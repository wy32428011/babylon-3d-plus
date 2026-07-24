# 模型生成器重构方案：多实例 + 设备绑定 + 前置设备驱动货箱流转

> 状态：方案待评审
> 日期：2026-07-22
> 影响范围：编辑器（store / Inspector / 序列化）、运行时（SceneRuntime / warehouse）、示例场景与文档

---

## 1. 背景与目标

### 1.1 现状问题

当前实现存在三个互相耦合的限制：

1. **模型生成器全局唯一**：编辑器强制场景中只能存在一个模型生成器实体；即使绕过编辑器，运行时也只取 `entityIds` 顺序里的第一个生效。
2. **生成器主动绑定设备**：MQTT 模式下由生成器持有 `bindings[]`（sourceId + deviceType + assetCode）去匹配场景中的设备模型，关系方向是"生成器 → 设备"。
3. **跨设备货箱流转依赖中央协调器**：必须显式勾选"启用同一货物跨设备接力"（`warehouseFlow`），并硬编码"入库输送机 → 堆垛机 → 出库输送机"三设备链路，由 `WarehouseFlowCoordinator` 状态机驱动。链路形状固定，无法表达任意拓扑（多入库口、多堆垛机、分流/合流）。

### 1.2 重构目标

| # | 目标 | 说明 |
| --- | --- | --- |
| G1 | 放开模型生成器数量限制 | 编辑器、复制/粘贴/阵列、运行时全部支持多实例 |
| G2 | 反转绑定方向 | 设备（带遥测绑定的模型实体）声明"我使用哪个模型生成器"，生成器退化为纯模板库（rules + defaultTarget） |
| G3 | 删除仓储流转模式 | 移除 `warehouseFlow` 配置与 `WarehouseFlowCoordinator`，不再有中央流转状态机 |
| G4 | 前置设备驱动流转 | 每台设备绑定一个**前置设备资产编号**（`upstreamAssetCode`），货箱的生成本地化到每台设备，交接沿 upstream 链传递 |

### 1.3 非目标

- Fetch 模式（`dataSource: 'fetch'`、`fetchBindings` 匹配 Locator）保持现状，本次不改动。
- 输送机/堆垛机自身的遥测货箱运动学（`applyConveyorCargoMotion`、`getStackerForkCargoPosition` 等）不改，只改货箱的**生成时机、模板来源与销毁时机**。
- Locator 库位的存货/取货语义保留（堆垛机放货完成后货物挂库位），仅改由堆垛机自身驱动，不再经过协调器。

---

## 2. 现状架构（关键代码索引）

### 2.1 模型生成器唯一性限制

| 位置 | 代码 | 说明 |
| --- | --- | --- |
| `src/editor/model/components.ts:128-162` | `ModelGeneratorComponent` | 组件定义：`defaultTarget` / `rules` / `bindings` / `fetchBindings` / `warehouseFlow` / `dataSource` |
| `src/editor/model/SceneDocument.ts:550-570` | `createModelGeneratorEntity()` | 实体工厂 |
| `src/editor/store/editorStore.ts:932-940` | `findExistingModelGeneratorEntity()` | 查找已存在的生成器 |
| `src/editor/store/editorStore.ts:951-976` | `filterDuplicatedModelGenerators()` | 复制/粘贴/阵列时过滤多余生成器 |
| `src/editor/store/editorStore.ts:1597-1623` | `createModelGenerator()` | **唯一性主入口**：已存在则仅选中，不再创建 |
| `src/editor/store/editorStore.ts:1956-1963, 2013-2025, 2192-2199` | 复制/粘贴/阵列 | 调用 `filterDuplicatedModelGenerators()` |
| `src/runtime/babylon/SceneRuntime.ts:893-902, 1048-1058` | `activeModelGeneratorEntityId` | **运行时单例兜底**：只取第一个生成器，其余打印冲突日志 |

### 2.2 MQTT 设备绑定与仓储流转

