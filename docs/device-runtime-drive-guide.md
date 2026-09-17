# 设备运行时驱动指南（conveyor / rgv / stacker / shuttle / shelf / lift）

面向设备功能扩展的总览文档。梳理 6 类设备在运行预览时如何被**参数化配置、MQTT 消息、fetch 响应**驱动，覆盖**动画、时序、状态机、设备间交接**四个维度。

> 修改任何一类设备行为前，必须同步更新本文档。行号引用以 master 分支为准，改代码后应立即修正对应条目。

## 总览：数据流与编排层

```
MQTT broker ──topic 路由──┐
                          ├→ deviceTelemetryStore (快照键 sourceId:deviceType:assetCode)
                          │     └→ SpecializedTelemetryRuntime.applyFrame (每帧)
参数化 (modelParameters / telemetryBinding / dataDriven) ─┐        ├→ conveyorDriver / rgvDriver / stackerDriver / shuttleDriver / liftDriver
                                                        ├→ 各 driver 的 applyToModel
fetch (LocatorFetchRuntime, 事件驱动) ────────────────────┘        └→ 货物表 stacker/conveyor/rgv/shuttle/liftCargoMeshes (全局共享)
                                                                          └→ 门面仲裁交接 adoptGlobalCargoByTask / placeCargoIntoConveyorPlatform / deliverRgvCargoToConveyorColumn / deliverLiftCargoToConveyorLayer
```

### 设备类型识别

- 模型包签名：`specializedModelAssets.ts` 中 `isConveyorModelAsset`(:21)、`isStackerModelAsset`(:39)、`isRgvModelAsset`(:52)、`isShuttleModelAsset`、`isLiftModelAsset`，按 assetCode/sourcePath/脚本 metadata 匹配关键字。
- 运行时判定：`resolveSpecializedTelemetryDeviceType`（SpecializedTelemetryRuntime.ts）— 实例 `telemetryBinding.deviceType` 优先，否则按注册顺序 stacker→conveyor→shuttle→rgv→lift。**shuttle 必须排在 rgv 前**：多穿小车脚本 metadata 含「穿梭车」会误中 `isRgvModelAsset`。
- shuttle 的 `isShuttleRuntimeModel` 仅按脚本 `dataDriven.device.devType==='shuttle'` 判定（该模型必有脚本，不加 ModelRuntimeEntry.capable 标志位）。
- lift 双保险：`isLiftRuntimeModel` 仅按脚本 `devType==='lift'` 判定（同 shuttle 策略），`ModelRuntimeEntry.liftCapable`（资产签名）仅用于编辑态解锁绑定 UI；「提升机」中文签名不进运行时判定，防止误接管。
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

- `SpecializedTelemetrySharedState`（types.ts）：五张全局货物表 `stacker/conveyor/rgv/shuttle/liftCargoMeshes`，即全局货物注册表。货物条目 `GeneratedCargoRuntimeEntry`，`task` 为全局唯一身份。
- 交接插值统一 `resolveCargoHandoffPose`（types.ts），时长 `CARGO_HANDOFF_SECONDS=1.0`。
- 交接只平移不旋转：`cargo.lockedWorldRotation` 全生命周期锁定，在 `setGeneratedCargoRootPose`（SceneRuntime.ts）首次**稳定**位姿写入时建立——handoff 插值期间不锁定，插值完结帧返回精确目标朝向时才 `??=` 落锁，避免把 slerp 中间角（大 dt 帧下可达 30°~60°）永久锁定。
- `createCargoHandoffState` 对从未写过位姿的新货物（`root.rotationQuaternion == null`）返回 null 不建插值：新货直接在目标位姿落位，避免从世界原点飞入 / 从 Identity 自旋，同时保证首次写入即稳定位姿。
- 门面方法：`adoptGlobalCargoByTask`(:239)、`placeCargoIntoConveyorPlatform`(:281)、`deliverRgvCargoToConveyorColumn`(:305)、`adoptConveyorCargoForLift` / `deliverLiftCargoToConveyorLayer` / `resolveConveyorDeckSurfacePoint`（SpecializedTelemetryRuntime.ts）。

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

### 编辑态轨迹线（Toolbar「动画」）

