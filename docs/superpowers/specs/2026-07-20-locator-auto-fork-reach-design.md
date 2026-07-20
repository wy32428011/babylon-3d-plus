# Locator 移除 storageDepth，改为目标距离自动判断货叉段数

日期：2026-07-20

## 背景

当前 `LocatorComponent.storageDepth`（`near`/`far`）要求用户在每个库位的 Inspector 中手动选择"近排（一段货叉）"或"远排（二段货叉）"。运行时的 `resolveStackerStorageForkReach()` 读取该标记，决定货叉允许的最大行程：

- `near` → `stageOne`（只允许第一段叉出）
- `far` → `stageOne + stageTwo`（允许两段全伸出）

这个手动标记存在两个问题：

1. **冗余**：库位是"近排"还是"远排"本质上是货叉到目标库位的投影距离，运行时完全可以通过定位信息计算出来。
2. **易出错**：用户可能忘记设置、设置错误，或者场景调整后标记与实际位置不一致。

`stackerStorageLocation.ts` 中的 `resolveStackerStorageForkReach()` 是唯一引用 `storageDepth` 做业务决策的函数，其余引用仅用于传递、序列化或视觉区分（远排橙色边框）。

## 目标

- 移除 `LocatorStorageDepth` 类型定义和 `LocatorComponent.storageDepth` 字段。
- `resolveTargetLocatorForkReach()` 改为根据货叉参考中心到目标位在货叉轴（模型局部 X）上的投影距离自动判断：
  投影距离 > `stageOne` → 返回 `stageOne + stageTwo`，否则返回 `stageOne`。
- `applyLocatorStyle()` 不再接收 `storageDepth` 参数，Locator 盒子始终使用默认边框色 `LOCATOR_EDGE_COLOR`（不再用橙色标记远排）。
- `resolveStackerStorageForkReach()` helper 函数从 `stackerStorageLocation.ts` 中移除。
- 旧场景 JSON 中的 `storageDepth` 字段由 `normalizeLocator` 自动忽略，无需显式迁移。
- 同步更新所有测试、脚本、示例和文档。

## 非目标

- 不改变 `StackerForkReachConfig`（`stageOne`/`stageTwo`/`total`）的结构或默认值。
- 不改变 `splitForkOffset`、`updateForkOffset`、`resolveForkCalibrationDistance` 等货叉运动计算逻辑。
- 不改变 `resolveStackerStorageTargetOffsets` 的行走/升降偏移计算。
- 不修改 Locator box 的生成逻辑（`createLocatorBoxes`）或网格结构。
- 不影响 MQTT 堆垛机遥测链路和数据模型。

## 已证实约束

- `getStackerTargetReferencePosition()`（SceneRuntime.ts:2910）已缓存货叉一段节点（stage-one fork nodes）的世界中心，用于行走/升降偏移的参考锚点。该位置同样适合作为货叉投影距离的参考点。
- `resolveForkCalibrationDistance()`（SceneRuntime.ts:3145）使用 `getModelAxis(model.root, 'x')` 作为货叉伸缩轴来投影目标距离，与距离判断所需的投影轴一致。
- `readStackerForkReachConfig()` 的 `stageOne` 默认 0.8m，由 `forkStageOneReach` 参数或 `dataDriven.motion.fork.stageOneReach` 决定。
- `resolveTargetLocatorForkReach` 的返回值 `targetForkReach` 在 `updateForkOffset()` 中作为 max clamp 使用（SceneRuntime.ts:3037），并非直接驱动货叉到该位置——实际伸出距离由 `resolveForkCalibrationDistance` 计算的目标投影距离决定。
- `LocatorRuntimeEntry` 当前有 `storageDepth` 字段（SceneRuntime.ts:324），在 `createLocator`、`syncLocatorEntity`、`rebuildLocatorTargetIndex` 三处赋值。
- 旧场景 JSON 的 `normalizeLocator` 会显式读取 `locator.storageDepth` 并传给 `normalizeLocatorStorageDepth`。删除该行后，JSON 中的旧字段自动被忽略，不产生解析错误。

