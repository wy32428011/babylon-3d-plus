import type { Entity } from '../../model/Entity';
import { createFolderEntity, createLocatorEntity, type SceneDocument } from '../../model/SceneDocument';
import { vector3 } from '../../model/math';
import { deriveLocatorDimensionsFromBinding, deriveBuiltInSlotRowCountFromBinding, deriveLayerChangePlatformDimensionsFromBinding, findBuiltInSlotEntities, findLayerChangePlatformEntity, getBuiltInSlotBindingConfig, getLayerChangePlatformBindingConfig, patchBuiltInSlotDimensions, patchLayerChangePlatformDimensions, type BuiltInSlotBindingConfig, type LayerChangePlatformBindingConfig } from '../../model/builtInSlotBinding';

/** 批量设置实体显示状态，并保持场景选择引用有效。 */
export function setEntitiesVisibleInScene(scene: SceneDocument, entityIds: string[], visible: boolean): SceneDocument {
  const entities = { ...scene.entities };
  for (const entityId of entityIds) {
    const entity = entities[entityId];
    if (!entity || entity.visible === visible) continue;
    entities[entityId] = { ...entity, visible };
  }

  return { ...scene, entities };
}

/** 批量设置实体锁定状态，并保持场景选择引用有效。 */
export function setEntitiesLockedInScene(scene: SceneDocument, entityIds: string[], locked: boolean): SceneDocument {
  const entities = { ...scene.entities };
  for (const entityId of entityIds) {
    const entity = entities[entityId];
    if (!entity || entity.locked === locked) continue;
    entities[entityId] = { ...entity, locked };
  }

  return { ...scene, entities };
}

/**
 * 收集“显示被祖先隐藏的实体”时需要一并显示的隐藏祖先。
 * 图标展示的是继承后的有效显隐；只翻转实体自身无法让被文件夹隐藏的模型真正出现。
 */
export function collectVisibilityShowTargetIds(entities: Record<string, Entity>, entityId: string): string[] {
  const targetIds = [entityId];
  const visited = new Set<string>([entityId]);
  let currentId = entities[entityId]?.parentId ?? null;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = entities[currentId];
    if (!current) break;
    if (current.visible === false) targetIds.push(currentId);
    currentId = current.parentId ?? null;
  }
  return targetIds;
}

/**
 * 收集“解锁被祖先锁定的实体”时需要一并解锁的锁定祖先。
 * 与显隐按钮一致：按钮按继承后的有效锁定状态切换，否则会把子实体自身 locked 反向翻转。
 */
export function collectLockUnlockTargetIds(entities: Record<string, Entity>, entityId: string): string[] {
  const targetIds = [entityId];
  const visited = new Set<string>([entityId]);
  let currentId = entities[entityId]?.parentId ?? null;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = entities[currentId];
    if (!current) break;
    if (current.locked === true) targetIds.push(currentId);
    currentId = current.parentId ?? null;
  }
  return targetIds;
}

/** 沿被移除文件夹向上查找最近仍存在的父文件夹。 */
function resolveNearestSurvivingParentId(
  scene: SceneDocument,
  parentId: string | null,
  removedIds: ReadonlySet<string>,
): string | null {
  const visited = new Set<string>();
  let currentId = parentId;

  while (currentId && removedIds.has(currentId) && !visited.has(currentId)) {
    visited.add(currentId);
    currentId = scene.entities[currentId]?.parentId ?? null;
  }

  return currentId && scene.entities[currentId]?.isFolder ? currentId : null;
}

/** 在移除文件夹容器时按原顺序展开其内容，供删除和解组共同保持层级顺序。 */
function collectPromotedChildrenIds(
  scene: SceneDocument,
  childIds: readonly string[],
  removedIds: ReadonlySet<string>,
  targetParentId: string,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const stack = [...childIds].reverse();

  while (stack.length > 0) {
    const childId = stack.pop();
    if (!childId || visited.has(childId)) continue;
    const child = scene.entities[childId];
    if (!child) continue;
    visited.add(childId);

    if (removedIds.has(childId)) {
      if (child.isFolder) {
        for (let index = child.childrenIds.length - 1; index >= 0; index -= 1) {
          stack.push(child.childrenIds[index]);
        }
      }
      continue;
    }

    if (resolveNearestSurvivingParentId(scene, child.parentId, removedIds) === targetParentId) {
      result.push(childId);
    }
  }

  return result;
}