- 链路：Toolbar `trajectoryVisible` → `SceneRuntime.syncConveyorTrajectory`（:5577）→ `resolveConveyorTrajectoryContext`（:5632）→ GreasedLine 虚线+箭头（`createConveyorTrajectory` :5675）。
- 位置口径：中心/面高/行程全部来自 `cargo.travel.nodes` 行程节点包围盒（中心、行走轴投影跨度、顶投影+surfaceOffset），与 conveyorDriver 同源——轨迹线高度即货物支撑面高度。
- 行程节点选型（辊道输送线 = `["GD_7","GD_4"]`）：GD_7 辊面提供面高、GD_4 主轨提供行程跨度；**勿用父节点 GD**——其下挡板 GD_3 顶（+0.12m）会抬升轨迹线悬浮，电机 DG 拉偏横向中心；`filterTopLevelMotionNodes` 会让 GD 吞掉 GD_7。
- 注意：`getNodesWorldBounds` 不过滤隐藏/非对称部件（电机、隐藏的克隆源原件、薄实例 host 包围盒），行程节点须选几何干净的对称件。

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
- **rgv 列放货**：`acceptRgvColumnPlacedCargo`(:1069)，由 rgvDriver.ts:537-550 发起。

### 扩展点
新 MQTT 字段 → `applyConveyorCargoMotion`(:141) 内 read 系列；新配置键 → specializedModelAssets.ts 读取器 + `ConveyorCargoTravelConfig`（types.ts:375-382）；新交接对象 → `SpecializedTelemetryDriverContext`（types.ts:467-502）加方法经门面接入。

### 变体：虚拟输送线（内置模型包）
针对复杂复合模型承载多个上报设备的拆分场景，编辑器内置「虚拟输送线」：长方形平面（GLB 1×0.05×1 m，单 mesh `VCConveyorBelt`），运行时行为与真实 conveyor 完全一致（conveyorDriver 零改动）。详见 `docs/virtual-conveyor-design.md`。
- **来源与分发**：模板 `public/builtin-model-packages/virtual-conveyor/`（随编辑器分发，打包经 extraResources）；首次放置时 IPC `assets:importBuiltinModelPackage` 自动导入项目 `Assets/Models`；前端入口 `ensureVirtualConveyorAsset`（src/editor/assets/virtualConveyorAsset.ts，模型库卡片与场景拖拽共用）。
- **设备识别**：meta.json `dataDriven.device.devType='conveyor'` + `defaultAssetCode='VirtualConveyor'`（assetCode 含 "conveyor" 命中 `isConveyorModelAsset`）→ 自动解锁 Inspector 绑定区（TelemetryBindingInspector / CargoGeneratorInspector / ModelParametersInspector）。
- **参数**：`length`（x 向长度，默认 2 m）、`width`（z 向宽度，默认 1 m）、`color`（材质色，默认 #8a97a5）；厚度固定 0.05 m。参数化脚本绕底面中心原点缩放 + 乘色（rememberBaseMaterial 快照基线）。
- **与真实 conveyor 的差异**：`cargo.travel.nodes` 留空 → 行程回退整机包围盒（板面即行程区）；支撑面走包围盒顶面兜底（板顶 0.05 m 精确）；无专属滚筒/链条动画（虚拟输送线本无动画节点），仅货物运动。

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
- 坐标：conveyor 对齐取载货面中心 `resolveConveyorDeckCenterWorld`（conveyorDriver.ts:999）；交接侧缘 `getRgvTransferEdgePose` 沿局部 X 偏移整台面宽(:632-651)。

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
| `telemetryBinding.stackerCargoGapY` | telemetryBinding.ts:56,236，读于 :989 | 货叉瞄准基点相对货格支撑位的竖直偏移 -1~1：只计入升降目标（:395-404），叉顶面定位到支撑位+间隙（插入货物底部货槽）；货物落位保持支撑位不变 |

### MQTT 消费
- `front_x/front_y/front_z` = 列/层/排当前库位(:120-122，全 0=空闲)；`to_x/to_y/to_z` = 目标库位(:147)，仅决定行走/升降终点。
- `front/back_command`：1 取货中 / 2 取货完成 / 3,4 放货中 / 5 放货完成 / 8 急停(faulted)。
- `front/back_movement_z`：1/3 伸、2/4 收(:483-484)；`front/back_rpm_z` 叉速。
- **mode==4 时 command 不可靠**：改用 `front_signalBits` 第 17 位（2^17=131072，types.ts:27）前一帧样本锁存取/放(:192-228)。
- `${side}_task`（全局货物身份）、`${side}_containerCode`(:1080-1089)。

