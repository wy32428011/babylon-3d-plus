import type { Command } from './Command';
import { executeCommand, type CommandHistory } from './CommandHistory';
import type {
  AutoPatrolComponent,
  CadReferenceComponent,
  LightComponent,
  LocatorComponent,
  MeshRendererComponent,
  ModelAssetComponent,
  ModelGeneratorComponent,
  PoiEffectComponent,
  TransformComponent,
} from '../model/components';
import type { TelemetryBindingComponent } from '../model/telemetryBinding';
import { findBuiltInSlotEntityId } from '../model/builtInSlotBinding';
import type { Entity } from '../model/Entity';
import {
  getTopLevelHierarchyEntityIds,
  isEntityAncestorOf,
  resolveFolderGroupMoveSelection,
  resolveHierarchyGroupTransformSelection,
} from '../model/entityHierarchy';
import type { ModelParameterValues } from '../model/modelParameters';
import type { Vector3Data } from '../model/math';
import type { SceneDocument, SceneEnvironmentSettings } from '../model/SceneDocument';

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

/** 创建一个仅用于 Hierarchy 分组的文件夹命令，可直接挂到任意可用父文件夹。 */
export function createFolderCommand(folder: Entity, parentId: string | null = folder.parentId): Command {
  let previousScene: SceneDocument | null = null;

  return {
    label: `新建文件夹 ${folder.name}`,
    execute: (scene) => {
      const parent = parentId ? scene.entities[parentId] : null;
      const resolvedParentId = parent?.isFolder ? parent.id : null;
      const entities: Record<string, Entity> = {
        ...scene.entities,
        [folder.id]: { ...folder, parentId: resolvedParentId },
      };

      if (resolvedParentId && parent) {
        entities[resolvedParentId] = {
          ...parent,
          childrenIds: parent.childrenIds.includes(folder.id)
            ? parent.childrenIds
            : [...parent.childrenIds, folder.id],
        };
      }

      previousScene = scene;
      return {
        ...scene,
        entityIds: scene.entityIds.includes(folder.id) ? scene.entityIds : [...scene.entityIds, folder.id],
        entities,
        selectedEntityId: folder.id,
      };
    },
    undo: (scene) => previousScene ?? scene,
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
          const parentId = currentEntity.parentId === entityId ? entity.parentId : currentEntity.parentId;
          const childrenIds = currentEntity.isFolder
            ? currentEntity.childrenIds.flatMap((childId) => (
                childId === entityId ? entity.childrenIds : [childId]
              ))
            : [];

          return [
            id,
            parentId === currentEntity.parentId
            && childrenIds.length === currentEntity.childrenIds.length
            && childrenIds.every((childId, index) => childId === currentEntity.childrenIds[index])
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

/** 用显式 before/after 环境快照提交场景级环境修改，支持 Gizmo 预览后的可靠撤销。 */
export function updateSceneEnvironmentCommand(
  label: string,
  before: SceneEnvironmentSettings | null,
  after: SceneEnvironmentSettings | null,
): Command {
  const replaceEnvironment = (
    scene: SceneDocument,
    environment: SceneEnvironmentSettings | null,
  ): SceneDocument => ({
    ...scene,
    sceneSettings: {
      ...scene.sceneSettings,
      environment,
    },
  });

  return {
    label,
    execute: (scene) => replaceEnvironment(scene, after),
    undo: (scene) => replaceEnvironment(scene, before),
  };
}

/** 批量移动实体或完整文件夹子树到目标文件夹/根层级，并拒绝形成层级循环。 */
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

export type HierarchyGroupTranslationInput = {
  sourceSceneDocument: SceneDocument;
  groupId: string;
  entityIds: string[];
  beforePositions: Record<string, Vector3Data>;
  delta: Vector3Data;
};

export type HierarchyGroupTransformResult = {
  committed: boolean;
  scene: SceneDocument;
  history: CommandHistory;
  message: string;
};

export type HierarchyGroupRotationInput = {
  sourceSceneDocument: SceneDocument;
  groupId: string;
  entityIds: string[];
  beforeTransforms: Record<string, TransformComponent>;
  afterTransforms: Record<string, TransformComponent>;
};

export type FolderGroupTranslationInput = {
  sourceSceneDocument: SceneDocument;
  folderId: string;
  entityIds: string[];
  beforePositions: Record<string, Vector3Data>;
  delta: Vector3Data;
};

export type FolderGroupTranslationResult = HierarchyGroupTransformResult;

export type FolderGroupRotationInput = {
  sourceSceneDocument: SceneDocument;
  folderId: string;
  entityIds: string[];
  beforeTransforms: Record<string, TransformComponent>;
  afterTransforms: Record<string, TransformComponent>;
};

export type FolderGroupRotationResult = HierarchyGroupTransformResult;

/** 在写入历史前重新校验任意 Hierarchy 群组选区、锁定状态与位置基线。 */
export function commitHierarchyGroupTranslation(
  scene: SceneDocument,
  history: CommandHistory,
  hierarchySelectionIds: readonly string[],
  input: HierarchyGroupTranslationInput,
): HierarchyGroupTransformResult {
  if (scene !== input.sourceSceneDocument) {
    return { committed: false, scene, history, message: '场景已变化，已取消选区群组移动。' };
  }
  if (![input.delta.x, input.delta.y, input.delta.z].every(Number.isFinite)) {
    return { committed: false, scene, history, message: '选区群组移动失败：位移无效。' };
  }

  const selection = resolveHierarchyGroupTransformSelection(scene, hierarchySelectionIds);
  if (selection.status !== 'ready') {
    const message = selection.status === 'blocked'
      ? '选区群组移动已阻止：选区内包含锁定对象。'
      : selection.status === 'empty'
        ? '选区群组移动已取消：选区内没有可移动对象。'
        : '选区群组移动已取消：当前不再是多选或文件夹选区。';
    return { committed: false, scene, history, message };
  }
  if (selection.groupId !== input.groupId || !areStringArraysEqual(selection.entityIds, input.entityIds)) {
    return { committed: false, scene, history, message: '选区成员已变化，已取消群组移动。' };
  }
  if (!selection.entityIds.every((entityId) => (
    areVector3DataEqual(selection.beforePositions[entityId], input.beforePositions[entityId])
  ))) {
    return { committed: false, scene, history, message: '对象位置已变化，已取消过期的群组移动。' };
  }
  if (input.delta.x === 0 && input.delta.y === 0 && input.delta.z === 0) {
    return { committed: false, scene, history, message: '选区位置未变化。' };
  }

  const translation = resolveTranslatedEntityPositions(
    selection.entityIds,
    selection.beforePositions,
    input.delta,
  );
  if (!translation.ok) {
    return {
      committed: false,
      scene,
      history,
      message: `选区群组移动失败：${translation.error}。`,
    };
  }
  if (!translation.changed) {
    return { committed: false, scene, history, message: '选区位置未变化。' };
  }

  const result = executeCommand(
    scene,
    history,
    createEntityPositionsCommand(selection.entityIds, selection.beforePositions, translation.afterPositions),
  );
  return {
    committed: true,
    ...result,
    message: `移动选中对象：${selection.entityIds.length} 个对象`,
  };
}

/** 在写入历史前重新校验任意 Hierarchy 群组选区与完整 Transform 基线。 */
export function commitHierarchyGroupRotation(
  scene: SceneDocument,
  history: CommandHistory,
  hierarchySelectionIds: readonly string[],
  input: HierarchyGroupRotationInput,
): HierarchyGroupTransformResult {
  if (scene !== input.sourceSceneDocument) {
    return { committed: false, scene, history, message: '场景已变化，已取消选区群组旋转。' };
  }

  const selection = resolveHierarchyGroupTransformSelection(scene, hierarchySelectionIds);
  if (selection.status !== 'ready') {
    const message = selection.status === 'blocked'
      ? '选区群组旋转已阻止：选区内包含锁定对象。'
      : selection.status === 'empty'
        ? '选区群组旋转已取消：选区内没有可旋转对象。'
        : '选区群组旋转已取消：当前不再是多选或文件夹选区。';
    return { committed: false, scene, history, message };
  }
  if (selection.groupId !== input.groupId || !areStringArraysEqual(selection.entityIds, input.entityIds)) {
    return { committed: false, scene, history, message: '选区成员已变化，已取消群组旋转。' };
  }

  const afterTransforms: Record<string, TransformComponent> = {};
  let changed = false;
  for (const entityId of selection.entityIds) {
    const current = selection.beforeTransforms[entityId];
    const before = input.beforeTransforms[entityId];
    const after = input.afterTransforms[entityId];
    if (!areTransformDataEqual(current, before)) {
      return { committed: false, scene, history, message: '对象 Transform 已变化，已取消过期的群组旋转。' };
    }
    if (!isFiniteTransformData(after)) {
      return { committed: false, scene, history, message: `选区群组旋转失败：对象 ${entityId} 的目标 Transform 无效。` };
    }
    if (!areVector3DataEqual(before.scale, after.scale)) {
      return { committed: false, scene, history, message: '选区群组旋转失败：旋转不得改变对象缩放。' };
    }

    afterTransforms[entityId] = cloneTransformData(after);
    changed = changed || !areTransformDataNearlyEqual(before, after);
  }
  if (!changed) {
    return { committed: false, scene, history, message: '选区旋转未变化。' };
  }

  const result = executeCommand(
    scene,
    history,
    createEntityTransformsCommand(
      selection.entityIds,
      input.beforeTransforms,
      afterTransforms,
      '旋转选中对象',
    ),
  );
  return {
    committed: true,
    ...result,
    message: `旋转选中对象：${selection.entityIds.length} 个对象`,
  };
}

/** 保留单文件夹调用契约，并委托给通用 Hierarchy 群组移动提交。 */
export function commitFolderGroupTranslation(
  scene: SceneDocument,
  history: CommandHistory,
  hierarchySelectionIds: readonly string[],
  input: FolderGroupTranslationInput,
): FolderGroupTranslationResult {
  if (scene !== input.sourceSceneDocument) {
    return { committed: false, scene, history, message: '场景已变化，已取消文件夹整组移动。' };
  }

  const folderSelection = resolveFolderGroupMoveSelection(scene, hierarchySelectionIds);
  if (folderSelection.status !== 'ready') {
    const message = folderSelection.status === 'blocked'
      ? '文件夹整组移动已阻止：文件夹内包含锁定对象。'
      : folderSelection.status === 'empty'
        ? '文件夹整组移动已取消：文件夹内没有可移动对象。'
        : '文件夹整组移动已取消：当前不再是单文件夹选区。';
    return { committed: false, scene, history, message };
  }
  if (folderSelection.folderId !== input.folderId || !areStringArraysEqual(folderSelection.entityIds, input.entityIds)) {
    return { committed: false, scene, history, message: '文件夹成员已变化，已取消整组移动。' };
  }

  const selection = resolveHierarchyGroupTransformSelection(scene, hierarchySelectionIds);
  if (selection.status !== 'ready') {
    return { committed: false, scene, history, message: '文件夹整组移动已取消：没有可移动对象。' };
  }
  return commitHierarchyGroupTranslation(scene, history, hierarchySelectionIds, {
    sourceSceneDocument: input.sourceSceneDocument,
    groupId: selection.groupId,
    entityIds: input.entityIds,
    beforePositions: input.beforePositions,
    delta: input.delta,
  });
}

/** 保留单文件夹调用契约，并委托给通用 Hierarchy 群组旋转提交。 */
export function commitFolderGroupRotation(
  scene: SceneDocument,
  history: CommandHistory,
  hierarchySelectionIds: readonly string[],
  input: FolderGroupRotationInput,
): FolderGroupRotationResult {
  if (scene !== input.sourceSceneDocument) {
    return { committed: false, scene, history, message: '场景已变化，已取消文件夹整组旋转。' };
  }

  const folderSelection = resolveFolderGroupMoveSelection(scene, hierarchySelectionIds);
  if (folderSelection.status !== 'ready') {
    const message = folderSelection.status === 'blocked'
      ? '文件夹整组旋转已阻止：文件夹内包含锁定对象。'
      : folderSelection.status === 'empty'
        ? '文件夹整组旋转已取消：文件夹内没有可旋转对象。'
        : '文件夹整组旋转已取消：当前不再是单文件夹选区。';
    return { committed: false, scene, history, message };
  }
  if (folderSelection.folderId !== input.folderId || !areStringArraysEqual(folderSelection.entityIds, input.entityIds)) {
    return { committed: false, scene, history, message: '文件夹成员已变化，已取消整组旋转。' };
  }

  const selection = resolveHierarchyGroupTransformSelection(scene, hierarchySelectionIds);
  if (selection.status !== 'ready') {
    return { committed: false, scene, history, message: '文件夹整组旋转已取消：没有可旋转对象。' };
  }
  return commitHierarchyGroupRotation(scene, history, hierarchySelectionIds, {
    sourceSceneDocument: input.sourceSceneDocument,
    groupId: selection.groupId,
    entityIds: input.entityIds,
    beforeTransforms: input.beforeTransforms,
    afterTransforms: input.afterTransforms,
  });
}

/** 把同一世界位移原子写入多个实体位置，整组只占用一条撤销历史。 */
export function translateEntityPositionsCommand(
  entityIds: readonly string[],
  beforePositions: Readonly<Record<string, Vector3Data>>,
  delta: Vector3Data,
): Command {
  const translation = resolveTranslatedEntityPositions(entityIds, beforePositions, delta);
  if (!translation.ok) throw new Error(`文件夹整组移动数值无效：${translation.error}。`);
  return createEntityPositionsCommand(entityIds, beforePositions, translation.afterPositions);
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

/** 使用单条可撤销命令替换 POI EFF 配置。 */
export function updatePoiEffectCommand(
  entityId: string,
  before: PoiEffectComponent,
  after: PoiEffectComponent,
  label = '更新 EFF 特效',
): Command {
  return {
    label,
    execute: (scene) => updatePoiEffect(scene, entityId, after),
    undo: (scene) => updatePoiEffect(scene, entityId, before),
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

/** 更新模型生成器完整配置，所有 Inspector 编辑都通过同一条可撤销命令提交。 */
export function updateModelGeneratorCommand(
  entityId: string,
  before: ModelGeneratorComponent,
  after: ModelGeneratorComponent,
  label = '更新模型生成器',
): Command {
  return {
    label,
    execute: (scene) => updateModelGenerator(scene, entityId, after),
    undo: (scene) => updateModelGenerator(scene, entityId, before),
  };
}

function moveEntitiesToFolder(scene: SceneDocument, entityIds: string[], targetFolderId: string | null): SceneDocument {
  const targetFolder = targetFolderId ? scene.entities[targetFolderId] : null;
  if (targetFolderId && !targetFolder?.isFolder) return scene;

  const topLevelMovingIds = getTopLevelHierarchyEntityIds(scene.entities, entityIds);
  if (topLevelMovingIds.length === 0) return scene;
  if (
    targetFolderId
    && topLevelMovingIds.some((entityId) => (
      entityId === targetFolderId
      || isEntityAncestorOf(scene.entities, entityId, targetFolderId)
    ))
  ) {
    return scene;
  }

  const movingIds = topLevelMovingIds.filter((entityId) => scene.entities[entityId]?.parentId !== targetFolderId);
  if (movingIds.length === 0) return scene;

  const movingIdSet = new Set(movingIds);
  const entities: Record<string, Entity> = { ...scene.entities };

  for (const [entityId, entity] of Object.entries(entities)) {
    if (!entity.isFolder) continue;
    const childrenIds = entity.childrenIds.filter((childId) => !movingIdSet.has(childId));
    if (childrenIds.length !== entity.childrenIds.length) {
      entities[entityId] = { ...entity, childrenIds };
    }
  }

  for (const entityId of movingIds) {
    const entity = entities[entityId];
    if (entity) entities[entityId] = { ...entity, parentId: targetFolderId };
  }

  if (targetFolderId) {
    const currentTarget = entities[targetFolderId];
    if (!currentTarget?.isFolder) return scene;
    entities[targetFolderId] = {
      ...currentTarget,
      childrenIds: [
        ...currentTarget.childrenIds,
        ...movingIds.filter((entityId) => !currentTarget.childrenIds.includes(entityId)),
      ],
    };
  }

  return { ...scene, entities };
}

export function updateModelAssetCodeCommand(entityId: string, before: string, after: string): Command {
  return {
    label: '更新资产编号',
    execute: (scene) => updateModelAssetCode(scene, entityId, after),
    undo: (scene) => updateModelAssetCode(scene, entityId, before),
  };
}

type TranslatedEntityPositionsResult = {
  ok: true;
  afterPositions: Record<string, Vector3Data>;
  changed: boolean;
} | {
  ok: false;
  error: string;
};

/** 预先计算整组目标位置，任何缺失、溢出或不可表示位移都会原子失败。 */
function resolveTranslatedEntityPositions(
  entityIds: readonly string[],
  beforePositions: Readonly<Record<string, Vector3Data>>,
  delta: Vector3Data,
): TranslatedEntityPositionsResult {
  if (![delta.x, delta.y, delta.z].every(Number.isFinite)) {
    return { ok: false, error: '位移不是有限数值' };
  }

  const afterPositions: Record<string, Vector3Data> = {};
  let changed = false;
  for (const entityId of [...new Set(entityIds)]) {
    const before = beforePositions[entityId];
    if (!before || ![before.x, before.y, before.z].every(Number.isFinite)) {
      return { ok: false, error: `对象 ${entityId} 的位置基线无效` };
    }

    const after = {
      x: before.x + delta.x,
      y: before.y + delta.y,
      z: before.z + delta.z,
    };
    if (![after.x, after.y, after.z].every(Number.isFinite)) {
      return { ok: false, error: `对象 ${entityId} 的目标位置超出有效数值范围` };
    }
    if (
      (delta.x !== 0 && after.x === before.x)
      || (delta.y !== 0 && after.y === before.y)
      || (delta.z !== 0 && after.z === before.z)
    ) {
      return { ok: false, error: `对象 ${entityId} 的位移小于当前坐标可表示精度` };
    }

    afterPositions[entityId] = after;
    changed = changed || !areVector3DataEqual(before, after);
  }
  return { ok: true, afterPositions, changed };
}

function createEntityPositionsCommand(
  entityIds: readonly string[],
  beforePositions: Readonly<Record<string, Vector3Data>>,
  afterPositions: Readonly<Record<string, Vector3Data>>,
): Command {
  const uniqueEntityIds = [...new Set(entityIds)];
  return {
    label: '移动选中对象',
    execute: (scene) => updateEntityPositions(scene, uniqueEntityIds, afterPositions),
    undo: (scene) => updateEntityPositions(scene, uniqueEntityIds, beforePositions),
  };
}

function createEntityTransformsCommand(
  entityIds: readonly string[],
  beforeTransforms: Readonly<Record<string, TransformComponent>>,
  afterTransforms: Readonly<Record<string, TransformComponent>>,
  label: string,
): Command {
  const uniqueEntityIds = [...new Set(entityIds)];
  const beforeSnapshots: Record<string, TransformComponent> = {};
  const afterSnapshots: Record<string, TransformComponent> = {};
  for (const entityId of uniqueEntityIds) {
    const before = beforeTransforms[entityId];
    const after = afterTransforms[entityId];
    if (before) beforeSnapshots[entityId] = cloneTransformData(before);
    if (after) afterSnapshots[entityId] = cloneTransformData(after);
  }
  return {
    label,
    execute: (scene) => updateEntityTransforms(scene, uniqueEntityIds, afterSnapshots),
    undo: (scene) => updateEntityTransforms(scene, uniqueEntityIds, beforeSnapshots),
  };
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function areVector3DataEqual(left: Vector3Data | undefined, right: Vector3Data | undefined): boolean {
  return Boolean(left && right && left.x === right.x && left.y === right.y && left.z === right.z);
}

function isFiniteTransformData(value: TransformComponent | undefined): value is TransformComponent {
  return Boolean(
    value
    && [
      value.position.x, value.position.y, value.position.z,
      value.rotation.x, value.rotation.y, value.rotation.z,
      value.scale.x, value.scale.y, value.scale.z,
    ].every(Number.isFinite),
  );
}

function areTransformDataEqual(
  left: TransformComponent | undefined,
  right: TransformComponent | undefined,
): boolean {
  return Boolean(
    left
    && right
    && areVector3DataEqual(left.position, right.position)
    && areVector3DataEqual(left.rotation, right.rotation)
    && areVector3DataEqual(left.scale, right.scale),
  );
}

function areTransformDataNearlyEqual(left: TransformComponent, right: TransformComponent): boolean {
  return [
    Math.abs(left.position.x - right.position.x),
    Math.abs(left.position.y - right.position.y),
    Math.abs(left.position.z - right.position.z),
    Math.abs(left.rotation.x - right.rotation.x),
    Math.abs(left.rotation.y - right.rotation.y),
    Math.abs(left.rotation.z - right.rotation.z),
  ].every((difference) => difference <= 1e-9);
}

function cloneTransformData(transform: TransformComponent): TransformComponent {
  return {
    position: { ...transform.position },
    rotation: { ...transform.rotation },
    scale: { ...transform.scale },
  };
}

function updateEntityPositions(
  scene: SceneDocument,
  entityIds: readonly string[],
  positions: Readonly<Record<string, Vector3Data>>,
): SceneDocument {
  let changed = false;
  const entities: Record<string, Entity> = { ...scene.entities };

  for (const entityId of entityIds) {
    const entity = scene.entities[entityId];
    const position = positions[entityId];
    if (!entity || entity.isFolder || !position) continue;
    const current = entity.components.transform.position;
    if (current.x === position.x && current.y === position.y && current.z === position.z) continue;

    changed = true;
    entities[entityId] = {
      ...entity,
      components: {
        ...entity.components,
        transform: {
          ...entity.components.transform,
          position: { x: position.x, y: position.y, z: position.z },
        },
      },
    };
  }

  return changed ? { ...scene, entities } : scene;
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

function updateEntityTransforms(
  scene: SceneDocument,
  entityIds: readonly string[],
  transforms: Readonly<Record<string, TransformComponent>>,
): SceneDocument {
  let changed = false;
  const entities: Record<string, Entity> = { ...scene.entities };

  for (const entityId of entityIds) {
    const entity = scene.entities[entityId];
    const transform = transforms[entityId];
    if (!entity || entity.isFolder || !transform) continue;
    if (areTransformDataEqual(entity.components.transform, transform)) continue;

    changed = true;
    entities[entityId] = {
      ...entity,
      components: {
        ...entity.components,
        transform: cloneTransformData(transform),
      },
    };
  }

  return changed ? { ...scene, entities } : scene;
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

/** 将自动巡检组件替换为已校验的不可变快照。 */
function updateAutoPatrol(scene: SceneDocument, entityId: string, autoPatrol: AutoPatrolComponent): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity?.components.autoPatrol) return scene;
  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        components: { ...entity.components, autoPatrol },
      },
    },
  };
}

export function updateAutoPatrolCommand(
  entityId: string,
  before: AutoPatrolComponent,
  after: AutoPatrolComponent,
  label = '更新自动巡检',
): Command {
  return {
    label,
    execute: (scene) => updateAutoPatrol(scene, entityId, after),
    undo: (scene) => updateAutoPatrol(scene, entityId, before),
  };
}

/** 将实体的 POI EFF 组件替换为已校验快照。 */
function updatePoiEffect(scene: SceneDocument, entityId: string, poiEffect: PoiEffectComponent): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity?.components.poiEffect) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        components: {
          ...entity.components,
          poiEffect,
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


/** 更新实体遥测绑定组件，支持设置覆盖或清空回默认。 */
function updateTelemetryBinding(
  scene: SceneDocument,
  entityId: string,
  telemetryBinding: TelemetryBindingComponent | null,
): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity?.components.modelAsset) return scene;
  const components = { ...entity.components };
  if (telemetryBinding) components.telemetryBinding = telemetryBinding;
  else delete components.telemetryBinding;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        components,
      },
    },
  };
}

