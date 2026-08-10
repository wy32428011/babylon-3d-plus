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
   - 快照断流（`now - receivedAt > staleAfterMs`）→ **默认不驱动**；例外：驱动注册项声明 `applyWhenStale` 且返回 true 时仍用缓存快照驱动。conveyor 的判定仅为 `conveyorTelemetry.selfDriveDirection !== 0`（见 §9 接管自驱）
3. 命中驱动 → `ConveyorTelemetryDriver.applyToModel(model, snapshot, delta)`：
   - 节流输出状态/故障日志，写入设备 metadata
   - **非故障**时执行本体动画（滚筒/链条）
   - 货物动画 `applyConveyorCargoMotion` **无论是否故障都执行**（故障只门控其中的走行推进，见 §10）
4. **帧尾**（全部驱动循环结束后）无条件执行 `conveyorDriver.pushCargoToProbeSubscribers()`：探测点订阅推送扫描，**与任何设备快照新旧无关**（见 §7/§8）

## 2. 输入字段

| 字段 | 类型 | 语义 |
|---|---|---|
| `movement_x` | int | 0 静止，1 正转，2 反转（正负数兜底兼容）。实际读取走 translate 配置的 `fields`+`actionMap`，缺省即 movement_x。**不再门控刷出**：新 task 刷出/复用时若为 0 按正转（1）处理并登记自驱（见 §6.7/§9） |
| `mode` | int | 2=销毁条件（配合双光电无货+勾选自动销毁）；0=空闲（等待方退出等待并退订）；缺省（null）视为运行中 |
| `task` | int | 任务号；缺失=匿名模式；0=无任务（归一化为空串，不触发任何边沿，状态不变） |
| `front_has_goods` / `back_has_goods` | bool | 前后光电，仅用于 mode==2 的销毁判定（字段名可由脚本 `motion.cargo` 覆盖） |
| `containerCode` | string | 货箱条码，仅元数据（命名/metadata），不参与身份唯一性 |
| `rotation` | number | >3 时作为滚筒角速度（度/秒），否则用脚本默认速度 |
| `faulted`（快照级） | bool | 故障门控，见 §10 |

绑定配置（`telemetryBinding`，输送线专用）：

| 选项 | 缺省 | 语义 |
|---|---|---|
| `trajectoryDirection` | x | movement_x 正转时货物的世界运动方向（x/-x/z/-z），见 §4 |
| `cargoAutoDispose` | 关 | 勾选后 mode==2 且双光电无货时销毁本机货物；缺省不销毁，货物滞留（等被推送取走或新 task 复用） |
| `cargoOriginDevice` | 关 | 起点设备：新 task 边沿时探测点未触及上游设备，允许自行创建货箱（见 §6.7） |

## 3. 本体动画（滚筒/链条）

由模型脚本 `dataDriven.motion`（devType=conveyor）配置驱动，每个配置块独立：

- **方向**：按 `config.fields` 顺序读第一个有值的字段，经 `actionMap` 映射（缺省 0→0、1→+1、2→−1）；方向为 0 跳过
- **节点**：`config.nodes` 精确名匹配（含参数化克隆的 `metadata.motionSourceNodeName` 继承），失败则用 `fallbackPattern` 正则兜底；只取顶层运动节点
- **rotate**（滚筒）：每帧 `direction × speed × delta` 绕局部轴旋转；speed 取 `rotation` 字段（>3 时）或配置速度（缺省 180°/s）
- **translate**（链条）：偏移累加后**回绕**到 ±0.6m 循环（`CONVEYOR_DEFAULT_TRANSLATE_LOOP_METERS=1.2`），从节点基线（首次驱动前的位置）出发做局部轴平移，不累计误差
- 故障时整个本体动画跳过

## 4. 货物几何基础

