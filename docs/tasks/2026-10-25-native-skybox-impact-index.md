# Babylon 原生天空盒改造：完整引用索引

- 日期：2026-10-25；基线：当前未提交工作树，HEAD `d96ec04`。
- 主方案：[修改方案与验收清单](2026-10-25-native-skybox-migration-plan.md)。
- 范围：统一无限远天空盒＋编辑端 HDR/EXR→预过滤 `.env`＋新版 Viewer 只消费产物。
- 这是一份静态调查索引，不是已实施变更或全部必须修改的文件列表。每个关键领域的具体动作和验收在主方案中。
- 搜索词：`skybox / 天空盒 / 天空球 / SandboxEnvironment / sanGiuseppeBridge`（忽略大小写）；再补充场景版本、资源遍历、烘焙、协议、独立导出和构建调用链。
- 包含 `.cts/.mts`、CSS、JSON、测试夹具；排除依赖、构建输出、历史运行产物、Python 字节码及本次报告自身。不扫描用户实际工程目录 `SharedResources/Platforms`。
- 行号来自此次工作树；导入语句也会命中。`调用链补充` 表示文件不含搜索词，但已由调用关系或协议确认有关。

## 统计

扫描 2031 个文本文件；直接命中 319 个文件；调用链补充 36 个文件；索引共 355 项。

| 范围 | 直接命中文件数 |
| --- | ---: |
| 根目录 | 2 |
| design | 1 |
| docs | 33 |
| electron | 34 |
| public | 2 |
| scripts | 34 |
| src | 81 |
| tests | 132 |

## 分类

- **M**：主方案要求修改的现有入口/契约/维护文档；不是每个文件都要重写。
- **P**：保留算法与回归，将所有权/依赖迁至编辑端预处理，不从仓库删除。
- **D**：有限球体专属模块计划退役；实施时确认全部调用已移除。
- **R**：保留职责或仅接线审查，回归确认；不因为命中词就机械修改。
- **T**：测试、夹具、验收脚本或入口登记候选；逐项按契约决定更新/保留，不批量删除或放宽断言。
- **H**：历史记录/其他方案/生成清单；保留历史事实，只补新方案状态或按生成流程更新。

| 分类 | 文件数 |
| --- | ---: |
| D | 1 |
| H | 27 |
| M | 85 |
| P | 8 |
| R | 68 |
| T | 166 |

## 文件索引

### src/