export function updateTelemetryBindingCommand(
  entityId: string,
  before: TelemetryBindingComponent | null,
  after: TelemetryBindingComponent | null,
): Command {
  return {
    label: '更新数据驱动绑定',
    execute: (scene) => updateTelemetryBinding(scene, entityId, after),
    undo: (scene) => updateTelemetryBinding(scene, entityId, before),
  };
}

/** 将模型生成器组件替换为已校验的不可变快照。 */
function updateModelGenerator(
  scene: SceneDocument,
  entityId: string,
  modelGenerator: ModelGeneratorComponent,
): SceneDocument {
  const entity = scene.entities[entityId];
  if (!entity?.components.modelGenerator) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        components: {
          ...entity.components,
          modelGenerator,
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

  const entities: SceneDocument['entities'] = {
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
  };

  // 内置货格的资产编号由宿主货架驱动，随货架编号在同一命令内同步，undo 一并回滚
  const slotEntityId = findBuiltInSlotEntityId(scene, entityId);
  const slotEntity = slotEntityId ? entities[slotEntityId] : null;
  const slotLocator = slotEntity?.components.locator;
  if (slotEntity && slotLocator && slotLocator.assetId !== assetCode) {
    entities[slotEntity.id] = {
      ...slotEntity,
      components: { ...slotEntity.components, locator: { ...slotLocator, assetId: assetCode } },
    };
  }

  return { ...scene, entities };
}