## 方案

### 1. 数据模型

**删除 `LocatorStorageDepth` 类型**（`components.ts:19`）：

```typescript
// 删除此行
export type LocatorStorageDepth = 'near' | 'far';
```

**`LocatorComponent` 删除 `storageDepth` 字段**（`components.ts:23`）：

```typescript
type LocatorComponent = {
  assetId: string;
  // storageDepth: LocatorStorageDepth;  ← 删除
  length: number;
  width: number;
  height: number;
  columns: number;
  layers: number;
  startColumn: number;
  columnGap: number;
  layerGap: number;
  deviceAssetCode: string;
  rowNumber: number;
};
```

**`LocatorRuntimeEntry` 删除 `storageDepth` 字段**（`SceneRuntime.ts:324`）：

```typescript
export type LocatorRuntimeEntry = {
  root: TransformNode;
  boxes: Mesh[];
  material: StandardMaterial;
  assetId: string;
  // storageDepth: ...  ← 删除
  signature: string;
  columns: number;
  layers: number;
  startColumn: number;
  deviceAssetCode: string;
  rowNumber: number;
};
```

### 2. Store 层适配

**`cloneLocator()`**（editorStore.ts:451）删除 `storageDepth: locator.storageDepth,`。

**`areLocatorsEqual()`**（editorStore.ts:579）删除 `left.storageDepth === right.storageDepth &&`。

**`updateSelectedLocator()`**（editorStore.ts:2412）删除 `storageDepth` 的 patch 合并行：
```typescript
// 删除此行
storageDepth: patch.storageDepth === 'far' ? 'far'
  : (patch.storageDepth === 'near' ? 'near' : before.storageDepth),
```

### 3. 默认值与序列化

**`SceneDocument.ts:473`** — 删除 `createLocatorEntity()` 中的 `storageDepth: 'near',`。

**`SceneSerializer.ts`** — 两处删除：

```typescript
// normalizeLocator() 中删除此行（第 383 行）
storageDepth: normalizeLocatorStorageDepth(locator.storageDepth),

// 删除整个函数（第 397-400 行）
function normalizeLocatorStorageDepth(value: unknown): LocatorStorageDepth {
  return value === 'far' ? 'far' : 'near';
}
```

旧场景 JSON 兼容性：`normalizeLocator` 逐字段构建返回对象，不会读取未显式列出的 key。旧 JSON 中的 `storageDepth` 作为 raw object 的 key 存在，但不会被映射到类型化结果中，自然丢弃。

### 4. Inspector UI

**`LocatorInspector.tsx:98-107`** — 删除整个"库位排深"下拉框：

```tsx
// 删除以下 block
<label className="inspector-row">
  <span>库位排深</span>
  <select
    disabled={disabled}
    value={component.storageDepth}
    onChange={(event) => updateSelectedLocator({
      storageDepth: event.target.value === 'far' ? 'far' : 'near'
    })}
  >
    <option value="near">近排（一段货叉）</option>
    <option value="far">远排（二段货叉）</option>
  </select>
</label>
```

`LocatorInspector.tsx` 不直接 import `LocatorStorageDepth`，只通过 `component.storageDepth` 使用字段，删除字段后类型即报错，编译器会引导确认无遗漏。

### 5. 运行时：移除 storageDepth 传递和视觉依赖

**`createLocator()`**（SceneRuntime.ts:4585）— 删除返回值中的 `storageDepth: 'near',`。

**`rebuildLocatorTargetIndex()`**（SceneRuntime.ts:1164）— 删除 `locator.storageDepth = locatorComponent?.storageDepth ?? 'near';`。