| 文件 | 分类/领域 | 证据 |
| --- | --- | --- |
| [src/editor/assets/AssetDatabase.ts:12](../../src/editor/assets/AssetDatabase.ts:12) | **M** · E 资产/转换接口 | 命中 16 行；首批 12, 56, 64, 65, 66, 77 … |
| [src/editor/assets/projectLibrary.ts:18](../../src/editor/assets/projectLibrary.ts:18) | **M** · E 资产/转换接口 | 命中 22 行；首批 18, 19, 21, 38, 46, 85 … |
| [src/editor/assets/skyboxAssets.ts:1](../../src/editor/assets/skyboxAssets.ts:1) | **M** · E 资产/转换接口 | 命中 60 行；首批 1, 3, 4, 5, 8, 9 … |
| [src/editor/assets/skyboxSyncController.ts:1](../../src/editor/assets/skyboxSyncController.ts:1) | **R** · E 源数据同步保持 | 命中 55 行；首批 1, 3, 4, 5, 6, 7 … |
| [src/editor/deployment/DeploymentExportDialog.tsx:247](../../src/editor/deployment/DeploymentExportDialog.tsx:247) | **M** · G 发布/恢复/搬迁 | 命中 1 行；首批 247 |
| [src/editor/deployment/deploymentExport.ts:23](../../src/editor/deployment/deploymentExport.ts:23) | **M** · G 发布/恢复/搬迁 | 命中 12 行；首批 23, 123, 133, 134, 135, 136 … |
| [src/editor/deployment/preparePublishScene.ts](../../src/editor/deployment/preparePublishScene.ts) | **M** · G 发布/恢复/搬迁 | 调用链补充 |
| [src/editor/deployment/preparePublishSceneSnapshots.ts:19](../../src/editor/deployment/preparePublishSceneSnapshots.ts:19) | **M** · G 发布/恢复/搬迁 | 命中 2 行；首批 19, 43 |
| [src/editor/deployment/repairPublishSceneSkyboxes.ts:5](../../src/editor/deployment/repairPublishSceneSkyboxes.ts:5) | **M** · G 发布/恢复/搬迁 | 命中 11 行；首批 5, 8, 11, 12, 13, 14 … |
| [src/editor/deployment/useDeploymentExport.ts](../../src/editor/deployment/useDeploymentExport.ts) | **M** · G 发布/恢复/搬迁 | 调用链补充 |
| [src/editor/deployment/useDigitalTwinPublish.ts:8](../../src/editor/deployment/useDigitalTwinPublish.ts:8) | **M** · G 发布/恢复/搬迁 | 命中 5 行；首批 8, 174, 175, 193, 211 |
| [src/editor/hierarchy/hierarchyRows.ts:19](../../src/editor/hierarchy/hierarchyRows.ts:19) | **R** · R 引用者/关联回归 | 命中 2 行；首批 19, 21 |
| [src/editor/home/HomePage.tsx:450](../../src/editor/home/HomePage.tsx:450) | **M** · F 加载准备/诊断 | 命中 3 行；首批 450, 463, 464 |
| [src/editor/loading/projectOpenTrace.ts](../../src/editor/loading/projectOpenTrace.ts) | **M** · F 加载准备/诊断 | 调用链补充 |
| [src/editor/loading/scenePreparationProgress.ts](../../src/editor/loading/scenePreparationProgress.ts) | **M** · F 加载准备/诊断 | 调用链补充 |
| [src/editor/model/SceneDocument.ts:10](../../src/editor/model/SceneDocument.ts:10) | **M** · A 数据契约/兼容 | 命中 101 行；首批 10, 85, 86, 87, 88, 89 … |
| [src/editor/model/components.ts:39](../../src/editor/model/components.ts:39) | **M** · A 数据契约/兼容 | 命中 7 行；首批 39, 40, 42, 43, 49, 51 … |
| [src/editor/model/sceneTheme.ts:20](../../src/editor/model/sceneTheme.ts:20) | **R** · R 引用者/关联回归 | 命中 7 行；首批 20, 54, 66, 79, 92, 105 … |
| [src/editor/panels/HierarchyPanel.tsx:168](../../src/editor/panels/HierarchyPanel.tsx:168) | **R** · R 引用者/关联回归 | 命中 4 行；首批 168, 628, 629, 633 |
| [src/editor/panels/InspectorPanel.tsx:15](../../src/editor/panels/InspectorPanel.tsx:15) | **M** · D 编辑交互/球体清理 | 命中 26 行；首批 15, 16, 17, 18, 19, 20 … |
| [src/editor/panels/LightingBakeManagerAppearance.tsx:18](../../src/editor/panels/LightingBakeManagerAppearance.tsx:18) | **R** · R 引用者/关联回归 | 命中 2 行；首批 18, 19 |
| [src/editor/panels/LightingBakeManagerLighting.tsx:3](../../src/editor/panels/LightingBakeManagerLighting.tsx:3) | **R** · R 引用者/关联回归 | 命中 6 行；首批 3, 18, 52, 58, 59, 60 |
| [src/editor/panels/ProjectPanel.tsx:1](../../src/editor/panels/ProjectPanel.tsx:1) | **M** · D 编辑交互/球体清理 | 命中 172 行；首批 1, 2, 3, 28, 31, 32 … |
| [src/editor/panels/SceneModelEntrancePanel.tsx:77](../../src/editor/panels/SceneModelEntrancePanel.tsx:77) | **R** · R 引用者/关联回归 | 命中 1 行；首批 77 |
| [src/editor/panels/SceneModelStatisticsPanel.tsx:57](../../src/editor/panels/SceneModelStatisticsPanel.tsx:57) | **R** · R 引用者/关联回归 | 命中 1 行；首批 57 |
| [src/editor/panels/SceneSettingsPanel.tsx:18](../../src/editor/panels/SceneSettingsPanel.tsx:18) | **M** · D 编辑交互/球体清理 | 命中 109 行；首批 18, 20, 22, 25, 28, 34 … |
| [src/editor/panels/SceneViewPanel.tsx:299](../../src/editor/panels/SceneViewPanel.tsx:299) | **M** · D 编辑交互/球体清理 | 命中 17 行；首批 299, 424, 775, 890, 1681, 1684 … |
| [src/editor/panels/lightingBakeManagerModel.ts:90](../../src/editor/panels/lightingBakeManagerModel.ts:90) | **R** · R 引用者/关联回归 | 命中 1 行；首批 90 |
| [src/editor/panels/project-library/SkyboxLibraryTab.tsx:1](../../src/editor/panels/project-library/SkyboxLibraryTab.tsx:1) | **M** · D 编辑交互/球体清理 | 命中 33 行；首批 1, 3, 7, 8, 9, 10 … |
| [src/editor/panels/project-library/projectLibrarySyncContracts.ts:2](../../src/editor/panels/project-library/projectLibrarySyncContracts.ts:2) | **M** · E 资产/转换接口 | 命中 13 行；首批 2, 82, 84, 85, 86, 87 … |
| [src/editor/panels/scene-view/useSceneAssetDropHandler.ts:7](../../src/editor/panels/scene-view/useSceneAssetDropHandler.ts:7) | **M** · D 编辑交互/球体清理 | 命中 11 行；首批 7, 12, 13, 23, 40, 65 … |
| [src/editor/panels/scene-view/useSceneFocusTransition.ts:6](../../src/editor/panels/scene-view/useSceneFocusTransition.ts:6) | **M** · D 编辑交互/球体清理 | 命中 6 行；首批 6, 38, 39, 44, 45, 52 |
| [src/editor/project/SceneSerializer.ts:25](../../src/editor/project/SceneSerializer.ts:25) | **M** · A 数据契约/兼容 | 命中 68 行；首批 25, 31, 36, 40, 48, 89 … |
| [src/editor/store/slices/editorStoreTypes.ts:13](../../src/editor/store/slices/editorStoreTypes.ts:13) | **M** · D 编辑交互/球体清理 | 命中 5 行；首批 13, 16, 355, 356, 357 |
| [src/editor/store/slices/entityClipboardOperations.ts:37](../../src/editor/store/slices/entityClipboardOperations.ts:37) | **R** · R 引用者/关联回归 | 命中 1 行；首批 37 |
| [src/editor/store/slices/entityValueOperations.ts:5](../../src/editor/store/slices/entityValueOperations.ts:5) | **M** · D 编辑交互/球体清理 | 命中 2 行；首批 5, 32 |
| [src/editor/store/slices/projectAssetsSlice.ts:6](../../src/editor/store/slices/projectAssetsSlice.ts:6) | **M** · D 编辑交互/球体清理 | 命中 31 行；首批 6, 17, 48, 49, 50, 344 … |
| [src/editor/store/slices/sceneDocumentSlice.ts:18](../../src/editor/store/slices/sceneDocumentSlice.ts:18) | **M** · D 编辑交互/球体清理 | 命中 9 行；首批 18, 657, 659, 661, 662, 691 … |
| [src/editor/store/slices/sceneEntityArrayOperations.ts:105](../../src/editor/store/slices/sceneEntityArrayOperations.ts:105) | **R** · R 引用者/关联回归 | 命中 2 行；首批 105, 111 |
| [src/editor/store/slices/sceneEnvironmentOperations.ts:2](../../src/editor/store/slices/sceneEnvironmentOperations.ts:2) | **M** · D 编辑交互/球体清理 | 命中 23 行；首批 2, 7, 11, 17, 18, 25 … |
| [src/editor/store/slices/selectionAndViewportSlice.ts:9](../../src/editor/store/slices/selectionAndViewportSlice.ts:9) | **M** · D 编辑交互/球体清理 | 命中 3 行；首批 9, 211, 212 |
| [src/player/PlayerApp.tsx:118](../../src/player/PlayerApp.tsx:118) | **M** · F 加载准备/诊断 | 命中 15 行；首批 118, 119, 120, 368, 531, 683 … |
| [src/player/playerInitialLoadMonitor.ts:9](../../src/player/playerInitialLoadMonitor.ts:9) | **M** · F 加载准备/诊断 | 命中 8 行；首批 9, 19, 21, 24, 25, 26 … |
| [src/player/publishedCacheVersion.ts:1](../../src/player/publishedCacheVersion.ts:1) | **R** · I 通用安全/缓存保留 | 命中 2 行；首批 1, 59 |
| [src/player/publishedReleaseCache.ts:23](../../src/player/publishedReleaseCache.ts:23) | **R** · I 通用安全/缓存保留 | 命中 1 行；首批 23 |
| [src/player/publishedReleaseStorage.ts:3](../../src/player/publishedReleaseStorage.ts:3) | **R** · I 通用安全/缓存保留 | 命中 2 行；首批 3, 26 |
| [src/player/publishedSkyboxCameraBounds.ts:5](../../src/player/publishedSkyboxCameraBounds.ts:5) | **D** · D 相机边界退役 | 命中 20 行；首批 5, 6, 7, 12, 17, 35 … |
| [src/runtime/assets/editorAssetUrl.ts](../../src/runtime/assets/editorAssetUrl.ts) | **R** · I 通用安全/缓存保留 | 调用链补充 |
| [src/runtime/assets/publishedAssetCache.ts:2](../../src/runtime/assets/publishedAssetCache.ts:2) | **R** · I 通用安全/缓存保留 | 命中 3 行；首批 2, 72, 155 |
| [src/runtime/assets/publishedCacheStore.ts](../../src/runtime/assets/publishedCacheStore.ts) | **R** · I 通用安全/缓存保留 | 调用链补充 |
| [src/runtime/assets/publishedRawStore.ts:3](../../src/runtime/assets/publishedRawStore.ts:3) | **R** · I 通用安全/缓存保留 | 命中 2 行；首批 3, 57 |
| [src/runtime/assets/runtimeAssetFetch.ts](../../src/runtime/assets/runtimeAssetFetch.ts) | **R** · I 通用安全/缓存保留 | 调用链补充 |
| [src/runtime/babylon/ArcRotateCameraViewController.ts](../../src/runtime/babylon/ArcRotateCameraViewController.ts) | **R** · J 构建/入口回归 | 调用链补充 |
| [src/runtime/babylon/BilinearSkyboxTexture.ts:6](../../src/runtime/babylon/BilinearSkyboxTexture.ts:6) | **P** · C 编辑端预处理复用 | 命中 6 行；首批 6, 7, 14, 15, 27, 31 |
| [src/runtime/babylon/PreparedSkyboxTexture.ts:6](../../src/runtime/babylon/PreparedSkyboxTexture.ts:6) | **P** · C 编辑端预处理复用 | 命中 3 行；首批 6, 11, 33 |
| [src/runtime/babylon/SandboxEnvironmentRuntime.ts:5](../../src/runtime/babylon/SandboxEnvironmentRuntime.ts:5) | **R** · H 光照基线保持 | 命中 13 行；首批 5, 8, 9, 10, 13, 15 … |
| [src/runtime/babylon/SceneAppearanceRuntime.ts](../../src/runtime/babylon/SceneAppearanceRuntime.ts) | **R** · H 光照基线保持 | 调用链补充 |
| [src/runtime/babylon/SceneLightingRuntime.ts:339](../../src/runtime/babylon/SceneLightingRuntime.ts:339) | **M** · H 光照/烘焙 | 命中 2 行；首批 339, 340 |
| [src/runtime/babylon/SceneLoadDiagnostics.ts:10](../../src/runtime/babylon/SceneLoadDiagnostics.ts:10) | **M** · F 加载准备/诊断 | 命中 2 行；首批 10, 33 |
| [src/runtime/babylon/SceneRuntime.ts:10](../../src/runtime/babylon/SceneRuntime.ts:10) | **M** · F 加载准备/诊断 | 命中 10 行；首批 10, 57, 141, 299, 324, 336 … |
| [src/runtime/babylon/SceneShadowRuntime.ts:94](../../src/runtime/babylon/SceneShadowRuntime.ts:94) | **M** · D 背景排除规则 | 命中 4 行；首批 94, 148, 152, 155 |
| [src/runtime/babylon/SceneSkyboxRuntime.ts:14](../../src/runtime/babylon/SceneSkyboxRuntime.ts:14) | **M** · B 原生运行时 | 命中 93 行；首批 14, 15, 16, 17, 20, 21 … |
| [src/runtime/babylon/TransformGizmoController.ts:12](../../src/runtime/babylon/TransformGizmoController.ts:12) | **M** · D 编辑交互/球体清理 | 命中 5 行；首批 12, 298, 936, 954, 966 |
| [src/runtime/babylon/assets/sanGiuseppeBridge.LICENSE.txt:1](../../src/runtime/babylon/assets/sanGiuseppeBridge.LICENSE.txt:1) | **R** · R 引用者/关联回归 | 命中 2 行；首批 1, 2 |
| [src/runtime/babylon/babylonSideEffects.ts](../../src/runtime/babylon/babylonSideEffects.ts) | **M** · B 原生运行时 | 调用链补充 |
| [src/runtime/babylon/createEngine.ts](../../src/runtime/babylon/createEngine.ts) | **R** · J 构建/入口回归 | 调用链补充 |
| [src/runtime/babylon/lightingClassificationRuntime.ts](../../src/runtime/babylon/lightingClassificationRuntime.ts) | **R** · H 光照基线保持 | 调用链补充 |
| [src/runtime/babylon/lightingGeometry.ts](../../src/runtime/babylon/lightingGeometry.ts) | **R** · H 光照基线保持 | 调用链补充 |
| [src/runtime/babylon/lightingRuntimeCapture.ts:94](../../src/runtime/babylon/lightingRuntimeCapture.ts:94) | **M** · H 光照/烘焙 | 命中 3 行；首批 94, 97, 108 |
| [src/runtime/babylon/modelTriangleStatistics.ts:19](../../src/runtime/babylon/modelTriangleStatistics.ts:19) | **M** · D 背景排除规则 | 命中 1 行；首批 19 |
| [src/runtime/babylon/refreshDetachedInstanceSourceMaterials.ts](../../src/runtime/babylon/refreshDetachedInstanceSourceMaterials.ts) | **R** · H 光照基线保持 | 调用链补充 |
| [src/runtime/babylon/scene-runtime/EnvironmentAndSkyboxController.ts:19](../../src/runtime/babylon/scene-runtime/EnvironmentAndSkyboxController.ts:19) | **M** · B 原生运行时 | 命中 56 行；首批 19, 20, 58, 59, 67, 74 … |
| [src/runtime/babylon/scene-runtime/ModelAssetRuntimeController.ts:32](../../src/runtime/babylon/scene-runtime/ModelAssetRuntimeController.ts:32) | **R** · R 引用者/关联回归 | 命中 2 行；首批 32, 62 |
| [src/runtime/babylon/scene-runtime/SceneDocumentController.ts:21](../../src/runtime/babylon/scene-runtime/SceneDocumentController.ts:21) | **M** · B 原生运行时 | 命中 7 行；首批 21, 38, 459, 471, 510, 612 … |
| [src/runtime/babylon/scene-runtime/SceneMeshPresentationController.ts:31](../../src/runtime/babylon/scene-runtime/SceneMeshPresentationController.ts:31) | **R** · R 引用者/关联回归 | 命中 2 行；首批 31, 43 |
| [src/runtime/babylon/scene-runtime/ScenePickingAndSelectionController.ts:9](../../src/runtime/babylon/scene-runtime/ScenePickingAndSelectionController.ts:9) | **M** · D 编辑交互/球体清理 | 命中 7 行；首批 9, 26, 40, 67, 70, 74 … |
| [src/runtime/babylon/scene-runtime/ScenePoiAndEffectsController.ts:18](../../src/runtime/babylon/scene-runtime/ScenePoiAndEffectsController.ts:18) | **R** · R 引用者/关联回归 | 命中 2 行；首批 18, 33 |
| [src/runtime/babylon/scene-runtime/SceneTelemetryController.ts:32](../../src/runtime/babylon/scene-runtime/SceneTelemetryController.ts:32) | **R** · R 引用者/关联回归 | 命中 2 行；首批 32, 51 |
| [src/runtime/babylon/scene-runtime/SceneTransformPreviewController.ts:31](../../src/runtime/babylon/scene-runtime/SceneTransformPreviewController.ts:31) | **M** · D 编辑交互/球体清理 | 命中 5 行；首批 31, 47, 95, 413, 467 |
| [src/runtime/babylon/scene-runtime/SceneTriangleAndReadinessController.ts:26](../../src/runtime/babylon/scene-runtime/SceneTriangleAndReadinessController.ts:26) | **M** · F 加载准备/诊断 | 命中 18 行；首批 26, 43, 262, 263, 349, 350 … |
| [src/runtime/babylon/scene-runtime/SceneWorldBoundsController.ts:26](../../src/runtime/babylon/scene-runtime/SceneWorldBoundsController.ts:26) | **M** · D 编辑交互/球体清理 | 命中 5 行；首批 26, 41, 234, 246, 247 |
| [src/runtime/babylon/scene-runtime/sceneRuntimeTypes.ts:20](../../src/runtime/babylon/scene-runtime/sceneRuntimeTypes.ts:20) | **M** · F 加载准备/诊断 | 命中 3 行；首批 20, 431, 432 |
| [src/runtime/babylon/skyboxContentHash.ts:1](../../src/runtime/babylon/skyboxContentHash.ts:1) | **R** · I 通用安全/缓存保留 | 命中 2 行；首批 1, 6 |
| [src/runtime/babylon/skyboxDecodedCache.ts:1](../../src/runtime/babylon/skyboxDecodedCache.ts:1) | **P** · C 编辑端预处理复用 | 命中 50 行；首批 1, 4, 5, 6, 7, 8 … |
| [src/runtime/babylon/skyboxDecodedData.ts:2](../../src/runtime/babylon/skyboxDecodedData.ts:2) | **P** · C 编辑端预处理复用 | 命中 29 行；首批 2, 3, 5, 6, 8, 15 … |
| [src/runtime/babylon/skyboxDecodedData.worker.ts:1](../../src/runtime/babylon/skyboxDecodedData.worker.ts:1) | **P** · C 编辑端预处理复用 | 命中 20 行；首批 1, 7, 8, 9, 10, 13 … |
| [src/runtime/babylon/skyboxDecodedValidation.ts:1](../../src/runtime/babylon/skyboxDecodedValidation.ts:1) | **P** · C 编辑端预处理复用 | 命中 12 行；首批 1, 2, 3, 5, 6, 7 … |
| [src/runtime/babylon/skyboxPanoramaSampling.ts:2](../../src/runtime/babylon/skyboxPanoramaSampling.ts:2) | **P** · C 编辑端预处理复用 | 命中 5 行；首批 2, 15, 18, 19, 21 |
| [src/runtime/babylon/skyboxPrefilter.ts:4](../../src/runtime/babylon/skyboxPrefilter.ts:4) | **P** · C 编辑端预处理复用 | 命中 2 行；首批 4, 11 |
| [src/runtime/babylon/skyboxTextureLoad.ts:1](../../src/runtime/babylon/skyboxTextureLoad.ts:1) | **M** · B 原生运行时/C 预处理边界 | 命中 14 行；首批 1, 13, 15, 18, 23, 24 … |
| [src/runtime/opening/openingPackageAssets.ts:4](../../src/runtime/opening/openingPackageAssets.ts:4) | **R** · R 引用者/关联回归 | 命中 2 行；首批 4, 108 |
| [src/runtime/roam/manualRoamCollisionBounds.ts:531](../../src/runtime/roam/manualRoamCollisionBounds.ts:531) | **M** · D 背景排除规则 | 命中 2 行；首批 531, 534 |
| [src/runtime/roam/manualRoamCollisionPolicy.ts:14](../../src/runtime/roam/manualRoamCollisionPolicy.ts:14) | **M** · D 背景排除规则 | 命中 3 行；首批 14, 30, 33 |
| [src/styles/global.css:1145](../../src/styles/global.css:1145) | **R** · R 引用者/关联回归 | 命中 11 行；首批 1145, 1578, 1584, 1591, 1600, 1608 … |
| [src/vite-env.d.ts:151](../../src/vite-env.d.ts:151) | **M** · E 资产/转换接口 | 命中 21 行；首批 151, 284, 292, 295, 348, 397 … |

