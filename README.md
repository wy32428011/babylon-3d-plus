<picture>
  <source media="(prefers-color-scheme: dark)" srcset="src/assets/branding/zending-logo-on-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="src/assets/branding/zending-logo-on-light.png">
  <img alt="ZENDING" src="src/assets/branding/zending-logo-on-light.png" width="520">
</picture>

# ZENDING 3D EDITOR

ZENDING 3D EDITOR 是一个基于 Electron、Vite、React、TypeScript 与 Babylon.js 的桌面 3D 编辑器原型项目。

## 当前目标

第一阶段 MVP 的目标是构建一个可启动、可编辑、可保存/加载的桌面 3D 编辑器内核。当前阶段重点验证编辑器基础架构、场景数据模型、基础对象编辑流程、基础资源导入与本地文件交互能力，不是一次性复刻完整 Unity3D。

## 当前功能

- Electron 桌面窗口：通过 Electron 主进程启动独立桌面应用窗口。
- 首页启动台：进入五面板编辑器前会先显示首页；左侧“最近项目”通过 Electron 主进程从可配置的数据中台 `POST /api/v1/projects/query` 拉取业务项目列表，支持按项目名称进行服务端搜索，并可直接打开当前格式 Editor 工程；右侧继续显示本地最近场景，并保留新建场景、打开项目目录和打开场景文件等入口。本地最近记录由主进程保存到 `recent-workspaces.json`，并兼容旧版单项目 `recent-project.json`。
- Electron 启动诊断：开发启动时会输出 renderer 加载、preload 与渲染进程退出日志；React 与 Scene View 初始化异常会显示可读错误页或错误面板，避免窗口内容区静默空白。
- GPU/WebGL 硬件加速：Electron 在 ready 前请求高性能 GPU、禁用软件 3D rasterizer，并在主窗口明确启用 WebGL；Windows 正式打包版按企业部署策略额外关闭 GPU sandbox。编辑器 Scene View 使用 `high-performance` 上下文并拒绝 SwiftShader、WARP 等软件 renderer，避免静默退回 CPU 模拟渲染。模型文件读取与格式解析仍由 CPU/Worker 执行，几何和纹理上传后由 GPU 完成绘制、Shader、纹理采样与画面合成。
- Unity-like 五面板布局：包含 Hierarchy、Scene、Inspector、Project、Console 五个核心编辑器区域，并支持根据窗口尺寸自动自适应；Toolbar 下方左侧 Hierarchy 与右侧 Inspector 贯通到窗口底部，中间列独立承载 Scene、Project 与 Console；Project/Console 只与 Scene 画布同宽，在约 `1024×640` 及以上窗口中保持五面板可见，Console 默认收纳到 Project 区域最小化入口，点击后以弹窗查看完整日志，Toolbar 与 Project 页签通过内部横向滚动承接溢出，资源卡片按可用宽度自动换行并在超出高度后纵向滚动。
- Babylon Scene View：在 Scene 面板中渲染 Babylon.js 3D 场景，并同步当前场景文档中的基础 Mesh、导入模型与灯光；默认编辑器相机使用更开阔的 `标准` 视野，让地面网格上方和周围保留更大的黑色背景可见范围，并可在 Toolbar 中切换 `近景`、`标准`、`远景`、`全景` 四档可视范围；鼠标滚轮近距离缩放带有最小观察距离与近裁剪保护，避免靠近模型时画面被裁成全黑；左键拖拽旋转或移动视角时以真实相机输入和位姿变化优先，即使从模型表面开始轻微拖拽也不会触发模型拾取，纯单击仍正常选中模型；Toolbar 新增“俯”视角按钮，可保留当前观察中心与缩放距离切换为稳定俯视视角，方便依据地面 CAD 图纸定位并搭建场景。
- 大场景无损容量优化：不降低抗锯齿、纹理、材质、光照或几何质量；同一 `sourceUrl + assetRevision` 的普通静态模型会复用单份源 `AssetContainer`，每个实体继续保留独立 Transform、显隐、锁定、拾取和选择语义。带外置脚本、参数配置或脚本元数据的动态模型默认继续独占容器，Shelf 保留经过验证的脚本化共享特例。模型与环境加载统一限制为最多 4 个并发任务；纯选择变化走 `SceneRuntime.syncSelection()`，矩阵实例选择缓冲只改写前后目标区间，Hierarchy 对 10k/50k 行采用固定行高虚拟化。Scene View 内置 1 Hz 性能 HUD，可查看 FPS、CPU/GPU frame time、Draw Call、Mesh、thinInstance、完整/选择同步、编辑态分组与 Long Task，并复制最近一分钟报告；监控器可通过 Toolbar 的“性能”复选框随时显示或隐藏，隐藏只影响界面，采样和最近一分钟历史继续保留。WebGL 上下文丢失或渲染循环异常会显示可读遮罩，Babylon 完成恢复后自动清除。详见 `docs/scene-capacity-performance.md`。
- 米制场景单位：编辑器约定 `1 scene unit = 1 m`，Inspector 中 position、位置吸附步长与地面网格均按米解释；普通导入模型的实际 X/Y/Z 尺寸由编辑器运行时原生测量，不依赖参数化脚本。
- 编辑器地面辅助层：Scene View 显示固定大范围的科技蓝地面网格，默认每小格表示 `5 m`，可在 Toolbar 中切换显示/隐藏并选择 `1 m`、`2 m`、`5 m`、`10 m` 四档格子大小；网格不会随相机视野重定位或被局部范围裁掉，网格线自身带有微弱低强度呼吸光晕效果，辅助层不参与选中、保存、加载或撤销/重做。
- CAD/DXF 网格参考层：Toolbar 支持导入 `.dxf` CAD 图纸，导入过程中会显示读取、解析和创建参考层进度；`LINE`、`ARC`、`CIRCLE`、`ELLIPSE`、`SPLINE`、`LWPOLYLINE`、`POLYLINE` 会在解析阶段统一换算为米，并按 DXF 正 Y → Babylon 正 Z 的同向规则转为贴近 `y = 0` 网格层的半透明线稿，避免俯视图上下镜像。超过 64 MB 的图纸在 Worker 中分块读取并完整扫描块定义/嵌套 INSERT，曲线采用有界采样，几何以 TypedArray 紧凑缓冲区零拷贝回传并分批创建 LinesMesh；默认安全上限为 100 万条折线 / 800 万个点，不再按旧的“每块 128 个图元 / 全图 80 万点”预览策略截断常规大图。单位优先读取 `$INSUNITS` 0–24，未声明单位时参考 `$MEASUREMENT`，仍无法判断时明确按毫米兜底；参考图默认锁定、不可拾取，Inspector 会显示源单位、判定来源和换算系数，并随场景保存/加载恢复。
- 创建基础对象：支持创建米制 Cube、Sphere、Plane；基准尺寸分别为 `1 m × 1 m × 1 m`、直径 `1 m`、`2 m × 2 m`，有体积对象拖入 Scene View 时会以底面落地。
- 创建基础灯光：支持创建 Hemispheric、Directional、Point 三类灯光实体。
- Hierarchy 选择与分组：支持在层级面板中选择场景对象，并与 Scene View 高亮状态同步；选中文件夹时会在 Scene View 高亮该文件夹下的所有可显示模型；左侧 Hierarchy 提供搜索、新建文件夹、单选/多选拖入文件夹分组、拖回根层级，以及实体/文件夹级显示隐藏、锁定解锁控制。
- Hierarchy 右键菜单：左侧模型树单选或多选后可打开深色上下文菜单，支持场景聚焦、库聚焦、隐藏、复制、粘贴、模型阵列、锁定、重命名、删除、群组和解组；右键未选中对象会切换为单选，右键当前多选对象会保留多选集合。复制文件夹时会连同全部直属对象生成完整文件夹副本，空文件夹同样支持复制，粘贴和撤销/重做均按整个文件夹处理。
- Scene View 点击选中：支持在 Scene 画布单击对象完成选中，单击空白区域会清空当前选择。
- Inspector 实体编辑：支持编辑选中实体名称、position、rotation、scale 等 Transform 数据；其中 position 按米、rotation 在 UI 中按角度、内部仍按弧度保存。内置 Box 以 1 米基准映射为 `size (m)`；Sphere/Plane 明确显示米制基准尺寸，但通用 scale 仍保持无量纲缩放比例。普通导入模型的 `Model Asset` 区域固定显示只读“实际尺寸 (m)”及 X/Y/Z，加载中或无有效可见几何时显示明确状态。
- Inspector 材质编辑：支持编辑基础 Mesh 的材质颜色。
- Inspector 灯光编辑：支持编辑灯光类型与强度。
- Transform Gizmo：Scene View 中支持移动、旋转、缩放三种可视化操控模式，普通拖拽结束后写入撤销/重做历史；编辑模式下选中单个未锁定可阵列实体并使用移动工具时，可按住 `Shift` 拖动 X/Y/Z 单轴箭头进入模型阵列。可阵列实体包括导入模型、内置 Mesh、虚拟定位线框、已解锁 CAD 参考层和 POI 特效；文件夹、灯光和全局唯一模型生成器明确排除。
- Gizmo 坐标与吸附：支持局部/全局坐标空间切换，并可配置位置、旋转角度、缩放三类基础吸附步长；Shift 阵列沿当前可见局部/世界轴计算方向，阵列手势期间临时忽略位置吸附，普通移动吸附不受影响。
- W/E/R 与批量操作快捷键：在非输入控件聚焦时，可用 W/E/R 快速切换移动、旋转、缩放工具；F 场景聚焦、H 隐藏对象、Ctrl+C 复制、Ctrl+V 粘贴、Ctrl+K 锁定、Ctrl+G 群组、Shift+G 解组、Delete/Backspace 删除当前 Hierarchy 选区；文件夹选区执行 Ctrl+C/Ctrl+V 时会整体复制文件夹及其全部直属对象。
- 撤销/重做：通过命令历史支持基础编辑操作、实体创建、实体删除、实体重命名、材质编辑、灯光编辑与 Gizmo 拖拽的撤销与重做；Hierarchy 批量隐藏、锁定、删除、粘贴、模型阵列、群组和解组均作为单条命令进入历史，Shift 拖拽阵列确认后同样以一条“模型阵列”命令整体撤销/重做。
- JSON 场景保存/加载：支持将当前场景保存为 JSON 文件，并从 JSON 场景文件加载；保存、文件选择加载和首页最近场景加载成功后都会更新最近场景列表。
- Project 资源库外观：底部 Project 面板已切换为资源库浏览器样式，位于中间列 Scene 画布下方且与 Scene 同宽，并将图库区域加高到约 `300px` 至 `460px` 自适应，包含模型库、POI库、主题库、组合库、环境库、图表库、图片库七个页签，以及筛选占位行和可换行资源卡片；模型库卡片使用深色直角卡、上方缩略图、下方两行居中文字和单行省略标题，模型库内置立方体、球体、地面、虚拟定位线框、半球光、方向光、点光源七类基础资源，并支持导入普通模型文件夹展示项目内模型卡片；POI 库保留可点击或拖入 Scene 任意位置的“模型生成器”，重复创建入口会选中已有生成器而不是新建副本；环境库使用独立的单 GLB 文件导入入口，支持点击应用或拖入右侧“环境模型”整条属性行；所有导入模型进入场景后统一以米为操作单位。
- POI 模型生成器：生成器保存共享生成模板、按顺序匹配的条件规则、MQTT 精确绑定和元数据 TTL；一个场景只有 `entityIds` 中第一个生成器生效，编辑态 Transform 只控制青色可拾取配置标记，不作为任何货物生成点。运行预览中该全局生成器统一管理普通 Conveyor、普通 Stacker 与 `warehouseFlow` 的模板/规则；货物实际位置来自输送面、货叉、locator 或仓储状态机。派生 Mesh/模型不进入 Hierarchy，也不写入场景文件或撤销历史。
- POI 内置 EFF 特效：POI 库内置报警脉冲光圈、旋转警示灯、定位光柱、雷达扫描圈、火焰、烟雾、火花飞溅、蒸汽泄漏、气体泄漏、水流喷射、管线流动粒子、管线流动箭头、移动双箭头、货物目标定位框、输送方向箭头和疏散路线 16 种实时特效；支持点击或拖拽创建、Hierarchy 管理、Transform、显隐、锁定、复制、阵列、撤销/重做、保存重载和 Inspector 参数实时编辑。
- 模型与环境导入：普通模型与环境模型严格分库。模型库点击 `导入模型文件夹`，将有效模型包复制到项目 `Assets/Models`；扫描支持目录本身为单模型包或包含多个一级模型包，并读取 `meta.json`、单位、缩略图和脚本。普通模型单位只接受 `meta.json.lengthUnit`：显式合法值按标准系数换算，缺失或空值按 `meter / 1`，显式非法值拒绝导入；参数脚本和几何包围盒都不参与源单位推断。环境库点击 `导入环境 GLB`，单文件保存到 `Assets/Environments/<安全化文件 stem>/<原文件名>.glb`，同名重导采用暂存、备份和失败回滚。普通模型、模型生成器输出和环境模型都保留 `lengthUnit + unitScaleToMeters`，运行时只在各自内容根节点应用一次源单位到米的基准缩放；直接导入且符合 glTF 约定的环境 GLB 登记为 `meter / 1`。 从其他电脑打开场景后，重新导入同名模型包会按唯一的“包目录名 + 主模型文件名”自动替换旧电脑的绝对资源路径并刷新已有实例。
- 导入模型资产编号：每个导入模型实例都会生成并保存 `modelAsset.assetCode`，Inspector 的 `Model Asset` 区域可编辑该编号；复制、粘贴会按新实体 ID 重新生成编号。所有阵列副本名称统一按源对象名称递增：末尾有数字时递增并保留前导零，例如 `测试 1001 → 测试 1002`、`DEV009 → DEV010`；只有字符串时直接追加 `1、2、3…`，不添加“副本”。导入模型阵列会创建与阵列数量一致的独立 Scene Entity，并通过 `components.modelArrayInstance.sourceEntityId` 关联共享渲染源；Hierarchy 中可逐个选择、移动、旋转、缩放、显隐、锁定和删除。Babylon 运行时不会逐实体加载或克隆模型，而是按参数组合运行脚本：相同 `parameterValues` 共享一个源或隐藏脚本宿主，不同参数组合分别执行参数化脚本；所有阵列实体仍按该组合的可渲染 Mesh 创建固定数量批次 Mesh，一次提交连续 `Float32Array` thinInstance 矩阵，并通过 `thinInstanceIndex` 映射回具体逻辑实体。旧版 `components.modelArray.items` 场景加载时会自动迁移为独立实体。虚拟定位线框仍把编号写入 `locator.assetId`，内置 Mesh、CAD 和 POI 继续沿用实体复制语义。场景文件版本保持 `1`，新增字段为可选字段。
- MQTT 配置入口：Toolbar 提供 MQTT 配置按钮，可在弹窗中填写 MQTT IP/域名、MQTT over WebSocket 地址、topic 与本地模拟参数；只填写 IP 时会自动生成 `ws://<IP>:8083/mqtt`。保存或启用配置只保存场景配置，不会自动连接 broker，也不会自动启动本地模拟。
- MQTT 运行预览：Toolbar 的“运行/停止”是唯一运行入口；点击“运行”并通过预检后才会连接 broker 或启动本地模拟，连接状态 badge 显示 disabled/simulating/connecting/connected/disconnected/error，无效配置会自动打开 MQTT 配置弹窗。运行态允许相机、选择、Hierarchy 搜索/展开、网格、诊断和 Console，只读阻止 Gizmo、Inspector 修改、Hierarchy 变更、资源创建/导入、保存加载、undo/redo 与 MQTT 配置。
- 通用 MQTT 数据驱动框架：详见 `docs/mqtt-data-driven-guide.md`，覆盖只读可视化边界、EPV `data[].e/p/v`、JSON Path、多订阅/QoS、`sourceId + deviceType + assetCode` 绑定、`dataDriven` 默认配置与 `telemetryBinding` 实例覆盖、Transform/Joint/Animation 示例，以及 stale/fault/conflict 和 Electron `wss://` 安全注意事项。
- 外置参数化脚本：模型包内的 `*.model.ts` 会随模型包复制到项目目录并作为受控 `editor-asset://` 资产授权；导入模型加载完成后，renderer 会以本地可信脚本方式转译并运行同包脚本，兼容 `ParametricModelRuntimeComponent`、`export default class`、`onStart/onUpdate/onStop` 生命周期以及 `babylonjs-editor-tools` 的 `visibleAs*` 装饰器写法。所有长度类参数统一以米输入；脚本在实体根米空间读取未销毁、自身启用、可见且有顶点的有效 Mesh，把米制位移转换回目标父节点局部坐标，并在整机根缩放时保持底部中心锚点。参数脚本只负责模型特有参数化和附加运行逻辑，不负责判断源单位或提供基础米制测量。
- 参数化模型：模型包 `meta.json.modelParameters` 可声明 number、color、boolean、enum、vector3、texture 参数，以及绑定到模型节点、网格或材质的安全 JSON DSL；选中带参数配置的导入模型后，Inspector 会以紧凑布局显示“模型参数”区域，参数标签使用自适应宽度并在必要时换行，确保长中文名称完整显示；修改参数会通过场景文档实时驱动 Babylon 模型外观变化，并支持随场景保存/加载与撤销/重做。参数变化完成后，编辑器会重新测量实际尺寸；没有参数脚本的模型仍正常显示米制尺寸。
- 模型库拖拽放置：模型库中已导入的真实模型卡片可直接拖拽到 Scene View，释放鼠标时会按当前鼠标射线与 `y = 0` 地面平面的交点创建模型实体；点击模型卡片仍保留原点快捷导入行为。
- Assets 目录能力：模型库已重新接入本地模型文件夹扫描、项目目录复制与 glTF/GLB 导入入口；其余资源类型的真实分类、搜索、扫描与导入会在后续资源库功能中继续补齐。

