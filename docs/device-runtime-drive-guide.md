# 设备运行时驱动指南（conveyor / rgv / stacker / shelf）

面向设备功能扩展的总览文档。梳理 4 类设备在运行预览时如何被**参数化配置、MQTT 消息、fetch 响应**驱动，覆盖**动画、时序、状态机、设备间交接**四个维度。

> 修改任何一类设备行为前，必须同步更新本文档。行号引用以 master 分支为准，改代码后应立即修正对应条目。

## 总览：数据流与编排层

```
MQTT broker ──topic 路由──┐
                          ├→ deviceTelemetryStore (快照键 sourceId:deviceType:assetCode)
                          │     └→ SpecializedTelemetryRuntime.applyFrame (每帧)
参数化 (modelParameters / telemetryBinding / dataDriven) ─┐        ├→ conveyorDriver / rgvDriver / stackerDriver
                                                        ├→ 各 driver 的 applyToModel
fetch (LocatorFetchRuntime, 事件驱动) ────────────────────┘        └→ 货物表 stacker/conveyor/rgvCargoMeshes (全局共享)
                                                                          └→ 门面仲裁交接 adoptGlobalCargoByTask / placeCargoIntoConveyorPlatform / deliverRgvCargoToConveyorColumn
```

### 设备类型识别

- 模型包签名：`specializedModelAssets.ts` 中 `isConveyorModelAsset`(:21)、`isStackerModelAsset`(:39)、`isRgvModelAsset`(:52)，按 assetCode/sourcePath/脚本 metadata 匹配关键字。
- 运行时判定：`resolveSpecializedTelemetryDeviceType`（SpecializedTelemetryRuntime.ts:356）— 实例 `telemetryBinding.deviceType` 优先，否则按注册顺序 stacker→conveyor→rgv。
- **shelf 无专用 driver**：是参数化脚本宿主模型 + Locator 组件（`builtInSlotBinding`），由 SceneRuntime 直接驱动渲染。

### MQTT 链路（deviceTelemetry.ts）

- topic：`dt/factory/logistics/{deviceType}/{assetCode}/twindatadriven/joint`（:81）。设备匹配 = assetCode 严格相等。
- payload `data[].{e,p,v}` 展平为字段表（:445-456），e 校验资产编号。
- `createSnapshot`(:344) 生成快照：`currentLocationKey`(front_x·y·z) / `targetLocationKey`(to_x·y·z) / faulted（command=8 或 normal 字段，:432)。
- store 键 `sourceId:deviceType:assetCode`(:276)；stale = 现在 - receivedAt > staleAfterMs（expectedIntervalMs×3 且 ≥2000ms，telemetryBinding.ts:197-199）。
- specialized 侧每帧 `resolveSpecializedTelemetrySnapshot` 拉取，禁止跨源兜底（:57-62）。

### fetch 链路（LocatorFetchRuntime + SceneRuntime）

- 场景级 `FetchConfig{url, apiKey}`（SceneDocument.ts:256-264）。
- **纯事件驱动，无周期轮询**：① 运行预览开始一次全量 `handleFetchDriveEvent`（SceneRuntime.ts:926）；② stacker 放货完成触发单排 `handleFetchRowSync`（:947）。
- 请求 `fetchInventoryRecords`（:971-1005）：POST `{rows}`，响应 `data.records[].result[]`。
- 乱序防护：`latestFetchRequestByRow` 代际戳（:719-720, :960）。

### 参数注入

- 链路：SceneDocument → `entity.components.modelAsset.parameterConfig/Values` → `applyModelAssetParameters`（SceneRuntime.ts:6278），签名比对后重置重放，**参数变化即热更新**。
- driver 侧另直接读 `model.telemetryBinding`（如 stackerCargoGapY、columnBindings、cargoAutoDispose）和模型脚本 `dataDriven` 配置。

### 驱动生命周期

- 注册：`drivers` 数组（SpecializedTelemetryRuntime.ts:60-79），每帧 `applyFrame`（:83-124），由 `SceneRuntime.applyDeviceTelemetryFrame`（SceneRuntime.ts:4567，`telemetryPreviewActive` 门控）调用。
- 开始预览：`beginTelemetryPreview`(:1097) + 基线捕获 `captureReadyTelemetryPreviewBaselines`（SceneRuntime.ts:4578）。
- 结束预览：`endTelemetryPreview`(:1114) → 销毁全部货物(:1131) → fetch 清批(:1133) → 恢复基线 → 重置三类遥测状态(:1143-1166)。