| 位置 | 代码 | 说明 |
| --- | --- | --- |
| `src/editor/model/components.ts:128-148` | `ModelGeneratorBinding` / `ModelGeneratorWarehouseFlow` | 生成器持有的设备绑定与流转配置 |
| `src/editor/model/telemetryBinding.ts:42-50` | `TelemetryBindingComponent` | 设备侧遥测绑定（`sourceId`/`deviceType`/`assetCode`） |
| `src/editor/panels/ModelGeneratorInspector.tsx:516-563` | 仓储流开关 UI | "启用同一货物跨设备接力" + 三个 binding 下拉 |
| `src/runtime/babylon/SceneRuntime.ts:2435-2474` | `findModelByWarehouseBinding()` | 按 binding 严格匹配模型 |
| `src/runtime/babylon/warehouse/WarehouseFlowCoordinator.ts` | 协调器 | 入库/出库两条状态机，**本次整体删除** |
| `src/runtime/babylon/SceneRuntime.ts:2311-2393` | `updateWarehouseFlowFrames()` | 每帧喂快照给协调器 |
| `src/runtime/babylon/SceneRuntime.ts:2599-2729` | `applyWarehouseFlowVisuals()` / `resolveWarehouseInboundPose()` / `resolveWarehouseOutboundPose()` | 按阶段摆放货物 |

### 2.3 货箱动画现状

- 生成器输出解析：`src/runtime/babylon/modelGeneratorRuntime.ts:36-66` `resolveModelGeneratorTargetFromSnapshot()`（按 rules 匹配遥测快照，回退 defaultTarget）。
- 输送机货箱：`SceneRuntime.ts:2959-2998` `applyConveyorCargoMotion()`，按 `containerCode` / `container_quantity` 创建销毁，`movement_x` 驱动位移。
- 堆垛机货箱：`SceneRuntime.ts:3591` `getOrCreateStackerCargo()` + `3539-3561` `syncGeneratedCargoVisual()`，货叉位置 `3613` `getStackerForkCargoPosition()`。
- 库位存货：`SceneRuntime.ts:4813` `storeWarehouseInboundCargo()`（挂到库位根节点）、`4894` `disposeWarehouseCargo()`。
- Locator 索引：`SceneRuntime.ts:1205-1248` `rebuildLocatorTargetIndex()`（`assetId` 与 `deviceAssetCode + rowNumber` 双索引）。

### 2.4 前置设备概念

当前代码库**不存在** upstream / predecessor / 前置设备 任何语义，设备顺序关系只能由 `warehouseFlow` 的三设备硬编码链路表达。

---

## 3. 目标概念模型

### 3.1 核心概念变化

| 维度 | 现状 | 目标 |
| --- | --- | --- |
| 生成器数量 | 全局唯一 | 任意多个 |
| 绑定方向 | 生成器 `bindings[]` → 设备 | 设备 `cargoGeneratorId` → 生成器 |
| 生成器职责 | 模板库 + 设备匹配 + 流转配置 | **纯模板库**（rules + defaultTarget） |
| 跨设备流转 | 中央协调器（warehouseFlow） | 每台设备声明 `upstreamAssetCode`，交接沿链本地发生 |
| 货箱生命周期 | 协调器创建/挂载/销毁 | 各设备自维护：生成于本设备有货上升沿，销毁于下游接管或本设备清空 |
| 拓扑表达 | 固定 输送机→堆垛机→输送机 | 任意链式/树状拓扑（每设备一个上游，下游数量不限） |

### 3.2 新货箱生命周期

每台带 `telemetryBinding` 的设备独立维护自身货箱，生命周期三态：

```text
[无货] --有货信号上升沿 + upstream 校验通过--> [持有货箱] --下游接管 / 本设备清空--> [无货]
```

1. **生成**：设备遥测出现"有货"上升沿（输送机 `front/back_has_goods`，堆垛机 `取货完成` 等，见 §6.3）：
   - 设备有 `upstreamAssetCode`：校验上游设备处于"可交接"状态（上游持有货箱且其交接侧有货/放货完成），通过后生成本设备货箱，并通知上游销毁对应货箱（视觉交接）。
   - 设备无 `upstreamAssetCode`（入口设备）：直接生成，货物视作系统外部进入。
