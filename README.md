<picture>
  <source media="(prefers-color-scheme: dark)" srcset="src/assets/branding/zending-logo-on-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="src/assets/branding/zending-logo-on-light.png">
  <img alt="ZENDING" src="src/assets/branding/zending-logo-on-light.png" width="520">
</picture>

# ZENDING 3D EDITOR

ZENDING 3D EDITOR 是一个基于 Electron、Vite、React、TypeScript 与 Babylon.js 的桌面 3D 编辑器原型项目。

## 当前目标

第一阶段 MVP 的目标是构建一个可启动、可编辑、可保存/加载的桌面 3D 编辑器内核。当前阶段重点验证编辑器基础架构、场景数据模型、基础对象编辑流程、基础资源导入与本地文件交互能力，不是一次性复刻完整 Unity3D。

## 文档索引

为保持 README 简洁，较长的内容已迁入 `docs/`，原文未删减：

- [当前功能清单](docs/features.md)
- [编辑器基础操作](docs/editor-operations.md)
- [领域专题：参数化模型 / MQTT / POI](docs/domain-guides.md)
- [提升机与换层提升机运动箭头](docs/lift-motion-arrows.md)
- [材质与光照烘焙、动静混合阴影](docs/hybrid-lighting.md)
- [烘焙性能与大场景稳定性评估及处理方案](docs/数字孪生编辑器烘焙性能与大场景稳定性评估.md)
- [最近完成与变更记录](docs/changelog.md)
- [极致性能实施说明](docs/extreme-performance-implementation.md)
- [性能指南检测与无损优化](docs/babylon-perf-guide-audit.md)
- [Babylon 只读几何声明与稀疏矩阵上传](docs/babylon-model-runtime-optimization.md)（旧模型策略不变；局部上传实验默认关闭）
- [测试入口、平台与隔离要求清单](docs/test-inventory.md)
- [S1 工程治理实施与验收记录](docs/optimization-s1-validation.md)
- [项目专项优化计划](docs/project-optimization-plan.md)、[P1 执行和验收记录](docs/tasks/2026-10-21-project-optimization.md)、[P2 执行和验收记录](docs/tasks/2026-10-21-project-optimization-p2.md)、[P3 执行和验收记录](docs/tasks/2026-10-22-project-optimization-p3.md) 与 [P4 执行和验收记录](docs/tasks/2026-10-22-project-optimization-p4.md)（P3模块解耦、P4类型安全与测试治理已完成本地验收；P2总验收未完成，动静合批缺省关闭）。

## 启动方式

首次运行前安装依赖：

```bash
npm install
```

启动开发版 Electron 编辑器：

```bash
npm run dev:electron
```

运行环境要求：Node.js `^22.15.0 || >=24.0.0`（覆盖 ESLint 与测试模块加载 hook 的要求）；CI 使用 Node.js 22。

开发启动器通过 Electron 包提供的路径入口准备运行时；首次使用时可能显示 `Downloading Electron binary...`，后续复用已下载的运行时。准备或进程启动失败会在终端输出 `[dev-electron]` 错误并以非零状态退出。需要提前下载时，可运行 `npx install-electron --no`。

Windows 下若 Electron 子进程报 `spawn ...electron.exe EACCES`，先核对实际系统错误：Win32 `740` 表示请求提权，可能是该 EXE 的“兼容性 → 以管理员身份运行”设置。开发启动和本地集成测试使用普通权限；确认该原因后，只备份并取消对应 Electron 路径的强制管理员标记即可，无需重装运行时或扩大目录权限。其他 `EACCES` 原因仍需按实际错误排查。

`[typescript] 缺少 N/M 个 Electron 产物，本次强制重建。` 是构建恢复通知。首次运行或清理 `dist-electron` 后，脚本会重新生成 JavaScript/CJS 和类型声明，即使保留了 `.tsbuildinfo` 缓存也能恢复；产物齐全后再次启动沿用增量编译。若随后仍启动失败，应查看这条提示之后的编译或 `[dev-electron]` 错误。