## 启动方式

首次运行前安装依赖：

```bash
npm install
```

启动开发版 Electron 编辑器：

```bash
npm run dev:electron
```

运行环境要求：Node.js `>=22.12.0`。

若 Electron 窗口只显示标题栏或菜单栏，优先查看启动终端中的 `[electron]` 日志；渲染入口异常会显示“编辑器启动失败”，WebGL/Babylon 初始化异常会显示在 Scene 面板内，不再静默白屏。若提示“硬件加速 WebGL 创建失败”，请先更新显卡驱动，并在 Windows“图形设置”中将 `ZENDING 3D EDITOR` 设为“高性能”；编辑器不会退回 SwiftShader/WARP 软件渲染。

开发脚本会自动从 `5173` 开始向后选择可用本地端口，最多扫描 300 个端口以避开 Windows 保留端口段或已有本地服务，并先执行 `npm run wait:renderer`，依次预热 Vite 根页面、React 入口、布局、Scene View、Babylon runtime 与编辑器 store 等首屏模块，全部成功返回后再启动 Electron，避免端口占用或 Vite 首次依赖预构建、模块转换尚未完成时打开空窗口。

## 仓库内参数化示例资产

本仓库内置一套无需外部资源的参数化验收资产：

- 模型包根目录：`examples/model-packages`
- 示例模型包：`examples/model-packages/ParameterChainDemo`
- 演示场景：`examples/scenes/parameter-chain-demo.scene.json`

最短验收流程：

1. 执行 `npm run dev:electron` 启动 Electron 编辑器。
2. 点击 Project 面板中的模型文件夹导入，选择 `F:\3d-models\models`；模型包会复制到当前项目 `Assets/Models`，同目录 `.model.ts` 会随包登记为外置参数化脚本。
3. 在 Project 模型库中点击任意导入模型，选中场景实例后在 Inspector 的“模型参数”区域调整数值、布尔、枚举或贴图参数；参数会同时写入 `modelAsset.parameterValues`、运行节点 `metadata.scripts[].values` 和脚本实例属性。
2. 在 Project 面板的模型库点击 `导入模型文件夹`；首次导入会先选择项目目录，随后模型文件夹选择本仓库的 `examples/model-packages`。
3. 模型库出现 `参数链路示例机柜` 后，点击或拖拽它进入 Scene View；选中模型后，在 Inspector 的“模型参数”里修改 `主体颜色`、`主体高度`、`显示侧边面板`、`屏幕贴图`。
4. 需要比对保存后的参数值时，点击 Toolbar 的 `加载场景`，选择 `examples/scenes/parameter-chain-demo.scene.json`；该场景包含默认蓝色网格实例和红色高柜斜纹实例，便于验证颜色、高度、显隐和贴图链路。

建议先导入 `examples/model-packages` 一次，再加载演示场景；导入流程会授权模型包目录和包内贴图，贴图参数链路验证最稳定。

## Box 纸箱米制参数化说明

`F:\3d-models\models\box` 已补齐 `box.model.ts` 与 `meta.json`，并同步到当前项目资产副本 `F:\3d-models\models\Assets\Models\box`：

- `box.glb` 原始坐标按厘米声明，模型内容根节点由编辑器统一乘以 `0.01` 换算到米；源单位元数据不会写入用户 `Transform.scale`。
- 编辑器原生测量会把内容根单位缩放、参数脚本几何变化和用户 `Transform.scale` 一并计入，默认在 `Model Asset` 中显示约 `X=0.18 m、Y=0.18 m、Z=0.32 m`；即使删除参数脚本，只要保留 `lengthUnit: "centimeter"`，基础实际尺寸仍可测量。
- Inspector 暴露 `长度 (m)`、`宽度 (m)`、`高度 (m)`，默认分别为 `0.32 m`、`0.18 m`、`0.18 m`，输入范围 `0.01–100 m`，步长 `0.01 m`。
- 轴向契约为 X=宽、Y=高、Z=长；脚本从单位换算后的缩放与归一化位置基线绝对重算，参数反复修改不会累计误差，并同步补偿 GLB 的微小底部中心偏移，使极端尺寸下模型底面仍严格锚定实体原点地面。
- 源包和 `Assets/Models/box` 中的 `box.model.ts`、`meta.json` 必须保持 SHA-256 一致；修改源脚本后应同步资产副本或在编辑器中重新导入模型包。 全量回归由 `npm run smoke:model-parameters` 校验，并随 `npm run smoke:units` 一并执行。
- 当前项目 `.babylon-editor/asset-index.json` 的 Box 条目已重新扫描并生成新 `assetRevision`，模型库会按 `Box 纸箱`、`centimeter / 0.01` 和三个米制参数读取该资产。

## Stacker 堆垛机参数化说明

`appearanceColor` 在 Inspector 中显示为“模型外观颜色”，使用 `#RRGGBB` 格式，默认值为 `#ffffff`。默认白色只作为现有 PBR 贴图的乘色，因此旧场景与未配置实例保持原外观；非法颜色会回退白色，不会中断模型参数更新。运行脚本为每个 Stacker 实例按原材质懒克隆并复用专属材质，颜色反复修改不会持续创建新材质，多个实例也不会互相串色；脚本停止时会先恢复原材质，再释放克隆材质且不强制销毁共享贴图。当前 `Stacker.glb` 已验证为 13 个独立 `PBRMaterial`；若未来模型改用 `MultiMaterial`，需要同步扩展 `subMaterials` 处理与回归验证。

`F:\3d-models\models\Stacker` 模型包中的 `forkGap` 表示两根货叉中心线之间的目标间距，不是基于原始位置的额外偏移量；脚本会读取两根货叉的基线世界中心，围绕中心对称设置目标间距，并把世界位移转换回父级本地坐标，避免 GLB 源单位、父节点缩放或局部轴向导致二次外扩。

模型实体被旋转后，Stacker 脚本会从模型内容根节点的当前世界矩阵读取局部 X/Y/Z 参数轴：主体长度沿模型局部 Z 轴、主体和载货台高度沿模型局部 Y 轴、宽度和货叉长度沿模型局部 X 轴生效；货叉间距沿两根货叉基线中心连线投影计算，避免旋转 45° 或 90° 后仍按全局坐标轴变形。

货叉的底面锚点以 Babylon.js Sandbox 中原始 `Stacker.glb` 的可视底面为准。参数化脚本会在应用 `forkLength` 和 `forkGap` 前记录两根货叉的原始底面投影，长度缩放和左右调距完成后再贴回原支撑平面；`forkGap` 只改变两叉左右中心距，不改变货叉高度，也不应把货叉抬离或压入载货台。

Stacker 默认原位会把 `dataDriven.motion.travel.nodes` 声明的整组行走机构沿模型局部 Z 轴向左回贴 `0.562846 m`，使操作台前缘与下轨左端黄色缓冲头贴合；固定上下轨保持不动，模型旋转或毫米单位缩放后仍沿自身轨道方向生效，MQTT `distance_x = 0` 继续以该贴合姿态作为运行基线。

当前项目已经导入的模型副本位于 `F:\3d-models\models\Assets\Models\Stacker`。调试或发布 Stacker 脚本时需要让源模型包、该副本以及 `output/playwright/stacker-assets` 中的 TS/TXT/meta 保持 SHA-256 一致，并用 `BABYLON_MODEL_FILTER=Stacker` 定向刷新资产索引，避免无关模型的 `assetRevision` 变化；视觉验证建议覆盖默认颜色、自定义颜色、颜色恢复，以及 `forkGap = 0 / 0.6 / 1.2`、`forkLength = 0.5 / 0.941 / 2.0`、`bodyHeight = 12 + platformHeight = 3 + forkGap = 1.2 + forkLength = 2` 的组合场景，确认颜色不串实例、两叉中心不漂移、货叉长度不污染间距、立柱和载货台参数互不牵连。

`forkLength` 仍表示货叉自身静态几何长度，用于 Inspector 参数化建模；`forkStageOneReach` 和 `forkStageTwoReach` 表示运行时伸缩行程，默认各 `0.8m`。脚本会在运行时为 `huocha.9`、`huocha2.10` 克隆第二段可视节点，GLB 本体不变。遥测驱动时优先读取 `front_distance_z/back_distance_z`，近位距离小于等于第一段行程时只移动第一段；远位距离超过第一段行程时，第一段先到达 `forkStageOneReach`，第二段继续补足剩余距离。没有编码器距离时，运行时会尝试用目标定位框沿模型局部 X 轴的投影距离估算伸出量；仍无目标时按 `movement_z` 连续伸缩并限制在两段总行程内。

## 一体式顶升移载 YZJ 参数化说明

`C:\Users\WY\Desktop\models\YZJ` 是“一体式顶升移载”源模型包，项目实际加载副本位于 `C:\Users\WY\Desktop\models\Assets\Models\YZJ`。参数化脚本继续按 GLB 的真实结构处理：`ZT.2` 是主体、腿和电机所在的单体网格，`Ban.4` 是辊筒框架，`GT.3` 是可复制的辊轮模板；`YZJ.glb` 本体不修改。

Inspector 的主参数按参考图片设置为：`长度 = 1.8276m`、`宽度 = 1.0621m`、`高度 = 0.6478692m`、`主体颜色 = #387368`、`辊筒框架位置 = 0.1576491m`、`辊筒框架长度 = 1.021932m`、`电机位置 = 0.1814833m`、`辊筒密度 = 0.6`，以及默认启用的 `显示腿A`、`显示腿B`、`显示电机`、`辊轮皮`。为保留既有 MQTT 方向箭头的贴图解析能力，面板末尾继续保留 `方向箭头贴图（运行兼容）`。

`长度/宽度/高度` 使用图片数值作为当前 GLB 基线，不会在默认加载时二次变形；长度仍采用端部保护的顶点分段拉伸，保持画面左侧对接端固定、只向右侧延长。`辊筒框架位置` 是图片中的绝对基线位置，运行时换算为相对当前 GLB 的偏移；`辊筒框架长度` 同步控制 `Ban.4 + GT.3`，并继续与整机长度解耦。

由于 `ZT.2` 没有独立的腿或电机子节点，脚本会按三角形连通性识别单 Mesh 内的腿 A、腿 B 和电机组件：显隐时只把目标连通组件收拢为退化面，电机位置只移动电机组件，不修改或拆分 GLB。`辊轮皮` 对应 `GT.3` 的长圆柱连通组件，关闭后保留两端轴头；辊筒密度仍沿设备局部宽度复制 `GT.3`，`0.6` 默认保持 1 根，整数 `3` 会生成 3 根。

旧场景中的 `chainLength/chainWidth/chainHeight/platformLength/platformPosition/rollerWidth/rollerPosition/showFrontSupport/showRearSupport` 仍作为隐藏兼容字段读取；既有 `infeedSide/outfeedSide/frontSide/backSide`、方向箭头和 MQTT `dataDriven.motion` 合同未删除。源包、项目资产副本和 `output/playwright/yzj-assets` 夹具中的脚本与元数据保持 SHA-256 一致，完整静态、浏览器矩阵和 Electron Inspector 验证记录见 `docs/yzj-parameter-visual-validation.md`。

## 导入模型资产编号说明

`modelAsset.assetCode` 是导入模型的场景实例级资产编号，用于后续动画数据按模型实例识别。模型包扫描会从同包 `*.model.ts` 的 `dataDriven.device.defaultAssetCode` 只读提取默认前缀；导入实例时会生成 `默认前缀-实体短ID`，例如 `YZJ01-A1B2C3D4`。如果脚本未声明默认前缀，则使用 `MODEL-实体短ID` 兜底。

`defaultAssetCode` 只作为模型库导入时的编号前缀，不是完整实例编号；同类模型多次导入或复制粘贴时，会用新实体 ID 重新生成 `assetCode`，避免不同实例共享同一个动画识别编号。旧场景文件缺少 `modelAsset.assetCode` 时，加载阶段会自动补齐编号。

模型阵列副本名称始终根据源对象名称生成，与资产编号规则相互独立：名称末尾有数字时按副本序号递增并保留位宽，例如 `测试 1001` 依次生成 `测试 1002`、`测试 1003`；只有字符串时依次追加 `1`、`2`，不会添加“副本”。阵列弹窗支持为本次阵列填写一次性资产编号规则，规则只写入本次阵列结果，原对象不变。导入模型的每个阵列结果都是具有稳定 ID、名称、资产编号和完整 Transform 的独立 Scene Entity，`components.modelArrayInstance.sourceEntityId` 只负责声明其共享几何源；Hierarchy、保存/加载和撤销/重做均按真实实体处理。SceneRuntime 默认只使用源模型；当阵列实体的 `parameterValues` 不同时，每个不同参数组合创建一个隐藏脚本宿主并完整执行参数化脚本，相同组合共享宿主，连续调参会复用已有宿主，不会按实体数量创建加载任务和完整节点树。宿主本身不显示，全部阵列实体仍按参数组合通过固定批次 Mesh 和单次 `thinInstanceSetBuffer("matrix", ...)` 或原缓冲更新提交矩阵。单个阵列实体移动、显隐、锁定、删除、拾取和选择描边只影响对应矩阵；删除源模型时会提升第一个未删除实例为新源并重绑其余实例。旧版 `components.modelArray.items[]` 会在反序列化时迁移为相同数量的独立实体。虚拟定位线框仍写入 `locator.assetId`，内置 Mesh、CAD 和 POI 等无编号对象不新增字段并继续创建普通实体副本。规则中的 `${1}-1-1` 会按副本序号生成 `2-1-1`、`3-1-1`，`${001}` 会生成 `002`、`003` 并保留前导零；规则为空时，若原编号末尾有数字则递增末尾数字，否则追加序号。多选多个带编号对象时禁用自定义规则，但每个对象仍按自己的原编号默认递增。场景内已有实体和旧版矩阵项都会参与名称/编号冲突校验；场景文件版本继续为 `1`。