/**
 * 为声明了内置货格绑定的宿主实体创建第 rowIndex 排货格实体。
 * 货格与宿主同级，绑定身份记录在 builtInBinding.hostEntityId + rowIndex。调用方需先确认该排不存在。
 */
export function createBuiltInSlotEntityInScene(
  scene: SceneDocument,
  hostEntityId: string,
  config: BuiltInSlotBindingConfig,
  rowIndex: number,
): SceneDocument {
  const host = scene.entities[hostEntityId];
  if (!host) return scene;

  const slotEntity = createLocatorEntity(host.components.transform.position);
  slotEntity.name = `内置货格 第${rowIndex + 1}排`;
  slotEntity.parentId = host.parentId;
  const derived = deriveLocatorDimensionsFromBinding(config, host.components.modelAsset?.parameterValues);
  slotEntity.components.locator = {
    ...slotEntity.components.locator!,
    ...derived,
    // 排号默认与排索引对齐；之后允许用户单独调整
    rowNumber: rowIndex + 1,
    // 资产编号由宿主货架驱动，创建即对齐，之后随货架编号同步
    assetId: host.components.modelAsset?.assetCode ?? slotEntity.components.locator!.assetId,
    builtInBinding: { hostEntityId, rowIndex, originOffset: vector3() },
  };

  const hostIndex = scene.entityIds.indexOf(hostEntityId);
  const entityIds = [...scene.entityIds];
  entityIds.splice(hostIndex >= 0 ? hostIndex + 1 + rowIndex : entityIds.length, 0, slotEntity.id);

  const hostParent = host.parentId ? scene.entities[host.parentId] : null;
  return {
    ...scene,
    entityIds,
    entities: {
      ...scene.entities,
      ...(hostParent?.isFolder
        ? { [hostParent.id]: { ...hostParent, childrenIds: [...hostParent.childrenIds, slotEntity.id] } }
        : {}),
      [slotEntity.id]: slotEntity,
    },
  };
}

/**
 * 把宿主的内置货格对齐到声明的排数：未启用（或声明未启用）时删除全部货格，启用时多删少补（幂等）。
 * 已有排保留其实体身份与用户改动，只按 rowIndex 增删；末尾统一派生维度。
 */
function reconcileBuiltInSlotEntitiesInScene(
  scene: SceneDocument,
  hostEntityId: string,
  config: BuiltInSlotBindingConfig,
): SceneDocument {
  const host = scene.entities[hostEntityId];
  if (!host) return scene;

  const parameterValues = host.components.modelAsset?.parameterValues;
  const enabled = parameterValues?.[config.enabledParam] === true;
  const rowCount = enabled ? deriveBuiltInSlotRowCountFromBinding(config, parameterValues) : 0;

  const seen = new Set<number>();
  const obsoleteIds: string[] = [];
  for (const slot of findBuiltInSlotEntities(scene, hostEntityId)) {
    const rowIndex = slot.components.locator?.builtInBinding?.rowIndex ?? 0;
    if (rowIndex >= rowCount || seen.has(rowIndex)) obsoleteIds.push(slot.id);
    else seen.add(rowIndex);
  }

  let next = obsoleteIds.length > 0 ? deleteEntitiesInScene(scene, obsoleteIds) : scene;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    if (seen.has(rowIndex)) continue;
    next = createBuiltInSlotEntityInScene(next, hostEntityId, config, rowIndex);
  }
  return patchBuiltInSlotDimensions(next, hostEntityId);
}

/**
 * 宿主模型参数变化后的内置货格副作用：按启用参数与排数对账货格（幂等），并按声明派生维度。
 * 仅在提交路径调用；preview 路径只应调用 patchBuiltInSlotDimensions。
 */
export function applyBuiltInSlotSideEffects(scene: SceneDocument, hostEntityId: string): SceneDocument {
  const host = scene.entities[hostEntityId];
  const config = getBuiltInSlotBindingConfig(host);
  if (!host || !config) return scene;

  return reconcileBuiltInSlotEntitiesInScene(scene, hostEntityId, config);
}

