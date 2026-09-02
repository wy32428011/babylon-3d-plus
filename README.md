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
- 首页启动台：进入五面板编辑器前会先显示首页；左侧“最近项目”通过 Electron 主进程从可配置的数据中台 `POST /api/v1/projects/query` 拉取业务项目列表，支持按项目名称进行服务端搜索，展示数字孪生工程版本、项目更新时间和最新发布时间，并打开该业务项目当前绑定的数字孪生工程；右侧继续显示本地最近场景，并保留新建场景、打开项目目录和打开场景文件等入口。本地最近记录由主进程保存到 `recent-workspaces.json`，并兼容旧版单项目 `recent-project.json`。
- 数据中台发布：Toolbar 提供 `发布到数据中台`，桌面端是数字孪生工程编辑和版本发布的唯一入口。发布会先对当前场景生成一次幂等合批快照并保存，再由同一份场景内容生成包含全部场景与实际引用资源的 SOURCE ZIP、自包含 Viewer DIST ZIP，不会在各阶段重复规划合批；随后按分片断点上传并在数据中台创建工程版本、发布记录及 nginx 部署。数字孪生 SOURCE/DIST 发布包会跳过 CAD 参考图和 DXF 文件，避免跨机器原图路径失效阻断发布，本地场景与独立 Web 部署导出仍保留 CAD；已绑定场景会自动使用所属业务项目，不再重复选择；未绑定场景可在发布弹窗选择业务项目，并在首次发布时建立本地绑定；目标业务项目已有当前数字孪生工程时必须显式确认覆盖，并沿用原 `editorProjectId` 创建下一版本；本地基础版本落后时可额外确认强制覆盖，以远端最新版本为基线把本地内容创建为下一版本；发布后的数字孪生 Viewer 在场景就绪后直接消费已持久化的 `modelArrayInstance` 关系，并默认隐藏“场景运行中”状态层、自动巡检浮窗和手动漫游浮窗；自动巡检与手动漫游浮窗只能由大屏组件对应按钮发送的 `startAutoPatrol` / `startManualRoam` 命令打开，打开时互斥切换；同时按下鼠标左键和右键仅切换运行状态层。运行状态层以 1 秒间隔显示 Babylon 实时 FPS，加载、阻断和真实运行异常仍自动显示。
- Electron 启动诊断：开发启动时会输出 renderer 加载、preload 与渲染进程退出日志；React 与 Scene View 初始化异常会显示可读错误页或错误面板，避免窗口内容区静默空白。
- GPU/WebGL 硬件加速：Electron 在 ready 前请求高性能 GPU，并在主窗口明确启用 WebGL；Windows 正式打包版按企业部署策略额外关闭 GPU sandbox。编辑器 Scene View 和发布后的独立 Web Viewer 都使用 `high-performance` 上下文、设置 `failIfMajorPerformanceCaveat=true`，并拒绝 SwiftShader、WARP 等软件 renderer，避免页面静默退回 CPU 模拟渲染；Viewer 无法获得硬件 WebGL 时会显示阻断原因和浏览器 GPU 排查建议。模型文件读取与格式解析仍由 CPU/Worker 执行，几何和纹理上传后由 GPU 完成绘制、Shader、纹理采样与画面合成。
- Unity-like 五面板布局：包含 Hierarchy、Scene、Inspector、Project、Console 五个核心编辑器区域，并支持根据窗口尺寸自动自适应；Toolbar 下方左侧 Hierarchy 与右侧 Inspector 贯通到窗口底部，中间列独立承载 Scene、Project 与 Console；Project/Console 只与 Scene 画布同宽，在约 `1024×640` 及以上窗口中保持五面板可见，Console 默认收纳到 Project 区域最小化入口，点击后以弹窗查看完整日志，Toolbar 与 Project 页签通过内部横向滚动承接溢出，资源卡片按可用宽度自动换行并在超出高度后纵向滚动。
- Babylon Scene View：在 Scene 面板中渲染 Babylon.js 3D 场景，并同步当前场景文档中的基础 Mesh、导入模型与灯光；默认编辑器相机使用更开阔的 `标准` 视野，新场景可视距离为 `12000 m`、最大为 `20000 m`，让地面网格上方和周围保留更大的黑色背景可见范围，并可在 Toolbar 中切换 `近景`、`标准`、`远景`、`全景` 四档可视范围；编辑态、运行预览和发布 Viewer 保留原有右键拖拽旋转、中键拖拽移动、Ctrl+左键拖拽平移、左键短点击单选和滚轮缩放，编辑器额外支持 `Ctrl/Cmd + 左键短点击`逐个加入或移出多选；默认旋转幅度统一为 `0.3°/px`，平移按当前取景高度换算为约 `1` 个画面像素/鼠标像素，滚轮每档缩放当前距离的 `5%`，Inspector 中的缩放/平移/旋转灵敏度随场景保存，发布 Viewer 启动和画布尺寸变化后都会应用同一套值；鼠标滚轮缩放带有最小观察距离与动态近裁剪保护：近景保留 2 cm 观察能力，透视远景按当前距离提高深度精度，避免模型外壳出现条纹、闪烁或缺面；模型表面上的相机操作不会被模型拾取阻断，短点击与拖拽按真实相机输入和位移阈值区分；Toolbar 新增“俯”视角按钮，可保留当前观察中心与缩放距离切换为稳定俯视视角，方便依据地面 CAD 图纸定位并搭建场景。
- 视口定向罗盘：Scene View 右上角常驻 SVG ViewCube，实时同步世界 X（红）、Y（绿）、Z（蓝）轴方向；支持 Top、Bottom、Front、Back、Left、Right 六个标准面及正负轴端点一键切换，点击后保留当前观察中心与缩放并进入正交硬锁，再次点击当前面恢复进入前的自由轨道方向。罗盘 Home 按钮复用场景“复位视角”，显式“保存当前视角”可持久化六面锁定与投影；运行预览继续显示和允许操作，发布 Viewer 只恢复保存画面但不继承硬锁。
- 大场景原模型 Geometry 无损优化：不降低渲染分辨率、抗锯齿、纹理、材质、光照或几何质量，也不焊接、删面、隐藏可见模型或使用 LOD/代理；同一 `sourceUrl + assetRevision` 的普通静态模型继续复用单份源 `AssetContainer`，每个实体保留独立 Transform、显隐、锁定、拾取和选择语义；基础 Mesh、普通导入模型、复制副本、阵列实例与球形天空盒选中时统一使用深红色（`#8B0000`）约 `5 px` 静态柔和光晕，不再叠加实线主描边，遵循场景深度遮挡且不改写模型表面材质。Scene View 编辑态只会把 `meta.json.dataDriven` 不含自有 `motion` 键的同模板无脚本模型，以及已核对的 Box、Chain、NewChain、GD、HCTS、Shelf、WLTS、YZJ 参数化模型归并为 thinInstance；`motion` 键存在时（包括值为 `null` 或空对象）保持独立渲染，旧快照中的对应 `modelArrayInstance` 关系也会自动解除。合批函数不修改编辑器 Store，保存、数据中台发布和独立部署导出则通过统一序列化入口把幂等 `modelArrayInstance` 关系写入快照。参数脚本先完整执行，随后批次仅复用真实模型的顶点、索引、材质、纹理和所有部件，在任何相机距离与视角都不创建方块、框架或其它替代 Geometry。运行预览和发布 Viewer 直接复用已完成或已持久化的 Geometry 批次、批次 Mesh 和矩阵缓冲，只切换脚本、动画与遥测生命周期，不重新加载、拆批或执行完整场景同步。每个逻辑实体的参数、`assetCode`、Transform、显隐、锁定和遥测绑定均保留。正式批次按空间分片并只对相机视锥外实例执行正常裁剪；实例进入视锥后始终提交原模型 Geometry。设备模型加载最多 4 个并发任务；环境 GLB 使用独立调度器和会话级源容器缓存，不再与设备模型抢同一条队列，同一环境二次打开只克隆工作副本。纯选择变化走 `SceneRuntime.syncSelection()`，Hierarchy 对 10k/50k 行采用固定行高虚拟化。Scene View 内置 1 Hz 性能 HUD，可查看 FPS、CPU/GPU frame time、Draw Call、Mesh、thinInstance、原模型/代理实体数、GPU 顶点/三角工作量与材质分类，并复制最近一分钟报告；代理计数必须恒为 0，监控器可通过 Toolbar 的“性能”复选框显示或隐藏。WebGL 上下文丢失或渲染循环异常会显示可读遮罩，Babylon 恢复后自动清除。详见 `docs/scene-capacity-performance.md`。
- 米制场景单位：编辑器约定 `1 scene unit = 1 m`，Inspector 中 position、位置吸附步长与地面网格均按米解释；普通导入模型的实际 X/Y/Z 尺寸由编辑器运行时原生测量，不依赖参数化脚本。
- 编辑器地面辅助层：Scene View 使用单 Mesh、单 Shader 的相机局部科技蓝地面网格，默认每小格表示 `5 m`，可在 Toolbar 中切换显示/隐藏并选择 `1 m`、`2 m`、`5 m`、`10 m` 四档格子大小；承载平面按主格整数倍跟随当前观察中心，但网格线继续锚定世界米制坐标，不会视觉漂移。细格、主格和粗格按屏幕像素密度自适应显隐，远端平滑渐隐；网格正常接受模型深度遮挡、不写入深度，不再创建第二层网格、GlowLayer 或逐帧呼吸动画。辅助层不参与选中、保存、加载或撤销/重做。
- CAD/DXF 网格参考层：Toolbar 支持导入 `.dxf` CAD 图纸，导入过程中会显示读取、解析和创建参考层进度；`LINE`、`ARC`、`CIRCLE`、`ELLIPSE`、`SPLINE`、`LWPOLYLINE`、`POLYLINE`、`HATCH` 边界、`SOLID/TRACE/3DFACE` 外轮廓与 `LEADER` 会统一换算为米，并按 DXF 正 Y → Babylon 正 Z 的同向规则转为贴近 `y = 0` 网格层的半透明线稿。超过 64 MB 的图纸在 Worker 中完整扫描 BLOCK 与嵌套/阵列 INSERT；每份 BLOCK 图层几何只保存一次，平移、旋转、缩放和镜像以 4×4 矩阵零拷贝回传，并通过 LinesMesh thinInstance 渲染。100 万条折线 / 800 万个点的安全上限只约束唯一原型几何，重复 INSERT 不再展开进坐标数组或被尾部截断；若唯一原型本身超过上限会明确拒绝导入。单位优先读取 `$INSUNITS` 0–24，未声明单位时参考 `$MEASUREMENT`，仍无法判断时明确按毫米兜底；参考图默认锁定、不可拾取，Inspector 会显示源单位、判定来源和换算系数，并随场景保存/加载恢复。
- 创建基础对象：支持创建米制 Cube、Sphere、Plane；基准尺寸分别为 `1 m × 1 m × 1 m`、直径 `1 m`、`2 m × 2 m`，有体积对象拖入 Scene View 时会以底面落地。
- 创建基础灯光：支持创建 Hemispheric、Directional、Point 三类灯光实体；Directional 会接管场景主阴影，没有可见方向光时自动创建太阳光并铺阴影接收地面，Hemispheric 保持为不产生阴影的环境补光。默认性能/均衡档缓存一张阴影贴图：设备模型只投射，环境底座和阴影地面接收，避免全场 PBR 逐像素采样；高质量档才对全部模型做实时级联阴影。未选中对象时，Inspector 场景属性可调节阴影开关、质量、浓度、太阳方位/高度/强度、覆盖距离、偏移、补光和环境光上限。编辑态中的 Point 使用可拾取球形标记，Directional 使用沿实际照射方向显示的箭头标记；标记保持近似固定屏幕尺寸、接受正常深度遮挡，并在运行预览和发布 Viewer 中隐藏。
- Hierarchy 选择与分组：Hierarchy 与 Scene View 共用同一多选集合和主选对象；最后加入的实体作为 Inspector 主选，移除主选时回退到最近加入的剩余实体。单文件夹或任意多选都会递归展开所选文件夹、去除重复后代，并在完整选区世界包围盒中心显示仅支持世界坐标移动和旋转的组合 Gizmo；缩放与 Shift 阵列不可用。移动对全部成员应用同一世界位移，旋转以拖拽开始时的组合中心为轴心，同时更新成员位置和自身旋转并保持原缩放；一次拖拽只写入一条撤销记录。隐藏但已就绪的成员继续参与变换，任一成员或祖先锁定时原子阻止整组；任一包围盒或运行时目标尚未就绪时暂不显示 Gizmo，全部加载完成后自动恢复。文件夹自身不保存 Transform，空文件夹不贡献轴心。左侧 Hierarchy 继续提供搜索、全部展开、全部收缩、新建根/子文件夹、单选/多选拖入任意层级文件夹、拖回根层级，以及实体/文件夹级显示隐藏、锁定解锁控制；拖拽会阻止把文件夹放入自身后代。
- Hierarchy 右键菜单：左侧模型树单选或多选后可打开深色上下文菜单，支持场景聚焦、库聚焦、隐藏、复制、粘贴、模型阵列、锁定、重命名、删除、群组和解组；右键未选中对象会切换为单选，右键当前多选对象会保留多选集合。复制文件夹时会递归复制完整文件夹子树，包含空子文件夹和全部普通对象；文件夹副本可粘贴到当前目标文件夹，且粘贴和撤销/重做均按整棵子树处理。删除文件夹仍为非级联操作，其直属内容会提升到原父级。
- Scene View 点击选中：普通左键短点击对象切换为单选，点击空白清空选区；`Ctrl/Cmd + 左键短点击`可逐个加入或移出所有可见、未锁定且可变换的场景实体，点击空白保持当前多选，`Ctrl + 左键拖拽`仍优先平移相机。巡检节点在组合选择中按整条巡检路线处理，重叠对象仍只拾取最前方命中项。
- Inspector 实体编辑：支持编辑选中实体名称、position、rotation、scale 等 Transform 数据；其中 position 按米、rotation 在 UI 中按角度、内部仍按弧度保存。内置 Box 以 1 米基准映射为 `size (m)`；Sphere/Plane 明确显示米制基准尺寸，但通用 scale 仍保持无量纲缩放比例。普通导入模型的 `Model Asset` 区域固定显示只读“实际尺寸 (m)”及 X/Y/Z，加载中或无有效可见几何时显示明确状态。
- Inspector 材质编辑：支持编辑基础 Mesh 的材质颜色。
- Inspector 灯光编辑：支持编辑灯光类型与强度；Point 只显示 position，Directional 显示 position 与 rotation，Hemispheric 将底层 position 字段按实际语义显示为 direction，三类灯光均隐藏无效 scale。
- Transform Gizmo：Scene View 中支持移动、旋转、缩放三种可视化操控模式，普通拖拽结束后写入撤销/重做历史；Point 灯光只开放移动工具，Directional 开放移动与旋转工具，选择无效工具会自动回退移动，Hemispheric 不显示场景 Gizmo。单文件夹和任意多选临时强制使用世界坐标，只开放移动与旋转，不支持缩放或 Shift 阵列；退出群组选区后恢复进入群组前的工具与局部/世界坐标偏好。编辑模式下选中单个未锁定可阵列实体并使用移动工具时，可按住 `Shift` 拖动 X/Y/Z 单轴箭头进入模型阵列。可阵列实体包括导入模型、内置 Mesh、虚拟定位线框、已解锁 CAD 参考层和特效；文件夹、灯光、全局唯一模型生成器和球形天空盒明确排除阵列，灯光按住 `Shift` 时继续执行普通移动。自动巡检路线只开放移动与旋转，节点子目标同样禁止缩放并关闭 Z 轴滚转；节点拖动只回写对应巡检点位，不改变路线实体 Transform。
- Gizmo 坐标与吸附：支持局部/全局坐标空间切换，并可配置位置、旋转角度、缩放三类基础吸附步长；Shift 阵列沿当前可见局部/世界轴计算方向，阵列手势期间临时忽略位置吸附，普通移动吸附不受影响。
- W/E/R 与批量操作快捷键：在非输入控件聚焦时，可用 W/E/R 快速切换移动、旋转、缩放工具；F 场景聚焦、F11 场景全屏、H 隐藏对象、Ctrl+C 复制、Ctrl+V 粘贴、Ctrl+K 锁定、Ctrl+G 群组、Shift+G 解组、Delete/Backspace 删除当前 Hierarchy 选区；文件夹选区执行 Ctrl+C/Ctrl+V 时会整体复制文件夹及其完整后代子树。
- 撤销/重做：通过命令历史支持基础编辑操作、实体创建、实体删除、实体重命名、材质编辑、灯光编辑、巡检路线/点位编辑与 Gizmo 拖拽的撤销与重做；Hierarchy 批量隐藏、锁定、删除、粘贴、模型阵列、群组、解组以及任意多选/文件夹组合移动与旋转均作为单条命令进入历史，组合变换撤销/重做只恢复全部成员的 Transform，不引入文件夹 Transform 继承。Shift 拖拽阵列确认后同样以一条“模型阵列”命令整体撤销/重做。
- JSON 场景保存/加载：支持将当前场景保存为 JSON 文件，并从 JSON 场景文件加载；保存、文件选择加载和首页最近场景加载成功后都会更新最近场景列表。
 - Project 资源库外观：底部 Project 面板已切换为资源库浏览器样式，位于中间列 Scene 画布下方且与 Scene 同宽，并将图库区域加高到约 `300px` 至 `460px` 自适应，包含模型库、POI库、特效库、主题库、组合库、环境库、天空盒库、图表库、图片库九个页签，以及筛选占位行和可换行资源卡片；模型库卡片使用深色直角卡、上方缩略图、下方两行居中文字和单行省略标题，模型库内置立方体、球体、地面、虚拟定位线框、半球光、方向光、点光源七类基础资源；HDR/EXR 天空盒资源仅展示在天空盒库，点击天空盒卡片或拖入 Scene 会创建/更新一个进入 Hierarchy 的可见球体并选中，重复放置只更新这个全局唯一实体。图表库会在当前工程绑定数据中台项目后，自动同步该项目绑定的完整大屏卡片，并支持手动重新同步；不解析或展示大屏内部图表，未绑定本地项目不访问数据中台，也不会展示其它项目的大屏；同步仅保存大屏索引元数据，不保存大屏 `jsonContent`，大屏卡片当前仅用于展示，不能点击创建或拖入 Scene View/相机视窗。POI 库保留可点击或拖入 Scene 任意位置的“模型生成器”，重复创建入口会选中已有生成器而不是新建副本；同时新增可创建多条路线的“自动巡检”卡片，点击或拖入 Scene 后进入 Hierarchy；特效库集中展示原 POI 库中的 16 种内置 EFF，保留原有点击与拖拽创建能力；环境库使用独立的单 GLB 文件导入入口，支持点击应用或拖入右侧“环境模型”整条属性行；天空盒库支持导入 HDR/EXR，也可拖入右侧“天空盒资源”区域；所有导入模型进入场景后统一以米为操作单位。