**`syncLocatorEntity()`**（SceneRuntime.ts:1273-1318）：
- 删除 `runtimeLocator.storageDepth = locator.storageDepth;`（第 1289 行）
- 删除包含 `storageDepth` 和 `forkStage` 的 `locatorMetadata` 对象（第 1296-1301 行），替换为仅含 `assetId` 的 metadata：
  ```typescript
  runtimeLocator.root.metadata = {
    ...(runtimeLocator.root.metadata ?? {}),
    storageLocation: { assetId: locator.assetId },
  };
  ```
- box metadata 循环（第 1313 行）中同样替换为简化版 metadata
- 调用 `applyLocatorStyle` 改为 `this.applyLocatorStyle(runtimeLocator, selected)`（第 1315 行）

**`syncEntityPresentation()`**（SceneRuntime.ts:958）— 调用改为 `this.applyLocatorStyle(locator, selected)`。

**`applyLocatorStyle()`**（SceneRuntime.ts:5097-5109）— 签名删除 `storageDepth` 参数，始终使用默认颜色：

```typescript
/** 根据选中状态更新全部 locator 盒子边线和表面颜色。 */
private applyLocatorStyle(entry: LocatorRuntimeEntry, selected: boolean): void {
  const color = selected ? SELECTED_MATERIAL_COLOR : LOCATOR_EDGE_COLOR;
  const color3 = Color3.FromHexString(color);

  entry.material.alpha = selected ? SELECTED_LOCATOR_SURFACE_ALPHA : LOCATOR_SURFACE_ALPHA;
  entry.material.diffuseColor = color3;
  entry.material.emissiveColor = color3;

  for (const box of entry.boxes) {
    box.edgesWidth = selected ? 4 : 2;
    box.edgesColor = this.color4FromHex(color, 1);
  }
}
```

**`writeStackerTelemetryMetadata()`**（SceneRuntime.ts:3905）— 删除 `targetStorageDepth` 行：
```typescript
// 删除
targetStorageDepth: targetLocator?.storageDepth ?? null,
```

### 6. 运行时核心：自动距离判断

**调用点 `applyStackerForkMotion()`**（SceneRuntime.ts:3016-3018）— 改为传入 `model` 和 `targetPosition`：

```typescript
// 旧
const targetForkReach = snapshot.hasTargetLocation
  ? this.resolveTargetLocatorForkReach(targetLocator, reach) ?? 0
  : null;

// 新
const targetForkReach = snapshot.hasTargetLocation && targetPosition
  ? this.resolveTargetLocatorForkReach(model, targetPosition, reach) ?? 0
  : null;
```

`targetPosition` 已在同方法第 3008 行定义为 `targetLocator?.root.getAbsolutePosition() ?? null`，`model` 是方法参数，均可直接使用。

**`resolveTargetLocatorForkReach()` 重写**（SceneRuntime.ts:3168-3175）：

```typescript
/** 根据货叉参考中心到目标位在货叉轴上的投影距离，自动判断是否启用第二段行程。 */
private resolveTargetLocatorForkReach(
  model: ModelRuntimeEntry,
  targetPosition: Vector3,
  reach: StackerForkReachConfig,
): number | null {
  const referencePosition = this.getStackerTargetReferencePosition(model);
  const forkAxis = this.getModelAxis(model.root, 'x');
  const projectedDistance = Math.abs(
    Vector3.Dot(targetPosition.subtract(referencePosition), forkAxis)
  );
  if (!Number.isFinite(projectedDistance)) return null;
  return projectedDistance > reach.stageOne + 0.001
    ? reach.stageOne + reach.stageTwo
    : reach.stageOne;
}
```

