# 定位线框 Fetch 数据驱动重构方案：绑定方向反转 + 生成器回归纯模板库

> 状态：方案待评审
> 日期：2026-07-27
> 影响范围：编辑器（store / Inspector / 序列化 / 迁移）、运行时（SceneRuntime / ModelGeneratorFetchRuntime）、场景版本 v2 → v3
> 前置文档：`docs/model-generator-device-binding-refactor.md`（MQTT 侧绑定方向已反转，Fetch 侧当时明确"保持现状"，本方案完成统一）

---

## 1. 背景与目标

### 1.1 现状问题

1. **fetch 触发与绑定方向挂在模型生成器上**：生成器持有 `fetchBindings[]`（资产编号指向定位线框 `assetId`），关系方向是"生成器 → 定位线框"。这与 MQTT 模式已确立的"设备 → 生成器"（`telemetryBinding.cargoGeneratorId`）方向相反，同一场景内两种数据源出现两套绑定语义。
2. **生成器持有 `dataSource: 'mqtt' | 'fetch'`**：数据源的区分只应影响**生成规则的数据解释**（MQTT 快照字段 vs fetch record 的 containerType），不该决定生成器的绑定关系与触发职责。生成器因此混杂了"模板库"与"fetch 调度器"两个角色。
3. **生成器唯一性解绑后语义更不合理**：多实例生成器各自持有一份"渲染目标列表"（fetchBindings），同一批 fetch 数据被复制渲染到所有绑定线框。渲染目标选择是**调用方**的职责，不是模板库的职责。
4. **fetch 不区分排号**：当前所有 records 渲染到所有绑定线框（`ModelGeneratorFetchRuntime.ts:111-122` 的 per-binding 循环），代码内已有 TODO（`ModelGeneratorFetchRuntime.ts:156`）指出"应该根据入参的排号进行有目标的清理，每次的请求并不是全量的更新"。排号数据（`ContainerInfo.row`）完全被忽略。

### 1.2 重构目标

| # | 目标 | 说明 |
| --- | --- | --- |
| G1 | 生成器回归纯模板库 | `ModelGeneratorComponent` 只保留 `defaultTarget` / `rules`，删除 `fetchBindings`、`dataSource` 与 `metadataTtlSeconds`（死配置，依据见 §4.2） |
| G2 | 定位线框担负 fetch 触发与渲染调用 | 定位线框新增 fetch 数据驱动配置（启用开关 + 货箱生成器），运行预览时由定位线框自身发起请求、匹配规则、驱动 thinInstance 渲染 |
| G3 | 绑定方向全局统一 | MQTT 设备 `telemetryBinding.cargoGeneratorId`、Fetch 定位线框 `locator.fetchDrive.cargoGeneratorId`，均为"消费方 → 生成器"；生成器不再持有任何外向指针 |
| G4 | 按排过滤 + 两级请求 | 定位线框只渲染本排数据；初始化一次全量请求按排分发，堆垛机放货/取货完成触发该排单排同步（§6.2）；起始列等现有字段继续参与库位映射 |

### 1.3 非目标

- `fetchConfig`（url / apiKey）保持**全局场景配置**（工具栏"配置 Fetch 请求"对话框），不搬到定位线框。
- 请求协议不变：POST、`X-API-Key`、`data.records` 结构保持现状；`rows` 参数语义已与服务端确认（不传 = 全量返回，传入 = 按排返回）。
- thinInstance 合批渲染管线、资产加载管线（`loadModelTemplateForFetch`）不变。
- MQTT 链路（`telemetryBinding` / `deviceTelemetry` / 货箱交接）不变；仅放货/取货完成处新增单排同步触发分支（§6.3）。
- 手动刷新 / 轮询不做：事件驱动覆盖主要同步路径，手动全量刷新按钮列为后续增强（§10 O1）。

---

## 2. 现状架构（关键代码索引）

### 2.1 数据模型

