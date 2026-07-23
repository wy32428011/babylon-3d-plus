# Scene View 大场景容量与渲染稳定性

日期：2026-07-17

更新：2026-07-23

## 目标

本轮优化只减少重复工作和资源峰值，不通过降低画质换取性能。以下视觉项保持不变：

- Babylon Engine 抗锯齿继续开启；
- stencil、GlowLayer、HighlightLayer、SelectionOutlineLayer 保留；
- 模型纹理、PBR 材质、几何精度和相机可视距离不做自动降级；
- 场景 JSON、模型包 `meta.json` 和米制单位契约不变。

## 硬件加速 WebGL 前置条件

Electron 主进程会在 `app ready` 前请求高性能 GPU，主窗口明确开启 WebGL。编辑器 Scene View 创建 Babylon Engine 时使用 `powerPreference: high-performance` 与 `failIfMajorPerformanceCaveat: true`，并检查实际 renderer：

- Intel / NVIDIA / AMD 等 ANGLE 硬件后端正常进入编辑器；
- SwiftShader、WARP、llvmpipe 等软件 renderer 会被拒绝，不再静默占用 CPU 模拟 WebGL；
- 硬件 WebGL 不可用时，Scene View 显示可读初始化错误，首页及项目管理仍可使用；
- 导出的独立 Web Viewer 保持既有兼容策略，不强制拒绝软件回退。

该策略不绕过 Chromium GPU 驱动黑名单；命中黑名单时应更新显卡驱动或调整系统图形首选项，而不是强制运行不稳定驱动。

## 静态同源模型共享

`SceneRuntime` 会为每个模型资产计算实例化策略：

- `shared-instance / shelf-resource`：Shelf 保留既有脚本化共享路径。
- `shared-instance / plain-static-model`：普通模型没有 `scriptAssets`、`parameterConfig`、`parameterScriptMetadata` 和 `animationScriptMetadata` 时进入静态共享路径。
- `owned-container`：带脚本、参数配置或脚本元数据的普通模型继续独占容器。

共享模型只复用源几何、材质和纹理；每个实体仍拥有独立的 `root`、`contentRoot`、实例节点、动画组、Transform、metadata、拾取、显隐、锁定和释放句柄。删除一个实体不会影响其它实例，最后一个引用归还后才释放源容器。

动态模型默认独占是有意的安全边界。例如 Stacker `appearanceColor` 会克隆并修改实例材质，YZJ/Stacker 参数脚本会修改顶点或生成额外 Mesh，强制共享可能造成实例串色或几何互相污染。

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
```

`smoke:gpu` 会先执行完整构建，再真实启动 Electron 验证硬件 GPU、GPU compositing、WebGL 2、上下文性能属性和 renderer，并使用 `--disable-gpu` 反向确认 Scene View 会阻断软件回退。

`smoke:scene-capacity` 覆盖：

- 静态/动态共享准入矩阵；
- 加载调度器最大并发 4、FIFO 与 dispose；
- 100 个同源静态实体只加载一次源容器；
- 有效 Mesh 使用 `InstancedMesh`；
- 选择变化不重新收集未修改模型子 Mesh；
- 删除最后一个实例时源容器只释放一次。