运行时会把当前实例编号写入模型内容根节点 `metadata.assetCode` 与 `metadata.modelAsset.assetCode`，并注入外置模型脚本实例的 `assetCode` 属性；模型脚本中已声明的 `dataDriven.device.assetCodeField = "assetCode"` 可直接读取该实例编号。

PLC/MQTT 遥测不会按模型名称、Hierarchy 名称或脚本文件名匹配设备，只使用 topic 中的资产编号匹配 `modelAsset.assetCode`。现场联调时应先确认模型实例的 `modelAsset.assetCode` 与 PLC 上报资产编号一致，例如堆垛机 `DDJ2`、输送线 `1001`。

## POI 模型生成器

在 Project 面板切换到 `POI库` 后，仍可点击“模型生成器”或把卡片拖入 Scene View 任意位置；点击默认放在世界原点，拖拽按鼠标与 `y = 0` 地面平面的交点放置青色配置标记。选中后 Inspector 使用紧凑布局，`POI名称` 与 Transform 只编辑该青色标记的位置、旋转和缩放，便于把配置入口放在场景任意处；它不参与普通 Conveyor、普通 Stacker 或 `warehouseFlow` 的货物坐标计算。派生模型不能作为独立 Hierarchy 实体编辑。

Inspector 配置字段：

- `共享生成模板`：保留原 `defaultTarget` 字段，从模型库拖入项目普通模型，或拖入内置 `立方体 / 球体 / 地面`；它是普通 Conveyor、普通 Stacker 与 `warehouseFlow` 共同复用的场景级默认模板，编辑态永远不实例化，只显示现有青色线框标记。
- `生成规则`：规则按列表从上到下执行，可添加、删除、上移和下移。每条规则保存稳定 ID、属性名、属性值和 `规则覆盖模型（可选）`；属性名为空时运行时忽略，规则目标为空但规则命中时使用共享生成模板。暂无规则或没有规则命中时直接使用共享生成模板。
- `元数据销毁时长`：默认 `5 秒`，允许范围 `1–3600 秒`；用于 `warehouseFlow` 三条严格绑定快照的有效期判断。普通 Conveyor/Stacker 的货物存在与 stale 行为仍由各设备遥测绑定和设备状态决定，生成器只选择可视模板。
- `仓储设备绑定`：可保存多条 `sourceId + deviceType + assetCode` 完整绑定，供 `warehouseFlow` 通过稳定 binding ID 引用三台设备；任一字段为空时允许保存，但仓储运行时忽略。普通 Conveyor/Stacker 直接使用各自模型的专用遥测快照解析模板。

运行预览中的解析顺序固定为：

1. Runtime 只启用当前场景 `entityIds` 中第一个模型生成器；旧场景若存在多个生成器，其余实体只显示编辑态标记并写入一次诊断。
2. 普通 Conveyor、普通 Stacker 和 `warehouseFlow` 为每个有效货物快照独立解析模板规则，快照顶层支持 `sourceId`、`deviceType`、`assetCode`，其它属性名读取 `snapshot.fields`。
3. 按规则顺序取第一条具有有效目标的命中规则；字符串、数字、布尔值统一转为去除首尾空格的文本后进行区分大小写的等值比较，对象、数组和嵌套字段路径不参与匹配。
4. 命中规则优先使用 `rule.target`，规则目标为空时使用共享生成模板；属性命中但 `rule.target` 和共享模板都为空属于不完整规则，会忽略并继续后续规则。
5. 没有规则命中时使用共享生成模板；普通 Conveyor/Stacker 没有生成器、没有可用模板或最终模型加载失败时回退旧版默认 Box，`warehouseFlow` 没有可用模板时继续 fail-closed，不创建仓储货物。

输送线示例：场景级生成器的共享模板拖入一个货物模型；添加 `front_has_goods = true` 和 `back_has_goods = true` 两条规则，两条规则的覆盖模型都可留空。任一有效货物快照命中时，普通 Conveyor 会在输送面支撑点创建对应模板；Stacker 会在货叉或目标 locator 支撑点创建对应模板；生成器标记 Transform 不改变这些货物位置。共享模板为空或最终加载失败时，普通设备继续显示旧版默认 Box。

模型生成器还可启用可选 `warehouseFlow`：它通过三条稳定 binding ID 分别引用入库 conveyor、stacker 和出库 conveyor。仓储模式只由入库输送机前端有货启动，并由独立协调器保持同一货物实例经过 1004 前后端输送与顶升高位、DDJ2 取货/搬运/入库、DDJ2 出库/后端交接、1005 顶升下降和前端输出。相同条码不会创建第二个实例；DDJ2 双叉无法唯一消歧时冻结而不默认选择前叉；入库完成后输出会脱离活动输出根节点并作为运行时库位货物保存，生成器可继续生成下一件。仓储流托管设备的旧默认 Box 货物会关闭；若没有可用共享模板或规则目标，仓储流继续 fail-closed，不创建仓储货物。停止预览时统一释放全部活动/已存实例。目标场景和字段说明见 `docs/stacker-warehouse-flow.md`。

生成器为编辑态青色标记维护长期稳定的 Babylon `TransformNode`，模型切换后拾取、Gizmo、显隐、锁定、高亮、包围盒和场景聚焦仍只指向该配置标记。自动货物使用独立、无父级的运行时支撑点根节点；导入模型输出使用运行时资产编号，同一目标签名不会重复加载，异步过期结果会被 load token 丢弃。规则覆盖模型加载失败时记录一次 Console 日志，并可在同一有效信号下回退共享生成模板；共享生成模板也失败时，普通设备回退默认 Box，`warehouseFlow` 保持无输出。

场景文件版本继续为 `1`。`components.modelGenerator` 只保存生成器配置和导入模型安全快照，不保存派生 Mesh、模型容器、脚本实例、自动货物或线框标记；新建场景只允许一个有效生成器，重复点击/拖入会选中已有生成器，复制、粘贴和模型阵列会拦截生成器副本。旧场景若已有多个生成器，运行时按 `scene.entityIds` 中第一个生效。重新导入模型包后，共享生成模板和规则目标会刷新 `assetRevision`、脚本元数据与默认参数。单个生成器最多保存 `64` 条规则和 `32` 条绑定；首版不支持范围比较、正则、表达式、嵌套字段路径或多个条件模型缓存。

## POI 内置 EFF 特效

在 Project 面板切换到 `POI库` 后，可点击任一 EFF 卡片在世界原点创建，也可把卡片拖入 Scene View，按鼠标与 `y = 0` 地面平面的交点创建特效实体。EFF 实体进入 Hierarchy，并像普通场景对象一样支持选中、Gizmo、显隐、锁定、分组、复制、粘贴、阵列、删除、撤销/重做和场景保存重载。

当前内置 16 种 EFF：

- 告警定位：报警脉冲光圈、旋转警示灯、定位光柱、雷达扫描圈。
- 消防与事故：火焰、烟雾、火花飞溅。
- 泄漏与流体：蒸汽泄漏、气体泄漏、水流喷射。
- 流向与物流：管线流动粒子、管线流动箭头、移动双箭头、货物目标定位框、输送方向箭头、疏散路线。

Inspector 使用统一参数模型：

- `特效类型`：可在 16 个内置预设之间切换；切换时应用新类型的推荐默认参数。
- `启用特效`：关闭后保留实体和配置，但停止显示及动画。
- `主颜色 / 辅助颜色`：控制主体、渐变、边缘光或尾迹颜色。
- `强度`：控制发光、透明度和整体视觉强度，范围 `0.1–3`。
- `速度`：控制旋转、流动、脉冲和粒子速度，范围 `0.1–5`。
- `密度`：控制粒子发射率、重复箭头或视觉单元数量，范围 `0.1–2`。
- `Transform`：Position 是特效锚点，Rotation 决定喷射/管线/箭头方向，Scale 决定整体作用范围。

EFF 只把上述配置写入 `components.poiEffect`；Babylon Mesh、材质、粒子、动态纹理、动画时间和选择壳均为运行时资源，不进入场景文件。全部 EFF 共用单一逐帧调度器，隐藏或禁用实体不会继续执行动画更新，也不会额外创建 GlowLayer。

## MQTT 配置入口

Toolbar 的 `MQ` 按钮用于维护场景级 MQTT 配置。弹窗包含“启用配置”、“本地模拟”、“模拟资产”、“模拟场景”、“间隔(ms)”、“IP/域名”、“地址”和“Topic”字段；如果只填写 IP/域名，保存时会按默认 MQTT over WebSocket 端口和路径生成 `ws://<IP>:8083/mqtt`，如果填写完整地址则以完整地址为准。 弹窗同时显示当前运行时连接状态和最近错误，并提供订阅选择、样例 Topic 与 payload 的本地解析预览；预览只生成标准化快照，不写入遥测仓库，也不会向设备发布消息。

该配置会写入当前 `SceneDocument.mqttConfig` 并随 `.scene.json` 保存、加载。启用后运行时通过 MQTT over WebSocket 连接 broker 并订阅 PLC/MQTT 遥测数据；通用默认订阅 topic 为 `dt/factory/logistics/+/+/twindatadriven/joint`。

如果启用“本地模拟”，运行时不会连接 MQTT broker，而是把模拟 payload 通过与真实 MQTT 相同的 EPV 解析入口写入内存遥测通道。Stacker 场景支持 `cycle`、`target`、`movement`、`fault`：`cycle` 会在目标位追踪和全 0 movement 模式之间切换，`target` 只追目标位，`movement` 固定发送 `to_x=0,to_y=0,to_z=0`，`fault` 发送急停/故障状态。`generic` 场景用于通用双机演示，`simulatorAssetCode` 以逗号分隔两台资产（例如 `GEN-A,GEN-B`），20 秒循环覆盖正向、反向、故障、4 秒断流和恢复。

topic 路径固定为 `dt/factory/logistics/<设备类型>/<资产编号>/twindatadriven/joint`。第一个通配段表示设备类型，例如 `stacker` 或 `conveyor`；第二个通配段表示资产编号，例如 `DDJ2` 或 `1001`。运行时只把资产编号与场景中导入模型实例的 `modelAsset.assetCode` 匹配，匹配成功后才驱动对应模型。

payload 使用 `data[]` 数组承载 PLC 点位，每一项按 `e/p/v` 三个字段解释：

| 字段 | 用途 |
| --- | --- |
| `data[].e` | 点位所属设备资产编号，通常与 topic 中的资产编号一致；现场数据不一致时优先排查 PLC 映射。 |
| `data[].p` | 点位名称，例如 `movement_x`、`containerCode`、`normal`。 |
| `data[].v` | 点位当前值，运行时按设备语义转换为数字、布尔或字符串。 |

运行时会以 topic 中的资产编号为准过滤点位：`data[].e` 为空时按兼容数据接收，`data[].e` 非空且与 topic 资产编号不一致时，该点位会被忽略，避免混合 payload 污染当前设备状态。

实时 MQTT 数据只保存在运行时内存中，不写入 `SceneDocument`，也不进入 undo history。

通用 MQTT 数据驱动框架的完整接入说明见 `docs/mqtt-data-driven-guide.md`。该指南补充说明 JSON Path 适配器、多订阅与 QoS、`sourceId + deviceType + assetCode` 三元绑定、模型包 `dataDriven` 默认配置、Inspector `telemetryBinding` 覆盖、Transform/Joint/Animation 通道配置、单位/坐标/平滑/stale/fault/conflict 处理，以及 Electron `wss://` 连接安全边界。

### 通用 MQTT 无 Broker 演示

演示文件位于 `examples/scenes/generic-mqtt-motion-demo.scene.json`，模型包位于 `examples/model-packages/GenericMqttMotionDemo`。场景包含 `GEN-A`、`GEN-B` 两台 `generic-machine`，分别验证根节点平移、`AccentPanel` 关节旋转和 `DoorPulse` AnimationGroup 状态动作；本地模拟按正向、反向、故障、断流、恢复循环，不需要 MQTT broker。

```bash
npm run demo:mqtt:generic:scene
npm run dev
```

开发服务器启动后访问 `http://127.0.0.1:<port>/?demo=mqtt-generic` 自动加载场景。第一条命令用于从 `ParameterChainDemo` 可重复生成独立模型包、真实 glTF 动画和场景文件；已生成文件也可直接通过编辑器“打开场景”加载。

## Stacker MQTT 动作解析与目标位规则

Stacker payload 使用通用 `data[]` 数组承载点位，DDJ2 堆垛机数据应发布到 `dt/factory/logistics/stacker/DDJ2/twindatadriven/joint`。运行时按每项的 `e` 校验资产来源，按 `p` 识别字段，读取 `v` 作为当前值。

| `data[].p` | 用途 |
| --- | --- |
| `deviceCode` | PLC 侧设备编号或设备类型辅助字段；模型匹配仍以 topic 资产编号和 `modelAsset.assetCode` 为准。 |
| `mode` | 设备模式；运行时写入状态日志和 metadata，用于现场判断自动/手动/故障等状态。 |
| `front_task`、`back_task` | 前叉、后叉当前任务号或任务计数。 |
| `signalBits`、`front_signalBits`、`back_signalBits` | 整机、前叉、后叉信号位快照；第一版用于 metadata 与排查，不直接改变几何运动。 |
| `movement_x`、`movement_y` | 水平行走和载货台升降的连续运动方向。 |
| `front_movement_z`、`back_movement_z` | 前/后货叉伸缩的连续运动方向。 |
| `rpm_x`、`rpm_y`、`front_rpm_z`、`back_rpm_z` | 水平、升降、前叉、后叉速度参考；没有正值时使用模型默认速度。 |
| `distance_x`、`distance_y`、`front_distance_z`、`ront_distance_z`、`back_distance_z` | 编码器校准值。 |
| `workingHours_x`、`workingHours_y`、`front_workingHours_z`、`back_workingHours_z` | 水平、升降、前叉、后叉累计运行小时；第一版用于 metadata 与排查。 |
| `front_containerCode`、`back_containerCode` | 前叉、后叉当前托盘条码；非空时运行时创建对应货物并随该侧货叉运动。 |
| `front_command`、`back_command` | 前叉、后叉作业状态；`3/4/5` 表示放货阶段，会把该侧货物送入目标定位线框。 |
| `normal`、`errorCode`、`message` | 正常、故障码与故障消息状态。 |
| `front_x`、`front_y`、`front_z` | 前载货台当前位置。 |
| `to_x`、`to_y`、`to_z` | 目标位坐标。 |

DDJ2 运动编码按第一版运行时规则解释：`movement_x = 0/1/2` 分别表示静止、前进、后退；`movement_y = 0/1/2` 分别表示原位、上升、下降；`front_movement_z/back_movement_z = 1/2/3/4` 分别表示右伸、左缩、左伸、右缩。`rpm_*` 为正值时换算为速度参考，否则使用模型默认速度；`normal = false`、`errorCode != 0`、`front_command = 8` 或 `back_command = 8` 会进入故障/急停状态，暂停目标追踪和连续运动。