| 位置 | 代码 | 说明 |
| --- | --- | --- |
| `src/editor/model/components.ts:153-169` | `ModelGeneratorFetchBinding` / `ModelGeneratorDataSource` / `ModelGeneratorComponent` | 生成器持有 `fetchBindings`（id + assetCode → 定位线框 assetId）与 `dataSource` |
| `src/editor/model/components.ts:21-34` | `LocatorComponent` | 已有 `assetId` / `rowNumber`（排号）/ `startColumn`（起始列）/ `deviceAssetCode` 等 |
| `src/editor/model/SceneDocument.ts:86-94` | `FetchConfig` | 全局 `{ url, apiKey }` |
| `src/editor/model/modelGenerator.ts:192-200, 290-318` | `createDefaultModelGeneratorComponent` / `sanitizeModelGeneratorFetchBinding` / `sanitizeModelGeneratorComponent` | 领域层清理逻辑 |

### 2.2 触发与渲染链路

| 位置 | 代码 | 说明 |
| --- | --- | --- |
| `src/editor/panels/SceneViewPanel.tsx:878` | `runtime.handleFetchGeneratorEvent(fetchConfig)` | 进入运行预览时触发一次 |
| `src/runtime/babylon/SceneRuntime.ts:542, 594-609` | `fetchRuntimes` / `handleFetchGeneratorEvent` | 按**生成器实体 ID** 持有 runtime，遍历转发 |
| `src/runtime/babylon/SceneRuntime.ts:2678-2683` | `syncModelGeneratorEntity` 内建/销 fetch runtime | `dataSource === 'fetch'` 时创建 |
| `src/runtime/babylon/SceneRuntime.ts:682-684` | `endTelemetryPreview` | 退出预览时清空全部 fetch 批次 |
| `src/runtime/babylon/ModelGeneratorFetchRuntime.ts:71-129` | `handleEvent` | POST → records → `matchRule(rules, containerType)` → **per-binding 循环生成实例** → thinInstance |
| `src/runtime/babylon/SceneRuntime.ts:612-655` | `loadModelTemplateForFetch` | 模型模板经完整资产管线加载并烘焙单位换算 |

### 2.3 编辑器 UI

| 位置 | 代码 | 说明 |
| --- | --- | --- |
| `src/editor/panels/ModelGeneratorInspector.tsx:227-245` | 数据源切换 + 提示文本 | MQTT / Fetch 下拉 |
| `src/editor/panels/ModelGeneratorInspector.tsx:338-373` | 定位线框绑定列表 | fetchBindings 增删改 |
| `src/editor/panels/LocatorInspector.tsx` | 定位线框面板 | 已有排号、起始列等字段，无数据驱动配置 |
| `src/editor/panels/TelemetryBindingInspector.tsx:162-223` | 设备侧"货箱生成器"下拉 | **新 UI 的对齐样板**（generatorOptions 模式） |

### 2.4 序列化与迁移

| 位置 | 代码 | 说明 |
| --- | --- | --- |
| `src/editor/project/SceneSerializer.ts:64, 72, 91` | `version: 2` | v1 → v2 迁移链已存在 |
| `src/editor/project/SceneSerializer.ts:798-843` | `normalizeModelGenerator` | 校验 rules / fetchBindings / dataSource |
| `src/editor/project/SceneSerializer.ts:548-564` | `normalizeLocator` | 校验定位线框字段 |
| `src/editor/project/sceneMigration.ts:84-152` | `migrateLegacySceneV1ToV2` | **v2 → v3 迁移的对齐样板** |
| `src/editor/store/editorStore.ts:1359-1364` | 删除实体时清理 `cargoGeneratorId` 引用 | **需同步扩展到 locator 侧新引用** |

### 2.5 无影响确认

- `src/player/PlayerApp.tsx` 的 `fetch` 是场景文件 HTTP 加载，与 fetch 数据源无关。
- `src/editor/deployment/deploymentExport.ts:134-138` 只消费 `defaultTarget` / `rules`（重构后保留字段），无改动。

---

## 3. 目标概念模型

### 3.1 核心概念变化

