# Scene View 大场景容量与渲染稳定性

日期：2026-07-17

更新：2026-07-24

## 目标

本轮优化只减少重复工作和资源峰值，不通过降低画质换取性能。以下视觉项保持不变：

- Babylon Engine 抗锯齿继续开启；
- stencil、GlowLayer、HighlightLayer、SelectionOutlineLayer 保留；
- 模型纹理、PBR 材质、几何精度和相机可视距离不做自动降级；
- 场景 JSON、模型包 `meta.json` 和米制单位契约不变。

## 硬件加速 WebGL 前置条件

Electron 主进程会在 `app ready` 前请求高性能 GPU、禁用 Chromium 软件 3D rasterizer，主窗口明确开启 WebGL。Windows 正式打包版还会按企业部署策略关闭 GPU sandbox，开发态继续保留该 sandbox。编辑器 Scene View 创建 Babylon Engine 时使用 `powerPreference: high-performance` 与 `failIfMajorPerformanceCaveat: true`，并检查实际 renderer：

- Intel / NVIDIA / AMD 等 ANGLE 硬件后端正常进入编辑器；
- SwiftShader、WARP、llvmpipe 等软件 renderer 会被拒绝，不再静默占用 CPU 模拟 WebGL；
- 硬件 WebGL 不可用时，Scene View 显示可读初始化错误，首页及项目管理仍可使用；
- 导出的独立 Web Viewer 保持既有兼容策略，不强制拒绝软件回退。

该策略不绕过 Chromium GPU 驱动黑名单，也不固定 `use-angle` 后端；命中黑名单时应更新显卡驱动或调整系统图形首选项，而不是强制运行不稳定驱动。`disable-gpu-sandbox` 只在 Windows 正式打包版生效，不会关闭 renderer sandbox，但会降低 GPU 进程隔离强度；这是已确认的企业部署取舍。

场景 JSON、GLB/GLTF 文件读取、格式解析和部分纹理解码仍由 CPU 或 Worker 完成；解析后的几何、材质和纹理上传到 WebGL 后，模型绘制、Shader、纹理采样和画面合成由 GPU 执行。

## 静态同源模型共享

`SceneRuntime` 会为每个模型资产计算实例化策略：

- `shared-instance / shelf-resource`：Shelf 保留既有脚本化共享路径。
- `shared-instance / plain-static-model`：普通模型没有 `scriptAssets`、`parameterConfig`、`parameterScriptMetadata` 和 `animationScriptMetadata` 时进入静态共享路径。
- `owned-container`：带脚本、参数配置或脚本元数据的普通模型继续独占容器。

共享模型只复用源几何、材质和纹理；每个实体仍拥有独立的 `root`、`contentRoot`、实例节点、动画组、Transform、metadata、拾取、显隐、锁定和释放句柄。删除一个实体不会影响其它实例，最后一个引用归还后才释放源容器。

动态模型默认独占是有意的安全边界。例如 Stacker `appearanceColor` 会克隆并修改实例材质，YZJ/Stacker 参数脚本会修改顶点或生成额外 Mesh，强制共享可能造成实例串色或几何互相污染。

## 模型阵列：独立实体与矩阵批次

模型阵列同时保留编辑语义和渲染性能：