`to_x`、`to_y`、`to_z` 三个值非零有效时，运行时生成目标位 ID `${to_x}-${to_y}-${to_z}`，并查找场景中的 `locator.assetId`，例如 `1-1-1`。目标位存在时模型追踪该 locator；三者全为 `0` 时不查目标位，模型按 `movement_*` 字段持续运动。

Stacker 水平行走不会移动导入模型根节点。运行时优先读取模型脚本 `dataDriven.motion.travel.nodes`，只驱动行走机构、立柱、载货台和货叉等可动部件；`dataDriven.fixedNodes` 中的上下轨道保持固定。行走位置会先投影到轨道轴，再按固定轨道的世界包围范围夹紧：即使 `distance_x` 超过轨道长度、目标位线框放在轨道外，机体也只能停在轨道端点内，不允许脱离轨道。行走、升降和货叉伸缩会先合成为节点世界偏移，再换算回各自父级本地坐标，避免毫米源模型缩放后位移量错误，也避免同一节点被多个动作顺序覆盖。

`distance_*` 字段始终只作为编码器校准值，不作为目标位选择依据。为兼容历史数据，运行时同时接受 `front_distance_z` 和拼写错误的 `ront_distance_z`。

`front_containerCode` 或 `back_containerCode` 非空时，运行时会创建一个只存在内存中的货物盒，分别跟随前叉或后叉。对应侧 `front_command/back_command` 进入 `3` 放货中、`4` 请求卸货或 `5` 放货完成，且 `to_x/to_y/to_z` 命中的 locator 存在时，货物会从该侧货叉逐步进入目标虚拟定位线框；放货完成后即使叉上条码清空，货物也保留在目标框内。条码切换时，未完成落位的旧货物会从运行时清理，已经落位的货物继续保留在对应 locator 中；这些货物不写入 `SceneDocument`，也不进入 undo history。

收到故障或急停状态时，运行时暂停追目标和 `movement_*` 积分，只保留编码器校准与故障状态展示；故障解除后再恢复动作解析。

## Conveyor 输送线 MQTT 第一版语义

Conveyor 输送线复用同一套 PLC/MQTT 遥测层，1001 输送线数据应发布到 `dt/factory/logistics/conveyor/1001/twindatadriven/joint`。场景中被驱动的输送线模型实例必须把 `modelAsset.assetCode` 设置为 `1001`，否则 payload 即使被订阅也不会驱动该模型。

第一版 Conveyor 语义聚焦实时联动和现场可视排查：运动、条码和机构状态只进入运行时内存快照，驱动模型脚本或运行时动画；不会写入 `.scene.json`，也不会进入 undo history。

| `data[].p` | 第一版用途 |
| --- | --- |
| `deviceCode` | PLC 侧设备编号或输送线编码，作为 topic 资产编号的辅助校验字段。 |
| `mode` | 输送线运行模式，写入运行时状态和 metadata。 |
| `task` | 当前输送任务号或任务状态。 |
| `movement_x`、`movement_y` | 输送线局部 X/Y 方向运动信号；`0` 表示停止，`1` 或正值表示沿局部正向运行，`2` 或负值表示沿局部反向运行。 |
| `signalBits` | 输送线 IO/传感器位掩码：位 0 前端有货、位 3 后端有货、位 4 顶升低位停准、位 5 顶升高位停准。 |
| `front_signalBits`、`back_signalBits` | 分离式前/后工位光电；非零时优先于 `signalBits` 对应位。 |
| `front_has_goods`、`back_has_goods` | 运行时派生布尔字段，供模型生成器规则和仓储流直接消费；payload 显式提供时不覆盖。 |
| `lift_at_low`、`lift_at_high` | 从 `signalBits` 位 4/5 派生的顶升低位/高位停准状态。 |
| `containerCode` | 当前容器、托盘或料箱条码；非空时可在运行时创建或绑定对应内存货物。 |
| `workingHours_x`、`workingHours_y` | X/Y 方向机构累计运行小时，用于状态展示和排查。 |
| `normal`、`errorCode`、`message` | 正常、故障码与故障消息；`normal = false` 或 `errorCode != 0` 时应暂停输送运动并保留故障信息。 |
| `layer` | 当前层、楼层或线体层级。 |
| `rotation` | 容器或转向机构旋转角度/状态，按模型脚本约定映射到可视旋转。 |
| `container_quantity` | 当前线体上容器数量或占用数量。 |
| `folding`、`flip`、`fork` | 折叠、翻转、拨叉/货叉等机构状态；第一版作为脚本输入和 metadata，不改变场景持久数据。 |
| `result`、`result2` | 主结果码和扩展结果码，用于展示任务完成、失败或异常状态。 |

Conveyor 第一版运动规则按“资产编号匹配 + 局部轴驱动 + 状态兜底”处理：topic 资产编号先匹配 `modelAsset.assetCode`；匹配成功后，`movement_x/movement_y` 只驱动该输送线模型声明的可动节点或货物运行态，不移动无关模型；`containerCode` 为空时只更新设备状态，非空时才创建或绑定容器货物；故障状态出现时停止连续运动，但保留最后一帧位置、条码和状态供现场排查。

## MQTT 现场排查步骤

1. 先确认 MQ 配置启用，并检查 WebSocket 地址是否能连接到 broker；只填 IP/域名时应自动生成 `ws://<IP>:8083/mqtt`。
2. 确认订阅 topic 使用通用格式 `dt/factory/logistics/+/+/twindatadriven/joint`，现场实际消息应落在 `dt/factory/logistics/stacker/DDJ2/twindatadriven/joint` 或 `dt/factory/logistics/conveyor/1001/twindatadriven/joint` 这类具体 topic 上。
3. 确认 payload 是 JSON，且 `data[]` 每项都包含 `e/p/v`；`e` 应与 topic 中的资产编号一致，`p` 必须是当前设备支持的字段名。
4. 在 Inspector 检查目标模型的 `modelAsset.assetCode`，堆垛机应为 `DDJ2`，输送线应为 `1001`；不匹配时运行时不会驱动模型。
5. 排查 DDJ2 时优先看 `normal/errorCode/message`、`movement_x/movement_y/front_movement_z/back_movement_z`、`rpm_*`、`distance_*` 和 `to_x/to_y/to_z`；目标位模式还要确认场景中存在对应 `locator.assetId`。
6. 排查 1001 时优先看 `normal/errorCode/message`、`movement_x/movement_y`、`containerCode`、`signalBits`、`layer/rotation/container_quantity/folding/flip/fork/result/result2`。
7. 如果画面不动但 Console 有 MQTT 日志，优先检查设备类型段、资产编号、payload 字段名和模型脚本声明；实时数据只在内存中，保存/加载场景或执行撤销/重做不会保留上一帧遥测。

## Stacker MQTT 演示场景与模拟器

仓库提供一组本地演示场景，用于验证 Stacker MQTT 数据驱动链路：

- 演示模型包：默认引用 `F:\3d-models\models\Stacker` 中的真实 `Stacker.glb` 和 `stacker.model.ts`
- 演示场景：`examples/scenes/stacker-mqtt-demo.scene.json`
- 场景内模型资产编号：`DDJ2`
- 场景内目标位：`locator.assetId = "1-1-1"`、`"2-1-1"`、`"3-2-1"`
- 默认 MQTT 地址：`ws://127.0.0.1:8083/mqtt`
- 演示场景订阅 topic：`dt/factory/logistics/stacker/+/twindatadriven/joint`，用于 Stacker 示例；现场通用订阅可改为 `dt/factory/logistics/+/+/twindatadriven/joint`
- 默认本地模拟：启用，资产编号 `DDJ2`，场景 `cycle`，间隔 `500ms`

演示场景生成脚本会读取模型包 `meta.json.lengthUnit` 并按标准映射重建换算系数；当前 Stacker 包显式声明 `lengthUnit = "millimeter"`，因此保存为 `unitScaleToMeters = 0.001`。脚本不会根据 GLB bounds 或参数内容猜测物理单位。

生成或刷新演示场景：

```bash
npm run demo:stacker:scene
```

如果 Stacker 模型包不在默认路径，可用 `STACKER_MODEL_DIR` 指向包含 `Stacker.glb`、`meta.json`、`stacker.model.ts` 的目录后再运行生成脚本。

打印一条模拟消息，不连接 broker：

```bash
npm run demo:stacker:mqtt -- --once --stdout
```

连接本地 MQTT over WebSocket broker 并持续发布 `DDJ2` 数据：

```bash
npm run demo:stacker:mqtt
```

如果没有部署 MQTT broker，加载 `examples/scenes/stacker-mqtt-demo.scene.json` 后保持 MQ 配置中的“启用配置”和“本地模拟”勾选，再点击 Toolbar “运行”；通过预检后，编辑器会在本次运行态内部生成同协议数据，不需要执行外部 broker。普通 Vite 浏览器调试可访问 `http://127.0.0.1:<port>/?demo=stacker-mqtt` 自动打开该演示场景；加载完成后仍需点击“运行”才会启动本地模拟。点击“停止”会断开本次模拟、清理运行时货物和诊断快照，并把模型姿态恢复到运行前，用于验证重复运行不会累计漂移。开发服务器会通过只读 `/__editor_asset__/` 通道加载 `editor-asset://local/` 指向的本地模型、脚本和贴图，正式 Electron 环境仍走受控本地资产协议。

模拟器支持 `--scenario cycle|target|movement|fault`。其中 `cycle` 会在目标位追踪和全 0 目标位 movement 模式之间切换；`target` 会按目标位序列让前叉、后叉交替携带托盘，并在 `front_command/back_command=3/4/5` 阶段把货物放入 `1-1-1`、`2-1-1`、`3-2-1` 虚拟定位线框；`movement` 会持续发送 `to_x=0,to_y=0,to_z=0`，用于验证不查 locator 时按 `movement_*` 移动且用 `distance_*` 校准；`fault` 会发送急停状态，用于验证运行时暂停追目标和 movement 积分。

运行时会先完成模型文件加载、源单位缩放、底部中心归一、参数化脚本初始化和 Stacker 遥测基线重建，然后才允许 MQTT/本地模拟帧驱动动画。这样模型会先以正确位置和比例进入场景，再由 `to_*` 或 `movement_*` 推动，不会在加载阶段把错误单位或未初始化节点写进动画基线。

## 构建检查

如果外部模型包只有 `meta.json.parameterScripts` 而没有 `modelParameters`，可执行以下脚本从已有脚本字段补齐 Inspector 参数 schema；脚本会先在每个模型包目录创建 `meta.json.bak-*` 备份，再写回 `meta.json.modelParameters`：

```bash
node scripts/sync-model-parameters-from-scripts.mjs --write
```

修改 `F:\3d-models\models` 的模型脚本或元数据并同步到 `Assets/Models` 后，可刷新当前项目资产索引与 `assetRevision`：

```bash
npm run refresh:model-assets
```

只刷新单个模型时可设置 `BABYLON_MODEL_FILTER`，例如 PowerShell 中执行：

```powershell
$env:BABYLON_MODEL_FILTER='Stacker'
npm run refresh:model-assets
```

可通过 `BABYLON_MODEL_ROOT` 指向其它模型项目根目录。


执行 TypeScript 类型检查：

```bash
npm run typecheck
```

执行米制导入、编辑器原生实际尺寸与 12 个外部模型参数脚本 smoke：

```bash
npm run smoke:units
```

执行大场景容量定向 smoke，验证静态模型共享、100 实体单源加载、选择增量同步和 4 并发加载预算：

```bash
npm run smoke:scene-capacity
```

执行 Shelf 脚本化共享、选择隔离与高密度 thin instance 回归：

```bash
npm run smoke:shelf-instancing
```

执行完整构建检查：

```bash
npm run build
```

## 基础操作

