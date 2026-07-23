# Shelf 与静态模型共享实例渲染

## 目标

当场景中存在大量相同 Shelf 时，避免每个实体重复解析和上传 `Shelf.glb` 的几何、材质与纹理，同时保留以下编辑能力：

- 每个 Shelf 具有独立的位置、旋转和缩放。
- 每个 Shelf 继续使用独立参数值和外置参数脚本实例。
- 场景拾取、锁定、显隐、Hierarchy 选择与 Transform Gizmo 保持实体级语义。
- 删除一个 Shelf 不得影响其它同源 Shelf，最后一个实例释放后必须回收共享源资源。

## 实现边界

共享实例框架现在包含两条准入路径：明确识别为 Shelf 的模型继续使用经过验证的脚本化共享；没有外置脚本、参数配置、参数脚本元数据和动画脚本元数据的普通静态模型使用通用静态共享。普通场景实体和模型生成器输出共用同一加载函数。Stacker `appearanceColor`、YZJ 顶点修改以及其它动态脚本模型继续使用独占容器，避免破坏每实例材质和几何隔离。

Shelf 识别依据为稳定资源信息：

- `Shelf.glb` / `Shelf.gltf`
- `shelf.model.ts`
- 模型包 `Shelf` 目录
- `meta.json` 中明确声明的 `shelf.model.ts`

场景实体显示名称不参与识别。

## 运行时结构

### 共享源资源

`SharedModelAssetCache` 使用现有模型资产签名作为缓存键：

```text
sourceUrl + assetRevision + instancingMode 策略标记
```

源 `AssetContainer` 不调用 `addAllToScene()`，只保留一份未进入场景的模板资源。每个 Shelf 实体通过以下方式创建层级：

```ts
container.instantiateModelsToScene(
  (sourceName) => sourceName,
  false,
  { doNotInstantiate: false },
);
```

必须保留原节点名称，否则 Shelf 参数脚本无法继续匹配 `Box023`、`node1` 等稳定部件名。

### 实体独立状态

每个 Shelf 仍创建独立的：

- `root`
- `contentRoot`
- `ExternalModelScriptRuntime`
- 参数值、资产编号和拾取 metadata
- `InstantiatedEntries`

因此参数脚本无需修改。参数脚本复制父 `TransformNode` 时，其子 `InstancedMesh.clone()` 仍会生成 `InstancedMesh`，新增层、列和双深结构继续共享源几何与材质。

### Mesh 刷新

外置脚本启动或参数更新后，运行时会从实体稳定根重新收集全部子 Mesh，并重新应用：

- `metadata.editorEntityId`
- 显隐和锁定对应的 `isPickable`
- 当前选择状态
- 模型测量与遥测基线

该刷新同时覆盖参数脚本后生成的 Mesh，避免生成层列遗漏拾取或锁定状态。

## 选择显示

独占容器模型继续使用 `HighlightLayer`。Shelf 与普通静态共享模型的 `InstancedMesh` 使用单个共享 `SelectionOutlineLayer`，通过实例选择 ID 区分同源实例，避免选中一个实体时其它同源模型同时高亮。

选择描边按当前选中 Mesh 的 `uniqueId` 生成签名；实体仅移动但选择和 Mesh 拓扑未变化时，不重复重建实例选择缓冲。签名变化时仍执行 `clearSelection()` 后重新 `addSelection()`，避免描边层累积已释放 Mesh 引用。由于 Babylon 清理实例选择缓冲后，已有 source mesh 的部分实例公开 `instancedBuffers` 容器可能为空，运行时会在重新添加选择前同时补齐当前选中实例、共享 source mesh 和 `sourceMesh.instances` 的公开容器；参数脚本或异步加载刷新 Mesh 后还会修复已经注册实例缓冲但容器暂时为空的新实例。这样可避免主渲染阶段读取 `instanceSelectionId` 时命中 `null`，且不扫描私有字段、不逐帧遍历场景，也不改参数化脚本。