- POI 模型生成器：生成器保存共享生成模板、按顺序匹配的条件规则、MQTT 精确绑定和元数据 TTL；一个场景只有 `entityIds` 中第一个生成器生效，编辑态 Transform 只控制青色可拾取配置标记，不作为任何货物生成点。运行预览中该全局生成器统一管理普通 Conveyor、普通 Stacker 与 `warehouseFlow` 的模板/规则；货物实际位置来自输送面、货叉、locator 或仓储状态机。派生 Mesh/模型不进入 Hierarchy，也不写入场景文件或撤销历史。
- POI 自动巡检：同一场景可创建多条可命名、分类、启停和设为默认的巡检路线，每条路线以实体 Transform 作为局部原点并支持整体移动/旋转、禁止缩放。编辑态选中路线后按 `F1` 以 `1.7 m` 统一眼高追加当前相机视角，选中编号节点后按 `F1` 覆盖；节点不进入 Hierarchy，可在 Inspector 中拖拽排序、复制、删除、聚焦，并编辑世界位置、视角、停留时间、路线速度和相机参数。Scene View 展示红色半透明编号节点、Catmull-Rom 路径、相机视锥及可配置的箱体/球体触发区域，并校验相邻点过近；巡检播放不做场景碰撞或地面可达性检测，相机可直接穿过模型。巡检支持区域进入/离开、距离、到点/停留和手动事件，可组合信息面板、设备高亮、`1920 x 1080` 异步截图、暂停及实时上报响应，包含冷却和单次巡检防重复机制。运行预览和发布 Viewer 共用巡检/历史面板，提供开始、暂停、继续、跳点、停止、紧急停止、`0.5x/1x/2x/4x` 倍速、第一人称/第三人称/轨道观察、手动接管和恢复自动视角；轨迹、事件、截图、异常汇总与任务状态持久化到 IndexedDB，断网时进入 Outbox，支持按时间轴回放、事件跳转及截图同步。路线 JSON 支持导入/导出，`enabled`、默认路线和自动启动相互独立。
- 手动漫游：只有场景中已摆放“手动漫游”POI 时才创建漫游运行时并对外暴露 `startManualRoam`；运行预览和普通独立 Web Viewer 直接显示漫游面板，数字孪生发布 Viewer 初始隐藏该浮窗，仅由大屏组件对应按钮发送的 `startManualRoam` 命令打开；未摆放出生点时保持标准轨道相机。人物漫游控制器支持 WASD/方向键、Q/E/Space、Shift、右键拖拽、双击或按钮进入 Pointer Lock、单指旋转、双指缩放、虚拟摇杆、Gamepad API、第一/第三人称、地面/飞行、独立移动与旋转灵敏度、跟随距离和约 `520 ms` 平滑复位。地面模式包含重力、跳跃、坡度限制、小台阶辅助、第三人称相机避障和可视化碰撞调试。碰撞按网格规模分层：顶点数不超过 `2048` 的廉价 Mesh 保留椭球对三角碰撞；中小型高模改走人物 `24 m` 邻域内最多 `128` 个世界 AABB 代理；厂区环境等可走进内部的超大高模只抽取邻域三角，原 GLB 不开启全场景 `checkCollisions`。模型阵列与其它 thin instance 继续共用同一 AABB 代理池。人物碰撞体通过 `surroundingMeshes` 只扫描邻域廉价网格、AABB 代理、局部三角代理和备用地面，避免 Babylon 默认遍历全部碰撞网格。CAD `LinesMesh` 参考层不参与实体碰撞扫描。人物默认加载 `public/manual-roam/EQ_People.glb`；该资源不含 skin/animation，运行时按材质和连通拓扑生成 GPU Morph Target，使左右手臂和双腿交替摆动，步频按实际水平速度推进（一个完整换步周期对应 `1.6 m` 位移），并优先播放未来替换资源内的 `Idle/Walk/Run/Jump` 动画片段且按同一速度缩放播放倍率。漫游、自动巡检、外部设备定位和标准视角切换使用互斥相机控制权。
- 内置 EFF 特效：特效库内置报警脉冲光圈、旋转警示灯、定位光柱、雷达扫描圈、火焰、烟雾、火花飞溅、蒸汽泄漏、气体泄漏、水流喷射、管线流动粒子、管线流动箭头、移动双箭头、货物目标定位框、输送方向箭头和疏散路线 16 种实时特效；支持点击或拖拽创建、Hierarchy 管理、Transform、显隐、锁定、复制、阵列、撤销/重做、保存重载和 Inspector 参数实时编辑。
- 模型库筛选：Project 模型库支持按模型名称和模型包 `deviceType` 组合筛选；类型选项来自当前模型资产元数据，内置对象和未声明类型的模型仅在“全部类型”下显示。
- 模型与环境导入：普通模型与环境模型严格分库。模型库点击 `导入模型文件夹`，将有效模型包复制到项目 `Assets/Models`；扫描支持目录本身为单模型包或包含多个一级模型包，并读取 `meta.json`、单位、缩略图和脚本；默认登记 `*.model.ts`，同时登记 `parameterScripts` / `animationScripts` 在 meta 中显式引用的其它 `.ts`（排除 `.d.ts`）。普通模型单位只接受 `meta.json.lengthUnit`：显式合法值按标准系数换算，缺失或空值按 `meter / 1`，显式非法值拒绝导入；参数脚本和几何包围盒都不参与源单位推断。环境库点击 `导入环境 GLB`，单文件保存到 `Assets/Environments/<安全化文件 stem>/<原文件名>.glb`，同名重导采用暂存、备份和失败回滚。打开场景后环境底座与设备模型并行加载；厂区等高模可用 `npm run optimize:environment-glb` 把 PNG 转成 KTX2 后再导入。发布 Viewer 不再阻塞等待环境，设备场景就绪后环境继续后台显现。普通模型、模型生成器输出和环境模型都保留 `lengthUnit + unitScaleToMeters`，运行时只在各自内容根节点应用一次源单位到米的基准缩放；直接导入环境 GLB 默认登记为 `meter / 1`，若源文件实际使用 centimeter / millimeter，可在环境 Inspector 修改“源单位”，运行时会事务式重载并重新居中落地，同包重导继续保留该场景级单位修正。 从其他电脑打开场景后，重新导入同名模型包会按唯一的“包目录名 + 主模型文件名”自动替换旧电脑的绝对资源路径并刷新已有实例。
- 天空盒导入与球体实体：天空盒库点击 `导入 HDR/EXR`，把通过扩展名、普通文件、512 MiB 上限、文件头和 RGBE/RLE 完整性校验的资源复制到项目 `Assets/Skyboxes/<安全化文件名>/<原文件名>`。同名资源通过暂存、备份、原子替换和失败回滚更新，不同扩展名可共存；场景只在新纹理加载成功后切换，失败时保留旧效果。天空盒以基础直径 `10000 m` 的双面大球体进入 Hierarchy，默认球心位于 `Y=0` 网格平面，使上、下半球分别处于网格两侧；尺寸倍率限制为 `0.1–1.0`，对应实际直径 `1000–10000 m`，Inspector 使用单一“尺寸倍率”并保持 XYZ 等比缩放，旧非等比数据按三轴最大绝对值迁移。天空盒存在时场景可视距离最低为 `12000 m`，旧场景自动提升；按 F 聚焦时临时使用 `20000 m` 完整取景。相机位于球体内部时背景点击忽略天空盒，位于球体外部时球面可拾取；球体仍支持显隐、锁定，并使用标准 Transform/Gizmo 自行设置位置和 Y 轴水平旋转；HDR/EXR 同时继续作为 PBR 环境照明/反射。Inspector 和场景属性可设置环境强度 `0-5` 与 `256/512/1024` 立方体分辨率。正常编辑流程只维护一个天空盒实体，禁止复制、随文件夹复制和阵列；重新点击天空盒库卡片会更新并恢复显示。旧 `sceneSettings.skybox` 会在加载时自动迁移为球形实体，缺少该字段时保持关闭；跨电脑打开工程时按“包目录名 + 文件名”重关联。数据中台工程包可选迁移 `Assets/Skyboxes`，旧包缺少该目录仍兼容。
- 导入模型资产编号：每个导入模型实例都会生成并保存 `modelAsset.assetCode`，Inspector 的 `Model Asset` 区域可编辑该编号；复制、粘贴会按新实体 ID 重新生成编号。所有阵列副本名称统一按源对象名称递增：末尾有数字时递增并保留前导零，例如 `测试 1001 → 测试 1002`、`DEV009 → DEV010`；只有字符串时直接追加 `1、2、3…`，不添加“副本”。导入模型阵列会创建与阵列数量一致的独立 Scene Entity，并通过 `components.modelArrayInstance.sourceEntityId` 关联共享渲染源；Hierarchy 中可逐个选择、移动、旋转、缩放、显隐、锁定和删除。Babylon 运行时不会逐实体加载或克隆模型，而是按参数组合运行脚本：相同 `parameterValues` 共享一个源或隐藏脚本宿主，不同参数组合分别执行参数化脚本；所有阵列实体仍按该组合的可渲染 Mesh 创建固定数量批次 Mesh，一次提交连续 `Float32Array` thinInstance 矩阵，并通过 `thinInstanceIndex` 映射回具体逻辑实体。旧版 `components.modelArray.items` 场景加载时会自动迁移为独立实体。虚拟定位线框仍把编号写入 `locator.assetId`，内置 Mesh、CAD 和特效继续沿用实体复制语义。场景文件当前使用 `version: 3`，加载器继续兼容 version 1/2，新增天空盒字段为可选字段。
- MQTT 配置入口：Toolbar 提供 MQTT 配置按钮，可在弹窗中填写 MQTT IP/域名、MQTT over WebSocket 地址、topic 与本地模拟参数；只填写 IP 时会自动生成 `ws://<IP>:8083/mqtt`。保存或启用配置只保存场景配置，不会自动连接 broker，也不会自动启动本地模拟。
- MQTT 运行预览：Toolbar 的“运行/停止”是唯一运行入口；点击“运行”并通过预检后才会连接 broker 或启动本地模拟，连接状态 badge 显示 disabled/simulating/connecting/connected/disconnected/error，无效配置会自动打开 MQTT 配置弹窗。运行态允许相机、选择、Hierarchy 搜索/展开、网格、诊断、Console 与场景全屏，只读阻止 Gizmo、Inspector 修改、Hierarchy 变更、资源创建/导入、保存加载、undo/redo 与 MQTT 配置。
- 场景全屏：Toolbar 在运行/停止旁提供全屏按钮，编辑态和运行预览均可使用；点击后隐藏 Hierarchy、Inspector、Project 与 Console，Scene 画布铺满剩余窗口，并请求系统全屏（浏览器拒绝时退化为窗口内最大化）。再次点击或 `Esc`（无弹窗时）退出，`F11` 也会切换场景全屏；桌面端若系统菜单同时占用 `F11`，以 Toolbar 按钮为准。返回首页前会先退出全屏。发布后的独立 Web Viewer / 数字孪生 Viewer 右上角同样提供全屏按钮，画布随尺寸重算。
- MQTT 专用设备数据驱动：详见 `docs/mqtt-data-driven-guide.md`，覆盖只读可视化边界、EPV `data[].e/p/v`、JSON Path、多订阅/QoS、`sourceId + deviceType + assetCode` 绑定、按设备类型（stacker/conveyor）分发的专用驱动与模型包 `dataDriven` 声明，以及 stale/fault/conflict 和 Electron `wss://` 安全注意事项。
- 外置参数化脚本：模型包内的 `*.model.ts`、meta 显式引用的 `.ts`，以及数据中台 API 明确返回的 `.ts` 会随模型包复制到项目目录并作为受控 `editor-asset://` 资产授权；导入模型加载完成后，renderer 会以本地可信脚本方式转译并运行同包脚本，兼容 `ParametricModelRuntimeComponent`、`export default class`、`onStart/onUpdate/onStop` 生命周期以及 `babylonjs-editor-tools` 的 `visibleAs*` 装饰器写法。所有长度类参数统一以米输入；脚本在实体根米空间读取未销毁、自身启用、可见且有顶点的有效 Mesh，把米制位移转换回目标父节点局部坐标，并在整机根缩放时保持底部中心锚点。参数脚本只负责模型特有参数化和附加运行逻辑，不负责判断源单位或提供基础米制测量。
- 参数化模型：模型包 `meta.json.modelParameters` 可声明 number、string、color、boolean、enum、vector3、texture 参数，以及绑定到模型节点、网格或材质的安全 JSON DSL；选中带参数配置的导入模型后，Inspector 会以紧凑布局显示“模型参数”区域，参数标签使用自适应宽度并在必要时换行，确保长中文名称完整显示；修改参数会通过场景文档实时驱动 Babylon 模型外观变化，并支持随场景保存/加载与撤销/重做。参数变化完成后，编辑器会重新测量实际尺寸；没有参数脚本的模型仍正常显示米制尺寸。
- 模型库拖拽放置：模型库中已导入的真实模型卡片可直接拖拽到 Scene View，释放鼠标时会按当前鼠标射线与 `y = 0` 地面平面的交点创建模型实体；点击模型卡片仍保留原点快捷导入行为。
- Assets 目录能力：模型库已接入本地模型文件夹扫描和 glTF/GLB 导入，环境库已接入单 GLB 导入，天空盒库已接入 HDR/EXR 导入；三类资源分别保存到 `Assets/Models`、`Assets/Environments` 和 `Assets/Skyboxes`。其它资源类型的真实分类、搜索、扫描与导入会在后续资源库功能中继续补齐。

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
2. 点击 Project 面板中的模型文件夹导入，选择 `F:\3d-models\models`；模型包会复制到当前项目 `Assets/Models`，同目录 `*.model.ts` 以及 meta 显式引用的其它 `.ts` 会随包登记为外置参数化脚本。
3. 在 Project 模型库中点击任意导入模型，选中场景实例后在 Inspector 的“模型参数”区域调整数值、字符串、颜色、布尔、枚举或贴图参数；参数会同时写入 `modelAsset.parameterValues`、运行节点 `metadata.scripts[].values` 和脚本实例属性。
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

