# Babylon Electron Unity-like Editor

Babylon Electron Unity-like Editor 是一个基于 Electron、Vite、React、TypeScript 与 Babylon.js 的桌面 3D 编辑器原型项目。

## 当前目标

第一阶段 MVP 的目标是构建一个可启动、可编辑、可保存/加载的桌面 3D 编辑器内核。当前阶段重点验证编辑器基础架构、场景数据模型、基础对象编辑流程、基础资源导入与本地文件交互能力，不是一次性复刻完整 Unity3D。

## 当前功能

- Electron 桌面窗口：通过 Electron 主进程启动独立桌面应用窗口。
- 首页启动台：进入五面板编辑器前会先显示首页，聚焦最近项目、最近场景、新建场景、打开项目目录和打开场景文件等项目相关入口；最近记录由主进程保存到 `recent-workspaces.json`，并兼容旧版单项目 `recent-project.json`。
- Electron 启动诊断：开发启动时会输出 renderer 加载、preload 与渲染进程退出日志；React 与 Scene View 初始化异常会显示可读错误页或错误面板，避免窗口内容区静默空白。
- Unity-like 五面板布局：包含 Hierarchy、Scene、Inspector、Project、Console 五个核心编辑器区域，并支持根据窗口尺寸自动自适应；在约 `1024×640` 及以上窗口中保持五面板可见，Console 可通过右上角按钮局部最小化以释放 Scene 视口高度，Toolbar、Project 页签与资源卡片通过内部横向滚动承接溢出。
- Babylon Scene View：在 Scene 面板中渲染 Babylon.js 3D 场景，并同步当前场景文档中的基础 Mesh、导入模型与灯光；默认编辑器相机使用更开阔的 `标准` 视野，让地面网格上方和周围保留更大的黑色背景可见范围，并可在 Toolbar 中切换 `近景`、`标准`、`远景`、`全景` 四档可视范围；鼠标滚轮近距离缩放带有最小观察距离与近裁剪保护，避免靠近模型时画面被裁成全黑。
- 米制场景单位：编辑器约定 `1 scene unit = 1 m`，Inspector 中 position、位置吸附步长与地面网格均按米解释。
- 编辑器地面辅助层：Scene View 显示视觉无限的科技蓝地面网格，默认每小格表示 `5 m`，可在 Toolbar 中切换显示/隐藏并选择 `1 m`、`2 m`、`5 m`、`10 m` 四档格子大小；网格线自身带有微弱低强度呼吸光晕效果，辅助层不参与选中、保存、加载或撤销/重做。
- CAD/DXF 网格参考层：Toolbar 支持导入 `.dxf` CAD 图纸，导入过程中会显示读取、解析和创建参考层进度；首版会把 `LINE`、`ARC`、`CIRCLE`、`LWPOLYLINE`、`POLYLINE` 转为贴近 `y = 0` 网格层的半透明线稿；参考图默认锁定、不可被 Scene View 鼠标拾取，不干扰模型选择和 Gizmo，并会随场景保存/加载恢复。
- 创建基础对象：支持创建 Cube、Sphere、Plane。
- 创建基础灯光：支持创建 Hemispheric、Directional、Point 三类灯光实体。
- Hierarchy 选择与分组：支持在层级面板中选择场景对象，并与 Scene View 高亮状态同步；选中文件夹时会在 Scene View 高亮该文件夹下的所有可显示模型；左侧 Hierarchy 提供搜索、新建文件夹、单选/多选拖入文件夹分组、拖回根层级，以及实体/文件夹级显示隐藏、锁定解锁控制。
- Hierarchy 右键菜单：左侧模型树单选或多选后可打开深色上下文菜单，支持场景聚焦、库聚焦、隐藏、复制、粘贴、模型阵列、锁定、重命名、删除、群组和解组；右键未选中对象会切换为单选，右键当前多选对象会保留多选集合。
- Scene View 点击选中：支持在 Scene 画布单击对象完成选中，单击空白区域会清空当前选择。
- Inspector 实体编辑：支持编辑选中实体名称、position、rotation、scale 等 Transform 数据。
- Inspector 材质编辑：支持编辑基础 Mesh 的材质颜色。
- Inspector 灯光编辑：支持编辑灯光类型与强度。
- Transform Gizmo：Scene View 中支持移动、旋转、缩放三种可视化操控模式，拖拽结束后写入撤销/重做历史。
- Gizmo 坐标与吸附：支持局部/全局坐标空间切换，并可配置位置、旋转角度、缩放三类基础吸附步长。
- W/E/R 与批量操作快捷键：在非输入控件聚焦时，可用 W/E/R 快速切换移动、旋转、缩放工具；F 场景聚焦、H 隐藏对象、Ctrl+C 复制、Ctrl+V 粘贴、Ctrl+K 锁定、Ctrl+G 群组、Shift+G 解组、Delete/Backspace 删除当前 Hierarchy 选区。
- 撤销/重做：通过命令历史支持基础编辑操作、实体创建、实体删除、实体重命名、材质编辑、灯光编辑与 Gizmo 拖拽的撤销与重做；Hierarchy 批量隐藏、锁定、删除、粘贴、模型阵列、群组和解组均作为单条命令进入历史。
- JSON 场景保存/加载：支持将当前场景保存为 JSON 文件，并从 JSON 场景文件加载；保存、文件选择加载和首页最近场景加载成功后都会更新最近场景列表。
- Project 资源库外观：底部 Project 面板已切换为资源库浏览器样式，并将图库区域固定加高到约 `260px`，包含模型库、POI库、主题库、组合库、环境库、图表库、图片库七个页签，以及筛选占位行和横向资源卡片；模型库卡片使用深色直角卡、上方缩略图、下方两行居中文字和单行省略标题，模型库内置立方体、球体、地面、虚拟定位线框、半球光、方向光、点光源七类基础资源，并支持导入模型文件夹展示项目内模型卡片。
- 模型文件夹导入：模型库可选择类似 `F:\3d-models\models` 的模型根目录，扫描一级模型包中的 `.glb/.gltf`、读取 `meta.json` 展示名称、`lengthUnit` 源单位与可选封面图，并将有效模型包复制到当前项目目录的 `Assets/Models` 下，通过 `.babylon-editor/asset-index.json` 在下次打开项目时自动恢复模型库。导入模型最终按米进入场景；`meta.json.lengthUnit` 支持 `meter`/`m`、`centimeter`/`cm`、`millimeter`/`mm`，`meta.json.thumbnail` 或 `meta.json.cover` 可指向模型包内 `.png/.jpg/.jpeg/.webp` 相对路径作为卡片缩略图；缺失 `lengthUnit` 时会优先根据 GLB 包围盒与 `meta.json` 中的长宽高等尺寸参数推断米/毫米/厘米，无法推断时默认按 `meter` 处理，不支持的显式单位会跳过该模型包。
- 导入模型资产编号：每个导入模型实例都会生成并保存 `modelAsset.assetCode`，Inspector 的 `Model Asset` 区域可编辑该编号；复制、粘贴和模型阵列会按新实体 ID 重新生成编号，避免多个实例共享后续动画数据识别键。
- MQTT 配置入口：Toolbar 提供 MQTT 配置按钮，可在弹窗中填写 MQTT IP/域名和 MQTT over WebSocket 地址；只填写 IP 时会自动生成 `ws://<IP>:8083/mqtt`，运行时支持通过 WebSocket 连接 broker 并订阅 PLC/MQTT 遥测 topic，通用默认 topic 为 `dt/factory/logistics/+/+/twindatadriven/joint`。现场尚未部署 MQTT 时，可勾选本地模拟，运行时会直接生成 Stacker 协议数据驱动场景。
- 外置参数化脚本：模型包内的 `*.model.ts` 会随模型包复制到项目目录并作为受控 `editor-asset://` 资产授权；导入模型加载完成后，renderer 会以本地可信脚本方式转译并运行同包脚本，兼容 `ParametricModelRuntimeComponent`、`export default class`、`onStart/onUpdate/onStop` 生命周期以及 `babylonjs-editor-tools` 的 `visibleAs*` 装饰器写法。
- 参数化模型：模型包 `meta.json.modelParameters` 可声明 number、color、boolean、enum、vector3、texture 参数，以及绑定到模型节点、网格或材质的安全 JSON DSL；选中带参数配置的导入模型后，Inspector 会显示“模型参数”区域，修改参数会通过场景文档实时驱动 Babylon 模型外观变化，并支持随场景保存/加载与撤销/重做。
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

