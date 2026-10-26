import { modelRuntimeCapabilitiesField } from '../../../../electron/shared/modelRuntimeCapabilities.ts';
import { mergeSceneModelAssetUpdate as mergeModelAssetUpdate } from '../../assets/mergeModelAssetUpdate';
import type { AssetEntry } from '../../assets/AssetDatabase';
import { createImportedAssetIndexes, findImportedAssetForModelAsset } from '../../assets/modelAssetRelink';
import { normalizeModelSourceSnapshot } from '../../model/modelSourceSnapshot';
import type { ModelAssetComponent, ModelAssetTemplate, ModelGeneratorComponent, ModelGeneratorTarget } from '../../model/components';
import { type SceneDocument } from '../../model/SceneDocument';
import { areModelParameterValuesEqual, normalizeModelParameterConfig, restoreModelParameterValues } from '../../model/modelParameters';
import { createModelLengthUnitInfo, type ModelLengthUnitInfo } from '../../model/sceneUnits';
import { createModelGeneratorTargetFromAsset } from '../../model/modelGenerator';
import { hasModelDataDrivenMotionKey } from '../../model/telemetryBinding';
import { cloneJsonValue } from './entityValueOperations';

/** 根据新导入的资产快照生成场景实例的新 modelAsset，同时保留现场资产编号。 */
export function createRefreshedModelAsset(modelAsset: ModelAssetComponent, asset: AssetEntry): ModelAssetComponent {
  const parameterConfig = normalizeModelParameterConfig(asset.parameterConfig) ?? undefined;
  const unitInfo: ModelLengthUnitInfo = createModelLengthUnitInfo(asset.lengthUnit);

  return mergeModelAssetUpdate(modelAsset, {

    sourcePath: asset.path,
    sourceUrl: asset.sourceUrl,
    ...(asset.assetRevision ? { assetRevision: asset.assetRevision } : {}),
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    ...(asset.scriptAssets?.length ? { scriptAssets: cloneJsonValue(asset.scriptAssets) } : {}),
    ...(asset.parameterScriptMetadata?.length ? { parameterScriptMetadata: cloneJsonValue(asset.parameterScriptMetadata) } : {}),
    ...modelRuntimeCapabilitiesField(asset.runtimeCapabilities),
    ...(asset.animationScriptMetadata?.length ? { animationScriptMetadata: cloneJsonValue(asset.animationScriptMetadata) } : {}),
    ...(asset.dataDrivenConfig ? { dataDrivenConfig: cloneJsonValue(asset.dataDrivenConfig) } : {}),
    ...(asset.builtInSlotBindingConfig ? { builtInSlotBindingConfig: cloneJsonValue(asset.builtInSlotBindingConfig) } : {}),
    ...(asset.layerChangePlatformBindingConfig ? { layerChangePlatformBindingConfig: cloneJsonValue(asset.layerChangePlatformBindingConfig) } : {}),
    ...(parameterConfig
      ? {
          parameterConfig,
          parameterValues: restoreModelParameterValues(parameterConfig, modelAsset.parameterValues),
        }
      : {}),
  }, modelAsset.assetCode);
}

/** 比较可序列化元数据，供字段级模型快照比较复用。 */
export function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** 判断刷新前后的模型资产快照是否等价，用于避免写入空的撤销历史。 */
function areModelAssetsEqual(left: ModelAssetComponent, right: ModelAssetComponent): boolean {
  return (
    left.assetCode === right.assetCode &&
    left.sourcePath === right.sourcePath &&
    left.sourceUrl === right.sourceUrl &&
    (left.assetRevision ?? '') === (right.assetRevision ?? '') &&
    areJsonValuesEqual(left.sourceSnapshot, right.sourceSnapshot) &&
    left.lengthUnit === right.lengthUnit &&
    left.unitScaleToMeters === right.unitScaleToMeters &&
    areJsonValuesEqual(left.scriptAssets, right.scriptAssets) &&
    areJsonValuesEqual(left.runtimeCapabilities, right.runtimeCapabilities) &&
    areJsonValuesEqual(left.parameterScriptMetadata, right.parameterScriptMetadata) &&
    areJsonValuesEqual(left.animationScriptMetadata, right.animationScriptMetadata) &&
    areJsonValuesEqual(left.dataDrivenConfig, right.dataDrivenConfig) &&
    areJsonValuesEqual(left.builtInSlotBindingConfig, right.builtInSlotBindingConfig) &&
    areJsonValuesEqual(left.layerChangePlatformBindingConfig, right.layerChangePlatformBindingConfig) &&
    areJsonValuesEqual(left.parameterConfig, right.parameterConfig) &&
    areModelParameterValuesEqual(left.parameterValues ?? {}, right.parameterValues ?? {})
  );
}