### electron/

| 文件 | 分类/领域 | 证据 |
| --- | --- | --- |
| [electron/ipc/assetIpc.ts:15](../../electron/ipc/assetIpc.ts:15) | **M** · E 资产/转换接口 | 命中 12 行；首批 15, 26, 168, 169, 172, 176 … |
| [electron/ipc/assetRegistry.ts](../../electron/ipc/assetRegistry.ts) | **R** · I 通用安全/缓存保留 | 调用链补充 |
| [electron/ipc/builtinSkyboxAssets.ts:6](../../electron/ipc/builtinSkyboxAssets.ts:6) | **M** · E 资产/转换接口 | 命中 26 行；首批 6, 11, 12, 13, 15, 19 … |
| [electron/ipc/dataPlatformIpc.ts:17](../../electron/ipc/dataPlatformIpc.ts:17) | **R** · J 构建/入口回归 | 命中 10 行；首批 17, 34, 40, 48, 400, 403 … |
| [electron/ipc/dataPlatformProjectLocation.ts:20](../../electron/ipc/dataPlatformProjectLocation.ts:20) | **R** · J 构建/入口回归 | 命中 1 行；首批 20 |
| [electron/ipc/dataPlatformProjectService.ts:21](../../electron/ipc/dataPlatformProjectService.ts:21) | **R** · J 构建/入口回归 | 命中 71 行；首批 21, 51, 101, 102, 103, 104 … |
| [electron/ipc/dataPlatformSceneRelocation.ts:64](../../electron/ipc/dataPlatformSceneRelocation.ts:64) | **M** · G 发布/恢复/搬迁 | 命中 2 行；首批 64, 67 |
| [electron/ipc/dataPlatformSkyboxContract.ts:1](../../electron/ipc/dataPlatformSkyboxContract.ts:1) | **R** · E 源数据同步保持 | 命中 22 行；首批 1, 13, 14, 28, 68, 70 … |
| [electron/ipc/dataPlatformSkyboxIndex.ts:3](../../electron/ipc/dataPlatformSkyboxIndex.ts:3) | **R** · E 源数据同步保持 | 命中 154 行；首批 3, 4, 8, 9, 11, 13 … |
| [electron/ipc/dataPlatformSkyboxSync.ts:6](../../electron/ipc/dataPlatformSkyboxSync.ts:6) | **R** · E 源数据同步保持 | 命中 178 行；首批 6, 7, 8, 9, 10, 12 … |
| [electron/ipc/deploymentExportIpc.ts](../../electron/ipc/deploymentExportIpc.ts) | **R** · J 构建/入口回归 | 调用链补充 |
| [electron/ipc/deploymentExportScene.ts:2](../../electron/ipc/deploymentExportScene.ts:2) | **M** · G 发布/恢复/搬迁 | 命中 73 行；首批 2, 39, 41, 42, 43, 44 … |
| [electron/ipc/deploymentPrecompression.ts](../../electron/ipc/deploymentPrecompression.ts) | **R** · I 通用安全/缓存保留 | 调用链补充 |
| [electron/ipc/deploymentSkyboxCache.ts:5](../../electron/ipc/deploymentSkyboxCache.ts:5) | **M** · G 发布/恢复/搬迁 | 命中 88 行；首批 5, 11, 12, 19, 20, 21 … |
| [electron/ipc/digitalTwinDistPackage.ts:19](../../electron/ipc/digitalTwinDistPackage.ts:19) | **M** · G 发布/恢复/搬迁 | 命中 5 行；首批 19, 40, 41, 91, 92 |
| [electron/ipc/digitalTwinModelRecovery.ts](../../electron/ipc/digitalTwinModelRecovery.ts) | **R** · J 构建/入口回归 | 调用链补充 |
| [electron/ipc/digitalTwinPublishIpc.ts](../../electron/ipc/digitalTwinPublishIpc.ts) | **R** · J 构建/入口回归 | 调用链补充 |
| [electron/ipc/digitalTwinPublishResourceIdentity.ts](../../electron/ipc/digitalTwinPublishResourceIdentity.ts) | **R** · J 构建/入口回归 | 调用链补充 |
| [electron/ipc/digitalTwinPublishResourceRecovery.ts:4](../../electron/ipc/digitalTwinPublishResourceRecovery.ts:4) | **R** · J 构建/入口回归 | 命中 13 行；首批 4, 43, 44, 46, 47, 49 … |
| [electron/ipc/digitalTwinPublishService.ts:59](../../electron/ipc/digitalTwinPublishService.ts:59) | **R** · J 构建/入口回归 | 命中 9 行；首批 59, 61, 334, 481, 482, 499 … |
| [electron/ipc/digitalTwinSourcePackage.ts:1](../../electron/ipc/digitalTwinSourcePackage.ts:1) | **M** · G 发布/恢复/搬迁 | 命中 79 行；首批 1, 12, 13, 14, 15, 16 … |
| [electron/ipc/editorAssetCacheHeaders.ts](../../electron/ipc/editorAssetCacheHeaders.ts) | **M** · I 协议缓存 | 调用链补充 |
| [electron/ipc/lightingBakeService.ts](../../electron/ipc/lightingBakeService.ts) | **R** · H 光照基线保持 | 调用链补充 |
| [electron/ipc/lightingBakeValidation.ts](../../electron/ipc/lightingBakeValidation.ts) | **R** · H 光照基线保持 | 调用链补充 |
| [electron/ipc/localSceneRecoveryService.ts:51](../../electron/ipc/localSceneRecoveryService.ts:51) | **M** · G 发布/恢复/搬迁 | 命中 1 行；首批 51 |
| [electron/ipc/localSceneResourceRecovery.ts:17](../../electron/ipc/localSceneResourceRecovery.ts:17) | **M** · G 发布/恢复/搬迁 | 命中 10 行；首批 17, 178, 179, 282, 362, 366 … |
| [electron/ipc/projectAssetStore.ts:11](../../electron/ipc/projectAssetStore.ts:11) | **M** · E 资产/转换接口 | 命中 57 行；首批 11, 32, 33, 34, 35, 36 … |
| [electron/ipc/projectIpc.ts:43](../../electron/ipc/projectIpc.ts:43) | **R** · J 构建/入口回归 | 命中 18 行；首批 43, 55, 56, 57, 101, 113 … |
| [electron/ipc/publishSceneSnapshots.ts:156](../../electron/ipc/publishSceneSnapshots.ts:156) | **M** · G 发布/恢复/搬迁 | 命中 3 行；首批 156, 157, 175 |
| [electron/ipc/publishSkyboxRecovery.ts:6](../../electron/ipc/publishSkyboxRecovery.ts:6) | **M** · G 发布/恢复/搬迁 | 命中 73 行；首批 6, 9, 10, 11, 13, 14 … |
| [electron/ipc/sceneCadReferenceSanitizer.ts](../../electron/ipc/sceneCadReferenceSanitizer.ts) | **R** · J 构建/入口回归 | 调用链补充 |
| [electron/ipc/sceneLightingBakeResources.ts](../../electron/ipc/sceneLightingBakeResources.ts) | **R** · J 构建/入口回归 | 调用链补充 |
| [electron/ipc/skyboxAssetStore.ts:5](../../electron/ipc/skyboxAssetStore.ts:5) | **R** · E 源数据同步保持 | 命中 51 行；首批 5, 9, 15, 27, 41, 50 … |
| [electron/ipc/viewerTemplateCapabilities.ts:196](../../electron/ipc/viewerTemplateCapabilities.ts:196) | **M** · G 发布/恢复/搬迁 | 命中 2 行；首批 196, 197 |
| [electron/lighting-bake/cycles_bake.py](../../electron/lighting-bake/cycles_bake.py) | **R** · H 光照基线保持 | 调用链补充 |
| [electron/main.ts](../../electron/main.ts) | **R** · J 构建/入口回归 | 调用链补充 |
| [electron/preload.cts:19](../../electron/preload.cts:19) | **M** · E 资产/转换接口 | 命中 12 行；首批 19, 42, 184, 185, 186, 189 … |
| [electron/preload.ts:20](../../electron/preload.ts:20) | **M** · E 资产/转换接口 | 命中 12 行；首批 20, 43, 187, 188, 189, 192 … |
| [electron/shared/glbStandardPreview.ts:37](../../electron/shared/glbStandardPreview.ts:37) | **R** · H 光照基线保持 | 命中 1 行；首批 37 |
| [electron/shared/openingPublishPlan.ts:37](../../electron/shared/openingPublishPlan.ts:37) | **R** · R 引用者/关联回归 | 命中 1 行；首批 37 |
| [electron/shared/projectOpenTrace.ts:9](../../electron/shared/projectOpenTrace.ts:9) | **M** · F 加载准备/诊断 | 命中 1 行；首批 9 |
| [electron/shared/sceneFileVersion.ts](../../electron/shared/sceneFileVersion.ts) | **M** · A 数据契约/兼容 | 调用链补充 |
| [electron/shared/sceneLightingBakeBinary.ts](../../electron/shared/sceneLightingBakeBinary.ts) | **R** · H 光照基线保持 | 调用链补充 |
| [electron/shared/sceneLightingBakeContract.ts:283](../../electron/shared/sceneLightingBakeContract.ts:283) | **M** · H 光照/烘焙 | 命中 5 行；首批 283, 287, 301, 303, 327 |
| [electron/shared/sceneLightingBakePreflight.ts](../../electron/shared/sceneLightingBakePreflight.ts) | **R** · H 光照基线保持 | 调用链补充 |
| [electron/shared/sceneLightingBakeRelocation.ts:45](../../electron/shared/sceneLightingBakeRelocation.ts:45) | **M** · H 光照/烘焙 | 命中 1 行；首批 45 |
| [electron/shared/sceneLightingConfig.ts:11](../../electron/shared/sceneLightingConfig.ts:11) | **R** · H 光照基线保持 | 命中 6 行；首批 11, 23, 46, 138, 164, 176 |
| [electron/shared/sceneResourceTraversal.ts:11](../../electron/shared/sceneResourceTraversal.ts:11) | **M** · A 数据契约/兼容 | 命中 15 行；首批 11, 14, 22, 25, 35, 36 … |
| [electron/shared/sceneShadowBakeContract.ts:62](../../electron/shared/sceneShadowBakeContract.ts:62) | **R** · R 引用者/关联回归 | 命中 2 行；首批 62, 139 |
| [electron/types.ts:163](../../electron/types.ts:163) | **M** · E 资产/转换接口 | 命中 20 行；首批 163, 273, 320, 356, 364, 367 … |