### fetch 响应（唯二消费 fetch 的设备之一）
放货完成 `keepCargoForFetchRowSync` 保留 MQTT 货箱 → `handleFetchRowSync(row)` 单排 POST(SceneRuntime.ts:947-968) → 响应应用后 `clearSuppressedCells` 并销毁保留货(:961-966)，避免网络延迟空窗。取/放期间 `suppressFetchCell` 抑制该格口 fetch 渲染(stackerDriver.ts:770)。

### 动画
每帧 `applyToModel`(:79)。行走/升降/叉伸缩均为**速度插值**（非直接定位）：`moveVectorTowards`(:429)、`moveNumberTowards`(:462)；例外：首帧吸附 `snapStackerToTargetOffsets`(:275)、catch-up 强制收尾。货叉总偏移 50/50 拆一/二段(`splitForkOffset` :616)。货物绑定叉尖时每帧锚定二段叉顶面中心（:968-977）；`stackerCargoGapY` 只计入升降瞄准基点（:395-404），叉顶面定位到支撑位+间隙（插入货物底部货槽），货格落位保持支撑位（:1008-1013，与货架/站台自身渲染同源）。取货绑定时锁存「持货位 − 叉面锚点」偏移、放货携带固定挂槽偏移 −gapY（`bindStackerCargo`/`beginStackerPlaceWithCargo`）：货叉插入货槽不推动货物，绑定/落货全程零跳变。**本体移动与伸叉互斥**(:492-496)。世界偏移经 `offsetNodesFromBaselineByWorldOffsets` 转父级本地(:1561)。

### 时序（取/放节拍）
command 1 + movement 伸叉开始帧 → 当前格刷货 `beginStackerFetch`(:669-671) → 叉到目标行程（余量 2cm :734-740）→ `bindStackerCargo`(:694-696) → command 相位离开 `completeStackerFetch`(:888-902) → 运载 → command 3/4 伸叉到位 → 解绑落入箱位 `unbindStackerCargo`(:696) → 收叉（收叉期叉未到位则每帧幂等重试 :702-708）→ 相位退出 `completeStackerPlace`(:903-907)。模拟器节拍：8s 周期（StackerTelemetrySimulator.ts:273-287）。

### 状态机
每侧货叉独立：`frontCargoKey`(无货) → 刷货滞留格 → `frontCargoBoundToFork=true`(随叉) → 解绑 `holdPosition`(箱位)。辅助态：`forkCatchUp`（库位跳变强制收尾，收叉前冻结平移/升降，:99-105,:235-272）、`frontSignalAction/Extended`(mode4 锁存)、`mismatch`（库位失配禁伸叉 :131）、`frontCargoPendingPlatformLocatorId`(mode4 延后站台交接)。全量字段见 `StackerModelTelemetryState`（types.ts:175-243）。

### 交接
- **conveyor→stacker**：取货格为 conveyor 内置站台货格时 `adoptConveyorPlatformCargo`(:761) → 门面 → conveyorDriver `adoptPlatformCargoForStacker`(:973)，无视 task 接管并广播 taken。
- **stacker→conveyor**：放货解绑 `placeCargoIntoConveyorPlatform`(:877/:935)，预检 `canAcceptPlatformPlacedCargo`（conveyorDriver.ts:1010）；mode4 延后到收叉停止边沿(:712-717)。
- **全局按 task**：`adoptGlobalCargoByTask`(:1081) 扫全部货物表跨设备接管；conveyor 拉货受 `isStackerCargoPendingPlatformHandoff` 门控（conveyorDriver.ts:383）。
- 库位键 `JSON.stringify([frontX,frontY,frontZ])`(:127)；排-列-层经 `resolveLocatorBoxIndex`（stackerStorageLocation.ts:45）换算，支撑位=格底面中心世界坐标(:139)，与叉锚点对齐保证交接无跳变。

### 扩展点
新 MQTT 字段无需改解析层（e/p/v 通用），在 `applyToModel`(:79) 增消费点；新动作时序改 `applyStackerForkCargoMotion`(:651) 与 `completeStackerCargoOnPhaseExit`(:888)；新交接对象在 `SpecializedTelemetryDriverContext`（types.ts:467-502）加方法。

