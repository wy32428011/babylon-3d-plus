# Conveyor MQTT 驱动动画逻辑

> 实现：`src/runtime/babylon/telemetry/specialized/conveyorDriver.ts`
> 帧调度：`src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime.ts`
> 状态类型：`src/runtime/babylon/telemetry/specialized/types.ts`（`ConveyorModelTelemetryState`）

## 1. 帧调度入口

`SpecializedTelemetryRuntime.applyFrame(deltaSeconds)` 每帧执行：

1. 按 sourceId/deviceType/assetCode 从 `deviceTelemetryStore` 取该设备的**最新缓存快照**（非新消息，是最后一次收到的状态）
2. 快照判定：
   - 绑定冲突（同一主键匹配多个专用模型）→ 不驱动，报冲突日志
   - 无快照 → 不驱动
   - 快照断流（`now - receivedAt > staleAfterMs`）→ **默认不驱动**；例外：驱动注册项声明 `applyWhenStale` 且返回 true 时仍用缓存快照驱动。conveyor 的判定仅为 `conveyorTelemetry.selfDriveDirection !== 0`（见 §8 接管自驱）
3. 命中驱动 → `ConveyorTelemetryDriver.applyToModel(model, snapshot, delta)`：
   - 节流输出状态/故障日志，写入设备 metadata
   - 货物动画 `applyConveyorCargoMotion` **无论是否故障都执行**（故障只门控其中的走行推进，见 §9）；输送线本体（滚筒/链条）不做任何驱动
4. **帧尾**（全部驱动循环结束后）无条件执行 `conveyorDriver.pullExternalHolderCargo()`：外部持货（stacker/RGV）拉取扫描，**与任何设备快照新旧无关**（见 §7.6）。conveyor 之间的流转由链路协议事件驱动（§6/§7），不依赖帧扫描

## 2. 输入字段

| 字段 | 类型 | 语义 |
|---|---|---|
| `movement_x` | int | 0 静止，1 正转，2 反转（正负数兜底兼容）。实际读取走 `cargo.travel` 的 `fields`+`actionMap`，缺省即 movement_x。**不再门控刷出**：新 task 刷出/复用时若为 0 按正转（1）处理并登记自驱（见 §5.7/§8） |
| `mode` | int | 2=销毁条件（配合双光电无货+勾选自动销毁）；0=空闲（等待方退出等待并退订）；缺省（null）视为运行中 |
| `task` | int | 任务号；缺失/0=无任务（归一化为空串，不触发任何边沿，状态不变）。**匿名模式已移除**：无 task 不再刷出货箱 |
| `front_has_goods` / `back_has_goods` | bool | 前后光电，仅用于 mode==2 的销毁判定（字段名可由脚本顶层 `cargo.frontHasGoodsField/backHasGoodsField` 覆盖） |
| `containerCode` | string | 货箱条码，仅元数据（命名/metadata），不参与身份唯一性 |
| `faulted`（快照级） | bool | 故障门控，见 §9 |

绑定配置（`telemetryBinding`，输送线专用）：

| 选项 | 缺省 | 语义 |
|---|---|---|
| `trajectoryDirection` | x | movement_x 正转时货物的运动方向（x/-x/z/-z），**模型本地坐标**，见 §3 |
| `cargoAutoDispose` | 关 | 勾选后 mode==2 且双光电无货时销毁本机货物；缺省不销毁，货物滞留（等被订阅交付取走或新 task 复用） |
| `cargoOriginDevice` | 关 | 起点设备：新 task 边沿时探测点未触及上游且无注册上游，允许自行创建货箱（见 §5.7） |

## 3. 货物几何基础