### 共享状态与交接门面

- `SpecializedTelemetrySharedState`（types.ts:391）：三张全局货物表 `stacker/conveyor/rgvCargoMeshes`，即全局货物注册表。货物条目 `GeneratedCargoRuntimeEntry`（:154），`task` 为全局唯一身份。
- 交接插值统一 `resolveCargoHandoffPose`（types.ts:54-67），时长 `CARGO_HANDOFF_SECONDS=1.0`（types.ts:42）。
- 交接只平移不旋转：`cargo.lockedWorldRotation` 全生命周期锁定（types.ts:169-170）。
- 门面方法：`adoptGlobalCargoByTask`(:239)、`placeCargoIntoConveyorPlatform`(:281)、`deliverRgvCargoToConveyorColumn`(:305)。

---

## 1. 输送线 conveyor

### 参数化配置
| 配置 | 位置 | 语义 |
|---|---|---|
| `dataDriven.cargo.travel.axis` | specializedModelAssets.ts:139-171 | 'x'\|'z'，行程轴（默认 x） |
| `dataDriven.cargo.travel.speed` | 同上 | m/s，默认 0.3（types.ts:81） |
| `dataDriven.cargo.travel.fields` | 同上 | 方向字段（默认 `['movement_x']`） |
| `dataDriven.cargo.travel.actionMap` | :213-225 | 字段值→方向（默认 {0:0,1:1,2:-1}） |
| `dataDriven.cargo.travel.nodes` / `fallbackPattern` | 同上 | 行程节点名 / 兜底正则 |
| `dataDriven.cargo.surfaceOffset` | :185-194 | 支撑面微调 |
| `dataDriven.cargo.front/backHasGoodsField` | :197-210 | 光电字段名（默认 front/back_has_goods） |
| `telemetryBinding.trajectoryDirection` | telemetryBinding.ts:51 | 'x'\|'-x'\|'-z'\|'z'，正转=movement_x 正值时的模型本地方向，换算 `forwardSign`（conveyorDriver.ts:1197-1202） |
| `telemetryBinding.cargoOriginDevice` | :273 | 起点刷货 |
| `telemetryBinding.cargoAutoDispose` | :209 | 缺省 false；恒 mode:2 且无 hasGoods 的设备勾选后会每帧销毁滞留货（配置陷阱，勿改代码） |
| `metadata.conveyorSurfaceY` | :1167-1179 | 链面顶高 |

### MQTT 消费
`task`(:167 数值身份)、`mode`（0 空闲退订 / 2 销货 :207）、`movement_x`(:852-872)、光电字段(:148-149)、`containerCode`(:257,:848)。

**不消费 fetch**。仅经 `findBuiltInSlotLocatorForHostModel`(:765-768) 解析内置 1×1 站台货格支撑位。

### 动画
仅货物平移，**本体滚筒/链条不驱动**（:98）。每帧 `cargoTravelOffset += direction × forwardSign × speed × dt`（:342-346），`getConveyorCargoPosition`(:1182-1190) = 中心 + surfaceLift + 轴向偏移。

### 时序
无独立节拍器，帧级 deltaSeconds 积分。行程半径 = span/2 − 货箱实测半长，每帧按模板重钳(:1116-1124)。端点容差 1e-3（:51）。自驱续行在 movement 归 0 后接管(:331-341)。

### 状态机（ConveyorModelTelemetryState, types.ts:290-329）
`cargoCode`（null=无货/等待）、`waitingTask`（等上游交付）、`pendingTask`（新 task 边沿）、`transitedTasks`（已过境）、`platformInboundCargo`（站台钳制）、`cargoDriveEngaged`、`selfDriveDirection`。迁移：task 边沿→刷出/订阅(:227-296)；mode=2+双光电空→销毁(:207-222)；交付 settle(:663-699)。