- 首页进入编辑：启动后在首页点击 `新建场景` 可重置为空白场景并进入编辑器；点击 `打开场景文件` 可选择 `.scene.json`；点击 `打开项目目录` 可进入编辑器并让 Project 面板加载本地项目资源；点击最近场景会直接加载对应场景。左侧数据中台项目卡片提供 `打开`：有可用工程包时下载并加载唯一场景，没有工程包或属于旧格式时创建当前格式本地项目并进入空白场景。
- 数据中台配置：点击首页顶部 `数据中台配置`，填写 HTTP/HTTPS 服务根地址并选择 `保存并刷新`；本地联调可使用 `http://127.0.0.1:8086`。地址持久化到 Electron `userData/data-platform-config.json`，主进程随后请求 `<服务地址>/api/v1/projects/query`；留空保存可清除配置。左侧项目列表顶部可输入项目名称后按 Enter 或点击 `搜索`，搜索词通过请求体 `projectName` 字段交给数据中台筛选，点击 `清除` 会恢复默认列表。renderer 打开项目时只提交列表中的 `projectId`，工程包地址由主进程最近一次可信列表缓存解析；项目、Editor 工程和模型等业务主键始终按十进制字符串传递，避免 19 位 ID 被 JavaScript `number` 截断。
- 数据中台工程包：只接受当前 ZENDING 3D EDITOR 目录结构，即 `.babylon-editor/`、`Assets/Models/`、`Assets/Environments/` 和恰好一个 `.scene.json`；ZIP 根目录和单层包装目录均可。旧 `project.bjseditor` 不迁移，统一按无可用工程包处理。主进程限制 ZIP 压缩体积、文件数、单文件及总展开大小，并拒绝 Zip Slip、绝对路径、盘符路径、加密条目和符号链接。
- 数据中台模型同步：打开项目后后台分页读取 `POST /api/v1/models/query`、`POST /api/v1/env-models/query` 和 `POST /api/v1/combo-models/query`。普通模型写入 `Assets/Models/Model-<id>-<名称>/`，环境模型写入 `Assets/Environments/Env-<id>-<名称>/`，组合模型写入 `Assets/Models/ComboModels/Combo-<id>-<名称>/`。普通模型脚本为可选资源：优先使用 `scriptFiles` 权威列表，仅在列表没有有效项时读取旧 `scriptFileName/scriptFileUrl` 兼容字段；接口提供可识别的 `*.ts` 文件名或 URL 时才下载，不要求文件名以 `.model.ts` 结尾，旧字段中以换行拼接的多脚本也会拆分处理；未提供脚本或返回非 TS 条目时直接跳过，不阻断模型同步。同步层会保留这些 TS 文件，编辑器现有外置脚本执行仍遵循 `.model.ts` 运行约定。所有数据中台项目共享同一模型库；下载和校验全部完成后才原子替换模型目录与 `.babylon-editor/asset-index.json`。同步成功后 Project 模型库会自动刷新并优先展示同步模型；失败时保留旧库，失败提示支持关闭，也可在 Project 面板重试。
- 数据中台存储位置：开发态继续使用 `app.getAppPath()`；安装态改用 Electron `userData/data-platform-workspace`（Windows 通常位于 `%APPDATA%/zending-3d-editor/data-platform-workspace`），不再向 EXE 所在目录或 `Program Files` 写入项目、场景和共享模型。首次打开会自动创建工作区，无需以管理员身份运行；测试环境仍可通过受保护的 `ZENDING_EDITOR_STORAGE_ROOT` 覆盖路径。 旧版本若已在自定义可写安装目录生成数据，不会自动删除，可继续通过“打开项目目录”访问或手动复制到新工作区。
- 创建基础对象与常用灯光：在模型库中点击或拖拽 `立方体`、`球体`、`地面`、`虚拟定位线框`、`半球光`、`方向光`、`点光源` 内置资源卡片；Box/立方体卡片明确标注默认尺寸 `1 m × 1 m × 1 m`，拖拽到 Scene View 后会按鼠标释放位置投射到地面平面，并把 Box 中心抬高 `0.5 m` 使底面落地；其它对象保持原有创建路径。
- 创建 POI 模型生成器：在 `POI库` 点击“模型生成器”可在原点创建青色配置标记，拖入 Scene View 可按地面落点放置标记；一个场景只保留一个有效生成器，重复点击/拖入会选中已有生成器。随后把模型库普通模型或内置立方体、球体、地面拖入 Inspector 的共享生成模板或规则覆盖模型槽位。
- 选择对象：点击 Hierarchy 项，或在 Scene View 中单击对象；Hierarchy 中可使用 Ctrl/Cmd 多选、Shift 连续多选。
- 整理层级：在 Hierarchy 点击 `新建` 可创建纯分组文件夹，将一个或多个普通实体拖入文件夹可完成分组；拖到 `根层级` 可移出文件夹。选中文件夹时，组内实体会在 Scene View 中一起高亮；文件夹只影响左侧列表归类，不改变模型世界坐标或 Transform 父子关系。右键菜单中的 `群组对象` 会创建新分组并把当前普通实体选区移入分组，`解组对象` 会把选中文件夹或选中对象所在文件夹释放回根层级。
- 控制对象状态：Hierarchy 实体与文件夹行前的显示按钮可隐藏/显示对象或整组对象，锁定按钮可锁定/解锁对象或整组对象；右键菜单和快捷键支持批量隐藏、批量锁定与批量删除。隐藏对象不会在 Scene View 显示或被拾取，锁定对象仍显示但不能被画布拾取、挂载 Gizmo、删除或通过 Inspector 编辑。
- 复制、粘贴与阵列：在 Hierarchy 右键菜单或快捷键中复制当前普通实体选区；粘贴到右键文件夹时进入该文件夹，粘贴到右键普通对象时进入同级，粘贴副本会生成新 ID 并轻微偏移位置；模型生成器会被复制、粘贴和阵列入口跳过或拦截，避免产生第二个有效生成器。`模型阵列` 可按 +X/-X/+Y/-Y/+Z/-Z 方向、阵列净间距和副本数量生成线性阵列副本，净间距按单个模型或整个多选组的世界包围盒边缘计算；净间距为 `0` 时相邻包围盒边缘贴合，阵列完成后原始选区保持原位和选中状态。阵列弹窗可填写一次性资产编号规则，支持导入模型 `modelAsset.assetCode` 与虚拟定位线框 `locator.assetId`：所有源对象的副本名称都按源名称末尾数字递增，只有字符串时追加序号且不添加“副本”；导入模型和定位线框的资产编号则分别按原编号或自定义规则生成。名称或资产编号与场景已有值、同批新副本冲突时会显示具体冲突并禁止确认；多个带编号对象多选时禁用自定义规则但分别默认递增，无编号对象不新增资产编号字段。
- 聚焦对象：右键菜单 `场景聚焦` 或 F 会根据当前 Hierarchy 选区世界包围盒移动 Scene View 相机；导入模型可用 `库聚焦` 切换到底部 Project 模型库并滚动高亮对应资源卡片。
- 清空选择：在 Scene View 中单击空白区域。
- 切换 Gizmo：点击顶部工具栏的移动、旋转、缩放图标按钮，或使用 W/E/R 快捷键。
- Shift 拖拽阵列：保持编辑模式和移动工具，单选一个未锁定的导入模型、内置 Mesh、虚拟定位线框、已解锁 CAD 参考层或 POI 特效，按住 `Shift` 后拖动 X/Y/Z 单轴箭头；文件夹、灯光和模型生成器不会触发。拖动超过当前轴向真实投影跨度的一半后开始实时出现零间距副本，最多 100 个，源对象始终不移动。POI 预览只克隆静态可见 Mesh，纯粒子效果使用半透明范围代理，不会临时创建最多 100 套粒子系统；确认后的正式 POI 副本仍保留完整粒子和动画。松开左键后方向固定为本次 `+X/-X/+Y/-Y/+Z/-Z（局部/世界）`，可在弹框修改新增副本数量和净间距；导入模型/定位线框还可使用对应编号规则，预览会实时更新。`Esc`、点击遮罩或“取消”不会写入场景和撤销历史。
- 切换坐标空间：点击 `局部` 或 `全局`。
- 开启吸附：勾选 `吸附`，并调整位置、旋转、缩放步长；其中位置步长单位为 `m`。
- 控制网格：在 Toolbar 中勾选或取消 `网格` 控制 Scene View 固定大范围地面辅助网格显示，并通过 `格子` 下拉选择 `1 m`、`2 m`、`5 m`、`10 m` 四档格子大小。
- 导入 CAD 参考图：点击 Toolbar 的 `导入CAD参考图` 选择 `.dxf` 文件；小于 `64 MB` 的普通图纸保持精确解析，达到 `64 MB` 的大图纸自动切换 Web Worker 轻量扫描，并限制在最多 `200000` 条折线 / `800000` 个点。单位优先读取 `$INSUNITS` 0–24；unitless/缺失时参考 `$MEASUREMENT`，仍未知时按毫米兜底并在日志/Inspector 明确提示。所有坐标换算为米后按包围盒中心归零，并贴到网格层上方约 `0.01 m`。
- 切换 CAD 俯视：点击 Toolbar 的 `俯` 图标按钮，Scene View 会保留当前观察中心和缩放距离，从世界 Y 轴上方向下观察 XZ 地面；切换前的旋转、平移和缩放惯性会被清除，避免视角继续漂移。该操作不会覆盖已保存视角，也不会写入场景文件或撤销历史；运行预览中仍可使用。
- 调整视野：在 Toolbar 中通过 `视野` 下拉选择 `近景`、`标准`、`远景`、`全景`，用于快速调整 Scene View 默认相机观察距离和可视范围；也可使用鼠标滚轮靠近或远离模型，近距离缩放会保留最小观察距离，便于查看模型细节且避免画面变黑。
- 查看 Console：点击底部 Project 区域最下方的 `Console` 最小化入口可弹出日志窗口，点击关闭按钮或按 Escape 可收起弹窗。
- 编辑属性：在 Inspector 中修改名称、Transform、材质颜色或灯光属性；position 按米输入，rotation 按角度输入但内部仍使用 Babylon 弧度，通用 scale 保持无量纲。内置 Box 的 `size (m)` 直接对应实际边长，Sphere/Plane 显示其米制基准说明；导入模型、环境模型和 CAD 均展示源单位到米的换算信息。
- 删除实体：点击顶部工具栏 `删除`，或使用 Delete/Backspace 快捷键。
- 浏览资源库外观：底部图库区域会根据窗口高度在约 `300px` 到 `460px` 之间自适应，在 Project 面板中点击 `模型库`、`POI库`、`主题库`、`组合库`、`环境库`、`图表库`、`图片库` 页签，可切换不同资源库展示；小窗口下页签通过内部横向滚动访问，资源卡片按可用宽度自动换行，超过可见高度后通过纵向滚动访问；模型库和环境库卡片有封面图时显示模型包封面，没有封面图时显示类型占位图标；模型库点击 `导入模型文件夹` 导入普通模型并复制到项目 `Assets/Models`，环境库点击 `导入环境 GLB` 直接选择单个 `.glb`，并保存到项目 `Assets/Environments` 下的独立单文件包；两者严格分库，同名重导只覆盖当前入口对应的目标资产。当前场景正在使用同一环境包时，重导产生的新 `assetRevision` 会写入环境资源 URL 查询参数并自动重载当前环境。
- 图片库贴图拖放：图片库当前内置透明发光方向箭头；选中带 `texture` 模型参数的导入模型后，可把图片卡片拖入 Inspector 参数区。属性保存 `editor-image://` 逻辑引用并进入撤销/重做历史，运行时统一解析为构建后的真实图片 URL。
- 放置模型：模型库中已导入的真实模型卡片支持点击或拖拽；点击会把模型导入到原点，拖拽到 Scene View 后释放会按鼠标位置投射到地面平面并在对应世界坐标创建模型。
- 资源库功能边界：模型库当前支持内置基础资源创建与真实模型文件夹导入，环境库支持单 GLB 文件导入；同名资产再次导入会覆盖项目目录中对应分库资产，其余资源库仍为样式占位。本地模型导入依赖 Electron preload 暴露的文件 API，需要使用 `npm run dev:electron` 启动桌面编辑器，普通 Vite 浏览器页面不具备该能力；Electron 主窗口通过 CommonJS preload 产物 `dist-electron/preload.cjs` 注入 `window.editorApi`。

场景级属性面板：

- 在 Scene View 点击非模型位置后，右侧 Inspector 会显示场景级设置，而不是对象属性。
- 场景区支持修改场景名称、初始化空白场景和导入 CAD 参考图；初始化会清空当前实体、历史记录和场景级设置。
- 相机区支持保存当前视角、复位到已保存视角，以及通过连续滑杆设置 Scene View 可视距离。
- 编辑器设置区支持缩放、移动、旋转三类相机操作灵敏度，数值范围为 `1-20`，默认值为 `10`。
- 环境属性区只接收环境库模型包：可从底部环境库点击应用，也可拖入环境属性区作为不可拾取的环境底座；模型库普通模型只能拖入 Scene 创建实体。包内主模型作为默认预设，其余 `.glb/.gltf` 文件会作为自定义效果卡片切换。

虚拟定位线框最短验收：

1. 执行 `npm run dev:electron` 启动 Electron 编辑器。
2. 在 Project 面板模型库点击或拖拽 `虚拟定位线框`，Scene View 中会出现可拾取的长方体线框。
3. 选中该实体，在 Inspector 的“虚拟定位线框”区域修改 `资产编号`、`长(X)`、`宽(Z)`、`高(Y)`，线框尺寸会实时变化。
4. 点击 Toolbar 的 `保存场景` 导出 `.scene.json`，再通过 `加载场景` 打开该文件，确认资产编号和长宽高保持一致。

## 架构说明

项目按桌面壳、渲染器 UI、编辑器领域模型与运行时渲染层拆分：

- Electron 主进程：负责创建桌面窗口、管理应用生命周期，并承载需要在主进程中执行的本地能力。
- preload 安全 API：作为主进程与 renderer 之间的受控桥接层，避免 renderer 直接暴露高权限 Node.js 能力；本地模型通过 `editor-asset://` 受控协议加载，项目内资源通过 `.babylon-editor/asset-index.json` v2 记录，普通模型指向 `Assets/Models`，环境模型指向 `Assets/Environments`；v1 旧索引条目默认归模型库且不移动旧文件；首页最近项目、最近场景、按路径加载场景和移除最近记录也通过受控 IPC 暴露。
- React renderer：负责编辑器界面、面板布局、用户交互与状态展示，并通过入口错误边界将启动期异常转换为可见错误页。
- editor model：定义 SceneDocument、Entity、Transform、MeshRenderer、ModelAsset、Light 等编辑器核心数据结构，是保存/加载与 UI 编辑的统一数据来源。
- commands：封装可撤销编辑操作，并维护撤销/重做命令历史。
- runtime/babylon：负责将编辑器场景文档增量同步到 Babylon.js 运行时场景，包括 Mesh 创建、模型导入、灯光同步、Transform 同步与选中高亮；安全静态模型和 Shelf 通过共享源容器实例化，资产加载由固定并发调度器控制，Scene View 统一处理 WebGL 上下文与渲染循环恢复。
- panels：按编辑器区域拆分 UI，包括 Hierarchy、Scene、Inspector、Project、Console 等面板。

## 场景文件说明

当前场景文件使用 `.scene.json` 后缀，内容为 JSON 格式的 `SceneDocument`。

场景文件的核心约定：

- `version` 当前为 `1`，用于后续场景格式演进和兼容处理。
- 长度单位固定为米：`1 scene unit = 1 m`。
- 所有模型最终都按米进入场景：内置模型使用显式米制基准；普通模型、模型生成器导入目标和环境模型通过 `lengthUnit + unitScaleToMeters` 把厘米/毫米源几何换算到米；普通模型缺少单位声明时按 `meter / 1`，不根据几何大小或参数脚本猜测；直接导入的环境 GLB 按 `meter / 1` 登记。
- 新保存的场景文件会写入 `units.length = "meter"`；旧版没有 `units` 字段的场景文件会按米兼容加载。
- `SceneDocument` 保存场景实体、基础对象类型、外部模型资源路径、灯光组件、Transform、Hierarchy 文件夹分组以及实体/文件夹 `visible`/`locked` 状态等编辑数据。
- 模型生成器实体保存可选 `components.modelGenerator`：包含默认目标、规则、TTL、MQTT 绑定和可选 `warehouseFlow` 三设备绑定引用。导入模型目标保存授权 `editor-asset://local/` URL、`assetRevision`、脚本元数据和默认参数快照；运行时派生输出、普通设备货物、已入库货物与青色线框不保存。旧场景缺少该字段时无需迁移；旧场景存在多个模型生成器时仅 `entityIds` 中第一个在运行时生效。
- 加载场景时会进行基础校验，格式不合法或结构不符合预期的 scene 文件会被拒绝，避免破坏当前编辑器状态。
- 场景加载成功后会重置 `selectedEntityId`，避免旧选中对象引用到新场景中不存在的实体。
- 场景加载成功后会重置 command history，避免跨场景执行旧的撤销/重做命令。
- glTF/GLB 模型实体保存的是项目内资源路径、`editor-asset://` 受控资产 URL、实例资产编号 `modelAsset.assetCode`、源单位 `lengthUnit` 与换算系数 `unitScaleToMeters`；移动或删除项目目录中的 `Assets/Models` 模型包后，需要重新导入对应模型包。
- 带参数化配置的模型实体会额外保存 `modelAsset.parameterConfig` 与 `modelAsset.parameterValues`：前者是从模型包 `meta.json.modelParameters` 归一化得到的参数 schema 与 binding 快照，后者是当前场景实例的参数值。旧场景缺少这些字段时仍按普通导入模型兼容加载。
- Inspector 的 `selectedModelMeasurement` 是运行时临时快照，只用于显示当前选中模型的 `loading / ready / unavailable` 状态和米制尺寸，不进入场景 JSON、撤销历史或实体剪贴板；切换选择或场景时清空。
- `虚拟定位线框` 实体会保存 `locator.assetId`、`locator.length`、`locator.width`、`locator.height`，重新加载 `.scene.json` 后仍能恢复资产编号与长方体线框尺寸。
- `CAD参考图` 实体会保存 `cadReference.sourcePath`、`sourceUrl`、`sourceFileSizeBytes`、`importMode`、源单位代码/名称、单位判定来源、米制换算比例、中心归零方式、线色、透明度、图层统计与包围盒；旧场景缺少单位审计字段时保留原换算系数并标记为 legacy，源文件被移动或删除时无法恢复线稿。
- 带外置脚本的模型实体会额外保存 `modelAsset.scriptAssets`、`parameterScriptMetadata` 与 `animationScriptMetadata`；加载场景时主进程会重新授权这些 `.model.ts` 文件，运行时把当前参数和 `assetCode` 同步到脚本实例与 Babylon 节点 metadata。
- 场景级 MQTT 配置保存在 `mqttConfig.enabled`、`mqttConfig.ip`、`mqttConfig.address`、`mqttConfig.topic`、`mqttConfig.simulatorEnabled`、`mqttConfig.simulatorAssetCode`、`mqttConfig.simulatorScenario` 和 `mqttConfig.simulatorIntervalMs` 中；旧场景缺少该字段时会自动补齐 MQTT 默认 topic 和本地模拟默认值。
- 场景级编辑设置保存在 `sceneSettings.camera`、`sceneSettings.sensitivity` 和 `sceneSettings.environment` 中；旧场景缺少该字段时会自动补齐默认可视距离、默认灵敏度和空环境模型。
- `sceneSettings.environment` 记录环境模型包路径、源单位、`unitScaleToMeters`、缩略图、当前激活变体和包内变体列表；旧场景缺少环境单位字段时按 `meter / 1` 兼容。运行时在独立环境根节点应用单位缩放后，再按包围盒把模型右边界放到 `X=-2m`、底部放到 `Y=0`、Z 中心对齐 `Z=0`；环境不进入 Hierarchy，也不参与拾取和 Gizmo。

