# 环境 GLB 文件导入与原点左侧放置设计

## 背景

当前模型库和环境库共用“导入模型文件夹”IPC。环境库要求用户选择模型包目录，再由扫描器查找 `.glb/.gltf`。新需求要求环境模型改为直接选择单个 GLB 文件，并在拖入 Inspector 的“环境属性”后，将该 GLB 显示在世界原点左侧。

## 目标

- 普通模型库继续使用模型文件夹导入。
- 环境库导入按钮直接打开单文件选择器，仅接受 `.glb`。
- 环境 GLB 仍复制进当前项目并写入 `.babylon-editor/asset-index.json` v2，保持 `libraryKind: 'environment'`。
- 环境资产拖入环境属性或点击应用后，整个模型位于世界原点负 X 一侧。
- 环境底座继续不进入 Hierarchy、不参与拾取和 Gizmo。
- 旧环境模型包索引继续可读、可显示、可应用。

## 方案比较

### 方案 A：单文件选择，内部保存为独立单文件包（采用）

用户选择一个 `.glb`。主进程把文件复制到：

```text
Assets/Environments/<GLB文件名不含扩展名>/<原GLB文件名>.glb
```

复制后继续调用现有 `scanModelPackage()`，生成标准 `ProjectModelAssetEntry`。

优点：用户无需选择文件夹；现有 `packagePath`、项目索引、受控 URL、环境变体和旧资产兼容链路均可复用；同名文件重导仍能覆盖对应环境资产。

### 方案 B：GLB 直接平铺到 `Assets/Environments`

实现更少，但多个 GLB 共用一个 `packagePath` 时，现有 `listModelPackageVariants()` 会把整个环境目录中的文件混为同一个包的变体。需要额外修改环境配置和变体逻辑，本次不采用。

### 方案 C：GLB 作为普通场景实体导入

可以直接复用普通模型实体 Transform，但会进入 Hierarchy、参与选择和保存，破坏现有“环境底座不是实体”的产品边界，本次不采用。

## 导入数据流

1. 环境库点击“导入环境 GLB”。
2. Renderer 调用 `window.editorApi.importEnvironmentModelFile()`。
3. Electron 使用 `openFile` 和 GLB 过滤器选择单个文件。
4. 主进程确认扩展名为 `.glb`、目标为真实文件，并校验 GLB magic、版本、声明长度、JSON 首块与分块边界。
5. 文件复制到 `Assets/Environments` 旁的临时同级目录，暂存副本通过 GLB 校验和 `scanModelPackage()` 后才允许进入提交阶段。
6. 若同名正式包已存在，先把旧包重命名为唯一备份，再把暂存包原子重命名为正式包。
7. 重新扫描正式包并写入 v2 项目资产索引，只替换环境库中同包路径或同资产路径的旧记录。
8. 正式包与索引都提交成功后删除旧包备份；重命名、扫描或索引写入任一步失败时恢复旧包和旧索引。
9. Renderer 使用返回的完整 `projectAssets` 刷新环境库；当前场景正在使用同一环境包时，自动应用新版本配置。

## 环境放置规则

环境模型完成 Babylon 容器加载并挂到 `EnvironmentRoot` 后：

1. 汇总所有具有真实顶点的环境 Mesh 世界包围盒。
2. 计算根节点偏移，使环境模型包围盒右边界位于 `X=-2m`。
3. 同时使包围盒底部位于 `Y=0`，Z 方向中心位于 `Z=0`。

计算公式：

```text
offsetX = -2 - maximumX
offsetY = -minimumY
offsetZ = -(minimumZ + maximumZ) / 2
```

该规则保证整个环境模型位于原点左侧，不依赖 GLB 自身原点和模型尺寸。若模型没有有效几何包围盒，则使用 `X=-10m` 的安全回退位置。

## 场景保存兼容

- 不修改 `SceneEnvironmentSettings` 字段结构。
- 新环境 GLB 仍保存 `packagePath`、`activeVariantUrl` 和单条 `variants`。
- 同路径重导的 `assetRevision` 通过现有环境 `sourceUrl` 查询参数表达，不新增 `SceneEnvironmentSettings` 字段；URL 解码时查询参数不参与本地路径。
- 原点左侧放置属于运行时统一规则，重新打开场景后自动重建，不需要新增场景字段。

## 错误处理

- 非 `.glb` 文件在 IPC 边界直接拒绝。
- 文件不存在或不是普通文件时直接拒绝。
- 项目目录未选择时沿用现有项目目录选择流程。
- GLB 结构校验、文件复制或包扫描失败时不替换正式包、不写入资产索引，并向 renderer 返回明确错误。
- 正式包切换或资产索引提交失败时，恢复旧环境包和旧索引；若回滚不完整，错误信息必须包含具体失败阶段。
- 环境拖放仍同时校验环境专用 MIME 和 `libraryKind: 'environment'`。

## 验收标准

- 模型库按钮仍显示“导入模型文件夹”。
- 环境库按钮显示“导入环境 GLB”，选择器只能选择 `.glb`。
- `F:\3d-models\envModels\866新厂房_Optimized.glb` 能复制为项目环境资产并显示卡片。
- 拖入环境属性后，环境模型整个包围盒位于负 X，右边界为 `-2m`，底部落在地面且 Z 居中。
- 旧环境模型包仍能从项目索引恢复。
- 同名重导在索引写入失败时保留旧包；成功重导当前正在使用的环境包时自动刷新运行时容器。
- 类型检查、Electron 构建、完整生产构建和差异检查通过。

