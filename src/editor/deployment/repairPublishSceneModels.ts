import type { DigitalTwinModelRecoveryResult, ProjectModelAssetEntry } from '../../../electron/types';
import { collectPublishModelReferences, publishModelMatchKey } from '../../../electron/shared/publishModelRecovery';
import { createModelEntity, type SceneDocument } from '../model/SceneDocument';
import { normalizeModelParameterConfig, restoreModelParameterValues } from '../model/modelParameters';
import { createModelLengthUnitInfo } from '../model/sceneUnits';
import { applyPublishModelIdentityReplacements } from '../../../electron/shared/publishResourceIdentityMigration';
import { mergeSceneModelAssetUpdate } from '../assets/mergeModelAssetUpdate';
import type { ModelAssetTemplate } from '../model/components';
import { normalizeDataPlatformModelIdentity } from '../../../electron/shared/sceneModelUpdatePlan';

function createRecoveredModel(asset: ProjectModelAssetEntry) {
  const entity = createModelEntity(
    asset.path, asset.sourceUrl, asset.displayName || asset.name,
    createModelLengthUnitInfo(asset.lengthUnit), undefined,
    normalizeModelParameterConfig(asset.parameterConfig) ?? undefined,
    asset.scriptAssets, asset.parameterScriptMetadata, asset.animationScriptMetadata,
    asset.defaultAssetCode, asset.assetRevision, asset.dataDrivenConfig, asset.builtInSlotBindingConfig,
  );
  const model = entity.components.modelAsset!;
  const [kind, resourceId, modelPath] = publishModelMatchKey(asset.sourceUrl).split(':');
  if (asset.dataPlatformSourceKey && (kind === 'model' || kind === 'combo') && resourceId && modelPath) {
    model.dataPlatformModel = { sourceKey: asset.dataPlatformSourceKey, kind, resourceId, modelPath };
  }
  // 恢复过程采用本次权威默认值；范围冲突交给参数运行时提示，不能在发布准备中改写默认值。
  if (model.parameterConfig) model.parameterValues = restoreModelParameterValues(model.parameterConfig, {});
  return entity;
}

/** 只改声明为资源地址的字段，不递归触碰参数或业务字符串。 */
function replaceResourcePaths(owner: Record<string, unknown>, asset: ProjectModelAssetEntry): void {
  const fields: Record<string, unknown> = { path: asset.path, sourcePath: asset.path, sourceUrl: asset.sourceUrl,
    packagePath: asset.packagePath, metadataPath: asset.metadataPath,
    thumbnailPath: asset.thumbnailPath, thumbnailUrl: asset.thumbnailUrl, assetId: asset.id };
  for (const [field, value] of Object.entries(fields)) {
    if (!(field in owner)) continue;
    if (value === undefined) delete owner[field]; else owner[field] = value;
  }
  if (Array.isArray(owner.scriptPaths)) {
    owner.scriptPaths = [...new Set([...(asset.scriptPaths ?? []), ...(asset.scriptAssets ?? []).map(script => script.path)])];
  }
}

