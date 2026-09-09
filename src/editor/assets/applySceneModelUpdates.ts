import type { ProjectModelAssetEntry } from '../../../electron/types';
import { getClickEventModelResourceKey } from '../../../electron/shared/clickEventModelIdentity';
import { collectPublishModelReferences } from '../../../electron/shared/publishModelRecovery';
import type { ModelAssetTemplate } from '../model/components';
import type { SceneDocument, SceneEnvironmentSettings } from '../model/SceneDocument';
import { createModelGeneratorTargetFromAsset } from '../model/modelGenerator';
import { hasModelDataDrivenMotionKey } from '../model/telemetryBinding';
import { mergeModelAssetUpdate } from './mergeModelAssetUpdate';
import { normalizeModelParameterConfig } from '../model/modelParameters';
import { normalizeModelDataDrivenConfig } from '../model/telemetryBinding';
import { normalizeBuiltInSlotBindingConfig } from '../model/builtInSlotBinding';

export type SceneModelReplacement = { sourceUrls: string[]; asset: ProjectModelAssetEntry };

/** 先在独立文档上检查所有实例，只有整批兼容才返回可提交的场景。 */
export function applySceneModelUpdates(
  scene: SceneDocument, replacements: SceneModelReplacement[], sourceKey: string,
  environment?: SceneEnvironmentSettings | null,
): { scene: SceneDocument; updatedCount: number } {
  const next = structuredClone(scene);
  const byUrl = new Map(replacements.flatMap(replacement => replacement.sourceUrls.map(url => [url, replacement.asset] as const)));
  const { models, devices } = collectPublishModelReferences(next);
  let updatedCount = 0;
  for (const reference of models) {
    const asset = byUrl.get(String(reference.asset.sourceUrl));
    if (!asset) continue;
    const target = createModelGeneratorTargetFromAsset({ ...asset,
      parameterConfig: normalizeModelParameterConfig(asset.parameterConfig) ?? undefined,
      dataDrivenConfig: asset.dataDrivenConfig ? normalizeModelDataDrivenConfig(asset.dataDrivenConfig) ?? undefined : undefined,
      builtInSlotBindingConfig: asset.builtInSlotBindingConfig ? normalizeBuiltInSlotBindingConfig(asset.builtInSlotBindingConfig) ?? undefined : undefined,
    });
    const key = getClickEventModelResourceKey(asset.sourceUrl);
    if (!target || !key) throw new Error('新版模型资源或身份无效，原场景保持不变。');
    const [kind, resourceId, modelPath] = key.split(':') as ['model' | 'combo', string, string];
    target.modelAsset.dataPlatformModel = { sourceKey, kind, resourceId, modelPath };
    const before = JSON.stringify(reference.asset);
    // 漫游人物只有资源引用；完整模型模板才参与参数与脚本契约合并。
    const merged = 'lengthUnit' in reference.asset
      ? mergeModelAssetUpdate(reference.asset as ModelAssetTemplate, target.modelAsset, String(reference.asset.assetCode ?? reference.target?.displayName ?? asset.name))
      : { ...reference.asset, sourcePath: asset.path, sourceUrl: asset.sourceUrl, assetRevision: asset.assetRevision,
        dataPlatformModel: target.modelAsset.dataPlatformModel };
    for (const field of Object.keys(reference.asset)) delete reference.asset[field];
    Object.assign(reference.asset, merged);
    if (!('lengthUnit' in reference.asset)) delete reference.asset.sourceSnapshot;
    if (reference.target) {
      reference.target.assetId = asset.id;
      reference.target.packagePath = asset.packagePath;
      if (asset.thumbnailUrl) reference.target.thumbnailUrl = asset.thumbnailUrl;
      else delete reference.target.thumbnailUrl;
    }
    if (JSON.stringify(reference.asset) !== before) updatedCount++;
  }
  for (const device of devices) {
    const asset = byUrl.get(String(device.sourceUrl));
    if (!asset) continue;
    const before = JSON.stringify(device);
    Object.assign(device, { assetId: asset.id, sourcePath: asset.path, sourceUrl: asset.sourceUrl, assetRevision: asset.assetRevision });
    if (asset.thumbnailUrl) device.thumbnailUrl = asset.thumbnailUrl;
    else delete device.thumbnailUrl;
    if (JSON.stringify(device) !== before) updatedCount++;
  }
  // 新版新增 motion 时，实体配置不变，但不能继续复用不支持运动的旧合批实例。
  for (const entity of Object.values(next.entities)) {
    const sourceId = entity.components.modelArrayInstance?.sourceEntityId;
    if (sourceId && (hasModelDataDrivenMotionKey(entity.components.modelAsset?.dataDrivenConfig)
      || hasModelDataDrivenMotionKey(next.entities[sourceId]?.components.modelAsset?.dataDrivenConfig))) {
      delete entity.components.modelArrayInstance;
    }
  }
  if (environment !== undefined) next.sceneSettings.environment = structuredClone(environment);
  if (JSON.stringify(next) === JSON.stringify(scene)) return { scene, updatedCount: 0 };
  return { scene: next, updatedCount };
}