/**
 * 为声明了换层站台绑定的宿主实体创建站台实体（固定 1 列、起始列 -1、排 1）。
 * 站台与宿主同级，绑定身份记录在 builtInBinding.hostEntityId + kind='layerChangePlatform'。
 */
export function createLayerChangePlatformEntityInScene(
  scene: SceneDocument,
  hostEntityId: string,
  config: LayerChangePlatformBindingConfig,
): SceneDocument {
  const host = scene.entities[hostEntityId];
  if (!host) return scene;

  const platformEntity = createLocatorEntity(host.components.transform.position);
  platformEntity.name = '换层站台';
  platformEntity.parentId = host.parentId;
  const derived = deriveLayerChangePlatformDimensionsFromBinding(config, host.components.modelAsset?.parameterValues);
  platformEntity.components.locator = {
    ...platformEntity.components.locator!,
    ...derived,
    columns: 1,
    startColumn: -1,
    startLayer: 1,
    rowNumber: 1,
    // 资产编号由宿主货架驱动，创建即对齐，之后随货架编号同步
    assetId: host.components.modelAsset?.assetCode ?? platformEntity.components.locator!.assetId,
    builtInBinding: { hostEntityId, rowIndex: 0, originOffset: vector3(), kind: 'layerChangePlatform' },
  };

  const hostIndex = scene.entityIds.indexOf(hostEntityId);
  const entityIds = [...scene.entityIds];
  entityIds.splice(hostIndex >= 0 ? hostIndex + 1 : entityIds.length, 0, platformEntity.id);

  const hostParent = host.parentId ? scene.entities[host.parentId] : null;
  return {
    ...scene,
    entityIds,
    entities: {
      ...scene.entities,
      ...(hostParent?.isFolder
        ? { [hostParent.id]: { ...hostParent, childrenIds: [...hostParent.childrenIds, platformEntity.id] } }
        : {}),
      [platformEntity.id]: platformEntity,
    },
  };
}

/** 换层站台对账：启用时确保存在唯一站台实体，未启用（或未声明）时删除；幂等。 */
function reconcileLayerChangePlatformEntityInScene(
  scene: SceneDocument,
  hostEntityId: string,
  config: LayerChangePlatformBindingConfig,
): SceneDocument {
  const host = scene.entities[hostEntityId];
  if (!host) return scene;

  const enabled = host.components.modelAsset?.parameterValues?.[config.enabledParam] === true;
  const existing = findLayerChangePlatformEntity(scene, hostEntityId);
  if (!enabled) {
    return existing ? deleteEntitiesInScene(scene, [existing.id]) : scene;
  }
  const next = existing ? scene : createLayerChangePlatformEntityInScene(scene, hostEntityId, config);
  return patchLayerChangePlatformDimensions(next, hostEntityId);
}

/** 宿主模型参数变化后的换层站台副作用：按启用参数对账站台（幂等），并按声明派生维度。 */
export function applyLayerChangePlatformSideEffects(scene: SceneDocument, hostEntityId: string): SceneDocument {
  const host = scene.entities[hostEntityId];
  const config = getLayerChangePlatformBindingConfig(host);
  if (!host || !config) return scene;

  return reconcileLayerChangePlatformEntityInScene(scene, hostEntityId, config);
}