---

## 4. 多穿小车 shuttle

堆垛机的水平裁剪版：仅 Z 轴水平走行（无升降，**层变化直接闪现对齐目标格层高位**），货叉沿模型 X 轴伸缩。**两段式货叉按比例联动**：一段（`stage1Nodes`）行程为总行程一半、二段（`stage2Nodes`）为全行程，同步启动同步到位（二段速度 = 一段 2 倍）。**环抱式载货**（非托起）：夹抱臂从货物前后两侧夹取，货箱几何中心锚定二段叉几何中心（水平），货物底面贴合**载货平面**（`cargoDeckNodes` 包围盒顶面）——载货平面即整车 Y 层对齐基准，与货格支撑位持平，夹取/收回全程货物高度不变。**库位匹配双路**：先按 Locator `deviceAssetCode` ↔ 小车 assetCode（设备绑定），未命中回退 Locator `aisleCode` ↔ 模型参数 `aisleCode`（巷道匹配）。

### 参数化配置
| 配置 | 位置 | 语义 |
|---|---|---|
| 模型参数 `aisleCode` | 模型包 modelParameters / parameterValues | 巷道编号：设备绑定货格未命中时的回退匹配；空值不参与巷道匹配（一次性告警） |
| Inspector `travelSpeed/forkSpeed` | parameterValues，shuttleDriver `readShuttleInspectorSpeed` | 速度覆盖，优先级最高（forkSpeed 为二段速度，一段减半） |
| `dataDriven.motion.travel.speed` | 模型包脚本 | 走行速度缺省，常量兜底 1.0 m/s |
| `dataDriven.motion.fork.speed` | 模型包脚本 | 伸叉速度缺省 0.25 m/s |
| `dataDriven.motion.fork.stage1Nodes` | 模型包脚本 | 一段叉节点（对象004/对象003），行程减半联动 |
| `dataDriven.motion.fork.stage2Nodes` / `fallbackPattern` | 模型包脚本 | 二段叉节点（对象001/cha1/cha2/huocha1），货箱水平锚点 / 兜底正则 |
| `dataDriven.motion.cargoDeckNodes` | 模型包脚本 | 载货平面节点（对象020/021/022）：环抱收回后承载货物底面的台面板件，其包围盒顶面为货物竖直基准与 Y 层对齐基准；未声明回退二段叉顶面（托起式） |
| `dataDriven.fixedNodes` | 模型包脚本（可选） | 固定轨道节点；缺省整车行走、无轨道约束 |
| Locator `deviceAssetCode` 或 `aisleCode` + `rowNumber/startColumn/startLayer/columns/layers/columnReversed` | SceneRuntime 设备/巷道索引 | 货格网格 |

### MQTT 消费
Status 单字段状态机，无 command/movement/mode 体系。
- `x/y` = 当前列/层（仅诊断日志）；`to_x/to_y/to_Depth` = **当前动作阶段的目标货格**（装货时=取货格，卸货时=放货格）；`to_x/to_y` 全 0 或缺失 = 无目标。
- `to_Depth` 位编码排号：1→排1、2→排2、4→排3、8→排4；非法值一次性告警并忽略本次目标（`to_z` 弃用）。
- `Status`：0 待机 / 1 装货（货：货格→小车，装完即完结）/ 2 卸货（货：小车→货格）/ 3 移动中。
- `task`、`containerCode`：货物身份（全局 task 接管用，缺失则匿名自建）。

### fetch 响应
与堆垛机一致：放货完成保留 MQTT 货箱 → `handleFetchRowSync(row)` 单排同步 → 清抑制并销毁保留货；取/放期间 `suppressFetchCellForLocator` 抑制该格口 fetch 渲染。放货排号取本次 `to_Depth` 解码值。

