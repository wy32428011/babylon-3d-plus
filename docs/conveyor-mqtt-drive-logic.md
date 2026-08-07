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
   - 快照断流（`now - receivedAt > staleAfterMs`）→ **默认不驱动**；例外：驱动注册项声明 `applyWhenStale` 且返回 true 时仍用缓存快照驱动。conveyor 的判定是 `conveyorTelemetry.selfDriveDirection !== 0`（见 §9 接管自驱）
3. 命中驱动 → `ConveyorTelemetryDriver.applyToModel(model, snapshot, delta)`：
   - 节流输出状态/故障日志，写入设备 metadata
   - **非故障**时执行本体动画（滚筒/链条）
   - 货物动画 `applyConveyorCargoMotion` **无论是否故障都执行**（故障只门控其中的走行与出货推进，见 §10）

## 2. 输入字段

| 字段 | 类型 | 语义 |
|---|---|---|
| `movement_x` | int | 0 静止，1 正转，2 反转（正负数兜底兼容）。实际读取走 translate 配置的 `fields`+`actionMap`，缺省即 movement_x。**不再门控刷出**：新 task 刷出时若为 0 按正转（1）处理并登记自驱（见 §6.8/§9） |
| `mode` | int | 2=任务完成/清线，0=空闲；缺省（null）视为运行中。1 等其他值无特殊语义 |
| `task` | int | 任务号；缺失=匿名模式；0=无任务（归一化为空串，不触发任何边沿，状态不变） |
| `front_has_goods` / `back_has_goods` | bool | 前后光电，仅用于 mode==2 的销毁判定（字段名可由脚本 `motion.cargo` 覆盖） |
| `containerCode` | string | 货箱条码，仅元数据（命名/metadata），不参与身份唯一性 |
| `rotation` | number | >3 时作为滚筒角速度（度/秒），否则用脚本默认速度 |
| `faulted`（快照级） | bool | 故障门控，见 §10 |

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
- **货物世界位置** = 包围盒中心抬升货箱半高 + 行走轴 × `cargoTravelOffset`
- **货物表**：跨设备共享 `state.conveyorCargoMeshes`，键 `JSON.stringify([assetCode, cargoCode])`；单机单货物，cargoCode 恒为 `'cargo'`；**task 是全局唯一身份**（空串=匿名，不参与跨设备接管）

## 5. 遥测状态字段

| 字段 | 语义 |
|---|---|
| `cargoCode` | 本机持有的货物身份（'cargo' 或 null） |
| `currentTask` | 当前 task，刷出/复用时盖到货物上 |
| `pendingTask` | 已登记待刷出的 task；新 task 边沿当帧消费（刷出或转等待）；等待被 mode 2/0 退出时一并放弃 |
| `lastTask` | 边沿判定基准，**不随清线复位**——同 task 重发（含销毁后）不重刷 |
| `waitingTask` | 正在等待他设备交出的 task；非 null 时不刷出、不走行 |
| `lastMovementDirection` | 最近非 0 运行方向（±1），供他设备计算本机上货坐标 |
| `selfDriveDirection` | 自驱走行方向（±1，0=关闭）：接管货物时登记接管方向；movement_x=0 的新 task 刷出时登记正转 1 |
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
- `waitingTask = null`（旧等待作废）

注意：`task=0` 或缺失不产生边沿；同 task 重发不产生边沿。

### 6.3 运行方向
从 translate 配置（或 movement_x 兜底）读 `movementDirection`；非 0 时记入 `lastMovementDirection`。

### 6.4 等待方退出（level 判断）
`mode === 2 || mode === 0` → `waitingTask = null`；若退出前在等待则**同时放弃 `pendingTask`**（刷出判定已提前到 task 边沿，不放弃会当帧立即重新等待）。
持有方货物中途消失**不**自动退出等待——等待只能被 mode 2/0、新 task 边沿、被交出三种方式结束。

### 6.5 持有方交出（移交优先于销毁）
本机持有带 task 的货物，且（`mode==2 || mode==0 || 新 task 边沿`）时：
- 扫全局找等待该 task 的输送线（`waitingTask === task` 的他设备）
- **有等待者** → 移交给「货物世界坐标距其**上货坐标**最近」的等待设备（见 §8），此后本机 `cargoCode=null`、货物从持有表摘除
- **无等待者** → 落入 6.6 的销毁/遗留规则

level 判断（非纯边沿）：mode 持续为 2/0 期间出现等待者也能交出，避免「持有方先停线、等待者后出现」的死锁。

### 6.6 mode==2 销货
条件：`mode==2 && 双光电都无货`（与线体是否走行无关；光电有货则整个块跳过）：

- **cargoAutoDispose 开启（缺省）** → 销毁本机全部货物，`cargoCode=null`，return
- **cargoAutoDispose 关闭** → 保留货物与位姿（遗留箱）：等下游凭 task 取走（6.5），或新 task 刷出时复用（6.8）；无货物时 return

