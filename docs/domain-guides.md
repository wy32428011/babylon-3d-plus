# 领域专题说明（模型 / MQTT / POI）

> 从根目录 README 迁出的参数化模型、MQTT 语义与 POI 专题说明，内容保持原样。

> 2026-10-14 夹具位置更新：下文历史记录中的 `output/playwright/{shelf,stacker,yzj}-assets` 当前对应 [tests/fixtures/model-packages](../tests/fixtures/model-packages/) 下的同名目录。4 个仍在使用的 HTML 验证页也位于该目录；新运行请使用当前路径，历史测量记录保留原路径。

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

## POI 图表立标

- 面板形状支持矩形和 360° 环形。环形是上下镂空的曲面屏，可设置半径（默认 3 m）、内容平铺次数（默认 4；设为 1 时整圈显示一份连续画面）、展开内容尺寸、悬浮高度和青色边框。环形固定跟随实体变换，不启用面向摄像机；切回矩形保留原有设置。旧场景缺省仍为矩形，支持撤销、复制、保存重开和 SOURCE/DIST。
- 环形文字、背景图片及允许 CORS 的视频共用连续曲面纹理；运行时双击环形大屏或视频打开原始内容交互，关闭后保持页面状态。大屏画面每约 1.2 秒按需采集一次，每立标仅一个 iframe，整圈共用最多 2 MP 的纹理；隐藏或删除时释放页面及纹理。
- 实时网页曲面需要同时更新数据中台 Preview/Published 截帧桥，并使用与中台同源的 HTTP(S) Viewer；开发模式另支持本机跨端口。Electron file://、生产跨域或未更新的中台不会获准回传画面，会显示提示，仍可在运行态双击打开原始页面。大屏内的视频、嵌套 iframe、不可读画布用明确占位显示；直接视频模式需要媒体服务器允许跨域访问。