### 动画
每帧 `applyToModel`（shuttleDriver）。走行为**速度插值**（`moveVectorTowards`），**仅 Status=3 期间**向目标格支撑位推进，首帧吸附；Y 不走动画，有目标格时每帧直接闪现对齐目标格层高位（载货平面顶面与货格底面持平，未声明 `cargoDeckNodes` 时回退货叉顶面）。**无轨道约束**（整车行走，除非 dataDriven.fixedNodes 声明轨道）。货叉目标行程 = 叉心对准货格支撑位（方向由货格几何相对叉心的 X 投影符号决定），不按叉长钳位、允许悬空，无货格几何时回退叉节点实测全行程（测不出则不伸叉）。**走行与伸叉互斥**：Status=3 期间叉强制收回原点；Status=1/2 须车体对准目标格（到位余量 2cm）才伸叉；目标位失配/非法 to_Depth 冻结走行与伸叉。库位跳变触发 catch-up（4 倍速收叉，收完前冻结走行）。

### 时序（取/放节拍）
Status=1：车体停驻 → 目标格刷货/接管（含 conveyor 站台接管）→ 两段叉同步伸出 → 伸满绑定（货水平锚定二段叉几何中心、底面贴载货平面顶面，随叉收回）→ 自动收叉完结。Status=3：运载（层变化闪现）。Status=2：无货先补建并绑定 → 两段叉伸出 → 伸满解绑落目标格支撑位（conveyor 站台当场交接）→ 收叉完结。Status 相位退出边沿兜底收尾（防报文丢帧），故障冻结。

### 状态机（ShuttleModelTelemetryState, types.ts）
单叉单货：`cargoKey`(无货) → 刷货滞留格 → `cargoBoundToFork=true`(随叉) → 解绑 `holdPosition`(箱位)。辅助态：`lastStatus`（相位边沿）、`forkPhase`（idle/extending/retracting 内部节拍，替代旧 movement 字段）、`statusActionDone`（相位完结闩锁：同相位不重复刷货/伸叉，Status 变化复位）、`forkCatchUp`、`cargoFetchRow`（放货排号锁定）、`cargoBaseHomeY`（Y 闪现基准：载货平面顶面无偏移世界高度，未声明 cargoDeckNodes 时为二段叉顶面）。`forkOffset` 为二段总行程偏移，一段偏移 = forkOffset/2 派生，不单列状态。

### 交接
- **conveyor→shuttle**：取货格为 conveyor 内置站台货格时 `adoptConveyorPlatformCargo`（门面共用，assetCode 参数通用）。
- **shuttle→conveyor**：放货解绑 `placeShuttleCargoIntoConveyorPlatform`（镜像 stacker 版，detach 来源为 shuttleCargoMeshes，失败放回）。
- **全局按 task**：`adoptGlobalCargoByTask` 扫四张货物表；conveyor externalPulls 可拉 shuttle 持货（无额外门控，同 stacker 非 mode4 语义）。
- 库位键与支撑位公式同 stacker（stackerStorageLocation.ts 复用）。

### 扩展点
新 MQTT 字段在 `applyToModel` 增消费点（e/p/v 通用解析层不动）；Status 节拍改 `applyShuttleStatusPhase`；fork 节点分组/行程与载货平面经模型包 dataDriven（`stage1Nodes`/`stage2Nodes`/`cargoDeckNodes`）调整，无需改驱动代码。

---

## 5. 货架 shelf

### 参数化配置（模型脚本 `shelf.model.ts`）
| 配置 | 位置 | 默认 |
|---|---|---|
| `layerCount` / `columnCount` | :30/:33 | 1 / 1（上限 20/100，:180-181） |
| `cellWidth` / `cellHeight` / `cellDepth` | :36/:39/:42 | 0.801 / 4.525 / 1.183 m |
| `supportLegHeight` | :45 | 0.904 m |
| `doubleDeepEnabled` / `deepSlotGap` | :52/:55 | false / 0.2（双排深位） |
| `enableBuiltInSlots` | :58 | false，开启后派生内置货格 |
| `slotColumnRatio` | :61 | 1（1..8），1 个实物货格列向分裂的逻辑列数：逻辑列数 = columnCount × ratio、逻辑格宽 = cellWidth / ratio，物理结构不变；`to_x` 按连续逻辑列号寻址 |
| `bodyColor` / `beamColor` | — | 本体/横梁颜色 |

货格 LocatorComponent（components.ts:58-78）：`length/width/height`、`columns/layers`、`startColumn/startLayer`、`columnReversed`、`columnGap/layerGap`、`deviceAssetCode`（绑堆垛机）、`rowNumber`（排号）、`storageDepth:'near'|'far'`、`fetchDrive:{enabled, cargoGeneratorId}`。内置绑定声明 `builtInSlotBinding`（shelf.model.ts:140-154，`dimensionMapping` 派生维度，`columnSplitParam` 声明列向分裂比例参数）。

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