若 Electron 窗口只显示标题栏或菜单栏，优先查看启动终端中的 `[electron]` 日志；渲染入口异常会显示“编辑器启动失败”，WebGL/Babylon 初始化异常会显示在 Scene 面板内，不再静默白屏。

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

## Stacker 堆垛机参数化说明

`F:\3d-models\models\Stacker` 模型包中的 `forkGap` 表示两根货叉中心线之间的目标间距，不是基于原始位置的额外偏移量；脚本会读取两根货叉的基线世界中心，围绕中心对称设置目标间距，并把世界位移转换回父级本地坐标，避免 GLB 源单位、父节点缩放或局部轴向导致二次外扩。

模型实体被旋转后，Stacker 脚本会从模型内容根节点的当前世界矩阵读取局部 X/Y/Z 参数轴：主体长度沿模型局部 Z 轴、主体和载货台高度沿模型局部 Y 轴、宽度和货叉长度沿模型局部 X 轴生效；货叉间距沿两根货叉基线中心连线投影计算，避免旋转 45° 或 90° 后仍按全局坐标轴变形。

当前项目已经导入的模型副本位于 `F:\3d-models\models\Assets\Models\Stacker`。调试或发布 Stacker 脚本时需要同步源模型包与该副本；视觉验证建议覆盖默认值、`forkGap = 0 / 0.6 / 1.2`、`forkLength = 0.5 / 0.941 / 2.0`，以及 `bodyHeight = 12 + platformHeight = 3 + forkGap = 1.2 + forkLength = 2` 的组合场景，确认两叉中心不漂移、货叉长度不污染间距、立柱和载货台参数互不牵连。