1. 在 `POI库` 点击“图表立标”，或拖到 Scene 画布，生成内置样式标牌：面板默认 `320 × 180 px`（对应 `4 m × 2.25 m`），悬浮高度 `1 m`，默认面向摄像机。 立标面板与指示器不参与物理阴影地面的生成；只有立标时不显示额外地面。新建实体旋转为零，X/Y/Z 变换轴与普通模型一致；面板宽度沿 X、高度沿 Y，立起面板仅改变显示几何。旧场景打开时自动转换坐标基准，保留原位置、朝向和尺寸，重复保存重开不会再次转换。
2. 切换 `图表库`，把已同步的大屏拖到场景中的立标上，或选中立标后拖到 Inspector 的“大屏内容”槽位。需要当前工程已绑定数据中台项目，且大屏具有可访问的 HTTP(S) 页面地址。
3. 标牌实时嵌入完整大屏，编辑态继续允许选中和调整 Transform；进入运行预览或打开发布 Viewer 后可以操作大屏内容。绑定、替换、清空、复制、移动、显隐与锁定沿用场景实体规则，保存重开会恢复绑定。
4. 大屏数据更新频率由大屏自身数据源/远程数据的轮询设置决定；修改大屏设计后，点击 Inspector 的“刷新内容”重新加载。页面加载超时提供提示和可用缩略图，隐藏/删除立标会释放嵌入页面；再次显示时重新加载。
5. “图表面板”可配置文本内容、字号、跑马灯、背景图片/颜色、线形/柱形/无指示器、指示器大小/颜色、面板尺寸、悬浮高度与面向摄像机。尺寸与实体缩放共同决定实际大小；悬浮和朝向只影响显示几何，空间信息与 Gizmo 的 Transform 保持独立。背景颜色默认“无色”（透明），颜色选择器可随时选择“无色”；透明区域显示后方场景模型，旧立标已保存的颜色保持不变。背景图片支持图片库内所有内置及已同步图片（PNG/JPEG/WebP/GIF/SVG），同步本地图片经桌面主进程读取。库内图片按同步上限 20 MB 读取，超大图片自动缩放或压缩至 2 MB、最长边 4096 像素，保留透明通道，SVG/GIF 固化为静态背景；本地上传仍支持 PNG/JPEG/WebP（最大 2 MB、4096×4096）。透明矩形及环形立标会按背景图片分辨率提高纹理精度，新增纹理分辨率受最长边 2048 像素和约 200 万像素限制；原有较大矩形面板不降低自身纹理尺寸。图片内嵌进场景，保存和导出无额外文件依赖，“恢复默认”清除背景图片并保留所选背景颜色。
6. 数据驱动选择 DATA DRIVEN、模型来源及遥测字段名（支持点路径），运行预览/Viewer 显示该模型最新字段值。按资产编号、设备类型和数据源匹配；字段缺失、过期或来源被删除时恢复文本内容。大屏模式继续使用大屏自身的数据源。
7. 点击事件支持增删“鼠标左键点击”事件及多个顺序动作，可配置对象聚焦、主题展示、选中物体和刷新内容。聚焦与选中可分别指定场景对象，目标失效会提示并跳过该动作；每个立标最多 16 个事件，每事件最多 32 个动作。立标不显示额外的事件按钮；运行预览/Viewer 中短按左键点击内置面板触发，右键与相机拖拽不触发；绑定大屏时可点击立标边框触发，大屏内部交互保持独立。选择“主题展示”后，将图表库完整大屏拖入该动作的“目标主题”槽位，支持替换、清空并显示已绑定名称。从数据中台大屏嵌入的数字孪生中触发时，按动作顺序请求外层数据中台切换到绑定的大屏内容；同项目中优先切换对应的引用页，保留公共层中的三维场景。目标未被当前大屏引用时，由数据中台在相同的预览或发布模式打开目标大屏；跨项目目标不执行。单独打开编辑器或 Viewer、未连接数据中台宿主时会提示主题展示不可用。未绑定主题会提示并跳过，继续执行其他动作。
8. 外观及事件配置支持复制、撤销重做、保存重开与独立 Viewer；同批复制的目标引用重映射到新对象，批外目标保留。绑定/替换/清空大屏保留外观和事件设置。旧场景缺省属性保留原朝向、尺寸与无悬浮行为，旧单动作聚焦立标/刷新内容自动兼容。

立标使用场景平面与实时网页深度合成，柱子、墙体等前方模型按实际轮廓遮住对应部分；多个倾斜或相交立标也按局部深度显示。大屏持续实时刷新，运行态可操作未遮挡区域，遮挡处不会穿透点击。大屏模式未绑定时显示拖入提示；清空只移除大屏绑定，保留立标及外观。大屏内部若再次嵌入数字孪生场景，四层及以上宿主页会停止继续加载立标页面，避免无限循环。场景版本保持 `5`，旧大屏与相机视窗大屏保持兼容。

验证：`node --test tests/editor/chartMarker.test.mjs tests/editor/chartMarkerClick.test.mjs tests/editor/chartMarkerDrag.test.mjs tests/editor/chartMarkerRuntime.test.mjs`；`npm run build` 后执行 `node scripts/smoke-chart-marker.mjs`，使用本地实时页面夹具和 Chrome 验证拖放、数据更新、运行预览交互、清空/撤销、刷新及构建后的独立 Viewer，主题动作覆盖拖放替换/清空、非法输入、保存恢复和无宿主提示。构建数据中台前端后执行 `node scripts/smoke-chart-marker-host.mjs <数据中台frontend目录>`，验证预览/发布模式下真实 Viewer 点击切换外层引用页或目标路由，并确认公共三维实例保留、Viewer 内未加载主题。浏览器测试使用接口夹具，截图保存到 `output/playwright/chart-marker/`。

坐标轴回归：`node --test tests/editor/chartMarkerTransform.test.mjs tests/editor/chartMarkerRuntime.test.mjs`；`node tests/editor/chartMarkerGizmo.integration.mjs` 验证真实浏览器 XYZ 拖动、撤销重做、Y 轴高度缩放及 Local/Global 切换，截图保存到 `output/playwright/chart-marker-gizmo/`。