- **行走轴**：脚本 `cargo.travel.axis` 声明（x/z），缺省 x；conveyor 本体无自主动画，`motion` 块已废弃
- **跨度**：`cargo.travel.nodes` 精确名节点（兜底 `fallbackPattern` 正则，再兜底通用命名正则/整机包围盒）投影到行走轴的长度
- **行程半径** `halfRange = span/2 − 货箱轴向长度/2`；货箱轴向长度取生成器模板实测（输出世界包围盒在行走轴上的投影，按模板 target 签名缓存），内置立方体/模板未就绪/探测点场景回退 `CONVEYOR_CARGO_SIZE=(0.72, 0.34, 0.72)`
- **轨迹方向** `forwardSign`：`telemetryBinding.trajectoryDirection`（x/-x/z/-z，缺省 x）为**模型本地坐标**方向；其轴与行走轴名一致时取配置正负号（±1），轴向不一致（缺省/错配）回退 1
- **刷出端偏移** `spawnOffset = −direction × forwardSign × halfRange`：正转刷在轨迹起点向终点走，反转反之
- **探测点偏移** `probeOffset = −direction × forwardSign × (halfRange + 货箱轴向长度)`：复用刷出端公式，自轨迹端点沿走行方向**向外多延伸一个货箱长度**；正转探测点对应 movement_x 0/1，反转探测点对应 movement_x 2
- **货物世界位置** = 包围盒中心抬升货箱半高 + 行走轴 × `cargoTravelOffset`
- **货物表**：跨设备共享 `state.conveyorCargoMeshes`，键 `JSON.stringify([assetCode, cargoCode])`；单机单货物，cargoCode 恒为 `'cargo'`

## 4. 遥测状态字段

| 字段 | 语义 |
|---|---|
| `cargoCode` | 本机持有的货物身份（'cargo' 或 null） |
| `currentTask` | 当前 task，刷出/复用时盖到货物上 |
| `pendingTask` | 已登记待刷出的 task；新 task 边沿当帧消费（刷出/复用/销毁）或转等待（等待期间保留）；被 mode 0 退出/过境标记时一并放弃 |
| `lastTask` | 边沿判定基准，**不随清线复位**——同 task 重发（含销毁/被交付后）不重刷 |
| `waitingTask` | 正在等待上游交付的 task；非 null 时不刷出、不走行 |
| `probeNeighbors` | 探测点邻居缓存 `{forward, reverse}`（各存邻居 assetCode 或 null），按方向各解析一次，reset 时清空重算 |
| `upstreamLinks` | 上位链路表 `Map<上一跳 assetCode, {task, holderAssetCode, hops, direction}>`：available 通知建立、taken 通知清除；含通知注册进来的非探测上游（侧向触及场景） |
| `downstreamLinks` | 下位链路表 `Map<最终订阅者 assetCode, {task, hops, direction}>`：subscribe 建立、unsubscribe/交付完成清除；Map 插入序即订阅先到先得的交付顺序 |
| `externalPulls` | 外部持货拉取登记 `Map<最终订阅者 assetCode, {holderAssetCode, task, hops, direction}>`：订阅传播触达 stacker/RGV 邻居时由相邻 conveyor 登记，帧尾扫描拉取（§7.6） |
| `transitedTasks` | 已过境 task 集合：货物沿链路越过本机交付给更下游（或消失）后标记；此后收到同 task 仅更新 `lastTask`，不再触发边沿/订阅 |
| `lastMovementDirection` | 最近非 0 运行方向（±1）；流向翻转时清空全部链路登记（§5.3） |
| `selfDriveDirection` | 自驱走行方向（±1，0=关闭）：被交付时登记订阅方向；movement_x=0 的新 task 刷出/复用时登记正转 1 |
| `lastSnapshotReceivedAt` | 最近应用的快照 receivedAt，识别新消息 |
| `cargoTravelOffset` | 货物行程偏移（世界方向带 forwardSign） |

## 5. 主流程逐分支（`applyConveyorCargoMotion`，按代码顺序）

每帧按以下顺序判定，**靠前分支的 return 会截断后续全部逻辑**：

### 5.1 新消息检测（自驱清零）
`receivedAt !== lastSnapshotReceivedAt` → 更新记录并 `selfDriveDirection = 0`。
断流重放（stale 快照重放同一 receivedAt）保持不变。mode 变 2/0、新 task 等停止语义都随新消息到达，天然被此清零覆盖。

### 5.2 新 task 边沿
`task` 为数值、归一化非空、且 ≠ `lastTask` 时：
- `lastTask = task`
- **若 task 不在 `transitedTasks` 中**：此前若在等待旧 task，先沿链退订（unsubscribe 上行传递，§7.3）；然后 `currentTask = pendingTask = task`，`waitingTask = null`（旧等待作废）
- 若 task 在 `transitedTasks` 中：仅更新 `lastTask`，不登记、不等待、不订阅（货已过机，本机不参与，**自身进行中的 task 状态与链路登记不受影响**）

