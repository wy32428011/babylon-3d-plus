import type { DigitalTwinModelRecoveryResult, ProjectModelAssetEntry } from '../../../electron/types';
import { collectPublishModelReferences, publishModelMatchKey } from '../../../electron/shared/publishModelRecovery';
import { createModelEntity, type SceneDocument } from '../model/SceneDocument';
import { normalizeModelParameterConfig } from '../model/modelParameters';
import { createModelLengthUnitInfo } from '../model/sceneUnits';

function createRecoveredModel(asset: ProjectModelAssetEntry) {
  return createModelEntity(
    asset.path, asset.sourceUrl, asset.displayName || asset.name,
    createModelLengthUnitInfo(asset.lengthUnit), undefined,
    normalizeModelParameterConfig(asset.parameterConfig) ?? undefined,
    asset.scriptAssets, asset.parameterScriptMetadata, asset.animationScriptMetadata,
    asset.defaultAssetCode, asset.assetRevision, asset.dataDrivenConfig, asset.builtInSlotBindingConfig,
  );
}

/** 保留实例 ID、位置、参数和事件；只有没有场景目标的设备类型才新增一个真实模型。 */
export function repairPublishSceneModels(scene: SceneDocument, recovery: DigitalTwinModelRecoveryResult): {
  scene: SceneDocument; restoredCount: number; addedCount: number; reboundCount: number;
} {
  const next = structuredClone(scene);
  const { models, devices } = collectPublishModelReferences(next);
  const byOriginalUrl = new Map(recovery.replacements.flatMap(({ sourceUrls, asset }) => sourceUrls.map((url) => [url, asset] as const)));
  const remappedKeys = new Map<string, string>();
  let restoredCount = 0, addedCount = 0, reboundCount = 0;
  for (const reference of models) {
    const asset = byOriginalUrl.get(String(reference.asset.sourceUrl));
    if (!asset) continue;
    const oldKey = publishModelMatchKey(reference.asset.sourceUrl);
    const { assetCode: _defaultAssetCode, ...replacement } = createRecoveredModel(asset).components.modelAsset!;
    // 参数与遥测属于实例配置，下载的新默认值只补充缺失字段。
    const instance = reference.asset;
    const oldParameters = instance.parameterValues;
    Object.assign(instance, {
      ...replacement, ...instance,
      sourcePath: replacement.sourcePath, sourceUrl: replacement.sourceUrl,
      assetRevision: replacement.assetRevision,
      lengthUnit: replacement.lengthUnit, unitScaleToMeters: replacement.unitScaleToMeters,
      scriptAssets: replacement.scriptAssets ?? [],
      parameterScriptMetadata: replacement.parameterScriptMetadata ?? [],
      animationScriptMetadata: replacement.animationScriptMetadata ?? [],
    });
    if (oldParameters && typeof oldParameters === 'object') {
      instance.parameterValues = { ...replacement.parameterValues, ...oldParameters };
    }
    delete instance.sourceSnapshot;
    if (reference.target) {
      reference.target.assetId = asset.id;
      reference.target.packagePath = asset.packagePath;
      reference.target.thumbnailUrl = asset.thumbnailUrl;
    }
    remappedKeys.set(oldKey, publishModelMatchKey(asset.sourceUrl));
    restoredCount += 1;
  }
  const byModelKey = new Map(models.filter(({ clickTarget }) => clickTarget).map(({ asset }) => [publishModelMatchKey(asset.sourceUrl), asset]));
  for (const [oldKey, newKey] of remappedKeys) {
    if (oldKey !== newKey && byModelKey.has(oldKey) && devices.some((device) => publishModelMatchKey(device.sourceUrl) === oldKey)) {
      throw new Error('中台模型主文件已改名，但场景还保留旧文件的独立工程快照；请统一模型版本并核对点击绑定后发布。');
    }
  }
  for (const device of devices) {
    const originalKey = publishModelMatchKey(device.sourceUrl);
    let model = byModelKey.get(remappedKeys.get(originalKey) ?? originalKey);
    if (!model) {
      const recovered = byOriginalUrl.get(String(device.sourceUrl));
      if (!recovered) throw new Error(`点击事件设备类型「${device.displayName ?? '未命名模型'}」仍无可用场景模型，已停止发布。`);
      const recoveredKey = publishModelMatchKey(recovered.sourceUrl);
      model = byModelKey.get(recoveredKey);
      if (!model) {
        const entity = createRecoveredModel(recovered);
        next.entities[entity.id] = entity;
        next.entityIds.push(entity.id);
        model = entity.components.modelAsset!;
        byModelKey.set(recoveredKey, model);
        addedCount += 1;
      }
      remappedKeys.set(originalKey, recoveredKey);
    }
    if (device.sourceUrl !== model.sourceUrl || device.sourcePath !== model.sourcePath || device.assetRevision !== model.assetRevision) {
      device.sourcePath = model.sourcePath;
      device.sourceUrl = model.sourceUrl;
      // 旧缩略图可能仍指向已丢失的共享包，不能让编辑用图片再次阻断 SOURCE 打包。
      delete device.thumbnailUrl;
      if (model.assetRevision) device.assetRevision = model.assetRevision;
      else delete device.assetRevision;
      reboundCount += 1;
    }
  }
  return { scene: restoredCount || addedCount || reboundCount ? next : scene, restoredCount, addedCount, reboundCount };
}
