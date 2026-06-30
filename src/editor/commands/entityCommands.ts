import type { Command } from './Command';
import type { LightComponent, MeshRendererComponent, TransformComponent } from '../model/components';
import type { Entity } from '../model/Entity';
import type { ModelParameterValues } from '../model/modelParameters';
import type { SceneDocument } from '../model/SceneDocument';

export function createEntityCommand(entity: Entity): Command {
  let previousSelectedEntityId: string | null = null;

  return {
    label: `创建 ${entity.name}`,
    execute: (scene) => {
      previousSelectedEntityId = scene.selectedEntityId;

      return {
        ...scene,
        entityIds: scene.entityIds.includes(entity.id) ? scene.entityIds : [...scene.entityIds, entity.id],
        entities: { ...scene.entities, [entity.id]: entity },
        selectedEntityId: entity.id,
      };
    },
    undo: (scene) => {
      const { [entity.id]: _removed, ...entities } = scene.entities;
      const restoredSelectedEntityId =
        previousSelectedEntityId && entities[previousSelectedEntityId] ? previousSelectedEntityId : null;

      return {
        ...scene,
        entityIds: scene.entityIds.filter((id) => id !== entity.id),
        entities,
        selectedEntityId: restoredSelectedEntityId,
      };
    },
  };
}

export function deleteEntityCommand(entityId: string): Command {
  let deletedEntity: Entity | null = null;
  let previousEntityIds: string[] = [];
  let previousSelectedEntityId: string | null = null;

  return {
    label: '删除实体',
    execute: (scene) => {
      const entity = scene.entities[entityId];
      if (!entity) return scene;

      deletedEntity = entity;
      previousEntityIds = scene.entityIds;
      previousSelectedEntityId = scene.selectedEntityId;

      const { [entityId]: _removed, ...entities } = scene.entities;

      return {
        ...scene,
        entityIds: scene.entityIds.filter((id) => id !== entityId),
        entities,
        selectedEntityId: scene.selectedEntityId === entityId ? null : scene.selectedEntityId,
      };
    },
    undo: (scene) => {
      if (!deletedEntity) return scene;

      return {
        ...scene,
        entityIds: previousEntityIds,
        entities: { ...scene.entities, [deletedEntity.id]: deletedEntity },
        selectedEntityId:
          previousSelectedEntityId && (previousSelectedEntityId === deletedEntity.id || scene.entities[previousSelectedEntityId])
            ? previousSelectedEntityId
            : null,
      };
    },
  };
}

export function renameEntityCommand(entityId: string, beforeName: string, afterName: string): Command {
  return {
    label: '重命名实体',
    execute: (scene) => updateEntityName(scene, entityId, afterName),
    undo: (scene) => updateEntityName(scene, entityId, beforeName),
  };
}

export function updateTransformCommand(
  entityId: string,
  before: TransformComponent,
  after: TransformComponent,
): Command {
  return {
    label: '更新 Transform',
    execute: (scene) => updateTransform(scene, entityId, after),
    undo: (scene) => updateTransform(scene, entityId, before),
  };
}

export function updateMeshRendererCommand(
  entityId: string,
  before: MeshRendererComponent,
  after: MeshRendererComponent,
): Command {
  return {
    label: '更新材质',
    execute: (scene) => updateMeshRenderer(scene, entityId, after),
    undo: (scene) => updateMeshRenderer(scene, entityId, before),
  };
}

export function updateLightCommand(entityId: string, before: LightComponent, after: LightComponent): Command {
  return {
    label: '更新灯光',
    execute: (scene) => updateLight(scene, entityId, after),
    undo: (scene) => updateLight(scene, entityId, before),
  };
}

export function updateModelParameterValuesCommand(
  entityId: string,
  before: ModelParameterValues,
  after: ModelParameterValues,
): Command {
  return {
    label: '更新模型参数',
    execute: (scene) => updateModelParameterValues(scene, entityId, after),
    undo: (scene) => updateModelParameterValues(scene, entityId, before),
  };
}

function updateEntityName(scene: SceneDocument, entityId: string, name: string): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        name,
      },
    },
  };
}

function updateTransform(scene: SceneDocument, entityId: string, transform: TransformComponent): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        components: {
          ...entity.components,
          transform,
        },
      },
    },
  };
}

function updateMeshRenderer(scene: SceneDocument, entityId: string, meshRenderer: MeshRendererComponent): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity?.components.meshRenderer) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        components: {
          ...entity.components,
          meshRenderer,
        },
      },
    },
  };
}

function updateLight(scene: SceneDocument, entityId: string, light: LightComponent): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity?.components.light) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        components: {
          ...entity.components,
          light,
        },
      },
    },
  };
}

function updateModelParameterValues(
  scene: SceneDocument,
  entityId: string,
  parameterValues: ModelParameterValues,
): SceneDocument {
  const entity = scene.entities[entityId];
  const modelAsset = entity?.components.modelAsset;
  if (!entity || !modelAsset) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        components: {
          ...entity.components,
          modelAsset: {
            ...modelAsset,
            parameterValues,
          },
        },
      },
    },
  };
}