| 维度 | 现状 | 目标 |
| --- | --- | --- |
| 生成器职责 | 模板库 + fetch 调度（触发 + 绑定渲染目标） | **纯模板库**（defaultTarget + rules） |
| fetch 绑定方向 | 生成器 `fetchBindings[]` → 定位线框 | 定位线框 `fetchDrive.cargoGeneratorId` → 生成器 |
| 数据源区分 | 生成器 `dataSource` 字段 | 删除；差异只体现在**消费方如何调用规则**（MQTT 快照字段 vs fetch record.containerType） |
| fetch 触发编排 | 生成器（每个 fetch 生成器一次全量请求） | 定位线框驱动：初始化一次全量按排分发；放货/取货完成单排同步（§6.2） |
| 数据范围 | 全部 records 渲染到全部绑定线框 | 每个定位线框按自身 `rowNumber` 过滤 records |
| 多生成器 | fetchBindings 各自指向线框，语义混乱 | 任意多生成器，被设备/定位线框自由引用，风格与 MQTT 统一 |

### 3.2 统一后的消费方 → 生成器引用

```text
MQTT 设备      telemetryBinding.cargoGeneratorId ──┐
                                                  ├──> 模型生成器（纯模板库）
Fetch 定位线框 locator.fetchDrive.cargoGeneratorId ┘    rules + defaultTarget
```

规则语义保持中立：`attributeName` / `attributeValue` 由消费方解释——

- MQTT 侧：`resolveModelGeneratorTargetFromSnapshot()`（`modelGeneratorRuntime.ts:36-66`）按 `attributeName` 读快照字段与 `attributeValue` 比较。
- Fetch 侧：按 `attributeName` 读 record 字段与 `attributeValue` 比较——`record[attributeName] ?? record.containerType`，字段不存在或留空时回退 `containerType`。

两侧语义拉齐为"属性名 = 数据字段名、属性值 = 期望值"，规则 UI 只有一套字段，无需按数据源区分（替代原"fetch 侧 attributeName 仅作备注"的妥协方案）。

### 3.3 定位线框 fetch 驱动生命周期

```text
[编辑态] 配置 fetchDrive（启用 + 货箱生成器）→ 定位线框正常渲染线框，无货物
   │
[进入运行预览] SceneViewPanel 触发初始化全量同步（§6.2）
   │  一次请求（不传排号 = 全量）→ 按 record.row 分组 → 每个 fetchDrive 定位线框：
   │    1. 收到本排 records
   │    2. 经 cargoGeneratorId 查生成器组件 → matchRule(rules, record) → target
   │       （未绑定/生成器缺失 → 内置立方体回退 + 一次性 Console 提示）
   │    3. 按 target 签名分组合批 → getLocatorBoxWorldMatrix(自身, column, layer) → thinInstance
   │
[运行中] 堆垛机放货/取货完成（§6.3）→ 该排单排请求 → 仅该排定位线框增量同步
   │
[退出运行预览] endTelemetryPreview 清空全部 fetch 批次（现状逻辑不变）
```

---

## 4. 数据结构变更

### 4.1 `LocatorComponent` 扩展（components.ts:21-34）

```ts
/** 定位线框的 fetch 数据驱动配置；区别于 MQTT 遥测驱动，由 HTTP 接口按排号拉取库存数据。 */
export type LocatorFetchDriveConfig = {
  enabled: boolean;
  /** 货箱模板来源：场景内模型生成器实体 ID；空 = 内置立方体回退 */
  cargoGeneratorId?: string;
};

export type LocatorComponent = {
  // ...现有字段不变（assetId / rowNumber / startColumn / ...）
  /** fetch 数据驱动；缺省表示不启用 */
  fetchDrive?: LocatorFetchDriveConfig;
};
```

设计说明：

- 排号（`rowNumber`）、起始列（`startColumn`）**复用现有字段**，不重复定义：排号作为请求与过滤参数，起始列参与库位列映射（`getLocatorBoxWorldMatrix` 已消费）。
- `cargoGeneratorId` 用**实体 ID**，与 `telemetryBinding.cargoGeneratorId` 命名、语义、校验完全对齐（重命名生成器不影响绑定；删除生成器时引用置空）。
- 配置做成可选子对象而非平铺字段：缺省即不启用，旧场景天然兼容，序列化体积不膨胀。

### 4.2 `ModelGeneratorComponent` 收敛（components.ts:153-169）

