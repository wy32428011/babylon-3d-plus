# 模型生成器 Fetch 数据源与 ThinInstance 合批渲染设计

日期：2026-07-18

## 背景

模型生成器当前仅支持 MQTT 驱动：接收设备遥测数据 → 匹配规则 → 生成单个模型实体（InstancedMesh 或独立 AssetContainer）。仓储场景中需要在货架库位上静态展示大量货物，数据来源为 HTTP 接口而非 MQTT 遥测，且实例数量可能很大（数百到数千个同类货物）。逐实例渲染在大量货物时性能不足。

## 目标

- 模型生成器新增 fetch 数据源模式，与现有 MQTT 模式互斥，由外部事件驱动。
- 工具栏新增 fetch URL 配置面板，请求地址全局存储。
- 事件携带 assetCode 等参数，与工具栏配置的 URL 拼接后发起请求。
- fetch 返回的货物数据先同步到仓储逻辑层，再驱动渲染。
- 通过 binding.assetCode 匹配 Locator.assetId，确定货物展示的目标库位。
- 使用 Babylon thinInstance 对同源货物合批渲染，单次 draw call 渲染全部实例。
- 保持现有 MQTT 模式语义、场景 JSON、绑定和规则语义完全兼容。

## 非目标

- 不修改 Locator 的数据模型或运行时结构。
- 不修改 SharedModelAssetCache 或 InstancedMesh 路径。
- 不支持带脚本的模型作为 thinInstance 源（材质/几何需要实例级隔离）。
- fetch 模式本轮不参与仓储流转（货物不移动），仅做静态库存展示。

## 已证实约束

- 绑定中的 `assetCode` 在两种模式下语义不同：MQTT 模式匹配 MQTT topic 资产编号；fetch 模式匹配 Locator 的 `assetId`。
- thinInstance 矩阵使用 Locator box 的世界坐标计算，box 网格由 `createLocatorBoxes` 按 columns/layers 生成。
- 规则匹配复用现有 `resolveModelGeneratorTargetFromSnapshot` 不可行（fetch 数据不是 DeviceTelemetrySnapshot），需新增轻量匹配路径。
- Babylon.js `thinInstanceSetBuffer` 要求 `Float32Array`，每实例 16 个 float（4×4 矩阵）。

## 方案

### 1. 数据模型

`ModelGeneratorComponent` 新增 `dataSource` 字段，其余字段语义不变：

```typescript
type ModelGeneratorDataSource = 'mqtt' | 'fetch';

type ModelGeneratorComponent = {
  // ... 现有字段不变
  dataSource: ModelGeneratorDataSource;  // 默认 'mqtt'
};
```

fetch 模式下，`bindings` 中的 `assetCode` 用于匹配 Locator 的 `assetId`。请求基础 URL 通过工具栏面板全局配置，事件携带 assetCode 等参数拼接到 URL。

### 2. 工具栏配置面板

工具栏新增 fetch 配置入口按钮，点击弹出配置面板：

- fetch 基础 URL 输入框（存入场景级配置）
- API Key 输入框（存入场景级配置，请求头 `X-API-Key`）
- 说明文案："fetch 模式下，事件参数将与基础 URL 拼接后发起请求"

请求格式：

```typescript
fetch(fetchUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  },
  body: JSON.stringify({ rows: [...] }),
})
```

`rows` 参数来自事件携带的数据（如排标识列表），由外部事件决定本次请求范围。

### 3. 接口数据结构

响应格式：

```typescript
{ records: ContainerInfo[] }

interface ContainerInfo {
  containerCode: string[];  // 货物条码列表
  containerType: string;    // 货物类型（用于规则匹配）
  isEmpty: boolean;         // 空库位跳过渲染
  locType: string;          // 库位排深（对应 storageDepth）
  row: string;              // 排标识
  column: number;           // 列号 → locator boxes column 索引
  layer: number;            // 层号 → locator boxes layer 索引
  tier: number;
  stackingRow: number;
  stackingColumn: number;
  stackingLayer: number;
}
```

