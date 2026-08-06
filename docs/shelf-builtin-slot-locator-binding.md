# 货架内置货格（虚拟定位线框绑定）实施方案

日期：2026-07-30　状态：未实施

## 背景与需求

虚拟定位线框（Locator）目前是独立内置实体，使用时需手动与货架对齐。本方案在货架模型参数区新增 checkbox「启用内置货格」，勾选后自动创建绑定货格子实体：

- 维度从货架参数派生映射
- 基点自动对齐（忽略支撑脚高度）：货格第一层底面贴货架第一层放货面，第一列中心对齐货架第一列单元中心
- 货格业务属性（assetId/关联设备/排号/起始列/fetch 驱动等）仍暴露给用户编辑
- 绑定期间货格选中高亮关闭、位置跟随货架

**核心设计原则：货架→货格的映射关系由模型开发者在 `.model.ts` 中声明（导出常量），对最终用户透明；编辑器/运行时按声明执行，不写死任何货架特有的参数 key 映射。** 任何模型包只要按约定声明，即可获得内置货格能力。

### 已确认决策

1. 取消勾选 → 内置货格**直接删除**（随参数更新同一命令提交，可 undo）
2. 删除货架 → 内置货格**一并级联删除**（可 undo）
3. 绑定期间货格**场景内不可点选、不可 Gizmo 拖动**（点击穿透到货架）；Hierarchy 可选中编辑业务属性
4. 列拓展方向等映射规则是**模型开发者声明的固定值**，不是最终用户配置项
5. 绑定期间货格选中高亮**关闭**

## 映射声明设计

### 声明载体与传递通道（仿 dataDriven 现有先例）

meta.json 的 `dataDriven` 字段是现成模式：模型包声明 → `modelPackageScanner.ts:224-228` 提取 → `ModelAssetTemplate.dataDrivenConfig` → 实体 modelAsset → 运行时使用。`sync-model-parameters-from-scripts.mjs` 不解析 .model.ts，parameterScripts 与 .model.ts 装饰器的一致性靠开发者维护。

本方案采用同一通道：

1. **`.model.ts` 导出常量 `builtInSlotBinding`** —— 开发者源头声明，运行时脚本可直接引用（同文件）
2. **meta.json 同名字段**（与 `dataDriven` 平级）—— 编辑器可读，scanner 提取进实体数据
3. **扩展 sync 脚本**：用 TS compiler API 从 .model.ts 提取该常量（仅 JSON 可序列化字面量）写回 meta.json，保证单一源头

### 声明结构（货架示例）

```ts
// shelf.model.ts
export const builtInSlotBinding = {
  /** 启用开关的模型参数 key */
  enabledParam: 'enableBuiltInSlots',
  /** 货格字段 ← 模型参数 key */
  dimensionMapping: {
    columns: 'columnCount',
    layers: 'layerCount',
    length: 'cellWidth',
    height: 'cellHeight',
    width: 'cellDepth',
  },
  /** 列拓展方向（模型局部轴，与脚本克隆方向一致） */
  columnDirection: '+x',
};
```

### 运行时布局输出约定

静态声明表达不了的布局量（第一列中心、放货面高度、实测列/层步距）由参数化脚本在应用参数后写入宿主节点 metadata，key 约定为 `builtInSlotLayout`：

```ts
// shelf.model.ts applyShelfParameters 末尾（this.node = contentRoot）
this.node.metadata = { ...(this.node.metadata ?? {}), builtInSlotLayout: {
  firstCellCenterX: (columnLayout.startCenter ?? 0) + columnLayout.spacing / 2,
  firstLayerSurfaceY: targetCrossbeamMinY + layerBoardHeight,  // 第一层放货面（层板顶，天然忽略支撑脚）
  columnSpacing: columnLayout.spacing,   // 实测列中心距
  layerStepY,                            // cellHeight + 层板厚
  depthCenterZ: bounds.center.z,
}};
```

列/层步距必须用货架实测值（spacing、layerStepY），不能用货格 length+columnGap——否则远端列/层累积错位。绑定期间 Locator 的 columnGap/layerGap 失效。

## 关键代码事实（已核实）