```ts
// 删除
- ModelGeneratorFetchBinding      // id + assetCode
- ModelGeneratorDataSource        // 'mqtt' | 'fetch'
- ModelGeneratorComponent.fetchBindings
- ModelGeneratorComponent.dataSource
- ModelGeneratorComponent.metadataTtlSeconds

// 保留（纯模板库）
+ ModelGeneratorComponent = {
    defaultTarget: ModelGeneratorTarget | null;
    rules: ModelGeneratorRule[];
  }
```

**`metadataTtlSeconds` 一并删除的依据**：该字段在当前运行时是**死配置**——全仓唯一读取点是 `createModelGeneratorRuntimeConfigSignature`（SceneRuntime.ts:5356-5363），没有任何销毁计时逻辑消费它；MQTT 侧货箱销毁在交接重构后已是事件驱动（下游接管 / 遥测无货 / 放货完成），不存在"超时销毁"语义。留在组件上只有两个副作用：改 TTL 会触发配置签名变化误释放全部货箱；UI 上误导用户以为存在时间兜底（fetch 模式下现 UI 已按 `dataSource` 条件隐藏该字段，可见连交互层都承认它不属于模板库）。若未来需要"遥测中断后清理滞留货箱"，应基于 `telemetryBinding.staleAfterMs` 重新设计，而非复活本字段。

同步删除：`modelGenerator.ts` 的 `sanitizeModelGeneratorFetchBinding`、`sanitizeModelGeneratorMetadataTtlSeconds`、`MODEL_GENERATOR_MAX_BINDINGS`、`MODEL_GENERATOR_TTL_*` 常量、`createDefaultModelGeneratorComponent` 中的三个字段；`SceneSerializer.ts:798-843` 的对应校验（含 801-804 的 TTL 范围校验）；`createModelGeneratorRuntimeConfigSignature` 中的 TTL 项。

### 4.3 场景序列化（SceneSerializer.ts）

- 顶层 `version: 2 → 3`；读取侧接受 1 / 2 / 3，v1 走现有 v1→v2 迁移后再走 v2→v3（§7）。
- `normalizeModelGenerator`：删除 `fetchBindings` / `dataSource` 校验；遇到旧字段**宽容丢弃**（v2 文件未经迁移直接读时不报错）。
- `normalizeLocator`：新增 `fetchDrive` 可选校验——`enabled` 必须布尔、`cargoGeneratorId` 为可选字符串（trim，≤128），非法则整个 `fetchDrive` 置为缺省，不阻断加载。

---

## 5. 编辑器改动

### 5.1 `ModelGeneratorInspector.tsx`（收敛为纯模板库）

- 删除"数据源"下拉与两段模式提示文本（227-245）。
- 删除"定位线框绑定"整个区块（338-373）及 `updateFetchBinding` / `addFetchBinding` / `removeFetchBinding`。
- 删除"元数据销毁时长"区块（312-336，含条件显隐与提示文本），字段随 §4.2 一并移除。
- 面板收敛为：共享生成模板 + 生成规则。提示语更新为"本生成器仅作为货箱模板库；在设备的遥测绑定面板或定位线框的 Fetch 数据驱动中选择本生成器作为货箱来源。规则属性名在 MQTT 下读取遥测快照字段、在 Fetch 下读取 record 字段（缺省比较 containerType）。"

### 5.2 `LocatorInspector.tsx`（新增 Fetch 数据驱动区块）

在现有字段之后新增"Fetch 数据驱动"分组：

- **启用开关**（checkbox）：写入 `fetchDrive.enabled`；关闭时保留 `cargoGeneratorId` 便于往返切换。
- **货箱生成器下拉**：列出场景内全部 `modelGenerator` 实体（实体名 + 短 ID），可清空；对齐 `TelemetryBindingInspector.tsx:162-223` 的 generatorOptions 实现与"引用已失效"提示模式。
- 说明文本："运行预览时按排号从 Fetch 接口拉取库存并渲染到本线框库位；排号、起始列使用上方已有配置。"
- 提交走现有 `updateSelectedLocator` partial patch（`editorStore.ts:2847`），自动进 undo 历史，无需新增 store action。

### 5.3 删除引用检查（editorStore.ts:1359-1364）