## 一体式顶升移载 YZJ 参数化说明

`F:\3d-models\models\YZJ` 模型包对应设备名称“一体式顶升移载”。参数化脚本按 GLB 的真实子结构处理：`ZT.2` 是链条机主体和支腿基准，`Ban.4` 是随顶升高度上移的上部平台，`GT.3` 是可按密度复制的辊筒模板；脚本不再对模型根节点整体缩放，避免默认值二次变形和旋转后沿世界轴变形。

参数单位按米解释：`chainLength` 沿设备局部 X 轴伸缩整条链条机主体，`platformLength` 单独控制红框内 `Ban.4` 顶升移载模块长度，`chainWidth` 沿设备局部 Z 轴伸缩，`chainHeight` 沿设备局部 Y 轴抬升主体并同步上移平台/辊筒；`rollerDensity` 会沿设备局部宽度方向铺开辊筒，`rollerPosition` 只沿设备局部长度方向偏移辊筒。`rollerWidth` 的元数据最小值保持小于默认值 `0.062`，避免 Inspector 把默认状态夹到 `0.1` 后造成加载即变形。

`chainLength` 不再对 `ZT.2` 主体节点做整体 X 缩放。脚本会读取主体 mesh 的原始顶点范围，保护两端支腿和端头区域，只让中间链条/侧梁区段做线性伸缩；长度变大或变小时，视觉左侧作为对接基准保持固定，右侧随目标长度延长，端部支腿保持自身厚度并整体平移，避免“移载机变长后支腿和端头被拉扁/拉宽”。由于 GLB 内部子节点导入朝向不同，主体固定局部 X 最大端，辊筒固定局部 X 最小端，统一表现为画面左端不漂移。

截图红框内的 `Ban.4` 顶升移载模块已经从整机 `chainLength` 中解耦：整机加长时红框模块长度保持默认 `platformLength = 1.022m`，需要改变红框模块自身长度时单独调整 `platformLength`。平台仍会随 `chainWidth` 居中变宽，并随 `chainHeight` 上移，避免独立长度破坏宽度、高度和顶升动画语义。

当前项目已经导入的模型副本位于 `F:\3d-models\models\Assets\Models\YZJ`。调试或发布 YZJ 脚本时需要同步源模型包与该副本；视觉验证建议覆盖默认值、旋转 45° 后调整 `chainLength/chainWidth/chainHeight`、`platformLength` 独立变化、`rollerDensity + rollerPosition`、旋转 90° 的多参数组合，确认底部支腿不漂移、顶升平台和辊筒随高度上移、辊筒密度沿设备宽度方向增加。

## 导入模型资产编号说明

`modelAsset.assetCode` 是导入模型的场景实例级资产编号，用于后续动画数据按模型实例识别。模型包扫描会从同包 `*.model.ts` 的 `dataDriven.device.defaultAssetCode` 只读提取默认前缀；导入实例时会生成 `默认前缀-实体短ID`，例如 `YZJ01-A1B2C3D4`。如果脚本未声明默认前缀，则使用 `MODEL-实体短ID` 兜底。

`defaultAssetCode` 只作为模型库导入时的编号前缀，不是完整实例编号；同类模型多次导入、复制粘贴或执行模型阵列时，都会用新实体 ID 重新生成 `assetCode`，避免不同实例共享同一个动画识别编号。旧场景文件缺少 `modelAsset.assetCode` 时，加载阶段会自动补齐编号。

运行时会把当前实例编号写入模型内容根节点 `metadata.assetCode` 与 `metadata.modelAsset.assetCode`，并注入外置模型脚本实例的 `assetCode` 属性；模型脚本中已声明的 `dataDriven.device.assetCodeField = "assetCode"` 可直接读取该实例编号。

PLC/MQTT 遥测不会按模型名称、Hierarchy 名称或脚本文件名匹配设备，只使用 topic 中的资产编号匹配 `modelAsset.assetCode`。现场联调时应先确认模型实例的 `modelAsset.assetCode` 与 PLC 上报资产编号一致，例如堆垛机 `DDJ2`、输送线 `1001`。

## MQTT 配置入口