- Locator root 原点 = 第 0 列 box 中心、底面、Z 居中；`createLocatorBoxes` 用 `col*(length+columnGap)` / `layer*(height+layerGap)` 步距（`SceneRuntime.ts:3155-3174`）
- 货架节点结构：`runtimeEntry.root`(实体世界 transform) → `modelRoot` → `contentRoot`(带 unitScaleToMeters) → GLB 节点；外置脚本宿主 = `contentRoot`（`SceneRuntime.ts:4818`），脚本内"实体根米空间" = 相对 modelRoot
- 货架脚本已有全部几何量：`getFootTopY`、`resolveSupportLegHeight`(=0.03+supportLegHeight)、`getLayerBoardHeight`(Box032 层板厚)、`createColumnLayout`(spacing/startCenter)、`layerStepY`(=cellHeight+层板厚)
- boolean 参数走 `updateSelectedModelParameterValue` 立即提交（`ModelParametersInspector.tsx:176`），number 走 preview + commit
- `updateSceneDocumentCommand`（`entityCommands.ts:140`）快照式复合 Command，适合创建/删除/级联删除
- `isEntityScenePickable`（`SceneRuntime.ts:3510`）是拾取 + Gizmo 统一排除点（`getGizmoTargetByEntityId:804`、`isEntityTransformEditable:3516` 都走它）；`syncedEntities` 存最新 Entity（`:1791`）
- 复制粘贴打包整个子树并重建 parentId（`editorStore.ts:983-1013, 1126-1188`）
- Hierarchy 拖拽仅支持移入文件夹（`moveEntitiesToFolder`），无法拖拽改变非 folder 父子
- `deleteEntitiesInScene`（`editorStore.ts:1340`）当前不级联删除，子实体提升到最近存活祖先
- **`SceneSerializer.validateEntityHierarchy` 强制 parentId 只能指向 folder**（非 folder 不得有 childrenIds）→ 绑定身份不能用 parentId 表达，改为 `builtInBinding.hostEntityId` 显式记录宿主；复制粘贴经剪贴板 `duplicatedIdBySourceId` 映射重建，宿主不在粘贴集合内则解除绑定

## 实现步骤

### 1. 声明类型与流入实体数据

- `src/editor/model/builtInSlotBinding.ts`（新建）：`BuiltInSlotBindingConfig` 类型 + normalize/校验
- `electron/ipc/modelPackageScanner.ts`：仿 `extractDataDrivenConfigFromMetadata` 新增 `builtInSlotBinding` 提取
- `src/editor/assets/AssetDatabase.ts` / `components.ts` ModelAssetTemplate：`+builtInSlotBindingConfig?`；实体 modelAsset 组件同步带该字段（照 dataDrivenConfig 链路）
- `LocatorComponent` 新增 `builtInBinding?: { hostEntityId: string; originOffset: Vector3Data }`（实体级绑定标记 + 用户微调；parentId 仍只用于文件夹分组，货格与宿主同级显示在 Hierarchy）
- 场景序列化 version 3 不变（均可选字段）
- `Assets/Models/Shelf/shelf.model.ts`：ParamsComponent 加 `@visibleAsBoolean("启用内置货格") enableBuiltInSlots = false` + 导出 builtInSlotBinding 常量；meta.json 同步
- `scripts/sync-model-parameters-from-scripts.mjs`：扩展提取 .model.ts 导出常量写回 meta.json

### 2. 编辑器派生（按声明执行，无货架硬编码）

`src/editor/model/builtInSlotBinding.ts` 纯函数：
- `getBuiltInSlotBindingConfig(entity)`：读 modelAsset.builtInSlotBindingConfig
- `deriveLocatorDimensionsFromBinding(config, parameterValues)`：按 dimensionMapping 取值（取整/下限保护）
- `findBuiltInSlotEntityId(scene, hostEntityId)`：按 `builtInBinding.hostEntityId` 扫描定位货格
- `patchBuiltInSlotDimensions(scene, hostEntity)` → SceneDocument（commit/preview 复用）

### 3. editorStore 挂钩（`src/editor/store/editorStore.ts`）

- `updateSelectedModelParameterValue`（:3038）：若实体声明了 binding：
  - key===enabledParam 且 true 且无绑定货格 → `updateSceneDocumentCommand('启用内置货格')` 复合执行：写参数 + `createLocatorEntity()`（维度按声明派生、parentId=host.parentId 与宿主同级、builtInBinding={hostEntityId, originOffset:0}、name='内置货格'）。幂等：已有绑定货格只写参数。
  - key===enabledParam 且 false 且有绑定货格 → `updateSceneDocumentCommand('更新模型参数')`：写参数 + `deleteEntitiesInScene` 直接删除货格实体。
  - 其他参数出现在 dimensionMapping 且有绑定货格 → 同一 command 内同步子货格维度（undo/redo 两实体一起回滚）。
- `previewSelectedModelParameterValue`（:3063）：preview 直接 patch 子货格维度（不写历史）；enabledParam 不触发创建/解绑。
- `commitSelectedModelParameterValues`（:3099）：同 commit 路径同步子货格维度。
- `deleteEntitiesInScene`（:1340）：deletingIds 确定后，把 `builtInBinding.hostEntityId ∈ deletingIds` 的货格并入 deletingIds。
- 复制粘贴：快照打包子树时把绑定到子树内宿主的货格一并纳入；粘贴经 `duplicatedIdBySourceId` 重建 hostEntityId，宿主不在粘贴集合内则解除绑定。
- 阵列：`prepareResolvedEntityArray` 为每个模型阵列副本克隆源货格实体（builtInBinding.hostEntityId 指向副本）；副本无独立模型宿主，运行时 `syncLocatorEntity` 经 `modelArrayInstanceEntities` 解析其渲染源的布局 metadata，按副本实体 transform 放置货格；源脚本布局更新经 `refreshBuiltInSlotBindings` 同步到副本货格。