背景回归：`node --test tests/editor/chartMarkerBackground.test.mjs tests/digitalTwin/syncedImageRead.test.mjs`；`npm run build:electron` 后执行 `node tests/editor/chartMarkerBackground.integration.mjs`，使用真实 Electron preload/主进程读取夹具验证各格式拖入、无色切换、撤销重做和保存重开；`node tests/editor/chartMarkerTransparency.integration.mjs` 验证透明背景、半透明图片、前后模型遮挡及动态内容。截图保存到 `output/playwright/chart-marker-background/` 和 `output/playwright/chart-marker-transparency/`。

遮挡回归：`node --experimental-strip-types --test tests/editor/chartMarkerVisibility.test.mjs`；`node scripts/smoke-chart-marker-occlusion.mjs` 验证部分/完全遮挡、模型前后关系、视角变化、交叉立标、跨域点击阻挡、空牌交互及分散立标像素读取范围，截图保存到 `output/playwright/chart-marker-occlusion/`。

POI 视频立标：在“图表面板 → 关联类型”选择“视频”，输入 HTTP(S) 视频直链，失焦或按 Enter 提交。支持循环播放、控制条开关及完整显示/铺满裁剪；默认静音、循环、显示控制条。编辑态显示占位信息且不请求视频，运行或发布 Viewer 场景就绪后尝试自动播放，可通过控制条开启声音；浏览器阻止播放时提供“点击播放”，网络或解码错误可重试。关闭控制条后正常播放区域保留场景操作，播放/重试入口仍可操作。视频保持现有立标的空间变换、模型遮挡与边框点击事件；手动暂停不会被逐帧刷新覆盖，离开视野或标签页后台暂停，返回时仅恢复此前应播放的内容。隐藏、删除、停止运行、切换类型/地址及场景卸载会释放媒体资源，再次显示从头加载。

视频 URL 和设置随场景、SOURCE 与 DIST 保存，切换关联类型保留原大屏绑定及视频设置。视频文件由外部服务器提供，不随发布包下载上传，播放端需能访问该地址；HTTPS 页面应使用兼容的 HTTPS 视频源。使用浏览器支持编码的 MP4/WebM 直链，视频网站观看页面及 RTSP/HLS/FLV 监控流不作为首期通用支持范围。URL 会保存在场景中，请勿包含账号密码或长期敏感凭据。新增能力需升级编辑器、重新构建 Viewer 并重新发布数字孪生，旧发布包不会自动更新。

视频回归：`node --test tests/editor/chartMarkerVideo.test.mjs`；完成 `npm run build` 后运行 `node scripts/smoke-chart-marker-video.mjs`，使用 MDN CC0 WebM 样片（可传入本地 WebM 文件路径）验证真实解码、编辑/运行切换、策略拦截、暂停恢复、错误处理和构建后的独立 Viewer，结果位于 `output/playwright/chart-marker-video/`。随后运行 `node node_modules/electron/cli.js tests/digitalTwin/chartMarkerVideoPublish.integration.mjs` 校验实际 SOURCE/DIST ZIP；本地固定场景验证不代替现场视频源及中台线上部署验收。

## POI 报警管理器

报警参考图中的 12 类外观可在“参考报警样式”直接选择：设备变色、闪烁、呼吸光晕、描边、顶部灯、悬浮图标、光柱、波纹、地面警戒圈、信息卡、烟雾粒子和故障路径。特效库新增其中缺失的 6 种独立 EFF；火焰与火花继续从特效库选择。局部外观预设保留设备本色，需要同时染色时勾选“覆盖设备颜色”；旧场景缺省保持原有颜色覆盖。操作、参数和验证见 [12 类报警外观](alarm-reference-effects.md)。

