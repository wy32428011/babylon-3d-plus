import type { DigitalTwinModelRecoveryResult } from '../../../electron/types';
import type { SceneDocument } from '../model/SceneDocument';

/** 仅接纳经过主进程校验的资源定位字段，保留场景原有渲染参数。 */
export function repairPublishSceneSkyboxes(scene: SceneDocument, recovery: DigitalTwinModelRecoveryResult): {
  scene: SceneDocument; restoredCount: number;
} {
  if (!recovery.skyboxReplacements?.length) return { scene, restoredCount: 0 };
  const next = structuredClone(scene);
  let restoredCount = 0;
  for (const replacement of recovery.skyboxReplacements) {
    const skybox = replacement.entityId === null
      ? next.sceneSettings.skybox
      : next.entities[replacement.entityId]?.components.skybox;
    // 与主进程序列化约定一致，旧场景允许仅保存 sourcePath。
    if (!skybox || String(skybox.sourceUrl ?? '') !== replacement.sourceUrl) {
      throw new Error('发布天空盒引用已变化，请重新恢复场景资源后发布。');
    }
    const updates: Record<string, unknown> = {};
    for (const key of ['packagePath', 'sourcePath', 'sourceUrl', 'assetRevision', 'dataPlatformResourceId', 'format']) {
      if (Object.hasOwn(replacement.skybox, key)) updates[key] = structuredClone(replacement.skybox[key]);
    }
    Object.assign(skybox, updates);
    restoredCount += 1;
  }
  return { scene: next, restoredCount };
}