- **行走轴**：首个非竖直轴 translate 配置的轴（x/z）；无配置时按 rotate 轴推断（rotate=x → 走 z），最终缺省 x
- **跨度**：运动节点包围盒（无则用整机包围盒）投影到行走轴的长度
- **行程半径** `halfRange = span/2 − 货箱轴向长度/2`，货箱尺寸 `CONVEYOR_CARGO_SIZE=(0.72, 0.34, 0.72)`
- **轨迹方向** `forwardSign`：`telemetryBinding.trajectoryDirection`（x/-x/z/-z，缺省 x）定义的「movement_x 正转时货物世界运动方向」与行走轴世界向量的对齐符号
- **刷出端偏移** `spawnOffset = −direction × forwardSign × halfRange`：正转刷在轨迹起点向终点走，反转反之
- **探测点偏移** `probeOffset = −direction × forwardSign × (halfRange + 货箱轴向长度)`：复用刷出端公式，自轨迹端点沿走行方向**向外多延伸一个货箱长度**；正转探测点对应 movement_x 0/1，反转探测点对应 movement_x 2
- **货物世界位置** = 包围盒中心抬升货箱半高 + 行走轴 × `cargoTravelOffset`
- **货物表**：跨设备共享 `state.conveyorCargoMeshes`，键 `JSON.stringify([assetCode, cargoCode])`；单机单货物，cargoCode 恒为 `'cargo'`

## 5. 遥测状态字段

| 字段 | 语义 |
|---|---|
| `cargoCode` | 本机持有的货物身份（'cargo' 或 null） |
| `currentTask` | 当前 task，刷出/复用时盖到货物上 |
| `pendingTask` | 已登记待刷出的 task；新 task 边沿当帧消费（刷出/复用）或转等待（等待期间保留，每帧幂等重估订阅）；被 mode 0 退出时一并放弃 |
| `lastTask` | 边沿判定基准，**不随清线复位**——同 task 重发（含销毁/被推送后）不重刷 |
| `waitingTask` | 正在等待探测点上游设备推送的 task；非 null 时不刷出、不走行 |
| `probeNeighbors` | 探测点邻居缓存 `{forward, reverse}`（各存邻居 assetCode 或 null），按方向各解析一次，reset 时清空重算 |
| `probeSubscription` | 向上游设备的订阅 `{holderAssetCode, direction, seq}`；等待期间登记，被推送/退出等待时清空；seq 单调递增，多下游订阅同一上游时**先订阅者（seq 小）先被推送** |
| `lastMovementDirection` | 最近非 0 运行方向（±1） |
| `selfDriveDirection` | 自驱走行方向（±1，0=关闭）：被推送时登记订阅方向；movement_x=0 的新 task 刷出/复用时登记正转 1 |
| `lastSnapshotReceivedAt` | 最近应用的快照 receivedAt，识别新消息 |
| `cargoTravelOffset` | 货物行程偏移（世界方向带 forwardSign） |
| `motionOffsets` / `nodeBaselines` | 链条循环偏移 / 节点基线 |

## 6. 主流程逐分支（`applyConveyorCargoMotion`，按代码顺序）

每帧按以下顺序判定，**靠前分支的 return 会截断后续全部逻辑**：

### 6.1 新消息检测（自驱清零）
`receivedAt !== lastSnapshotReceivedAt` → 更新记录并 `selfDriveDirection = 0`。
断流重放（stale 快照重放同一 receivedAt）保持不变。mode 变 2/0、新 task 等停止语义都随新消息到达，天然被此清零覆盖。

### 6.2 新 task 边沿
`task` 为数值、归一化非空、且 ≠ `lastTask` 时：
- `lastTask = currentTask = pendingTask = task`
- `waitingTask = null`、`probeSubscription = null`（旧等待作废，**退订旧上游**）

注意：`task=0` 或缺失不产生边沿；同 task 重发不产生边沿。

### 6.3 运行方向
从 translate 配置（或 movement_x 兜底）读 `movementDirection`；非 0 时记入 `lastMovementDirection`。