- 阵列数量为 N 时，`SceneDocument` 和 Hierarchy 中真实增加 N 个模型实体；每个实体有独立 ID、名称、`modelAsset.assetCode`、Transform、显隐、锁定、删除和选择状态。
- 阵列实体通过 `modelArrayInstance.sourceEntityId` 直接引用一个源模型；默认相同参数的 N 个实体只复用源模型，不会逐实体加载模型、创建完整节点树或启动脚本运行时。
- 每个阵列实体自己的 `modelAsset.parameterValues` 都参与渲染分组。与源模型参数不同的组合会创建一个 `layerMask=0` 的隐藏脚本宿主，完整执行声明式参数绑定和外置参数脚本；相同参数组合只共享一个宿主，连续调参且组成员不变时复用已有宿主。宿主本身不参与显示或拾取，该组全部逻辑模型仍由 thinInstance 渲染。
- 每个参数组合的每个可渲染 Mesh 只创建一个批次 Mesh。全部逻辑实体 Transform 先组合为连续 `Float32Array`，再通过一次 `thinInstanceSetBuffer("matrix", ...)` 注册或通过 `thinInstanceBufferUpdated("matrix")` 刷新。
- 源模型自身已有 thinInstance 时，会先展开源矩阵，再与每个逻辑实体根矩阵组合；例如同一参数组合下，88 个源 Mesh × 1000 个逻辑模型仍只有 88 个批次 Mesh 和 88,000 个 thinInstance；只有实际出现不同参数组合时才增加对应组合的固定批次数。
- 拾取使用 Babylon 返回的 `thinInstanceIndex` 反查逻辑实体；选择描边使用逐实例 `instanceSelectionId` 缓冲，只标记目标模型，不会整组高亮。
- 隐藏实体会从有效矩阵缓冲中移除；锁定实体保持显示但不作为可编辑拾取结果。移动单个实体会复用原批次与同长度矩阵缓冲，不影响其它实体。
- 删除阵列源时，编辑器会提升第一个未删除实例为新源并重绑其余实例，避免产生悬空引用。旧版 `modelArray.items` 会在加载时迁移成相同数量的独立实体。

矩阵计算只处理数值 TypedArray；Babylon Mesh、材质、骨骼和 GPU Buffer 仍由渲染主线程管理，避免把不可转移的引擎对象错误放入 Worker。若后续实测矩阵组合本身成为瓶颈，可只把纯数值矩阵填充下沉到 Worker，并通过 transferable 返回 `Float32Array`。

## 场景打开：编辑态自动 thinInstance 合批

Scene View 在编辑态会构造一层只存在于内存中的实体覆盖，不修改原始 `SceneDocument`，也不会把优化关系写入场景文件：

- 完全相同的模型模板忽略实例级 `modelAsset.assetCode` 后分组；每组只保留一个真实模型和脚本宿主，其余实体临时映射到 `modelArrayInstance`，复用既有拾取、Gizmo、测量、显隐、锁定、选择描边和 thinInstance 矩阵批次。
- 无外置脚本模型默认允许合批；带脚本模型仅允许经过编辑态行为核对的 `shelf.model.ts`、`yzj.model.ts` 和 `chain-conveyor.model.ts`。其它脚本继续走逐实体路径，避免把依赖 `assetCode` 或私有运行状态的视觉错误合并。
- 模板签名包含资源版本、单位、脚本元数据、参数配置和 `parameterValues`，因此不同尺寸、材质或显隐参数会进入不同批次，不会共用已变形几何。
- 模型模板签名和派生实体使用不可变对象缓存；单个 Transform 变化时复用其余逻辑实体，避免 Gizmo 拖动期间反复序列化整份脚本元数据。
- 进入运行预览时 Scene View 始终同步原始文档，恢复每个设备独立的脚本实例、`assetCode`、参数和 MQTT 遥测状态；退出预览后再回到编辑态覆盖层。

2026-07-23 使用指定的 `Untitled Scene.scene.json`（SHA-256 `f9d9fa6dc156dd0f96b5ba76f794ee2454efde415b7965b91cae92244a459b54`）和仓库内真实 YZJ/链条机 GLB、脚本进行 NullEngine 初始化回归：29,893,835 字节场景包含 1,840 个实体，其中 1,821 个模型被归并为 4 个参数变体源和 1,817 个逻辑 thinInstance 实体；实际只加载 4 次模型源，生成 135 个批次 Mesh、38,027 个 thinInstance，最终有效渲染 Mesh 为 270。最终一次运行中反序列化约 612 ms、编辑态分组约 572 ms、真实脚本与矩阵批次从 `sync()` 到就绪约 2.40 s，脚本警告和运行时日志均为 0。该数据用于验证初始化数量级和完整性，不等同于最终 Electron 窗口的 GPU 上传或首帧时间。

## 增量场景同步

