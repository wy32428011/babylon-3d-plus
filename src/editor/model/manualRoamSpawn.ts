import type { ManualRoamSpawnPose } from '../../runtime/roam/manualRoamCore';
import type { Entity } from './Entity';
import type { Vector3Data } from './math';
import type { SceneDocument } from './SceneDocument';

/** 按 Hierarchy 顺序查找全场唯一的手动漫游出生点。 */
export function findManualRoamSpawnEntity(scene: SceneDocument): Entity | null {
  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    if (entity?.components.manualRoamSpawn) return entity;
  }
  return null;
}

/** 场景中是否已摆放手动漫游 POI；未摆放时运行预览和 Viewer 不开放漫游功能。 */
export function hasManualRoamSpawnEntity(scene: SceneDocument): boolean {
  return findManualRoamSpawnEntity(scene) !== null;
}

/** 判断指定实体集合是否包含手动漫游出生点，供群组编辑能力统一收敛。 */
export function containsManualRoamSpawnEntity(
  scene: Pick<SceneDocument, 'entities'>,
  entityIds: readonly string[],
): boolean {
  return entityIds.some((entityId) => Boolean(scene.entities[entityId]?.components.manualRoamSpawn));
}

/** 含出生点的群组只以出生点水平朝向为 Inspector 旋转参考，避免混入其他成员的俯仰或翻滚。 */
export function resolveManualRoamGroupRotationReference(
  scene: Pick<SceneDocument, 'entities'>,
  entityIds: readonly string[],
): Vector3Data | null {
  let fallbackRotation: Vector3Data | null = null;
  for (const entityId of entityIds) {
    const entity = scene.entities[entityId];
    if (!entity) continue;
    fallbackRotation ??= { ...entity.components.transform.rotation };
    if (entity.components.manualRoamSpawn) {
      return { x: 0, y: entity.components.transform.rotation.y, z: 0 };
    }
  }
  return fallbackRotation;
}

/** 将出生点实体转换为人物脚底位置和水平朝向，忽略缩放及 X/Z 旋转。 */
export function resolveManualRoamSpawnPose(scene: SceneDocument): ManualRoamSpawnPose | null {
  const entity = findManualRoamSpawnEntity(scene);
  if (!entity) return null;
  const transform = entity.components.transform;
  return {
    position: { ...transform.position },
    yaw: transform.rotation.y,
  };
}