/** 批量删除实体；文件夹保持非级联语义，未删除内容提升到最近仍存在的父级。 */
export function deleteEntitiesInScene(scene: SceneDocument, entityIds: string[]): SceneDocument {
  const deletingIds = new Set(entityIds.filter((entityId) => Boolean(scene.entities[entityId])));
  if (deletingIds.size === 0) return scene;

  // 内置货格是宿主模型的附属物，随宿主一并删除而非提升为孤儿实体。
  for (const entity of Object.values(scene.entities)) {
    if (deletingIds.has(entity.id)) continue;
    const hostEntityId = entity.components.locator?.builtInBinding?.hostEntityId;
    if (hostEntityId && deletingIds.has(hostEntityId)) deletingIds.add(entity.id);
  }

  // 删除阵列源时提升第一个未删除实例为新源，避免其余独立模型因悬空引用一起消失。
  const promotedSources = new Map<string, string>();
  for (const deletingId of deletingIds) {
    const deletingEntity = scene.entities[deletingId];
    if (!deletingEntity?.components.modelAsset || deletingEntity.components.modelArrayInstance) continue;
    const promoted = scene.entityIds.find((entityId) => (
      !deletingIds.has(entityId)
      && scene.entities[entityId]?.components.modelArrayInstance?.sourceEntityId === deletingId
    ));
    if (promoted) promotedSources.set(deletingId, promoted);
  }

  const entities: Record<string, Entity> = {};
  for (const [entityId, entity] of Object.entries(scene.entities)) {
    if (deletingIds.has(entityId)) continue;

    const parentId = resolveNearestSurvivingParentId(scene, entity.parentId, deletingIds);
    const childrenIds = entity.isFolder
      ? collectPromotedChildrenIds(scene, entity.childrenIds, deletingIds, entityId)
      : [];
    const promotedSourceId = entity.components.modelArrayInstance
      ? promotedSources.get(entity.components.modelArrayInstance.sourceEntityId)
      : undefined;
    let components = entity.components;
    if (promotedSources.get(entity.components.modelArrayInstance?.sourceEntityId ?? '') === entityId) {
      components = { ...entity.components };
      delete components.modelArrayInstance;
      delete components.modelArray;
    } else if (promotedSourceId) {
      components = {
        ...entity.components,
        modelArrayInstance: { sourceEntityId: promotedSourceId },
      };
    }

    const telemetryBinding = components.telemetryBinding;
    if (telemetryBinding?.cargoGeneratorId && deletingIds.has(telemetryBinding.cargoGeneratorId)) {
      components = {
        ...components,
        telemetryBinding: { ...telemetryBinding, cargoGeneratorId: undefined },
      };
    }

    const locator = components.locator;
    if (locator?.fetchDrive?.cargoGeneratorId && deletingIds.has(locator.fetchDrive.cargoGeneratorId)) {
      components = {
        ...components,
        locator: { ...locator, fetchDrive: { ...locator.fetchDrive, cargoGeneratorId: undefined } },
      };
    }

    const deviceSpawner = components.deviceSpawner;
    if (deviceSpawner?.templateEntityId && deletingIds.has(deviceSpawner.templateEntityId)) {
      components = {
        ...components,
        deviceSpawner: { ...deviceSpawner, templateEntityId: null },
      };
    }

    entities[entityId] =
      parentId === entity.parentId
      && childrenIds.length === entity.childrenIds.length
      && childrenIds.every((childId, index) => childId === entity.childrenIds[index])
      && components === entity.components
        ? entity
        : { ...entity, parentId, childrenIds, components };
  }

  const selectedReplacement = scene.selectedEntityId
    ? promotedSources.get(scene.selectedEntityId) ?? null
    : null;
  const selectedEntityId =
    scene.selectedEntityId && !deletingIds.has(scene.selectedEntityId) && entities[scene.selectedEntityId]
      ? scene.selectedEntityId
      : selectedReplacement;

  const defaultCargoGeneratorId =
    scene.sceneSettings.defaultCargoGeneratorId && deletingIds.has(scene.sceneSettings.defaultCargoGeneratorId)
      ? null
      : scene.sceneSettings.defaultCargoGeneratorId;

  return {
    ...scene,
    entityIds: scene.entityIds.filter((entityId) => !deletingIds.has(entityId)),
    entities,
    selectedEntityId,
    sceneSettings: defaultCargoGeneratorId === scene.sceneSettings.defaultCargoGeneratorId
      ? scene.sceneSettings
      : { ...scene.sceneSettings, defaultCargoGeneratorId },
  };
}

/** 插入带完整父子关系的剪贴板副本，并把独立实体挂到已有目标文件夹。 */
export function insertClipboardEntitiesInScene(
  scene: SceneDocument,
  duplicatedEntities: Entity[],
  rootEntityIds: string[],
): SceneDocument {
  const duplicatedIdSet = new Set(duplicatedEntities.map((entity) => entity.id));
  const entities: Record<string, Entity> = { ...scene.entities };
  const existingParentAdditions = new Map<string, string[]>();

  for (const entity of duplicatedEntities) {
    entities[entity.id] = entity;
    if (!entity.parentId || duplicatedIdSet.has(entity.parentId)) continue;

    const additions = existingParentAdditions.get(entity.parentId) ?? [];
    additions.push(entity.id);
    existingParentAdditions.set(entity.parentId, additions);
  }

  for (const [parentId, childIds] of existingParentAdditions.entries()) {
    const parent = entities[parentId];
    if (!parent?.isFolder) continue;
    entities[parentId] = {
      ...parent,
      childrenIds: [...parent.childrenIds, ...childIds.filter((childId) => !parent.childrenIds.includes(childId))],
    };
  }

  return {
    ...scene,
    entityIds: [...scene.entityIds, ...duplicatedEntities.map((entity) => entity.id)],
    entities,
    selectedEntityId: rootEntityIds[0] ?? scene.selectedEntityId,
  };
}