## 6. 物料提升机 lift

RGV 的垂直版：RGV 水平绑定「列」（columnBindings），lift 垂直（Y 轴）绑定「层」，分**来料层绑定**（incomingLayerBindings，取货上台）与**送料层绑定**（outgoingLayerBindings，放货下台）。单车单货（同 shuttle），货物随载货台升降。

### 参数化配置
| 配置 | 位置 | 语义 |
|---|---|---|
| `telemetryBinding.incomingLayerBindings` | telemetryBinding.ts | 来料层号(正整数字符串) → conveyor 实体 ID 数组（同层可绑多台） |
| `telemetryBinding.outgoingLayerBindings` | telemetryBinding.ts | 送料层号 → conveyor 实体 ID 数组 |
| Inspector `liftSpeed` 参数 | modelAsset.parameterValues | 载货台升降速度，优先级最高（同 stacker `readStackerInspectorSpeed` 链路） |
| `dataDriven.motion.lift.speed` | 模型包脚本 | 速度缺省值 0.3 m/s，最终回退 types.ts `LIFT_DEFAULT_LIFT_SPEED_METERS_PER_SECOND` |
| `dataDriven.motion.lift.nodes` | 模型包脚本 | 载货台随动节点名（全量升降件）；查找兼容参数化 ThinInstance 克隆（`metadata.motionSourceNodeName`） |
| `dataDriven.cargo.nodes` | 模型包脚本 | 载货面节点名（滚筒组）：货物锚点与层对齐口径，缺省回退 motion.lift.nodes 全集（同 RGV cargo.frontNodes 的 motion/cargo 分离） |

升降行程不配 limits：完全由模型物理尺寸约束（整机静态框架 × 载货台随动件基线投影交集，同 stacker `clampStackerLiftOffset` 去掉配置侧后的语义）；约束不可用时保持 [0, +∞)。

货物锚定载货面节点包围盒顶面中心，台升货自升（不 parent）；载货面之外的随动件（立柱/护罩等）不进锚点包围盒。

### MQTT 消费
- `reference_upper_step`：1=来料侧（选 incomingLayerBindings），2=送料侧（选 outgoingLayerBindings）；其它值忽略。
- `level_upper`：该侧目标层号（正整数），与绑定表键匹配。
- 两字段经 `normalizeLiftCompatibleFields`（deviceTelemetry.ts）原地 `Math.trunc` 归一为整数。
- **`movement_y` 不存在于协议**：载货台运动完全由目标层驱动，脚本 `motion.lift` 仅保留 speed/nodes 供驱动读取。
- **lift 无 task 字段**：来料侧取货「见货就拉」（同层多台取首个持货候选）；送料侧仲裁完全依赖目标 conveyor 自身 MQTT 的 `pendingTask/waitingTask`。

**不消费 fetch**。

### 动画
载货台 Y 速度插值：`liftOffset` 按 `moveNumberTowards(speed×Δt)` 逼近 `liftTargetOffset`（= 目标层 conveyor 支撑面世界 Y − 载货面顶面基线世界 Y，同投影到模型 Y 轴），写回载货台节点基线（`worldDeltaToParentLocalDelta` 转父级本地）。货物锚定载货面节点包围盒顶面中心，台升货自升（不 parent）。交接插值时长复用 `RGV_CARGO_TRANSFER_SECONDS`，`resolveCargoHandoffPose` 统一姿态；货箱全程 `lockedWorldRotation` 只平移不旋转。

### 时序
`reference_upper_step/level_upper` 组合键 `${side}:${layer}`（side 内部表示：来料 0 / 送料 1）边沿锁目标层 → 滑向目标支撑面 Y → 到位（`moveNumberTowards` 精确吸附）置 `arrivedTargetKey` → 自动交接：来料层且台上无货 → 每帧幂等尝试拉取绑定 conveyor 持货（无货下帧重试）；送料层且台上有货 → 当场尝试推送交付，无等待方进放货插值并持续重试，**不销毁货物**（区别于 RGV 停转销毁语义）。