Toolbar 的 `MQ` 按钮用于维护场景级 MQTT 配置。弹窗包含“启用配置”、“本地模拟”、“模拟资产”、“模拟场景”、“间隔(ms)”、“IP/域名”、“地址”和“Topic”字段；如果只填写 IP/域名，保存时会按默认 MQTT over WebSocket 端口和路径生成 `ws://<IP>:8083/mqtt`，如果填写完整地址则以完整地址为准。

该配置会写入当前 `SceneDocument.mqttConfig` 并随 `.scene.json` 保存、加载。启用后运行时通过 MQTT over WebSocket 连接 broker 并订阅 PLC/MQTT 遥测数据；通用默认订阅 topic 为 `dt/factory/logistics/+/+/twindatadriven/joint`。

如果启用“本地模拟”，运行时不会连接 MQTT broker，而是按 `simulatorAssetCode` 生成 `dt/factory/logistics/stacker/<资产编号>/twindatadriven/joint` 消息并写入同一个内存遥测通道。模拟场景支持 `cycle`、`target`、`movement`、`fault`：`cycle` 会在目标位追踪和全 0 movement 模式之间切换，`target` 只追目标位，`movement` 固定发送 `to_x=0,to_y=0,to_z=0`，`fault` 发送急停/故障状态。

topic 路径固定为 `dt/factory/logistics/<设备类型>/<资产编号>/twindatadriven/joint`。第一个通配段表示设备类型，例如 `stacker` 或 `conveyor`；第二个通配段表示资产编号，例如 `DDJ2` 或 `1001`。运行时只把资产编号与场景中导入模型实例的 `modelAsset.assetCode` 匹配，匹配成功后才驱动对应模型。

payload 使用 `data[]` 数组承载 PLC 点位，每一项按 `e/p/v` 三个字段解释：

| 字段 | 用途 |
| --- | --- |
| `data[].e` | 点位所属设备资产编号，通常与 topic 中的资产编号一致；现场数据不一致时优先排查 PLC 映射。 |
| `data[].p` | 点位名称，例如 `movement_x`、`containerCode`、`normal`。 |
| `data[].v` | 点位当前值，运行时按设备语义转换为数字、布尔或字符串。 |

运行时会以 topic 中的资产编号为准过滤点位：`data[].e` 为空时按兼容数据接收，`data[].e` 非空且与 topic 资产编号不一致时，该点位会被忽略，避免混合 payload 污染当前设备状态。

实时 MQTT 数据只保存在运行时内存中，不写入 `SceneDocument`，也不进入 undo history。

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
| `signalBits` | 输送线 IO/传感器信号位快照，第一版用于 metadata 与现场排查。 |
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

演示场景生成脚本会读取真实 `Stacker.glb` 的 bounds 和模型包 `meta.json`，自动推断源单位；当前真实模型会保存为 `lengthUnit = "millimeter"`、`unitScaleToMeters = 0.001`，避免把毫米模型误按米处理后被参数脚本放大或拉伸。

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

如果没有部署 MQTT broker，直接加载 `examples/scenes/stacker-mqtt-demo.scene.json`，保持 MQ 配置中的“启用配置”和“本地模拟”勾选即可；编辑器会在浏览器运行时内部生成同协议数据，不需要执行外部 broker。普通 Vite 浏览器调试可访问 `http://127.0.0.1:<port>/?demo=stacker-mqtt` 自动打开该演示场景；开发服务器会通过只读 `/__editor_asset__/` 通道加载 `editor-asset://local/` 指向的本地模型、脚本和贴图，正式 Electron 环境仍走受控本地资产协议。

模拟器支持 `--scenario cycle|target|movement|fault`。其中 `cycle` 会在目标位追踪和全 0 目标位 movement 模式之间切换；`target` 会按目标位序列让前叉、后叉交替携带托盘，并在 `front_command/back_command=3/4/5` 阶段把货物放入 `1-1-1`、`2-1-1`、`3-2-1` 虚拟定位线框；`movement` 会持续发送 `to_x=0,to_y=0,to_z=0`，用于验证不查 locator 时按 `movement_*` 移动且用 `distance_*` 校准；`fault` 会发送急停状态，用于验证运行时暂停追目标和 movement 积分。

运行时会先完成模型文件加载、源单位缩放、底部中心归一、参数化脚本初始化和 Stacker 遥测基线重建，然后才允许 MQTT/本地模拟帧驱动动画。这样模型会先以正确位置和比例进入场景，再由 `to_*` 或 `movement_*` 推动，不会在加载阶段把错误单位或未初始化节点写进动画基线。

## 构建检查

如果外部模型包只有 `meta.json.parameterScripts` 而没有 `modelParameters`，可执行以下脚本从已有脚本字段补齐 Inspector 参数 schema；脚本会先在每个模型包目录创建 `meta.json.bak-*` 备份，再写回 `meta.json.modelParameters`：