### 交接
- **conveyor→conveyor**：探测邻居(:805-838) + `available/taken` 下行泛洪、`subscribe/unsubscribe` 上行传递（`dispatchLinkMessage` :397）；越级直达 `runCargoDeliveryRelay`(:621-655)，K 跳仅终点发一次 taken+available，`visited` 防环。
- **外部持货（rgv/stacker）**：无链路能力，经 `externalPulls` 帧尾 `pullExternalHolderCargo` 代交付(:363-394)，门控 `isRgvCargoReadyForExternalPull` / `isStackerCargoPendingPlatformHandoff`(:379-381)。
- **stacker↔conveyor 站台**：locator 事件驱动不经链路 — `adoptPlatformCargoForStacker`(:973)、`acceptPlatformPlacedCargo`(:1000)。
- **rgv 列放货**：`acceptRgvColumnPlacedCargo`(:1047)，由 rgvDriver.ts:537-550 发起。

### 扩展点
新 MQTT 字段 → `applyConveyorCargoMotion`(:141) 内 read 系列；新配置键 → specializedModelAssets.ts 读取器 + `ConveyorCargoTravelConfig`（types.ts:375-382）；新交接对象 → `SpecializedTelemetryDriverContext`（types.ts:467-502）加方法经门面接入。

---

## 2. RGV 有轨穿梭车

### 参数化配置
| 配置 | 位置 | 语义 |
|---|---|---|
| `telemetryBinding.columnBindings` | telemetryBinding.ts:48 | 协议列号字符串 → 同列 conveyor 实体 ID 数组（可多对多） |
| `telemetryBinding.expectedIntervalMs` | :197-199 | staleAfterMs = ×3 且 ≥2000ms |
| `dataDriven.fixedNodes` | rgvDriver.ts:290-295 | 固定轨道节点，缺失回退正则 `/^A(?:3[7-9]\|4[0-6])/i` |
| `dataDriven.cargo.front/backNodes` | :212-219 | 载货台面节点 |
| `dataDriven.motion.travel.speed` | :131-132 | 默认 0.8 m/s（types.ts:82） |

### MQTT 消费
`front_y/back_y` 当前列(:750-753)、`go_column` 目标列（非 0 优先，:93,:108）、`front/back_command`（0 待机/1 取货/2 放货/3 取货准备，:327）、`front/back_movement_z` 滚筒起停转、`front/back_task`、`front_containerCode`(:340)、`faulted/errorCode`(:345,:874)。RGV 无字段归一化（deviceTelemetry.ts:363-381 仅 stacker/conveyor）。

**不消费 fetch**。

### 动画
车体行走 `applyRgvTravelMotion`(:79-141)：`moveVectorTowards` 按 speed×Δt 逼近目标(:133)，轨道约束 `constrainRgvTravelPosition`(:222-236)；行走节点按基线写回(:260-287)。货箱交接插值 `advanceRgvTransfer`(:499-509)，时长 1.5s（`RGV_CARGO_TRANSFER_SECONDS`，types.ts:84），`updateRgvCargoPose` 每帧 Lerp/Slerp(:570-595)。无载货台升降动画——工位锚点取台面包围盒顶面 y(:602-626)。

### 时序
go_column/列号边沿锁行走目标(:112-123) → 滑向目标列 → movement_z 起转=到位 → 取货：command 1/3 `beginRgvFetchTransfer` 侧缘刷出(:403-440) → 插值上车 → command 归 0 `completeRgvFetch`(:376-382)；放货：command 2 `beginRgvPlaceTransfer`(:443-477) → 起转边沿即交付(:360-362) → 停转边沿兜底(:370-374)。

### 状态机（RgvModelTelemetryState, types.ts:343-370）
`frontCargoKey`、`frontCargoOnBoard`、`frontTransferProgress`、`frontLastCommand/frontLastMovementZ`（边沿基线）。迁移全在 `applyRgvForkCargoMotion` 边沿块(:345-389)；faulted 冻结(:345)。

### 交接（同列多台仲裁：推送交付而非订阅传播）
- 同列取全部候选 `resolveRgvColumnCandidates`(:659-682)；偏好选择 `selectRgvColumnCandidateByPreference`(:703-723)：place 匹配 conveyor `pendingTask/waitingTask` 且无货，fetch 匹配持货 task。
- 交付链：`tryDeliverRgvPlaceCargo`(:540-553) → 门面 `deliverRgvCargoToConveyorColumn`(SpecializedTelemetryRuntime.ts:305-319) → conveyor 预检+settle+广播入链。放货在起转边沿即推送，不等订阅传播。
- pull 门控：conveyor 订阅波触达非 conveyor 邻居时登记 `externalPulls`（conveyorDriver.ts:487-501），RGV 持货须 `command==2 且 travelTargetPosition===null`（rgvDriver.ts:556-567）才被拉取。
- 坐标：conveyor 对齐取载货面中心 `resolveConveyorDeckCenterWorld`（conveyorDriver.ts:983-985）；交接侧缘 `getRgvTransferEdgePose` 沿局部 X 偏移整台面宽(:632-651)。