### tests/

| 文件 | 分类/领域 | 证据 |
| --- | --- | --- |
| [tests/dataPlatform/dataPlatformProjectLocation.test.ts:83](../../tests/dataPlatform/dataPlatformProjectLocation.test.ts:83) | **T** · T 测试/夹具候选 | 命中 1 行；首批 83 |
| [tests/dataPlatform/fixtures/electronStub.mjs:1](../../tests/dataPlatform/fixtures/electronStub.mjs:1) | **T** · T 测试/夹具候选 | 命中 1 行；首批 1 |
| [tests/dataPlatform/localSceneResourceRecovery.test.ts:104](../../tests/dataPlatform/localSceneResourceRecovery.test.ts:104) | **T** · T 测试/夹具候选 | 命中 7 行；首批 104, 105, 109, 115, 186, 188 … |
| [tests/dataPlatform/projectSessionClose.integration.mjs:34](../../tests/dataPlatform/projectSessionClose.integration.mjs:34) | **T** · T 测试/夹具候选 | 命中 7 行；首批 34, 46, 78, 99, 109, 114 … |
| [tests/dataPlatform/skyboxContract.test.ts:5](../../tests/dataPlatform/skyboxContract.test.ts:5) | **T** · T 测试/夹具候选 | 命中 68 行；首批 5, 6, 8, 10, 11, 17 … |
| [tests/dataPlatform/skyboxIndex.test.ts:7](../../tests/dataPlatform/skyboxIndex.test.ts:7) | **T** · T 测试/夹具候选 | 命中 204 行；首批 7, 8, 9, 10, 11, 12 … |
| [tests/dataPlatform/skyboxLifecycle.test.ts:25](../../tests/dataPlatform/skyboxLifecycle.test.ts:25) | **T** · T 测试/夹具候选 | 命中 161 行；首批 25, 32, 34, 35, 36, 37 … |
| [tests/dataPlatform/skyboxRelink.test.ts:4](../../tests/dataPlatform/skyboxRelink.test.ts:4) | **T** · T 测试/夹具候选 | 命中 52 行；首批 4, 5, 9, 11, 12, 17 … |
| [tests/dataPlatform/skyboxSyncQueue.test.ts:13](../../tests/dataPlatform/skyboxSyncQueue.test.ts:13) | **T** · T 测试/夹具候选 | 命中 8 行；首批 13, 14, 15, 17, 25, 27 … |
| [tests/dataPlatform/workspaceProjectOpen.integration.mjs:27](../../tests/dataPlatform/workspaceProjectOpen.integration.mjs:27) | **T** · T 测试/夹具候选 | 命中 1 行；首批 27 |
| [tests/digitalTwin/alarmManagerPublish.integration.mjs:54](../../tests/digitalTwin/alarmManagerPublish.integration.mjs:54) | **T** · T 测试/夹具候选 | 命中 1 行；首批 54 |
| [tests/digitalTwin/builtinSkybox.integration.mjs:11](../../tests/digitalTwin/builtinSkybox.integration.mjs:11) | **T** · T 测试/夹具候选 | 命中 15 行；首批 11, 18, 19, 25, 26, 27 … |
| [tests/digitalTwin/builtinSkybox.test.ts:6](../../tests/digitalTwin/builtinSkybox.test.ts:6) | **T** · T 测试/夹具候选 | 命中 16 行；首批 6, 8, 9, 12, 18, 19 … |
| [tests/digitalTwin/chartMarkerVideoPublish.integration.mjs:31](../../tests/digitalTwin/chartMarkerVideoPublish.integration.mjs:31) | **T** · T 测试/夹具候选 | 命中 1 行；首批 31 |
| [tests/digitalTwin/compositionPublish.integration.mjs:36](../../tests/digitalTwin/compositionPublish.integration.mjs:36) | **T** · T 测试/夹具候选 | 命中 1 行；首批 36 |
| [tests/digitalTwin/conveyorArrowEffectsPackages.integration.mjs:60](../../tests/digitalTwin/conveyorArrowEffectsPackages.integration.mjs:60) | **T** · T 测试/夹具候选 | 命中 1 行；首批 60 |
| [tests/digitalTwin/conveyorSurfaceArrowPackages.integration.mjs:146](../../tests/digitalTwin/conveyorSurfaceArrowPackages.integration.mjs:146) | **T** · T 测试/夹具候选 | 命中 1 行；首批 146 |
| [tests/digitalTwin/dataPlatformChartBridge.test.ts:27](../../tests/digitalTwin/dataPlatformChartBridge.test.ts:27) | **T** · T 测试/夹具候选 | 命中 1 行；首批 27 |
| [tests/digitalTwin/dataPlatformSkyboxSync.test.ts:9](../../tests/digitalTwin/dataPlatformSkyboxSync.test.ts:9) | **T** · T 测试/夹具候选 | 命中 215 行；首批 9, 10, 11, 12, 13, 14 … |
| [tests/digitalTwin/deploymentExportFileSystem.test.ts:15](../../tests/digitalTwin/deploymentExportFileSystem.test.ts:15) | **T** · T 测试/夹具候选 | 命中 6 行；首批 15, 17, 18, 25, 30, 37 |
| [tests/digitalTwin/deploymentSkyboxCache.test.ts:5](../../tests/digitalTwin/deploymentSkyboxCache.test.ts:5) | **T** · T 测试/夹具候选 | 命中 28 行；首批 5, 6, 7, 8, 15, 29 … |
| [tests/digitalTwin/digitalTwinEffectsPackages.integration.mjs:75](../../tests/digitalTwin/digitalTwinEffectsPackages.integration.mjs:75) | **T** · T 测试/夹具候选 | 命中 1 行；首批 75 |
| [tests/digitalTwin/digitalTwinPublish.integration.mjs:31](../../tests/digitalTwin/digitalTwinPublish.integration.mjs:31) | **T** · T 测试/夹具候选 | 命中 204 行；首批 31, 32, 33, 34, 36, 37 … |
| [tests/digitalTwin/digitalTwinSourcePackage.test.ts:48](../../tests/digitalTwin/digitalTwinSourcePackage.test.ts:48) | **T** · T 测试/夹具候选 | 命中 21 行；首批 48, 68, 112, 277, 328, 383 … |
| [tests/digitalTwin/editorAssetCacheHeaders.test.ts:20](../../tests/digitalTwin/editorAssetCacheHeaders.test.ts:20) | **T** · T 测试/夹具候选 | 命中 1 行；首批 20 |
| [tests/digitalTwin/effectConfigurationPackages.integration.mjs:66](../../tests/digitalTwin/effectConfigurationPackages.integration.mjs:66) | **T** · T 测试/夹具候选 | 命中 1 行；首批 66 |
| [tests/digitalTwin/effectTemplatePackages.integration.mjs:118](../../tests/digitalTwin/effectTemplatePackages.integration.mjs:118) | **T** · T 测试/夹具候选 | 命中 1 行；首批 118 |
| [tests/digitalTwin/environmentBuildingEffectPackages.integration.mjs:72](../../tests/digitalTwin/environmentBuildingEffectPackages.integration.mjs:72) | **T** · T 测试/夹具候选 | 命中 1 行；首批 72 |
| [tests/digitalTwin/generatedFollowPackages.integration.mjs:47](../../tests/digitalTwin/generatedFollowPackages.integration.mjs:47) | **T** · T 测试/夹具候选 | 命中 1 行；首批 47 |
| [tests/digitalTwin/generatedFollowViewerPackage.integration.mjs:29](../../tests/digitalTwin/generatedFollowViewerPackage.integration.mjs:29) | **T** · T 测试/夹具候选 | 命中 1 行；首批 29 |
| [tests/digitalTwin/geographicOpeningPackages.integration.mjs:149](../../tests/digitalTwin/geographicOpeningPackages.integration.mjs:149) | **T** · T 测试/夹具候选 | 命中 1 行；首批 149 |
| [tests/digitalTwin/glbStandardPreview.test.ts:33](../../tests/digitalTwin/glbStandardPreview.test.ts:33) | **T** · T 测试/夹具候选 | 命中 4 行；首批 33, 40, 64, 65 |
| [tests/digitalTwin/liftMotionArrowPackages.integration.mjs:89](../../tests/digitalTwin/liftMotionArrowPackages.integration.mjs:89) | **T** · T 测试/夹具候选 | 命中 1 行；首批 89 |
| [tests/digitalTwin/lightWallFencePackages.integration.mjs:60](../../tests/digitalTwin/lightWallFencePackages.integration.mjs:60) | **T** · T 测试/夹具候选 | 命中 1 行；首批 60 |
| [tests/digitalTwin/localScenePublishResourceRoots.integration.mjs:41](../../tests/digitalTwin/localScenePublishResourceRoots.integration.mjs:41) | **T** · T 测试/夹具候选 | 命中 1 行；首批 41 |
| [tests/digitalTwin/modelEntrancePackages.integration.mjs:19](../../tests/digitalTwin/modelEntrancePackages.integration.mjs:19) | **T** · T 测试/夹具候选 | 命中 3 行；首批 19, 45, 58 |
| [tests/digitalTwin/multiEffectBindingPackages.integration.mjs:75](../../tests/digitalTwin/multiEffectBindingPackages.integration.mjs:75) | **T** · T 测试/夹具候选 | 命中 1 行；首批 75 |
| [tests/digitalTwin/openingPluginPackages.integration.mjs:100](../../tests/digitalTwin/openingPluginPackages.integration.mjs:100) | **T** · T 测试/夹具候选 | 命中 2 行；首批 100, 187 |
| [tests/digitalTwin/playerEnvironmentLoadContract.test.ts:10](../../tests/digitalTwin/playerEnvironmentLoadContract.test.ts:10) | **T** · T 测试/夹具候选 | 命中 2 行；首批 10, 23 |
| [tests/digitalTwin/playerInitialLoadMonitor.test.ts:6](../../tests/digitalTwin/playerInitialLoadMonitor.test.ts:6) | **T** · T 测试/夹具候选 | 命中 5 行；首批 6, 7, 30, 32, 34 |
| [tests/digitalTwin/playerInitialLoadRenderState.test.ts:81](../../tests/digitalTwin/playerInitialLoadRenderState.test.ts:81) | **T** · T 测试/夹具候选 | 命中 5 行；首批 81, 82, 89, 92, 106 |
| [tests/digitalTwin/playerLoadingProgress.test.ts:121](../../tests/digitalTwin/playerLoadingProgress.test.ts:121) | **T** · T 测试/夹具候选 | 命中 3 行；首批 121, 123, 169 |
| [tests/digitalTwin/prismaticOpeningPublish.integration.mjs:62](../../tests/digitalTwin/prismaticOpeningPublish.integration.mjs:62) | **T** · T 测试/夹具候选 | 命中 1 行；首批 62 |
| [tests/digitalTwin/projectLibraryTabs.test.ts:8](../../tests/digitalTwin/projectLibraryTabs.test.ts:8) | **T** · T 测试/夹具候选 | 命中 108 行；首批 8, 54, 57, 58, 59, 60 … |
| [tests/digitalTwin/publishModelRecovery.integration.mjs:33](../../tests/digitalTwin/publishModelRecovery.integration.mjs:33) | **T** · T 测试/夹具候选 | 命中 16 行；首批 33, 41, 74, 75, 78, 79 … |
| [tests/digitalTwin/publishOrchestration.test.ts:40](../../tests/digitalTwin/publishOrchestration.test.ts:40) | **T** · T 测试/夹具候选 | 命中 6 行；首批 40, 48, 49, 50, 56, 71 |
| [tests/digitalTwin/publishParameterWarnings.test.ts:51](../../tests/digitalTwin/publishParameterWarnings.test.ts:51) | **T** · T 测试/夹具候选 | 命中 13 行；首批 51, 52, 54, 57, 58, 60 … |
| [tests/digitalTwin/publishSceneSnapshots.test.ts:124](../../tests/digitalTwin/publishSceneSnapshots.test.ts:124) | **T** · T 测试/夹具候选 | 命中 8 行；首批 124, 126, 130, 131, 134, 135 … |
| [tests/digitalTwin/publishSkyboxRecovery.test.ts:8](../../tests/digitalTwin/publishSkyboxRecovery.test.ts:8) | **T** · T 测试/夹具候选 | 命中 43 行；首批 8, 9, 10, 14, 19, 21 … |
| [tests/digitalTwin/publishedAssetCache.test.ts:6](../../tests/digitalTwin/publishedAssetCache.test.ts:6) | **T** · T 测试/夹具候选 | 命中 16 行；首批 6, 57, 66, 122, 131, 229 … |
| [tests/digitalTwin/publishedReleaseHttp.browser.test.mjs:13](../../tests/digitalTwin/publishedReleaseHttp.browser.test.mjs:13) | **T** · T 测试/夹具候选 | 命中 3 行；首批 13, 120, 201 |
| [tests/digitalTwin/publishedSkyboxCameraBounds.test.ts:18](../../tests/digitalTwin/publishedSkyboxCameraBounds.test.ts:18) | **T** · T 测试/夹具候选 | 命中 35 行；首批 18, 19, 24, 25, 26, 27 … |
| [tests/digitalTwin/regionViewPackages.integration.mjs:45](../../tests/digitalTwin/regionViewPackages.integration.mjs:45) | **T** · T 测试/夹具候选 | 命中 1 行；首批 45 |
| [tests/digitalTwin/rgvMotionArrowPackages.integration.mjs:91](../../tests/digitalTwin/rgvMotionArrowPackages.integration.mjs:91) | **T** · T 测试/夹具候选 | 命中 1 行；首批 91 |
| [tests/digitalTwin/sceneLightingConfig.test.ts:29](../../tests/digitalTwin/sceneLightingConfig.test.ts:29) | **T** · T 测试/夹具候选 | 命中 6 行；首批 29, 101, 196, 205, 209, 212 |
| [tests/digitalTwin/sceneResourceTraversal.test.ts:7](../../tests/digitalTwin/sceneResourceTraversal.test.ts:7) | **T** · T 测试/夹具候选 | 命中 10 行；首批 7, 22, 26, 30, 40, 41 … |
| [tests/digitalTwin/sceneRuntimeSelection.test.ts:24](../../tests/digitalTwin/sceneRuntimeSelection.test.ts:24) | **T** · T 测试/夹具候选 | 命中 1 行；首批 24 |
| [tests/digitalTwin/sceneRuntimeShadows.test.ts:296](../../tests/digitalTwin/sceneRuntimeShadows.test.ts:296) | **T** · T 测试/夹具候选 | 命中 5 行；首批 296, 300, 301, 308, 310 |
| [tests/digitalTwin/sceneSelectionHighlight.test.ts:59](../../tests/digitalTwin/sceneSelectionHighlight.test.ts:59) | **T** · T 测试/夹具候选 | 命中 5 行；首批 59, 61, 68, 73, 78 |
| [tests/digitalTwin/sceneSwitchPublishGuard.test.ts:209](../../tests/digitalTwin/sceneSwitchPublishGuard.test.ts:209) | **T** · T 测试/夹具候选 | 命中 1 行；首批 209 |
| [tests/digitalTwin/sceneThemePackages.integration.mjs:102](../../tests/digitalTwin/sceneThemePackages.integration.mjs:102) | **T** · T 测试/夹具候选 | 命中 2 行；首批 102, 130 |
| [tests/digitalTwin/skyboxSyncController.test.ts:4](../../tests/digitalTwin/skyboxSyncController.test.ts:4) | **T** · T 测试/夹具候选 | 命中 30 行；首批 4, 5, 8, 10, 11, 16 … |
| [tests/digitalTwin/sourceResourcePlan.test.mjs:37](../../tests/digitalTwin/sourceResourcePlan.test.mjs:37) | **T** · T 测试/夹具候选 | 命中 1 行；首批 37 |
| [tests/digitalTwin/stackerMotionArrowPackages.integration.mjs:82](../../tests/digitalTwin/stackerMotionArrowPackages.integration.mjs:82) | **T** · T 测试/夹具候选 | 命中 1 行；首批 82 |
| [tests/digitalTwin/viewerTemplateCapabilities.test.ts:18](../../tests/digitalTwin/viewerTemplateCapabilities.test.ts:18) | **T** · T 测试/夹具候选 | 命中 4 行；首批 18, 21, 22, 25 |
| [tests/editor/glbStandardPreviewManager.test.mjs:26](../../tests/editor/glbStandardPreviewManager.test.mjs:26) | **T** · T 测试/夹具候选 | 命中 14 行；首批 26, 36, 54, 97, 137, 142 … |
| [tests/editor/lightLibrary.test.mjs:47](../../tests/editor/lightLibrary.test.mjs:47) | **T** · T 测试/夹具候选 | 命中 3 行；首批 47, 49, 70 |
| [tests/editor/lightingBakeManagerModel.test.mjs:27](../../tests/editor/lightingBakeManagerModel.test.mjs:27) | **T** · T 测试/夹具候选 | 命中 2 行；首批 27, 111 |
| [tests/editor/lightingUnified.integration.test.mjs:71](../../tests/editor/lightingUnified.integration.test.mjs:71) | **T** · T 测试/夹具候选 | 命中 1 行；首批 71 |
| [tests/editor/localSceneRecoveryTransaction.test.ts:86](../../tests/editor/localSceneRecoveryTransaction.test.ts:86) | **T** · T 测试/夹具候选 | 命中 2 行；首批 86, 90 |
| [tests/editor/panel-p3-behavior.test.ts:69](../../tests/editor/panel-p3-behavior.test.ts:69) | **T** · T 测试/夹具候选 | 命中 2 行；首批 69, 72 |
| [tests/editor/publishContextRetry.test.ts:8](../../tests/editor/publishContextRetry.test.ts:8) | **T** · T 测试/夹具候选 | 命中 10 行；首批 8, 128, 330, 332, 333, 334 … |
| [tests/editor/repairPublishSceneSkyboxes.test.ts:3](../../tests/editor/repairPublishSceneSkyboxes.test.ts:3) | **T** · T 测试/夹具候选 | 命中 36 行；首批 3, 6, 9, 10, 11, 12 … |
| [tests/editor/runtimeVisibilityRoundTrip.test.mjs:60](../../tests/editor/runtimeVisibilityRoundTrip.test.mjs:60) | **T** · T 测试/夹具候选 | 命中 1 行；首批 60 |
| [tests/editor/sceneEnvironmentReadinessContract.test.ts:61](../../tests/editor/sceneEnvironmentReadinessContract.test.ts:61) | **T** · T 测试/夹具候选 | 命中 3 行；首批 61, 74, 78 |
| [tests/editor/sceneModelLibrarySync.test.ts:120](../../tests/editor/sceneModelLibrarySync.test.ts:120) | **T** · T 测试/夹具候选 | 命中 2 行；首批 120, 131 |
| [tests/editor/scenePreparationProgress.test.ts:52](../../tests/editor/scenePreparationProgress.test.ts:52) | **T** · T 测试/夹具候选 | 命中 4 行；首批 52, 53, 59, 62 |
| [tests/editor/scenePreparationProjectPanelContract.test.ts:27](../../tests/editor/scenePreparationProjectPanelContract.test.ts:27) | **T** · T 测试/夹具候选 | 命中 2 行；首批 27, 59 |
| [tests/editor/sceneStartupResourceGate.test.ts:209](../../tests/editor/sceneStartupResourceGate.test.ts:209) | **T** · T 测试/夹具候选 | 命中 25 行；首批 209, 210, 212, 217, 234, 236 … |
| [tests/editor/sceneTheme.test.ts:30](../../tests/editor/sceneTheme.test.ts:30) | **T** · T 测试/夹具候选 | 命中 1 行；首批 30 |
| [tests/editor/visibilityToggleEffectiveState.test.mjs:37](../../tests/editor/visibilityToggleEffectiveState.test.mjs:37) | **T** · T 测试/夹具候选 | 命中 1 行；首批 37 |
| [tests/fixtures/alarmAppearance.harness.tsx:25](../../tests/fixtures/alarmAppearance.harness.tsx:25) | **T** · T 测试/夹具候选 | 命中 1 行；首批 25 |
| [tests/fixtures/builtinSkybox.harness.tsx:16](../../tests/fixtures/builtinSkybox.harness.tsx:16) | **T** · T 测试/夹具候选 | 命中 6 行；首批 16, 19, 26, 29, 30, 33 |
| [tests/fixtures/effectBindingEditor.harness.tsx:20](../../tests/fixtures/effectBindingEditor.harness.tsx:20) | **T** · T 测试/夹具候选 | 命中 1 行；首批 20 |
| [tests/fixtures/generatedCargoPool.harness.ts:14](../../tests/fixtures/generatedCargoPool.harness.ts:14) | **T** · T 测试/夹具候选 | 命中 2 行；首批 14, 48 |
| [tests/fixtures/openingPackageEditor.harness.tsx:57](../../tests/fixtures/openingPackageEditor.harness.tsx:57) | **T** · T 测试/夹具候选 | 命中 1 行；首批 57 |
| [tests/fixtures/prismaticOpening.harness.tsx:20](../../tests/fixtures/prismaticOpening.harness.tsx:20) | **T** · T 测试/夹具候选 | 命中 1 行；首批 20 |
| [tests/fixtures/skyboxMosaic.harness.ts:2](../../tests/fixtures/skyboxMosaic.harness.ts:2) | **T** · T 测试/夹具候选 | 命中 4 行；首批 2, 11, 27, 31 |
| [tests/helpers/glbStandardPreviewPublishing.mjs:137](../../tests/helpers/glbStandardPreviewPublishing.mjs:137) | **T** · T 测试/夹具候选 | 命中 1 行；首批 137 |
| [tests/helpers/lightingUnifiedUiSmoke.mjs:95](../../tests/helpers/lightingUnifiedUiSmoke.mjs:95) | **T** · T 测试/夹具候选 | 命中 12 行；首批 95, 96, 99, 101, 105, 106 … |
| [tests/lightingBake/lightingBakeSourcePackage.test.ts:53](../../tests/lightingBake/lightingBakeSourcePackage.test.ts:53) | **T** · T 测试/夹具候选 | 命中 2 行；首批 53, 77 |
| [tests/lightingBake/lightingGeometryBinary.integration.mjs:89](../../tests/lightingBake/lightingGeometryBinary.integration.mjs:89) | **T** · T 测试/夹具候选 | 命中 1 行；首批 89 |
| [tests/lightingBake/lightingGeometryBinaryRuntime.test.mjs:35](../../tests/lightingBake/lightingGeometryBinaryRuntime.test.mjs:35) | **T** · T 测试/夹具候选 | 命中 1 行；首批 35 |
| [tests/lightingBake/lightingGeometryRuntimeVersion.test.mjs:35](../../tests/lightingBake/lightingGeometryRuntimeVersion.test.mjs:35) | **T** · T 测试/夹具候选 | 命中 1 行；首批 35 |
| [tests/lightingBake/lightingGeometryV2.integration.mjs:81](../../tests/lightingBake/lightingGeometryV2.integration.mjs:81) | **T** · T 测试/夹具候选 | 命中 1 行；首批 81 |
| [tests/lightingBake/lightingPolicyPersistence.test.ts:117](../../tests/lightingBake/lightingPolicyPersistence.test.ts:117) | **T** · T 测试/夹具候选 | 命中 2 行；首批 117, 194 |
| [tests/lightingBake/lightingUnifiedPersistence.test.ts:47](../../tests/lightingBake/lightingUnifiedPersistence.test.ts:47) | **T** · T 测试/夹具候选 | 命中 2 行；首批 47, 90 |
| [tests/lightingBake/sceneLightingRuntime.test.mjs:46](../../tests/lightingBake/sceneLightingRuntime.test.mjs:46) | **T** · T 测试/夹具候选 | 命中 1 行；首批 46 |
| [tests/p4QualityGates.test.mjs:6](../../tests/p4QualityGates.test.mjs:6) | **T** · T 测试/夹具候选 | 命中 3 行；首批 6, 39, 45 |
| [tests/roam/manualRoamAvatar.integration.mjs:82](../../tests/roam/manualRoamAvatar.integration.mjs:82) | **T** · T 测试/夹具候选 | 命中 1 行；首批 82 |
| [tests/runtime/canonicalEnvironmentLighting.test.mjs:24](../../tests/runtime/canonicalEnvironmentLighting.test.mjs:24) | **T** · T 测试/夹具候选 | 命中 5 行；首批 24, 133, 134, 137, 140 |
| [tests/runtime/fixtures/phase2GammaLegacyClient.json:22](../../tests/runtime/fixtures/phase2GammaLegacyClient.json:22) | **T** · T 测试/夹具候选 | 命中 3 行；首批 22, 28, 34 |
| [tests/runtime/glbStandardPreview.webgl.mjs:50](../../tests/runtime/glbStandardPreview.webgl.mjs:50) | **T** · T 测试/夹具候选 | 命中 1 行；首批 50 |
| [tests/runtime/lightingDraftPreviewController.test.mjs:11](../../tests/runtime/lightingDraftPreviewController.test.mjs:11) | **T** · T 测试/夹具候选 | 命中 6 行；首批 11, 16, 26, 27, 34, 70 |
| [tests/runtime/lightingStartupSnapshotRace.test.mjs:42](../../tests/runtime/lightingStartupSnapshotRace.test.mjs:42) | **T** · T 测试/夹具候选 | 命中 1 行；首批 42 |
| [tests/runtime/modelTriangleStatistics.test.ts:117](../../tests/runtime/modelTriangleStatistics.test.ts:117) | **T** · T 测试/夹具候选 | 命中 1 行；首批 117 |
| [tests/runtime/phase2EntranceLightingOverride.test.mjs:74](../../tests/runtime/phase2EntranceLightingOverride.test.mjs:74) | **T** · T 测试/夹具候选 | 命中 1 行；首批 74 |
| [tests/runtime/phase2EntranceLightingThinCarrier.test.mjs:67](../../tests/runtime/phase2EntranceLightingThinCarrier.test.mjs:67) | **T** · T 测试/夹具候选 | 命中 1 行；首批 67 |
| [tests/runtime/phase2LightingClassificationAudit.test.mjs:17](../../tests/runtime/phase2LightingClassificationAudit.test.mjs:17) | **T** · T 测试/夹具候选 | 命中 17 行；首批 17, 285, 293, 295, 296, 298 … |
| [tests/runtime/phase2LooseModelResourcePlan.test.mjs:70](../../tests/runtime/phase2LooseModelResourcePlan.test.mjs:70) | **T** · T 测试/夹具候选 | 命中 1 行；首批 70 |
| [tests/runtime/phase2ProjectOpenRendererTrace.test.mjs:39](../../tests/runtime/phase2ProjectOpenRendererTrace.test.mjs:39) | **T** · T 测试/夹具候选 | 命中 1 行；首批 39 |
| [tests/runtime/phase2ProjectOpenRuntimeTrace.test.ts:116](../../tests/runtime/phase2ProjectOpenRuntimeTrace.test.ts:116) | **T** · T 测试/夹具候选 | 命中 13 行；首批 116, 117, 119, 124, 125, 126 … |
| [tests/runtime/phase2ProjectOpenTraceIpc.test.mjs:69](../../tests/runtime/phase2ProjectOpenTraceIpc.test.mjs:69) | **T** · T 测试/夹具候选 | 命中 4 行；首批 69, 98, 101, 102 |
| [tests/runtime/sandboxEnvironmentRuntime.test.mjs:23](../../tests/runtime/sandboxEnvironmentRuntime.test.mjs:23) | **T** · T 测试/夹具候选 | 命中 11 行；首批 23, 24, 36, 37, 49, 89 … |
| [tests/runtime/sceneModelReadinessError.test.ts:230](../../tests/runtime/sceneModelReadinessError.test.ts:230) | **T** · T 测试/夹具候选 | 命中 2 行；首批 230, 249 |
| [tests/runtime/sceneOpenPairedPlan.test.mjs:258](../../tests/runtime/sceneOpenPairedPlan.test.mjs:258) | **T** · T 测试/夹具候选 | 命中 1 行；首批 258 |
| [tests/runtime/sceneOpenReadOnlyGuard.test.mjs:17](../../tests/runtime/sceneOpenReadOnlyGuard.test.mjs:17) | **T** · T 测试/夹具候选 | 命中 1 行；首批 17 |
| [tests/runtime/sceneThemeRuntime.test.mjs:25](../../tests/runtime/sceneThemeRuntime.test.mjs:25) | **T** · T 测试/夹具候选 | 命中 1 行；首批 25 |
| [tests/runtime/sha256Compatibility.test.ts:6](../../tests/runtime/sha256Compatibility.test.ts:6) | **T** · T 测试/夹具候选 | 命中 4 行；首批 6, 17, 33, 41 |
| [tests/runtime/skyboxContentHash.test.ts:4](../../tests/runtime/skyboxContentHash.test.ts:4) | **T** · T 测试/夹具候选 | 命中 7 行；首批 4, 11, 12, 20, 23, 27 … |
| [tests/runtime/skyboxDecodedCache.integration.mjs:9](../../tests/runtime/skyboxDecodedCache.integration.mjs:9) | **T** · T 测试/夹具候选 | 命中 12 行；首批 9, 11, 13, 15, 30, 31 … |
| [tests/runtime/skyboxDecodedData.test.ts:3](../../tests/runtime/skyboxDecodedData.test.ts:3) | **T** · T 测试/夹具候选 | 命中 32 行；首批 3, 4, 5, 22, 28, 44 … |
| [tests/runtime/skyboxFallbackSampling.test.ts:4](../../tests/runtime/skyboxFallbackSampling.test.ts:4) | **T** · T 测试/夹具候选 | 命中 1 行；首批 4 |
| [tests/runtime/skyboxHttpCache.integration.mjs:9](../../tests/runtime/skyboxHttpCache.integration.mjs:9) | **T** · T 测试/夹具候选 | 命中 21 行；首批 9, 11, 13, 14, 15, 17 … |
| [tests/runtime/skyboxPanoramaSampling.test.ts:3](../../tests/runtime/skyboxPanoramaSampling.test.ts:3) | **T** · T 测试/夹具候选 | 命中 11 行；首批 3, 9, 22, 35, 48, 62 … |
| [tests/runtime/skyboxPrefilter.test.ts:3](../../tests/runtime/skyboxPrefilter.test.ts:3) | **T** · T 测试/夹具候选 | 命中 6 行；首批 3, 11, 19, 25, 27, 34 |
| [tests/runtime/skyboxRuntimeState.test.ts:7](../../tests/runtime/skyboxRuntimeState.test.ts:7) | **T** · T 测试/夹具候选 | 命中 17 行；首批 7, 8, 9, 11, 17, 25 … |
| [tests/runtime/skyboxTextureLoad.test.ts:3](../../tests/runtime/skyboxTextureLoad.test.ts:3) | **T** · T 测试/夹具候选 | 命中 12 行；首批 3, 16, 21, 30, 80, 94 … |
| [tests/runtime/stackerFocusBounds.test.ts:38](../../tests/runtime/stackerFocusBounds.test.ts:38) | **T** · T 测试/夹具候选 | 命中 1 行；首批 38 |
| [tests/telemetry/builtinSkyboxAsset.test.ts:4](../../tests/telemetry/builtinSkyboxAsset.test.ts:4) | **T** · T 测试/夹具候选 | 命中 21 行；首批 4, 9, 10, 11, 16, 19 … |
| [tests/telemetry/skyboxAssetDragPayload.test.ts:4](../../tests/telemetry/skyboxAssetDragPayload.test.ts:4) | **T** · T 测试/夹具候选 | 命中 21 行；首批 4, 11, 14, 15, 17, 18 … |
| [tests/telemetry/skyboxSettings.test.ts:5](../../tests/telemetry/skyboxSettings.test.ts:5) | **T** · T 测试/夹具候选 | 命中 175 行；首批 5, 6, 10, 15, 20, 25 … |

