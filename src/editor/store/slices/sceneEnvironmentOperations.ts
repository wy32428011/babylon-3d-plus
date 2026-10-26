import type { Entity } from '../../model/Entity';
import { createSkyboxComponent, createSkyboxEntity, getSceneSkyboxEntity, type SceneSkyboxSettings, type SceneDocument } from '../../model/SceneDocument';
import { normalizeTransformForEntity } from './entityValueOperations';
import { deleteEntitiesInScene } from './sceneHierarchyOperations';

export function isSceneSkyboxEqual(left: SceneSkyboxSettings | null, right: SceneSkyboxSettings | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type UpsertSkyboxEntityOptions = { revealEntity?: boolean; selectEntity: boolean };

/** 无限远背景与用户相机距离无关，只清除旧扁平配置镜像。 */
export function createSceneSettingsWithSkybox(scene: SceneDocument): SceneDocument['sceneSettings'] {
  return { ...scene.sceneSettings, skybox: null };
}

/** 更新唯一天空配置；旧位置和缩放只保留数据，不再把拖放点作为球心。 */
export function upsertSkyboxEntityInScene(scene: SceneDocument, skybox: SceneSkyboxSettings,
  options: UpsertSkyboxEntityOptions): { scene: SceneDocument; entityId: string; created: boolean } {
  const existing = getSceneSkyboxEntity(scene);
  if (!existing) {
    const entity = createSkyboxEntity(skybox);
    return {
      entityId: entity.id, created: true,
      scene: { ...scene, entityIds: [...scene.entityIds, entity.id], entities: { ...scene.entities, [entity.id]: entity },
        selectedEntityId: options.selectEntity ? entity.id : scene.selectedEntityId, sceneSettings: createSceneSettingsWithSkybox(scene) },
    };
  }
  const transform = normalizeTransformForEntity(existing, existing.components.transform);
  transform.rotation.y = skybox.rotationDegrees * Math.PI / 180;
  const updatedEntity: Entity = { ...existing, visible: options.revealEntity ? true : existing.visible,
    components: { ...existing.components, transform, skybox: createSkyboxComponent(skybox) } };
  return {
    entityId: existing.id, created: false,
    scene: { ...scene, entities: { ...scene.entities, [existing.id]: updatedEntity },
      selectedEntityId: options.selectEntity ? existing.id : scene.selectedEntityId, sceneSettings: createSceneSettingsWithSkybox(scene) },
  };
}

/** 删除唯一天空配置，并清除旧扁平兼容字段。 */
export function removeSkyboxEntitiesFromScene(scene: SceneDocument): SceneDocument {
  const skyboxEntityIds = scene.entityIds.filter((entityId) => Boolean(scene.entities[entityId]?.components.skybox));
  const withoutEntities = skyboxEntityIds.length > 0 ? deleteEntitiesInScene(scene, skyboxEntityIds) : scene;
  if (!withoutEntities.sceneSettings.skybox) return withoutEntities;
  return { ...withoutEntities, sceneSettings: { ...withoutEntities.sceneSettings, skybox: null } };
}