删除生成器实体时的引用清理由 `telemetryBinding.cargoGeneratorId` 扩展为同时扫描 `locator.fetchDrive.cargoGeneratorId`：命中则 `fetchDrive.cargoGeneratorId = undefined`（保留 enabled 与其他配置，回退内置立方体语义与 MQTT 侧一致）。

---

## 6. 运行时改动（SceneRuntime）

### 6.1 `ModelGeneratorFetchRuntime` → `LocatorFetchRuntime`

文件改名 `src/runtime/babylon/LocatorFetchRuntime.ts`，类与构造签名调整：

```ts
// 现状：按生成器组织，handleEvent 内部发 HTTP 请求并循环 fetchBindings 匹配定位线框
constructor(scene, generatorEntityId, onPushLog)
handleEvent(fetchConfig, generatorComponent, getLocatorByAssetId, getLocatorBoxWorldMatrix, loadModelTemplate)

// 目标：按定位线框组织，自身即渲染目标，生成器仅提供规则与模板；
//       HTTP 请求编排上移至 SceneRuntime（§6.2），本类只收本排 records
constructor(scene, locatorEntityId, onPushLog)
applyRecords(records, locatorEntry, locatorComponent, generatorComponent | null, getLocatorBoxWorldMatrix, loadModelTemplate)
```

行为变化：

1. **records 过滤**：分发层已按排分组（§6.2），此处仍防御性校验 `String(record.row).trim() === String(locatorComponent.rowNumber)`，丢弃串排数据（`ContainerInfo.row` 现状被完全忽略）。
2. **规则匹配（语义拉齐）**：`matchRule` 签名由 `(rules, containerType)` 改为 `(rules, record)`，读取 `record[rule.attributeName] ?? record.containerType` 与 `rule.attributeValue` 比较；`attributeName` 留空默认比较 `containerType`（替代现状"空即跳过规则"）。`generatorComponent` 为 `null`（未绑定/已删除）时该批次回退内置立方体（复用现有 `loadTemplateMesh` 的 mesh 分支），并一次性 Console 提示"定位线框 X 未绑定货箱生成器"。
3. **删除 per-binding 循环**：每个 record 只产生一个实例（自身线框），`CargoInstance` 的 `locatorAssetId` 字段删除，矩阵直接由 `getLocatorBoxWorldMatrix(自身, column, layer)` 计算，Identity 兜底分支删除。
4. `matchRule` 保持私有实现（fetch record 非 `DeviceTelemetrySnapshot`，不复用 `resolveModelGeneratorTargetFromSnapshot`）；`loadModelTemplateForFetch`（SceneRuntime.ts:612-655）原样保留并改名 `loadModelTemplateForLocatorFetch` 之类，签名不变。

### 6.2 请求编排：初始化全量 + 事件驱动单排同步

服务端语义已确认：**请求体 `rows` 不传/空数组 = 返回全量数据；传入排号 = 只返回该排**。据此分两级：

1. **初始化全量同步**（进入运行预览，`SceneViewPanel.tsx:878` 调用点改名）：
   - `SceneRuntime.handleFetchDriveEvent(fetchConfig)`：无 fetchDrive 定位线框时直接返回；否则只发**一次**全量请求（`{ rows: [] }`）。
   - 响应按 `record.row` 分组，分发到各 `LocatorFetchRuntime.applyRecords`；本排无数据的定位线框收到空数组并清空已有批次。
2. **事件驱动单排同步**：`SceneRuntime.handleFetchRowSync(rowNumber)`：
   - 请求体 `{ rows: [String(rowNumber)] }`，响应只分发给该排的 fetchDrive 定位线框（同排多台共享一次请求）。
   - 触发源：堆垛机放货/取货完成（§6.3）；后续可扩展手动刷新入口（§10 O1）。
3. **请求函数上移**：HTTP 逻辑从 `ModelGeneratorFetchRuntime` 抽出为 SceneRuntime 私有 helper（如 `fetchInventoryRecords(fetchConfig, rows)`），失败日志沿用 `pushLog`；`LocatorFetchRuntime` 不再持有 `fetchConfig`。
4. **乱序防护**：每次请求携带递增代际戳，响应仅在代际最新时应用，避免初始化全量与单排同步并发时旧数据覆盖新状态。
5. `SceneRuntime.ts:2678-2683` 的建/销逻辑从 `syncModelGeneratorEntity` 移到 `syncLocatorEntity`：`fetchDrive?.enabled` 时创建 `LocatorFetchRuntime`，否则 dispose 并移除。`syncModelGeneratorEntity` 中的对应分支删除。
6. `endTelemetryPreview`（682-684）清理逻辑不变（仅变量名随 Map 改名）。

