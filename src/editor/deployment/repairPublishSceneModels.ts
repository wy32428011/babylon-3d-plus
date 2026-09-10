import type { DigitalTwinModelRecoveryResult, ProjectModelAssetEntry } from '../../../electron/types';
import { collectPublishModelReferences, publishModelMatchKey } from '../../../electron/shared/publishModelRecovery';
import { createModelEntity, type SceneDocument } from '../model/SceneDocument';
import { normalizeModelParameterConfig } from '../model/modelParameters';
import { createModelLengthUnitInfo } from '../model/sceneUnits';
import { applyPublishModelIdentityReplacements } from '../../../electron/shared/publishResourceIdentityMigration';

function createRecoveredModel(asset: ProjectModelAssetEntry) {
  return createModelEntity(
    asset.path, asset.sourceUrl, asset.displayName || asset.name,
    createModelLengthUnitInfo(asset.lengthUnit), undefined,
    normalizeModelParameterConfig(asset.parameterConfig) ?? undefined,
    asset.scriptAssets, asset.parameterScriptMetadata, asset.animationScriptMetadata,
    asset.defaultAssetCode, asset.assetRevision, asset.dataDrivenConfig, asset.builtInSlotBindingConfig,
  );
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
    const scriptPaths = [...new Set([...(asset.scriptPaths ?? []), ...(asset.scriptAssets ?? []).map(script => script.path)])];
    owner.scriptPaths = owner.scriptPaths.map(value => {
      if (typeof value !== 'string') throw new Error('模型脚本路径格式无效，已停止发布。');
      const fileName = value.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase();
      const candidates = scriptPaths.filter(file => file.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() === fileName);
      if (candidates.length !== 1) throw new Error(`恢复模型无法唯一对应原脚本「${fileName}」，已停止发布。`);
      return candidates[0];
    });
  }
}

/** 保留实例 ID、位置、参数和事件；只有没有场景目标的设备类型才新增一个真实模型。 */
export function repairPublishSceneModels(scene: SceneDocument, recovery: DigitalTwinModelRecoveryResult): {
  scene: SceneDocument; restoredCount: number; addedCount: number; reboundCount: number;
} {
  const identityReplacements = recovery.replacements.filter(({ sourceUrls, asset }) => sourceUrls.some(url => {
    const oldKey = publishModelMatchKey(url).split(':').slice(0, 2).join(':');
    const newKey = publishModelMatchKey(asset.sourceUrl).split(':').slice(0, 2).join(':');
    return oldKey !== newKey;
  }));
  const identityUrls = new Set(identityReplacements.flatMap(item => item.sourceUrls));
  const identityCount = collectPublishModelReferences(scene).models.filter(reference => identityUrls.has(String(reference.asset.sourceUrl))).length;
  const next: SceneDocument = identityReplacements.length
    ? JSON.parse(applyPublishModelIdentityReplacements(JSON.stringify({ scene }), { replacements: identityReplacements })).scene
    : structuredClone(scene);
  const { models, devices } = collectPublishModelReferences(next);
  const byOriginalUrl = new Map(recovery.replacements.filter(item => !identityReplacements.includes(item)).flatMap(({ sourceUrls, asset }) => sourceUrls.map((url) => [url, asset] as const)));
  const remappedKeys = new Map<string, string>();
  let restoredCount = identityCount, addedCount = 0, reboundCount = 0;
  for (const reference of models) {
    const asset = byOriginalUrl.get(String(reference.asset.sourceUrl));
    if (!asset) continue;
    const oldKey = publishModelMatchKey(reference.asset.sourceUrl);
    const { assetCode: _defaultAssetCode, ...replacement } = createRecoveredModel(asset).components.modelAsset!;
    // 参数与遥测属于实例配置，下载的新默认值只补充缺失字段。
    const instance = reference.asset;
    const oldParameters = instance.parameterValues;
    const sameVersion = typeof instance.assetRevision === 'string' && /^[a-f\d]{64}$/i.test(instance.assetRevision)
      && instance.assetRevision.toLowerCase() === replacement.assetRevision?.toLowerCase();
    const resourcePaths: Record<string, unknown> = {
      sourcePath: replacement.sourcePath, sourceUrl: replacement.sourceUrl,
      assetRevision: replacement.assetRevision,
    };
    if (sameVersion) {
      // 同版只迁移原来启用的脚本引用，不能重新启用被实例移除的脚本或覆盖配置值。
      if (Array.isArray(instance.scriptAssets)) resourcePaths.scriptAssets = instance.scriptAssets.map((previous) => {
        const old = previous as Record<string, unknown>;
        const fileName = String(old.path ?? '').replace(/\\/g, '/').split('/').at(-1);
        const script = asset.scriptAssets?.find(item => item.name === old.name
          || item.path.replace(/\\/g, '/').split('/').at(-1) === fileName);
        if (!script) throw new Error(`同版本模型未包含原脚本「${String(old.name ?? fileName)}」，已停止发布。`);
        return { ...old, path: script.path, sourceUrl: script.sourceUrl };
      });
      Object.assign(instance, resourcePaths);
    } else {
      Object.assign(instance, { ...replacement, ...instance, ...resourcePaths,
        scriptAssets: replacement.scriptAssets ?? [],
        lengthUnit: replacement.lengthUnit, unitScaleToMeters: replacement.unitScaleToMeters,
        parameterScriptMetadata: replacement.parameterScriptMetadata ?? [],
        animationScriptMetadata: replacement.animationScriptMetadata ?? [],
      });
    }
    replaceResourcePaths(instance, asset);
    if (!sameVersion && oldParameters && typeof oldParameters === 'object') {
      instance.parameterValues = { ...replacement.parameterValues, ...oldParameters };
    }
    if (!sameVersion) delete instance.sourceSnapshot;
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