### scripts/

| 文件 | 分类/领域 | 证据 |
| --- | --- | --- |
| [scripts/babylon-build-chunks.ts](../../scripts/babylon-build-chunks.ts) | **R** · J 构建/入口回归 | 调用链补充 |
| [scripts/build-analysis-plugin.ts](../../scripts/build-analysis-plugin.ts) | **R** · J 构建/入口回归 | 调用链补充 |
| [scripts/build-analysis.mjs](../../scripts/build-analysis.mjs) | **R** · J 构建/入口回归 | 调用链补充 |
| [scripts/lib/phase2LightingClassificationAudit.mjs:99](../../scripts/lib/phase2LightingClassificationAudit.mjs:99) | **T** · T 验收脚本/测试登记候选 | 命中 1 行；首批 99 |
| [scripts/lib/sceneOpenManifestPrepare.mjs:82](../../scripts/lib/sceneOpenManifestPrepare.mjs:82) | **T** · T 验收脚本/测试登记候选 | 命中 4 行；首批 82, 132, 133, 136 |
| [scripts/lib/sceneOpenPairedPlan.mjs:60](../../scripts/lib/sceneOpenPairedPlan.mjs:60) | **T** · T 验收脚本/测试登记候选 | 命中 3 行；首批 60, 62, 128 |
| [scripts/lib/sceneOpenReadOnlyGuard.mjs:70](../../scripts/lib/sceneOpenReadOnlyGuard.mjs:70) | **T** · T 验收脚本/测试登记候选 | 命中 1 行；首批 70 |
| [scripts/phase2-gamma-repackage.mjs:64](../../scripts/phase2-gamma-repackage.mjs:64) | **T** · T 验收脚本/测试登记候选 | 命中 1 行；首批 64 |
| [scripts/phase2-gi-business.mjs:363](../../scripts/phase2-gi-business.mjs:363) | **T** · T 验收脚本/测试登记候选 | 命中 1 行；首批 363 |
| [scripts/phase2-lighting-classification-abba.mjs:155](../../scripts/phase2-lighting-classification-abba.mjs:155) | **T** · T 验收脚本/测试登记候选 | 命中 26 行；首批 155, 177, 178, 179, 180, 181 … |
| [scripts/phase2-mips-business.mjs:170](../../scripts/phase2-mips-business.mjs:170) | **T** · T 验收脚本/测试登记候选 | 命中 1 行；首批 170 |
| [scripts/run-digital-twin-publish-integration.mjs:52](../../scripts/run-digital-twin-publish-integration.mjs:52) | **T** · T 验收脚本/测试登记候选 | 命中 2 行；首批 52, 54 |
| [scripts/smoke-builtin-skybox.mjs:8](../../scripts/smoke-builtin-skybox.mjs:8) | **T** · T 验收脚本/测试登记候选 | 命中 38 行；首批 8, 12, 13, 32, 44, 45 … |
| [scripts/smoke-camera-view.mjs](../../scripts/smoke-camera-view.mjs) | **R** · J 构建/入口回归 | 调用链补充 |
| [scripts/smoke-chart-marker-ring.mjs:99](../../scripts/smoke-chart-marker-ring.mjs:99) | **T** · T 验收脚本/测试登记候选 | 命中 1 行；首批 99 |
| [scripts/smoke-chart-marker-video.mjs:37](../../scripts/smoke-chart-marker-video.mjs:37) | **T** · T 验收脚本/测试登记候选 | 命中 1 行；首批 37 |
| [scripts/smoke-chart-marker.mjs:30](../../scripts/smoke-chart-marker.mjs:30) | **T** · T 验收脚本/测试登记候选 | 命中 1 行；首批 30 |
| [scripts/smoke-data-platform-skybox.mjs:16](../../scripts/smoke-data-platform-skybox.mjs:16) | **T** · T 验收脚本/测试登记候选 | 命中 134 行；首批 16, 17, 18, 19, 20, 30 … |
| [scripts/smoke-extreme-scene-performance.mjs:193](../../scripts/smoke-extreme-scene-performance.mjs:193) | **T** · T 验收脚本/测试登记候选 | 命中 3 行；首批 193, 382, 411 |
| [scripts/smoke-glb-standard-preview.mjs:161](../../scripts/smoke-glb-standard-preview.mjs:161) | **T** · T 验收脚本/测试登记候选 | 命中 2 行；首批 161, 341 |
| [scripts/smoke-hierarchy-virtualization.mjs:118](../../scripts/smoke-hierarchy-virtualization.mjs:118) | **T** · T 验收脚本/测试登记候选 | 命中 16 行；首批 118, 119, 124, 169, 170, 171 … |
| [scripts/smoke-lighting-bake-electron.mjs:17](../../scripts/smoke-lighting-bake-electron.mjs:17) | **T** · T 验收脚本/测试登记候选 | 命中 7 行；首批 17, 24, 39, 40, 41, 42 … |
| [scripts/smoke-lighting-hemisphere.mjs:46](../../scripts/smoke-lighting-hemisphere.mjs:46) | **T** · T 验收脚本/测试登记候选 | 命中 1 行；首批 46 |
| [scripts/smoke-lighting-instance-receivers.mjs:61](../../scripts/smoke-lighting-instance-receivers.mjs:61) | **T** · T 验收脚本/测试登记候选 | 命中 1 行；首批 61 |
| [scripts/smoke-lighting-types.mjs:95](../../scripts/smoke-lighting-types.mjs:95) | **T** · T 验收脚本/测试登记候选 | 命中 2 行；首批 95, 97 |
| [scripts/smoke-persisted-scene-batching.mjs:164](../../scripts/smoke-persisted-scene-batching.mjs:164) | **T** · T 验收脚本/测试登记候选 | 命中 1 行；首批 164 |
| [scripts/smoke-published-release-cache.mjs:38](../../scripts/smoke-published-release-cache.mjs:38) | **T** · T 验收脚本/测试登记候选 | 命中 11 行；首批 38, 44, 47, 54, 55, 76 … |
| [scripts/smoke-published-response-cache.mjs:19](../../scripts/smoke-published-response-cache.mjs:19) | **T** · T 验收脚本/测试登记候选 | 命中 1 行；首批 19 |
| [scripts/smoke-published-viewer-cache.mjs:13](../../scripts/smoke-published-viewer-cache.mjs:13) | **T** · T 验收脚本/测试登记候选 | 命中 9 行；首批 13, 14, 15, 25, 27, 28 … |
| [scripts/smoke-real-project-loading.mjs:73](../../scripts/smoke-real-project-loading.mjs:73) | **T** · T 验收脚本/测试登记候选 | 命中 5 行；首批 73, 186, 197, 204, 663 |
| [scripts/smoke-scene-reopen-snapshots.mjs:64](../../scripts/smoke-scene-reopen-snapshots.mjs:64) | **T** · T 验收脚本/测试登记候选 | 命中 3 行；首批 64, 65, 66 |
| [scripts/smoke-scene-theme-skybox.mjs:7](../../scripts/smoke-scene-theme-skybox.mjs:7) | **T** · T 验收脚本/测试登记候选 | 命中 20 行；首批 7, 21, 29, 31, 73, 79 … |
| [scripts/smoke-selection-highlight.mjs:137](../../scripts/smoke-selection-highlight.mjs:137) | **T** · T 验收脚本/测试登记候选 | 命中 9 行；首批 137, 138, 139, 141, 143, 146 … |
| [scripts/smoke-skybox-assets.mjs:7](../../scripts/smoke-skybox-assets.mjs:7) | **T** · T 验收脚本/测试登记候选 | 命中 20 行；首批 7, 47, 51, 52, 53, 54 … |
| [scripts/smoke-skybox-decoded-data.mjs:10](../../scripts/smoke-skybox-decoded-data.mjs:10) | **T** · T 验收脚本/测试登记候选 | 命中 34 行；首批 10, 11, 16, 18, 20, 21 … |
| [scripts/smoke-skybox-mosaic.mjs:12](../../scripts/smoke-skybox-mosaic.mjs:12) | **T** · T 验收脚本/测试登记候选 | 命中 13 行；首批 12, 14, 32, 35, 50, 63 … |
| [scripts/test-entry-classification.json:360](../../scripts/test-entry-classification.json:360) | **T** · T 验收脚本/测试登记候选 | 命中 40 行；首批 360, 364, 3894, 3898, 4041, 4045 … |
| [scripts/test-entry-manifest.json:281](../../scripts/test-entry-manifest.json:281) | **T** · T 验收脚本/测试登记候选 | 命中 9 行；首批 281, 282, 287, 288, 293, 294 … |