```bash
node scripts/sync-model-parameters-from-scripts.mjs --write
```


执行 TypeScript 类型检查：

```bash
npm run typecheck
```

执行完整构建检查：

```bash
npm run build
```

## 基础操作

- 首页进入编辑：启动后在首页点击 `新建场景` 可重置为空白场景并进入编辑器；点击 `打开场景文件` 可选择 `.scene.json`；点击最近项目会进入编辑器并让 Project 面板加载该项目资源；点击最近场景会直接加载对应场景。
- 创建基础对象与常用灯光：在模型库中点击或拖拽 `立方体`、`球体`、`地面`、`虚拟定位线框`、`半球光`、`方向光`、`点光源` 内置资源卡片；点击卡片会在默认位置创建对象，拖拽到 Scene View 会按鼠标释放位置投射到地面平面并创建对象。
- 选择对象：点击 Hierarchy 项，或在 Scene View 中单击对象；Hierarchy 中可使用 Ctrl/Cmd 多选、Shift 连续多选。
- 整理层级：在 Hierarchy 点击 `新建` 可创建纯分组文件夹，将一个或多个普通实体拖入文件夹可完成分组；拖到 `根层级` 可移出文件夹。选中文件夹时，组内实体会在 Scene View 中一起高亮；文件夹只影响左侧列表归类，不改变模型世界坐标或 Transform 父子关系。右键菜单中的 `群组对象` 会创建新分组并把当前普通实体选区移入分组，`解组对象` 会把选中文件夹或选中对象所在文件夹释放回根层级。
- 控制对象状态：Hierarchy 实体与文件夹行前的显示按钮可隐藏/显示对象或整组对象，锁定按钮可锁定/解锁对象或整组对象；右键菜单和快捷键支持批量隐藏、批量锁定与批量删除。隐藏对象不会在 Scene View 显示或被拾取，锁定对象仍显示但不能被画布拾取、挂载 Gizmo、删除或通过 Inspector 编辑。
- 复制、粘贴与阵列：在 Hierarchy 右键菜单或快捷键中复制当前普通实体选区；粘贴到右键文件夹时进入该文件夹，粘贴到右键普通对象时进入同级，粘贴副本会生成新 ID 并轻微偏移位置；`模型阵列` 可按 +X/-X/+Y/-Y/+Z/-Z 方向、可配置间距和副本数量生成线性阵列副本。
- 聚焦对象：右键菜单 `场景聚焦` 或 F 会根据当前 Hierarchy 选区世界包围盒移动 Scene View 相机；导入模型可用 `库聚焦` 切换到底部 Project 模型库并滚动高亮对应资源卡片。
- 清空选择：在 Scene View 中单击空白区域。
- 切换 Gizmo：点击顶部工具栏的移动、旋转、缩放图标按钮，或使用 W/E/R 快捷键。
- 切换坐标空间：点击 `局部` 或 `全局`。
- 开启吸附：勾选 `吸附`，并调整位置、旋转、缩放步长；其中位置步长单位为 `m`。
- 控制网格：在 Toolbar 中勾选或取消 `网格` 控制 Scene View 地面辅助网格显示，并通过 `格子` 下拉选择 `1 m`、`2 m`、`5 m`、`10 m` 四档格子大小。
- 导入 CAD 参考图：点击 Toolbar 的 `导入CAD参考图` 选择 `.dxf` 文件；Toolbar 会显示读取文件、解析图元和创建参考层的进度，导入中会暂时禁用重复导入。无明确单位时按毫米换算到米，图纸会按自身包围盒中心归零后贴到网格层上方约 `0.01 m`。导入后默认锁定，可在 Hierarchy 解锁后通过 Transform 移动/旋转/缩放对齐，也可在 Inspector 调整线色和透明度。
- 调整视野：在 Toolbar 中通过 `视野` 下拉选择 `近景`、`标准`、`远景`、`全景`，用于快速调整 Scene View 默认相机观察距离和可视范围；也可使用鼠标滚轮靠近或远离模型，近距离缩放会保留最小观察距离，便于查看模型细节且避免画面变黑。
- 编辑属性：在 Inspector 中修改名称、Transform、材质颜色或灯光属性；选中 `虚拟定位线框` 时，可编辑资产编号、长(X)、宽(Z)、高(Y)，场景线框会实时更新并支持撤销/重做；选中导入模型时，可在 `Model Asset` 区域编辑模型实例资产编号，选中带 `modelParameters` 的导入模型时，还可在“模型参数”中编辑尺寸、颜色、显隐、规格、向量偏移或贴图等参数，场景外观会实时更新。
- 删除实体：点击顶部工具栏 `删除`，或使用 Delete/Backspace 快捷键。
- 浏览资源库外观：底部图库区域会根据窗口高度在约 `180px` 到 `260px` 之间自适应，在 Project 面板中点击 `模型库`、`POI库`、`主题库`、`组合库`、`环境库`、`图表库`、`图片库` 页签，可切换不同资源库展示；小窗口下页签和资源卡片通过内部滚动访问；模型库卡片有封面图时显示模型包封面，没有封面图时显示类型占位图标；模型库可点击 `导入模型文件夹` 扫描本地模型包，首次导入会选择项目目录，模型包会复制到该项目的 `Assets/Models` 下；导入模型 `scale = 1` 表示不额外缩放，源单位到米的换算会自动生效。
- 放置模型：模型库中已导入的真实模型卡片支持点击或拖拽；点击会把模型导入到原点，拖拽到 Scene View 后释放会按鼠标位置投射到地面平面并在对应世界坐标创建模型。
- 资源库功能边界：模型库当前支持内置基础资源创建与真实模型文件夹导入；同名模型包再次导入会覆盖项目目录中对应模型包，其余资源库仍为样式占位。导入模型文件夹依赖 Electron preload 暴露的本地文件 API，需要使用 `npm run dev:electron` 启动桌面编辑器，普通 Vite 浏览器页面不具备该能力；Electron 主窗口通过 CommonJS preload 产物 `dist-electron/preload.cjs` 注入 `window.editorApi`。

