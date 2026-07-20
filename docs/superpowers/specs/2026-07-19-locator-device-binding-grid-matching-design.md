# Locator 设备绑定与网格库位匹配设计

日期：2026-07-19

## 背景

`9e19ae2` 将虚拟定位线框从单 box 升级为 `columns × layers` 网格，`LocatorRuntimeEntry.box` 改为 `boxes: Mesh[]`。但 `LocatorRuntimeEntry` 缺少 `columns`、`layers`、`startColumn`，导致 `ModelGeneratorFetchRuntime.getLocatorBoxWorldMatrix()` 无法正确计算 `boxIndex`，column/layer 索引永远错误。

更根本的问题是：当前的库位匹配依赖 `assetId` 字符串（格式 `列-层-排`）做 `locatorTargets.get(assetId)`。网格化后一个 Locator 实体覆盖多个库位，却只有一个 `assetId`，无法区分实体内的不同 box。同时缺少与堆垛机的显式绑定，匹配只能靠命名约定。

## 目标

- `LocatorComponent` 新增 `deviceAssetCode` 和 `rowNumber`，建立与堆垛机的显式绑定关系。
- `LocatorRuntimeEntry` 补全 `columns`、`layers`、`startColumn`、`deviceAssetCode`、`rowNumber`。
- 库位匹配从"按 `assetId` 字符串"改为"按 `deviceAssetCode + rowNumber` 找 Locator → 按 `to_x/to_y` 定位具体 box"。
- 正确处理 `startColumn` 偏移（第一列可能不是 1）。
- 支持多个 Locator 绑定同一台堆垛机（如不同排或不同列段）。
- 修复 `ModelGeneratorFetchRuntime` 的 boxIndex 计算。
- 旧场景通过默认值和兼容路径保持可用。

## 非目标

- 不修改 `assetId` 的序列化格式（保留字段但降级为展示用途）。
- 不改变 Locator box 的视觉渲染或 `createLocatorBoxes` 的生成顺序。
- 不影响 MQTT 模式下的仓储流转逻辑。

## 已证实约束

- `createLocatorBoxes` 按 `layer→col` 顺序生成：`boxes[layer * columns + col]`。
- `startColumn` 是 `LocatorComponent` 已有字段，默认 `1`。
- `to_x/to_y/to_z` 来自堆垛机遥测，均为 1-based 整数。`to_z` 对应排号。
- 多个 Locator 可能绑定同一 `deviceAssetCode` + `rowNumber`（覆盖不同列段），匹配时需按 `to_x/to_y` 范围过滤。
- `DeviceTelemetrySnapshot.assetCode` 是堆垛机自身的资产编号，不是 Locator 的 assetId。

## 方案

### 1. 数据模型

```typescript
// LocatorComponent 新增字段
type LocatorComponent = {
  // ... 现有字段不变
  deviceAssetCode: string;  // 关联的堆垛机资产编号，默认 ""
  rowNumber: number;       // 排号 (对应 to_z)，默认 1
};

// LocatorRuntimeEntry 补全字段
export type LocatorRuntimeEntry = {
  root: TransformNode;
  boxes: Mesh[];
  material: StandardMaterial;
  assetId: string;
  signature: string;
  columns: number;          // 新增：列数
  layers: number;           // 新增：层数
  startColumn: number;      // 新增：起始列号
  deviceAssetCode: string;  // 新增：关联设备
  rowNumber: number;      // 新增：排号
};
```

### 2. 匹配规则

```
堆垛机遥测:
  assetCode = "DDJ2"     (堆垛机自身的资产编号)
  to_x = 3, to_y = 2, to_z = 1

步骤 1: 找到所有 locator 满足:
  deviceAssetCode === "DDJ2"
  rowNumber === to_z (1)

步骤 2: 在结果中过滤出覆盖 to_x/to_y 范围的:
  startColumn <= to_x < startColumn + columns
  1 <= to_y <= layers

步骤 3: 定位具体 box:
  columnIndex = to_x - startColumn      (0-based)
  layerIndex  = to_y - 1               (0-based)
  boxIndex = layerIndex * columns + columnIndex
  box = locator.boxes[boxIndex]
```

若未匹配到任何 Locator，回退兼容路径：`locatorTargets.get(to_x + '-' + to_y + '-' + to_z)`，保持旧场景可用。

### 3. locatorTargets 索引