### 6.4 等待方退出（level 判断）
`mode === 0`（空闲）→ `waitingTask = null`、`probeSubscription = null`（退订）；若退出前在等待则**同时放弃 `pendingTask`**（刷出判定已提前到 task 边沿，不放弃会当帧立即重新等待）。
**`mode === 2` 不退出等待**：mode=2 仅是销毁条件（6.5），与等待无关；等待方 mode=2 保持等待且不影响被推送资格。
持有方货物中途消失**不**自动退出等待——等待只能被 mode 0、新 task 边沿、被推送三种方式结束。

### 6.5 mode==2 销货
条件：`mode==2 && 双光电都无货`（与线体是否走行无关；光电有货则整个块跳过）：

- **cargoAutoDispose 勾选** → 销毁本机全部货物，`cargoCode=null`，return
- **cargoAutoDispose 未勾选（缺省）** → 保留货物与位姿（遗留箱）：等下游订阅推送取走（§7），或新 task 边沿时复用（6.7）；无货物时 return

### 6.6 task 模式刷出/订阅判定
条件：`pendingTask` 非空（**新 task 边沿当帧即判定，不再等 movement_x 非 0**）。等待期间 pendingTask 保留，本块每帧幂等重估（方向翻转时更新订阅）。

### 6.7 新 task 边沿的三支分流
1. **自身持有货物**（滞留箱复用，无论 autoDispose 与否）：不销毁不重建，`cargoTravelOffset` 保持滞留位置，货物 `task` 盖上新 task、`containerCode` 更新（新值优先，空则保留旧值）；消费 `pendingTask=null`，不等待不订阅
2. **否则解析探测点邻居**（`probeDirection = movementDirection ≠ 0 ? movementDirection : 1`）：
   - **邻居存在** → `waitingTask = pendingTask`（pendingTask 保留）+ 登记订阅（§7）：等邻居持货后主动推送，无需本机再收消息
   - **邻居不存在且为起点设备**（`cargoOriginDevice === true`）→ 消费 pendingTask，`cargoTravelOffset = spawnOffset`（按 probeDirection 的刷出端），自行创建货箱
   - **邻居不存在且非起点** → `waitingTask = pendingTask`（无订阅对象，仅阻塞自身刷出，永远等不到）
3. 复用与自建两支中 `movementDirection === 0` 时登记 `selfDriveDirection = 1`：从当前位置/轨迹起点自驱移向终点，下一条新消息到达恢复字段驱动（见 §9）

### 6.8 等待中截断
`waitingTask` 非 null → return：不刷出、不走行。接管完全由帧级推送扫描完成（§8），**本机快照断流也能收到推送**。

### 6.9 匿名模式刷出
快照无 `task` 字段时：本机无货物且 `movementDirection ≠ 0` → 在刷出端自建匿名货箱（`task=''`，不参与探测点推送）；`movementDirection === 0` → return。已有货物时不再刷出，直接走进行。

### 6.10 走行 + 钳制
`cargoDirection = movementDirection ≠ 0 ? movementDirection : selfDriveDirection`（自驱回退，见 §9）：
- 非故障且方向非 0 → `cargoTravelOffset += cargoDirection × forwardSign × cargoSpeed × delta`
- `cargoSpeed` = translate 配置速度，缺省 0.3 m/s（与链条同源，链/货速度不脱节）
- 最终 `cargoTravelOffset` clamp 到 ±halfRange：货箱走到行程端即停住，无订阅者时持有方持续持货

### 6.11 视觉落地
- `syncGeneratedCargoVisual` 同步货箱模板/回退 Box
- `resolveCargoHandoffPose`：handoff 未完结时在「接管起点世界位姿 → 当前目标位姿」间插值（1 秒），完结清除
- `setGeneratedCargoRootPose` 写世界位姿

## 7. 探测点订阅/推送协议

货物流转**完全由 3D 场景布局决定**，不再按 task 匹配，也无锁定/解锁握手。三方视角：