虚拟定位线框最短验收：

1. 执行 `npm run dev:electron` 启动 Electron 编辑器。
2. 在 Project 面板模型库点击或拖拽 `虚拟定位线框`，Scene View 中会出现可拾取的长方体线框。
3. 选中该实体，在 Inspector 的“虚拟定位线框”区域修改 `资产编号`、`长(X)`、`宽(Z)`、`高(Y)`，线框尺寸会实时变化。
4. 点击 Toolbar 的 `保存场景` 导出 `.scene.json`，再通过 `加载场景` 打开该文件，确认资产编号和长宽高保持一致。

## 架构说明

项目按桌面壳、渲染器 UI、编辑器领域模型与运行时渲染层拆分：

- Electron 主进程：负责创建桌面窗口、管理应用生命周期，并承载需要在主进程中执行的本地能力。
- preload 安全 API：作为主进程与 renderer 之间的受控桥接层，避免 renderer 直接暴露高权限 Node.js 能力；本地模型通过 `editor-asset://` 受控协议加载，项目内模型资产通过 `.babylon-editor/asset-index.json` 记录并指向 `Assets/Models` 下的项目内路径；首页最近项目、最近场景、按路径加载场景和移除最近记录也通过受控 IPC 暴露。
- React renderer：负责编辑器界面、面板布局、用户交互与状态展示，并通过入口错误边界将启动期异常转换为可见错误页。
- editor model：定义 SceneDocument、Entity、Transform、MeshRenderer、ModelAsset、Light 等编辑器核心数据结构，是保存/加载与 UI 编辑的统一数据来源。
- commands：封装可撤销编辑操作，并维护撤销/重做命令历史。
- runtime/babylon：负责将编辑器场景文档同步到 Babylon.js 运行时场景，包括 Mesh 创建、模型导入、灯光同步、Transform 同步与选中高亮。
- panels：按编辑器区域拆分 UI，包括 Hierarchy、Scene、Inspector、Project、Console 等面板。

## 场景文件说明

当前场景文件使用 `.scene.json` 后缀，内容为 JSON 格式的 `SceneDocument`。

场景文件的核心约定：