新增按设备的二级索引，与现有 `assetId` 索引共存：

```typescript
// 现有索引保留（兼容旧场景）
private readonly locatorTargets = new Map<string, LocatorRuntimeEntry>();

// 新增按设备 + 排号索引
private readonly locatorDeviceIndex = new Map<string, Map<number, LocatorRuntimeEntry[]>>();

// 查找方法
private findLocatorByDevice(
  deviceAssetCode: string,
  rowNumber: number,
  toX: number,
  toY: number,
): LocatorRuntimeEntry | null
```

查找顺序：
1. 新索引命中 → 按步骤 2 过滤，返回第一个匹配的
2. 新索引未命中 → 回退 `assetId` 字符串匹配

### 4. 影响范围

| 文件 | 改动 |
|------|------|
| `src/editor/model/components.ts` | `LocatorComponent` 加 `deviceAssetCode`、`rowNumber` |
| `src/editor/model/SceneDocument.ts` | `createLocatorEntity` 设置默认值；`sanitizeLocatorComponent`（若有）补充新字段 |
| `src/editor/panels/LocatorInspector.tsx` | 新增 `deviceAssetCode` 输入框和 `rowNumber` 数字输入 |
| `src/editor/project/SceneSerializer.ts` | 序列化新字段，反序列化缺字段时补默认值 |
| `src/runtime/babylon/SceneRuntime.ts` | `LocatorRuntimeEntry` 补字段；`createLocator`/`syncLocatorEntity` 传值；`rebuildLocatorTargetIndex` 建新索引；`applyStackerTelemetryToModel` 改用 `findLocatorByDevice` |
| `src/runtime/babylon/ModelGeneratorFetchRuntime.ts` | `getLocatorBoxWorldMatrix` 用 `locator.columns` 替代错误计算；外部传入的 column/layer 映射到正确的 `boxIndex` |

### 5. Inspector 设计

在 LocatorInspector 的面板中，于现有 `assetId` 输入框下方新增：

```
关联设备编号  [________________]  ← deviceAssetCode
排号          [___]              ← rowNumber (数字输入)
```

默认值：`deviceAssetCode = ""`，`rowNumber = 1`。

### 6. Fetch 运行时 box 索引修复

当前错误代码：

```typescript
// 永远算出 columns = boxes.length
const columns = locator.boxes.length > 0
  ? Math.max(1, locator.boxes.length / Math.max(1, Math.ceil(
      locator.boxes.length / locator.boxes.length)))
  : 1;
```

修复后：

```typescript
const columns = locator.columns;
const boxIndex = instance.layer * columns + instance.column;
```

`instance.column` 和 `instance.layer` 来自 fetch 响应，已经是 0-based 索引（在 fetch runtime 的匹配阶段完成从实际列号到 0-based 的转换）。

### 7. 堆垛机目标定位改造

`applyStackerTelemetryToModel` 当前通过 `locatorTargets.get(snapshot.targetLocationKey)` 查找目标 Locator。改为：

```typescript
const targetLocator = this.findLocatorByDevice(
  snapshot.assetCode,
  readIntegerField(snapshot.fields, 'to_z') ?? 0,
  readIntegerField(snapshot.fields, 'to_x') ?? 0,
  readIntegerField(snapshot.fields, 'to_y') ?? 0,
);
```

## 兼容性

- `deviceAssetCode` 默认 `""`，`rowNumber` 默认 `1`。
- `assetId` 字段保留，序列化不变。
- 旧场景（无 `deviceAssetCode`）走 `assetId` 字符串匹配回退路径。
- `rebuildLocatorTargetIndex` 同时重建新旧两套索引。
- `LocatorRuntimeEntry` 新增字段在 `createLocator` 时设置默认值，不会 undefined。

## 验收标准

- 配置 `deviceAssetCode` + `rowNumber` 后，堆垛机遥测 `to_x/to_y/to_z` 能正确定位到对应网格 box 的世界坐标。
- `startColumn` 不为 1 时，列偏移计算正确。
- 多个 Locator 绑定同一设备时，按 `to_x/to_y` 范围匹配到正确的那个。
- 旧场景（未配 `deviceAssetCode`）的堆垛机定位行为不变。
- `ModelGeneratorFetchRuntime` 的 thinInstance 矩阵写入正确的 Locator box 世界位置。
- `npm run typecheck` 和 `npm run build` 通过。