字段映射：

| 响应字段 | 映射目标 |
|---|---|
| `containerType` | 生成器规则 `attributeValue` 匹配 |
| `column` | locator box 列索引 |
| `layer` | locator box 层索引 |
| `locType` / `stackingRow` | storageDepth 判定（near/far） |
| `isEmpty` | 为 true 时跳过该库位 |
| `containerCode[0]` | 仓储 cargo 唯一标识 |

### 4. 数据流

```
工具栏配置 fetch URL + API Key（全局，存入 SceneSettings）
  ↓
外部事件（携带 rows 等参数）
  ↓
POST fetchUrl，body: { rows }, headers: { X-API-Key }
  → 响应: { records: ContainerInfo[] }
  ↓
遍历 fetch 模式生成器，binding.assetCode 匹配 containerType / Locator assetId
  ↓
同步到仓储逻辑层（warehouseCargos）
  │  containerType → 规则匹配 → target model
  │  binding.assetCode → Locator.assetId → locatorRuntimeEntry
  │  column/layer → locator.boxes[col][layer] 世界坐标
  ↓
ThinInstance 渲染层
  │  从 warehouseCargos 读取全部货物，按 targetModel 分组
  │  每组取 locator box 世界坐标构造 Float32Array 矩阵
  │  thinInstanceSetBuffer("matrix", ...)
```

### 5. 分层职责

| 层 | 职责 |
|---|---|
| Fetch | 请求外部数据，解析为标准货物条目 |
| 仓储逻辑 | 管理货物生命周期（存/取/删），维护 locator → cargo 映射 |
| 模型生成器 | 规则匹配，决定 cargoType → 渲染模型 |
| ThinInstance | 从仓储读取货物列表，按模型分组合批渲染 |

### 6. ThinInstance 渲染器

新增 `ModelGeneratorFetchRuntime`：

- 注册到生成器的输出宿主上，与 `ModelGeneratorOutputRuntimeEntry` 同级。
- 监听仓储货物变更（增/删/改），增量更新 thinInstance 矩阵。
- 按目标模型分组：
  - 首次加载：异步加载源 GLB，提取首个有顶点的 mesh 顶点数据，创建 batch Mesh。
  - 矩阵计算：`locatorBox.computeWorldMatrix() → 转换到 batch 本地 → Matrix.Translation → Float32Array`。
  - 启用 `thinInstanceEnablePicking`，`thinInstanceRefreshBoundingInfo(true)`。
- 事件再次触发时，重建矩阵 buffer 并重新提交。

### 7. SceneRuntime 集成

- `sync` 中：fetch 模式生成器跳过 `applyDeviceTelemetryFrame` 链路。
- 新增 `handleFetchGeneratorEvent(event)` 公开方法：匹配生成器 → fetch → 仓储同步 → 渲染。
- 通过 IPC 暴露给 renderer：`window.editorApi.triggerFetchGenerator(event)`。

## 兼容性

- `dataSource` 默认为 `'mqtt'`，旧场景加载后行为不变。
- 规则、绑定、序列化格式仅追加字段，不修改现有字段语义。
- MQTT 模式下所有现有行为（仓库流转、堆垛机动效、货物移动）完全不受影响。

## 验收标准

- Inspector 中可切换数据源为 fetch 模式。
- 触发事件后，fetch 请求成功发出并解析。
- 货物正确写入对应 Locator 的库位坐标。
- 同源货物使用 thinInstance 合批渲染，场景中仅存在 batch Mesh。
- 切换数据源回 MQTT 模式后，原有 MQTT 行为不受影响。
- `npm run typecheck` 和 `npm run build` 通过。

## 风险与回退

- 若 fetch 接口不可用，保留上批次渲染结果，打日志，不崩溃。
- 若源模型加载失败，该模型类型跳过，不影响其他模型批次的渲染。
- 所有 thinInstance batch 在生成器释放时统一 dispose，确保无内存泄漏。