## 当前限制

- glTF/GLB 导入属于 MVP 级能力：支持导入、选择、基础 Transform、参数化外观绑定、保存和加载，不承诺完整材质编辑、动画、骨骼、蒙皮或嵌套资源管理。
- 大场景共享只对明确安全的重复资产生效：普通模型仅在没有外置脚本、参数配置、参数脚本元数据和动画脚本元数据时共享源几何/材质；Shelf 使用独立验证过的脚本化共享路径。Stacker `appearanceColor`、YZJ 顶点修改等动态模型继续独占容器，因此不同资产、动态脚本和高面数贴图本身仍受 GPU 能力限制；本轮不会用降分辨率、LOD 或纹理降采样换取容量。
- CAD/DXF 导入属于布局参考层能力：只承诺常见二维线稿实体 `LINE`、`ARC`、`CIRCLE`、`LWPOLYLINE`、`POLYLINE`；不承诺 HATCH、DIMENSION、完整 TEXT/MTEXT、Paper Space、多布局、3D Solid 或可编辑 CAD 图元。普通图纸保持精确解析，`64 MB` 及以上图纸使用后台轻量扫描和固定预览预算。DXF 合法 `$INSUNITS` 0–24 会换算为米；无单位图纸只能依据 `$MEASUREMENT` 或毫米 fallback，建议源 CAD 明确写入单位。超过 `±1e15` 的异常原始坐标会被过滤。
- 参数化模型依赖模型包中稳定的节点、网格或材质名称；安全 DSL 只支持 JSON AST 中的白名单运算和白名单属性绑定，不执行任意 JavaScript/TypeScript。贴图参数允许编辑器登记过的内置 `editor-image://` 逻辑引用，或模型包内 `.png`、`.jpg`、`.jpeg`、`.webp` 相对路径；仍不支持绝对路径、网络 URL、`data:`、反斜杠路径、未登记逻辑引用或 `../` 路径逃逸。重新导入模型包后，场景实例会使用新的 `modelParameters` 与 `.model.ts` 脚本元数据清洗参数：同名且仍合法的实例值会保留，新增参数使用新默认值，删除或非法参数会移除。
- Project 资源库中模型库和环境库已接入项目目录持久化；模型库普通模型包复制到 `Assets/Models`，环境库直接选择的单个 GLB 保存到 `Assets/Environments/<安全化文件 stem>/` 独立包。POI 库已接入模型生成器和 16 种内置 EFF，其它图表立标、图表面板、报警管理器、手动漫游卡片以及主题、组合、图表仍为占位；图片库已接入内置方向箭头和 texture 参数拖放，但尚未开放用户图片导入、项目级图片索引和真实搜索过滤。
- 首页数据中台配置、远程项目列表、项目打开和最近场景都依赖 Electron preload IPC；普通 Vite 浏览器页面会显示降级提示，并仅保留进入空白编辑器、新建场景等不依赖桌面权限的基础入口。当前不包含身份令牌配置或数据中台项目详情交互。
- 主布局自适应当前只包含随窗口尺寸自动调整、左右面板贯通到底部、Project/Console 限定为中间 Scene 同宽以及底部 Console 弹窗入口，不包含拖拽分隔条、其它面板折叠或用户自定义布局保存；小于约 `1024×640` 的窗口会继续尽量收缩，但不保证所有内容舒适可读。
- 图片库当前只登记内置方向箭头资源；用户图片导入、项目级图片持久化与更多图片类型仍待扩展。POI 库的模型生成器与 16 种内置 EFF 可用，图表立标、图表面板、报警管理器、手动漫游以及图表、主题、组合仍为占位分类。
- 灯光编辑支持类型与强度，暂未提供颜色、阴影、范围、衰减等高级参数。
- 当前 Hierarchy 文件夹仅用于场景对象组织分组；文件夹显隐和锁定会作用到组内对象，但不提供文件夹嵌套、文件夹 Transform 继承或批量 Transform 父子联动。

## 最近完成

- 2026-07-24：完成大场景交互第一阶段优化：Scene View 将纯选择变化从完整 `SceneRuntime.sync()` 拆到 `syncSelection()`，普通单选只刷新前后目标；共享模型/矩阵阵列描边按当前选区推导，thinInstance 选择缓冲通过实体连续区间差量改写。Hierarchy 使用 24px 固定行高、上下各 20 行 overscan 的虚拟窗口，10k/50k 行只保留受控 DOM。新增 1 Hz 性能 HUD 与最近一分钟 JSON 报告，采集 FPS、CPU/GPU frame time、Draw Call、active mesh、thinInstance、同步/分组耗时和 Long Task；Toolbar 新增“性能”复选框控制 HUD 显示与隐藏，隐藏期间持续采样并保留报告历史；同时新增 `npm run smoke:editor-performance` 数量级回归。
- 2026-07-24：Windows 正式打包版新增 `disable-gpu-sandbox`，与既有高性能 GPU 请求、软件 rasterizer 禁用和 Scene View 硬件 WebGL 严格校验共同固化到 `app.asar`；开发态继续保留 GPU sandbox，不绕过 Chromium GPU blocklist，也不固定 ANGLE 后端。生产 GPU smoke 新增开关策略检查，并在 Scene View 创建内置立方体后确认硬件 WebGL 上下文未丢失。该企业部署策略降低 GPU 进程隔离强度，使用方已明确接受相应安全风险。
- 2026-07-23：修复 thinInstance 模型阵列中每个逻辑模型的参数化脚本失效：运行时按完整模型参数快照分组，相同参数组合共享一个隐藏脚本宿主，不同组合独立执行声明式参数绑定和外置参数脚本；脚本输出继续一次性提交为 thinInstance，宿主不显示、不拾取。连续调参复用原宿主，恢复相同参数后自动合并批次，源 GLB 仍通过资产缓存复用。
- 2026-07-23：Windows NSIS 安装包补齐 GPU/WebGL 安装态回归：新增 `smoke-packaged-gpu.mjs` 直接校验生产主进程 GPU feature、活动显卡、启动开关和 Scene View 实际 renderer，并通过版本核对阻断旧安装程序；`npm run smoke:installer:gpu` 串联完整构建、NSIS 产物生成和生产 EXE 验证。Windows 打包继续复用已安装的 Electron runtime，并在 `afterPack` 清理默认入口文件，避免端点安全软件导致解压目录重命名失败。
- 2026-07-23：固化编辑器 GPU/WebGL 硬件加速契约：Electron 在 ready 前请求高性能 GPU，BrowserWindow 明确启用 WebGL；Scene View 使用 `powerPreference: high-performance`、`failIfMajorPerformanceCaveat: true` 并拒绝 SwiftShader/WARP/llvmpipe 等软件 renderer，初始化失败通过现有 Scene 错误遮罩呈现；新增 `npm run smoke:gpu` 验证 Electron GPU compositing、WebGL 状态、上下文属性和实际 renderer。独立 Web Viewer 兼容策略不变。
- 2026-07-23：Shift+Gizmo 单轴阵列从普通导入模型扩展到全部可阵列实体：新增内置 Mesh、虚拟定位线框、已解锁 CAD 参考层和 POI 特效的世界/局部正负轴投影测量与不可拾取临时预览；POI 纯粒子效果使用半透明范围代理，不复制粒子系统。文件夹、灯光和全局唯一模型生成器继续排除。阵列名称统一改为按源对象名称末尾数字递增，例如 `测试 1001 → 测试 1002/1003`，纯字符串追加序号且不再添加“副本”；导入模型和定位线框的资产编号继续独立递增。导入模型的临时预览与正式结果统一改为固定批次 Mesh + thinInstance 矩阵，正式阵列项持久化在源实体 `components.modelArray` 中，不再按数量创建模型实体、脚本和加载任务；非模型阵列保持普通实体复制。确认、取消、生命周期清理和单条撤销/重做语义保持不变，场景版本仍为 `1`。
- 2026-07-22：新增普通导入模型 Shift+Gizmo 单轴阵列：局部/世界 X/Y/Z 拖动按可见几何投影跨度生成零间距临时克隆，原模型保持原位，松开后共享阵列弹框可实时调整副本数量、净间距和编号规则；确认时名称与 `modelAsset.assetCode` 从源资产编号同步递增并原子检查冲突，整组副本以一条命令撤销/重做，取消、失焦、选择/模式/场景变化会清理预览且不修改场景格式。
- 2026-07-22：首页启动台新增数据中台地址配置弹窗，配置持久化到 Electron `userData/data-platform-config.json`；左侧“最近项目”由主进程通过 `POST /api/v1/projects/query` 拉取、校验并按更新时间展示业务项目，支持 `projectName` 搜索，并新增可信项目 ID 打开流程。当前格式工程包会安全下载、展开并加载唯一场景；无包、旧 `project.bjseditor` 或结构不兼容时进入空白场景；进入编辑器后后台全量同步普通、环境和组合模型。已使用 `http://127.0.0.1:8086` 完成真实联调：19 位业务 ID 无损保留，10 个普通模型共 25 个文件同步成功，Shelf 双 TS 脚本不再被旧换行拼接字段重复下载。
- 2026-07-21：按参考图片重做 YZJ 一体式移载机参数契约，新增精确长宽高、主体颜色、辊筒框架位置/长度、电机位置、腿 A/B、电机与辊轮皮控制；通过连通组件处理单体 GLB，保留旧场景、MQTT 与方向箭头兼容，并完成静态、浏览器视觉矩阵和真实 Electron Inspector 联动验证。

- 2026-07-17：完成 Scene View 大场景无损容量与稳定性优化：普通无脚本/无参数静态模型按 `sourceUrl + assetRevision + instancingMode` 复用单份源 `AssetContainer`，100 个同源实体 smoke 仅加载 1 次源资源、每实体保持 18 个独立实例 Mesh；SceneRuntime 改为实体引用驱动的增量同步，选择变化不再重跑全部模型参数/脚本/子 Mesh 收集；模型和环境加载统一限制为最多 4 并发；关闭无功能依赖的 `preserveDrawingBuffer`，保留抗锯齿与 stencil，并增加 WebGL context lost/restored 和 render error/recovered 可见恢复。既有 Shelf smoke 保持 `loadCount=1`、低密度 88/128 Mesh、高密度 121608 thin instances 与单次源释放。
- 2026-07-16：Stacker 参数化脚本新增 `appearanceColor`“模型外观颜色”参数，默认 `#ffffff` 保留原 PBR 贴图外观；每个实例按原材质懒克隆并复用专属材质，反复换色不累计材质、多个实例不串色，停止时恢复原材质并释放克隆。源包、`Assets/Models/Stacker`、可视夹具、演示场景和定向刷新后的资产索引已同步，`smoke:model-parameters` 覆盖颜色类型、默认/自定义/非法颜色、材质复用、停止恢复和共享原材质的双实例隔离。
- 2026-07-16：Toolbar 新增“俯”视角按钮；点击后通过 Zustand 临时请求驱动 Babylon ArcRotateCamera 保留当前 target/radius 切换到稳定俯视，并清除旋转、平移和缩放惯性。该操作不修改场景文档、已保存视角或撤销历史，运行预览中仍可使用，便于结合底层 CAD/DXF 图纸搭建场景。
- 2026-07-16：完成全部 12 个外部模型参数化脚本的米制适配：`多穿小车/辊道机/链条机/box/GD/HCTS/LED/RGV/Shelf/Stacker/WLTS/YZJ` 的长度字段与元数据统一使用 `m`；通用脚本改为在实体根米空间测量，过滤无顶点 glTF 占位 Mesh，根缩放后保持底部中心锚点，并区分模型基线与生成克隆的包围盒上下文。源包、`Assets/Models` 副本、Shelf/Stacker/YZJ 可视夹具和资产索引同步刷新；`smoke:model-parameters` 已接入 `smoke:units`。
- 2026-07-16：调整编辑器主布局边界：Toolbar 下方左侧 Hierarchy 与右侧 Inspector 贯通到窗口底部；Project 模型库和 Console 入口移动到中间列，仅占 Scene 画布同宽，并保留 Project 高度 `clamp(300px, 38vh, 460px)` 与 Console 30px 最小化入口。
- 2026-07-16：修复 Scene View 从模型表面轻微拖拽视角时仍触发模型选中的冲突；点击快照现在锁存 Babylon 已累计的相机输入，并以 alpha、beta、radius 或 target 的位姿变化兜底，只要本次会话驱动过相机，就优先按视角拖拽处理，模型拾取、Gizmo、F 聚焦、运行预览和纯单击选择语义保持不变。
- 2026-07-16：POI 库新增“移动双箭头”作为第 16 种 EFF；多组无贴图发光 `>>` 沿实体本地 `+X` 循环移动并在两端渐隐，Rotation 控制业务方向，Speed、Density、Intensity 分别控制速度、组数与亮度/线段尺度；每组折线预合并为 3 个动画 Mesh，默认 9 个、最大 18 个，避免逐段 draw call 膨胀。
- 2026-07-15：普通导入模型的米制实际尺寸改为编辑器原生能力：Inspector 的 `Model Asset` 区固定显示 X/Y/Z，测量汇总 `contentRoot` 下有效 Mesh 并投影到实体自身轴，包含源单位、参数化几何和用户 scale，旋转/平移不造成数值跳变；测量快照不持久化。模型包单位同时与参数脚本彻底解耦，只接受显式 `meta.json.lengthUnit`，缺失按 `meter / 1`、非法值拒绝，不再按参数或包围盒猜测。
- 2026-07-15：POI 库新增 15 种统一 EFF 特效，支持点击/拖拽创建、通用 Inspector 参数、完整场景实体编辑与 Babylon 实时渲染；运行时使用稳定实体根节点、透明拾取壳和单一逐帧调度器，粒子及动态材质资源不会写入场景文件。
- 2026-07-15：模型生成器升级为场景级全局自动模型管理器：POI 库卡片和拖拽入口保留，但 Transform 只控制编辑态青色配置标记；重复新建、复制、粘贴和阵列会被拦截，旧场景按 `entityIds` 第一个生成器生效。该生成器统一管理普通 Conveyor、普通 Stacker 与 `warehouseFlow` 的模板/规则，实际货物位置来自输送面、货叉、locator 或仓储状态机；普通设备无生成器、无模板或加载失败时回退默认 Box，`warehouseFlow` 无模板时继续 fail-closed。
- 2026-07-15：YZJ 一体式顶升移载参数化脚本新增 `frontSide/backSide`（Inspector 显示为 MQTT 前端方向/后端方向），与 `infeedSide/outfeedSide` 独立保存并写入 `metadata.logisticsFlow`；仓储运行时按显式前端→后端或后端→前端锚点对应 `front_has_goods/back_has_goods`，旧模型包继续兼容入料→出料路径，端点重合时 fail-closed。源包、项目副本、视觉夹具与项目资产索引已同步。
- 2026-07-15：为 `F:\3d-projects\Stacker MQTT Demo.scene.json` 增加 1004 → DDJ2 → 虚拟库位 → 1005 仓储入库/出库联动：Conveyor 协议位派生前后有货和顶升停准字段，1004 后端高位到位后 DDJ2 才接管；出库补齐 DDJ2 `command=3/4/5` 后端交接、1005 顶升下降和前端输出阶段。模型生成器用三条严格绑定启用 `warehouseFlow`，同一 `containerCode` 只保留一个实例，双叉无法消歧时冻结；入库完成实例脱离生成器保留在库位，出库复用同一实例，仓储设备旧默认 Box 被抑制，停止预览统一回收。详见 `docs/stacker-warehouse-flow.md`。
- 2026-07-15：为 `F:\3d-models\models\box` 增加 Box 纸箱米制参数化脚本和元数据；源 GLB 按厘米换算到米，Inspector 可直接编辑 `长度 (m)`、`宽度 (m)`、`高度 (m)`，默认 `0.32 × 0.18 × 0.18 m`，脚本按 X=宽、Y=高、Z=长从单位基线绝对缩放并补偿底部中心位置，同步当前项目 `Assets/Models/box` 副本，并刷新 `.babylon-editor/asset-index.json` 的 Box 快照与 `assetRevision`。
- 2026-07-15：修复模型紧凑 Inspector 的参数标签固定为 `52px` 并显示省略号的问题；普通参数与贴图参数标签改为自适应宽度，超长中文名称自动换行完整显示，输入控件保持可收缩，Transform 的 X/Y/Z 轴标签继续使用紧凑单行布局，非模型属性面板不受影响。
- 2026-07-14：模型阵列弹窗新增一次性资产编号规则，支持导入模型 `modelAsset.assetCode` 与虚拟定位线框 `locator.assetId`；规则示例 `${1}-1-1` 生成 `2-1-1`、`3-1-1`，`${001}` 保留前导零，空规则按末尾数字递增或追加序号；多个带编号对象多选时禁用自定义规则但各自默认递增，无编号对象不新增字段，原对象、粘贴语义、场景格式、撤销/重做和保存/加载保持不变。
- 2026-07-14：POI 库新增“模型生成器”，支持点击/拖拽创建、共享生成模板与有序条件规则槽位、多 MQTT 完整绑定、1–3600 秒 TTL、撤销/重做、保存重载和模型重导刷新；Babylon 运行时使用稳定根节点派生内置 Mesh 或项目模型，运行预览仅在最新有效快照命中规则时输出，TTL 超时、无快照或无命中会销毁输出并保持编辑态青色线框不实例化模板，派生输出不进入 Hierarchy。
- 2026-07-14：统一项目全链路米制单位契约：Cube/Sphere/Plane 使用集中米制基准；普通模型、模型生成器与环境模型在独立内容根节点应用源单位缩放；环境单位随场景保存并兼容旧场景；CAD 补齐 `$INSUNITS` 0–24、`$MEASUREMENT` 推断和明确毫米 fallback，普通/大文件解析、Inspector 与导入日志保持一致。
- 2026-07-14：模型库内置 Box 明确采用米制基准，资源卡片显示 `1 m × 1 m × 1 m`；拖入 Scene View 时中心自动抬高 `0.5 m` 使底面落地，选中后 Inspector 将 X/Y/Z 显示为 `size (m)`，底层 `Transform.scale` 与场景格式保持不变。
- 2026-07-14：修复模型阵列间距仅按实体根节点位移、对大型模型看起来无效，以及净间距 `0` 被错误回退为 `1m`、阵列后选中态切换到副本导致误以为原模型移动的问题；阵列步长统一为“选区世界包围盒轴向尺寸 + 用户输入净间距”，`0` 表示边缘贴合，原始选区的 Transform 与选中状态保持不变，模型几何未加载完成时会明确阻止错误阵列。
- 2026-07-13：修复 Stacker 默认原位与下轨左端缓冲头之间约 `0.562846 m` 的空隙；参数脚本在全部静态参数应用后，将 `dataDriven.motion.travel.nodes` 整组沿模型局部 Z 轴回贴，固定上下轨不移动，旋转、单位缩放与 MQTT 零位基线保持一致。
- 2026-07-13：修复环境 GLB 真实鼠标拖放：接收范围从环境预览按钮扩大到“环境模型”整条属性行，拖到文字、预览框或其子元素都会保持高亮并应用环境；仍严格校验环境专用 MIME 与 `libraryKind: environment`。同时明确导入模型的场景单位统一为米，普通模型保留源单位换算，直接环境 GLB 固定按 `meter / 1` 登记。
- 2026-07-13：环境库改为直接导入单个 GLB：文件选择器只接受 `.glb`，项目内保存为 `Assets/Environments/<安全化文件 stem>/<原 GLB 文件名>.glb` 独立包并保持 `libraryKind: environment`；导入前校验 GLB 结构，同名覆盖通过暂存、旧包备份和索引失败回滚保证一致性。拖入环境属性或点击应用后，运行时根据真实包围盒把模型右边界放到 `X=-2m`、底部落到 `Y=0`、Z 方向居中，使整个环境模型稳定显示在世界原点左侧；同包重导会使用新 `assetRevision` 自动刷新当前环境。普通模型库继续使用文件夹导入，旧环境包索引仍兼容。
- 2026-07-13：普通模型文件夹扫描器支持“所选目录本身就是模型包”的结构，根目录没有可判定主模型时仍继续扫描原有一级模型包子目录。
- 2026-07-12：修复 `F:\3d-models\test.dxf`（约 309 MB）导入卡死：大文件改由 Web Worker 轻量扫描并施加 `200000` 条折线 / `800000` 个点预览预算，过滤 `±1e20` 等异常哨兵坐标；Babylon LineSystem 按批次创建并在批次间让出事件循环，场景重新加载高复杂度 CAD 时依据持久化 `importMode` 继续走可取消的后台路径，删除实体或切换场景会终止未完成 Worker。目标文件 smoke 验证可在预算内完成并生成有限包围盒。
- 2026-07-12：完成 YZJ 一体式顶升移载方向箭头全链路：图片库内置透明发光箭头、Inspector texture 拖放、逻辑引用到开发/生产 URL 解析、`Ban.4` 顶面呼吸显示，以及 MQTT `movement_x` 正向/反向/停止/故障/无数据/恢复编辑态联动；开发与生产视觉页均通过，详见 `docs/yzj-parameter-visual-validation.md`。