### 扩展点
新 MQTT 字段 → `applyRgvTravelMotion`/`applyRgvForkCargoMotion` + 状态结构；新 dataDriven 配置 → `readRgvDataDrivenNumber`/`readRgvCargoNodeNames`(:889-906)；新仲裁策略 → `resolveRgvColumnCandidates` + 门面；列绑定编辑 UI → TelemetryBindingInspector.tsx:214-228。

---

## 3. 堆垛机 stacker

### 参数化配置
| 配置 | 位置 | 语义 |
|---|---|---|
| Inspector `travelSpeed/liftSpeed/forkSpeed` | stackerDriver.ts:1580 `readStackerInspectorSpeed` | 读 modelAsset.parameterValues，优先级最高 |
| `dataDriven.motion.{travel,lift,fork}.speed` | :1593 | 回退链第二级 |
| 常量默认 0.8 / 0.3 / 0.25 m/s | types.ts:15-17 | 最终回退 |
| MQTT `rpm_*` × `rpmToMetersPerSecond` | :1596-1599 | 实际速度优先（默认 0.01） |
| Locator `rowNumber/startColumn/startLayer/columns/layers/columnReversed/cellSteps/cellSize` | SceneRuntime.ts:458-483 | 巷道/列/层网格不在 stacker 配置，在绑定货格 |
| `travelConstraint` / `liftConstraint` + `dataDriven.motion.lift.limits` | :90,:1344,:1378-1390 | 行走/升降行程钳制 |
| `dataDriven.motion.*.nodes` / `fixedNodes` / `fallbackPattern` | :1478,:1522,:1505 | 轴节点映射；兜底硬编码 huocha2.10(一段叉)/huocha.9(二段叉)(:1450) |
| `telemetryBinding.stackerCargoGapY` | telemetryBinding.ts:56,236，读于 :989 | 货物与叉尖间隙 -1~1 |

### MQTT 消费
- `front_x/front_y/front_z` = 列/层/排当前库位(:120-122，全 0=空闲)；`to_x/to_y/to_z` = 目标库位(:147)，仅决定行走/升降终点。
- `front/back_command`：1 取货中 / 2 取货完成 / 3,4 放货中 / 5 放货完成 / 8 急停(faulted)。
- `front/back_movement_z`：1/3 伸、2/4 收(:483-484)；`front/back_rpm_z` 叉速。
- **mode==4 时 command 不可靠**：改用 `front_signalBits` 第 17 位（2^17=131072，types.ts:27）前一帧样本锁存取/放(:192-228)。
- `${side}_task`（全局货物身份）、`${side}_containerCode`(:1080-1089)。

### fetch 响应（唯二消费 fetch 的设备之一）
放货完成 `keepCargoForFetchRowSync` 保留 MQTT 货箱 → `handleFetchRowSync(row)` 单排 POST(SceneRuntime.ts:947-968) → 响应应用后 `clearSuppressedCells` 并销毁保留货(:961-966)，避免网络延迟空窗。取/放期间 `suppressFetchCell` 抑制该格口 fetch 渲染(stackerDriver.ts:770)。

### 动画
每帧 `applyToModel`(:79)。行走/升降/叉伸缩均为**速度插值**（非直接定位）：`moveVectorTowards`(:429)、`moveNumberTowards`(:462)；例外：首帧吸附 `snapStackerToTargetOffsets`(:275)、catch-up 强制收尾。货叉总偏移 50/50 拆一/二段(`splitForkOffset` :616)。货物绑定叉尖时每帧锚定二段叉顶面中心 + `stackerCargoGapY`(:968-977)。**本体移动与伸叉互斥**(:492-496)。世界偏移经 `offsetNodesFromBaselineByWorldOffsets` 转父级本地(:1561)。