### 6.3 与 MQTT 落位货箱的互斥协调

原则：**启用 fetchDrive 的定位线框，其库位货物的唯一渲染来源是 fetch 数据**；MQTT 只驱动设备运动与叉上货物。否则放货完成后 MQTT 货箱留在库位（现状）会与 fetch 渲染的同一件货双重显示。

- **放货完成锚点**：`applyStackerForkCargoMotion` 中 `cargo.placedLocatorKey = snapshot.targetLocationKey`（SceneRuntime.ts:3778-3781）。目标定位线框启用 fetchDrive 时：**跳过 `placedLocatorKey` 赋值**（货箱不再留库位），并触发 `handleFetchRowSync(locator.rowNumber)`；该 MQTT 货箱保留到单排同步响应应用时再销毁，避免网络延迟造成视觉空窗。
- **取货完成**：同样触发目标排单排同步，被取货物随 fetch 响应从渲染中移除；取货完成的命令沿检测按同一模式挂接（实现时对齐 `getStackerCargoPlacingProgress` 的命令判定）。
- **未启用 fetchDrive 的定位线框**：现有 MQTT 落位/交接语义完全不变。

### 6.4 生成器组件查找

`handleFetchDriveEvent` 内经 `cargoGeneratorId` 查生成器组件：从 `modelGenerators` / `generatedOutputOwners`（SceneRuntime.ts:530-531）按实体 ID 取同步快照中的 `ModelGeneratorComponent`，保证运行时所见与场景同步状态一致，不反向依赖 editor store。

### 6.5 删除/改名清单

| 文件/位置 | 内容 |
| --- | --- |
| `src/runtime/babylon/ModelGeneratorFetchRuntime.ts` | 整文件改名改造为 `LocatorFetchRuntime.ts`；HTTP 请求逻辑（:80-98）上移为 SceneRuntime 请求编排（§6.2） |
| `SceneRuntime.ts:542, 594-609, 2678-2683` | fetchRuntimes 键与遍历逻辑改定位线框 |
| `SceneRuntime.ts:3778-3781` | 放货完成落位分支：fetchDrive 定位线框跳过 `placedLocatorKey` 并触发单排同步（§6.3） |
| `components.ts` / `modelGenerator.ts` / `SceneSerializer.ts` | `ModelGeneratorFetchBinding` / `ModelGeneratorDataSource` / `metadataTtlSeconds` 及相关 sanitize、常量、配置签名项 |
| `ModelGeneratorInspector.tsx` | 数据源切换、绑定列表、元数据销毁时长区块 |
| `SceneViewPanel.tsx:878` | 调用点改名 |

---

## 7. 场景迁移策略（v2 → v3）

`sceneMigration.ts` 新增 `migrateSceneV2ToV3`（风格对齐现有 `migrateLegacySceneV1ToV2`）：

1. **绑定反转**：对每个 `modelGenerator.dataSource === 'fetch'` 的实体，遍历其 `fetchBindings`：
   - 按 `locator.assetId === binding.assetCode` 找定位线框实体 → 写入 `fetchDrive = { enabled: true, cargoGeneratorId: <该生成器实体 ID> }`。
   - 一对多冲突（同一定位线框被多个生成器绑定）：保留首个，其余跳过并记警告。
   - 找不到匹配定位线框：跳过并记警告。
2. **字段丢弃**：所有生成器实体（含 `dataSource === 'mqtt'` 的）写回时删除 `fetchBindings` / `dataSource` / `metadataTtlSeconds`。TTL 为死配置（§4.2），静默丢弃，不计入迁移摘要。
3. 迁移后内存即 v3 结构；保存时写 `version: 3`，旧字段不再回写。
4. Console 输出迁移摘要（反转绑定 N 条、跳过 M 条及原因），对齐 v1→v2 摘要风格。

