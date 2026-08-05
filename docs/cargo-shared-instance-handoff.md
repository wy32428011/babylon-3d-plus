# 货物共享实例交接改造方案（已实施，task 语义版）

> 状态：**已实施**（2026-08-04 制定初版，同日按 task 语义重写并落地）
>
> 背景：stacker / conveyor / rgv 三类专用遥测驱动的货物交接最初通过 containerCode 全局认领实现「源设备销毁 + 目标设备重建」，存在模板异步加载空窗和位姿瞬移导致的闪现；且经与后端协商，containerCode 语义不可靠。现改为 **task（front_task/back_task/task）作为全局货物唯一身份 + 共享实例移交 + 动画插值补全**。

## 核心语义

- **全局身份 = task**：stacker/rgv 读 `${side}_task`，conveyor 读无前缀 `task`；数值 0 或缺失为匿名，不参与全局接管。
- **containerCode 退化为纯元数据**（货物命名/metadata），不再参与唯一性逻辑。
- **三张货物表即全局注册表**：持有条目的 map 所属设备即 owner（持有即锁）。
- **新 task 边沿触发**：设备接到新 task 后在自己的刷出时机生成货物并加锁；下一个设备接到同 task 并到达自身刷出时机时，**接管（adopt）** 上一设备的货物实例并加锁，旧设备因 task 边沿不再触发而无法抢回。

## 实现机制

### 1. 货物条目移交（adopt，替代销毁重建）

`GeneratedCargoRuntimeEntry` 新增 `task`、`handoff` 字段，是设备中立结构，直接移交：

- 门面 `SpecializedTelemetryRuntime.adoptGlobalCargoByTask(task, claimingKey)`：扫三张 map 找同 task 条目 → 持有方 driver `detachClaimedCargoByKey(key)`（清模型遥测引用、**从 map 取出不销毁**）→ 返回条目；空 task 直接返回 null。
- 接管方：更新 `assetCode` 为本机编号、按本机 key 入本机 map、以条目当前世界位姿创建 `handoff` 过渡状态，并销毁本侧刚建的占位条目（从未渲染，无视觉影响）。
- 未接管到则走自建路径（`getOrCreate*Cargo`），记录 task。
- `generatorEntityId` 由接管方的 `syncGeneratedCargoVisual` 自然覆盖；`disposeCargoForGenerator`/`disposeAllCargo`/`disposeCargoForAssetCode` 逐表扫描逻辑不变，天然幂等。

### 2. 交接插值过渡层（与状态机解耦）

- `CARGO_HANDOFF_SECONDS = 1.0`（types.ts，可调）。
- `createCargoHandoffState(cargo)`：adopt 时记录货物当前世界位姿（root 无父级，本地位姿即世界位姿）。
- `resolveCargoHandoffPose(cargo, targetPosition, targetRotation, deltaSeconds)`：三个 `update*CargoPose` 算出各自最终目标位姿后统一过一层 lerp/slerp，progress 到 1 自动清除。
- 关键性质：**目标位姿每帧动态计算**（stacker 叉尖随叉移动、conveyor 行程位置、rgv 工位），插值天然追踪动态目标；两设备交替接管同 task 时过渡反复重启，但起点永远是当前世界位姿，视觉连续无跳变。
- RGV 自身的 `RGV_CARGO_TRANSFER_SECONDS` 状态机插值（列↔车）与 handoff 层叠加互不干扰。

### 3. 各设备刷出时机与锁

| 设备 | 刷出时机 | 锁的实现 |
|---|---|---|
| conveyor | 新 task 边沿登记 `pendingTask` → 光电（front/back_has_goods）有货且 movement_x 非 0 时刷出/接管；刷出端由运行方向决定（正转刷轨迹起点、反转刷终点） | `currentTask` 同 task 不重生；停线且双光电无货时清空并复位 `currentTask`（允许 task 复用），pendingTask 保留等待确认 |
| stacker | command 边沿（取货初始化/放货补建）不变 | command 边沿不重复触发，天然不反抢 |
| rgv | movement_z 起转边沿/放货补建不变 | 同上 |

- conveyor 匿名模式（快照无数值 task 字段）保留光电有货 + 线体运行的双条件刷出逻辑，设备自管理，不参与全局接管。
- 被接管的 conveyor 货物：`detachClaimedCargoByKey` 清空 `cargoCode`，`currentTask` 保持 → 光电持续有货也不会重生（取代了原 containerCode 时代的 `claimedAwaySource` 闩锁）。

### 4. 视觉连续性

- 移交保留原 `outputOwner`（模板实例）和 `fallback`，接管帧即可见；
- 接管方 generator 相同 → target 签名一致无副作用；不同 → `syncModelGeneratorResolvedTarget` 的 `loadToken` 机制异步换装。

### 5. 兼容边界

- **匿名货物**（task 0/缺失）：不参与 adopt，设备自管理销毁，行为不变；
- **fetch 滞留箱**（`keepCargoForFetchRowSync`）：无模型引用，detach 天然兼容；
- 生成器回退 `runtimeAssetCode = containerCode || assetCode` 不变量不受影响。

## 模拟器 task 语义

- `scripts/simulate-stacker-mqtt.mjs`：stacker 每个 8 秒任务周期发稳定 `jobTask = 7000 + floor(seconds/8)`（活动侧，另一侧 0）；conveyor movement 场景 `task = 304 + floor(seconds/4)`（与货物条码同周期，周期内恒定）。
- `src/runtime/mqtt/StackerTelemetrySimulator.ts`：同步 8 秒周期稳定 task。
- `scripts/publish-stacker-full-demo.mjs`：每个库位任务一个 taskId（`loopIndex * tasksTotal + taskIndex + 1`），一轮任务内恒定、逐轮递增。

## 改动清单（已落地）

| 文件 | 改动 |
|---|---|
| `telemetry/specialized/types.ts` | 条目加 `task`/`handoff`；`CARGO_HANDOFF_SECONDS`；`normalizeCargoTask`/`createCargoHandoffState`/`resolveCargoHandoffPose`；`ConveyorModelTelemetryState` 改 `currentTask`/`pendingTask`；context 接口 `adoptGlobalCargoByTask` |
| `telemetry/specialized/SpecializedTelemetryRuntime.ts` | 门面 adopt 实现（三表扫描 → detach → 返回条目） |
| `telemetry/specialized/stackerDriver.ts` / `rgvDriver.ts` | 认领点改读 `${side}_task` + adopt-or-create；`detachClaimedCargoByKey`；pose 接 handoff 插值（deltaSeconds 透传） |
| `telemetry/specialized/conveyorDriver.ts` | task 边沿登记 + 光电确认刷出；adopt-or-create；同 task 锁与复位；匿名模式保留 |
| `telemetry/specialized/specializedModelAssets.ts` | conveyor 状态创建/重置同步新字段 |
| 三个模拟器 | task 稳定语义 |

## 验证

- `npm run typecheck` 通过；`npm run test:telemetry` 回归。
- 场景回归：stacker→conveyor、conveyor→conveyor 同 task、conveyor→rgv、rgv→stacker 交接无闪现；匿名货物行为不变；连续过货（不同 task）正常刷出。