`modelAsset.assetCode` 是导入模型的场景实例级资产编号，用于后续动画数据按模型实例识别。模型包扫描会从已登记的同包 TypeScript 模型脚本中只读提取 `dataDriven.device.defaultAssetCode` 默认前缀；导入实例时会生成 `默认前缀-实体短ID`，例如 `YZJ01-A1B2C3D4`。如果脚本未声明默认前缀，则使用 `MODEL-实体短ID` 兜底。

`defaultAssetCode` 只作为模型库导入时的编号前缀，不是完整实例编号；同类模型多次导入或复制粘贴时，会用新实体 ID 重新生成 `assetCode`，避免不同实例共享同一个动画识别编号。旧场景文件缺少 `modelAsset.assetCode` 时，加载阶段会自动补齐编号。

模型阵列副本名称始终根据源对象名称生成，与资产编号规则相互独立：名称末尾有数字时按副本序号递增并保留位宽，例如 `测试 1001` 依次生成 `测试 1002`、`测试 1003`；只有字符串时依次追加 `1`、`2`，不会添加“副本”。阵列弹窗支持为本次阵列填写一次性资产编号规则，规则只写入本次阵列结果，原对象不变。导入模型的每个阵列结果都是具有稳定 ID、名称、资产编号和完整 Transform 的独立 Scene Entity，`components.modelArrayInstance.sourceEntityId` 只负责声明其共享几何源；Hierarchy、保存/加载和撤销/重做均按真实实体处理。SceneRuntime 默认只使用源模型；当阵列实体的 `parameterValues` 不同时，每个不同参数组合创建一个隐藏脚本宿主并完整执行参数化脚本，相同组合共享宿主，连续调参会复用已有宿主，不会按实体数量创建加载任务和完整节点树。宿主本身不显示，全部阵列实体仍按参数组合通过固定批次 Mesh 和单次 `thinInstanceSetBuffer("matrix", ...)` 或原缓冲更新提交矩阵。单个阵列实体移动、显隐、锁定、删除、拾取和选择描边只影响对应矩阵；删除源模型时会提升第一个未删除实例为新源并重绑其余实例。旧版 `components.modelArray.items[]` 会在反序列化时迁移为相同数量的独立实体。虚拟定位线框仍写入 `locator.assetId`，内置 Mesh、CAD 和 POI 等无编号对象不新增字段并继续创建普通实体副本。规则中的 `${1}-1-1` 会按副本序号生成 `2-1-1`、`3-1-1`，`${001}` 会生成 `002`、`003` 并保留前导零；规则为空时，若原编号末尾有数字则递增末尾数字，否则追加序号。多选多个带编号对象时禁用自定义规则，但每个对象仍按自己的原编号默认递增。场景内已有实体和旧版矩阵项都会参与名称/编号冲突校验；场景文件当前使用 `version: 3`，并继续兼容 version 1/2。

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

场景文件当前使用 `version: 5`，并继续兼容 version 1/2/3/4。`components.modelGenerator` 只保存生成器配置和导入模型安全快照，不保存派生 Mesh、模型容器、脚本实例、自动货物或线框标记；新建场景只允许一个有效生成器，重复点击/拖入会选中已有生成器，复制、粘贴和模型阵列会拦截生成器副本。旧场景若已有多个生成器，运行时按 `scene.entityIds` 中第一个生效。重新导入模型包后，共享生成模板和规则目标会刷新 `assetRevision`、脚本元数据与默认参数。单个生成器最多保存 `64` 条规则和 `32` 条绑定；首版不支持范围比较、正则、表达式、嵌套字段路径或多个条件模型缓存。

## 特效库内置 EFF 特效

在 Project 面板切换到 `特效库` 后，可点击任一 EFF 卡片在世界原点创建，也可把卡片拖入 Scene View，按鼠标与 `y = 0` 地面平面的交点创建特效实体。EFF 实体进入 Hierarchy，并像普通场景对象一样支持选中、Gizmo、显隐、锁定、分组、复制、粘贴、阵列、删除、撤销/重做和场景保存重载。

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

如果启用“本地模拟”，运行时不会连接 MQTT broker，而是把模拟 payload 通过与真实 MQTT 相同的 EPV 解析入口写入内存遥测通道。Stacker 场景支持 `cycle`、`target`、`movement`、`fault`：`cycle` 会在目标位追踪和全 0 movement 模式之间切换，`target` 只追目标位，`movement` 固定发送 `to_x=0,to_y=0,to_z=0`，`fault` 发送急停/故障状态。

topic 路径固定为 `dt/factory/logistics/<设备类型>/<资产编号>/twindatadriven/joint`。第一个通配段表示设备类型，例如 `stacker` 或 `conveyor`；第二个通配段表示资产编号，例如 `DDJ2` 或 `1001`。运行时只把资产编号与场景中导入模型实例的 `modelAsset.assetCode` 匹配，匹配成功后才驱动对应模型。

payload 使用 `data[]` 数组承载 PLC 点位，每一项按 `e/p/v` 三个字段解释：

| 字段 | 用途 |
| --- | --- |
| `data[].e` | 点位所属设备资产编号，通常与 topic 中的资产编号一致；现场数据不一致时优先排查 PLC 映射。 |
| `data[].p` | 点位名称，例如 `movement_x`、`containerCode`、`normal`。 |
| `data[].v` | 点位当前值，运行时按设备语义转换为数字、布尔或字符串。 |

运行时会以 topic 中的资产编号为准过滤点位：`data[].e` 为空时按兼容数据接收，`data[].e` 非空且与 topic 资产编号不一致时，该点位会被忽略，避免混合 payload 污染当前设备状态。

实时 MQTT 数据只保存在运行时内存中，不写入 `SceneDocument`，也不进入 undo history。

MQTT 数据驱动的完整接入说明见 `docs/mqtt-data-driven-guide.md`。该指南补充说明 JSON Path 适配器、多订阅与 QoS、`sourceId + deviceType + assetCode` 三元绑定、专用驱动（stacker/conveyor）的模型包 `dataDriven` 声明、Inspector `telemetryBinding` 基础字段、stale/fault/conflict 处理、新增设备类型的接入步骤，以及 Electron `wss://` 连接安全边界。

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

DDJ2 运动编码按第一版运行时规则解释：`movement_x = 0/1/2` 分别表示静止、前进、后退；`movement_y = 0/1/2` 分别表示原位、上升、下降；`front_movement_z/back_movement_z = 1/3` 表示伸出、`2/4` 表示收回——伸出方向由当前货格几何决定（朝目标货格一侧伸），不再区分 1/3 的左右编码；无货格可解析时回退 1 右伸、3 左伸的旧语义。`rpm_*` 为正值时换算为速度参考，否则使用模型默认速度；`normal = false`、`errorCode != 0`、`front_command = 8` 或 `back_command = 8` 会进入故障/急停状态，暂停目标追踪和连续运动。

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

`npm run demo:stacker:mqtt` 默认运行库位驱动全演示（按库位任务自动发布 MQTT，用法见 `docs/stacker-mqtt-full-demo.md`）；旧的单设备模拟器保留为 `demo:stacker:mqtt:legacy`。

打印一条模拟消息，不连接 broker：

```bash
npm run demo:stacker:mqtt:legacy -- --once --stdout
```

