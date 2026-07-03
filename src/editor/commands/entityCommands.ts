import type { Command } from './Command';
import type {
  CadReferenceComponent,
  LightComponent,
  LocatorComponent,
  MeshRendererComponent,
  ModelAssetComponent,
  TransformComponent,
} from '../model/components';
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

/** 创建一个仅用于 Hierarchy 分组的文件夹命令。 */
export function createFolderCommand(folder: Entity): Command {
  const command = createEntityCommand(folder);
  return {
    ...command,
    label: `新建文件夹 ${folder.name}`,
  };
}

export function deleteEntityCommand(entityId: string): Command {
  let previousScene: SceneDocument | null = null;

  return {
    label: '删除实体',
    execute: (scene) => {
      const entity = scene.entities[entityId];
      if (!entity) return scene;

      previousScene = scene;

      const { [entityId]: _removed, ...entities } = scene.entities;
      const normalizedEntities = Object.fromEntries(
        Object.entries(entities).map(([id, currentEntity]) => {
          const parentId = currentEntity.parentId === entityId ? null : currentEntity.parentId;
          const childrenIds = currentEntity.childrenIds.filter((childId) => childId !== entityId);

          return [
            id,
            parentId === currentEntity.parentId && childrenIds.length === currentEntity.childrenIds.length
              ? currentEntity
              : { ...currentEntity, parentId, childrenIds },
          ];
        }),
      );

      const selectedEntityId =
        scene.selectedEntityId && scene.selectedEntityId !== entityId && normalizedEntities[scene.selectedEntityId]
          ? scene.selectedEntityId
          : null;

      return {
        ...scene,
        entityIds: scene.entityIds.filter((id) => id !== entityId),
        entities: normalizedEntities,
        selectedEntityId,
      };
    },
    undo: (scene) => {
      return previousScene ?? scene;
    },
  };
}

/** 用单条可撤销命令承载批量场景结构变更，适合复制、阵列、群组等复合操作。 */
export function updateSceneDocumentCommand(
  label: string,
  updateScene: (scene: SceneDocument) => SceneDocument,
): Command {
  let previousScene: SceneDocument | null = null;

  return {
    label,
    execute: (scene) => {
      previousScene = scene;
      return updateScene(scene);
    },
    undo: (scene) => {
      return previousScene ?? scene;
    },
  };
}

/** 批量移动实体到文件夹或根层级，文件夹本身不允许被拖入其他文件夹。 */
export function moveEntitiesToFolderCommand(entityIds: string[], targetFolderId: string | null): Command {
  let previousScene: SceneDocument | null = null;

  return {
    label: targetFolderId ? '移动到文件夹' : '移动到根层级',
    execute: (scene) => {
      previousScene = scene;
      return moveEntitiesToFolder(scene, entityIds, targetFolderId);
    },
    undo: (scene) => {
      return previousScene ?? scene;
    },
  };
}

/** 更新实体显示状态，隐藏实体仍保留在场景文档中。 */
export function updateEntityVisibilityCommand(entityId: string, before: boolean, after: boolean): Command {
  return {
    label: after ? '显示实体' : '隐藏实体',
    execute: (scene) => updateEntityVisibility(scene, entityId, after),
    undo: (scene) => updateEntityVisibility(scene, entityId, before),
  };
}

/** 更新实体锁定状态，锁定后禁止场景拾取和编辑写回。 */
export function updateEntityLockCommand(entityId: string, before: boolean, after: boolean): Command {
  return {
    label: after ? '锁定实体' : '解锁实体',
    execute: (scene) => updateEntityLock(scene, entityId, after),
    undo: (scene) => updateEntityLock(scene, entityId, before),
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

export function updateLocatorCommand(entityId: string, before: LocatorComponent, after: LocatorComponent): Command {
  return {
    label: '更新定位线框',
    execute: (scene) => updateLocator(scene, entityId, after),
    undo: (scene) => updateLocator(scene, entityId, before),
  };
}

export function updateCadReferenceCommand(
  entityId: string,
  before: CadReferenceComponent,
  after: CadReferenceComponent,
): Command {
  return {
    label: '更新CAD参考图',
    execute: (scene) => updateCadReference(scene, entityId, after),
    undo: (scene) => updateCadReference(scene, entityId, before),
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

function moveEntitiesToFolder(scene: SceneDocument, entityIds: string[], targetFolderId: string | null): SceneDocument {
  const targetFolder = targetFolderId ? scene.entities[targetFolderId] : null;
  if (targetFolderId && !targetFolder?.isFolder) return scene;

  const movingIds = [...new Set(entityIds)].filter((id) => {
    const entity = scene.entities[id];
    return Boolean(entity && !entity.isFolder);
  });
  if (movingIds.length === 0) return scene;

  const movingIdSet = new Set(movingIds);
  const entities: Record<string, Entity> = { ...scene.entities };

  for (const entityId of movingIds) {
    const entity = entities[entityId];
    if (!entity) continue;
    entities[entityId] = { ...entity, parentId: targetFolderId };
  }

  for (const [entityId, entity] of Object.entries(entities)) {
    if (!entity.isFolder) continue;

    const childrenIds = entity.childrenIds.filter((childId) => !movingIdSet.has(childId));
    const nextChildrenIds =
      entityId === targetFolderId
        ? [...childrenIds, ...movingIds.filter((movingId) => !childrenIds.includes(movingId))]
        : childrenIds;

    if (nextChildrenIds.length !== entity.childrenIds.length || nextChildrenIds.some((childId, index) => childId !== entity.childrenIds[index])) {
      entities[entityId] = { ...entity, childrenIds: nextChildrenIds };
    }
  }

  return {
    ...scene,
    entities,
  };
}

export function updateModelAssetCodeCommand(entityId: string, before: string, after: string): Command {
  return {
    label: '更新资产编号',
    execute: (scene) => updateModelAssetCode(scene, entityId, after),
    undo: (scene) => updateModelAssetCode(scene, entityId, before),
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

function updateEntityVisibility(scene: SceneDocument, entityId: string, visible: boolean): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        visible,
      },
    },
  };
}

function updateEntityLock(scene: SceneDocument, entityId: string, locked: boolean): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        locked,
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

function updateLocator(scene: SceneDocument, entityId: string, locator: LocatorComponent): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity?.components.locator) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        components: {
          ...entity.components,
          locator,
        },
      },
    },
  };
}

function updateCadReference(
  scene: SceneDocument,
  entityId: string,
  cadReference: CadReferenceComponent,
): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity?.components.cadReference) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        components: {
          ...entity.components,
          cadReference,
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

function updateModelAssetCode(scene: SceneDocument, entityId: string, assetCode: ModelAssetComponent['assetCode']): SceneDocument {
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
            assetCode,
          },
        },
      },
    },
  };
}
