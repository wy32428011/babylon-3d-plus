# 货物共享实例交接改造方案（未实施）

> 状态：**未实施**（2026-08-04 制定，待实施）
>
> 背景：stacker / conveyor / rgv 三类专用遥测驱动的货物交接目前通过 containerCode 全局认领实现「源设备销毁 + 目标设备重建」，存在模板异步加载空窗和位姿瞬移导致的闪现。本方案改为共享货物实例移交 + 动画插值补全。

## 现状与问题

当前交接链路（以 containerCode 全局认领实现）：

1. 目标设备 `getOrCreate*Cargo` **新建**条目：新 `TransformNode` root、`outputOwner: null`、`fallback: null`；
2. `claimGlobalCargoContainerCode` 让源设备 `releaseClaimedCargoByKey` **销毁**旧条目（dispose root + 模板 + Box）；
3. 目标设备首帧 `syncGeneratedCargoVisual` 重新解析生成器目标，模板**异步加载期间无输出**（或回退 Box 闪一下），且位姿直接跳到目标锚点。

闪现 = 销毁/重建的渲染空窗 + 位姿瞬移。

## 核心思路

把认领语义从「销毁重建」改为「**实例移交（adopt）+ 纯视觉插值过渡层**」，完全不动三个 driver 各自的状态机。

### 1. 货物条目移交（替代销毁）

`GeneratedCargoRuntimeEntry` 是不可分设备的中立结构（root/outputOwner/fallback/generatorEntityId），具备直接移交条件：

- 门面 `claimGlobalCargoContainerCode` 改为 `tryAdoptGlobalCargo(containerCode, claimingKey): GeneratedCargoRuntimeEntry | null`：
  - 找到持有同码货物的其他设备时，调用该 driver 的 `detachClaimedCargoByKey(key): entry | null`（由现有 `releaseClaimedCargoByKey` 拆分：清模型遥测引用不变，**销毁改为从源 map 取出并返回**）；
  - 目标 driver 拿到条目后：更新 `assetCode` 为目标设备编号，`containerCode` 不变，按目标键插入自己的 map，**替代**自己刚创建的占位条目（占位条目未渲染过，直接丢弃，无视觉影响）；
  - 未找到则走现有自建路径。
- 移交后 `generatorEntityId` 由目标设备的 `syncGeneratedCargoVisual` 自然覆盖，源生成器删除时 `disposeCargoForGenerator` 不会误杀已移交货物。

### 2. 交接插值过渡层（与状态机解耦）

条目新增字段：

```ts
handoff: { fromPosition: Vector3; fromRotation: Quaternion; progress: number } | null;
```

- adopt 时记录货物**当前世界位姿**（root 无父级，`position/rotationQuaternion` 即世界值），`progress = 0`；
- 三个 `update*CargoPose` 算出各自最终目标位姿后（stacker 叉尖/箱位、conveyor 行程位置、rgv 工位/交接插值结果），统一过一层：

```ts
if (cargo.handoff) {
  pose = lerp/slerp(handoff.from, targetPose, easing(handoff.progress));
  handoff.progress += deltaSeconds / CARGO_HANDOFF_SECONDS; // 到 1 清除
}
```

- 关键性质：**目标位姿是每帧动态计算的**（如 stacker 叉尖随叉移动），插值天然追踪动态目标，无需预知路径；两设备交替认领同码时过渡反复重启，但起点永远是当前世界位姿，视觉上仍然连续、无跳变；
- 时长新增共享常量 `CARGO_HANDOFF_SECONDS`（建议 0.8~1.2s，可调），与 RGV 自身的 `RGV_CARGO_TRANSFER_SECONDS` 状态机插值互不干扰——adopt 到 RGV 时工位状态置 `onBoard/progress=1` 钉工位，视觉过渡全由 handoff 层负责。

### 3. 视觉连续性（不换装空窗）

- 移交保留原 `outputOwner`（模板实例）和 `fallback`，接管帧即可见；
- 目标设备 generator 与源相同 → target 签名一致，`syncModelGeneratorResolvedTarget` 无副作用；
- generator 不同导致签名变化 → 需核对 `syncModelGeneratorResolvedTarget` 是否「新输出加载完成前保留旧输出」：若不是，补强为换装期间保留旧 output，加载完成再替换（复用现有 `loadToken` 机制），杜绝换装空窗。

### 4. 兼容边界（维持现状）

- **匿名货物**（空码/`__anonymous__`）：不参与 adopt，设备自管理销毁，行为不变；
- **fetch 滞留箱**（`keepCargoForFetchRowSync`）：无模型引用，`detach` 天然兼容；
- `disposeAllCargo` / `disposeCargoForAssetCode` / `disposeCargoForGenerator`：条目全局只存在于一张 map，逐表扫描逻辑不变，幂等。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/runtime/babylon/telemetry/specialized/types.ts` | 条目加 `handoff` 字段；`CARGO_HANDOFF_SECONDS` 常量；context 接口 `claimGlobalCargoContainerCode` → `tryAdoptGlobalCargo` |
| `src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime.ts` | 门面 adopt 实现（找持有者→detach→返回条目） |
| `src/runtime/babylon/telemetry/specialized/stackerDriver.ts` / `conveyorDriver.ts` / `rgvDriver.ts` | `releaseClaimedCargoByKey` 拆出 `detachClaimedCargoByKey`；认领处改为 adopt 优先；`update*CargoPose` 末尾接 handoff 插值 |
| `src/runtime/babylon/SceneRuntime.ts` | 视核对结果补强生成器换装「新就绪再换旧」 |

## 实施步骤

1. 类型 + 门面 adopt 机制（含三个 driver 的 detach 拆分）；
2. 三个 driver 认领点接入 adopt + handoff 初始化；
3. 三个 pose 函数接插值层；
4. 核对/补强生成器换装连续性；
5. 模拟器回归：stacker→conveyor、conveyor→conveyor 同码、conveyor→rgv、rgv→stacker 交接观察无闪现；匿名货物行为不变。

预计改动集中在 5 个文件，无新增文件。