### 4. 运行时绑定（`src/runtime/babylon/SceneRuntime.ts`）

- `syncLocatorEntity`（:2189）检测 `locator.builtInBinding`：
  - host runtimeEntry = `this.models.get(binding.hostEntityId)`；`root.parent = hostEntry.root`（脚本米空间 = 相对该 root，货架脚本用 root 逆世界矩阵测量）
  - 读 `contentRoot.metadata.builtInSlotLayout` + host 实体 modelAsset.builtInSlotBindingConfig.columnDirection：
    `root.position = { x: dir*firstCellCenterX+originOffset.x, y: firstLayerSurfaceY+originOffset.y, z: depthCenterZ+originOffset.z }`，rotation/scale 归零；忽略实体 transform
  - metadata 未就绪兜底：落在货架局部原点，脚本就绪后经 `refreshBuiltInSlotBindings`（挂在脚本 onSettled 回调）修正
  - `createLocatorBoxes` 绑定模式：列步距 = columnSpacing（×方向符号）、层步距 = layerStepY；`createLocatorSignature` 纳入绑定步距
  - `applyLocatorStyle(entry, false)` 强制关闭高亮
- `isEntityScenePickable`（:3510）：`syncedEntities.get(entityId)?.components.locator?.builtInBinding` → false（拾取/Gizmo 一并排除）
- MQTT/堆垛机匹配不受影响（deviceAssetCode+rowNumber+columns/layers 仍在实体数据；box 世界坐标正常）

### 5. Inspector

- `InspectorPanel.tsx`：Transform fieldset 对绑定货格禁用（`disabled={isLocked || isBuiltInBound}`）+ 提示"位置由货架驱动"
- `LocatorInspector.tsx`：绑定期间维度字段（长/宽/高/列数/层数/列间隔/层间隔）disabled + 标注"由货架驱动"；新增「内置货格」区：originOffset XYZ 三个 number 输入（经 `updateSelectedLocator` 提交）；业务字段（assetId/deviceAssetCode/rowNumber/storageDepth/startColumn/fetchDrive）保持可编辑
- 映射声明不出现在任何最终用户 UI

### 已知限制（初版范围外）

- 货架 `doubleDeepEnabled`（双深）只生成单排（近排）货格；远排用户可自行再放独立 Locator
- 复制货架连带复制货格时 assetId 重复（既有复制 Locator 的行为，非本次引入）

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/editor/model/builtInSlotBinding.ts` | 新建：声明类型 + normalize + 派生纯函数 |
| `src/editor/model/components.ts` | +LocatorBuiltInBinding；ModelAssetTemplate/组件 +builtInSlotBindingConfig |
| `electron/ipc/modelPackageScanner.ts` | 提取 meta.json builtInSlotBinding |
| `src/editor/assets/AssetDatabase.ts` | 声明流入资产模板 |
| `Assets/Models/Shelf/shelf.model.ts` | +enableBuiltInSlots 参数、+导出 builtInSlotBinding、+builtInSlotLayout metadata |
| `Assets/Models/Shelf/meta.json` | +enableBuiltInSlots schema、+builtInSlotBinding |
| `scripts/sync-model-parameters-from-scripts.mjs` | 扩展提取 .model.ts 导出常量写回 meta.json |
| `src/editor/store/editorStore.ts` | 创建/删除/维度同步 hook、级联删除、剪贴板绑定重建、阵列副本货格生成 |
| `src/runtime/babylon/SceneRuntime.ts` | syncLocatorEntity 绑定分支（含阵列副本宿主解析）、isEntityScenePickable、normalizeModelContentOrigin 只测 contentRoot |
| `src/editor/panels/SceneViewPanel.tsx` | — |
| `src/editor/panels/InspectorPanel.tsx` | Transform 禁用 |
| `src/editor/panels/LocatorInspector.tsx` | 维度禁用 + originOffset 编辑 |

## 验证

1. `npm run typecheck`
2. `node scripts/sync-model-parameters-from-scripts.mjs --write` 验证 .model.ts → meta.json 声明同步
3. `npm run dev:electron` 端到端：
   - 拖入货架 → 勾选「启用内置货格」→ 货格出现，第一列中心对齐、底面贴第一层放货面（支撑脚上方）
   - 改 columnCount/cellWidth/cellHeight/supportLegHeight → 货格实时跟随（含拖动 preview）
   - 拖动/旋转货架 → 货格跟随；点击货格 → 选中货架
   - Hierarchy 选中货格 → 可改 assetId/关联设备/排号/originOffset；Transform 与维度禁用
   - 取消勾选 → 货格直接删除（随参数更新同一命令，undo 一并恢复）
   - 删除货架 → 货格一并删除；undo 恢复两者
   - 阵列开着内置货格的货架 → 每个副本各生成一个绑定货格，位置对齐副本第一列
   - 复制开着内置货格的货架 → 副本原点仍在第一列中部（不归一到整排中点）
   - 保存场景重开 → 绑定正常；`npm run demo:stacker:scene` + MQTT 模拟验证堆垛机仍能匹配内置货格
