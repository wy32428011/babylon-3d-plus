import type { SceneDocument } from '../../editor/model/SceneDocument';
import type { EffectRuntimeTarget, EffectTargetBinding, EffectTargetCandidate } from '../../editor/model/effectConfiguration';
import { effectDeviceIdentity, resolveEffectModelReference } from '../../editor/model/effectTargets';
import { matchesModelTypeReference } from '../../../electron/shared/modelTypeIdentity';

export type RuntimeEffectResolution = {
  status: 'resolved' | 'unbound' | 'missing-target' | 'ambiguous' | 'limit' | 'loading' | 'error';
  ids: string[];
  candidates: EffectTargetCandidate[];
  message: string;
  targets: EffectRuntimeTarget[];
};

/** 业务锁定可以跨重建恢复；匿名实例只允许在当前运行对象与代际内锁定。 */
export function runtimeTargetLockKey(target: EffectRuntimeTarget): string {
  if (target.identity) return JSON.stringify(['device', target.identity.sourceId, target.identity.deviceType, target.identity.assetCode]);
  // 承载设备的数据来源可在库存与设备交接时变化，不属于货物本身的身份。
  if (target.containerCode) return JSON.stringify(['container', target.generatorId ?? '', target.containerCode]);
  return JSON.stringify(['runtime', target.id, target.generation]);
}

export function sceneEffectTargets(scene: Pick<SceneDocument, 'entityIds' | 'entities'>): EffectRuntimeTarget[] {
  return scene.entityIds.flatMap(id => {
    const entity = scene.entities[id], model = entity?.components.modelAsset;
    if (!model || entity.components.poiEffect) return [];
    return [{ id, name: entity.name, origin: 'scene' as const,
      model: { name: entity.name, sourcePath: model.sourcePath, sourceUrl: model.sourceUrl, identity: model.dataPlatformModel, deviceType: model.dataDrivenConfig?.device.devType },
      identity: effectDeviceIdentity(entity), state: entity.visible === false ? 'hidden' as const : 'ready' as const, generation: 0 }];
  });
}

/** 只解析类型和会话选择；场景文件中从不保存运行 ID。 */
export function resolveRuntimeEffectTargets(
  scene: Pick<SceneDocument, 'entityIds' | 'entities'>,
  binding: EffectTargetBinding,
  generated: readonly EffectRuntimeTarget[],
  session: { selectedId?: string | null; lockedKey?: string | null; multiple?: boolean; follow?: boolean } = {},
): RuntimeEffectResolution {
  const result = (status: RuntimeEffectResolution['status'], targets: EffectRuntimeTarget[], matches: EffectRuntimeTarget[], message: string): RuntimeEffectResolution => ({
    status, ids: targets.map(t => t.id), targets, message,
    candidates: matches.slice(0, 64).map(t => ({ id: t.id, name: t.name, assetCode: t.identity?.assetCode ?? t.containerCode ?? '', origin: t.origin, state: t.state, containerCode: t.containerCode, generatorId: t.generatorId })),
  });
  if (binding.mode === 'model' && !binding.model) return result('unbound', [], [], '请从模型库拖入模型类型');
  const ordinary = sceneEffectTargets(scene);
  // 旧 entityIds 仅作为迁移证据，类型匹配不再以编辑实体存在为前提。
  const {reference, ambiguous} = resolveEffectModelReference(scene, binding.model);
  if (ambiguous) {
    return result('ambiguous', [], [], '模板参考对象已指向不同资源，请重新选择模型类型');
  }
  const matches = [...ordinary, ...generated].filter(target => {
    if (binding.instanceSource && binding.instanceSource !== 'all' && target.origin !== binding.instanceSource) return false;
    if (binding.generatorId && target.generatorId !== binding.generatorId) return false;
    if (binding.mode === 'model' && (!reference || !matchesModelTypeReference({ sourcePath: target.model.sourcePath, sourceUrl: target.model.sourceUrl, dataPlatformModel: target.model.identity }, reference))) return false;
    const key = binding.instanceKey ?? 'assetCode';
    const identity = key === 'carrierAssetCode' ? target.carrierIdentity : target.identity;
    const sourceId = identity?.sourceId ?? (key === 'containerCode' ? target.carrierIdentity?.sourceId : undefined);
    const deviceType = identity?.deviceType ?? target.model.deviceType;
    const code = key === 'containerCode' ? target.containerCode : identity?.assetCode;
    return (!binding.sourceId || binding.sourceId === sourceId)
      && (!binding.deviceType || binding.deviceType.toLowerCase() === deviceType?.toLowerCase())
      && (!binding.assetCode || binding.assetCode === code);
  });
  if (!matches.length) return result('missing-target', [], [], '模型类型已绑定，等待运行时实例');
  const ready = matches.filter(t => t.state === 'ready');
  if (session.multiple) {
    if (matches.length > (binding.maxTargets ?? 32)) return result('limit', [], matches, `匹配数量 ${matches.length} 超过配置上限`);
    if (ready.length) return result('resolved', ready, matches, `已匹配 ${ready.length} 个可用目标${ready.length < matches.length ? `；${matches.length-ready.length} 个目标等待加载或恢复` : ''}`);
    return result(matches.some(t=>t.state==='error') ? 'error' : 'loading', [], matches, '等待匹配的模型加载或恢复显示');
  }
  const selected = session.selectedId ? ready.find(t => t.id === session.selectedId && (!session.lockedKey || runtimeTargetLockKey(t) === session.lockedKey)) : undefined;
  if (selected) return result('resolved', [selected], matches, '已选择运行时目标');
  const locked = session.lockedKey ? matches.filter(t => runtimeTargetLockKey(t) === session.lockedKey) : [];
  if (locked.length === 1) {
    if (locked[0].state === 'ready') return result('resolved', locked, matches, '继续跟随已锁定目标');
    return result(locked[0].state === 'error' ? 'error' : 'loading', [], matches, locked[0].message || '等待已锁定目标恢复，镜头保持当前位置');
  }
  if (session.lockedKey && locked.length === 0 && !session.lockedKey.startsWith('["runtime"')) {
    return result('missing-target', [], matches, '等待已锁定业务对象重新生成；可清除选择以重新定位');
  }
  if (matches.length > (binding.maxTargets ?? 32)) return result('limit', [], matches, `匹配数量 ${matches.length} 超过配置上限`);
  if (session.follow !== false && binding.followSelection === 'manual' || matches.length > 1) return result('ambiguous', [], matches, '请选择运行时实例，或用数据源和编号进一步限定');
  if (ready.length === 1) return result('resolved', ready, matches, '已匹配运行时目标');
  return result(matches[0].state === 'error' ? 'error' : 'loading', [], matches, matches[0].message || '等待目标模型加载或恢复显示');
}