注意：`task=0` 或缺失不产生边沿；同 task 重发不产生边沿。

### 5.3 运行方向与流向翻转
从 `cargo.travel` 配置（fields+actionMap，或 movement_x 缺省映射）读 `movementDirection`；非 0 时记入 `lastMovementDirection`。
**流向翻转**（新非 0 方向 ≠ 旧非 0 方向）：链路全部失效——等待中的订阅先以旧方向退订，然后 `upstreamLinks`/`downstreamLinks`/`externalPulls` 清空（探测缓存保留），仍以新方向重新订阅。

### 5.4 等待方退出（level 判断）
`mode === 0`（空闲）→ 沿链退订，`waitingTask = null`；若退出前在等待则**同时放弃 `pendingTask`**（刷出判定已提前到 task 边沿，不放弃会当帧立即重新等待）。
**`mode === 2` 不退出等待**：mode=2 仅是销毁条件（5.5），与等待无关；等待方 mode=2 保持等待且不影响被交付资格。
持有方货物中途消失**不**自动退出等待——等待只能被 mode 0、新 task 边沿、过境标记、被交付四种方式结束。

### 5.5 mode==2 销货
条件：`mode==2 && 双光电都无货`（与线体是否走行无关；光电有货则整个块跳过）：

- **cargoAutoDispose 勾选** → 销毁本机全部货物，`cargoCode=null`，向下游发出 taken 通知（货物消失），return
- **cargoAutoDispose 未勾选（缺省）** → 保留货物与位姿（遗留箱）：等下游订阅交付取走（§7），或新 task 边沿时复用/销毁（5.7）；无货物时 return

### 5.6 task 模式刷出/订阅判定
条件：`pendingTask` 非空（**新 task 边沿当帧即判定，不再等 movement_x 非 0**）。事件驱动：订阅只在首次进入等待（或 available 通知到达）时发出，等待期间（waitingTask 非空）本块幂等不重发。

### 5.7 新 task 边沿的分流（持货复用/销毁规则）
1. **自身持有货物**：
   - 旧货**已有下游订阅**（downstreamLinks 中有其 task 的订阅者）→ 先正常交付（§7.4），本机按无货流程继续处理新 task
   - 旧货无下游订阅，且**上游链路有新 task 的在持货物**（upstreamLinks 记录命中，或直接探测上游邻居持有该 task 货）→ **销毁**当前货物（发 taken），`waitingTask = pendingTask` 并向上订阅，等上游传递
   - 旧货无下游订阅且上游无新 task 货 → **复用**滞留箱：不销毁不重建，`cargoTravelOffset` 保持滞留位置，货物 `task` 盖新 task、`containerCode` 更新（新值优先，空则保留旧值）；发 taken（旧 task 消失）+ available（新 task 持货）通知；消费 `pendingTask=null`，不等待
2. **无货物且不在等待**（`probeDirection = movementDirection ≠ 0 ? movementDirection : 1`）：
   - **探测点无直接上游且无注册上游，且为起点设备**（`cargoOriginDevice === true`）→ 消费 pendingTask，`cargoTravelOffset = spawnOffset`，自行创建货箱；随后发 available 通知并检查交付（已有下游订阅时当帧交付）
   - **否则** → `waitingTask = pendingTask`（pendingTask 保留）+ **传递式订阅**（subscribe 上行，§7.2）：等持货方命中交付，无需本机再收消息
3. 复用与自建两支中 `movementDirection === 0` 时登记 `selfDriveDirection = 1`：从当前位置/轨迹起点自驱移向终点，下一条新消息到达恢复字段驱动（见 §8）

### 5.8 等待中截断
`waitingTask` 非 null → return：不刷出、不走行。接管完全由链路协议事件完成（§6/§7），**本机快照断流也能收到交付**。

### 5.9 走行 + 钳制
走行前先做**帧级交付兜底**（`tryDeliverHeldCargo`：本机持货且 downstreamLinks 有该 task 订阅者 → 交付）；事件驱动已覆盖所有正常路径，此处仅自愈事件缺口（如运行期外部直接注入持货），交付后本机不再持有直接返回。