export function groupEntitiesInScene(scene: SceneDocument, entityIds: string[]): SceneDocument {
  const groupingIdSet = new Set(entityIds.filter((entityId) => {
    const entity = scene.entities[entityId];
    return Boolean(entity && !entity.isFolder);
  }));
  if (groupingIdSet.size === 0) return scene;

  const firstGroupingEntity = scene.entityIds
    .map((entityId) => scene.entities[entityId])
    .find((entity) => Boolean(entity && groupingIdSet.has(entity.id)));
  const commonParentId = firstGroupingEntity
    && [...groupingIdSet].every((entityId) => scene.entities[entityId]?.parentId === firstGroupingEntity.parentId)
      ? firstGroupingEntity.parentId
      : null;
  const orderedGroupingIds = commonParentId
    ? scene.entities[commonParentId]?.childrenIds.filter((entityId) => groupingIdSet.has(entityId)) ?? []
    : scene.entityIds.filter((entityId) => groupingIdSet.has(entityId));
  if (orderedGroupingIds.length === 0) return scene;

  const folder = {
    ...createFolderEntity(`群组 ${orderedGroupingIds.length}`),
    parentId: commonParentId,
    childrenIds: orderedGroupingIds,
  };
  const entities: Record<string, Entity> = {
    ...scene.entities,
    [folder.id]: folder,
  };

  for (const entityId of orderedGroupingIds) {
    const entity = entities[entityId];
    if (entity) entities[entityId] = { ...entity, parentId: folder.id };
  }

  for (const [entityId, entity] of Object.entries(scene.entities)) {
    if (!entity.isFolder) continue;
    const firstGroupedIndex = entity.childrenIds.findIndex((childId) => groupingIdSet.has(childId));
    const childrenIds = entity.childrenIds.filter((childId) => !groupingIdSet.has(childId));
    if (entityId === commonParentId) {
      childrenIds.splice(firstGroupedIndex >= 0 ? firstGroupedIndex : childrenIds.length, 0, folder.id);
    }
    if (
      childrenIds.length !== entity.childrenIds.length
      || childrenIds.some((childId, index) => childId !== entity.childrenIds[index])
    ) {
      entities[entityId] = { ...entity, childrenIds };
    }
  }

  return {
    ...scene,
    entityIds: [...scene.entityIds, folder.id],
    entities,
    selectedEntityId: folder.id,
  };
}

/** 解组文件夹：只移除文件夹容器，直属内容按原顺序提升到原父级。 */
export function ungroupFoldersInScene(scene: SceneDocument, folderIds: string[]): SceneDocument {
  const ungroupingIds = new Set(
    folderIds.filter((folderId) => scene.entities[folderId]?.isFolder),
  );
  if (ungroupingIds.size === 0) return scene;

  const entities: Record<string, Entity> = {};
  let selectedEntityId: string | null = null;

  for (const [entityId, entity] of Object.entries(scene.entities)) {
    if (ungroupingIds.has(entityId)) continue;
    const parentId = resolveNearestSurvivingParentId(scene, entity.parentId, ungroupingIds);
    const childrenIds = entity.isFolder
      ? collectPromotedChildrenIds(scene, entity.childrenIds, ungroupingIds, entityId)
      : [];
    if (selectedEntityId === null && parentId !== entity.parentId) selectedEntityId = entityId;
    entities[entityId] =
      parentId === entity.parentId
      && childrenIds.length === entity.childrenIds.length
      && childrenIds.every((childId, index) => childId === entity.childrenIds[index])
        ? entity
        : { ...entity, parentId, childrenIds };
  }

  return {
    ...scene,
    entityIds: scene.entityIds.filter((entityId) => !ungroupingIds.has(entityId)),
    entities,
    selectedEntityId,
  };
}