/** 区分启动路径恢复与用户明确更新资源，避免索引修订覆盖完整场景快照。 */
function findAssetForSceneRefresh(
  modelAsset: Pick<ModelAssetTemplate, 'sourcePath' | 'sourceUrl' | 'sourceSnapshot'>,
  indexes: ReturnType<typeof createImportedAssetIndexes>,
  preserveResolvedSnapshots: boolean,
): AssetEntry | null {
  // 打开工程已将包内路径重定位；后台候选可能仅包含共享新版，不能按同 ID 替换固定版本。
  if (preserveResolvedSnapshots && normalizeModelSourceSnapshot(modelAsset.sourceSnapshot)) return null;
  const asset = findImportedAssetForModelAsset(modelAsset, indexes);
  if (!asset || !preserveResolvedSnapshots) return asset;
  const normalizePath = (value: string) => value.trim().replace(/\\/g, '/').toLowerCase();
  // 打开工程只恢复失效路径，保留已解析文件对应的完整编辑快照和烘焙版本。
  return normalizePath(modelAsset.sourcePath) === normalizePath(asset.path)
    && modelAsset.sourceUrl === asset.sourceUrl ? null : asset;
}

/** 使用本轮导入资产刷新单个生成目标；内置 Mesh 和未匹配目标保持原值。 */
function refreshModelGeneratorTargetFromImportedAssets(
  target: ModelGeneratorTarget | null,
  indexes: ReturnType<typeof createImportedAssetIndexes>,
  preserveResolvedSnapshots = false,
): { target: ModelGeneratorTarget | null; refreshedCount: number } {
  if (!target || target.kind !== 'model') return { target, refreshedCount: 0 };

  const importedAsset = findAssetForSceneRefresh(target.modelAsset, indexes, preserveResolvedSnapshots);
  if (!importedAsset) return { target, refreshedCount: 0 };

  const refreshedTarget = createModelGeneratorTargetFromAsset(importedAsset);
  if (!refreshedTarget) return { target, refreshedCount: 0 };
  const merged = { ...target, ...refreshedTarget, displayName: target.displayName,
    modelAsset: mergeModelAssetUpdate(target.modelAsset, refreshedTarget.modelAsset, target.displayName) };
  if (areJsonValuesEqual(target, merged)) return { target, refreshedCount: 0 };
  return { target: merged, refreshedCount: 1 };
}

/** 刷新模型生成器的默认目标和每条规则目标，生成器绑定及规则文本保持不变。 */
function refreshModelGeneratorFromImportedAssets(
  modelGenerator: ModelGeneratorComponent,
  indexes: ReturnType<typeof createImportedAssetIndexes>,
  preserveResolvedSnapshots = false,
): { modelGenerator: ModelGeneratorComponent; refreshedCount: number } {
  const defaultResult = refreshModelGeneratorTargetFromImportedAssets(modelGenerator.defaultTarget, indexes, preserveResolvedSnapshots);
  let refreshedCount = defaultResult.refreshedCount;
  const rules = modelGenerator.rules.map((rule) => {
    const result = refreshModelGeneratorTargetFromImportedAssets(rule.target, indexes, preserveResolvedSnapshots);
    refreshedCount += result.refreshedCount;
    return result.target === rule.target ? rule : { ...rule, target: result.target };
  });

  if (refreshedCount === 0) return { modelGenerator, refreshedCount };
  return {
    modelGenerator: {
      ...modelGenerator,
      defaultTarget: defaultResult.target,
      rules,
    },
    refreshedCount,
  };
}