`cargoDirection = movementDirection ≠ 0 ? movementDirection : selfDriveDirection`（自驱回退，见 §8）：
- 非故障且方向非 0 → `cargoTravelOffset += cargoDirection × forwardSign × cargoSpeed × delta`
- `cargoSpeed` = `cargo.travel.speed`，缺省 0.3 m/s
- 最终 `cargoTravelOffset` clamp 到 ±halfRange：货箱走到行程端即停住，无订阅者时持有方持续持货

### 5.10 视觉落地
- `syncGeneratedCargoVisual` 同步货箱模板/回退 Box
- `resolveCargoHandoffPose`：handoff 未完结时在「接管起点世界位姿 → 当前目标位姿」间插值（时长 = `CARGO_HANDOFF_SECONDS / hops`，越级交付按跳数加速），完结清除
- `setGeneratedCargoRootPose` 写世界位姿

## 6. 链路流转协议（事件驱动）

每台 conveyor **显式维护上位/下位链路**（§4 upstreamLinks/downstreamLinks），货物流转**由 3D 场景布局与事件消息决定**：设备收到货物（或起点自建）即向下游通知，设备收到 task 即向上游传递式订阅，持货方发现命中的订阅即**直达交付**给最终订阅者。无帧级全量扫描、无锁定握手；消息处理为同步方法调用，与设备各自 MQTT 快照新旧无关。

### 6.1 上下游解析

- **探测邻接**：探测点（§3）落在其他**专用设备**（conveyor/stacker/rgv 能力模型）世界包围盒内（外扩 epsilon 0.05）即视为邻居；多个命中取盒中心距探测点最近者。按正/反转各缓存一次到 `probeNeighbors`。对流向 d：入口侧（d 侧）探测邻居为轨迹上游，出口侧（−d 侧）为轨迹下游
- **链路注册**：除探测邻接外，通知/订阅动作会把对方登记进本机链路表——覆盖侧向触及场景（A 探测触及 B 侧面而 B 探不到 A：A 发 available 时 B 注册 A 为上位链路，随后 B 的订阅经注册上游送达 A）
- **消息防环**：链路消息携带 `visited: string[]`（已处理设备链），命中即丢弃；`hops` 逐跳 +1，兼作交付交接动画的时长除数

### 6.2 消息类型

| kind | 方向 | 载荷语义 | 接收方动作 |
|---|---|---|---|
| `available` | 下行泛洪 | origin=持货方 | 登记/更新 `upstreamLinks[上一跳] = {task, holder, hops+1, direction}`；正等该 task 且无货 → 立即向上订阅；继续下行转发 |
| `taken` | 下行泛洪 | origin=持货方，recipient=交付对象（null=消失） | 清除该 task 的上位链路记录；`pendingTask` 匹配且 recipient 非本机 → 标记 `transitedTasks`、退订并停止挂单；继续下行转发 |
| `subscribe` | 上行传递 | origin=最终订阅者 | 登记 `downstreamLinks[订阅者] = {task, hops+1, direction}`；持有该 task 货 → **不再转发，直接交付**；否则继续上行转发 |
| `unsubscribe` | 上行传递 | origin=最终订阅者 | 摘除 `downstreamLinks[订阅者]` 与 `externalPulls[订阅者]`；继续上行转发 |

**泛洪/传递目标**：下行 = 出口探测邻居 + 全部注册下游（去重）；上行 = 入口探测邻居 + 全部注册上游（去重）。入口探测邻居为非 conveyor 专用设备（stacker/RGV）时，subscribe 不再传递，改由本机登记 `externalPulls`（§7.6）。

### 6.3 通知时机（持有方）

- **available**：交付到达 / 起点自建 / 复用盖新 task 后发出
- **taken**：交付给下游（recipient=订阅者）/ 自动销毁 / 复用盖 task（旧 task 消失，recipient=null）后发出
- 持有方其余时间**完全被动**：无订阅者时继续持有（clamp 在 ±halfRange）

### 6.4 订阅时机（等待方）

- **subscribe**：新 task 边沿首次进入等待、available 通知到达且正等该 task、流向翻转后以新方向重订
- **unsubscribe**：收到货（交付落地时）、变更 task（新边沿先退订旧的）、mode=0 退出等待、过境标记

## 7. 交付与仲裁

### 7.1 交付触发（`tryDeliverHeldCargo`）