### 6.7 等待中截断
`waitingTask` 非 null → return：不刷出、不走行，**本机已有货物同样静止**。

### 6.8 task 模式刷出
条件：`pendingTask` 非空（**新 task 边沿当帧即刷出/等待判定，不再等 movement_x 非 0**）：

1. **等待判定**：他设备**输送线**持有同 task 货物 → `waitingTask = pendingTask`，return（pendingTask 保留，被交出后仍按原 task 接管）
2. 否则消费 `pendingTask = null`，`spawnDirection = movementDirection ≠ 0 ? movementDirection : 1`（movement_x=0 按正转处理），按本机是否有遗留箱分两支：
   - **遗留箱复用**（仅 `cargoAutoDispose === false` 且本机持有货物）：不销毁不重建，`cargoTravelOffset` 保持滞留位置，货物 `task` 盖上新 task、`containerCode` 更新（新值优先，空则保留旧值）
   - **新建/接管**：先销毁本机旧箱（自动销毁开启时换 task 即此路径），`cargoTravelOffset = spawnOffset`（按 spawnDirection 计算的刷出端），然后 `adoptOrCreateConveyorCargo`：
     - `adoptGlobalCargoByTask` 命中（stacker/RGV 持有的同 task 货物，或历史遗留的他机货物）→ **立即接管**：实例不销毁，换绑本机，登记 1 秒交接插值（handoff），从原世界位姿平滑接入本机走行
     - 未命中 → 自建新货箱
3. `movementDirection === 0` 时登记 `selfDriveDirection = 1`：刷在轨迹起点后自驱移向终点，下一条新消息到达恢复字段驱动（见 §9）

### 6.9 匿名模式刷出
快照无 `task` 字段时：本机无货物且 `movementDirection ≠ 0` → 在刷出端自建匿名货箱（`task=''`，不参与全局接管）；`movementDirection === 0` → return。已有货物时不再刷出，直接走进行。

### 6.10 走行
`cargoDirection = movementDirection ≠ 0 ? movementDirection : selfDriveDirection`（自驱回退，见 §9）：
- 非故障且方向非 0 → `cargoTravelOffset += cargoDirection × forwardSign × cargoSpeed × delta`
- `cargoSpeed` = translate 配置速度，缺省 0.3 m/s（与链条同源，链/货速度不脱节）

### 6.11 出货动画 + 钳制
存在等待本 task 的设备时（`findWaitingConveyorModels` 命中），**无论 movement_x 是否为 0**（故障除外）：
- 每帧向 `pushTarget = forwardSign × (halfRange + 货箱轴向长度/2)` 推进（moveNumberTowards，按 cargoSpeed），**最多越出轨迹终点半个货箱长度即停**
- 钳制范围同步放宽到 pushTarget
- 无等待者时货物走到 ±halfRange 即停
- **动画期间或结束后收到释放逻辑（mode 2/0、新 task 边沿）都立即交出**（6.5 判定不受动画进度影响）

最终 `cargoTravelOffset` clamp 到当前允许区间。

### 6.12 视觉落地
- `syncGeneratedCargoVisual` 同步货箱模板/回退 Box
- `resolveCargoHandoffPose`：handoff 未完结时在「接管起点世界位姿 → 当前目标位姿」间插值（1 秒），完结清除
- `setGeneratedCargoRootPose` 写世界位姿

## 7. 等待/交出协议（仅持有方为输送线）

三方视角：

- **等待方（下游）**：新 task 边沿（不再要求线体运行）+ 发现他机输送线持有同 task 货物 → 不刷出、不走行，登记 `waitingTask`（`pendingTask` 保留）。退出：mode 2/0（同时放弃 pendingTask）、新 task 边沿、被交出
- **持有方（上游）**：有等待者 → 出货动画（6.11，最多越出终点半箱）；动画期间或结束后收到 mode 2/0 或新 task 边沿 → 交出（6.5）
- **接管方（等待方被选中后）**：见 §8/§9

stacker/RGV 持有的货物**不在等待协议内**：下游刷出时直接 `adoptGlobalCargoByTask` 立即接管（6.8）。

## 8. 交出仲裁（`transferConveyorCargoToNearestWaiter`）

1. **上货坐标**：每个等待设备按其 `lastMovementDirection`（缺省 1）的刷出端世界坐标
2. **最近者胜**：货物当前世界坐标与各等待者上货坐标距离平方最小者接管（多等待者仲裁）
3. 等待者已有遗留箱 → **先销毁**（单机单货物约束；与 6.8 的复用路径不同——交出场景两箱无法共存）
4. 持有方：表项删除（货物实例不销毁）、`cargoCode=null`、`currentTask` 若等于该 task 则清空
5. 接管方：
   - `cargoCode='cargo'`、`cargoTravelOffset = 自身刷出端`、`pendingTask=null`、`waitingTask=null`
   - `selfDriveDirection = 接管方向`（§9）
   - 货物 `assetCode` 换绑、`handoff` 登记（1 秒视觉插值保持连续）