- 2026-07-10：新增编辑器 MQTT 运行预览文档语义；保存/启用 MQTT 配置不再表示自动连接，只有点击 Toolbar “运行”并通过预检后才连接 broker 或启动本地模拟。运行态保持相机、选择、Hierarchy 搜索/展开、网格、诊断和 Console 可用，同时冻结 Gizmo、Inspector 修改、Hierarchy 变更、资源导入、保存加载、undo/redo 与 MQTT 配置；停止会断开 transport、清理运行时快照/货物/诊断和本次遥测触发动画，恢复运行前姿态且不回写 SceneDocument/history。
- 2026-07-10：模型库与环境库改为严格分库：普通模型导入复制到 `Assets/Models`，环境模型导入复制到 `Assets/Environments`，`.babylon-editor/asset-index.json` 升级为 v2；v1 旧条目默认归模型库且不移动旧文件，同名包重导只覆盖当前入口对应的目标库。模型库卡片只能拖入 Scene，环境库卡片只能点击应用或拖入环境属性区；`sceneSettings.environment` 与模型包 `meta.json` 格式保持不变。
- 2026-07-09：修复 Stacker 参数化后货叉悬浮问题；货叉长度缩放和间距调整前记录原始 GLB 底面锚点，`forkGap` 调距会剔除模型竖直轴分量，完成后再把两根货叉贴回原支撑平面。
- 2026-07-09：Stacker 货叉伸缩改为两段式行程；新增 `forkStageOneReach/forkStageTwoReach` 参数，近位只伸第一段，远位在第一段到位后继续伸第二段，并在本地模拟中覆盖近/远目标位。
- 2026-07-09：Scene View 地面网格改为固定大范围过程式网格线，取消按相机视野重定位造成的局部显示效果，远景查看时不再因局部网格范围不足而消失。
- 2026-07-09：重新导入项目模型包后，当前场景中引用同一模型包的导入模型实例会自动刷新模型、参数 schema 和外置脚本元数据；兼容的手动参数值与实例资产编号保持不变。
- 2026-07-09：修复 Inspector 中 rotation 直接暴露 Babylon 弧度导致的角度不匹配问题；属性面板现在按度显示和输入，store、Gizmo、场景文件与运行时仍保持内部弧度契约。
- 2026-07-09：优化底部 Project 模型库布局，图库区域加高后资源卡片按可用宽度自动换行，取消全屏下不必要的横向滚动条。
- 2026-07-09：新增环境库作为场景环境入口，支持点击应用环境模型，也支持把环境库模型卡片拖入 Inspector 的环境属性区。
- 2026-07-08：选中基础 Mesh/默认模型或导入模型实例时，右侧 Inspector 启用紧凑属性布局，压缩 Transform、材质、Model Asset 与模型参数区域的表单密度，同时保留灯光、CAD、虚拟定位线框等非模型对象的原属性面板布局。
- 2026-07-08：Console 从 Scene 下方常驻面板改为底部 Project 区域的最小化入口，点击后以弹窗显示日志，默认释放 Scene 视口高度。
- 2026-07-08：优化 Scene View 默认相机构图，`标准` 视野采用更远的观察距离和更低俯仰角，让地面网格不再铺满首屏，保留更多黑色背景可见范围。
- 2026-07-03：模型阵列方向扩展为 +X/-X/+Y/-Y/+Z/-Z 六向选择，阵列间距继续按米配置，负向阵列会按同一间距反向生成副本。
- 2026-07-03：补充通用 PLC/MQTT 遥测层文档；默认 topic 扩展为 `dt/factory/logistics/+/+/twindatadriven/joint`，说明 `data[].e/p/v`、`modelAsset.assetCode` 资产匹配、DDJ2 堆垛机字段、1001 输送线第一版语义和现场排查步骤。
- 2026-07-03：补齐 Stacker 前叉/后叉货物运行时语义；`front_containerCode/back_containerCode` 会创建内存货物并随对应货叉运动，`front_command/back_command=3/4/5` 且目标位有效时货物进入 locator 虚拟定位框，放货完成后条码清空也会保留在目标框内。
- 2026-07-02：修正 Stacker 遥测水平行走语义；`movement_x`/目标位只驱动模型脚本 `dataDriven.motion.travel.nodes` 声明的行走机构，`fixedNodes` 上下轨道保持固定，并将行走、升降、货叉伸缩合成为节点级世界偏移后再写回本地坐标。
- 2026-07-02：补强 Stacker 轨道约束；水平行走会按固定轨道包围范围夹紧，超出轨道长度的 `distance_x`、movement 积分或轨道外目标位不会把机体推出轨道端点。
- 2026-07-02：修复 Stacker demo 普通浏览器可视验证链路；旧版本曾按真实 GLB bounds 推断毫米单位，当前已改为仅读取 `meta.json.lengthUnit`，缺失按 `meter / 1`、显式非法值拒绝。Vite 开发期通过只读 `/__editor_asset__/` 加载本地模型包，运行时在归一化和外置脚本初始化完成后再启动 Stacker 遥测动画，避免加载即变形。
- 2026-07-02：新增无 broker 的 Stacker 本地模拟模式；MQ 配置可保存模拟资产、场景和间隔，浏览器运行时直接生成同协议数据写入内存遥测，演示场景默认启用 `DDJ2/cycle/500ms`。
- 2026-07-02：Stacker MQTT demo 场景改为直接引用 `F:\3d-models\models\Stacker` 真实模型包，保留 `DDJ2` 资产编号、`1-1-1/2-1-1/3-2-1` 目标位和本地模拟配置。
- 2026-07-02：新增 Stacker MQTT 演示场景和模拟发布脚本；场景内置 `DDJ2` 模型、`1-1-1/2-1-1/3-2-1` 目标位与默认 WebSocket MQTT 配置，模拟器支持目标位、全 0 movement 和急停场景。
- 2026-07-02：补充 Stacker MQTT 动作解析与目标位规则文档；说明 WebSocket 连接订阅、topic 资产编号匹配、payload 字段映射、目标位 locator 查找、编码器校准、故障暂停和实时数据不落盘边界。
- 2026-07-02：首页启动台调整为只展示项目与场景相关内容，保留最近项目、最近场景、新建场景、打开项目目录和打开场景文件入口；Project 面板继续独立承载模型库与内置资源创建。
- 2026-07-02：Toolbar 新增 MQTT 配置弹窗，支持保存 MQTT IP/域名、MQTT over WebSocket 地址和 topic；只填 IP 时自动补齐 `ws://<IP>:8083/mqtt`。连接 broker 与订阅 Stacker 动作数据现在由 Toolbar “运行”预检通过后触发。
- 2026-07-02：导入模型实例新增 `modelAsset.assetCode` 资产编号；模型包可用 `dataDriven.device.defaultAssetCode` 提供默认前缀，导入、旧场景加载、复制粘贴、模型阵列、Inspector 编辑、保存加载与运行时 metadata/外置脚本注入已接入同一字段。
- 2026-07-01：修复 YZJ“一体式顶升移载”模型参数化脚本；链条机主体、顶升平台和辊筒按 `ZT.2` / `Ban.4` / `GT.3` 分组处理，长宽高沿模型局部轴变化，辊筒密度沿设备宽度方向复制，并修正 `rollerWidth` 元数据最小值避免默认加载即变形。
- 2026-07-01：继续修复 YZJ 移载机 `chainLength` 变长后的主体变形；长度参数改为端部保护的顶点分段拉伸，两端支腿/端头只平移，中间侧梁和链条区域承担伸缩。
- 2026-07-01：修复 YZJ 移载机长度变化的视觉锚点；按“左侧固定、右侧延长”处理 `chainLength`，并补充 Playwright 左端基准线截图验证。
- 2026-07-01：新增 YZJ `platformLength` 参数，红框内 `Ban.4` 顶升移载模块长度可单独设置；整机 `chainLength` 加长时该模块保持默认长度，不再随整机一起拉伸。
- 2026-07-01：修复 Stacker 模型旋转后参数化变形方向错误的问题；脚本改为读取模型内容根节点的当前局部参数轴，并用任意世界方向投影处理主体长度、高度、载货台高度和货叉间距，避免旋转后仍按全局 X/Y/Z 变形。
- 2026-07-01：Console 面板右上角新增局部最小化/恢复按钮，最小化时隐藏日志列表并压缩 Console 行高，让 Scene 视口获得更多垂直空间；该状态仅保留在当前编辑会话中。
- 2026-07-01：新增 CAD/DXF 网格参考层导入，支持从 Toolbar 选择 `.dxf` 文件，将常见二维 CAD 线稿按米制换算后贴近地面网格显示；导入时显示读取、解析和创建进度，默认锁定且不可拾取，并支持保存/加载、Inspector 线色与透明度调整。
- 2026-07-01：修复复杂 CAD 图纸导入时 `Maximum call stack size exceeded` 的问题；DXF `INSERT` 块引用改为迭代式展开并跳过循环块引用，导入阶段解析结果会临时复用到 Babylon runtime，避免大图纸新导入后立即重复解析。
- 2026-07-01：Hierarchy 新增右键上下文菜单与批量操作，支持场景聚焦、库聚焦、批量隐藏/锁定/删除、内部复制粘贴、线性模型阵列、行内重命名、群组和解组，并接入 F/H/Ctrl+C/Ctrl+V/Ctrl+K/Ctrl+G/Shift+G/Delete 快捷键与单条撤销历史。
- 2026-07-01：左侧 Hierarchy 前置显示/锁定状态图标调整为蓝底白色线框按钮样式，并固定为紧凑双列，和模型树行高对齐。
- 2026-07-01：修复 `npm run dev:electron` 在 Windows 端口排除段覆盖 `5173-5222` 时无法启动的问题，开发脚本会继续向后扫描并输出端口失败原因摘要。
- 2026-07-01：模型库卡片改为参考图风格的深色缩略图卡片，并支持从模型包 `meta.json.thumbnail` 或 `meta.json.cover` 读取同包封面图。
- 2026-07-01：选中左侧 Hierarchy 文件夹时，Scene View 会同步高亮该文件夹下所有可显示模型，方便按分组检查场景对象。
- 2026-06-30：左侧 Hierarchy 新增搜索、新建分组文件夹、多选拖拽归组、拖回根层级，以及实体/文件夹显示隐藏、锁定解锁控制；文件夹状态会影响组内对象，并随场景保存/加载、撤销/重做与 Scene View 拾取/Gizmo 保护同步生效。
- 2026-06-30：模型库新增 `虚拟定位线框` 内置资产，支持点击或拖拽创建可拾取长方体线框，并在 Inspector 参数化编辑资产编号、长宽高，随场景保存/加载且支持撤销/重做。
- 2026-06-30：新增仓库内参数化示例资产，包含带 `meta.json.modelParameters` 的 `ParameterChainDemo` 模型包、包内 PNG 贴图、演示 `.scene.json` 场景和 README 最短验收流程。
- 2026-06-30：修复 `npm run dev:electron` 预热阶段递归扫描 Vite optimizer 产物导致启动过慢或失败的问题；预热器现在只递归应用源码静态依赖，外置模型脚本的 TypeScript 编译器改为运行脚本时延迟加载。
- 2026-06-30：导入模型包支持同目录外置 `.model.ts` 参数化脚本，脚本随模型包复制、登记、保存、授权并在 Babylon 模型加载后执行；新增 `scripts/sync-model-parameters-from-scripts.mjs` 用于从旧 `parameterScripts` 批量补齐 `modelParameters`。
- 2026-06-30：修复 `npm run dev:electron` 启动后可能只显示窗口壳、不显示编辑器内容的问题；开发脚本新增 `wait:renderer` 预热首屏 renderer 模块后再启动 Electron，主进程新增 renderer 加载诊断，React 入口新增错误边界，Scene View 对 WebGL/Babylon 初始化失败显示可读错误面板。
- 2026-06-30：导入模型新增参数化配置链路，支持读取 `meta.json.modelParameters`，在 Inspector 展示 number、color、boolean、enum、vector3、texture 参数，并通过安全 JSON DSL 实时驱动模型节点、网格、材质和贴图外观变化。
- 2026-06-30：修复 Scene View 鼠标滚轮靠近模型时可能变黑的问题，为编辑器相机增加近裁剪距离和最小观察半径保护，近距离查看模型细节时不再轻易裁空画面。
- 2026-06-29：Scene View 可视范围新增 Toolbar `视野` 下拉配置，支持 `近景`、`标准`、`远景`、`全景` 四档相机观察距离，便于按编辑场景大小快速切换取景范围。
- 2026-06-29：Scene View 地面辅助网格新增 Toolbar 显示/隐藏开关与 `1 m`、`2 m`、`5 m`、`10 m` 四档格子大小选择，默认格子大小调整为 `5 m`。
- 2026-06-29：下调 Scene View 地面网格与网格线 GlowLayer 的呼吸光晕透明度和强度，使网格只保留微弱呼吸效果，避免画面过亮。
- 2026-06-29：模型库新增半球光内置资源卡片，Toolbar 移除最后一个创建类按钮，基础对象与常用灯光统一从模型库创建。
- 2026-06-29：移除 Toolbar 中已迁移到模型库的立方体、球体、地面、方向光、点光源创建按钮，完成第一阶段 Toolbar 创建入口收缩。
- 2026-06-29：模型库新增立方体、球体、地面、方向光、点光源五个内置资源卡片，支持点击创建和拖拽到 Scene View 按落点创建。
- 2026-06-29：修复导入模型通过 Gizmo 移动后消失的问题，将源单位换算缩放隔离到模型内容节点，避免移动提交时把单位缩放误写回用户 Transform。
- 2026-06-29：编辑器主布局支持根据窗口尺寸自动自适应，在约 `1024×640` 及以上窗口中保持五面板可见，并通过 Toolbar、Project 页签和资源卡片内部横向滚动承接溢出。
- 2026-06-29：模型库真实模型卡片支持拖拽到 Scene View，并按鼠标释放位置投射到地面平面创建模型实体。
- 2026-06-29：修复 Scene View 地面网格呼吸光晕表现，将原先独立圆盘光斑改为网格线自身的呼吸光晕效果。
- 2026-06-29：导入模型支持读取 `meta.json.lengthUnit`，将 meter/cm/mm 源模型自动换算到米制场景，保持 `scale = 1` 表示不额外缩放。
- 2026-06-29：将场景长度单位明确为米，新增场景文件单位元数据，并在 Inspector、位置吸附与地面网格文档中统一米制语义。
- 2026-06-28：模型库导入改为复制到项目目录 `Assets/Models`，并通过 `.babylon-editor/asset-index.json` 在下次打开项目时自动恢复模型卡片。
- 2026-06-28：为模型库新增导入模型文件夹设计与实现入口，支持扫描一级模型包、读取 `meta.json` 展示名，并通过 `editor-asset://` 引用原目录模型。
- 2026-06-28：将底部 Project 图库区域固定加高到约 `260px`，让资源卡片、资源名称和底部空间完整可见。
- 2026-06-28：将底部 Project 面板切换为资源库浏览器外观，补齐七类资源库页签、筛选占位行和横向资源卡片占位。
- 2026-06-28：将 Scene View 地面网格升级为大范围视觉辅助网格，并保留世界原点呼吸光晕。
- 2026-06-28：补齐 Scene View 科技蓝地面网格与呼吸光晕辅助视觉，并保持其独立于场景保存/加载数据。