- `version` 当前为 `1`，用于后续场景格式演进和兼容处理。
- 长度单位固定为米：`1 scene unit = 1 m`。
- 新保存的场景文件会写入 `units.length = "meter"`；旧版没有 `units` 字段的场景文件会按米兼容加载。
- `SceneDocument` 保存场景实体、基础对象类型、外部模型资源路径、灯光组件、Transform、Hierarchy 文件夹分组以及实体/文件夹 `visible`/`locked` 状态等编辑数据。
- 加载场景时会进行基础校验，格式不合法或结构不符合预期的 scene 文件会被拒绝，避免破坏当前编辑器状态。
- 场景加载成功后会重置 `selectedEntityId`，避免旧选中对象引用到新场景中不存在的实体。
- 场景加载成功后会重置 command history，避免跨场景执行旧的撤销/重做命令。
- glTF/GLB 模型实体保存的是项目内资源路径、`editor-asset://` 受控资产 URL、实例资产编号 `modelAsset.assetCode`、源单位 `lengthUnit` 与换算系数 `unitScaleToMeters`；移动或删除项目目录中的 `Assets/Models` 模型包后，需要重新导入对应模型包。
- 带参数化配置的模型实体会额外保存 `modelAsset.parameterConfig` 与 `modelAsset.parameterValues`：前者是从模型包 `meta.json.modelParameters` 归一化得到的参数 schema 与 binding 快照，后者是当前场景实例的参数值。旧场景缺少这些字段时仍按普通导入模型兼容加载。
- `虚拟定位线框` 实体会保存 `locator.assetId`、`locator.length`、`locator.width`、`locator.height`，重新加载 `.scene.json` 后仍能恢复资产编号与长方体线框尺寸。
- `CAD参考图` 实体会保存 `cadReference.sourcePath`、`sourceUrl`、米制换算比例、中心归零方式、线色、透明度、图层统计与包围盒；重新加载场景时会重新授权对应 `.dxf` 文件，若源文件被移动或删除，参考图无法恢复线稿。
- 带外置脚本的模型实体会额外保存 `modelAsset.scriptAssets`、`parameterScriptMetadata` 与 `animationScriptMetadata`；加载场景时主进程会重新授权这些 `.model.ts` 文件，运行时把当前参数和 `assetCode` 同步到脚本实例与 Babylon 节点 metadata。
- 场景级 MQTT 配置保存在 `mqttConfig.enabled`、`mqttConfig.ip`、`mqttConfig.address`、`mqttConfig.topic`、`mqttConfig.simulatorEnabled`、`mqttConfig.simulatorAssetCode`、`mqttConfig.simulatorScenario` 和 `mqttConfig.simulatorIntervalMs` 中；旧场景缺少该字段时会自动补齐 MQTT 默认 topic 和本地模拟默认值。

## 当前限制

- glTF/GLB 导入属于 MVP 级能力：支持导入、选择、基础 Transform、参数化外观绑定、保存和加载，不承诺完整材质编辑、动画、骨骼、蒙皮或嵌套资源管理。
- CAD/DXF 导入属于布局参考层能力：首版只承诺常见二维线稿实体 `LINE`、`ARC`、`CIRCLE`、`LWPOLYLINE`、`POLYLINE`；不承诺 HATCH 填充、DIMENSION 标注、完整 TEXT/MTEXT 字体、Paper Space、多布局、3D Solid 或可编辑 CAD 图元。DXF 文件不再按文件大小、图元数量、折线数量或采样点数量做硬性拦截；复杂图纸会尽量完整导入，但超大图纸解析和生成线稿可能需要较长时间。
- 参数化模型依赖模型包中稳定的节点、网格或材质名称；安全 DSL 只支持 JSON AST 中的白名单运算和白名单属性绑定，不执行任意 JavaScript/TypeScript。贴图参数只允许模型包内 `.png`、`.jpg`、`.jpeg`、`.webp` 相对路径，不支持绝对路径、网络 URL、`data:`、反斜杠路径或 `../` 路径逃逸。
- Project 资源库当前只有模型库接入项目目录持久化与真实模型拖拽放置；POI、主题、组合、环境、图表、图片仍为占位展示，暂未接入真实搜索过滤、资源加载、拖拽或导入。
- 首页最近项目和最近场景依赖 Electron preload 的本地文件 IPC；普通 Vite 浏览器页面会显示降级提示，并仅保留进入空白编辑器、新建场景等不依赖本地文件授权的基础入口。
- 主布局自适应当前只包含随窗口尺寸自动调整与 Console 局部最小化，不包含拖拽分隔条、其它面板折叠或用户自定义布局保存；小于约 `1024×640` 的窗口会继续尽量收缩，但不保证所有内容舒适可读。
- 纹理、图片、图表、POI、主题、组合与环境资源目前只作为资源库占位分类展示，暂未建立真实数据模型。
- 灯光编辑支持类型与强度，暂未提供颜色、阴影、范围、衰减等高级参数。
- 当前 Hierarchy 文件夹仅用于场景对象组织分组；文件夹显隐和锁定会作用到组内对象，但不提供文件夹嵌套、文件夹 Transform 继承或批量 Transform 父子联动。

## 最近完成