### 时序（取/放节拍）
command 1 + movement 伸叉开始帧 → 当前格刷货 `beginStackerFetch`(:669-671) → 叉到目标行程（余量 2cm :734-740）→ `bindStackerCargo`(:694-696) → command 相位离开 `completeStackerFetch`(:888-902) → 运载 → command 3/4 伸叉到位 → 解绑落入箱位 `unbindStackerCargo`(:696) → 收叉（收叉期叉未到位则每帧幂等重试 :702-708）→ 相位退出 `completeStackerPlace`(:903-907)。模拟器节拍：8s 周期（StackerTelemetrySimulator.ts:273-287）。

### 状态机
每侧货叉独立：`frontCargoKey`(无货) → 刷货滞留格 → `frontCargoBoundToFork=true`(随叉) → 解绑 `holdPosition`(箱位)。辅助态：`forkCatchUp`（库位跳变强制收尾，收叉前冻结平移/升降，:99-105,:235-272）、`frontSignalAction/Extended`(mode4 锁存)、`mismatch`（库位失配禁伸叉 :131）、`frontCargoPendingPlatformLocatorId`(mode4 延后站台交接)。全量字段见 `StackerModelTelemetryState`（types.ts:175-243）。

### 交接
- **conveyor→stacker**：取货格为 conveyor 内置站台货格时 `adoptConveyorPlatformCargo`(:761) → 门面 → conveyorDriver `adoptPlatformCargoForStacker`(:973)，无视 task 接管并广播 taken。
- **stacker→conveyor**：放货解绑 `placeCargoIntoConveyorPlatform`(:877/:935)，预检 `canAcceptPlatformPlacedCargo`（conveyorDriver.ts:988）；mode4 延后到收叉停止边沿(:712-717)。
- **全局按 task**：`adoptGlobalCargoByTask`(:1081) 扫三张货物表跨设备接管；conveyor 拉货受 `isStackerCargoPendingPlatformHandoff` 门控（conveyorDriver.ts:381）。
- 库位键 `JSON.stringify([frontX,frontY,frontZ])`(:127)；排-列-层经 `resolveLocatorBoxIndex`（stackerStorageLocation.ts:45）换算，支撑位=格底面中心世界坐标(:139)，与叉锚点对齐保证交接无跳变。

### 扩展点
新 MQTT 字段无需改解析层（e/p/v 通用），在 `applyToModel`(:79) 增消费点；新动作时序改 `applyStackerForkCargoMotion`(:651) 与 `completeStackerCargoOnPhaseExit`(:888)；新交接对象在 `SpecializedTelemetryDriverContext`（types.ts:467-502）加方法。

---

## 4. 货架 shelf

### 参数化配置（模型脚本 `shelf.model.ts`）
| 配置 | 位置 | 默认 |
|---|---|---|
| `layerCount` / `columnCount` | :30/:33 | 1 / 1（上限 20/100，:180-181） |
| `cellWidth` / `cellHeight` / `cellDepth` | :36/:39/:42 | 0.801 / 4.525 / 1.183 m |
| `supportLegHeight` | :45 | 0.904 m |
| `doubleDeepEnabled` / `deepSlotGap` | :52/:55 | false / 0.2（双排深位） |
| `enableBuiltInSlots` | :58 | false，开启后派生内置货格 |
| `bodyColor` / `beamColor` | — | 本体/横梁颜色 |

货格 LocatorComponent（components.ts:58-78）：`length/width/height`、`columns/layers`、`startColumn/startLayer`、`columnReversed`、`columnGap/layerGap`、`deviceAssetCode`（绑堆垛机）、`rowNumber`（排号）、`storageDepth:'near'|'far'`、`fetchDrive:{enabled, cargoGeneratorId}`。内置绑定声明 `builtInSlotBinding`（shelf.model.ts:137-150，`dimensionMapping` 派生维度）。

**共享实例策略**：带脚本的 shelf 走 **owned-container 独占**（`resolveModelAssetSharedInstancingPolicy`，SharedModelAssetCache.ts:157-180）；仅无脚本纯静态模型才 shared-instance。

### 数据源
**不消费 MQTT**。泊位货物状态全部来自 HTTP fetch；MQTT 仅驱动 stacker，stacker 的 `front_x/front_y/front_z` 经 `findLocatorByDevice`（SceneRuntime.ts:3541-3560）按 `deviceAssetCode + rowNumber + 列/层范围` 命中货格。