设计要点：
- **参考点**：复用 `getStackerTargetReferencePosition()`（一段货叉世界中心，已缓存于 `model.stackerTelemetry.targetReferencePosition`），与行走/升降偏移计算共用同一锚点。
- **投影轴**：复用 `getModelAxis(model.root, 'x')`，与 `resolveForkCalibrationDistance`（SceneRuntime.ts:3162）完全一致。
- **方向无关**：`Math.abs` 消除前后叉方向差异——无论 locator 在货叉前方还是后方，距离判断只关心需要多长的行程。
- **容差**：`+ 0.001`（1mm）防止浮点计算恰好等于 `stageOne` 时误触发两段，避免边界抖动。
- **防御**：`Number.isFinite()` 对 NaN/Infinity 返回 `null`，与原方法返回 `null` 的防御行为一致。

### 7. 移除旧 helper 函数

**`stackerStorageLocation.ts`** — 删除 `resolveStackerStorageForkReach` 及 `LocatorStorageDepth` import：

```typescript
// 删除 import
import type { LocatorStorageDepth } from '../../../editor/model/components';

// 删除函数（第 7-15 行）
export function resolveStackerStorageForkReach(
  storageDepth: LocatorStorageDepth,
  stageOneReach: number,
  stageTwoReach: number,
): number { ... }
```

**`SceneRuntime.ts:99`** — 更新 import：
```typescript
// 旧
import { resolveStackerStorageForkReach, resolveStackerStorageTargetOffsets }
  from './telemetry/stackerStorageLocation';

// 新
import { resolveStackerStorageTargetOffsets }
  from './telemetry/stackerStorageLocation';
```

### 8. 影响范围

| 文件 | 改动 |
|------|------|
| `src/editor/model/components.ts` | 删除 `LocatorStorageDepth` 类型，`LocatorComponent` 删除 `storageDepth` 字段 |
| `src/editor/model/SceneDocument.ts` | `createLocatorEntity` 删除 `storageDepth: 'near'` 默认值 |
| `src/editor/panels/LocatorInspector.tsx` | 删除"库位排深"下拉框 UI block |
| `src/editor/store/editorStore.ts` | `cloneLocator`/`areLocatorsEqual`/`updateSelectedLocator` 删除 storageDepth 相关行 |
| `src/editor/project/SceneSerializer.ts` | `normalizeLocator` 删除 storageDepth 行；删除 `normalizeLocatorStorageDepth` 函数 |
| `src/runtime/babylon/SceneRuntime.ts` | `LocatorRuntimeEntry` 删除 storageDepth；`createLocator`/`syncLocatorEntity`/`rebuildLocatorTargetIndex` 移除 storageDepth 传递；`applyLocatorStyle` 签名去 storageDepth 参数、统一颜色；`resolveTargetLocatorForkReach` 重写为投影距离判断；`writeStackerTelemetryMetadata` 删除 targetStorageDepth；import 删除 resolveStackerStorageForkReach |
| `src/runtime/babylon/telemetry/stackerStorageLocation.ts` | 删除 `resolveStackerStorageForkReach` 函数及 `LocatorStorageDepth` import |
| `tests/telemetry/stackerStorageLocation.test.ts` | 删除 resolveStackerStorageForkReach 的 3 个测试，import 改为只导入 resolveStackerStorageTargetOffsets |
| `tests/telemetry/editorTelemetryConfig.test.ts` | 删除"库位深度 roundtrip"测试（第 167-187 行） |
| `tests/telemetry/specializedTelemetryBinding.test.ts` | 第 125 行正则改为匹配新投影距离逻辑；第 127 行删除 targetStorageDepth 断言；第 136 行类型去 storageDepth；第 145-150 行 deepEqual 仅校验 assetId |
| `scripts/create-stacker-mqtt-demo-scene.mjs` | `createLocatorEntity` 删除 storageDepth 参数和字段；4 处调用移除 `'near'`/`'far'` 实参，更新 entity name |
| `scripts/publish-stacker-full-demo.mjs` | 删除 storageDepth 校验；prefix 描述去掉"近排/远排"；fork 步骤描述去掉"一段/二段货叉" |
| `examples/scenes/stacker-mqtt-demo.scene.json` | 4 个 locator 各删除 `"storageDepth"` 字段 |
| `examples/mqtt/stacker-full-demo-sequence.json` | 4 个 location 各删除 `"storageDepth"` 字段 |
| `docs/stacker-mqtt-full-demo.md` | 移除 near/far 相关描述、字段说明和配置步骤 |
| `docs/superpowers/specs/2026-07-18-model-generator-fetch-thinInstance-design.md` | 更新 `locType` 字段描述（不再映射 storageDepth） |