1. 在 POI 库点击“报警管理器”或拖入 Scene，选中后配置 `POIAlarmSpawnerComponent`。目标 `Size` 支持 0–64 个槽位，调整数量保留已有槽位；从模型库拖入设备模型。`ENTITY` 可再限定具体场景设备，未限定时监听该模型全部实例；`MODEL` 始终监听该模型全部实例。不会因配置目标而创建新的设备。
2. `RUNNING STATE` 监听离线、空闲、运行、报警。沿用目标设备的 MQTT 资产编号、设备类型、数据源与超时配置，读取遥测 `fields.runningState`（兼容 `running_state`、`state`、`status`）；支持英文状态、中文状态和 `0/1/2/3`（离线/空闲/运行/报警）。遥测 `faulted` 为真时优先视为报警；收到过数据后超时视为离线，从未收到数据或设备绑定已禁用时不触发。
3. `CUSTOM PROPERTY` 监听绑定设备的 MQTT 点位：火警属性填写 `data` 中的 `p` 名称，触发值填写该点位希望命中的 `v`。例如 `data:[{p:"fireAlarm",v:1}]` 对应火警属性 `fireAlarm`、触发值 `1`，无需填写数组下标；实时值不会写回触发值。默认仍为 `fireAlarm` / `true`，同名属性优先精确匹配，保留旧点路径兼容；值按去除首尾空格、忽略大小写的标量文本比较。触发值 `true/false` 兼容相应的布尔值和 `1/0`，触发值 `1/0` 仅匹配对应数值或字符串，保留旧场景的单向兼容。启用“仓库告警”后，还监听 `warehouseAlarm=true/1` 或配置的火警条件（CUSTOM PROPERTY 保留最后值，RUNNING STATE 沿用超时判断），优先展示仓库告警主题；只需普通火警时关闭该开关。
4. “外观特效”从特效库拖入 EFF 卡片，不能拖入模型库资源；设备目标槽仍从模型库选取。报警时为每台命中的绑定设备独立显示特效，随设备世界位置和旋转更新：火焰、烟雾、警示灯等位于设备顶部，光圈、光柱、围栏等以设备底部中心为锚点，使用可编辑的米制尺寸。拖入后展开“报警外观属性”，可修改颜色、强度、速度及对应类型的尺寸、透明度和专用参数；这些值仅写入当前报警管理器的外观配置，支持撤销、保存重开和发布。目标绑定及触发仍由报警管理器控制，无需为外观再次配置数据源。轮廓、高亮、全息等模型表面特效直接作用于绑定模型，优先显示自身外观，暂停该设备的普通颜色覆盖和原有模型特效，解除后恢复；其余特效仍叠加报警覆盖颜色。外观为空时显示内置火焰；旧场景已保存的模型外观继续兼容，拖入特效或清空后替换旧外观。场景雾、昼夜切换、镜头跟随及报警/立标/巡检等业务入口不能作为设备局部外观。“摄像机聚焦”开启时，新报警触发一次设备聚焦。报警解除、隐藏目标、停止预览或删除管理器后，清除派生效果并恢复原材质。共享模型中的其它设备不会被染色；受监控设备及其原有批次伙伴会独立渲染，大批量监控时需留意绘制调用增加。
5. “告警主题”“仓库告警主题”可选择已同步的图表库大屏，也支持拖入大屏卡片。发布 Viewer 从同项目的数据中台大屏打开后，通过现有宿主协议展示主题；首条报警早于握手时，保留最新主题，握手完成后仅在报警仍有效时发送。独立打开 Viewer 会提示需要连接数据中台宿主，不会在本地擅自打开主题页面。
6. 启用“显示图表立标”后，可配置分类、图表库/第三方/视频/内置样式、背景图片与颜色、线形/多面体型/图标型、指示器大小与颜色、尺寸、悬浮高度及面向摄像机。图表库嵌入已选大屏；第三方支持 HTTP(S) 嵌入页面，视频使用浏览器原生视频格式，页面嵌入与播放能力取决于内容服务器和浏览器。立标随报警出现和清除，沿用场景深度遮挡。
7. 配置支持撤销重做、复制、保存重开；同批复制的具体设备引用会重映射。发布包和源工程包保存外观特效配置，并收集目标模型、旧版外观模型及关联资源，保留主题引用与内嵌背景图片，不依赖编辑电脑的绝对模型路径。旧场景无报警组件时保持原行为。