连接本地 MQTT over WebSocket broker 并持续发布 `DDJ2` 数据：

```bash
npm run demo:stacker:mqtt:legacy
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

执行全部 16 个模型包的直接展示、参数修改、阵列、阵列后调参和恢复结构验收：

```bash
npm run smoke:model-array-packages
```

执行同一批 16 个模型的真实 WebGL 截图与像素对比，并生成逐包 JSON 和联系表：

```bash
npm run smoke:model-array-visual
```

执行完整构建检查：

```bash
npm run build
```

## 基础操作

- 首页进入编辑：启动后在首页点击 `新建场景` 可重置为空白场景并进入编辑器；点击 `打开场景文件` 可选择 `.scene.json`；点击 `打开项目目录` 可进入编辑器并让 Project 面板加载本地项目资源；点击最近场景会直接加载对应场景。左侧数据中台项目卡片提供 `打开`：有可用工程包时下载并加载清单指定的入口场景，没有工程包或属于旧格式时创建当前格式本地项目并进入空白场景。
- 数据中台配置：点击首页顶部 `数据中台配置`，填写 HTTP/HTTPS `API 服务地址`后选择 `保存并刷新`。本地联调时可使用 `http://127.0.0.1:8086`。前端端口和大屏页面地址不再作为编辑器配置项；新保存配置时相关页面地址由主进程按 API 地址自动推导，历史配置保留兼容。配置持久化到 Electron `userData/data-platform-config.json`，主进程通过 API 地址请求 `<API 服务地址>/api/v1/projects/query`。API 地址留空保存可清除整项配置。首页常驻的“数据中台工作区”栏显示当前实际目录，可选择 `修改` 或 `恢复默认`；目录选择和读写校验全部由主进程完成，renderer 不能直接提交任意路径。左侧项目列表顶部可输入项目名称后按 Enter 或点击 `搜索`，搜索词通过请求体 `projectName` 字段交给数据中台筛选，点击 `清除` 会恢复默认列表。renderer 打开项目时只提交列表中的 `projectId`，工程包地址由主进程最近一次可信列表缓存解析；项目、Editor 工程和模型等业务主键始终按十进制字符串传递，避免 19 位 ID 被 JavaScript `number` 截断。
- 数据中台工程包：当前数字孪生 SOURCE ZIP 保留 `Scenes/` 下的多场景、`.babylon-editor/digital-twin-source-manifest.json` 以及场景实际引用的模型、环境、天空盒和 CAD 资源；打开远端工程时兼容 ZIP 根目录和单层包装目录。数据中台环境在打包前会按稳定身份重关联到当前共享缓存，仅将 Sidecar 校验过的 `model.glb` 复制为 `Assets/Environments/Env-<resourceId>/model.glb`，场景中的本机绝对路径同步改写为本地便携路径，同时保留并更新 `sourceKey + resourceId + revision` 稳定身份。`Env-<resourceId>` 属于受管便携命名，即使身份字段被删除，再次发布仍必须重新匹配当前 Sidecar；缺失或无法唯一匹配会明确失败。无稳定身份的旧场景仅在缓存路径或受管便携路径可唯一确定资源 ID 时兼容迁移并补全身份。旧 `project.bjseditor` 不自动迁移，统一按无可用当前工程包处理。主进程限制 ZIP 压缩体积、文件数、单文件及总展开大小，并拒绝 Zip Slip、绝对路径、盘符路径、加密条目、符号链接与 Junction。
- 数据中台资源同步：打开数据中台项目、加载本地 `.scene.json` 场景或进入空白工作区后，若已配置数据中台地址，会在共享工作区后台同步资源且不阻塞场景打开；未配置地址时本地场景仍正常打开并跳过同步。普通模型和组合模型继续通过 `POST /api/v1/models/query`、`POST /api/v1/combo-models/query` 写入 `Assets/Models`，并使用 `.babylon-editor/data-platform-model-index.json` 保存数据中台来源、远端稳定指纹和本地内容 revision。接口提供可靠版本字段时，内容未变化的模型包不会重复下载；旧接口缺少版本字段时仍会下载校验，但模型、去除缩略图字段后的 `meta.json` 和有序运行脚本内容相同就保持原 `assetRevision`。同步只原子推广变化或缺失的普通/组合模型包，并与 `.babylon-editor/asset-index.json`、Sidecar 一起失败回滚；仅名称等展示元数据变化时只刷新 Project 资源库，只有 `runtimeRevision` 变化的资源键才重新关联 Babylon 模型，因此不会因同步批次 ID 变化重复加载或重新合批。环境模型已从普通模型同步解耦，通过 `POST /api/v1/env-models/sync-manifest/query` 获取稳定清单，并缓存到 `.babylon-editor/data-platform-cache/environments/<sourceKey>/<resourceId>/<fileRevision>/model.glb`，索引保存在 `.babylon-editor/data-platform-environment-index.json`。环境场景配置会持久化 `sourceKey + resourceId + revision` 稳定身份；跨机器或切换工作区打开旧场景时，编辑器会先完成当前项目资产的首次重关联，再把受管缓存 URL 交给 Babylon，避免加载旧电脑的绝对路径。精确身份失配时仅允许唯一的 `resourceId + revision` 跨 `sourceKey` 匹配，无稳定身份的旧场景仅允许从受管缓存路径提取唯一 `resourceId` 匹配。同步失败保留旧缓存，成功后只热刷新 Babylon 运行态并保留摆放、显隐、透明度、源单位和活动变体，不修改场景文档、不产生 dirty；后续主动修改环境单位、变体或配置时会把当前缓存引用正式写回场景。远端已删除资源暂不物理清理旧缓存。普通模型脚本为可选资源：优先使用 `scriptFiles` 权威列表，仅在列表没有有效项时读取旧 `scriptFileName/scriptFileUrl` 兼容字段；接口提供可识别的 `*.ts` 文件名或 URL 时才下载，不要求文件名以 `.model.ts` 结尾，旧字段中以换行拼接的多脚本也会拆分处理；未提供脚本或返回非 TS 条目时直接跳过，不阻断模型同步。切换到其他数据中台地址后不会复用旧来源的同 ID 缓存；跨中台场景重关联仍只在逻辑名称唯一时执行，存在同名歧义时不会自动替换。失败提示支持关闭，也可在 Project 面板重试。
- 场景准备进度：进入编辑器后会显示全屏蒙版，以蓝色 ZENDING 品牌填充、进度条和百分数反馈本地模型关联、运行时模型加载与 Geometry 合批；后台数据中台模型同步不再作为首次打开场景的阻塞阶段。同步发现真实运行时变化后会在后台选择性刷新对应模型，合批准入、分组、Geometry 合并和 thinInstance 矩阵提交逻辑保持不变。资源关联失败会记录警告，运行时准备超过 120 秒时会解除蒙版并提示在 Console 排查，避免界面永久阻塞。
- 数据中台存储位置：未自定义时开发态使用 `app.getAppPath()`，安装态使用 Electron `userData/data-platform-workspace`（Windows 通常位于 `%APPDATA%/zending-3d-editor/data-platform-workspace`）；也可在首页改为其他可写目录。每个业务项目独立写入 `Projects/{projectId}/`，全量共享模型缓存写入同级 `SharedResources/`，冲突副本写入 `Conflicts/{projectId}/`；安装态拒绝选择 EXE 安装目录及其内部路径。切换工作区只影响后续打开和同步，不会迁移、覆盖或删除旧目录内容。
- 发布冲突与资源关系：远端最新工程版本发生变化时默认禁止发布并在工作区保留 SOURCE ZIP 冲突副本；用户可在弹窗显式确认强制覆盖，以远端最新版本为基线创建下一版本，历史版本不会删除。项目资源修订发生变化时仍禁止发布，prepare 完成后若又出现新的远端版本，commit 也仍会按任务基线拒绝覆盖。场景引用了尚未关联到目标项目的共享资源时，用户确认后只补充缺失关系，不自动解绑已有关系。发布、回滚和 Viewer 的数据中台请求按可信内网模式运行，不附加 `Authorization` 或数据中台 API Key；场景自身的 Fetch 配置会进入 SOURCE 工程包，公开 Viewer DIST 只保留请求地址并剥离 API Key。发布版 Viewer 进入运行态后会触发已启用的 Fetch 数据驱动；中台项目级“Fetch 请求地址”非空时会在每次 Viewer 启动时覆盖发布包默认地址，保存后刷新 Viewer 即生效、无需重新发布。项目运行配置通过公开 Viewer 接口下发，因此 URL 和扩展 JSON 均禁止保存密码、令牌、API Key 或凭据字段。
- 项目深链：Windows 安装包注册 `zending3d://` 协议，数据中台可使用 `zending3d://open-project?baseUrl=<HTTP(S) API服务地址>&webBaseUrl=<HTTP(S)大屏页面地址>&projectId=<字符串ID>` 打开项目；生产环境两者同源时可省略 `webBaseUrl`，本地 API `8086/18087` 且无该参数时会自动使用页面端口 `8001`。应用采用单实例处理第二次启动的深链；发布期间禁止切换项目，未保存场景切换前会再次确认。
- 创建基础对象与常用灯光：在模型库中点击或拖拽 `立方体`、`球体`、`地面`、`虚拟定位线框`、`半球光`、`方向光`、`点光源` 内置资源卡片；Box/立方体卡片明确标注默认尺寸 `1 m × 1 m × 1 m`，拖拽到 Scene View 后会按鼠标释放位置投射到地面平面，并把 Box 中心抬高 `0.5 m` 使底面落地；其它对象保持原有创建路径。
- 创建 POI 模型生成器：在 `POI库` 点击“模型生成器”可在原点创建青色配置标记，拖入 Scene View 可按地面落点放置标记；一个场景只保留一个有效生成器，重复点击/拖入会选中已有生成器。随后把模型库普通模型或内置立方体、球体、地面拖入 Inspector 的共享生成模板或规则覆盖模型槽位。
- 选择对象：点击 Hierarchy 项，或在 Scene View 中单击对象；Hierarchy 中可使用 Ctrl/Cmd 多选、Shift 连续多选。
- 整理层级：在 Hierarchy 点击 `新建` 可创建纯分组文件夹，将一个或多个普通实体拖入文件夹可完成分组；拖到 `根层级` 可移出文件夹。选中文件夹时，组内实体会在 Scene View 中一起高亮；文件夹只影响左侧列表归类，不改变模型世界坐标或 Transform 父子关系。右键菜单中的 `群组对象` 会创建新分组并把当前普通实体选区移入分组，`解组对象` 会把选中文件夹或选中对象所在文件夹释放回根层级。
- 控制对象状态：Hierarchy 实体与文件夹行前的显示按钮可隐藏/显示对象或整组对象，锁定按钮可锁定/解锁对象或整组对象；右键菜单和快捷键支持批量隐藏、批量锁定与批量删除。隐藏对象不会在 Scene View 显示或被拾取，锁定对象仍显示但不能被画布拾取、挂载 Gizmo、删除或通过 Inspector 编辑。
- 复制、粘贴与阵列：在 Hierarchy 右键菜单或快捷键中复制当前普通实体选区；粘贴到右键文件夹时进入该文件夹，粘贴到右键普通对象时进入同级，粘贴副本会生成新 ID 并保持源对象位置，直接与原对象叠加；模型生成器会被复制、粘贴和阵列入口跳过或拦截，避免产生第二个有效生成器。`模型阵列` 可按 +X/-X/+Y/-Y/+Z/-Z 方向、阵列净间距和副本数量生成线性阵列副本，净间距按单个模型或整个多选组的世界包围盒边缘计算；净间距为 `0` 时相邻包围盒边缘贴合，阵列完成后原始选区保持原位和选中状态。阵列弹窗可填写一次性资产编号规则，支持导入模型 `modelAsset.assetCode` 与虚拟定位线框 `locator.assetId`：所有源对象的副本名称都按源名称末尾数字递增，只有字符串时追加序号且不添加“副本”；导入模型和定位线框的资产编号则分别按原编号或自定义规则生成。名称或资产编号与场景已有值、同批新副本冲突时会显示具体冲突并禁止确认；多个带编号对象多选时禁用自定义规则但分别默认递增，无编号对象不新增资产编号字段。
- 聚焦对象：右键菜单 `场景聚焦` 或 F 会把最新世界包围盒中心作为 Scene View 相机 Target，保留当前水平方向并从模型斜上方 `45°` 看向中心；模型距离优先为 `2 m`，会按包围盒适配在 `2–3 m` 内，包括改大后的链条机在内，模型中心到相机的距离最大为 `3 m`。环境和天空盒等非模型目标保留当前观察方向并不使用该模型距离上限；导入模型可用 `库聚焦` 切换到底部 Project 模型库并滚动高亮对应资源卡片。
- 清空选择：在 Scene View 中单击空白区域。
- 切换 Gizmo：点击顶部工具栏的移动、旋转、缩放图标按钮，或使用 W/E/R 快捷键。点光源只允许移动，方向光允许移动和旋转；灯光请求不支持的工具时会自动切回移动。
- Shift 拖拽阵列：保持编辑模式和移动工具，单选一个未锁定的导入模型、内置 Mesh、虚拟定位线框、已解锁 CAD 参考层或特效，按住 `Shift` 后拖动 X/Y/Z 单轴箭头；文件夹和模型生成器不会触发，灯光则保持普通移动而不生成副本。拖动超过当前轴向真实投影跨度的一半后开始实时出现零间距副本，最多 100 个，源对象始终不移动。特效预览只克隆静态可见 Mesh，纯粒子效果使用半透明范围代理，不会临时创建最多 100 套粒子系统；确认后的正式特效副本仍保留完整粒子和动画。松开左键后方向固定为本次 `+X/-X/+Y/-Y/+Z/-Z（局部/世界）`，可在弹框修改新增副本数量和净间距；导入模型/定位线框还可使用对应编号规则，预览会实时更新。`Esc`、点击遮罩或“取消”不会写入场景和撤销历史。
- 切换坐标空间：点击 `局部` 或 `全局`。
- 开启吸附：勾选 `吸附`，并调整位置、旋转、缩放步长；其中位置步长单位为 `m`。
- 场景全屏：点击 Toolbar 运行/停止旁的全屏图标，或按 `F11`。Scene View 会隐藏左右栏和底部 Project/Console，3D 画布铺满窗口并进入系统全屏；编辑态和运行预览都可用，运行预览中 Toolbar 仍保留停止按钮。浏览器不允许系统全屏时改为窗口内最大化。再次点击或无弹窗时按 `Esc` 退出。发布 Viewer 使用右上角同一图标。
- 控制网格：在 Toolbar 中勾选或取消 `网格` 控制 Scene View 相机局部地面辅助网格显示，并通过 `格子` 下拉选择 `1 m`、`2 m`、`5 m`、`10 m` 四档最小格子大小；缩远后细格会平滑淡出并保留 `10×/100×` 主次层级，世界坐标对齐保持不变。
- 导入 CAD 参考图：点击 Toolbar 的 `导入CAD参考图` 选择 `.dxf` 文件；小于 `64 MB` 的普通图纸保持精确展开解析，达到 `64 MB` 的大图纸自动切换 Web Worker 轻量扫描，并将重复 BLOCK/INSERT 转为共享原型与实例矩阵。唯一原型安全上限为 100 万条折线 / 800 万个点，逻辑图元数量不受重复 INSERT 展开量限制。单位优先读取 `$INSUNITS` 0–24；unitless/缺失时参考 `$MEASUREMENT`，仍未知时按毫米兜底并在日志/Inspector 明确提示。所有坐标换算为米后按完整实例包围盒中心归零，并贴到网格层上方约 `0.01 m`。
- 切换 CAD 俯视：点击 Toolbar 的 `俯` 图标按钮，Scene View 会保留当前观察中心和缩放距离，从世界 Y 轴上方向下观察 XZ 地面；切换前的旋转、平移和缩放惯性会被清除，避免视角继续漂移。该操作不会覆盖已保存视角，也不会写入场景文件或撤销历史；运行预览中仍可使用。
- 调整视野：在 Toolbar 中通过 `视野` 下拉选择 `近景`、`标准`、`远景`、`全景`，用于快速调整 Scene View 默认相机观察距离和可视范围；也可使用鼠标滚轮靠近或远离模型，近距离缩放会保留最小观察距离，便于查看模型细节且避免画面变黑。
- 查看 Console：点击底部 Project 区域最下方的 `Console` 最小化入口可弹出日志窗口，点击关闭按钮或按 Escape 可收起弹窗。
- 编辑属性：在 Inspector 中修改名称、Transform、材质颜色或灯光属性；position 按米输入，rotation 按角度输入但内部仍使用 Babylon 弧度，通用 scale 保持无量纲。灯光字段按有效语义收敛：Point 仅 position，Directional 为 position/rotation，Hemispheric 为 direction。内置 Box 的 `size (m)` 直接对应实际边长，Sphere/Plane 显示其米制基准说明；导入模型、环境模型和 CAD 均展示源单位到米的换算信息。
- 删除实体：点击顶部工具栏 `删除`，或使用 Delete/Backspace 快捷键。
- 浏览资源库外观：底部图库区域会根据窗口高度在约 `300px` 到 `460px` 之间自适应，在 Project 面板中点击 `模型库`、`POI库`、`主题库`、`组合库`、`环境库`、`天空盒库`、`图表库`、`图片库` 页签，可切换不同资源库展示；小窗口下页签通过内部横向滚动访问，资源卡片按可用宽度自动换行，超过可见高度后通过纵向滚动访问；模型库和环境库卡片有封面图时显示模型包封面，没有封面图时显示类型占位图标；模型库点击 `导入模型文件夹` 导入普通模型并复制到项目 `Assets/Models`，环境库点击 `导入环境 GLB` 直接选择单个 `.glb`，并保存到项目 `Assets/Environments` 下的独立单文件包；两者严格分库，同名重导只覆盖当前入口对应的目标资产。天空盒库点击 `导入 HDR/EXR` 后保存到项目 `Assets/Skyboxes`，卡片显示格式和文件大小，可点击应用或拖入 Inspector；当前场景正在使用同一环境包或天空盒包时，同名重导产生的新 `assetRevision` 会自动刷新运行时资源。
- 图片库贴图拖放：图片库包含内置透明发光方向箭头和数据中台同步图片；图片库面板提供“从数据中台同步”按钮，打开项目时也会自动增量同步 `CUSTOM + ACTIVE` 且带 `iconUrl` 的图标到项目 `Assets/Images`，按 `updatedAt` 只下载变更，格式或内容校验失败的图片自动跳过，软删除图标在面板隐藏但保留本地文件与场景引用。选中带 `texture` 模型参数的导入模型后，可把图片卡片拖入 Inspector 参数区；属性保存 `editor-image://platform/<iconKey>` 稳定逻辑引用并进入撤销/重做历史，运行时统一解析为本地或发布后的真实图片 URL。
- 放置模型：模型库中已导入的真实模型卡片支持点击或拖拽；点击会把模型导入到原点，拖拽到 Scene View 后释放会按鼠标位置投射到地面平面并在对应世界坐标创建模型。
- 资源库功能边界：模型库当前支持内置基础资源创建与真实模型文件夹导入，环境库支持单 GLB 文件导入，天空盒库支持 HDR/EXR 单文件导入；同名资产再次导入会原子覆盖项目目录中对应分库资产，其余资源库仍为样式占位。本地模型导入依赖 Electron preload 暴露的文件 API，需要使用 `npm run dev:electron` 启动桌面编辑器，普通 Vite 浏览器页面不具备该能力；Electron 主窗口通过 CommonJS preload 产物 `dist-electron/preload.cjs` 注入 `window.editorApi`。