### 9. 脚本适配详情

**`scripts/create-stacker-mqtt-demo-scene.mjs`**

`createLocatorEntity` 函数签名从：
```js
function createLocatorEntity(id, name, assetId, storageDepth, position, size = {...})
```
改为：
```js
function createLocatorEntity(id, name, assetId, position, size = {...})
```

函数体内的 `storageDepth,` 字段删除。4 个调用点改为：
```js
// 旧
createLocatorEntity('entity_locator_1_1_1', '近排库位 1-1-1', '1-1-1', 'near', vector3(0.9, 1.2, 4))
createLocatorEntity('entity_locator_1_2_1', '远排库位 1-2-1', '1-2-1', 'far',  vector3(1.9, 1.2, 4))

// 新
createLocatorEntity('entity_locator_1_1_1', '库位 1-1-1', '1-1-1', vector3(0.9, 1.2, 4))
createLocatorEntity('entity_locator_1_2_1', '库位 1-2-1', '1-2-1', vector3(1.9, 1.2, 4))
```

**`scripts/publish-stacker-full-demo.mjs`**

- 第 62 行帮助文本：删除 `storageDepth=near 时只用一段货叉，storageDepth=far 时使用两段货叉`。
- 第 115 行：删除 `if (location.storageDepth !== 'near' && ...)` 校验。
- 第 155 行：prefix 从 `` `${location.storageDepth === 'far' ? '远排' : '近排'}库位 ${location.assetId}` `` 改为 `` `库位 ${location.assetId}` ``。
- 第 161 行：步骤描述从 `` `${location.storageDepth === 'far' ? '二段货叉' : '一段货叉'}叉出` `` 改为 `` `货叉叉出` ``。

## 兼容性

- **场景 JSON**：`normalizeLocator` 按字段名显式读取，已删除 `storageDepth: normalizeLocatorStorageDepth(locator.storageDepth)` 行后，旧 JSON 中的 `storageDepth` key 自然被忽略，不产生解析错误。
- **运行时 metadata**：`transformNode.metadata.storageLocation` 不再包含 `storageDepth` 和 `forkStage` 字段。下次 `syncLocatorEntity` 触发时，旧 metadata 被覆盖为仅含 `assetId` 的新对象。消费者如需判断段数，应改为读取 `model.stackerTelemetry.frontForkOffset` 等运行时状态。
- **序列 JSON**（`stacker-full-demo-sequence.json`）：`publish-stacker-full-demo.mjs` 校验删除后，`storageDepth` 字段的存在与否不影响运行。
- **测试**：`editorTelemetryConfig.test.ts` 的 roundtrip 测试直接删除；`stackerStorageLocation.test.ts` 仅保留 offset 测试；`specializedTelemetryBinding.test.ts` 的源码模式断言更新为正则匹配新的投影逻辑。

## 验收标准

1. `npm run typecheck` 零类型错误。
2. `npm test` 全部通过。
3. `npm run demo:stacker:scene` 生成的 `stacker-mqtt-demo.scene.json` 中 locator 组件不含 `storageDepth`。
4. `npm run demo:stacker:mqtt` 运行演示时：
   - 投影距离 ≤ `stageOne`（默认 0.8m）的目标库位只用一段货叉。
   - 投影距离 > `stageOne` 的目标库位启用两段货叉。
   - Locator 盒子统一显示默认青色边框 `#19c7d4`。
5. 旧场景 JSON（含 `storageDepth` 字段）可正常加载，Locator 不报解析错误。