每次 `SceneDocument` 变化时仍会完整计算实体存在性和父级显隐/锁定状态，但只有新增、删除、实体对象发生变化或运行时对象缺失的实体才执行完整 `syncEntity`。

仅选择变化、父文件夹显隐或锁定变化时，运行时只刷新：

- 基础 Mesh 选择颜色和拾取；
- locator 边线与交互面；
- CAD 显示；
- 模型 Highlight/SelectionOutline 与拾取；
- 模型生成器标记、POI 展示和灯光启用状态。

模型加载、参数绑定、外置脚本、子 Mesh 收集和遥测基线不会因无关实体或纯选择变化被重复执行。

## 加载峰值控制

`AssetLoadScheduler` 默认最多并行执行 4 个 `LoadAssetContainerAsync`：

- 普通模型、共享源模型和环境模型共用该预算；
- 同源共享请求仍只产生一个真实加载任务；
- 调度器释放后拒绝未开始任务，已开始任务自然结束并由 load token 回收过期结果。

并发限制不改变最终画面，只把批量模型的解析、纹理解码和 GPU 上传从同一瞬间摊开，降低卡顿和 WebGL context lost 风险。

## 全黑诊断与恢复

Engine 保留 antialias 和 stencil，同时把没有项目功能依赖的 `preserveDrawingBuffer` 关闭。Babylon Engine 的 context observable 和渲染循环状态会映射到 Scene View：

- `context-lost`：显示“正在自动恢复”遮罩并写入 Console；
- `context-restored`：Babylon 完成资源恢复后清除遮罩；
- `render-error`：捕获首次异常，避免每帧重复刷屏；
- `render-recovered`：后续成功帧清除遮罩并记录恢复。

如果恢复后仍反复全黑，应优先检查 Console 中的模型加载、shader、纹理和 WebGL 日志；不同高面数资产无法共享时仍可能达到具体 GPU 的显存上限。

## 验证

```powershell
npm run smoke:scene-capacity
npm run smoke:shelf-instancing
npm run smoke:gpu
npm run smoke:packaged:gpu
npm run smoke:installer:gpu
```

`smoke:gpu` 会先执行完整构建，再真实启动 Electron 验证硬件 GPU、GPU compositing、WebGL 2、上下文性能属性和 renderer，并使用 `--disable-gpu` 反向确认 Scene View 会阻断软件回退。

`smoke:packaged:gpu` 会通过 Playwright Electron 直接启动生产 EXE，同时检查主进程 GPU feature、活动显卡、三个选定启动开关，以及未启用 `ignore-gpu-blocklist`/`use-angle`。脚本会进入 Scene View 创建内置立方体，并确认硬件 WebGL renderer 与上下文在模型 Mesh 渲染后仍有效。默认验证 `release/win-unpacked`；也可执行 `npm run smoke:packaged:gpu -- "C:\Program Files\ZENDING 3D EDITOR\ZENDING 3D EDITOR.exe"` 检查指定安装目录。脚本会核对应用版本，旧安装程序会以明确的版本不匹配错误失败。

`smoke:installer:gpu` 会重新生成 Windows NSIS 安装程序，再调用上述生产 EXE 验证；验证过程使用独立临时 `userData`，不会写入安装目录。

`smoke:scene-capacity` 覆盖：

- 静态/动态共享准入矩阵；
- 加载调度器最大并发 4、FIFO 与 dispose；
- 100 个同源静态实体在编辑态只保留 1 个真实模型和 99 个 thinInstance，切换原始运行文档后恢复 100 个独立运行实体；
- 未知外置脚本明确回退，已核对参数化脚本允许按完整参数模板分组；
- 1000 个模型阵列实体仍只加载一个源模型，每个源 Mesh 只增加一个批次 Mesh；
- `thinInstanceIndex`、单实体移动/隐藏/锁定/删除和选择缓冲保持独立实体语义；
- 运行预览中的普通静态共享模型继续使用 `InstancedMesh`；
- 选择变化不重新收集未修改模型子 Mesh；
- 删除最后一个实例时源容器只释放一次。