### 状态机（LiftModelTelemetryState, types.ts）
`liftOffset`（当前）/ `liftTargetOffset`（目标）/ `targetKey` / `arrivedTargetKey`（到位锁，防重复触发）/ `cargoKey`（null=台上无货）/ `cargoOnBoard` / `transferProgress` / `transferActive` / `cargoHoldPosition/Rotation`（交接另一端）/ `nodeBaselines`（载货台节点基线）。faulted 冻结；断流停摆（无 applyWhenStale）。

### 交接
- **conveyor→lift（来料层取货）**：到位后 liftDriver 经门面 `adoptConveyorCargoForLift(entityId, liftAssetCode)` → 复用 conveyorDriver `adoptPlatformCargoForStacker`（无视 task 接管、发 taken 波），交接插值上台。取货锚点 = **货物在来料输送线上的实际位置**（通常停在紧靠提升机的末端），不取输送线台面中心——否则插值起点落在货物后方半个机身，先向后滑再上台（后摇）。
- **lift→conveyor（送料层放货）**：到位后 `deliverLiftCargoToConveyorLayer(entityId, cargoKey, task, preserveAxialPosition)`（镜像 deliverRgvCargoToConveyorColumn）→ conveyor 预检 `canAcceptRgvColumnPlacedCargo`（task 仲裁）+ settle 入链。`preserveAxialPosition = transferProgress < 1`（对齐 RGV 滞后承接语义）：放货插值已推进属接收方 task 消息滞后的兜底交付，按货物当前轴向投影落地；到位当场交付（progress=1，货仍在台上）保持进入端落地——否则交付成功瞬间货物被拽回进入端（后摇）。
- **externalPulls 兜底**：conveyor 订阅波触达 lift 持货时帧尾拉取，门控 `isLiftCargoReadyForExternalPull` = 到位锁 + onBoard + 非交接中。
- 支撑面口径：`resolveConveyorDeckSurfacePoint` = deck center + upAxis × surfaceLift（surfaceLift 优先脚本 metadata 链面顶 conveyorSurfaceY），与 conveyor 自家货物落点同口径。用途限定：层对齐的目标支撑面 Y 与放货插值终点；**不**作取货插值锚点（取货锚货物实际位置，见上）。

### 扩展点
新 MQTT 字段 → `applyLiftMotion` 内 read 系列；新绑定维度 → telemetryBinding 加字段 + `LiftLayerBindingsEditor`；新仲裁策略 → 候选解析（仿 `resolveRgvColumnCandidates`）+ 门面。

---

## 扩展检查清单

### 改已有设备行为
1. 同步更新本文档对应小节（字段表/状态机/交接链）。
2. 检查是否影响其他设备交接面（6 类设备交接矩阵）：

| 交接 | 发起方 | 仲裁/门面 | 接收方 |
|---|---|---|---|
| conveyor→conveyor | 链路协议 available/taken | 下行泛洪+越级直达 | conveyorDriver settle |
| conveyor→stacker | stacker 取货相位 | adoptConveyorPlatformCargo | conveyorDriver:989 |
| stacker→conveyor | stacker 放货解绑 | placeCargoIntoConveyorPlatform | conveyorDriver:1022 |
| conveyor→shuttle | shuttle 取货相位 | adoptConveyorPlatformCargo | conveyorDriver |
| shuttle→conveyor | shuttle 放货解绑 | placeShuttleCargoIntoConveyorPlatform | conveyorDriver |
| rgv→conveyor 列 | rgv 起转边沿推送 | deliverRgvCargoToConveyorColumn | conveyorDriver:1069 |
| conveyor→lift 来料层 | lift 到位自动拉取 | adoptConveyorCargoForLift | liftDriver |
| lift→conveyor 送料层 | lift 到位推送+持续重试 | deliverLiftCargoToConveyorLayer | conveyorDriver:1069 |
| conveyor→rgv/stacker/shuttle/lift | conveyor externalPulls 帧尾拉取 | isRgvCargoReadyForExternalPull 等门控 | rgvDriver/stackerDriver/shuttleDriver/liftDriver |
| stacker↔shelf 泊位 | stacker 取/放相位 + fetch 单排同步 | suppressFetchCell + keepCargoForFetchRowSync | LocatorFetchRuntime |
| shuttle↔shelf 泊位 | shuttle 取/放相位 + fetch 单排同步 | suppressFetchCell + keepCargoForFetchRowSync | LocatorFetchRuntime |

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