若 Electron 窗口只显示标题栏或菜单栏，优先查看启动终端中的 `[electron]` 日志；渲染入口异常会显示“编辑器启动失败”，WebGL/Babylon 初始化异常会显示在 Scene 面板内，不再静默白屏。若提示“硬件加速 WebGL 创建失败”，请先更新显卡驱动，并在 Windows“图形设置”中将 `ZENDING 3D EDITOR` 设为“高性能”；编辑器不会退回 SwiftShader/WARP 软件渲染。

开发脚本会自动从 `5173` 开始向后选择可用本地端口，最多扫描 300 个端口以避开 Windows 保留端口段或已有本地服务，并先执行 `npm run wait:renderer`，依次预热 Vite 根页面、React 入口、布局、Scene View、Babylon runtime 与编辑器 store 等首屏模块，全部成功返回后再启动 Electron，避免端口占用或 Vite 首次依赖预构建、模块转换尚未完成时打开空窗口。

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

质量门禁还包括 `npm run lint`、`npm run format:check` 和 `npm run test:ci`。`test:ci` 与 `npm test` 执行范围明确的 core 组；集成与完整容量分别使用 `npm run test:integration`、`npm run test:smoke`。默认组不代表全仓测试，旧细分入口均保留；分组、覆盖率和渐进类型规则见[测试说明](docs/test-groups.md)，平台和隔离要求见[测试清单](docs/test-inventory.md)。`npm run format` 仅格式化 package.json、ESLint、Prettier 和 CI 四份配置，不会格式化整个项目。测试入口或夹具变动后执行 `node scripts/generate-test-inventory.mjs` 更新清单，再用 `--check` 检查漂移。

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

## 架构说明

项目按桌面壳、渲染器 UI、编辑器领域模型与运行时渲染层拆分：

- Electron 主进程：负责创建桌面窗口、管理应用生命周期，并承载需要在主进程中执行的本地能力。
- preload 安全 API：作为主进程与 renderer 之间的受控桥接层，避免 renderer 直接暴露高权限 Node.js 能力；本地模型通过 `editor-asset://` 受控协议加载，项目内模型与环境通过 `.babylon-editor/asset-index.json` v2 记录，普通模型指向 `Assets/Models`，环境模型指向 `Assets/Environments`；天空盒从独立的 `Assets/Skyboxes` 单文件包安全扫描并授权；v1 旧索引条目默认归模型库且不移动旧文件；首页最近项目、最近场景、按路径加载场景和移除最近记录也通过受控 IPC 暴露。
- React renderer：负责编辑器界面、面板布局、用户交互与状态展示，并通过入口错误边界将启动期异常转换为可见错误页。
- editor model：定义 SceneDocument、Entity、Transform、MeshRenderer、ModelAsset、Light 等编辑器核心数据结构，是保存/加载与 UI 编辑的统一数据来源。
- commands：封装可撤销编辑操作，并维护撤销/重做命令历史。
- runtime/babylon：负责将编辑器场景文档增量同步到 Babylon.js 运行时场景，包括 Mesh 创建、模型导入、灯光同步、Transform 同步与选中高亮；安全静态模型和 Shelf 通过共享源容器实例化，资产加载由固定并发调度器控制，Scene View 统一处理 WebGL 上下文与渲染循环恢复。
- panels：按编辑器区域拆分 UI，包括 Hierarchy、Scene、Inspector、Project、Console 等面板。

## 材质与光照烘焙

操作说明更新：2026-10-23。

Toolbar 的“光照与烘焙管理器”是统一照明和烘焙的唯一编辑入口，包含“总览与烘焙”“分类规则”“对象与部件”“任务与资源”四个页签。总览集中设置场景照明、显示效果和烘焙；“光照预设”“显示预设”只暂存对应草稿，应用后才生效。场景和模型 Inspector 保留状态及有效分类来源摘要，并可进入管理器定位对象。规则按字段采用上方优先，已有对象及部件例外保留；草稿整体应用形成一次可撤销更改。

本机 Blender 路径可在“总览与烘焙 → 烘焙参数 → 配置引擎…”中选择、检测和保存，无需手工新建 JSON。窗口显示实际生效引擎和来源，要求 Blender 4 或更新版本；“恢复自动查找”会移除手动路径。该设置仅属于当前电脑和系统用户，所有工程共用，不进入场景或发布包。发布窗口在需要生成光照时也提供“配置 Blender…”和“重新检查引擎”，保存后保留原发布表单。已有有效光照的 Viewer 不依赖 Blender。