### docs/

| 文件 | 分类/领域 | 证据 |
| --- | --- | --- |
| [docs/changelog.md:39](../../docs/changelog.md:39) | **H** · H 历史方案/记录/清单 | 命中 4 行；首批 39, 40, 44, 47 |
| [docs/conveyor-link-protocol-optimization-backlog.md:61](../../docs/conveyor-link-protocol-optimization-backlog.md:61) | **H** · H 历史方案/记录/清单 | 命中 1 行；首批 61 |
| [docs/digital-twin-effects.md:53](../../docs/digital-twin-effects.md:53) | **H** · H 历史方案/记录/清单 | 命中 2 行；首批 53, 155 |
| [docs/editor-operations.md:9](../../docs/editor-operations.md:9) | **M** · K 当前维护文档 | 命中 5 行；首批 9, 21, 35, 38, 46 |
| [docs/extreme-performance-implementation.md:7](../../docs/extreme-performance-implementation.md:7) | **H** · H 历史方案/记录/清单 | 命中 7 行；首批 7, 29, 71, 73, 91, 128 … |
| [docs/features.md:39](../../docs/features.md:39) | **M** · K 当前维护文档 | 命中 16 行；首批 39, 61, 63, 65, 67, 73 … |
| [docs/hybrid-lighting.md:5](../../docs/hybrid-lighting.md:5) | **M** · K 当前维护文档 | 命中 4 行；首批 5, 15, 74, 174 |
| [docs/lessons.md:35](../../docs/lessons.md:35) | **H** · H 历史方案/记录/清单 | 命中 3 行；首批 35, 355, 409 |
| [docs/optimization-s1-validation.md:61](../../docs/optimization-s1-validation.md:61) | **H** · H 历史方案/记录/清单 | 命中 4 行；首批 61, 65, 76, 99 |
| [docs/project-optimization-plan.md:70](../../docs/project-optimization-plan.md:70) | **H** · H 历史方案/记录/清单 | 命中 7 行；首批 70, 74, 168, 178, 186, 189 … |
| [docs/published-viewer-cache.md:22](../../docs/published-viewer-cache.md:22) | **M** · K 当前维护文档 | 命中 6 行；首批 22, 30, 37, 53, 55, 108 |
| [docs/releases/v0.3.41.md:25](../../docs/releases/v0.3.41.md:25) | **H** · H 历史方案/记录/清单 | 命中 1 行；首批 25 |
| [docs/scene-themes.md:13](../../docs/scene-themes.md:13) | **H** · H 历史方案/记录/清单 | 命中 3 行；首批 13, 23, 42 |
| [docs/scene-web-export.md:23](../../docs/scene-web-export.md:23) | **M** · K 当前维护文档 | 命中 6 行；首批 23, 25, 43, 51, 140, 151 |
| [docs/superpowers/plans/2026-08-10-data-platform-skybox-sync.md:1](../../docs/superpowers/plans/2026-08-10-data-platform-skybox-sync.md:1) | **H** · H 历史方案/记录/清单 | 命中 450 行；首批 1, 5, 7, 9, 18, 24 … |
| [docs/superpowers/specs/2026-08-10-auto-patrol-model-selection-design.md:24](../../docs/superpowers/specs/2026-08-10-auto-patrol-model-selection-design.md:24) | **H** · H 历史方案/记录/清单 | 命中 1 行；首批 24 |
| [docs/superpowers/specs/2026-08-10-data-platform-skybox-sync-design.md:1](../../docs/superpowers/specs/2026-08-10-data-platform-skybox-sync-design.md:1) | **H** · H 历史方案/记录/清单 | 命中 69 行；首批 1, 6, 10, 12, 16, 17 … |
| [docs/task-log.md:3](../../docs/task-log.md:3) | **H** · H 历史方案/记录/清单 | 命中 11 行；首批 3, 5, 6, 7, 164, 168 … |
| [docs/tasks/2026-10-21-unified-lighting.md:13](../../docs/tasks/2026-10-21-unified-lighting.md:13) | **H** · H 历史方案/记录/清单 | 命中 7 行；首批 13, 42, 49, 50, 55, 71 … |
| [docs/tasks/2026-10-22-glb-standard-preview.md:11](../../docs/tasks/2026-10-22-glb-standard-preview.md:11) | **H** · H 历史方案/记录/清单 | 命中 2 行；首批 11, 23 |
| [docs/tasks/2026-10-22-project-optimization-p3.md:40](../../docs/tasks/2026-10-22-project-optimization-p3.md:40) | **H** · H 历史方案/记录/清单 | 命中 2 行；首批 40, 50 |
| [docs/tasks/2026-10-22-project-optimization-p4.md:22](../../docs/tasks/2026-10-22-project-optimization-p4.md:22) | **H** · H 历史方案/记录/清单 | 命中 1 行；首批 22 |
| [docs/tasks/2026-10-23-lighting-invalidation-result.md:15](../../docs/tasks/2026-10-23-lighting-invalidation-result.md:15) | **H** · H 历史方案/记录/清单 | 命中 1 行；首批 15 |
| [docs/tasks/2026-10-24-factory-main-thread-hotspots.md:59](../../docs/tasks/2026-10-24-factory-main-thread-hotspots.md:59) | **H** · H 历史方案/记录/清单 | 命中 1 行；首批 59 |
| [docs/tasks/2026-10-24-render-optimization-l2-design-review.md:26](../../docs/tasks/2026-10-24-render-optimization-l2-design-review.md:26) | **H** · H 历史方案/记录/清单 | 命中 1 行；首批 26 |
| [docs/tasks/2026-10-24-render-optimization-l8-assessment.md:17](../../docs/tasks/2026-10-24-render-optimization-l8-assessment.md:17) | **H** · H 历史方案/记录/清单 | 命中 1 行；首批 17 |
| [docs/tasks/2026-10-24-render-optimization-q1-classification-design.md:17](../../docs/tasks/2026-10-24-render-optimization-q1-classification-design.md:17) | **H** · H 历史方案/记录/清单 | 命中 2 行；首批 17, 22 |
| [docs/tasks/2026-10-25-optimization-phase2-continuation.md:5](../../docs/tasks/2026-10-25-optimization-phase2-continuation.md:5) | **H** · H 历史方案/记录/清单 | 命中 6 行；首批 5, 14, 21, 28, 42, 85 |
| [docs/test-groups.md:34](../../docs/test-groups.md:34) | **M** · K 当前维护文档 | 命中 1 行；首批 34 |
| [docs/test-inventory.md:28](../../docs/test-inventory.md:28) | **H** · H 历史方案/记录/清单 | 命中 37 行；首批 28, 99, 102, 103, 118, 184 … |
| [docs/全项目优化方案-第二期.md:22](../../docs/全项目优化方案-第二期.md:22) | **H** · H 历史方案/记录/清单 | 命中 2 行；首批 22, 52 |
| [docs/全项目渲染光照烘焙加载优化方案.md:57](../../docs/全项目渲染光照烘焙加载优化方案.md:57) | **H** · H 历史方案/记录/清单 | 命中 7 行；首批 57, 66, 111, 320, 322, 326 … |
| [docs/极致性能优化方案.md:22](../../docs/极致性能优化方案.md:22) | **H** · H 历史方案/记录/清单 | 命中 10 行；首批 22, 56, 62, 109, 116, 132 … |