/** 保留实例 ID、位置、参数和事件；只有没有场景目标的设备类型才新增一个真实模型。 */
export function repairPublishSceneModels(scene: SceneDocument, recovery: DigitalTwinModelRecoveryResult): {
  scene: SceneDocument; restoredCount: number; addedCount: number; reboundCount: number; warnings: string[];
} {
  const identityReplacements = recovery.replacements.filter(({ sourceUrls, asset }) => sourceUrls.some(url => {
    const oldKey = publishModelMatchKey(url).split(':').slice(0, 2).join(':');
    const newKey = publishModelMatchKey(asset.sourceUrl).split(':').slice(0, 2).join(':');
    return oldKey !== newKey;
  }));
  const identitySource = identityReplacements.length ? structuredClone(scene) : scene;
  if (identityReplacements.length) {
    const migratedUrls = new Set(identityReplacements.flatMap(item => item.sourceUrls));
    for (const reference of collectPublishModelReferences(identitySource).models) {
      if (!migratedUrls.has(String(reference.asset.sourceUrl))
        || !('lengthUnit' in reference.asset || 'parameterConfig' in reference.asset)) continue;
      // 完整模型的脚本清单将由新版模板替换；身份迁移仍校验原 ID、包内主文件和内容修订。
      for (const owner of [reference.asset, reference.target]) if (owner) {
        for (const field of ['scriptAssets', 'scriptPaths']) if (Array.isArray(owner[field])) owner[field] = [];
      }
    }
  }
  const next: SceneDocument = identityReplacements.length
    ? JSON.parse(applyPublishModelIdentityReplacements(JSON.stringify({ scene: identitySource }), { replacements: identityReplacements })).scene
    : structuredClone(scene);
  const { models, devices } = collectPublishModelReferences(next);
  const byOriginalUrl = new Map(recovery.replacements.flatMap(item => [
    ...item.sourceUrls, ...(identityReplacements.includes(item) ? [item.asset.sourceUrl] : []),
  ].map(url => [url, item.asset] as const)));
  const remappedKeys = new Map<string, string>();
  const warnings = new Set<string>();
  let restoredCount = 0, addedCount = 0, reboundCount = 0;
  for (const reference of models) {
    const asset = byOriginalUrl.get(String(reference.asset.sourceUrl));
    if (!asset) continue;
    const oldKey = publishModelMatchKey(reference.asset.sourceUrl);
    const { assetCode: _defaultAssetCode, ...replacement } = createRecoveredModel(asset).components.modelAsset!;
    const instance = reference.asset;
    if (!replacement.dataPlatformModel && instance.dataPlatformModel !== undefined) {
      const identity = normalizeDataPlatformModelIdentity(instance.dataPlatformModel);
      const [kind, resourceId, modelPath] = publishModelMatchKey(replacement.sourceUrl).split(':');
      const [previousKind, previousId] = oldKey.split(':');
      if (identity && identity.kind === kind && identity.resourceId === resourceId
        && previousKind === kind && previousId === resourceId && modelPath) {
        replacement.dataPlatformModel = { ...identity, modelPath };
      } else throw new Error('恢复模型的来源身份与已验证资源不一致，已保留原场景。');
    }
    const resourcePaths: Record<string, unknown> = {
      sourcePath: replacement.sourcePath, sourceUrl: replacement.sourceUrl,
      assetRevision: replacement.assetRevision,
      ...(replacement.dataPlatformModel ? { dataPlatformModel: replacement.dataPlatformModel } : {}),
    };
    if ('lengthUnit' in instance || 'parameterConfig' in instance) {
      const merged = mergeSceneModelAssetUpdate(instance as ModelAssetTemplate, replacement,
        String(instance.assetCode ?? reference.target?.displayName ?? asset.name), warning => warnings.add(warning));
      for (const field of Object.keys(instance)) delete instance[field];
      Object.assign(instance, merged);
    } else {
      // 漫游人物等轻量引用不包含参数模板，仅同步资源身份。
      Object.assign(instance, resourcePaths);
    }
    replaceResourcePaths(instance, asset);
    delete instance.sourceSnapshot;
    if (reference.target) {
      replaceResourcePaths(reference.target, asset);
      reference.target.assetId = asset.id;
      reference.target.packagePath = asset.packagePath;
      if (asset.thumbnailUrl) reference.target.thumbnailUrl = asset.thumbnailUrl;
      else delete reference.target.thumbnailUrl;
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
    let identity: ReturnType<typeof normalizeDataPlatformModelIdentity> = undefined;
    try { identity = normalizeDataPlatformModelIdentity(model.dataPlatformModel); } catch {
      warnings.add(`点击设备「${device.displayName ?? '未命名模型'}」的模型身份暂时不可解析，已保留槽位并等待后续中台同步确认。`);
    }
    const identityChanged = identity !== undefined && JSON.stringify(device.dataPlatformModel) !== JSON.stringify(identity);
    const resourceChanged = device.sourceUrl !== model.sourceUrl || device.sourcePath !== model.sourcePath || device.assetRevision !== model.assetRevision;
    if (resourceChanged || identityChanged) {
      device.sourcePath = model.sourcePath;
      device.sourceUrl = model.sourceUrl;
      if (identity) device.dataPlatformModel = identity;
      // 旧缩略图可能仍指向已丢失的共享包，不能让编辑用图片再次阻断 SOURCE 打包。
      if (resourceChanged) delete device.thumbnailUrl;
      if (model.assetRevision) device.assetRevision = model.assetRevision;
      else delete device.assetRevision;
      reboundCount += 1;
    }
  }
  return { scene: restoredCount || addedCount || reboundCount ? next : scene, restoredCount, addedCount, reboundCount, warnings: [...warnings] };
}