场景级属性面板：

- 在 Scene View 点击非模型位置后，右侧 Inspector 会显示场景级设置，而不是对象属性。
- 场景区支持修改场景名称、初始化空白场景和导入 CAD 参考图；初始化会清空当前实体、历史记录和场景级设置。
- 相机区支持显式保存当前视角、复位到已保存视角，以及通过连续滑杆设置 Scene View 可视距离。保存内容包含相机 `alpha / beta / radius / target`、轨道/俯视朝向和透视/正交投影；之后临时移动或切换视图不会在保存场景文件时自动覆盖，需再次点击“保存当前视角”。
- 编辑器设置区支持缩放、移动、旋转三类相机操作灵敏度，数值范围为 `1-20`，默认值为 `10`。
- 天空盒区只接收天空盒库 HDR/EXR：可点击资源卡应用，也可拖入属性区；支持清除，以及实时调整水平旋转、环境强度和立方体分辨率。天空盒配置进入撤销/重做、保存/加载和运行预览。
- 环境属性区只接收环境库模型包：可从底部环境库点击应用，也可拖入环境属性区作为不可拾取的环境底座；模型库普通模型只能拖入 Scene 创建实体。包内主模型作为默认预设，其余 `.glb/.gltf` 文件会作为自定义效果卡片切换。

虚拟定位线框最短验收：

1. 执行 `npm run dev:electron` 启动 Electron 编辑器。
2. 在 Project 面板模型库点击或拖拽 `虚拟定位线框`，Scene View 中会出现可拾取的长方体线框。
3. 选中该实体，在 Inspector 的“虚拟定位线框”区域修改 `资产编号`、`长(X)`、`宽(Z)`、`高(Y)`，线框尺寸会实时变化。
4. 点击 Toolbar 的 `保存场景` 导出 `.scene.json`，再通过 `加载场景` 打开该文件，确认资产编号和长宽高保持一致。

## 架构说明

项目按桌面壳、渲染器 UI、编辑器领域模型与运行时渲染层拆分：

- Electron 主进程：负责创建桌面窗口、管理应用生命周期，并承载需要在主进程中执行的本地能力。
- preload 安全 API：作为主进程与 renderer 之间的受控桥接层，避免 renderer 直接暴露高权限 Node.js 能力；本地模型通过 `editor-asset://` 受控协议加载，项目内模型与环境通过 `.babylon-editor/asset-index.json` v2 记录，普通模型指向 `Assets/Models`，环境模型指向 `Assets/Environments`；天空盒从独立的 `Assets/Skyboxes` 单文件包安全扫描并授权；v1 旧索引条目默认归模型库且不移动旧文件；首页最近项目、最近场景、按路径加载场景和移除最近记录也通过受控 IPC 暴露。
- React renderer：负责编辑器界面、面板布局、用户交互与状态展示，并通过入口错误边界将启动期异常转换为可见错误页。
- editor model：定义 SceneDocument、Entity、Transform、MeshRenderer、ModelAsset、Light 等编辑器核心数据结构，是保存/加载与 UI 编辑的统一数据来源。
- commands：封装可撤销编辑操作，并维护撤销/重做命令历史。
- runtime/babylon：负责将编辑器场景文档增量同步到 Babylon.js 运行时场景，包括 Mesh 创建、模型导入、灯光同步、Transform 同步与选中高亮；安全静态模型和 Shelf 通过共享源容器实例化，资产加载由固定并发调度器控制，Scene View 统一处理 WebGL 上下文与渲染循环恢复。
- panels：按编辑器区域拆分 UI，包括 Hierarchy、Scene、Inspector、Project、Console 等面板。

## 场景文件说明

当前场景文件使用 `.scene.json` 后缀，内容为 JSON 格式的 `SceneDocument`。

场景文件的核心约定：

- `version` 当前为 `3`，加载器继续兼容 version 1/2；旧场景缺少天空盒字段时默认关闭。
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
- 带外置脚本的模型实体会额外保存 `modelAsset.scriptAssets`、`parameterScriptMetadata` 与 `animationScriptMetadata`；加载场景时主进程会重新授权这些可执行 `.ts` 文件（排除 `.d.ts`），运行时把当前参数和 `assetCode` 同步到脚本实例与 Babylon 节点 metadata。
- 场景级 MQTT 配置保存在 `mqttConfig.enabled`、`mqttConfig.ip`、`mqttConfig.address`、`mqttConfig.topic`、`mqttConfig.simulatorEnabled`、`mqttConfig.simulatorAssetCode`、`mqttConfig.simulatorScenario` 和 `mqttConfig.simulatorIntervalMs` 中；旧场景缺少该字段时会自动补齐 MQTT 默认 topic 和本地模拟默认值。
- 场景级编辑设置保存在 `sceneSettings.camera`、`sceneSettings.sensitivity`、`sceneSettings.environment` 和 `sceneSettings.skybox` 中；`sceneSettings.camera` 的 `savedPose`、`savedOrientation` 与 `savedProjection` 共同组成显式保存视角。编辑器通过文件选择器、最近场景、Project 场景资产或内置示例加载后会自动恢复一次，导出 Web Viewer 也使用同一启动视角；仅切换编辑/运行预览不会强制复位。旧场景缺少朝向/投影字段时按轨道与透视兼容，完全没有保存位姿时使用默认相机。
- `sceneSettings.environment` 记录环境模型包路径、显示名称、文件大小、源单位、`unitScaleToMeters`、摆放模式、根节点 position / XYZ rotation / 统一 scale、显隐、透明度、缩略图、当前激活变体和包内变体列表。新环境默认作为唯一全局场景底座，按包围盒 X/Z 居中、Y=0 落地；旧场景缺少新字段时继续使用右边界 `X=-2m` 的 `legacy-left` 兼容摆放，并可在 Inspector 显式转换。环境不进入 Hierarchy、默认不可拾取，不启用 GLB 相机、灯光、动画或模型脚本；半透明使用关闭深度写入的幽灵显示。环境切换、变体、源单位修正、重置和重导先后台加载候选资源，成功后原子替换，失败时保留当前有效环境。
- `sceneSettings.skybox` 记录授权资源包/文件路径、`editor-asset://` URL、格式、`assetRevision`、旋转、强度和分辨率；运行时使用 Babylon HDR/EXR CubeTexture，在加载和预过滤成功后原子替换可见背景与环境反射。

## 当前限制