2. **驱动**：货箱由本设备遥测驱动（沿用现有输送机/堆垛机运动学代码，不改）。
3. **销毁**（先到先生效）：
   - 下游设备（其 `upstreamAssetCode` 指向本设备）完成生成 → 本设备销毁被接管的货箱。
   - 本设备遥测显示无货且无下游接管（末端设备货物离开系统）→ 销毁。
   - 堆垛机特例：放货完成 → 货箱挂到目标 Locator 库位（保留现有 `storeWarehouseInboundCargo` 语义）；取货完成 → 从库位移除并挂到货叉。

### 3.3 货箱模板解析

设备需要生成货箱时：

1. 读取自身 `cargoGeneratorId` 指向的生成器实体。
2. 以**本设备当前遥测快照**为输入，调用现有 `resolveModelGeneratorTargetFromSnapshot()` 解析 rules → 命中规则用 `rule.target`，否则用 `defaultTarget`。
   - 效果保留：可按货物类型/条码等遥测字段让不同设备共用一台生成器但生成不同箱型。
3. 未绑定生成器的设备：回退内置立方体（与当前共享模板缺省行为一致），并在 Console 打印一次性提示。

`containerCode` 作为交接匹配键：下游生成时优先复用上游货箱的 `containerCode`，保证同一货物在链路中条码一致。

---

## 4. 数据结构变更

### 4.1 `ModelGeneratorComponent`（components.ts:128-162）

```ts
// 删除
- ModelGeneratorBinding          // sourceId + deviceType + assetCode
- ModelGeneratorWarehouseFlow    // enabled + inbound/stacker/outboundBindingId
- ModelGeneratorComponent.bindings
- ModelGeneratorComponent.warehouseFlow

// 保留
+ ModelGeneratorComponent = {
    defaultTarget: ModelGeneratorTarget | null;
    rules: ModelGeneratorRule[];
    metadataTtlSeconds: number;
    fetchBindings: ModelGeneratorFetchBinding[];   // fetch 模式，不动
    dataSource: ModelGeneratorDataSource;
  }
```

### 4.2 `TelemetryBindingComponent` 扩展（telemetryBinding.ts:42-50）

在设备侧新增两个可选字段：

```ts
export type TelemetryBindingComponent = {
  // ...现有字段不变
  /** 货箱模板来源：场景内模型生成器实体 ID；空 = 内置立方体回退 */
  cargoGeneratorId?: string;
  /** 前置设备资产编号；空 = 入口设备（货物从系统外进入） */
  upstreamAssetCode?: string;
};
```

设计说明：

- `cargoGeneratorId` 用**实体 ID** 而非名称，重命名生成器实体不影响绑定；删除被引用的生成器时按"删除引用检查"处理（见 §5.2）。
- `upstreamAssetCode` 用**资产编号**而非实体 ID，与 MQTT topic 匹配语义一致（`assetCode` 本来就是设备的对外身份），也符合"绑定前置设备的资产编号"的需求表述。
- 两字段均可选：纯展示型遥测设备（不参与货箱）不受影响。

### 4.3 场景序列化（SceneSerializer.ts）

- `serializeScene()` 顶层 `version: 1 → 2`。
- 反序列化 `normalizeModelGenerator()`（SceneSerializer.ts:630-683）：
  - 读取并丢弃 `bindings` / `warehouseFlow`，迁移逻辑见 §7。
  - v1 场景缺少 `version` 字段按 v1 处理（现有文件均未显式升过版本，需兼容）。
- `telemetryBinding` 反序列化：新增两字段的可选校验（字符串或缺省），非法值置空并记 Console 警告，不阻断加载。

---

## 5. 编辑器改动

### 5.1 放开多实例（editorStore.ts）