### fetch 响应驱动
- 记录格式 `FetchContainerRecord`（LocatorFetchRuntime.ts:16-28）：`containerCode/containerType/isEmpty/row/column/layer/tier/stackingRow/stackingColumn/stackingLayer`。
- `applyRecords`(:89-135)：按 `rowNumber` 过滤 + `!isEmpty` + 排除抑制格口；`matchRule`(:138-151) 按 `attributeName`（空则比 `containerType`）匹配 `ModelGeneratorRule` → 目标模板，缺省 `defaultTarget`，无生成器回退内置 cube。
- 映射：`column/layer` → `getLocatorBoxWorldMatrix`（SceneRuntime.ts:3602-3619）→ 格口底面中心世界矩阵；越界跳过(:298-311)。
- 渲染：按 `targetSignature` 分组合批（`syncBatches` :161-188），逐 mesh 抽顶点烘焙（`createBatch` :191-250），`thinInstanceSetBuffer` 全量重建(:299-325)。

### 动画与时序
货架本体无动画（脚本 onUpdate 仅参数变化时重应用）。fetch 货物显隐为**瞬时**全量重建 thinInstance buffer，无过渡。时序纯事件驱动：预览开始一次全量 + stacker 放货单排同步。

### 状态机
格口态 = fetch 渲染（record 有/无） ∪ `suppressedCellKeys`（LocatorFetchRuntime.ts:69，stacker 取放期间抑制） ∪ `fetchKeptCargoByRow` 保留货（SceneRuntime.ts:723-724）。无"锁定"态。

### 交接（与 stacker 联动）
取货：command 1 + movement 1/3 伸叉瞬间 `beginStackerFetch`（stackerDriver.ts:743-787）刷货并 `suppressFetchCellForLocator`(:770)。放货：command 3/4 锁 `frontCargoFetchRow`(:682-691) → 解绑落箱位 → `completeStackerPlace` → 保留货 → 单排 fetch 拉回 → 解除抑制 → 销毁保留货。

### 扩展点
新 fetch 字段 → 加 `FetchContainerRecord`，`matchRule` 的 `attributeName` 可直接引用新字段配规则，无需改匹配代码；新泊位渲染 → `LocatorFetchRuntime.syncBatches/createBatch` + `SceneRuntime.handleFetchDriveEvent/handleFetchRowSync`；新维度映射 → `builtInSlotBinding` 声明。

---

## 扩展检查清单

### 改已有设备行为
1. 同步更新本文档对应小节（字段表/状态机/交接链）。
2. 检查是否影响其他设备交接面（4 类设备交接矩阵）：

| 交接 | 发起方 | 仲裁/门面 | 接收方 |
|---|---|---|---|
| conveyor→conveyor | 链路协议 available/taken | 下行泛洪+越级直达 | conveyorDriver settle |
| conveyor→stacker | stacker 取货相位 | adoptConveyorPlatformCargo | conveyorDriver:973 |
| stacker→conveyor | stacker 放货解绑 | placeCargoIntoConveyorPlatform | conveyorDriver:1000 |
| rgv→conveyor 列 | rgv 起转边沿推送 | deliverRgvCargoToConveyorColumn | conveyorDriver:1047 |
| conveyor→rgv/stacker | conveyor externalPulls 帧尾拉取 | isRgvCargoReadyForExternalPull 等门控 | rgvDriver/stackerDriver |
| stacker↔shelf 泊位 | stacker 取/放相位 + fetch 单排同步 | suppressFetchCell + keepCargoForFetchRowSync | LocatorFetchRuntime |

3. 检查 fetch 抑制/保留货是否会产生空窗。
4. 检查结束预览清理（`endTelemetryPreview`）是否覆盖新状态。

### 新增设备类型
1. `telemetryBinding.ts:32` 类型表 + `specializedTelemetryBinding.ts:11` 联合类型。
2. `specializedModelAssets.ts` 加识别函数 + 状态工厂。
3. `types.ts` 加状态结构、货物表字段、`SpecializedTelemetryDriverContext` 方法。
4. 新建 driver，在 SpecializedTelemetryRuntime.ts:60 `drivers` 数组注册。
5. SceneRuntime 加 reset 调用(:1143 起) 与遍历清单(:4620-4637)。
6. TelemetryBindingInspector 加绑定编辑 UI。
7. 同步更新本文档新增章节。

### 新增数据源类型
实现 `TelemetryAdapterConfig`（deviceTelemetry.ts:11）经 `MqttSubscriptionConfig.adapter` 接入，或直接向 deviceTelemetryStore 写同构快照并用 sourceId 路由。