- glTF/GLB 导入属于 MVP 级能力：支持导入、选择、基础 Transform、参数化外观绑定、保存和加载，不承诺完整材质编辑、动画、骨骼、蒙皮或嵌套资源管理。
- 大场景共享只对明确安全的重复资产生效：普通无脚本模型可共享源几何/材质，Shelf 使用独立验证过的脚本化共享路径；自动 thinInstance 另允许 8 个已核对参数脚本按完整结构模板签名合批，并在保存、发布和部署导出快照中持久化直接源引用。未列入白名单的动态脚本继续独占容器，因此不同资产、动态脚本和高面数贴图本身仍受 GPU 能力限制；本轮不会用降分辨率、LOD 或纹理降采样换取容量。
- CAD/DXF 导入属于布局参考层能力：承诺常见二维线稿实体 `LINE`、`ARC`、`CIRCLE`、`ELLIPSE`、`SPLINE`、`LWPOLYLINE`、`POLYLINE`、`HATCH` 边界、`SOLID/TRACE/3DFACE` 外轮廓与 `LEADER`，并完整保留 BLOCK、嵌套/阵列 INSERT 的几何实例；不承诺完整 TEXT/MTEXT 字形、Paper Space、多布局、实体填充、3D Solid 曲面或可编辑 CAD 图元。普通图纸保持精确解析，`64 MB` 及以上图纸使用后台轻量扫描和实例化原型预算。DXF 合法 `$INSUNITS` 0–24 会换算为米；无单位图纸只能依据 `$MEASUREMENT` 或毫米 fallback，建议源 CAD 明确写入单位。超过 `±1e15` 的异常原始坐标会被过滤。
- 参数化模型依赖模型包中稳定的节点、网格或材质名称；安全 DSL 只支持 JSON AST 中的白名单运算和白名单属性绑定，不执行任意 JavaScript/TypeScript。贴图参数允许编辑器登记过的内置 `editor-image://` 逻辑引用，或模型包内 `.png`、`.jpg`、`.jpeg`、`.webp` 相对路径；仍不支持绝对路径、网络 URL、`data:`、反斜杠路径、未登记逻辑引用或 `../` 路径逃逸。重新导入模型包后，场景实例会使用新的 `modelParameters` 与 TypeScript 脚本元数据清洗参数：同名且仍合法的实例值会保留，新增参数使用新默认值，删除或非法参数会移除。
- Project 资源库中模型库、环境库、天空盒库、图表库和图片库已接入项目目录持久化；模型库普通模型包复制到 `Assets/Models`，环境库单个 GLB 保存到 `Assets/Environments/<安全化文件 stem>/`，天空盒 HDR/EXR 保存到 `Assets/Skyboxes/<安全化文件名>/` 独立包，数据中台同步大屏索引保存到当前绑定工程的 `.babylon-editor/data-platform-charts.json`，数据中台同步图片保存到 `Assets/Images/<iconKey>.<ext>`。新导入或从数据中台同步且未显式声明 `lengthUnit` 的环境模型默认按 `centimeter`（`×0.01 m`）解释，普通模型仍默认 `meter`，旧场景兼容语义不变。POI 库已接入模型生成器、自动巡检和图表立标，运行预览与 Viewer 已接入手动漫游控制器，特效库已接入 16 种内置 EFF；图表面板、报警管理器以及主题、组合仍为占位；图片库已接入内置方向箭头、数据中台同步图片和 texture 参数拖放，支持按名称、图标 Key 与分类搜索。
- 首页数据中台配置、远程项目列表、项目打开和最近场景都依赖 Electron preload IPC；普通 Vite 浏览器页面会显示降级提示，并仅保留进入空白编辑器、新建场景等不依赖桌面权限的基础入口。当前不包含身份令牌配置或数据中台项目详情交互。
- 主布局自适应当前只包含随窗口尺寸自动调整、左右面板贯通到底部、Project/Console 限定为中间 Scene 同宽以及底部 Console 弹窗入口，不包含拖拽分隔条、其它面板折叠或用户自定义布局保存；小于约 `1024×640` 的窗口会继续尽量收缩，但不保证所有内容舒适可读。
- 图片库当前登记内置方向箭头和数据中台同步图片；用户手动导入本地图片、更多图片类型与分类管理仍待扩展。
- 灯光编辑支持类型、强度、点光源位置和方向光位置/朝向；半球光继续使用方向向量。暂未提供颜色、范围、衰减等灯光高级参数。场景级阴影可在未选中对象时的 Inspector 场景属性中调节。
- 当前 Hierarchy 文件夹用于场景对象组织分组并支持任意层级嵌套；文件夹显隐和锁定会作用到组内对象。单选文件夹或任意多选可用世界坐标移动递归展开并去重后的普通成员，或绕完整世界包围盒中心旋转全部成员并保持各自缩放；Inspector 按“位置 / 旋转 / 缩放”三行展示群组空间信息：位置可按世界包围盒中心绝对坐标修改，旋转可按角度修改并绕群组中心应用，缩放当前显示为 1 且禁用。文件夹仍不保存 Transform，也不提供持续的父子 Transform 继承或整组缩放。

## 最近完成

- 2026-09-02：Toolbar 新增场景全屏按钮（运行/停止旁），`F11` 同步切换；全屏时隐藏 Hierarchy/Inspector/Project/Console，Scene 画布铺满窗口并请求系统全屏，失败时退化为窗口内最大化。运行预览可继续停止场景；发布 Viewer 右上角提供相同入口。`Esc` 或再次点击退出，返回首页前会先退出全屏。
- 2026-09-01：数字孪生 Project 图表库接入已绑定数据中台项目的大屏配置，只自动分页同步完整大屏卡片，不解析大屏内部图表；未绑定项目不发起请求且清空跨项目展示，网络失败时保留旧项目索引并提供重试入口。
- 2026-08-28：数据中台普通/组合模型改为 Sidecar 增量同步，打开场景先关联本地缓存且不等待后台下载；内容未变化时保持稳定 `assetRevision`，只对真实运行时变化的模型执行选择性刷新，避免重复加载和重新合批。
- 2026-08-28：发布后的数字孪生 Viewer 默认隐藏自动巡检与手动漫游浮窗；两者只能由大屏组件对应按钮发送的 `startAutoPatrol` / `startManualRoam` 命令打开，并保持互斥显示。鼠标左右键组合仅切换运行状态层，状态层继续每秒刷新 Babylon FPS；普通独立 Web 部署和编辑器运行预览保持原有显示行为。
- 2026-08-28：自动巡检取消场景障碍与地面可达性检测，编辑录点、运行预览和发布 Viewer 均允许路线直接穿过模型。
- 2026-08-27：加快打开场景后的环境模型加载：环境 GLB 不再挤占设备模型 4 路并发，会话内同源环境只解析一次；`editor-asset://` 对 GLB/贴图启用 ETag 协商缓存；视口创建时预热 Draco WASM；发布 Viewer 设备场景可先就绪，环境后台显现。可用 `npm run optimize:environment-glb` 把厂区 PNG 转成 KTX2。
- 2026-08-27：场景未摆放手动漫游 POI 时，运行预览和发布 Viewer 不再显示漫游面板，也不对外暴露 `startManualRoam`；只有摆放出生点后才开放人物漫游。
- 2026-08-27：手动漫游碰撞改为邻域分层：廉价网格保留三角碰撞，中小型高模走 AABB 代理，厂区环境等高模只抽取人物附近三角；人物 `surroundingMeshes` 不再扫描全场景碰撞网格，避免加入物理碰撞后 FPS 腰斩。
- 2026-08-27：修复手动漫游人物走动姿势与位移不同步：程序化步态相位按实际水平速度推进，一个完整左右换步对应 `1.6 m`；摇杆半幅、行走灵敏度与奔跑都会同步降低或提高步频。内置走/跑动画片段同样按当前速度缩放播放倍率，避免滑步或原地碎步。
- 2026-08-26：修复跨机器打开数字孪生场景时环境模型仍加载旧工作区绝对路径的问题：受管缓存环境会在 Babylon 首次加载前按稳定资源身份重关联到当前共享缓存，保留场景显示设置且不产生无意义 dirty；SOURCE 发布同时把环境缓存复制为便携资源并改写场景引用，避免发布包携带本机路径。
- 2026-08-25：运行预览和发布 Viewer 新增完整手动漫游闭环：人物 GLB 后跟随、第一/第三人称、键鼠/触摸/手柄、Pointer Lock、地面/飞行、重力跳跃、坡度和台阶、平滑复位、灵敏度调节、碰撞调试及与巡检/外部定位的相机互斥。普通廉价 Mesh 保留三角碰撞，阵列、thin instance 与中小型高模使用人物邻域 AABB 代理，超大环境高模改为邻域局部三角；默认人物无 skin/animation，运行时使用 GPU Morph Target 生成可见的四肢交替步态。
- 2026-08-21：发布 Viewer 的 `focusAsset` 在模型资产编号未命中后，继续按「排-列-层」定位虚拟货格单格；相机关注该格世界包围盒，并在 3 秒内高亮单格而非整面货架。内置货格默认仍隐藏，搜索命中后才露出线框。协议 payload 与 capabilities 保持 v1 不变。
- 2026-08-21：修复发布 Viewer 未按编辑器鼠标灵敏度运行：场景 `sceneSettings.sensitivity` 随发布包保存并在 Viewer 启动时应用；画布 `ResizeObserver` 在 iframe/全屏尺寸变化后重新计算平移幅度，避免默认小画布把中键拖拽放大。
- 2026-08-26：默认阴影改为不影响帧率的缓存地面方案：性能/均衡档只渲染一次阴影贴图，设备模型只投射、环境底座和阴影地面接收；高质量档才启用全场实时级联阴影。Inspector 质量选项与说明已同步。
- 2026-08-21：修复场景阴影优化后模型影子不可见：设备影子画在环境地面和阴影接收面上，而不是只埋在专用地面下。Inspector 仍可调节开关、质量、浓度、阴影地面、自动太阳方位/高度/强度、覆盖距离、bias/normalBias、补光强度和环境光上限，设置随场景文件保存，发布 Viewer 同步生效。
- 2026-08-13：修复链条机点击空洞区域也会被选中的问题；链条机仅按真实可见几何拾取，点击整体包围盒内但无几何的空隙不再误选，Shelf、多穿货架及其它模型原有包围盒补充拾取保持不变。
- 2026-08-12：MQTT 配置弹窗新增“测试连接”；测试直接使用未保存草稿建立与正式运行隔离的临时连接，只有 Broker 会话和全部有效订阅 Topic 均收到成功 SUBACK 后才显示成功。测试成功、失败、超时、连接字段变化或关闭弹窗时都会清理临时连接，不保存配置、不启动运行预览，也不写入正式 MQTT 状态或设备遥测。
- 2026-08-10：Hierarchy 单选文件夹或任意多选群组时，右侧 Inspector 新增可编辑空间信息：位置字段以世界包围盒中心为绝对坐标，修改后整体平移；旋转字段以首个参与对象为参考角度，修改后全部成员绕群组中心旋转，并继续形成单条撤销记录。缩放行按现有约束显示为 1 且禁用；异步几何、空群组和锁定群组保留明确状态提示，不改变场景 JSON 或文件夹 Transform 语义。
- 2026-08-05：Project 资源库新增“特效库”页签并放置在 POI 库之后，原 POI 库中的 16 种内置 EFF 全部迁入特效库；POI 库仅保留自动巡检、模型生成器、图表立标、图表面板、报警管理器和手动漫游。特效卡片、底层 `poiEffect` 场景协议及运行行为保持兼容，Inspector 用户可见术语同步改为“特效”。
- 2026-08-05：Scene View 新增与 Hierarchy 同步的 `Ctrl/Cmd + 左键`多选：短点击实体可追加或移除，Ctrl 拖拽继续平移相机，空白 Ctrl 点击保留选区；任意多选和文件夹混合选区会递归展开并在完整世界包围盒中心显示世界坐标组合 Gizmo，支持原子移动、旋转和单条撤销记录，不支持组合缩放。任一锁定成员会阻止整组，异步几何全部就绪前隐藏 Gizmo，恢复单选后还原原工具与坐标空间。
- 2026-08-05：POI 库新增“自动巡检”：支持多路线、F1 当前相机视角录制/覆盖、编号节点与路径辅助、节点排序和受限 Gizmo、平滑/直线路径、单次/循环/往返播放、移动/停留时间、手动相机接管暂停、返回巡检前视角、运行预览/Viewer 悬浮控制器以及全场唯一自动启动路线；节点使用路线局部坐标持久化，路线整体移动/旋转后仍保持相对取景。后续已补齐路线校验、事件触发与响应、巡检记录、断网补报、历史回放和自动视角切换。
- 2026-08-05：Scene View 为 Point/Directional 灯光新增编辑器专用球形/方向箭头标记，可直接点击选择并使用类型受限的 Transform Gizmo；Point 支持移动，Directional 支持移动和旋转，灯光继续排除 Shift 阵列。标记维持近似固定屏幕尺寸、接受正常遮挡，只在编辑态显示且不参与阴影；Inspector 同步隐藏无效字段并将 Hemispheric 的方向向量标为 direction。场景版本和序列化格式保持不变。
- 2026-08-04：Scene View 新增视口定向罗盘：SVG ViewCube 实时显示世界三轴，六面/正负轴端点支持约 200 ms 标准视角切换和硬锁，同面再次点击退出；正交投影、二维 WASD 平移、Home 复位、显式视角保存、运行预览和小视口缩放已接入，发布 Viewer 从保存方向启动但保持自由旋转。

