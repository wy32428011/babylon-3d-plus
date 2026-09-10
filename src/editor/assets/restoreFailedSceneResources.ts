import { getClickEventModelResourceKey } from '../../../electron/shared/clickEventModelIdentity';
import { collectPublishModelReferences } from '../../../electron/shared/publishModelRecovery';
import type { SceneDocument } from '../model/SceneDocument';

export type FailedSceneResources = { entityIds?: string[]; environment?: boolean };

/** 事务没有改变实体结构；按同一实体内稳定的引用次序恢复失败资源组，保留其他组及场景配置。 */
export function restoreFailedSceneResources(before: SceneDocument, current: SceneDocument, failed: FailedSceneResources): SceneDocument {
  const key = (url: unknown) => getClickEventModelResourceKey(url)?.split(':').slice(0, 2).join(':') ?? String(url ?? '');
  const failedKeys = new Set((failed.entityIds ?? []).flatMap(id => collectPublishModelReferences({ entities: {
    [id]: current.entities[id],
  } }).models.map(reference => key(reference.asset.sourceUrl))).filter(Boolean));
  if (!failedKeys.size && !failed.environment) return current;
  const next = structuredClone(current);
  let changed = false;
  const restore = (target: Record<string, unknown>, source: Record<string, unknown>) => {
    if (JSON.stringify(target) === JSON.stringify(source)) return;
    for (const field of Object.keys(target)) delete target[field];
    Object.assign(target, structuredClone(source));
    changed = true;
  };
  for (const [id, entity] of Object.entries(next.entities)) {
    const original = before.entities[id];
    if (!original) continue;
    const oldRefs = collectPublishModelReferences({ entities: { [id]: original } });
    const newRefs = collectPublishModelReferences({ entities: { [id]: entity } });
    for (let index = 0; index < newRefs.models.length; index++) {
      const reference = newRefs.models[index];
      const old = oldRefs.models[index];
      if (!old || !failedKeys.has(key(reference.asset.sourceUrl))) continue;
      restore(reference.asset, old.asset);
      if (reference.target && old.target) {
        for (const field of ['assetId', 'packagePath', 'thumbnailUrl']) {
          if (JSON.stringify(reference.target[field]) !== JSON.stringify(old.target[field])) changed = true;
          if (old.target[field] !== undefined) reference.target[field] = structuredClone(old.target[field]);
          else delete reference.target[field];
        }
      }
    }
    for (let index = 0; index < newRefs.devices.length; index++) {
      const device = newRefs.devices[index];
      if (oldRefs.devices[index] && failedKeys.has(key(device.sourceUrl))) restore(device, oldRefs.devices[index]);
    }
    if (failedKeys.has(key(entity.components.modelAsset?.sourceUrl)) && original.components.modelArrayInstance) {
      if (JSON.stringify(entity.components.modelArrayInstance) !== JSON.stringify(original.components.modelArrayInstance)) changed = true;
      entity.components.modelArrayInstance = structuredClone(original.components.modelArrayInstance);
    }
  }
  if (failed.environment && before.sceneSettings.environment
    && JSON.stringify(next.sceneSettings.environment) !== JSON.stringify(before.sceneSettings.environment)) {
    next.sceneSettings.environment = structuredClone(before.sceneSettings.environment);
    changed = true;
  }
  return changed ? next : current;
}