- 2026-07-08：优化 Scene View 默认相机构图，`标准` 视野采用更远的观察距离和更低俯仰角，让地面网格不再铺满首屏，保留更多黑色背景可见范围。
- 2026-07-03：模型阵列方向扩展为 +X/-X/+Y/-Y/+Z/-Z 六向选择，阵列间距继续按米配置，负向阵列会按同一间距反向生成副本。
- 2026-07-03：补充通用 PLC/MQTT 遥测层文档；默认 topic 扩展为 `dt/factory/logistics/+/+/twindatadriven/joint`，说明 `data[].e/p/v`、`modelAsset.assetCode` 资产匹配、DDJ2 堆垛机字段、1001 输送线第一版语义和现场排查步骤。
- 2026-07-03：补齐 Stacker 前叉/后叉货物运行时语义；`front_containerCode/back_containerCode` 会创建内存货物并随对应货叉运动，`front_command/back_command=3/4/5` 且目标位有效时货物进入 locator 虚拟定位框，放货完成后条码清空也会保留在目标框内。
- 2026-07-02：修正 Stacker 遥测水平行走语义；`movement_x`/目标位只驱动模型脚本 `dataDriven.motion.travel.nodes` 声明的行走机构，`fixedNodes` 上下轨道保持固定，并将行走、升降、货叉伸缩合成为节点级世界偏移后再写回本地坐标。
- 2026-07-02：补强 Stacker 轨道约束；水平行走会按固定轨道包围范围夹紧，超出轨道长度的 `distance_x`、movement 积分或轨道外目标位不会把机体推出轨道端点。
- 2026-07-02：修复 Stacker demo 普通浏览器可视验证链路；演示场景按真实 GLB bounds 推断毫米单位，Vite 开发期通过只读 `/__editor_asset__/` 加载本地模型包，运行时在归一化和外置脚本初始化完成后再启动 Stacker 遥测动画，避免加载即变形。
- 2026-07-02：新增无 broker 的 Stacker 本地模拟模式；MQ 配置可保存模拟资产、场景和间隔，浏览器运行时直接生成同协议数据写入内存遥测，演示场景默认启用 `DDJ2/cycle/500ms`。
- 2026-07-02：Stacker MQTT demo 场景改为直接引用 `F:\3d-models\models\Stacker` 真实模型包，保留 `DDJ2` 资产编号、`1-1-1/2-1-1/3-2-1` 目标位和本地模拟配置。
- 2026-07-02：新增 Stacker MQTT 演示场景和模拟发布脚本；场景内置 `DDJ2` 模型、`1-1-1/2-1-1/3-2-1` 目标位与默认 WebSocket MQTT 配置，模拟器支持目标位、全 0 movement 和急停场景。
- 2026-07-02：补充 Stacker MQTT 动作解析与目标位规则文档；说明 WebSocket 连接订阅、topic 资产编号匹配、payload 字段映射、目标位 locator 查找、编码器校准、故障暂停和实时数据不落盘边界。
- 2026-07-02：首页启动台调整为只展示项目与场景相关内容，保留最近项目、最近场景、新建场景、打开项目目录和打开场景文件入口；Project 面板继续独立承载模型库与内置资源创建。
- 2026-07-02：Toolbar 新增 MQTT 配置弹窗，支持保存 MQTT IP/域名、MQTT over WebSocket 地址和 topic；只填 IP 时自动补齐 `ws://<IP>:8083/mqtt`，启用后会连接 broker 并订阅 Stacker 动作数据。
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
- 2026-06-28：将 Scene View 地面网格升级为随相机重定位的视觉无限网格，并保留世界原点呼吸光晕。
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
- Play Mode：区分编辑模式与运行模式，支持场景运行预览。
- 脚本组件：为实体挂载脚本逻辑与自定义组件。
- 动画、物理、粒子、Terrain：补充完整 3D 编辑器常见运行时与内容创作能力。
- 构建导出与插件系统：支持项目打包导出，并提供可扩展的编辑器插件机制。
## Shelf 多穿货架参数化修复记录

- 2026-07-01：补齐 Shelf 高度变化时侧面三角支架的数量联动。`cellHeight` 按 `ceil(目标层高 / 原始层高)` 计算每层三角支架模块数，保证单个支架模块高度不超过原始层高；默认高度保持 4 个侧撑节点，5.5m/6.8m/9.05m 会自动变为 8 个，13.575m 会变为 12 个。多层、多列、双深和旋转组合都会在各自货格内按模块高度重复生成支架，而不是只把单个支架拉长。
- 2026-07-01：修复 Shelf 多穿货架参数化脚本的层/列/双深组合变形。`layerCount`、`columnCount`、`doubleDeepEnabled` 现在以原始单格部件为唯一语义源，按层、列、深位一次性组合克隆，避免把运行态克隆再次作为克隆源导致穿插或漏复制。
- 列复制语义：`cellWidth` 仍作为货格宽度输入，实际列阵优先使用左右支撑中心距，以保持多穿货架 0 间距共享立柱的业务语义；深位复制使用 `cellDepth + deepSlotGap`，`deepSlotLift` 只作用于第二深位的 Y 向偏移。
- 旋转语义：宽、高、深的包围盒读取和克隆偏移改为模型局部 X/Y/Z 在世界空间中的投影方向，模型整体旋转后仍沿货架自身方向参数化。
- 验证组合：默认 1 层 1 列、3 层 4 列、2 层 3 列双深、旋转后的多层多列双深组合。源包 `F:\3d-models\models\Shelf\shelf.model.ts` 与资产副本 `F:\3d-models\models\Assets\Models\Shelf\shelf.model.ts` 必须保持同步。