- 2026-08-04：环境模型原单位默认改为 `centimeter`：本地单 GLB 导入、数据中台缺失单位元数据的环境资源以及渲染端缺省兜底统一使用 `0.01 m` 换算；普通模型默认 `meter` 和旧场景米制兼容保持不变。
- 2026-08-04：Hierarchy 文件夹群组在既有世界坐标移动基础上新增绕当前世界包围盒中心旋转：全部成员的位置与自身旋转同步变化、缩放保持不变，普通节点与 thinInstance 均支持可取消预览；隐藏或尚未加载成员仍写回最终 Transform，整组提交只形成一条撤销/重做记录。文件夹群组继续强制世界坐标且不支持缩放，不新增文件夹 Transform，也不改变场景版本或序列化格式。
- 2026-08-04：修正 Project 资源库分类：HDR/EXR 以及 `kind: skybox` 的天空盒资源只展示在“天空盒库” Tab，不再重复混入模型库；模型库空状态也仅按普通模型资产判断。
- 2026-08-04：补齐数字孪生场景阴影链路：方向光和点光源自动创建阴影生成器，现有及异步加载的基础 Mesh、导入模型、模型生成器输出和环境模型统一参与投射/接收阴影；编辑器地面辅助网格、CAD 线稿和天空盒继续排除，灯光删除或类型切换时同步释放阴影贴图。
- 2026-08-04：发布后的数字孪生 Viewer 在场景就绪后默认隐藏运行状态层；同时按下鼠标左键和右键可在一次完整组合按压中切换一次显示/隐藏，且不改变右键旋转、左键选择等既有相机操作。加载、启动阻断、WebGL/环境运行异常和 MQTT 错误仍会自动展示。
- 2026-08-04：统一数字孪生相机运动幅度并保留原有键位：右键旋转、中键移动、Ctrl+左键平移、左键短点击选择、滚轮缩放；默认旋转统一为 `0.3°/px`，平移按取景高度保持约 `1:1` 屏幕像素幅度，滚轮每档缩放当前距离的 `5%`，灵敏度仅作为倍率。模型表面上的相机操作继续穿透拾取层，近距保护保持不变。详见 `docs/digital-twin-camera-control-standard.md`。
- 2026-08-03：修复发布后的独立 Web Viewer 可静默回退软件 WebGL、拖动时出现低帧率和类似撕裂观感的问题：Viewer 现在显式要求硬件加速，共享 Babylon Engine 恢复 `requireHardwareAcceleration` 的严格语义，使用 `high-performance`、`failIfMajorPerformanceCaveat=true`、`desynchronized=false`，并校验实际 renderer；SwiftShader、WARP、llvmpipe 等软件实现会直接阻断并展示浏览器硬件加速排查提示。新增 `npm run smoke:viewer:gpu` 固化发布 Viewer 的 GPU 与帧同步契约。
- 2026-07-31：天空盒基础直径扩大到 `10000 m`，尺寸倍率统一为 `0.1–1.0` 等比缩放并显示实际直径；含天空盒场景最低可视距离自动迁移为 `12000 m`，按 F 聚焦临时提升到 `20000 m`。相机在球体内部时背景点击不再误选天空盒，从外部查看时仍可点击球面；编辑器与导出 Viewer 保持一致。
- 2026-07-31：场景“保存当前视角”扩展为完整启动视角，显式记录相机位姿、轨道/俯视朝向与透视/正交投影；所有编辑器场景加载入口和导出 Web Viewer 会自动恢复，复位按钮恢复同一完整状态，旧场景兼容回退到轨道透视。场景文件保存仍只写入最后一次显式确认的视角，不会被后续临时观察角度覆盖；新增序列化兼容测试和 `npm run smoke:camera-view`。
- 2026-07-30：重构 Scene View 地面辅助网格：移除两个 `80,000 m` Ground、第二套 Shader、GlowLayer 和逐帧呼吸更新，改为单 Mesh、单 Shader 的相机局部有限网格；承载平面按主格吸附观察中心，Shader 使用有界世界原点余数保持米制坐标稳定，并提供细格/主格/粗格像素自适应、远端渐隐、正常深度遮挡和无深度写入。新增 `smoke:grid` 验证单 Draw 资源契约、事件驱动更新、正交覆盖、吸附稳定与资源释放。
- 2026-07-30：将项目天空盒升级为可见球体实体：两个 HDR/EXR 资源同时展示在模型库和天空盒库，点击或拖入 Scene 后进入 Hierarchy，并支持标准 Transform/Gizmo 移动、旋转、缩放、显隐和锁定；保留环境照明、旧场景迁移、独立 Viewer 导出以及加载失败保留旧效果。
- 2026-07-29：修复大场景修改模型参数时的实时卡顿：参数值变化不再重算/复制 10k–50k 全量编辑态实体计划，也不再调用完整 `SceneRuntime.sync()` 或重复提交成员未变化的基础 thinInstance 矩阵；编辑态按结构模板保持稳定源关系，不同参数值继续由独立参数变体宿主执行完整脚本和原 Geometry 渲染，撤销/重做、保存格式和运行预览语义不变。

- 2026-07-29：服务器模型同步与模型文件夹重导现在会把新下载的 TypeScript 参数脚本、`parameterScripts` / `animationScripts`、`modelParameters` 和 `dataDriven` 一并刷新到已有场景实例及模型生成器目标；数据中台显式返回的任意 `.ts` 不再因缺少 `.model.ts` 后缀而只落盘不登记。运行时脚本签名纳入 `assetRevision` 和脚本 meta，确保同路径覆盖后停止旧脚本、重新读取并启动新版本。

- 2026-07-29：修复所有参数化模型在正式阵列后修改源模型数值时的闪烁：源参数从默认值切出或恢复默认值期间，旧批次会持续显示到新参数宿主与 Geometry 完整 ready 后再原子替换，空输出或创建失败保留上一份有效画面；参数变体宿主在脚本编译和启动期间不进入 Active Mesh，不存在外置脚本运行时的阵列不再执行空宿主刷新。
- 2026-07-26：Hierarchy 单选文件夹新增整组世界坐标平移：递归高亮全部可显示后代，在世界包围盒中心显示移动 Gizmo；拖动期间普通节点与 thinInstance 逻辑实体走可取消运行时预览，松开后一次性写回全部普通后代位置并形成单条撤销记录。隐藏/未加载成员仍参与最终提交，任一文件夹后代锁定时原子阻止，空文件夹、多选和运行预览不显示组 Gizmo；不新增文件夹 Transform，不修改场景版本或序列化格式。

- 2026-07-25：撤销大场景屏幕空间方块/框架代理方案。`SceneRuntime` 与 `EntityArrayThinInstanceBatch` 不再创建或切换任何替代 Geometry；极远景、中景、近景及任意旋转视角都使用参数化脚本完整生成后的原模型顶点、索引、材质、纹理和全部部件。保留 thinInstance、空间分片、原模型 OBB 视锥裁剪、前到后不透明排序、单实体拾取和单实体高亮；性能 HUD 与真实场景 smoke 强制断言代理数为 0、原模型实体数等于场景模型总数。Intel UHD 630 的最新 10k 全景旋转保真报告 `2026-07-25T09-04-02-336Z` 验证刷新前后均为 10,000 个原模型、0 个代理，刷新后平均 `4.53 FPS`、GPU frame `223.72 ms`；该结果确认 GPU 几何吞吐边界，不冒充 30 FPS 达标。此前依赖代理得到的 33.07 FPS / 248.65 FPS 报告标记为已否决实验，不再作为发布证据。
- 2026-07-24：针对 RTX 5070 大场景报告中的 CPU/Draw Call 瓶颈扩展编辑态自动 thinInstance：新增 Box、GD、HCTS、WLTS 安全参数脚本，并把同模板的多个已有阵列源临时统一到一个真实源；原始场景、运行预览、参数变体、资产编号与遥测隔离不变。指定 113,110,088 字节场景的静态计划从 1,966 个真实模型源降至 18 个，其余 8,328 个模型实体走逻辑矩阵实例；旧 `modelArray.items` 源继续保留，避免兼容场景丢失隐藏阵列项。
- 2026-07-24：完成大场景交互第一阶段优化：Scene View 将纯选择变化从完整 `SceneRuntime.sync()` 拆到 `syncSelection()`，普通单选只刷新前后目标；共享模型/矩阵阵列描边按当前选区推导，thinInstance 选择缓冲通过实体连续区间差量改写。Hierarchy 使用 24px 固定行高、上下各 20 行 overscan 的虚拟窗口，10k/50k 行只保留受控 DOM。新增 1 Hz 性能 HUD 与最近一分钟 JSON 报告，采集 FPS、CPU/GPU frame time、Draw Call、active mesh、thinInstance、同步/分组耗时和 Long Task；Toolbar 新增“性能”复选框控制 HUD 显示与隐藏，隐藏期间持续采样并保留报告历史；同时新增 `npm run smoke:editor-performance` 数量级回归。
- 2026-07-24：Windows 正式打包版新增 `disable-gpu-sandbox`，与既有高性能 GPU 请求、软件 rasterizer 禁用和 Scene View 硬件 WebGL 严格校验共同固化到 `app.asar`；开发态继续保留 GPU sandbox，不绕过 Chromium GPU blocklist，也不固定 ANGLE 后端。生产 GPU smoke 新增开关策略检查，并在 Scene View 创建内置立方体后确认硬件 WebGL 上下文未丢失。该企业部署策略降低 GPU 进程隔离强度，使用方已明确接受相应安全风险。
- 2026-07-30：环境模型升级为单一全局场景底座：新环境按真实包围盒 X/Z 居中、Y=0 落地，旧场景继续保留 `X=-2m` 左侧摆放并提供显式转换；Inspector 新增源单位修正、位置/XYZ 旋转/统一缩放、显隐、透明度、幽灵显示、重置、聚焦、临时 Gizmo、加载状态和折叠统计。环境切换、变体、单位修正和同包重导采用候选容器事务，失败保留旧环境；编辑器、运行预览与导出 Viewer 共用同一静态环境运行时，不启用 GLB 相机、灯光、动画或脚本。环境聚焦同时修复 ArcRotate Target 高差导致相机翻到地下的问题。
- 2026-07-23：修复 thinInstance 模型阵列中每个逻辑模型的参数化脚本失效：运行时按完整模型参数快照分组，相同参数组合共享一个隐藏脚本宿主，不同组合独立执行声明式参数绑定和外置参数脚本；脚本输出继续一次性提交为 thinInstance，宿主不显示、不拾取。连续调参复用原宿主，恢复相同参数后自动合并批次，源 GLB 仍通过资产缓存复用。
- 2026-07-23：Windows NSIS 安装包补齐 GPU/WebGL 安装态回归：新增 `smoke-packaged-gpu.mjs` 直接校验生产主进程 GPU feature、活动显卡、启动开关和 Scene View 实际 renderer，并通过版本核对阻断旧安装程序；`npm run smoke:installer:gpu` 串联完整构建、NSIS 产物生成和生产 EXE 验证。Windows 打包继续复用已安装的 Electron runtime，并在 `afterPack` 清理默认入口文件，避免端点安全软件导致解压目录重命名失败。
- 2026-07-23：固化编辑器 GPU/WebGL 硬件加速契约：Electron 在 ready 前请求高性能 GPU，BrowserWindow 明确启用 WebGL；Scene View 使用 `powerPreference: high-performance`、`failIfMajorPerformanceCaveat: true` 并拒绝 SwiftShader/WARP/llvmpipe 等软件 renderer，初始化失败通过现有 Scene 错误遮罩呈现；新增 `npm run smoke:gpu` 验证 Electron GPU compositing、WebGL 状态、上下文属性和实际 renderer。当时独立 Web Viewer 兼容策略未改；该策略已于 2026-08-03 收紧为必须使用硬件 WebGL。
- 2026-07-23：Shift+Gizmo 单轴阵列从普通导入模型扩展到全部可阵列实体：新增内置 Mesh、虚拟定位线框、已解锁 CAD 参考层和 POI 特效的世界/局部正负轴投影测量与不可拾取临时预览；POI 纯粒子效果使用半透明范围代理，不复制粒子系统。文件夹、灯光和全局唯一模型生成器继续排除。阵列名称统一改为按源对象名称末尾数字递增，例如 `测试 1001 → 测试 1002/1003`，纯字符串追加序号且不再添加“副本”；导入模型和定位线框的资产编号继续独立递增。导入模型的临时预览与正式结果统一改为固定批次 Mesh + thinInstance 矩阵，正式阵列项持久化在源实体 `components.modelArray` 中，不再按数量创建模型实体、脚本和加载任务；非模型阵列保持普通实体复制。确认、取消、生命周期清理和单条撤销/重做语义保持不变，场景版本仍为 `1`。
- 2026-07-22：新增普通导入模型 Shift+Gizmo 单轴阵列：局部/世界 X/Y/Z 拖动按可见几何投影跨度生成零间距临时克隆，原模型保持原位，松开后共享阵列弹框可实时调整副本数量、净间距和编号规则；确认时名称与 `modelAsset.assetCode` 从源资产编号同步递增并原子检查冲突，整组副本以一条命令撤销/重做，取消、失焦、选择/模式/场景变化会清理预览且不修改场景格式。
- 2026-07-22：首页启动台新增数据中台地址配置弹窗，配置持久化到 Electron `userData/data-platform-config.json`；左侧“最近项目”由主进程通过 `POST /api/v1/projects/query` 拉取、校验并按更新时间展示业务项目，支持 `projectName` 搜索，并新增可信项目 ID 打开流程。当前格式工程包会安全下载、展开并加载唯一场景；无包、旧 `project.bjseditor` 或结构不兼容时进入空白场景；进入编辑器后后台全量同步普通、环境和组合模型。已使用 `http://127.0.0.1:8086` 完成真实联调：19 位业务 ID 无损保留，10 个普通模型共 25 个文件同步成功，Shelf 双 TS 脚本不再被旧换行拼接字段重复下载。
- 2026-07-21：按参考图片重做 YZJ 一体式移载机参数契约，新增精确长宽高、主体颜色、辊筒框架位置/长度、电机位置、腿 A/B、电机与辊轮皮控制；通过连通组件处理单体 GLB，保留旧场景、MQTT 与方向箭头兼容，并完成静态、浏览器视觉矩阵和真实 Electron Inspector 联动验证。