新版本统一采用材质/间接光烘焙与动静混合阴影，不再提供旧 baked/realtime 模式选择、旧太阳阴影烘焙或主题自动接管灯光。编辑端使用本机 Blender/Cycles 计算静态间接光和环境漫反射，原生实时直接光、高光、反射及动态阴影继续保留。关闭“启用阴影”不会关闭主光、补光或环境反射；修改曝光、对比度和雾等显示效果不会使 GI 过期。总览展示当前已应用配置的真实 Scene 快照。

结果作为独立光照图集、几何 JSON/bin 和探针 JSON 保存在工程 Assets/LightingBakes 中，随保存、SOURCE/DIST 和工程迁移携带；Viewer 读取成品，不依赖 Blender。旧场景只在内存中转换，不因打开文件而写盘或启动 Blender；首次覆盖旧文件前保存原始字节备份。旧 v1 GI 保留资源和原签名并标为过期，需明确重新烘焙；旧太阳阴影贴图不能充当新 GI。“允许昼夜循环控制光照”由 allowDayNightCycle 显式记录，旧主题场景保留原禁用状态；实际日夜控制器活动时须先暂停，再烘焙。总览提供不读回像素的轻量预算预检、临时草稿预览、区域探针与CPU/自动/GPU选择；任务从捕获前开始记录，逐项捕获并以确认后的有界数据块暂存，超预算明确停止。相同输入重试可复用校验通过的完整阶段；结果按解码字节及新旧GI共同驻留预算加载。任务页显示每光源阴影成本、阶段内存、设备回退、日志和安全临时清理。具体操作、限制与迁移边界见[混合光照指南](docs/hybrid-lighting.md)。

`npm run test:lighting-unified` 覆盖统一配置、Store、原生光照与环境材质、备份及保存发布；`npm run test:lighting-manager` 与 `npm run test:lighting-bake` 继续覆盖管理器和烘焙，均已采用新结构且不需要 Blender/GPU。新增 `npm run test:lighting-optimization` 覆盖预检、产物、二进制、任务、临时预览与区域；`npm run smoke:lighting-optimization` 和 `npm run test:lighting-optimization:cycles` 分别执行真实界面闭环及引擎增强验收。真实统一光照闭环使用 `npm run smoke:lighting-unified`；已有当前流程保存的真实 v2 烘焙工程后，可用 `node scripts/smoke-lighting-bake-state.mjs --unified` 检查过期、清除和撤销恢复。真实 Cycles 与浏览器/Electron 检查独立执行，不加入默认 core 组。具体通过状态和截图以[统一光照任务记录](docs/tasks/2026-10-21-unified-lighting.md)为准，单测和文件链检查不等同于真实 Viewer 画面通过。

## 场景文件说明

当前场景文件使用 `.scene.json` 后缀，内容为 JSON 格式的 `SceneDocument`。

场景文件的核心约定：