### public/

| 文件 | 分类/领域 | 证据 |
| --- | --- | --- |
| [public/builtin-skyboxes/LICENSE.md:1](../../public/builtin-skyboxes/LICENSE.md:1) | **M** · J 构建/内置资源 | 命中 1 行；首批 1 |
| [public/third-party-licenses/sandbox-environment.txt:1](../../public/third-party-licenses/sandbox-environment.txt:1) | **R** · R 引用者/关联回归 | 命中 2 行；首批 1, 2 |

### 根目录及其他配置

| 文件 | 分类/领域 | 证据 |
| --- | --- | --- |
| [README.md:129](../../README.md:129) | **M** · K 当前维护文档 | 命中 14 行；首批 129, 172, 174, 177, 186, 217 … |
| [design/qa.md:46](../../design/qa.md:46) | **R** · R 引用者/关联回归 | 命中 1 行；首批 46 |
| [package.json:88](../../package.json:88) | **M** · J 构建/内置资源 | 命中 8 行；首批 88, 89, 90, 91, 105, 121 … |
| [vite.config.ts](../../vite.config.ts) | **M** · J 构建/内置资源 | 调用链补充 |
| [vite.viewer.config.ts](../../vite.viewer.config.ts) | **M** · J 构建/内置资源 | 调用链补充 |

## 阅读边界

- 文本命中数不等于语义影响数量，更不等于最终修改数量。通用哈希工具导致的缓存/开场命中不要求修改开场业务。
- 关键入口已经定向阅读；大量集成夹具只作为回归入口登记，没有声称逐个运行或逐行审计。
- 新增转换器、派生资产存储、共享天空资源契约与专项验收文件尚不存在，见主方案的新增模块章节。
- 外部数据中台服务器实现、实际业务场景视觉、GPU 转换耗时和产物数值误差不在这次静态调查的验证结论内。