- 2026-07-17：完成 Scene View 大场景无损容量与稳定性优化：普通无脚本/无参数静态模型按 `sourceUrl + assetRevision + instancingMode` 复用单份源 `AssetContainer`，100 个同源实体 smoke 仅加载 1 次源资源、每实体保持 18 个独立实例 Mesh；SceneRuntime 改为实体引用驱动的增量同步，选择变化不再重跑全部模型参数/脚本/子 Mesh 收集；模型和环境加载统一限制为最多 4 并发；关闭无功能依赖的 `preserveDrawingBuffer`，保留抗锯齿与 stencil，并增加 WebGL context lost/restored 和 render error/recovered 可见恢复。当前 Shelf 回归按目标场景真实参数验证 `20 层 × 100 列 × 双深`（`cellWidth=1.2`、`cellHeight=1.2`、`supportLegHeight=0.2`、`cellDepth=1.183`、`deepSlotGap=1.2`），统计为 `denseBatch=18`、`thinInstances=16674`、`visibleMesh=18`。
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
- 2026-07-29：扩大场景导入模型的可选中区域。真实三角面完全未命中时，Scene View 会按模型当前可见子 Mesh（包含参数脚本生成的 clone / thin instance）的实体局部有向包围盒补充拾取，使 Shelf 调整层数/列数后的货格空隙和多穿货架内部区域更容易选中；范围不增加额外 padding，旋转模型也不会退化为放大的世界 AABB，且后方真实可见模型仍保持命中优先。新增 `npm run smoke:model-picking` 定向回归。
- 2026-07-29：统一场景模型选择效果。拖入场景的独占容器模型、共享实例、复制副本和阵列实例全部使用同一个 `SelectionOutlineLayer` 描边，不再因运行时资源策略不同而出现发光高亮与轮廓描边两种模式。
- 2026-07-25：Shelf 按当前模型契约支持 `layerCount=1..20`、`columnCount=1..100`。当层/列/双深组合会超过逐节点生成阈值时，参数脚本自动切换为高密度 `dense batch + thin instance` 渲染：每个可渲染源叶 Mesh 只创建一个批次 Mesh，重复货格通过一次性矩阵缓冲提交，场景节点保持批次级；低密度路径继续保留原 `cloneSingleNode` 行为。目标场景的 20 层 × 100 列 × 双深参数（`cellWidth=1.2`、`cellHeight=1.2`、`supportLegHeight=0.2`、`cellDepth=1.183`、`deepSlotGap=1.2`）smoke 统计为 `denseBatch=18`、`thinInstances=16674`、`visibleMesh=18`，低密度当前回归为 142/196。视觉页 `output/playwright/shelf-visual-check.html?dense=1` 会自动取景并显示 effective layers/columns、mesh/node、thin instance 与 FPS 采样。
- 2026-07-17：Shelf 普通场景实体与模型生成器输出改为共享源 `AssetContainer` + `InstancedMesh`：同一资源签名只加载一次 GLB，实体继续保留独立根节点、参数值、外置脚本、拾取 metadata、显隐/锁定和 Gizmo。参数脚本无需修改，其层/列/双深生成节点的子 Mesh 会继续保持实例化；实例选择改用单个共享 `SelectionOutlineLayer`。动态修改 `layerCount`/`columnCount` 后，运行时会在 `clearSelection()` 与 `addSelection()` 之间按 source mesh 补齐公开 `instancedBuffers` 容器，避免 Babylon 重新注册 `instanceSelectionId` 时写入空实例缓冲。新增引用计数回收与 `npm run smoke:shelf-instancing` 定向验证，详细边界见 `docs/shelf-shared-instancing.md`。
- 2026-07-10：精简 Shelf 参数元数据，移除 `aisleWidth`、`aisleHeight`、`shelfStyle` 这 3 个无模型语义参数；剩余 9 个参数均会产生可见模型效果。`postWidth` 继续按 0.08 兼容基准，仅调整立柱横截面；立柱底端保持锚定，列布局统一支撑容差，旧场景刷新时按新参数集兼容。GLB 未修改，Sandbox 仅用于结构校验。

- 2026-07-01：补齐 Shelf 高度变化时侧面三角支架的数量联动。`cellHeight` 按 `ceil(目标层高 / 原始层高)` 计算每层三角支架模块数，保证单个支架模块高度不超过原始层高；默认高度保持 4 个侧撑节点，5.5m/6.8m/9.05m 会自动变为 8 个，13.575m 会变为 12 个。多层、多列、双深和旋转组合都会在各自货格内按模块高度重复生成支架，而不是只把单个支架拉长。
- 2026-07-01：修复 Shelf 多穿货架参数化脚本的层/列/双深组合变形。`layerCount`、`columnCount`、`doubleDeepEnabled` 现在以原始单格部件为唯一语义源，按层、列、深位一次性组合克隆，避免把运行态克隆再次作为克隆源导致穿插或漏复制。
- 列复制语义：`cellWidth` 仍作为货格宽度输入，实际列阵优先使用左右支撑中心距，以保持多穿货架 0 间距共享立柱的业务语义；深位复制使用 `cellDepth + deepSlotGap`，`deepSlotLift` 只作用于第二深位的 Y 向偏移。
- 旋转语义：宽、高、深的包围盒读取和克隆偏移改为模型局部 X/Y/Z 在世界空间中的投影方向，模型整体旋转后仍沿货架自身方向参数化。
- 验证组合：默认 1 层 1 列、3 层 4 列、2 层 3 列双深、旋转后的多层多列双深组合。源包 `F:\3d-models\models\Shelf\shelf.model.ts` 与资产副本 `F:\3d-models\models\Assets\Models\Shelf\shelf.model.ts` 必须保持同步。

## 数据中台图表库同步

- 图表库同步只认当前工程目录中的数据中台项目绑定。绑定存在时，通过 `POST /api/v1/projects/{projectId}/config/screens/query` 分页读取该项目关联的大屏；未绑定的本地工程不访问数据中台，并显示空图表库。
- 每个绑定大屏只保留项目 ID、大屏 ID、名称和编码等卡片元数据，不读取或保存 `jsonContent`，也不解析其中的 widget 图表配置。
- 同步索引按项目隔离并原子替换；任一分页请求或返回数据校验失败时整批失败，继续使用该项目上一次成功同步的图表库。项目切换后，旧任务的迟到进度和结果不会覆盖当前项目。
- 当前图表库同步绑定项目的完整大屏，卡片可以拖入 POI 图表立标或其 Inspector 大屏槽位。拖到场景空白处不会创建大屏或覆盖相机视窗。已有场景中的 `viewportScreen` 和 `dataPlatformScreen` 数据继续兼容；沿用现有数据中台访问权限。
- 大屏与三维对象通过 `postMessage` 双向联动：大屏可发送 `zending.data-platform-screen.bridge` v1 的 `screen.selectEntity`、`screen.focusEntity` 或 `screen.clearSelection`，目标可使用 `entityId` 或唯一 `assetCode`；Viewer 将三维点击结果回传为 `viewer.selectionChanged`。消息仅接受来自对应大屏 URL origin 且 source 为对应 iframe 的事件，不把 `jsonContent` 或内部 widget 配置写入场景。

## 数据中台天空盒同步

- 从首页打开数据中台业务项目时，编辑器先进入已经绑定的数字孪生工程，再在后台同步数据中台天空盒资源；查询或下载延迟不会阻塞项目打开。本地项目不会自动联网，只能在 Project 面板的天空盒 Tab 手动发起同步。
- Project 面板会合并本地天空盒与数据中台天空盒；即使名称相同也分别显示且本地资源优先。数据中台资源使用稳定 `dataPlatformResourceId` 标识，按 `revision` 与 SHA-256 增量更新，并发下载上限为 `2`，单个文件最大 `512 MiB`，单次同步计划最大 `8 GiB`。
- 同步采用整批校验与原子切换：任一分页、下载、格式或 SHA 校验失败时继续使用旧资源库，并在天空盒 Tab 显示失败状态与重试入口；再次同步未发生变化的资源不会重复下载。
- 数据中台以同一稳定 ID 替换天空盒后，已引用该资源的场景会重新关联到新文件，同时保留强度、分辨率、旋转和天空盒实体 Transform；该变更进入正常 dirty/undo 历史。远端删除资源后，新选择列表会隐藏对应卡片，但已打开场景仍可使用标记为 orphaned 的兼容缓存。
- SOURCE ZIP、Viewer DIST ZIP 和独立部署导出只包含场景实际引用的天空盒，并把资源 URL 改写为包内离线路径；Viewer 不依赖数据中台即可运行。若场景引用的 orphaned 兼容缓存已经缺失或校验失败，发布会明确失败，而不是生成缺少资源的包。

## 场景 Web 部署导出

Toolbar 的 `📦 导出部署工程` 会捕获当前内存场景，通过与保存、发布相同的序列化入口生成一次幂等合批快照，再自动收集普通模型、模型生成器目标、环境、天空盒、DXF、模型脚本与贴图，输出可部署目录或 ZIP。该离线部署包能力继续保留，并与 `发布到数据中台` 相互独立；导出结果使用独立只读 Web Viewer，直接消费快照中的合批关系，不包含编辑器界面和 Electron 运行环境。

部署包通过根目录 `runtime-config.json` 外置页面、资源和 MQTT 配置；修改 JSON 后刷新页面即可生效。真实 MQTT 仅支持 `ws://` / `wss://`，静态 JSON 不应保存用户名、密码或长期 Token。部署包必须通过 HTTP/HTTPS 静态服务器访问，不支持直接双击 `index.html`。Viewer 要求浏览器启用硬件加速 WebGL，不再静默降级到软件 renderer；无法获得 GPU 时会在页面状态层显示明确错误。 Viewer 打开页面后立即显示与编辑器一致的品牌加载蒙版（ZENDING Logo 蓝色填充、蓝色进度条与百分数），覆盖配置读取、场景文档解析、引擎创建、模型与环境资源加载全过程，全部就绪后才消失；首次场景加载超过 120 秒会强制收起蒙版并提示部分资源可能尚未完整显示，阻断性错误则直接切换为错误状态层。

完整目录结构、配置字段、CSP、外部资源、安全边界和部署说明见 [场景 Web 部署导出](docs/scene-web-export.md)。
## Windows 安装包构建与安装

项目使用 Electron + electron-builder 生成 Windows x64 NSIS 安装包。生产构建使用相对资源路径，因此安装后由 `file://` 加载 renderer 时，React 页面、Babylon.js 分块、CAD Worker、样式和图片仍可正常读取。GPU 启动开关和 Scene View 硬件 WebGL 严格校验位于打入 `app.asar` 的生产代码中；Windows 免安装目录和 NSIS 安装后的程序还会按企业部署策略关闭 GPU sandbox，开发态继续保留该 sandbox。正式包不绕过 Chromium GPU blocklist，也不固定 `use-angle` 后端。

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
- 最近项目与最近场景记录写入 Electron 的 `userData` 目录，不写入只读安装目录；数据中台服务地址和可选自定义工作区保存在同目录的 `data-platform-config.json`，旧版仅含服务地址的 v1 配置会继续兼容读取。
- 数据中台下载的工程场景默认写入工作区 `Projects/{projectId}`，共享模型库写入 `SharedResources`；默认开发态工作区为应用根目录，默认安装态为 `userData/data-platform-workspace`，也可从首页选择其他可写目录。安装、升级程序不会覆盖工作区，也不会放宽安装目录 ACL；切换工作区不会自动迁移或删除旧数据。
- 模型库、环境模型库、天空盒库、场景 JSON、CAD 文件和模型脚本仍保存在用户选择的项目目录中；安装或升级程序不会删除项目数据。
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


## POI 图表立标

1. 在 `POI库` 点击“图表立标”，或拖到 Scene 画布，生成默认 `4 m × 2.25 m` 的竖直标牌。
2. 切换 `图表库`，把已同步的大屏拖到场景中的立标上，或选中立标后拖到 Inspector 的“大屏内容”槽位。需要当前工程已绑定数据中台项目，且大屏具有可访问的 HTTP(S) 页面地址。
3. 标牌实时嵌入完整大屏，编辑态继续允许选中和调整 Transform；进入运行预览或打开发布 Viewer 后可以操作大屏内容。绑定、替换、清空、复制、移动、显隐与锁定沿用场景实体规则，保存重开会恢复绑定。
4. 大屏数据更新频率由大屏自身数据源/远程数据的轮询设置决定；修改大屏设计后，点击 Inspector 的“刷新内容”重新加载。页面加载超时提供提示和可用缩略图，隐藏/删除立标会释放嵌入页面；再次显示时重新加载。

立标使用场景中的平面及跟随透视投影的网页层，网页层不参与三维逐像素深度遮挡。未绑定时显示拖入提示；清空只移除大屏绑定，保留立标。大屏内部若再次嵌入数字孪生场景，四层及以上宿主页会停止继续加载立标页面，避免无限循环。场景版本保持 `5`，旧大屏与相机视窗大屏保持兼容。

验证：`node --test tests/editor/chartMarker.test.mjs tests/editor/chartMarkerDrag.test.mjs tests/editor/chartMarkerRuntime.test.mjs`；`npm run build` 后执行 `node scripts/smoke-chart-marker.mjs`，使用本地实时页面夹具和 Chrome 验证拖放、数据更新、运行预览交互、清空/撤销、刷新及构建后的独立 Viewer，截图保存到 `output/playwright/chart-marker/`。