| 位置 | 改动 |
| --- | --- |
| `createModelGenerator()`（1597-1623） | 删除"已存在则仅选中"分支，永远创建新实体；命名自动递增（模型生成器、模型生成器 2、…） |
| `findExistingModelGeneratorEntity()`（932-940） | 删除（无调用方后） |
| `filterDuplicatedModelGenerators()`（951-976） | 删除；复制/粘贴/阵列三处调用点（1956-1963, 2013-2025, 2192-2199）改为直接透传 |

层级面板、POI 资产库入口无需改动（点击/拖入创建走同一 `createModelGenerator()`）。

### 5.2 Inspector UI

**`ModelGeneratorInspector.tsx`**：

- 删除"仓储流"开关与三个 binding 下拉（516-563）。
- 删除 MQTT 绑定列表编辑（424-563 中 `bindings` 部分）；Fetch 绑定 UI 保留。
- 面板顶部保留数据源切换（313-325）；MQTT 模式下生成器面板收敛为：规则列表 + 默认目标 + 元数据 TTL。

**`TelemetryBindingInspector.tsx`**（134-199）：

- 新增"货箱生成器"下拉：列出场景内全部 `modelGenerator` 实体（显示实体名 + 短 ID），可清空。
- 新增"前置设备资产编号"输入框（或下拉：列出场景中其他设备的 `telemetryBinding.assetCode`，允许手输以兼容尚未建模的上游）。
- 校验提示（不阻断保存）：
  - `upstreamAssetCode` 与自身 `assetCode` 相同 → 警告。
  - upstream 形成环（A→B→A）→ 警告（运行时检测到环也会停驱动并打印，见 §6.3）。
  - `upstreamAssetCode` 在场景中无匹配设备 → 弱提示（允许外部上游/后续补建）。

**删除引用检查**：删除生成器实体时，扫描所有 `telemetryBinding.cargoGeneratorId` 引用，弹确认并列明受影响设备；确认后引用置空（回退内置立方体）。

### 5.3 层级面板

无结构性改动；生成器实体允许多个后自然平铺展示。

---

## 6. 运行时改动（SceneRuntime）

### 6.1 多生成器运行时

- `activeModelGeneratorEntityId`（SceneRuntime.ts:893-902, 1048-1058）改为 `modelGeneratorRuntimes: Map<entityId, ModelGeneratorRuntimeEntry>`。
- 每个生成器实体独立维护自己的已加载输出缓存（`loadModelGeneratorModelOutput` 结果按生成器 ID 命名空间隔离），场景同步增删实体时增量建/销。
- 删除"多生成器冲突"日志与 `disposeAllTelemetryRuntimeCargo()` / `resetAllWarehouseFlows()` 的单例切换副作用。

### 6.2 设备货箱生成改造

现有两个生成入口改为从**设备绑定的生成器**取模板：

- `getOrCreateConveyorCargo()`（3911）：新增按设备 `cargoGeneratorId` 解析模板 → 实例化；未绑定时走现有内置几何回退。
- `getOrCreateStackerCargo()`（3591）/ `syncGeneratedCargoVisual()`（3539-3561）：同上。
- 模板缓存键：`generatorEntityId + resolvedTargetSignature`（沿用现有签名去重思路，1749-1803 `syncModelGeneratorResolvedTarget()` 的逻辑下沉为按生成器实例的方法）。

### 6.3 前置设备交接控制

新增轻量模块（建议 `src/runtime/babylon/telemetry/cargoHandoff.ts`，纯逻辑、不碰 Babylon 节点，风格对齐 `WarehouseFlowCoordinator` 但**无中央状态**——状态分散在各设备条目上）：

```ts
type DeviceCargoState = {
  assetCode: string;
  cargoContainerCode: string | null;   // 当前持有货箱条码
  handoffReady: boolean;               // 交接侧有货/放货完成
};

// 每帧（或每次快照更新）：
function resolveHandoffs(devices: DeviceCargoState[], bindings: TelemetryBindingComponent[]): HandoffEvent[]
// HandoffEvent: { type: 'spawn', device, fromUpstream } | { type: 'release', device } | { type: 'dispose', device }
```

**各设备类型的"有货"与"可交接"判定**（复用现有派生字段与命令字）：