持货方检查本机 `downstreamLinks`：首个 task 匹配（Map 插入序，先注册先得）的订阅者即交付对象。触发点：subscribe 登记时（持货命中不再转发）、持货到达时（available 后）、复用盖 task 后、帧级兜底（5.9）。
**链路自愈合**：订阅者已持有货物或不再等待该 task（pendingTask/waitingTask 均不匹配）→ 摘除该登记看下一个。

### 7.2 传递式订阅（上行）

等待方向「入口探测邻居 + 注册上游」发送 subscribe；途经设备登记下游链路并继续向上；**持有所订阅 task 货物的设备终止传递并交付**。货物与 task 绑定：异 task 持货不匹配、不交付。

### 7.3 退订（上行）

unsubscribe 沿同样的上行目标传递，沿途摘除 `downstreamLinks[订阅者]` 与 `externalPulls[订阅者]` 登记。

### 7.4 直达交付（`deliverCargoToSubscriber` / `completeCargoTransfer`）

- `detachClaimedCargoByReference(cargo)` 从持有方表取出（**实例不销毁**，由持有方 driver 清理其遥测引用——conveyor 的 cargoCode、stacker 的货叉 key 等）
- 换绑：`assetCode = 订阅者`、`task` 保持绑定值、`handoff` 登记，**时长 = `CARGO_HANDOFF_SECONDS / max(hops, 1)`**（越级交付按跳数加速）
- 订阅者状态：`cargoCode='cargo'`、`cargoTravelOffset = 自身刷出端（按订阅 direction）`、`pendingTask=null`、`waitingTask=null`、`selfDriveDirection = direction`
- 交付落地即：收货方发 unsubscribe（沿链清除登记）→ 持有方发 taken（recipient=订阅者）→ 收货方发自身 available 并检查交付 → **同帧链式接力**（A 交付 B 后 B 持货，若 C 订阅了 B 同帧再交付 C）
- 输出移交日志 `Conveyor {订阅者} 经链路接管货物（task=...，hops=N）`

### 7.5 越级直达与过境标记

多跳订阅（如 DOWN 经 MID 订阅到 UP）时，UP 持货后**直达交付 DOWN**（MID 全程不持货），交接动画按跳数加速（hops=2 → 0.5s）。taken 波经过等待同 task 的中间设备时：该 task == 其 pendingTask 且交付对象非自身 → 标记 `transitedTasks`、退订、停止挂单——此后收到同 task 仅更新 `lastTask`（货已过机，防止 B/C 事后又向 A 挂单）。相邻交付无中间设备、不产生标记，链式接力不受影响。

### 7.6 外部持货拉取（stacker/RGV）

stacker/RGV 无链路能力（不收发消息）：subscribe 上行触达时由相邻 conveyor 登记 `externalPulls[订阅者] = {holderAssetCode, task, hops, direction}`。facade 帧尾 `pullExternalHolderCargo()` 扫描全部登记：持有方三张货物表中有该 task 货 → 代交付（同样直达最终订阅者、hops 加速），并由相邻 conveyor 代发 taken 波；登记失配（订阅者已持货/不再等待）即自愈摘除。

## 8. 接管自驱（断流不停货）

问题：帧调度默认不驱动断流设备；边缘触发发布的承接方被交付后若无新消息，快照断流后若不做处理，货箱会静止到下一条消息。

机制：
- 两个登记入口：被交付时登记 `selfDriveDirection = 订阅方向`（7.4）；**movement_x=0 的新 task 刷出/复用时登记 `selfDriveDirection = 1`**（5.7）
- 走行时快照 movement 为 0 回退到自驱方向（5.9）
- facade 的 `applyWhenStale` 钩子让处于自驱的输送线在快照断流时仍被帧调度驱动（用缓存快照）；**链路协议与帧尾拉取本身与快照新旧无关**，等待方断流期间照样能收到交付
- **任何新消息到达**（receivedAt 变化）→ 自驱清零，恢复字段驱动（movement_x=0 即停车，mode 2/0、新 task 正常生效）
- 持续到货：走行至行程端 clamp 停住

## 9. 故障（faulted）行为

