import type { Entity } from './Entity';
import type { SceneDocument } from './SceneDocument';
import type { EffectDeviceIdentity, EffectModelReference, EffectTargetBinding } from './effectConfiguration';
import { ENVIRONMENT_EFFECT_TARGET_ID } from './environmentBuildingEffect';
import type { ProjectModelAssetEntry } from '../assets/AssetDatabase';
import { createModelTypeIdentityFromAsset, matchesModelTypeReference, modelTypePathKey } from '../../../electron/shared/modelTypeIdentity';

export function effectDeviceIdentity(entity: Entity | undefined): EffectDeviceIdentity | null {
  if (!entity) return null;
  const binding = entity.components.telemetryBinding, model = entity.components.modelAsset;
  const assetCode = binding?.assetCode || model?.assetCode || '';
  const deviceType = (binding?.deviceType || model?.dataDrivenConfig?.device.devType || '').toLowerCase();
  return assetCode && deviceType ? { sourceId: binding?.sourceId || 'default', deviceType, assetCode } : null;
}
const localKey = modelTypePathKey;

export function createEffectModelReference(asset: ProjectModelAssetEntry, scene: Pick<SceneDocument,'entities'|'entityIds'>): EffectModelReference {
  const matched=scene.entityIds.filter(id=>{const model=scene.entities[id]?.components.modelAsset;return model&&(localKey(model.sourcePath)===localKey(asset.path)||localKey(model.sourceUrl)===localKey(asset.sourceUrl));});
  const identities=matched.flatMap(id=>scene.entities[id].components.modelAsset?.dataPlatformModel??[]);
  const identity = createModelTypeIdentityFromAsset(asset)
    ?? (identities.length && identities.every(value=>JSON.stringify(value)===JSON.stringify(identities[0])) ? identities[0] : undefined);
  return {name:asset.displayName||asset.name,sourcePath:asset.path,sourceUrl:asset.sourceUrl,
    deviceType:asset.dataDrivenConfig?.device.devType,...(identity?{identity}:{})};
}

export function matchesEffectModel(entity: Entity, reference: EffectModelReference): boolean {
  const model = entity.components.modelAsset;
  if (!model) return false;
  return matchesModelTypeReference(model, reference);
}

export function resolveEffectModelReference(scene: Pick<SceneDocument, 'entities'>, reference: EffectModelReference | null): { reference: EffectModelReference | null; ambiguous: boolean } {
  if (!reference || reference.identity || !reference.entityIds?.length) return {reference, ambiguous:false};
  const proofs = reference.entityIds.flatMap(id => scene.entities[id]?.components.modelAsset ?? []);
  const keys = new Set(proofs.map(model => JSON.stringify(model.dataPlatformModel ?? localKey(model.sourcePath || model.sourceUrl))));
  if (keys.size > 1) return {reference, ambiguous:true};
  return {reference: proofs.length ? {...reference, sourcePath:proofs[0].sourcePath,sourceUrl:proofs[0].sourceUrl,identity:proofs[0].dataPlatformModel} : reference, ambiguous:false};
}

export type EffectTargetResolution = {
  status: 'resolved' | 'unbound' | 'missing-target' | 'ambiguous' | 'limit';
  ids: string[];
  candidates: { id: string; name: string; assetCode: string }[];
  message: string;
};

/** 只在文档或绑定变化时建立候选集合；完整业务身份筛选先于单目标歧义检查。 */
export function resolveEffectTargets(scene: Pick<SceneDocument, 'entityIds' | 'entities'> & { sceneSettings?: Pick<SceneDocument['sceneSettings'], 'environment'> }, target: EffectTargetBinding, effectKind: string): EffectTargetResolution {
  const result = (status: EffectTargetResolution['status'], ids: string[], message: string): EffectTargetResolution => ({ status, ids,
    candidates: ids.map(id => ({ id, name: scene.entities[id]?.name ?? '环境模型', assetCode: effectDeviceIdentity(scene.entities[id])?.assetCode ?? '' })), message });
  if (target.mode === 'point') return result('resolved', [], '使用特效自身坐标');
  if (target.mode === 'environment') return scene.sceneSettings?.environment ? result('resolved', [ENVIRONMENT_EFFECT_TARGET_ID], '已匹配环境模型') : result('missing-target', [], '等待环境模型');
  if (target.mode === 'entity') {
    const configured = [...new Set(target.entityIds ?? (target.entityId ? [target.entityId] : []))];
    const ids = configured.filter(id=>!!scene.entities[id]);
    if (!configured.length) return result('unbound', [], '请选择目标对象');
    if (effectKind === 'target-follow' && configured.length>1) return result('ambiguous', ids, '相机同时只能跟随一个目标，请选择单个对象或按类型在运行时选择');
    if (configured.length>target.maxTargets) return result('limit', ids.slice(0,target.maxTargets+1), `指定目标数量 ${configured.length} 超过配置上限 ${target.maxTargets}`);
    const missing = configured.length - ids.length;
    return result(ids.length ? 'resolved' : 'missing-target', ids, `已匹配 ${ids.length} 个对象${missing ? `；${missing} 个目标不存在，保留其绑定` : ''}`);
  }
  if (target.mode === 'model' && !target.model) return result('unbound', [], '请从模型库拖入资源模板');
  const needsSingle=target.selection==='single'||effectKind==='target-follow';
  if (target.mode === 'device' && (!target.deviceType || needsSingle&&!target.assetCode)) return result('unbound', [], needsSingle?'请填写协议设备类型和资产编号':'请填写协议设备类型');
  const {reference, ambiguous} = resolveEffectModelReference(scene, target.model);
  if (ambiguous) return result('ambiguous',[],'模板参考对象已指向不同资源，请重新从模型库选择');
  const matches = scene.entityIds.filter(id => {
    if (target.instanceSource === 'generated' || target.generatorId) return false;
    const entity = scene.entities[id];
    if (!entity?.components.modelAsset || entity.components.poiEffect) return false;
    if (target.mode === 'model' && !matchesEffectModel(entity, reference!)) return false;
    const identity = effectDeviceIdentity(entity);
    if (target.sourceId && identity?.sourceId !== target.sourceId) return false;
    if (target.deviceType && identity?.deviceType !== target.deviceType.toLowerCase()) return false;
    return !target.assetCode || identity?.assetCode === target.assetCode;
  });
  if (!matches.length) return result('missing-target', [], '等待匹配的模型或设备，不自动创建模型');
  if (needsSingle && matches.length > 1) return result('ambiguous', matches, '匹配到多个设备，请用数据源和资产编号进一步限定');
  if (matches.length > target.maxTargets) return result('limit', matches.slice(0, target.maxTargets + 1), `目标数量 ${matches.length} 超过配置上限 ${target.maxTargets}`);
  return result('resolved', matches, `已匹配 ${matches.length} 个对象`);
}