## 生命周期

共享源容器使用引用计数：

1. 第一个 Shelf 创建时加载源容器。
2. 后续同签名 Shelf 复用源容器。
3. 删除实体时先停止参数脚本，再释放实体 `InstantiatedEntries`。
4. 引用数仍大于 0 时保留共享源。
5. 最后一个实例释放后销毁共享源容器。
6. SceneRuntime 整体销毁时，即使调用顺序异常，也不会在活动实例之前提前销毁共享源。

## Thin Instances 边界

普通 Shelf 实体仍优先使用共享源 `AssetContainer` + `InstancedMesh`，以保留实体级编辑、Gizmo、锁定、显隐和选择语义。参数脚本内部另有一条高密度保护路径：当 `layerCount`、`columnCount`、双深组合估算会超过逐节点生成阈值 `MAX_GENERATED_NODES=5000` 时，不再继续为每个货格 clone 节点，而是按每个可渲染源叶 Mesh 创建一个带 `metadata.denseShelfBatch=true` 的批次 Mesh，并用 thin-instance matrix buffer 表示重复网格。

高密度路径只作用于单个 Shelf 实体内部的重复结构：

- `layerCount`、`columnCount` 均支持 `1..100`，双深 `100x100x2` 不会静默截断。
- 每个源叶 Mesh 只执行一次几何提取/烘焙；格子循环只累积矩阵，最后一次性提交 `Float32Array`。
- 批次 Mesh 开启 thin instance picking，并保留 `editorEntityId` 可回写 metadata。
- 原始基准 leaf Mesh 只在当前实体内隐藏，重建或停止脚本时通过快照恢复，避免污染另一个同源 Shelf。
- 低密度路径继续使用原 `cloneSingleNode`、metadata 和 cleanup 行为，既有 88/128 smoke 数量保持不变。

## 定向验证

执行：

```powershell
npm run smoke:shelf-instancing
```

验证覆盖：

- 底层缓存和真实 `SceneRuntime.sync()` 中，两个同源 Shelf 都只加载一次 `AssetContainer`。
- 基础与参数脚本生成的有效 Mesh 全部保持实例化。
- 两个 Shelf 共享同一组源 Mesh，但 Transform 和拾取 metadata 相互隔离。
- SelectionOutlineLayer 只给被选实例写入选择 ID；SceneRuntime 锁定实体后会禁用该实例全部拾取。
- 保持左侧 Shelf 选中时修改 `layerCount`/`columnCount`，随后清理并重建描边不再触发 Babylon `instanceSelectionId` 空容器写入错误。
- 256 个同源矩阵实例在选择缓冲已注册后模拟脚本重建产生空容器，修复后连续渲染与重新选择均不得抛出 `instanceSelectionId` 异常。
- 重建前后左侧真实 `InstancedMesh` 均具有 `instanceSelectionId > 0`，右侧同源未选 Shelf 保持 `0/undefined`。
- 每个相关 `sourceMesh.instances` 都具备公开 `instancedBuffers` 容器。
- 删除一个实例不释放共享源；删除最后一个实例时只释放一次。
- 参数从 2 列更新到 3 列后，新增结构仍为实例。
- `100x100` 双深 Shelf 不被 clamp，启用 dense batch，thin instance 数覆盖全部重复结构，场景 Mesh 数保持批次级。
- 高密度 Shelf 选择不会污染另一个同源低密度 Shelf；高密度参数更新后可重新生成批次。

2026-07-17 的定向 smoke 结果：

- 实际源加载次数：1
- 每个 2 层、2 列、双深 Shelf 的有效实例 Mesh：88
- 更新为 3 列后的有效实例 Mesh：128
- 参数脚本生成根节点：70
- 100 层 × 100 列 × 双深：dense batch 18，thin instance 121608，高密度可渲染 Mesh 36
- 共享源释放次数：1
- SceneRuntime 集成实例基础 Mesh：每个 Shelf 18 个，加载次数和最终源释放次数均为 1