- **邻居嗅探**：探测点（§4）落在其他**专用设备**（conveyor/stacker/rgv 能力模型）世界包围盒内（外扩 epsilon 0.05）即视为上游邻居；多个命中取盒中心距探测点最近者。按正/反转各缓存一次到 `probeNeighbors`（预览期间模型不动，缓存安全）
- **等待方（下游）**：新 task 边沿 + 探测点有邻居 → 不刷出、不走行，登记 `waitingTask` 并**向邻居订阅**（`probeSubscription = {holderAssetCode, direction, seq}`）。退出：mode 0（同时放弃 pendingTask 并退订）、新 task 边沿（退订后重新判定）、被推送；**mode=2 不构成退出条件**
- **持有方（上游）**：**完全被动**——一旦持货且存在订阅者，帧级扫描即把货物推送走（不等货到端点、无需自身收到任何消息）；无订阅者时继续持有（clamp 在 ±halfRange）；mode==2 且双光电无货时按 cargoAutoDispose 销毁或遗留（6.5）
- **被推送方**：见 §8/§9
- stacker/RGV 持有的货物同样可被推送：三张货物表统一扫描，双叉各持一箱时取距订阅者探测点最近的一件

## 8. 推送仲裁（`pushCargoToProbeSubscribers`）

facade 帧尾每帧无条件执行（**与快照新旧无关**，等待方断流也能收货）：

1. 收集所有带 `probeSubscription` 的 conveyor 模型，按 `holderAssetCode` 分组
2. 组内按 **seq 升序**排序（先订阅者先得；seq 为 driver 实例单调递增序号，邻居不变仅更新方向保留 seq，邻居变化/新 task 边沿重新登记排到队尾）
3. 组内依次推送：持有方在三张货物表中有货（`cargo.assetCode === holderAssetCode`，多件取距**订阅者探测点**最近的一件）→ 推送给队首订阅者；无货即 `break`，其余订阅者顺位等下一箱
4. 推送执行（`pushCargoToSubscriber`）：
   - `detachClaimedCargoByReference(cargo)` 从持有方表取出（**实例不销毁**，由持有方 driver 清理其遥测引用——conveyor 的 cargoCode、stacker 的货叉 key 等）
   - 换绑：`assetCode = 订阅者`、`task = 订阅者 pendingTask ?? currentTask`、`handoff` 登记（1 秒视觉插值保持连续）
   - 订阅者状态：`cargoCode='cargo'`、`cargoTravelOffset = 自身刷出端（按订阅 direction）`、`pendingTask=null`、`waitingTask=null`、`probeSubscription=null`、`selfDriveDirection = direction`
   - 输出移交日志 `Conveyor {订阅者} 凭探测点订阅接管 {持有方} 持有的货物（task=...）`
5. **链式接力**：A 推 B 后 B 即持货，同组扫描中若 C 订阅了 B 可同帧（最迟下一帧）再推 C——货箱实例沿订阅链逐级传递到末端

不变式：**等待 ⇒ 不持货**（持货 + 新 task 走 6.7 的复用路径），故被推送方必无旧箱，无需防御性销毁。

## 9. 接管自驱（断流不停货）

问题：帧调度默认不驱动断流设备；边缘触发发布的承接方被推送后若无新消息，快照断流后若不做处理，货箱会静止到下一条消息。

机制：
- 两个登记入口：被推送时登记 `selfDriveDirection = 订阅方向`（8.4）；**movement_x=0 的新 task 刷出/复用时登记 `selfDriveDirection = 1`**（6.7）
- 走行时快照 movement 为 0 回退到自驱方向（6.10）
- facade 的 `applyWhenStale` 钩子让处于自驱的输送线在快照断流时仍被帧调度驱动（用缓存快照）；**推送扫描本身与快照新旧无关**，等待方断流期间照样能收到推送
- **任何新消息到达**（receivedAt 变化）→ 自驱清零，恢复字段驱动（movement_x=0 即停车，mode 2/0、新 task 正常生效）
- 持续到货：走行至行程端 clamp 停住