/** 批量刷新场景中的普通模型实例和模型生成器目标，并返回刷新引用数量。 */
export function refreshSceneModelAssetsFromImportedAssets(
  scene: SceneDocument,
  assets: AssetEntry[],
  preserveResolvedSnapshots = false,
): { scene: SceneDocument; refreshedCount: number; detachedMotionInstanceCount: number } {
  const indexes = createImportedAssetIndexes(assets);
  let refreshedCount = 0;
  let detachedMotionInstanceCount = 0;
  const entities: SceneDocument['entities'] = { ...scene.entities };

  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    if (!entity) continue;

    let components = entity.components;
    let entityChanged = false;
    const modelAsset = entity.components.modelAsset;
    if (modelAsset) {
      const importedAsset = findAssetForSceneRefresh(modelAsset, indexes, preserveResolvedSnapshots);
      if (importedAsset) {
        const refreshedModelAsset = createRefreshedModelAsset(modelAsset, importedAsset);
        if (!areModelAssetsEqual(modelAsset, refreshedModelAsset)) {
          refreshedCount += 1;
          components = { ...components, modelAsset: refreshedModelAsset };
          entityChanged = true;
        }
      }
    }

    const alarmManager = entity.components.alarmManager;
    if (alarmManager) {
      const appearance = refreshModelGeneratorTargetFromImportedAssets(alarmManager.appearanceModel, indexes, preserveResolvedSnapshots);
      let alarmRefreshCount = appearance.refreshedCount;
      const targets = alarmManager.targets.map(slot => {
        const result = refreshModelGeneratorTargetFromImportedAssets(slot.model, indexes, preserveResolvedSnapshots);
        alarmRefreshCount += result.refreshedCount;
        return result.refreshedCount ? { ...slot, model: result.target } : slot;
      });
      if (alarmRefreshCount) {
        components = { ...components, alarmManager: { ...alarmManager, appearanceModel: appearance.target, targets } };
        refreshedCount += alarmRefreshCount;
        entityChanged = true;
      }
    }
    const avatar = entity.components.manualRoamSpawn?.avatar;
    if (avatar) {
      const importedAsset = findAssetForSceneRefresh(avatar, indexes, preserveResolvedSnapshots);
      if (importedAsset && (avatar.sourcePath !== importedAsset.path || avatar.sourceUrl !== importedAsset.sourceUrl
        || avatar.assetRevision !== importedAsset.assetRevision || avatar.sourceSnapshot !== undefined)) {
        components = { ...components, manualRoamSpawn: { avatar: {
          ...avatar, sourcePath: importedAsset.path, sourceUrl: importedAsset.sourceUrl,
          assetRevision: importedAsset.assetRevision,
          sourceSnapshot: undefined,
        } } };
        refreshedCount += 1;
        entityChanged = true;
      }
    }
    const modelGenerator = entity.components.modelGenerator;
    if (modelGenerator) {
      const generatorResult = refreshModelGeneratorFromImportedAssets(modelGenerator, indexes, preserveResolvedSnapshots);
      if (generatorResult.refreshedCount > 0) {
        refreshedCount += generatorResult.refreshedCount;
        components = { ...components, modelGenerator: generatorResult.modelGenerator };
        entityChanged = true;
      }
    }

    if (entityChanged) entities[entityId] = { ...entity, components };
  }

  // 元数据刷新后以最终模型快照判定；实例或其源新增 motion 都必须立即退出旧合批。
  for (const entityId of scene.entityIds) {
    const entity = entities[entityId];
    const sourceEntityId = entity?.components.modelArrayInstance?.sourceEntityId;
    if (!entity || !sourceEntityId) continue;

    const sourceEntity = entities[sourceEntityId];
    if (preserveResolvedSnapshots && entity === scene.entities[entityId]
      && sourceEntity === scene.entities[sourceEntityId]) continue;
    if (
      !hasModelDataDrivenMotionKey(entity.components.modelAsset?.dataDrivenConfig)
      && !hasModelDataDrivenMotionKey(sourceEntity?.components.modelAsset?.dataDrivenConfig)
    ) {
      continue;
    }

    const { modelArrayInstance: _modelArrayInstance, ...components } = entity.components;
    entities[entityId] = { ...entity, components };
    detachedMotionInstanceCount += 1;
  }

  if (refreshedCount === 0 && detachedMotionInstanceCount === 0) {
    return { scene, refreshedCount, detachedMotionInstanceCount };
  }

  return {
    scene: {
      ...scene,
      entities,
    },
    refreshedCount,
    detachedMotionInstanceCount,
  };
}