| 逻辑 | 故障时 |
|---|---|
| 货物走行 | 停止 |
| 新 task 边沿登记 | 照常 |
| mode==2 销毁/遗留 | 照常 |
| 刷出/订阅判定 | 照常（新 task 边沿即判定） |
| 链路协议事件 | 照常（同步方法调用，与快照新旧无关，故障设备持货照样被交付走） |
| 帧尾外部拉取扫描 | 照常 |
| 状态日志 | 输出故障日志（节流到签名变化） |

## 10. 退出运行预览清理

`SceneRuntime.endTelemetryPreview()`：
- `disposeAllCargo()` 销毁三张货物表（stacker/conveyor/rgv）全部货物
- 普通模型、生成器输出模型、**合批阵列代表模型**（modelArrayParameterVariants）全部 `resetConveyorTelemetryState()`（清空本文 §4 所有字段，含 probeNeighbors/链路表/selfDriveDirection/lastSnapshotReceivedAt）
- 恢复预览前基线位姿；清理 fetch 批次、诊断状态；MQTT 快照存储由 `client.dispose()` 清空

## 11. 全情况速查表

### 新 task 边沿判定（当帧执行，不再等线体运行；movement_x=0 按正转处理）

task 在 `transitedTasks` 中（越级流转货已过机，§7.5）时**不触发边沿**：仅更新 `lastTask`，不登记、不等待、不订阅，自身进行中的 task 状态与链路登记不受影响。

| 自身持有货物 | 旧货下游订阅 | 上游有新 task 货 | cargoOriginDevice | 结果 |
|---|---|---|---|---|
| 有 | 有 | — | — | 先交付旧货，再按无货流程处理新 task |
| 有 | 无 | 有 | — | 销毁旧货（发 taken），订阅等上游传递 |
| 有 | 无 | 无 | — | 复用滞留箱：盖新 task、滞留位置继续走行（movement_x=0 登记正转自驱），发 taken+available |
| 无 | — | — | 开（且无探测/注册上游） | 刷出端自建（movement_x=0 登记正转自驱），发 available |
| 无 | — | — | 其余 | 进入等待 + 传递式订阅，持货方命中即交付 |

### mode=2（双光电无货）

| 持有货物 | autoDispose | 结果 |
|---|---|---|
| 有 | 勾选 | 销毁（发 taken） |
| 有 | 未勾选（缺省） | 遗留（等被订阅交付取走或新 task 复用/销毁） |
| 无 | — | 无操作 |

### 等待中（waitingTask 非空）

| 事件 | 结果 |
|---|---|
| 任意帧 | 不刷出、不走行；pendingTask 保留；订阅事件驱动不重发 |
| mode 变 0 | 退订、退出等待、放弃 pendingTask（同 task 重发不再重新等待，仅新 task 边沿再判定） |
| mode 变 2 | **不退出**（mode=2 仅是销毁条件），保持等待且不影响被交付资格 |
| 新 task 边沿 | 退订旧 task，旧等待作废，走新 task 判定 |
| available 通知到达（该 task） | 立即向上订阅（覆盖新出现的持货方路径） |
| taken 波经过（货交他人/消失） | 标记 transitedTasks、退订、停止挂单 |
| 方向翻转（movement_x 变化） | 退订旧方向、链路清空，以新方向重新订阅 |
| 被交付 | 接管货物：刷出端起走 + 自驱 + handoff 插值（1s/hops） |

### 持有方（完全被动）

| downstreamLinks 有其 task 的订阅者 | movement_x | 结果 |
|---|---|---|
| 有 | 任意 | 事件触发即交付（不等货到端点，无需自身收到消息） |
| 无 | ≠0 | 走到 ±halfRange 停住，持续持货 |
| 无 | 0 | 静止持货 |

### 交付仲裁（多下游订阅同一 task）

| 情形 | 结果 |
|---|---|
| 持货方有该 task 货 | 交给最先注册（Map 插入序）的订阅者；货物与 task 绑定、唯一，落选者被 taken 波标记过境不再挂单 |
| 订阅途经非 conveyor 邻居（stacker/RGV） | 相邻 conveyor 登记 externalPulls，帧尾扫描代交付 |
| 多跳订阅 | 直达交付最终订阅者，交接动画 1s/hops；过境的中间等待设备标记 transitedTasks |
| 链式 A→B→C | A 交付 B 后 B 即持货并触发自身交付检查，同帧接力到末端 |