`SceneSerializer` 读取链：`version: 1` → v1→v2 → v2→v3；`version: 2` → v2→v3；`version: 3` 直接校验。示例场景与 demo 生成脚本若有 fetch 配置，同步产出 v3 结构。

---

## 8. 分阶段实施计划

| 阶段 | 内容 | 依赖 | 验证 |
| --- | --- | --- | --- |
| P1 | 数据结构 + 序列化 + v2→v3 迁移（§4、§7） | 无 | typecheck；加载 v2 fetch 场景断言迁移结果 |
| P2 | 编辑器 Inspector + 删除引用清理（§5） | P1 | 手测：生成器面板收敛；定位线框新配置块编辑/撤销/保存 |
| P3 | 运行时改造 + 请求编排 + 堆垛机事件挂接（§6） | P1 | 初始化一次全量请求、多排各自渲染本排；放货/取货完成自动单排同步；切换 cargoGeneratorId 模板生效；未绑定回退立方体 |
| P4 | 清理与回归 | P3 验证通过 | 全仓搜索 `fetchBindings` / `dataSource` / `ModelGeneratorFetchBinding` 无残留；MQTT 链路行为不变 |

每阶段独立可交付：P1-P2 完成后编辑器即可用新模型搭场景；P3 完成前旧场景迁移后运行预览不渲染 fetch 货物（不崩）。

---

## 9. 验证方案

1. **静态**：`npm run typecheck`、`npm run smoke:units`。
2. **迁移**：构造/选取含 `dataSource: 'fetch'` + 多条 `fetchBindings` 的 v2 场景加载 → 断言各定位线框获得正确 `fetchDrive.cargoGeneratorId`、生成器字段被丢弃 → 保存后为 v3。
3. **功能**（fetch 演示环境）：
   - 两台定位线框配不同排号 + 同一生成器：各自只渲染本排 records。
   - 进入运行预览只发**一次**全量请求（无论多少台 fetchDrive 定位线框）。
   - 放货完成到启用 fetchDrive 的库位：MQTT 货箱不留库位、该排自动单排同步，无双重渲染；未启用 fetchDrive 的库位落位语义不变。
   - 取货完成：该排自动单排同步，被取货物从渲染中消失。
   - 规则 `attributeName` 指向 record 字段时按该字段匹配；留空或字段不存在时回退 `containerType`。
   - 两台定位线框配不同生成器（不同 defaultTarget）：模板互不串扰。
   - 未绑定生成器的定位线框：内置立方体回退 + 一次性提示。
   - 删除被引用生成器：定位线框 `cargoGeneratorId` 置空并回退。
   - 退出运行预览：全部批次清空，回到编辑态无残留。
4. **回归**：MQTT 堆垛机演示链路（`npm run demo:stacker:mqtt`）行为不变；非 fetch 定位线框（纯库位语义）行为不变。

---

## 10. 风险与开放问题

| 项 | 说明 | 建议 |
| --- | --- | --- |
| R1 `record.row` 匹配语义 | `ContainerInfo.row` 为 string，与 `rowNumber`（number）的对应关系需与后端确认（前导零、多排写法如 "1,2"）；`rows` 请求参数语义已确认（不传 = 全量，传入 = 按排） | 本期按 `String(row).trim() === String(rowNumber)` 严格匹配；确认后如需多值再扩展 |
| R2 初始化与单排同步乱序 | 放货完成瞬间若初始化全量响应尚未返回，旧数据可能覆盖新状态 | 请求携带递增代际戳，过期响应直接丢弃（§6.2-4） |
| O1 手动刷新 / 轮询 | 事件驱动（放货/取货完成）已覆盖主要库存变化路径，但仍存在外部改库存的盲区 | 本期不做；后续可在工具栏加"全量刷新"按钮，直接重走初始化全量路径 |
| O2 遥测中断后的滞留货箱 | MQTT 货箱销毁为事件驱动，遥测整体中断时货物滞留（现状即如此，与删除 TTL 无关——TTL 本就无逻辑消费） | 本期不做；如需时间兜底，基于 `telemetryBinding.staleAfterMs` 另行设计 |
