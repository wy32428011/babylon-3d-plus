import type { ProjectModelAssetEntry } from '../../../electron/types';
import { getClickEventModelResourceKey } from '../../../electron/shared/clickEventModelIdentity';
import { collectPublishModelReferences } from '../../../electron/shared/publishModelRecovery';
import type { ModelAssetTemplate } from '../model/components';
import type { SceneDocument, SceneEnvironmentSettings } from '../model/SceneDocument';
import { createModelGeneratorTargetFromAsset } from '../model/modelGenerator';
import { hasModelDataDrivenMotionKey } from '../model/telemetryBinding';
import { mergeSceneModelAssetUpdate as mergeModelAssetUpdate } from './mergeModelAssetUpdate';
import { normalizeModelParameterConfig } from '../model/modelParameters';
import { normalizeModelDataDrivenConfig } from '../model/telemetryBinding';
import { normalizeBuiltInSlotBindingConfig } from '../model/builtInSlotBinding';

export type SceneModelReplacement = { sourceUrls: string[]; asset: ProjectModelAssetEntry };
export type SceneModelUpdateIssue = { resourceKind: 'model' | 'combo' | 'environment'; resourceId?: string; message: string };

function createUpdatedTemplate(asset: ProjectModelAssetEntry, sourceKey: string, onWarning?: (message: string) => void): ModelAssetTemplate {
  const parameterConfig = normalizeModelParameterConfig(asset.parameterConfig);
  const dataDrivenConfig = asset.dataDrivenConfig ? normalizeModelDataDrivenConfig(asset.dataDrivenConfig) : undefined;
  const builtInSlotBindingConfig = asset.builtInSlotBindingConfig ? normalizeBuiltInSlotBindingConfig(asset.builtInSlotBindingConfig) : undefined;
  if ((asset.parameterConfig !== undefined && !parameterConfig) || (asset.dataDrivenConfig && !dataDrivenConfig)
    || (asset.builtInSlotBindingConfig && !builtInSlotBindingConfig)) onWarning?.(`模型「${asset.name}」的部分新版参数或绑定配置无效，已忽略无效配置并应用新版模型。`);
  const target = createModelGeneratorTargetFromAsset({ ...asset, parameterConfig: parameterConfig ?? undefined,
    dataDrivenConfig: dataDrivenConfig ?? undefined, builtInSlotBindingConfig: builtInSlotBindingConfig ?? undefined });
  const key = getClickEventModelResourceKey(asset.sourceUrl);
  if (!target || !key) throw new Error('新版模型资源或身份无效，原场景保持不变。');
  const [kind, resourceId, modelPath] = key.split(':') as ['model' | 'combo', string, string];
  target.modelAsset.dataPlatformModel = { sourceKey, kind, resourceId, modelPath };
  return target.modelAsset;
}

/** 同一资源的全部实例及点击引用一起更新；参数配置差异只记录日志。 */
export function applyAvailableSceneModelUpdates(
  scene: SceneDocument, replacements: SceneModelReplacement[], sourceKey: string,
  environment?: SceneEnvironmentSettings | null,
): { scene: SceneDocument; updatedCount: number; issues: SceneModelUpdateIssue[]; warnings: string[] } {
  const resourceKey = (asset: ProjectModelAssetEntry) => getClickEventModelResourceKey(asset.sourceUrl)?.split(':').slice(0, 2).join(':') ?? asset.sourceUrl;
  const failures = new Map<string, SceneModelUpdateIssue>();
  const fail = (asset: ProjectModelAssetEntry, error: unknown) => {
    const key = resourceKey(asset);
    const [kind, resourceId] = key.split(':');
    if (!failures.has(key)) failures.set(key, { resourceKind: kind === 'combo' ? 'combo' : 'model',
      resourceId: /^\d+$/.test(resourceId ?? '') ? resourceId : undefined,
      message: error instanceof Error ? error.message : String(error) });
  };
  for (const { asset } of replacements) {
    try { createUpdatedTemplate(asset, sourceKey); } catch (error) { fail(asset, error); }
  }
  const compatible = replacements.filter(({ asset }) => !failures.has(resourceKey(asset)));
  if (!compatible.length && environment === undefined) return { scene, updatedCount: 0, issues: [...failures.values()], warnings: [] };
  return { ...applySceneModelUpdates(scene, compatible, sourceKey, environment), issues: [...failures.values()] };
}

/** 在独立文档上直接应用新版配置，同key的实例值独立保留。 */
export function applySceneModelUpdates(
  scene: SceneDocument, replacements: SceneModelReplacement[], sourceKey: string,
  environment?: SceneEnvironmentSettings | null,
): { scene: SceneDocument; updatedCount: number; warnings: string[] } {
  const next = structuredClone(scene);
  const byUrl = new Map(replacements.flatMap(replacement => replacement.sourceUrls.map(url => [url, replacement.asset] as const)));
  const { models, devices } = collectPublishModelReferences(next);
  const templates = new Map<ProjectModelAssetEntry, ModelAssetTemplate>();
  const warnings = new Set<string>();
  let updatedCount = 0;
  for (const reference of models) {
    const asset = byUrl.get(String(reference.asset.sourceUrl));
    if (!asset) continue;
    const template = templates.get(asset) ?? createUpdatedTemplate(asset, sourceKey, warning => warnings.add(warning));
    templates.set(asset, template);
    const before = JSON.stringify(reference.asset);
    // 漫游人物只有资源引用；完整模型模板才参与参数与脚本契约合并。
    const merged = 'lengthUnit' in reference.asset
      ? mergeModelAssetUpdate(reference.asset as ModelAssetTemplate, template, String(reference.asset.assetCode ?? reference.target?.displayName ?? asset.name), warning => warnings.add(warning))
      : { ...reference.asset, sourcePath: asset.path, sourceUrl: asset.sourceUrl, assetRevision: asset.assetRevision,
        dataPlatformModel: template.dataPlatformModel };
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
    const template = templates.get(asset) ?? createUpdatedTemplate(asset, sourceKey, warning => warnings.add(warning));
    templates.set(asset, template);
    Object.assign(device, { assetId: asset.id, sourcePath: asset.path, sourceUrl: asset.sourceUrl, assetRevision: asset.assetRevision,
      dataPlatformModel: structuredClone(template.dataPlatformModel) });
    if (asset.thumbnailUrl) device.thumbnailUrl = asset.thumbnailUrl;
    else delete device.thumbnailUrl;
    if (JSON.stringify(device) !== before) updatedCount++;
  }
  // 新版新增 motion 时，实体配置不变，但不能继续复用不支持运动的旧合批实例。
  const updatedUrls = new Set(replacements.map(replacement => replacement.asset.sourceUrl));
  for (const entity of Object.values(next.entities)) {
    const sourceId = entity.components.modelArrayInstance?.sourceEntityId;
    if (!updatedUrls.has(entity.components.modelAsset?.sourceUrl ?? '')
      && !updatedUrls.has(sourceId ? next.entities[sourceId]?.components.modelAsset?.sourceUrl ?? '' : '')) continue;
    if (sourceId && (hasModelDataDrivenMotionKey(entity.components.modelAsset?.dataDrivenConfig)
      || hasModelDataDrivenMotionKey(next.entities[sourceId]?.components.modelAsset?.dataDrivenConfig))) {
      delete entity.components.modelArrayInstance;
    }
  }
  if (environment !== undefined) next.sceneSettings.environment = structuredClone(environment);
  if (JSON.stringify(next) === JSON.stringify(scene)) return { scene, updatedCount: 0, warnings: [...warnings] };
  return { scene: next, updatedCount, warnings: [...warnings] };
}
