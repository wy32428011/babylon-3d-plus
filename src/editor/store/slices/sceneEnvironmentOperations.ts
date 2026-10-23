import type { Entity } from '../../model/Entity';
import { createSkyboxComponent, createSkyboxEntity, getSceneSkyboxEntity, sanitizeSceneViewDistance, SCENE_SKYBOX_VIEW_DISTANCE_MIN, type SceneSkyboxSettings, type SceneDocument } from '../../model/SceneDocument';
import type { Vector3Data } from '../../model/math';
import { sanitizeVector3, normalizeTransformForEntity } from './entityValueOperations';
import { deleteEntitiesInScene } from './sceneHierarchyOperations';

export function isSceneSkyboxEqual(left: SceneSkyboxSettings | null, right: SceneSkyboxSettings | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type UpsertSkyboxEntityOptions = {
  placementPosition?: Vector3Data;
  revealEntity?: boolean;
  selectEntity: boolean;
};

/** 创建启用天空盒后的场景设置，并把相机距离提升到 12 km 安全下限。 */
export function createSceneSettingsWithSkybox(scene: SceneDocument): SceneDocument['sceneSettings'] {
  return {
    ...scene.sceneSettings,
    camera: {
      ...scene.sceneSettings.camera,
      viewDistance: sanitizeSceneViewDistance(
        scene.sceneSettings.camera.viewDistance,
        SCENE_SKYBOX_VIEW_DISTANCE_MIN,
      ),
    },
    skybox: null,
  };
}

/** 在场景中创建或更新唯一球形天空盒实体，并清除旧 sceneSettings.skybox 镜像。 */
export function upsertSkyboxEntityInScene(
  scene: SceneDocument,
  skybox: SceneSkyboxSettings,
  options: UpsertSkyboxEntityOptions,
): { scene: SceneDocument; entityId: string; created: boolean } {
  const existing = getSceneSkyboxEntity(scene);
  const placementPosition = options.placementPosition
    ? sanitizeVector3(options.placementPosition)
    : undefined;

  if (!existing) {
    const entity = createSkyboxEntity(skybox, placementPosition);
    return {
      entityId: entity.id,
      created: true,
      scene: {
        ...scene,
        entityIds: [...scene.entityIds, entity.id],
        entities: { ...scene.entities, [entity.id]: entity },
        selectedEntityId: options.selectEntity ? entity.id : scene.selectedEntityId,
        sceneSettings: createSceneSettingsWithSkybox(scene),
      },
    };
  }

  const transform = normalizeTransformForEntity(existing, existing.components.transform);
  transform.rotation.y = skybox.rotationDegrees * Math.PI / 180;
  if (placementPosition) transform.position = placementPosition;
  const updatedEntity: Entity = {
    ...existing,
    visible: options.revealEntity ? true : existing.visible,
    components: {
      ...existing.components,
      transform,
      skybox: createSkyboxComponent(skybox),
    },
  };
  return {
    entityId: existing.id,
    created: false,
    scene: {
      ...scene,
      entities: { ...scene.entities, [existing.id]: updatedEntity },
      selectedEntityId: options.selectEntity ? existing.id : scene.selectedEntityId,
      sceneSettings: createSceneSettingsWithSkybox(scene),
    },
  };
}

/** 删除场景中的球形天空盒实体，同时清除旧场景级兼容字段。 */
export function removeSkyboxEntitiesFromScene(scene: SceneDocument): SceneDocument {
  const skyboxEntityIds = scene.entityIds.filter((entityId) => Boolean(scene.entities[entityId]?.components.skybox));
  const withoutEntities = skyboxEntityIds.length > 0 ? deleteEntitiesInScene(scene, skyboxEntityIds) : scene;
  if (!withoutEntities.sceneSettings.skybox) return withoutEntities;
  return {
    ...withoutEntities,
    sceneSettings: { ...withoutEntities.sceneSettings, skybox: null },
  };
}