- 新保存场景文件外层 `version` 为 `6`，新版加载器兼容 version 1–6；统一配置缺省使用 `sceneSettings.lighting.version: 2` 与 `sceneSettings.appearance.version: 1`，不混同文件版本。显式启用 Gamma RGBM 新编码或有限 Mip 时使用可选 lighting v3，旧无新特性场景保持 v2。旧编辑器会拒绝 v3，启用前应保留原工程副本；新文件需要配套新版编辑器与 Viewer。设置、预算和支持条件见[混合光照说明](docs/hybrid-lighting.md)。
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
- 模型阵列的“阵列净间距(m)”支持正数、0 和负数，适用于普通对象与组合模型，也适用于右键菜单及 Shift 拖轴后的参数弹框。副本沿所选方向按“选区几何跨度 + 净间距”排列；负净间距可用于重叠拼接，合计步长为 0 时重合、小于 0 时反向排列。
- 场景属性的“场景”分组在名称下展示“模型总面数”，按三角面统计普通/内置模型、完整逻辑实例、环境和实际生成货物；“统计明细”可展开核对场景模型与环境模型。隐藏实体、父组显隐、相机裁剪、双面材质与位置缩放不会改变几何总量，参数关闭的内部部件按当前结果排除。编辑辅助、天空盒、线点与 CAD 线稿不计入；加载未完成或失败时显示明确状态，不把部分结果当作完整总数。计数及明细展开仅保存在编辑器运行状态，不写入场景文件或撤销历史。
- 场景准备会预取并解码模型生成器默认目标、规则目标及组合成员，复用现有模板缓存；Editor 和 Viewer 就绪后首次生成可直接复用已解码模板。预取不创建货物或提前执行参数脚本，保留画质、实例隔离及跨设备动作；失败时生成路径仍按原规则重试或回退。配置变化、删除及场景释放会归还预取引用，详见 [动态货物模板启动预取](docs/scene-capacity-performance.md#动态货物模板启动预取)。
- `sceneSettings.environment` 记录环境模型包路径、显示名称、文件大小、源单位、`unitScaleToMeters`、摆放模式、根节点 position / XYZ rotation / 统一 scale、显隐、透明度、缩略图、当前激活变体和包内变体列表。新环境默认作为唯一全局场景底座，按包围盒 X/Z 居中、Y=0 落地；旧场景缺少新字段时继续使用右边界 `X=-2m` 的 `legacy-left` 兼容摆放，并可在 Inspector 显式转换。环境不进入 Hierarchy、默认不可拾取，不启用 GLB 相机、灯光、动画或模型脚本；环境 PBR/Standard 材质保留原始底色与纹理；默认原貌模式与场景光源隔离，hybrid 模式让环境参与场景受光；显隐与编辑透明度仍由环境设置控制，物理材质透明度另行保留；半透明使用关闭深度写入的幽灵显示。环境切换、变体、源单位修正、重置和重导先后台加载候选资源，成功后原子替换，失败时保留当前有效环境。
- 天空盒是“无限远天空背景”：场景实体 `components.skybox` 保存原始 HDR/EXR 引用（`sourcePath/sourceUrl/assetRevision`）、编辑器编译出的 Babylon 原生 `environment`（`format: 'env'`、`sourceSha256`、`recipeKey`、`sha256`、`byteLength`、`faceSize`）、旋转、强度和分辨率；旧 `sceneSettings.skybox` 与旧球体实体在加载时迁移，场景文件版本为 7（1–6 仍可读取）。运行时使用 `scene.createDefaultSkybox` 创建 `infiniteDistance` 天空盒，跟随相机、不参与拾取、不受场景尺寸/可视距离影响，当照明来源选择“场景天空盒”时，同一 ENV 也作为 `scene.environmentTexture`，选择 Sandbox 时保持其独立照明；Viewer 与编辑器运行时只加载 Babylon 原生预过滤 `.env`，不再解码 HDR/EXR 或执行 `HDRFiltering` 预过滤。
- 唯一照明配置保存在 `sceneSettings.lighting`（缺省 version 2，可选新编码 version 3），其中 `main`、`fill`、`environmentIntensity`、`disabledLightIds`、`allowDayNightCycle`、`shadows`、`bake`、`policy` 和 `result` 分别承载灯光、控制状态、阴影、烘焙、规则和结果；纯外观位于 `sceneSettings.appearance`（version 1）。旧 `theme`、`shadows`、`lightingBake`、`lightingPolicy`、`lightingBakeResult` 只用于兼容读取，新写删除这些旧字段。对象/部件例外仍在 `components.lighting`，按字段恢复继承由 `inheritPolicy` 记录；实体、动作、材质和未知扩展数据保留。临时生成部件采用资源或类型规则，真实场景宿主和逻辑阵列实例仍可分别编辑。有效 GI 只有输入与产物严格等价才可随地址迁移；旧 v1 与已有过期结果不会通过重签变成有效。

## 当前限制

- glTF/GLB 导入属于 MVP 级能力：支持导入、选择、基础 Transform、参数化外观绑定、保存和加载，不承诺完整材质编辑、动画、骨骼、蒙皮或嵌套资源管理。
- 大场景共享只对明确安全的重复资产生效：普通无脚本模型可共享源几何/材质，Shelf 使用独立验证过的脚本化共享路径；自动 thinInstance 另允许 8 个已核对参数脚本按完整结构模板签名合批，并在保存、发布和部署导出快照中持久化直接源引用。未列入白名单的动态脚本继续独占容器，因此不同资产、动态脚本和高面数贴图本身仍受 GPU 能力限制；本轮不会用降分辨率、LOD 或纹理降采样换取容量。
- CAD/DXF 导入属于布局参考层能力：承诺常见二维线稿实体 `LINE`、`ARC`、`CIRCLE`、`ELLIPSE`、`SPLINE`、`LWPOLYLINE`、`POLYLINE`、`HATCH` 边界、`SOLID/TRACE/3DFACE` 外轮廓与 `LEADER`，并完整保留 BLOCK、嵌套/阵列 INSERT 的几何实例；不承诺完整 TEXT/MTEXT 字形、Paper Space、多布局、实体填充、3D Solid 曲面或可编辑 CAD 图元。普通图纸保持精确解析，`64 MiB` 及以上图纸使用后台两遍流式扫描和按字节核算的几何预算，不自动减少线稿。`AC1021` 及以上 DXF 使用严格 UTF-8 解码；旧版或缺少版本时保留 ANSI_936 中文代码页兼容。DXF 合法 `$INSUNITS` 0–24 会换算为米；无单位图纸只能依据 `$MEASUREMENT` 或毫米 fallback，建议源 CAD 明确写入单位。超过 `±1e15` 的异常原始坐标会被过滤。
- 参数化模型依赖模型包中稳定的节点、网格或材质名称；安全 DSL 只支持 JSON AST 中的白名单运算和白名单属性绑定，不执行任意 JavaScript/TypeScript。贴图参数允许编辑器登记过的内置 `editor-image://` 逻辑引用，或模型包内 `.png`、`.jpg`、`.jpeg`、`.webp` 相对路径；仍不支持绝对路径、网络 URL、`data:`、反斜杠路径、未登记逻辑引用或 `../` 路径逃逸。重新导入模型包后，场景实例会使用新的 `modelParameters` 与 TypeScript 脚本元数据清洗参数：同名且仍合法的实例值会保留，新增参数使用新默认值，删除或非法参数会移除。
- Project 资源库中模型库、环境库、天空盒库、图表库和图片库已接入项目目录持久化；模型库普通模型包复制到 `Assets/Models`，环境库单个 GLB 保存到 `Assets/Environments/<安全化文件 stem>/`，天空盒 HDR/EXR 保存到 `Assets/Skyboxes/<安全化文件名>/` 独立包，数据中台同步大屏索引保存到当前绑定工程的 `.babylon-editor/data-platform-charts.json`，数据中台同步图片保存到 `Assets/Images/<iconKey>.<ext>`。新导入或从数据中台同步且未显式声明 `lengthUnit` 的环境模型默认按 `centimeter`（`×0.01 m`）解释，普通模型仍默认 `meter`，旧场景兼容语义不变。POI 库已接入模型生成器、自动巡检和图表立标，运行预览与 Viewer 已接入手动漫游控制器，特效库已接入 16 种内置 EFF；图表面板、组合及其它主题卡片仍为占位。原场景主题的照明/显示参数改由光照管理器预设草稿承接，资源库点击和拖入不再直接接管全局灯光。图片库已接入内置方向箭头、数据中台同步图片和 texture 参数拖放，支持按名称、图标 Key 与分类搜索。
- 首页数据中台配置、远程项目列表、项目打开和最近场景都依赖 Electron preload IPC；普通 Vite 浏览器页面会显示降级提示，并仅保留进入空白编辑器、新建场景等不依赖桌面权限的基础入口。当前不包含身份令牌配置或数据中台项目详情交互。
- 主布局自适应当前只包含随窗口尺寸自动调整、左右面板贯通到底部、Project/Console 限定为中间 Scene 同宽以及底部 Console 弹窗入口，不包含拖拽分隔条、其它面板折叠或用户自定义布局保存；小于约 `1024×640` 的窗口会继续尽量收缩，但不保证所有内容舒适可读。
- 图片库当前登记内置方向箭头和数据中台同步图片；用户手动导入本地图片、更多图片类型与分类管理仍待扩展。
- 灯光支持五种类型及各自有效参数，模型库另提供 HDRI/IBL 环境光入口。管理器可选择“统一主光”或“场景方向光”，并显式控制各场景灯是否参与照明；阴影开关只控制投影，不负责灯光生灭。点光与聚光在启用阴影时使用原生实时投影，矩形面光和半球光不具备相同的实时投影能力。编辑器点光和聚光继续使用线性距离衰减，PBR 与 Standard 材质按相同的强度、范围和聚光衰减参数呈现。环境统一参与场景照明，旧“保持环境原貌”和旧太阳阴影叠图路径已退出。材质、灯光和采样器预算不足时应查看明确诊断；不会以削弱校验或丢弃贡献伪装成功。完整材质与动态阴影边界见[混合光照指南](docs/hybrid-lighting.md)。
- 当前 Hierarchy 文件夹用于场景对象组织分组并支持任意层级嵌套；文件夹显隐和锁定会作用到组内对象。单选文件夹或任意多选可用世界坐标移动递归展开并去重后的普通成员，或绕完整世界包围盒中心旋转全部成员并保持各自缩放；Inspector 按“位置 / 旋转 / 缩放”三行展示群组空间信息：位置可按世界包围盒中心绝对坐标修改，旋转可按角度修改并绕群组中心应用，缩放当前显示为 1 且禁用。文件夹仍不保存 Transform，也不提供持续的父子 Transform 继承或整组缩放。

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
## 数据中台图表库同步

- 图表库同步只认当前工程目录中的数据中台项目绑定。绑定存在时，通过 `POST /api/v1/projects/{projectId}/config/screens/query` 分页读取该项目关联的大屏；未绑定的本地工程不访问数据中台，并显示空图表库。
- 每个绑定大屏只保留项目 ID、大屏 ID、名称和编码等卡片元数据，不读取或保存 `jsonContent`，也不解析其中的 widget 图表配置。
- 同步索引按项目隔离并原子替换；任一分页请求或返回数据校验失败时整批失败，继续使用该项目上一次成功同步的图表库。项目切换后，旧任务的迟到进度和结果不会覆盖当前项目。
- 当前图表库同步绑定项目的完整大屏，卡片可以拖入 POI 图表立标或其 Inspector 大屏槽位。拖到场景空白处不会创建大屏或覆盖相机视窗。已有场景中的 `viewportScreen` 和 `dataPlatformScreen` 数据继续兼容；沿用现有数据中台访问权限。
- 大屏与三维对象通过 `postMessage` 双向联动：大屏可发送 `zending.data-platform-screen.bridge` v1 的 `screen.selectEntity`、`screen.focusEntity` 或 `screen.clearSelection`，目标可使用 `entityId` 或唯一 `assetCode`；Viewer 将三维点击结果回传为 `viewer.selectionChanged`。消息仅接受来自对应大屏 URL origin 且 source 为对应 iframe 的事件，不把 `jsonContent` 或内部 widget 配置写入场景。

## GLB 标准预览与默认环境照明

新建场景默认带有与 Babylon Sandbox 同款的离线环境，普通模型与环境模型共用，同时保留可编辑的主光、补光等默认设置以保持基础对象可见。显式应用标准预览后关闭额外主光、补光及烘焙应用，建立材质预览基线。已有场景继续保留原配置；在“光照与烘焙管理器”的“光照预设”中选择“GLB 标准预览（对齐 Sandbox）”，点击“应用配置”后才切换，并可一次撤销。照明来源、独立旋转与强度会保存并随本地发布保留；隐藏天空背景不撤下内置照明。完整参数与兼容说明见[光照指南](docs/hybrid-lighting.md)。

## 数据中台天空盒同步

- 从首页打开数据中台业务项目时，编辑器先进入已经绑定的数字孪生工程，再在后台同步数据中台天空盒资源；查询或下载延迟不会阻塞项目打开。本地项目不会自动联网，只能在 Project 面板的天空盒 Tab 手动发起同步。
- Project 面板会合并本地天空盒与数据中台天空盒；即使名称相同也分别显示且本地资源优先。数据中台资源使用稳定 `dataPlatformResourceId` 标识，按 `revision` 与 SHA-256 增量更新，并发下载上限为 `2`，单个文件最大 `512 MiB`，单次同步计划最大 `8 GiB`。
- 同步采用整批校验与原子切换：任一分页、下载、格式或 SHA 校验失败时继续使用旧资源库，并在天空盒 Tab 显示失败状态与重试入口；再次同步未发生变化的资源不会重复下载。
- 数据中台以同一稳定 ID 替换天空盒后，已引用该资源的场景会重新关联到新文件，同时保留强度、分辨率、旋转和天空盒实体 Transform；该变更进入正常 dirty/undo 历史。远端删除资源后，新选择列表会隐藏对应卡片，但已打开场景仍可使用标记为 orphaned 的兼容缓存。
- SOURCE ZIP、Viewer DIST ZIP 和独立部署导出只包含场景实际引用的天空盒，并把资源 URL 改写为包内离线路径；Viewer 不依赖数据中台即可运行。若场景引用的 orphaned 兼容缓存已经缺失或校验失败，发布会明确失败，而不是生成缺少资源的包。 SOURCE ZIP 同时携带原始 HDR/EXR 与 ENV，便于继续编辑和重建；Viewer DIST ZIP 与独立部署只携带 ENV，场景中的原图字段清空并标记 `sourceAvailable=false`。Viewer 模板通过 manifest 的 `sceneFileVersions`/`skybox` 能力声明支持原生 ENV，缺少该能力的旧模板会在导出前被拒绝。

## 场景 Web 部署导出

Toolbar 的 `📦 导出部署工程` 会捕获当前内存场景，通过与保存、发布相同的序列化入口生成一次幂等合批快照，再自动收集普通模型、模型生成器目标、环境、天空盒、DXF、模型脚本、贴图及独立光照烘焙产物，输出可部署目录或 ZIP。该离线部署包能力继续保留，并与 `发布到数据中台` 相互独立；导出结果使用独立只读 Web Viewer，直接消费快照中的合批关系，不包含编辑器界面和 Electron 运行环境。

部署包通过根目录 `runtime-config.json` 外置页面、资源和 MQTT 配置；修改 JSON 后刷新页面即可生效。真实 MQTT 仅支持 `ws://` / `wss://`，静态 JSON 不应保存用户名、密码或长期 Token。部署包必须通过 HTTP/HTTPS 静态服务器访问，不支持直接双击 `index.html`。Viewer 要求浏览器启用硬件加速 WebGL，不再静默降级到软件 renderer；无法获得 GPU 时会在页面状态层显示明确错误。 Viewer 打开页面后立即显示与编辑器一致的品牌加载蒙版（ZENDING Logo 蓝色填充、蓝色进度条与百分数），覆盖配置读取、场景文档解析、引擎创建、模型与环境资源加载全过程，全部就绪后才消失；首次资源加载超过 120 秒仍保留超时提示与未完成状态，真实资源结算后才允许依赖完整场景的巡检启动；天空盒和首帧验证错误优先展示错误状态层。正常完成必须由实际首帧验证触发界面重绘，空场景也执行该验证。

完整目录结构、配置字段、CSP、外部资源、安全边界和部署说明见 [场景 Web 部署导出](docs/scene-web-export.md)。
## Windows 安装包构建与安装

项目使用 Electron + electron-builder 生成 Windows x64 NSIS 安装包。生产构建使用相对资源路径，因此安装后由 `file://` 加载 renderer 时，React 页面、Babylon.js 分块、CAD Worker、样式和图片仍可正常读取。GPU 启动开关和 Scene View 硬件 WebGL 严格校验位于打入 `app.asar` 的生产代码中；Windows 免安装目录和 NSIS 安装后的程序还会按企业部署策略关闭 GPU sandbox，开发态继续保留该 sandbox。正式包不绕过 Chromium GPU blocklist，也不固定 `use-angle` 后端。

### 构建环境

- Windows 10/11 x64
- Node.js `^22.15.0 || >=24.0.0`
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
- 数据中台工程打开时，Windows 对刚解压或替换目录的短暂 `EPERM/EACCES/EBUSY` 占用会自动重试（七档等待合计最多 4.35 秒）；持续失败保留错误并恢复旧工程，回滚不完整时报告并保留恢复目录。首次失败只留下已知空初始化目录时可直接重新打开；未绑定目录中存在文件、未知目录或链接时仍拒绝覆盖。
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

开发模式本地模型库默认沿用存在的 `F:/3d-models`，否则仅使用 workspace。可在项目根 `.env.local` 设置 `STACKER_MODEL_LIBRARY_ROOT=F:/your-model-library`（也支持相对项目目录）；显式进程环境变量优先。该变量只供开发服务器读取，不暴露给客户端。