MQTT 点位诊断按目标设备分别显示资产编号、设备类型、数据源、当前 `v`、触发值、最后接收时间及未触发原因。编辑态可手动配置；运行预览时展开诊断，每 500 ms 更新当前页（每页 10 台设备），收起或离开运行预览后停止刷新。诊断不会产生场景修改或撤销记录，运行预览中仍可翻页。零设备时分别提示“未配置报警目标”或“未匹配到场景设备”，此时尚未进入点位判断。

模型目标使用中台来源、资源 ID 与包内模型路径匹配，同一模型同步后缓存位置变化仍可监控。普通模型库条目或旧场景缺少身份时，兼容模型包的资源类别、资源 ID 与完整包内路径，因此共享库模型可匹配场景中的固定版本实例；普通本地模型仍按精确资源路径匹配，兼容 URL 编码与修订参数差异，不按名称或文件名猜测。已知来源冲突时不会匹配；来源缺失且同一资源出现多个来源时，仅保留精确路径匹配，或由用户在 `ENTITY` 中选择具体设备。带来源标识的库模型导入场景时会保留稳定身份。配置 `CUSTOM PROPERTY`、火警属性 `normal`、触发值 `true` 后，绑定设备消息 `data:[{p:"normal",v:true}]` 会按自定义条件报警，使用覆盖颜色和配置的外观特效；该模式不受内置 `normal=true` 表示正常的运行状态解释影响。`normal=false` 不匹配该条件，会清除效果（其他独立报警条件仍按各自配置判断）。

设备身份沿用 `sourceId + deviceType + assetCode`；同名 `p` 不跨设备或数据源匹配。原始 EPV 遥测仍按整帧替换；CUSTOM PROPERTY 单独按设备和订阅点位保留本次运行最后一次收到的值。没有新消息、仅更新其它点位或该点位没有 `v` 时均保留当前状态，不因设备超时解除；相同值持续报警且不重复激活，收到不匹配的新值或显式无效值时解除。停止预览、删除管理器或显式清空数据后释放保留状态。普通文档同步保留未变订阅，RUNNING STATE 的离线超时规则保持。报警逐条接收点位更新，并约每 250 ms 评估一次，短于评估间隔且已被后续值覆盖的瞬时脉冲不保证显示。JSON Path 适配器继续使用映射后的字段名；诊断基于共用标准化快照，并非原始点位目录。

验证：`node --test --test-concurrency=1 tests/editor/alarmTargetDrop.test.mjs tests/editor/alarmCustomProperty.test.mjs tests/editor/alarmManager.test.mjs`；`node scripts/smoke-alarm-custom-property.mjs` 验证真实浏览器表单、只读诊断、最后值持续保持、新值解除和分页；`npm run build:electron` 后执行 `node_modules/.bin/electron.cmd tests/digitalTwin/alarmManagerPublish.integration.mjs` 验证部署资源与源工程包；`node scripts/smoke-alarm-manager.mjs` 在 Edge 中验证真实 WebGL 颜色隔离、火焰、立标可见像素、解除恢复和 GLB 外观加载，截图位于 `output/playwright/alarm-manager/`。`node scripts/smoke-alarm-appearance.mjs` 验证完整编辑器的特效库拖放、对应属性编辑、拒绝模型、保存重开、实际尺寸与颜色像素、多设备隔离和停止清理，截图位于 `output/playwright/alarm-appearance/`。新版报警特效需构建并重新发布 Viewer 后才能用于已有线上场景。真实现场 MQTT 与数据中台在线大屏需使用项目实际连接配置联调。