6. 输出移交日志 `Conveyor {持有方} 凭 task={task} 将货物移交 {接管方}`

链式送货：接管后若仍有其他设备等待同 task，接管方变成新持有方，继续出货动画 → 再交出，逐级传递。

## 9. 接管自驱（断流不停货）

问题：帧调度默认不驱动断流设备；边缘触发发布的承接方等待期间无新消息，快照断流后若不做处理，货箱会静止到下一条消息。

机制：
- 两个登记入口：交出时给接管方登记 `selfDriveDirection = 接管方向`（8.5）；**movement_x=0 的新 task 刷出时登记 `selfDriveDirection = 1`**（6.8，从轨迹起点移向终点）
- 走行时快照 movement 为 0 回退到自驱方向（6.10）
- facade 的 `applyWhenStale` 钩子让处于自驱的输送线在快照断流时仍被帧调度驱动（用缓存快照）
- **任何新消息到达**（receivedAt 变化）→ 自驱清零，恢复字段驱动（movement_x=0 即停车，mode 2/0、新 task 正常生效）
- 持续到货：走行至行程端 clamp 停住；有下游等待则继续出货动画

## 10. 故障（faulted）行为

| 逻辑 | 故障时 |
|---|---|
| 本体滚筒/链条动画 | 停止（整个跳过） |
| 货物走行 | 停止 |
| 出货动画推进 | 停止 |
| 新 task 边沿登记 | 照常 |
| 持有方交出 | 照常 |
| mode==2 销毁/遗留 | 照常 |
| 刷出 | 照常（新 task 边沿即刷） |
| 状态日志 | 输出故障日志（节流到签名变化） |

## 11. 退出运行预览清理

`SceneRuntime.endTelemetryPreview()`：
- `disposeAllCargo()` 销毁三张货物表（stacker/conveyor/rgv）全部货物
- 普通模型、生成器输出模型、**合批阵列代表模型**（modelArrayParameterVariants）全部 `resetConveyorTelemetryState()`（清空本文 §5 所有字段，含 waitingTask/selfDriveDirection/lastSnapshotReceivedAt）
- 恢复预览前基线位姿；清理 fetch 批次、诊断状态；MQTT 快照存储由 `client.dispose()` 清空

## 12. 全情况速查表

### 刷出判定（task 模式，新 task 边沿当帧判定，不再等线体运行；movement_x=0 按正转刷在起点并自驱）

| 同 task 货物持有方 | 本机遗留箱 | 结果 |
|---|---|---|
| 他机输送线 | — | 进入等待，不刷出 |
| stacker/RGV | 无 | 立即接管（handoff 插值） |
| stacker/RGV | 有（autoDispose 关） | **遗留箱复用优先**，不触发接管 |
| 无 | 有（autoDispose 关） | 复用遗留箱，盖新 task，滞留位置继续走行 |
| 无 | 有（autoDispose 开） | 销毁旧箱，刷出端新建 |
| 无 | 无 | 刷出端自建 |

### mode=2（双光电无货）

| 持有货物 | 等待者 | autoDispose | 结果 |
|---|---|---|---|
| 有 | 有 | 任意 | 移交最近等待者（不销毁） |
| 有 | 无 | 开 | 销毁 |
| 有 | 无 | 关 | 遗留（等下游取走或新 task 复用） |
| 无 | — | 任意 | 无操作 |

### 等待中（waitingTask 非空）

| 事件 | 结果 |
|---|---|
| 任意帧 | 不刷出、不走行、本机已有货物静止 |
| mode 变 2/0 | 退出等待并放弃 pendingTask（同 task 重发不再重新等待，仅新 task 边沿再判定） |
| 新 task 边沿 | 旧等待作废，走新 task 流程 |
| 被持有方选中交出 | 接管货物：刷出端起走 + 自驱 + handoff 插值 |
| 持有方货物消失（非交出） | **不退出**，继续等 |

### 持有方走行

| 等待者 | movement_x | 结果 |
|---|---|---|
| 无 | ≠0 | 走到 ±halfRange 停住 |
| 无 | 0 | 静止 |
| 有 | 任意 | 推进到 forwardSign×(halfRange+货箱长/2)，越出常规端点半箱即停；动画期间或结束后收到释放都立即交出 |

### 新 task 边沿（持有旧 task 货物时）

| 等待旧 task 的设备 | 结果 |
|---|---|
| 有 | 旧货物移交最近等待者，新 task 当帧即刷出 |
| 无 | 旧货物按 6.8 刷出规则处理（复用/销毁），新 task 当帧即刷出 |