| 设备 | 有货信号（生成触发） | 可交接信号（上游判定） |
| --- | --- | --- |
| 输送机（入库侧） | `front_has_goods` 0→1 | `back_has_goods` = 1 或后端有货刚消失（交接完成沿） |
| 输送机（出库侧） | `front_has_goods` 0→1 | `back_has_goods` 由 1→0（货离开系统） |
| 堆垛机 | `取货完成`（command=2） | `放货完成`（command=5） |
| Locator（伪设备） | — | 库存占用状态（供堆垛机取货查询） |

**SceneRuntime 接入点**：

- 替换 `updateWarehouseFlowFrames()`（2311-2393）为 `updateCargoHandoffs()`：收集所有参与设备的快照 → 调 `resolveHandoffs()` → 执行 spawn/release/dispose。
- spawn 时若设备声明了 upstream：优先取上游货箱 `containerCode`；视觉起点 = 本设备入口锚点（输送机前端 / 堆垛机货叉），不再做协调器式的世界坐标接力插值（交接瞬间的跳变由"上游销毁 + 本端在入口生成"承担，与真实 PLC 信号时序一致）。
- **环检测**：构建 `upstreamAssetCode` 图时检测环，发现环上设备全部停驱动并打印一次性错误（同现有"绑定命中多模型"的 fail-fast 风格）。
- **缺上游容错**：`upstreamAssetCode` 指向不存在的设备时，该设备按入口设备处理并打印一次性警告。

### 6.4 删除清单

| 文件/位置 | 内容 |
| --- | --- |
| `src/runtime/babylon/warehouse/WarehouseFlowCoordinator.ts` | 整文件删除；`warehouse/` 目录移除 |
| `SceneRuntime.ts:2311-2393` | `updateWarehouseFlowFrames()` |
| `SceneRuntime.ts:2599-2729` | `applyWarehouseFlowVisuals()` / `resolveWarehouseInboundPose()` / `resolveWarehouseOutboundPose()` |
| `SceneRuntime.ts:2396-2417` | warehouseFlow 配置解析 |
| `SceneRuntime.ts:2435-2474` | `findModelByWarehouseBinding()`（其严格匹配工具 `resolveSpecializedTelemetryBinding()` 仍被普通遥测绑定使用，保留） |
| `components.ts` | `ModelGeneratorWarehouseFlow` / `ModelGeneratorBinding` |
| `ModelGeneratorInspector.tsx` | 仓储流开关与 MQTT 绑定 UI |

`storeWarehouseInboundCargo()`（4813）与 `disposeWarehouseCargo()`（4894）**保留**，改为堆垛机自身放货/取货流程调用（见 §6.3 堆垛机特例）。

---

## 7. 场景迁移策略（v1 → v2）

反序列化遇到含 `modelGenerator.bindings` 或 `warehouseFlow` 的旧场景时自动迁移：

1. **绑定反转**：对旧生成器 `bindings[]` 中每个 `assetCode`，在场景里找 `telemetryBinding.assetCode` 匹配的设备实体，写入 `cargoGeneratorId = <该生成器实体ID>`。一对多匹配失败（无设备/多设备）→ 跳过并 Console 警告。
2. **流转链迁移**：`warehouseFlow.enabled = true` 时，按链路写入 upstream：
   - `stackerBindingId` 对应设备 ← `upstreamAssetCode = inbound 输送机 assetCode`
   - `outboundBindingId` 对应设备 ← `upstreamAssetCode = stacker assetCode`
   - 入库输送机 `upstreamAssetCode` 留空（入口）。
   - 三台设备的 `cargoGeneratorId` 均指向原生成器。
3. 迁移后的场景在内存中即为 v2 结构；保存时写 `version: 2`，旧字段不再回写。
4. 迁移结果在 Console 输出摘要（迁移了几条绑定、几条 upstream、跳过项及原因）。

**示例场景同步**：`examples/scenes/` 与 `npm run demo:*:scene` 生成脚本改为直接产出 v2 结构。

---