- 2026-06-27：补齐实体重命名、删除、材质颜色编辑与灯光创建/编辑，并接入撤销/重做。
- 2026-06-27：补齐 Project 面板 `.scene.json` 资产加载与 `.gltf/.glb` 模型导入能力。
- 2026-06-27：补齐 Scene View 单击选中与空白清选能力；补齐 W/E/R 工具快捷键，并避免在 Inspector 输入框内误触快捷键。
- 2026-06-27：补齐 Gizmo 局部/全局坐标空间切换与基础吸附配置，位置、旋转、缩放吸附均通过 Toolbar 控制。

## 后续路线

以下能力尚未作为当前 MVP 可用功能交付，属于后续迭代方向：

- Gizmo 高级能力：补充 Frame Selected、多选变换、吸附快捷键与更完整的编辑器命令面板。
- glTF/GLB 高级导入：补充嵌套资源拷贝、材质映射、动画预览、骨骼/蒙皮支持与资源缺失提示。
- Prefab/GUID：建立资源唯一标识、Prefab 实例化与引用关系。
- 材质与灯光高级编辑：支持贴图、PBR 参数、灯光颜色、阴影与范围等属性。
- Play Mode 后续增强：已具备 MQTT 运行预览的编辑/运行隔离入口；后续补充通用脚本 Play Mode、暂停/单步、运行态调试和更多运行时能力。
- 脚本组件：为实体挂载脚本逻辑与自定义组件。
- 动画、物理、粒子、Terrain：补充完整 3D 编辑器常见运行时与内容创作能力。
- 插件系统：后续提供可扩展的编辑器插件机制。
## Shelf 多穿货架参数化修复记录
- 2026-07-17：Shelf `layerCount` 与 `columnCount` 均支持 `1..100`。当层/列/双深组合会超过逐节点生成阈值时，参数脚本自动切换为高密度 `dense batch + thin instance` 渲染：每个可渲染源叶 Mesh 只创建一个批次 Mesh，重复货格通过一次性矩阵缓冲提交，场景节点保持批次级；低密度路径继续保留原 `cloneSingleNode` 行为。100 层 × 100 列 × 双深 smoke 统计为 `denseBatch=18`、`thinInstances=121608`、`mesh=36`，低密度 88/128 回归保持不变。视觉页 `output/playwright/shelf-visual-check.html?dense=1` 会自动取景并显示 effective layers/columns、mesh/node、thin instance 与 FPS 采样。
- 2026-07-17：Shelf 普通场景实体与模型生成器输出改为共享源 `AssetContainer` + `InstancedMesh`：同一资源签名只加载一次 GLB，实体继续保留独立根节点、参数值、外置脚本、拾取 metadata、显隐/锁定和 Gizmo。参数脚本无需修改，其层/列/双深生成节点的子 Mesh 会继续保持实例化；实例选择改用单个共享 `SelectionOutlineLayer`，普通模型仍保留 `HighlightLayer`。动态修改 `layerCount`/`columnCount` 后，运行时会在 `clearSelection()` 与 `addSelection()` 之间按 source mesh 补齐公开 `instancedBuffers` 容器，避免 Babylon 重新注册 `instanceSelectionId` 时写入空实例缓冲。新增引用计数回收与 `npm run smoke:shelf-instancing` 定向验证，详细边界见 `docs/shelf-shared-instancing.md`。
- 2026-07-10：精简 Shelf 参数元数据，移除 `aisleWidth`、`aisleHeight`、`shelfStyle` 这 3 个无模型语义参数；剩余 9 个参数均会产生可见模型效果。`postWidth` 继续按 0.08 兼容基准，仅调整立柱横截面；立柱底端保持锚定，列布局统一支撑容差，旧场景刷新时按新参数集兼容。GLB 未修改，Sandbox 仅用于结构校验。

- 2026-07-01：补齐 Shelf 高度变化时侧面三角支架的数量联动。`cellHeight` 按 `ceil(目标层高 / 原始层高)` 计算每层三角支架模块数，保证单个支架模块高度不超过原始层高；默认高度保持 4 个侧撑节点，5.5m/6.8m/9.05m 会自动变为 8 个，13.575m 会变为 12 个。多层、多列、双深和旋转组合都会在各自货格内按模块高度重复生成支架，而不是只把单个支架拉长。
- 2026-07-01：修复 Shelf 多穿货架参数化脚本的层/列/双深组合变形。`layerCount`、`columnCount`、`doubleDeepEnabled` 现在以原始单格部件为唯一语义源，按层、列、深位一次性组合克隆，避免把运行态克隆再次作为克隆源导致穿插或漏复制。
- 列复制语义：`cellWidth` 仍作为货格宽度输入，实际列阵优先使用左右支撑中心距，以保持多穿货架 0 间距共享立柱的业务语义；深位复制使用 `cellDepth + deepSlotGap`，`deepSlotLift` 只作用于第二深位的 Y 向偏移。
- 旋转语义：宽、高、深的包围盒读取和克隆偏移改为模型局部 X/Y/Z 在世界空间中的投影方向，模型整体旋转后仍沿货架自身方向参数化。
- 验证组合：默认 1 层 1 列、3 层 4 列、2 层 3 列双深、旋转后的多层多列双深组合。源包 `F:\3d-models\models\Shelf\shelf.model.ts` 与资产副本 `F:\3d-models\models\Assets\Models\Shelf\shelf.model.ts` 必须保持同步。

## 场景 Web 部署导出

Toolbar 的 `📦 导出部署工程` 会捕获当前内存场景，自动收集普通模型、模型生成器目标、环境、DXF、模型脚本与贴图，输出可部署目录或 ZIP。导出结果使用独立只读 Web Viewer，不包含编辑器界面和 Electron 运行环境。

部署包通过根目录 `runtime-config.json` 外置页面、资源和 MQTT 配置；修改 JSON 后刷新页面即可生效。真实 MQTT 仅支持 `ws://` / `wss://`，静态 JSON 不应保存用户名、密码或长期 Token。部署包必须通过 HTTP/HTTPS 静态服务器访问，不支持直接双击 `index.html`。

完整目录结构、配置字段、CSP、外部资源、安全边界和部署说明见 [场景 Web 部署导出](docs/scene-web-export.md)。
## Windows 安装包构建与安装

项目使用 Electron + electron-builder 生成 Windows x64 NSIS 安装包。生产构建使用相对资源路径，因此安装后由 `file://` 加载 renderer 时，React 页面、Babylon.js 分块、CAD Worker、样式和图片仍可正常读取。GPU 启动开关、软件 3D rasterizer 禁用和 Scene View 硬件 WebGL 校验位于打入 `app.asar` 的生产代码中；Windows 免安装目录和 NSIS 安装后的程序还会按企业部署策略关闭 GPU sandbox，开发态继续保留该 sandbox。正式包不绕过 Chromium GPU blocklist，也不固定 `use-angle` 后端。

### 构建环境

- Windows 10/11 x64
- Node.js `>= 22.12.0`
- npm 10+
- 首次构建执行 `npm install`
- Windows 打包通过 electron-builder `electronDist` 复用 `node_modules/electron/dist`，避免端点安全软件锁住临时解压目录；`afterPack` 会移除运行时不需要的 Electron 默认入口文件。

### 构建命令

```bash
# 仅生成免安装目录，用于快速验证
npm run pack:win

# 生成 Windows NSIS 安装程序
npm run dist:win

# 验证免安装目录中的生产程序、React 根节点、Electron preload API 和硬件 WebGL
npm run smoke:packaged:win

# 专门验证生产 EXE 的主进程 GPU feature、活动显卡和 Scene View renderer
npm run smoke:packaged:gpu

# 重新生成 NSIS 安装程序，并验证安装包同源生产 EXE 的 GPU/WebGL
npm run smoke:installer:gpu
```

安装包默认输出到：

```text
release/ZENDING-3D-EDITOR-Setup-0.1.2-x64.exe
```

免安装验证程序默认输出到：

```text
release/win-unpacked/ZENDING 3D EDITOR.exe
```

### 安装与数据目录

- 安装器允许用户选择安装目录，并创建桌面快捷方式和开始菜单快捷方式。若旧版使用“为所有用户安装”并位于 `C:\Program Files\ZENDING 3D EDITOR`，升级时应选择相同安装模式和目录，或先卸载旧版，避免保留两个同名快捷方式继续启动旧 EXE。
- 最近项目与最近场景记录写入 Electron 的 `userData` 目录，不写入只读安装目录；数据中台服务地址单独保存在同目录的 `data-platform-config.json`。
- 数据中台下载的工程场景与共享模型库：开发态写入应用根目录，安装态统一写入 `userData/data-platform-workspace`；安装、升级程序不会覆盖该工作区，也不会放宽安装目录 ACL。
- 模型库、环境模型库、场景 JSON、CAD 文件和模型脚本仍保存在用户选择的项目目录中；安装或升级程序不会删除项目数据。
- 卸载默认保留 `userData`，包括最近项目记录、数据中台配置以及 `data-platform-workspace` 中的场景和共享模型，便于重新安装后继续使用。

### 安装态功能验证范围

`scripts/smoke-packaged-windows.mjs` 会启动生产 EXE，并通过 Chromium DevTools 协议确认：

- renderer 页面完成加载且 React 根节点已渲染；
- `window.editorApi` preload 桥接存在；
- 场景保存、模型文件夹导入和 MQTT 配置等关键 IPC 方法可调用；
- 通过本地模拟数据中台打开项目并等待模型同步完成，确认安装态工作区位于本次临时 `userData/data-platform-workspace`，不会写入程序目录；
- 进入 Scene View，确认生产 EXE 创建 WebGL 上下文、请求 `high-performance` GPU、设置 `failIfMajorPerformanceCaveat=true`，并拒绝 SwiftShader/WARP/llvmpipe 等软件 renderer；
- 验证结束后只关闭本次启动的进程树，并清理临时用户数据目录。

当前安装包未配置商业代码签名证书。首次运行时 Windows SmartScreen 可能显示“未知发布者”，这不影响本地功能；正式对外分发时应使用受信任的 Windows 代码签名证书签署安装程序和主程序。