## 10. 故障（faulted）行为

| 逻辑 | 故障时 |
|---|---|
| 本体滚筒/链条动画 | 停止（整个跳过） |
| 货物走行 | 停止 |
| 新 task 边沿登记 | 照常 |
| mode==2 销毁/遗留 | 照常 |
| 刷出/订阅判定 | 照常（新 task 边沿即判定） |
| 帧级推送扫描 | 照常（与快照内容无关，故障设备持货照样被推送走） |
| 状态日志 | 输出故障日志（节流到签名变化） |

## 11. 退出运行预览清理

`SceneRuntime.endTelemetryPreview()`：
- `disposeAllCargo()` 销毁三张货物表（stacker/conveyor/rgv）全部货物
- 普通模型、生成器输出模型、**合批阵列代表模型**（modelArrayParameterVariants）全部 `resetConveyorTelemetryState()`（清空本文 §5 所有字段，含 probeNeighbors/probeSubscription/selfDriveDirection/lastSnapshotReceivedAt）
- 恢复预览前基线位姿；清理 fetch 批次、诊断状态；MQTT 快照存储由 `client.dispose()` 清空

## 12. 全情况速查表

### 新 task 边沿判定（当帧执行，不再等线体运行；movement_x=0 按正转处理）

| 自身持有货物 | 探测点邻居 | cargoOriginDevice | 结果 |
|---|---|---|---|
| 有 | — | — | 复用滞留箱：盖新 task、滞留位置继续走行（movement_x=0 登记正转自驱） |
| 无 | 有 | 任意 | 进入等待 + 订阅邻居，等其持货后推送 |
| 无 | 无 | 开 | 刷出端自建（movement_x=0 登记正转自驱） |
| 无 | 无 | 关 | 仅等待（无订阅对象，永远等不到） |

### mode=2（双光电无货）

| 持有货物 | autoDispose | 结果 |
|---|---|---|
| 有 | 勾选 | 销毁 |
| 有 | 未勾选（缺省） | 遗留（等被推送取走或新 task 复用） |
| 无 | — | 无操作 |

### 等待中（waitingTask 非空）

| 事件 | 结果 |
|---|---|
| 任意帧 | 不刷出、不走行；pendingTask 保留，订阅每帧幂等维护 |
| mode 变 0 | 退出等待、放弃 pendingTask 并退订（同 task 重发不再重新等待，仅新 task 边沿再判定） |
| mode 变 2 | **不退出**（mode=2 仅是销毁条件），保持等待且不影响被推送资格 |
| 新 task 边沿 | 退订旧上游，旧等待作废，走新 task 判定 |
| 方向翻转（movement_x 变化） | 邻居不变 → 更新订阅方向、保留 seq；邻居变化 → 重新登记、排到队尾 |
| 被推送 | 接管货物：刷出端起走 + 自驱 + handoff 插值（1 秒） |

### 持有方（完全被动）

| 订阅者 | movement_x | 结果 |
|---|---|---|
| 有 | 任意 | 帧级扫描即被推送走（不等货到端点，无需自身收到消息） |
| 无 | ≠0 | 走到 ±halfRange 停住，持续持货 |
| 无 | 0 | 静止持货 |

### 推送仲裁（多下游订阅同一上游）

| 情形 | 结果 |
|---|---|
| 持有方有货 | 推送给 seq 最小（先订阅）的订阅者；其余顺位等下一箱 |
| 持有方多件货（stacker 双叉） | 同帧按订阅顺序各推一件，取距订阅者探测点最近的货物 |
| 持有方无货 | 本轮不推送，订阅者继续排队 |
| 链式 A→B→C | A 推 B 后 B 即持货，同帧或下一帧再推 C，逐级接力到末端 |