## 8. 分阶段实施计划

| 阶段 | 内容 | 依赖 | 验证 |
| --- | --- | --- | --- |
| P1 | 数据结构 + 序列化 + 迁移（§4、§7） | 无 | typecheck；加载 v1 旧场景断言迁移结果 |
| P2 | 编辑器放开多实例 + Inspector（§5） | P1 | 手测：创建/复制/删除多个生成器；设备侧两个新字段编辑与保存 |
| P3 | 运行时多生成器 + 设备侧模板解析（§6.1-6.2） | P1 | 多生成器各绑定不同设备，货箱模板互不串扰 |
| P4 | 前置设备交接（§6.3） | P3 | MQTT 模拟器跑通 1004→DDJ2→1005 全链路（不启用 warehouseFlow） |
| P5 | 删除 warehouseFlow（§6.4） | P4 验证通过 | 全仓搜索 `warehouseFlow` / `WarehouseFlowCoordinator` 无残留；旧场景迁移后行为等价 |
| P6 | 文档与示例（§7 示例、更新 `docs/stacker-warehouse-flow.md`） | P5 | `npm run demo:stacker:mqtt` 人工验收 |

每阶段独立可交付：P1-P2 完成后编辑器即可用新模型搭场景；P3-P4 完成前运行预览对多生成器场景退化为"内置立方体 + 入口直接生成"（不崩，仅流转不接力）。

---

## 9. 验证方案

1. **静态**：`npm run typecheck`、`npm run smoke:units`。
2. **迁移**：用 `F:\3d-projects\Stacker MQTT Demo.scene.json`（v1，含 warehouseFlow）加载 → 断言三设备获得正确 `cargoGeneratorId` 与 upstream 链 → 保存后为 v2。
3. **功能**（MQTT 模拟器 + 堆垛机演示场景）：
   - 入库：1004 前端来货 → 生成货箱 → 到后端 → DDJ2 取货完成时 1004 货箱销毁、DDJ2 货叉出现同码货箱 → 放货完成 → 货箱挂库位。
   - 出库：DDJ2 取货完成 → 库位货箱转挂货叉 → 放货到 1005 → 1005 生成同码货箱、DDJ2 销毁 → 1005 后端离开 → 销毁。
   - 多生成器：两台生成器配不同 defaultTarget 分别绑定 1004/1005，确认模板不串。
   - 异常：配 upstream 环 → 相关设备停驱动且有错误日志；删生成器 → 引用设备回退立方体。
4. **回归**：fetch 模式场景（Locator 匹配）行为不变；非仓储遥测设备（纯动画模型）行为不变。

---

## 10. 风险与开放问题

| 项 | 说明 | 建议 |
| --- | --- | --- |
| R1 交接瞬间视觉跳变 | 上游销毁 + 下游入口生成，无跨设备插值 | 真实信号时序下两设备锚点本就近似重合，可接受；若演示效果不佳，后续加"交接吸附"（下游生成时先定位在上游出口锚点再滑入） |
| R2 分叉拓扑 | 一个堆垛机对应多台出库输送机：多台下游都以 stacker 为 upstream，交接时哪台生成？ | 由下游各自的有货信号决定——stacker 放货完成后只有目标输送机会出现前端有货，天然消歧；文档明确该语义 |
| R3 containerCode 缺失 | 部分现场 payload 条码为空 | 交接匹配退化为"上游最近释放的货箱"；仍无 → 生成无码货箱 |
| R4 旧文档失效 | `docs/stacker-warehouse-flow.md` 描述的 warehouseFlow 机制被删 | P6 重写该文档为"前置设备链"模型 |
| O1 生成器是否需要 assetCode | 当前设备用实体 ID 引用生成器；若未来 MQTT payload 需按编号指定生成器，可后补 `generatorCode` 字段 | 本期不做，避免过度设计 |
| O2 多上游（合流） | 当前设计每设备单上游；合流输送机实际需要多上游 | 本期不做；预留方向：`upstreamAssetCode` 升级为数组，生成触发取任一可交接上游 |
