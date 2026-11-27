import { createId } from '../../../shared/ids';
import type { Entity } from '../../model/Entity';
import { collectEntitySubtreeIds, getTopLevelHierarchyEntityIds } from '../../model/entityHierarchy';
import { createModelAssetCode, extractModelAssetCodePrefix, type SceneDocument } from '../../model/SceneDocument';
import type { Vector3Data } from '../../model/math';
import { cloneAutoPatrolComponent } from '../../model/autoPatrolInspection';
import { cloneModelGeneratorComponent } from '../../model/modelGenerator';
import { cloneInspectionWithoutDevice } from '../../model/inspectionBinding';
import { cloneClickEventBindingComponent } from '../../model/clickEventBinding';
import { cloneJsonValue, cloneTransform, cloneMeshRenderer, cloneLocator, cloneCadReference, cloneModelAsset, cloneVector3, cloneLight, sanitizeEntityName } from './entityValueOperations';
import type { EntityClipboardEntry, EntityClipboard } from './editorStoreTypes';

/** 根据当前场景生成不重名的新建文件夹名称。 */
export function createNextFolderName(scene: SceneDocument): string {
  const folderNames = new Set(
    scene.entityIds
      .map((entityId) => scene.entities[entityId])
      .filter((entity) => entity?.isFolder)
      .map((entity) => entity.name),
  );

  for (let index = 1; index < 1000; index += 1) {
    const name = `新建文件夹 ${index}`;
    if (!folderNames.has(name)) return name;
  }

  return `新建文件夹 ${Date.now()}`;
}

/** 深拷贝实体组件，确保复制/粘贴后的实例可独立编辑。 */
function cloneEntityComponents(entity: Entity): Entity['components'] {
  return {
    ...(entity.components.lighting ? { lighting: cloneJsonValue(entity.components.lighting) } : {}),
    transform: cloneTransform(entity.components.transform),
    ...(entity.components.meshRenderer ? { meshRenderer: cloneMeshRenderer(entity.components.meshRenderer) } : {}),
    ...(entity.components.dataPlatformScreen ? { dataPlatformScreen: cloneJsonValue(entity.components.dataPlatformScreen) } : {}),
    ...(entity.components.chartMarker ? { chartMarker: cloneJsonValue(entity.components.chartMarker) } : {}),
    ...(entity.components.skybox ? { skybox: cloneJsonValue(entity.components.skybox) } : {}),
    ...(entity.components.locator ? { locator: cloneLocator(entity.components.locator) } : {}),
    ...(entity.components.cadReference ? { cadReference: cloneCadReference(entity.components.cadReference) } : {}),
    ...(entity.components.modelAsset ? { modelAsset: cloneModelAsset(entity.components.modelAsset) } : {}),
    ...(entity.components.modelArray
      ? {
          modelArray: {
            items: entity.components.modelArray.items.map((item) => ({
              ...item,
              offset: cloneVector3(item.offset),
            })),
          },
        }
      : {}),
    ...(entity.components.modelArrayInstance
      ? { modelArrayInstance: { ...entity.components.modelArrayInstance } }
      : {}),
    ...(entity.components.alarmManager ? { alarmManager: cloneJsonValue(entity.components.alarmManager) } : {}),
    ...(entity.components.modelGenerator ? { modelGenerator: cloneModelGeneratorComponent(entity.components.modelGenerator) } : {}),
    ...(entity.components.deviceSpawner ? { deviceSpawner: cloneJsonValue(entity.components.deviceSpawner) } : {}),
    ...(entity.components.agvMap ? { agvMap: cloneJsonValue(entity.components.agvMap) } : {}),
    ...(entity.components.clickEventBinding ? { clickEventBinding: cloneClickEventBindingComponent(entity.components.clickEventBinding) } : {}),
    ...(entity.components.telemetryBinding ? { telemetryBinding: cloneJsonValue(entity.components.telemetryBinding) } : {}),
    ...(entity.components.poiEffect ? { poiEffect: cloneJsonValue(entity.components.poiEffect) } : {}),
    ...(entity.components.autoPatrol ? { autoPatrol: cloneAutoPatrolComponent(entity.components.autoPatrol) } : {}),
    ...(entity.components.manualRoamSpawn ? { manualRoamSpawn: cloneJsonValue(entity.components.manualRoamSpawn) } : {}),
    ...(entity.components.camera ? { camera: { ...entity.components.camera } } : {}),
    ...(entity.components.light ? { light: cloneLight(entity.components.light) } : {}),
  };
}

/** 生成不会和当前场景重名的普通复制/粘贴名称；阵列会显式覆盖为数字递增名称。 */
export function createUniqueEntityName(existingNames: Set<string>, baseName: string): string {
  const trimmedBaseName = sanitizeEntityName(baseName) || '对象';
  const firstCandidate = `${trimmedBaseName} 副本`;
  if (!existingNames.has(firstCandidate)) {
    existingNames.add(firstCandidate);
    return firstCandidate;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${trimmedBaseName} 副本 ${index}`;
    if (!existingNames.has(candidate)) {
      existingNames.add(candidate);
      return candidate;
    }
  }

  const fallbackName = `${trimmedBaseName} 副本 ${Date.now()}`;
  existingNames.add(fallbackName);
  return fallbackName;
}

/** 跨场景粘贴时若目标场景无同名对象则保留原名，有冲突再生成副本名称。 */
export function createCrossSceneEntityName(existingNames: Set<string>, baseName: string): string {
  const trimmedBaseName = sanitizeEntityName(baseName) || '对象';
  if (!existingNames.has(trimmedBaseName)) {
    existingNames.add(trimmedBaseName);
    return trimmedBaseName;
  }
  return createUniqueEntityName(existingNames, trimmedBaseName);
}

/** 阵列副本资产编号覆盖目标，避免混合组件实体同时改写两套业务编号。 */
type EntityAssetNumberOverride = {
  kind: 'modelAsset' | 'locator';
  value: string;
};

/** 读取实体当前资产编号目标；导入模型优先于定位线框。 */
export function getEntityAssetNumberTarget(entity: Entity): EntityAssetNumberOverride | null {
  if (entity.components.modelAsset) {
    return { kind: 'modelAsset', value: entity.components.modelAsset.assetCode };
  }
  if (entity.components.locator) {
    return { kind: 'locator', value: entity.components.locator.assetId };
  }
  return null;
}

/** 判断实体是否携带阵列可管理的资产编号字段。 */
export function hasEntityAssetNumber(entity: Entity): boolean {
  return getEntityAssetNumberTarget(entity) !== null;
}

/** 生成不重复的自动巡检名称：自动巡检、自动巡检 2、…。 */
export function createNextAutoPatrolName(scene: SceneDocument): string {
  const existingNames = new Set(Object.values(scene.entities).map((entity) => entity.name));
  const baseName = '自动巡检';
  if (!existingNames.has(baseName)) return baseName;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${baseName} ${Date.now()}`;
}

/** 生成不重复的实体名称：X、X 2、… */
export function createNextEntityName(scene: SceneDocument, baseName: string): string {
  const existingNames = new Set(Object.values(scene.entities).map((entity) => entity.name));
  if (!existingNames.has(baseName)) return baseName;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${baseName} ${Date.now()}`;
}

/** 生成不重复的模型生成器名称：模型生成器、模型生成器 2、… */
export function createNextModelGeneratorName(scene: SceneDocument): string {
  return createNextEntityName(scene, '模型生成器');
}

/** 若阵列子副本的源模型未一同纳入剪贴板，则沿源链固化其完整模型模板并解除悬空阵列引用。 */
function solidifyOrphanedModelArrayInstance(
  scene: SceneDocument,
  entity: Entity,
  components: Entity['components'],
  allIncludedIdSet: ReadonlySet<string>,
): void {
  const sourceEntityId = components.modelArrayInstance?.sourceEntityId;
  if (!sourceEntityId || allIncludedIdSet.has(sourceEntityId)) return;

  const visited = new Set<string>([entity.id]);
  let cursor: Entity | undefined = scene.entities[sourceEntityId];
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (!cursor.components.modelArrayInstance) break;
    cursor = scene.entities[cursor.components.modelArrayInstance.sourceEntityId];
  }

  if (cursor?.components.modelAsset && components.modelAsset) {
    components.modelAsset = {
      ...cloneModelAsset(cursor.components.modelAsset),
      ...cloneModelAsset(components.modelAsset),
    };
  }
  delete components.modelArrayInstance;
}

/** 创建与场景实体隔离的剪贴板快照，并按当前子树归一化层级字段。 */
function cloneEntityForClipboard(
  scene: SceneDocument,
  entity: Entity,
  parentId: string | null,
  childrenIds: string[],
  allIncludedIdSet: ReadonlySet<string>,
): Entity {
  const components = cloneEntityComponents(entity);
  solidifyOrphanedModelArrayInstance(scene, entity, components, allIncludedIdSet);
  return {
    ...entity,
    parentId,
    childrenIds: [...childrenIds],
    components,
  };
}

type EntityClipboardSnapshot = {
  entries: EntityClipboardEntry[];
  folderCount: number;
  entityCount: number;
};

/**
 * 把 Hierarchy 选区转换为互不重叠的完整子树快照。
 * 祖先与任意深度后代同时选中时只保留最高层根条目，空文件夹继续保留。
 */
export function createEntityClipboardSnapshot(scene: SceneDocument, selectedIds: string[]): EntityClipboardSnapshot {
  const rootIds = getTopLevelHierarchyEntityIds(scene.entities, selectedIds);
  const rawRoots: Array<{ rootId: string; includedIds: string[]; includedIdSet: Set<string> }> = [];
  const allIncludedIdSet = new Set<string>();

  for (const rootId of rootIds) {
    const subtreeIds = collectEntitySubtreeIds(scene.entities, rootId);
    const includedIds = subtreeIds.filter((entityId) => Boolean(scene.entities[entityId]));
    if (!includedIds.includes(rootId)) continue;

    const includedIdSet = new Set(includedIds);
    // 绑定到被复制子树内宿主的内置货格一并打包；粘贴时按 ID 映射重建绑定关系。
    for (const entity of Object.values(scene.entities)) {
      const hostEntityId = entity.components.locator?.builtInBinding?.hostEntityId;
      if (hostEntityId && includedIdSet.has(hostEntityId) && !includedIdSet.has(entity.id)) {
        includedIds.push(entity.id);
        includedIdSet.add(entity.id);
      }
    }
    for (const entityId of includedIds) allIncludedIdSet.add(entityId);
    rawRoots.push({ rootId, includedIds, includedIdSet });
  }

  const entries: EntityClipboardEntry[] = [];
  let folderCount = 0;
  let entityCount = 0;

  for (const { rootId, includedIds, includedIdSet } of rawRoots) {
    const snapshotEntities = includedIds.flatMap((entityId) => {
      const entity = scene.entities[entityId];
      if (!entity) return [];
      const parentId = entityId === rootId || !entity.parentId || !includedIdSet.has(entity.parentId)
        ? null
        : entity.parentId;
      const childrenIds = entity.isFolder
        ? entity.childrenIds.filter((childId) => includedIdSet.has(childId))
        : [];
      return [cloneEntityForClipboard(scene, entity, parentId, childrenIds, allIncludedIdSet)];
    });

    entries.push({ rootId, entities: snapshotEntities });
    folderCount += snapshotEntities.filter((entity) => entity.isFolder).length;
    entityCount += snapshotEntities.filter((entity) => !entity.isFolder).length;
  }

  return { entries, folderCount, entityCount };
}

/** 生成人类可读的文件夹/实体数量摘要，用于复制与粘贴日志。 */
export function formatEntityClipboardCount(folderCount: number, entityCount: number): string {
  const parts: string[] = [];
  if (folderCount > 0) parts.push(`${folderCount} 个文件夹`);
  if (entityCount > 0) parts.push(`${entityCount} 个对象`);
  return parts.join('、') || '0 个对象';
}

export type EntityDuplicateOverrides = {
  id?: string;
  name?: string;
  assetNumber?: EntityAssetNumberOverride;
};

/** 创建普通实体副本，复制所有业务组件；阵列场景可按需调整 Transform 位置。 */
export function createDuplicatedRuntimeEntity(
  source: Entity,
  parentId: string | null,
  offset: Vector3Data | null,
  existingNames: Set<string>,
  overrides: EntityDuplicateOverrides = {},
): Entity {
  const id = overrides.id ?? createId('entity');
  const components = cloneEntityComponents(source);
  // 显式指向自身的动作随副本重新绑定，保持旧版“聚焦立标”在普通阵列中的行为。
  for (const event of components.chartMarker?.clickEvents ?? []) {
    for (const action of event.actions) {
      if ((action.type === 'focus' || action.type === 'select') && action.targetEntityId === source.id) action.targetEntityId = id;
    }
  }
  if (offset) {
    components.transform = {
      ...components.transform,
      position: {
        x: components.transform.position.x + offset.x,
        y: components.transform.position.y + offset.y,
        z: components.transform.position.z + offset.z,
      },
    };
  }
  if (components.modelAsset) {
    components.modelAsset = {
      ...components.modelAsset,
      assetCode:
        overrides.assetNumber?.kind === 'modelAsset'
          ? overrides.assetNumber.value
          : createModelAssetCode(extractModelAssetCodePrefix(components.modelAsset.assetCode), id),
      ...(components.modelAsset.inspection ? { inspection: cloneInspectionWithoutDevice(components.modelAsset.inspection) } : {}),
    };
  }
  if (components.autoPatrol) {
    components.autoPatrol = { ...components.autoPatrol, autoStart: false };
  }
  if (components.locator) {
    components.locator = {
      ...components.locator,
      // 复制定位线框必须生成唯一资产编号，否则运行时按 assetId 去重会丢弃副本（设备定位失效）
      assetId:
        overrides.assetNumber?.kind === 'locator'
          ? overrides.assetNumber.value
          : createModelAssetCode(extractModelAssetCodePrefix(components.locator.assetId), id),
    };
  }

  const name = overrides.name ?? createUniqueEntityName(existingNames, source.name);
  if (overrides.name) existingNames.add(overrides.name);

  return {
    ...source,
    id,
    name,
    parentId,
    childrenIds: [],
    components,
  };
}

/**
 * 创建模型阵列的轻量 Scene Entity。
 * 只复制实例级 Transform、资产编号和关联字段；大型模型模板元数据保持只读共享，避免 1000 级阵列重复 JSON 深拷贝。
 */
export function createModelArrayInstanceEntity(
  source: Entity,
  sourceEntityId: string,
  offset: Vector3Data,
  name: string,
  assetCode: string,
  existingNames: Set<string>,
): Entity {
  const modelAsset = source.components.modelAsset;
  if (!modelAsset) throw new Error('模型阵列源缺少 modelAsset。');

  const components: Entity['components'] = {
    ...source.components,
    transform: {
      ...source.components.transform,
      position: {
        x: source.components.transform.position.x + offset.x,
        y: source.components.transform.position.y + offset.y,
        z: source.components.transform.position.z + offset.z,
      },
    },
    modelAsset: { ...modelAsset, assetCode, ...(modelAsset.inspection ? { inspection: cloneInspectionWithoutDevice(modelAsset.inspection) } : {}) },
    modelArrayInstance: { sourceEntityId },
  };
  delete components.modelArray;
  existingNames.add(name);

  return {
    ...source,
    id: createId('entity'),
    name,
    parentId: source.parentId,
    childrenIds: [],
    components,
  };
}

type PreparedEntityClipboardPaste = {
  entities: Entity[];
  rootEntityIds: string[];
  folderCount: number;
  entityCount: number;
  duplicatedIdBySourceId: Map<string, string>;
  warnings: string[];
};

export type CrossScenePasteOptions = {
  crossScene?: boolean;
  sourceProjectId?: string | null;
  targetProjectId?: string | null;
};

function collectExistingAssetNumbers(scene: SceneDocument): Set<string> {
  const existing = new Set<string>();
  for (const entity of Object.values(scene.entities)) {
    const modelCode = entity.components.modelAsset?.assetCode?.trim();
    if (modelCode) existing.add(modelCode);
    const locatorId = entity.components.locator?.assetId?.trim();
    if (locatorId) existing.add(locatorId);
  }
  return existing;
}

function allocateUniqueAssetNumber(existing: Set<string>, prefixSource: string | undefined, entityId: string): string {
  const prefix = extractModelAssetCodePrefix(prefixSource);
  const candidate = createModelAssetCode(prefix, entityId);
  if (!existing.has(candidate)) {
    existing.add(candidate);
    return candidate;
  }
  for (let index = 2; index < 1000; index += 1) {
    const indexed = `${candidate}-${index}`;
    if (!existing.has(indexed)) {
      existing.add(indexed);
      return indexed;
    }
  }
  const fallback = `${candidate}-${Date.now()}`;
  existing.add(fallback);
  return fallback;
}

function collectEntityScreenProjectIds(entity: Entity): string[] {
  const projectIds: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) projectIds.push(trimmed);
  };
  push(entity.components.dataPlatformScreen?.projectId);
  for (const event of entity.components.chartMarker?.clickEvents ?? []) {
    for (const action of event.actions) {
      if (action.type === 'theme') push(action.screen?.projectId);
    }
  }
  for (const event of entity.components.clickEventBinding?.events ?? []) {
    push(event.chart?.projectId);
  }
  const alarm = entity.components.alarmManager;
  push(alarm?.theme?.projectId);
  push(alarm?.markerScreen?.projectId);
  push(alarm?.warehouseTheme?.projectId);
  return projectIds;
}

function isCrossProjectScreenEntity(entity: Entity): boolean {
  return collectEntityScreenProjectIds(entity).length > 0;
}

/** 为一次粘贴生成全新的子树 ID，并在两阶段处理中重建任意深度父子关系。 */
export function prepareEntityClipboardPaste(
  scene: SceneDocument,
  clipboard: EntityClipboard,
  parentId: string | null,
  arrayOptions?: { existingNames: Set<string>; rootName: string },
  pasteOptions?: CrossScenePasteOptions,
): PreparedEntityClipboardPaste {
  const crossScene = Boolean(pasteOptions?.crossScene);
  const existingNames = arrayOptions?.existingNames ?? new Set(Object.values(scene.entities).map((entity) => entity.name));
  const existingAssetNumbers = crossScene ? collectExistingAssetNumbers(scene) : null;
  const entities: Entity[] = [];
  const rootEntityIds: string[] = [];
  const duplicatedIdBySourceId = new Map<string, string>();
  let folderCount = 0;
  let entityCount = 0;
  let renamedAssetCodeCount = 0;

  for (const entry of clipboard.entries) {
    const sourceById = new Map(entry.entities.map((entity) => [entity.id, entity]));
    const copyableSources = entry.entities;
    const copyableIdSet = new Set(copyableSources.map((entity) => entity.id));
    if (!copyableIdSet.has(entry.rootId)) continue;

    for (const source of copyableSources) {
      duplicatedIdBySourceId.set(source.id, createId(source.isFolder ? 'folder' : 'entity'));
    }

    for (const source of copyableSources) {
      const duplicatedId = duplicatedIdBySourceId.get(source.id);
      if (!duplicatedId) continue;
      const duplicatedParentId = source.id === entry.rootId
        ? parentId
        : source.parentId && copyableIdSet.has(source.parentId)
          ? duplicatedIdBySourceId.get(source.parentId) ?? parentId
          : parentId;

      if (source.isFolder) {
        const folderName = source.id === entry.rootId && arrayOptions
          ? arrayOptions.rootName
          : crossScene
            ? createCrossSceneEntityName(existingNames, source.name)
            : createUniqueEntityName(existingNames, source.name);
        const folder: Entity = {
          ...source,
          id: duplicatedId,
          ...(source.composition ? { composition: { ...source.composition, instanceId: createId('composition') } } : {}),
          name: folderName,
          isFolder: true,
          parentId: duplicatedParentId,
          childrenIds: source.childrenIds.flatMap((childId) => {
            if (!copyableIdSet.has(childId) || !sourceById.has(childId)) return [];
            const duplicatedChildId = duplicatedIdBySourceId.get(childId);
            return duplicatedChildId ? [duplicatedChildId] : [];
          }),
          components: cloneEntityComponents(source),
        };
        entities.push(folder);
        folderCount += 1;
      } else {
        const entityOverrides: EntityDuplicateOverrides = { id: duplicatedId };
        if (crossScene) {
          entityOverrides.name = createCrossSceneEntityName(existingNames, source.name);
          if (existingAssetNumbers) {
            if (source.components.modelAsset) {
              const sourceCode = source.components.modelAsset.assetCode?.trim();
              if (sourceCode && !existingAssetNumbers.has(sourceCode)) {
                existingAssetNumbers.add(sourceCode);
                entityOverrides.assetNumber = { kind: 'modelAsset', value: sourceCode };
              } else {
                const allocated = allocateUniqueAssetNumber(
                  existingAssetNumbers,
                  source.components.modelAsset.assetCode,
                  duplicatedId,
                );
                entityOverrides.assetNumber = { kind: 'modelAsset', value: allocated };
                if (sourceCode) renamedAssetCodeCount += 1;
              }
            } else if (source.components.locator) {
              const boundToCopiedHost = Boolean(
                source.components.locator.builtInBinding?.hostEntityId
                && copyableIdSet.has(source.components.locator.builtInBinding.hostEntityId),
              );
              if (!boundToCopiedHost) {
                const sourceAssetId = source.components.locator.assetId?.trim();
                if (sourceAssetId && !existingAssetNumbers.has(sourceAssetId)) {
                  existingAssetNumbers.add(sourceAssetId);
                  entityOverrides.assetNumber = { kind: 'locator', value: sourceAssetId };
                } else {
                  const allocated = allocateUniqueAssetNumber(
                    existingAssetNumbers,
                    source.components.locator.assetId,
                    duplicatedId,
                  );
                  entityOverrides.assetNumber = { kind: 'locator', value: allocated };
                  if (sourceAssetId) renamedAssetCodeCount += 1;
                }
              }
            }
          }
        }
        const duplicated = createDuplicatedRuntimeEntity(
          source,
          duplicatedParentId,
          null,
          existingNames,
          entityOverrides,
        );
        if (arrayOptions) {
          const renderSourceId = source.components.modelArrayInstance?.sourceEntityId;
          if (renderSourceId && !copyableIdSet.has(renderSourceId)) {
            let renderSource = scene.entities[renderSourceId];
            while (renderSource?.components.modelArrayInstance) renderSource = scene.entities[renderSource.components.modelArrayInstance.sourceEntityId];
            duplicated.components.modelAsset = {
              ...cloneEntityComponents(renderSource).modelAsset!,
              ...duplicated.components.modelAsset!,
            };
            delete duplicated.components.modelArrayInstance;
          }
        }
        const binding = duplicated.components.locator?.builtInBinding;
        if (binding) {
          // 宿主同批粘贴则按 ID 映射重建绑定；宿主不在剪贴板内则解除绑定，避免悬空引用。
          const remappedHostId = duplicatedIdBySourceId.get(binding.hostEntityId);
          const locator = { ...duplicated.components.locator! };
          if (remappedHostId) locator.builtInBinding = { ...binding, hostEntityId: remappedHostId, originOffset: { ...binding.originOffset } };
          else delete locator.builtInBinding;
          duplicated.components = { ...duplicated.components, locator };
        }
        entities.push(duplicated);
        entityCount += 1;
      }
    }

    const duplicatedRootId = duplicatedIdBySourceId.get(entry.rootId);
    if (duplicatedRootId) rootEntityIds.push(duplicatedRootId);
  }

  const pastedIdSet = new Set(duplicatedIdBySourceId.values());
  const remapIfPasted = (id: string): string | null => duplicatedIdBySourceId.get(id) ?? (pastedIdSet.has(id) ? id : null);
  let cleanedRefCount = 0;

  // 所有剪贴板根条目均生成 ID 后再处理引用，支持跨根对象及指向自身的动作。
  // 同场景粘贴未随本批复制的目标仍引用场景原对象；跨场景粘贴则清理悬空引用避免指向不存在的 ID。
  for (const entity of entities) {
    if (entity.components.alarmManager) {
      if (crossScene) {
        const nextTargets = entity.components.alarmManager.targets.flatMap((slot) => {
          if (!slot.entityId) return [slot];
          const remapped = remapIfPasted(slot.entityId);
          if (!remapped) {
            cleanedRefCount += 1;
            return [];
          }
          slot.entityId = remapped;
          return [slot];
        });
        entity.components.alarmManager.targets = nextTargets;
      } else {
        for (const slot of entity.components.alarmManager.targets) {
          slot.entityId = duplicatedIdBySourceId.get(slot.entityId) ?? slot.entityId;
        }
      }
    }

    const effectTarget = entity.components.poiEffect?.configuration?.target;
    if (effectTarget) {
      if (effectTarget.entityId) {
        const remapped = crossScene ? remapIfPasted(effectTarget.entityId) : (duplicatedIdBySourceId.get(effectTarget.entityId) ?? effectTarget.entityId);
        if (remapped) effectTarget.entityId = remapped;
        else {
          effectTarget.entityId = null;
          cleanedRefCount += 1;
        }
      }
      if (effectTarget.entityIds) {
        const before = effectTarget.entityIds.length;
        effectTarget.entityIds = crossScene
          ? effectTarget.entityIds.flatMap((id) => {
              const remapped = remapIfPasted(id);
              return remapped ? [remapped] : [];
            })
          : effectTarget.entityIds.map((id) => duplicatedIdBySourceId.get(id) ?? id);
        cleanedRefCount += before - effectTarget.entityIds.length;
        if (crossScene && effectTarget.entityIds.length === 0) delete effectTarget.entityIds;
      }
      if (effectTarget.generatorId) {
        const remapped = crossScene ? remapIfPasted(effectTarget.generatorId) : (duplicatedIdBySourceId.get(effectTarget.generatorId) ?? effectTarget.generatorId);
        if (remapped) effectTarget.generatorId = remapped;
        else {
          effectTarget.generatorId = null;
          cleanedRefCount += 1;
        }
      }
      if (effectTarget.model?.entityIds) {
        const before = effectTarget.model.entityIds.length;
        effectTarget.model.entityIds = crossScene
          ? effectTarget.model.entityIds.flatMap((id) => {
              const remapped = remapIfPasted(id);
              return remapped ? [remapped] : [];
            })
          : effectTarget.model.entityIds.map((id) => duplicatedIdBySourceId.get(id) ?? id);
        cleanedRefCount += before - effectTarget.model.entityIds.length;
        if (crossScene && effectTarget.model.entityIds.length === 0) delete effectTarget.model.entityIds;
      }
    }

    const effectVisual = entity.components.poiEffect?.visual;
    if (effectVisual?.targetEntityId) {
      const remapped = crossScene ? remapIfPasted(effectVisual.targetEntityId) : (duplicatedIdBySourceId.get(effectVisual.targetEntityId) ?? effectVisual.targetEntityId);
      if (remapped) effectVisual.targetEntityId = remapped;
      else {
        effectVisual.targetEntityId = null;
        cleanedRefCount += 1;
      }
    }

    if (arrayOptions || crossScene) {
      const remap = (id: string) => duplicatedIdBySourceId.get(id) ?? id;
      const marker = entity.components.chartMarker;
      if (marker?.dataSourceEntityId) {
        if (crossScene) {
          const remapped = remapIfPasted(marker.dataSourceEntityId);
          if (remapped) marker.dataSourceEntityId = remapped;
          else {
            delete marker.dataSourceEntityId;
            cleanedRefCount += 1;
          }
        } else {
          marker.dataSourceEntityId = remap(marker.dataSourceEntityId);
        }
      }
      const spawner = entity.components.deviceSpawner;
      if (spawner?.templateEntityId) {
        if (crossScene) {
          const remapped = remapIfPasted(spawner.templateEntityId);
          if (remapped) spawner.templateEntityId = remapped;
          else {
            spawner.templateEntityId = null;
            cleanedRefCount += 1;
          }
        } else {
          spawner.templateEntityId = remap(spawner.templateEntityId);
        }
      }
      for (const rule of spawner?.templateRules ?? []) {
        if (rule.templateEntityId) {
          if (crossScene) {
            const remapped = remapIfPasted(rule.templateEntityId);
            if (remapped) rule.templateEntityId = remapped;
            else {
              rule.templateEntityId = null;
              cleanedRefCount += 1;
            }
          } else {
            rule.templateEntityId = remap(rule.templateEntityId);
          }
        }
      }
      const telemetry = entity.components.telemetryBinding;
      if (telemetry?.cargoGeneratorId) {
        if (crossScene) {
          const remapped = remapIfPasted(telemetry.cargoGeneratorId);
          if (remapped) telemetry.cargoGeneratorId = remapped;
          else {
            delete telemetry.cargoGeneratorId;
            cleanedRefCount += 1;
          }
        } else {
          telemetry.cargoGeneratorId = remap(telemetry.cargoGeneratorId);
        }
      }
      for (const field of ['columnBindings', 'incomingLayerBindings', 'outgoingLayerBindings'] as const) {
        if (telemetry?.[field]) {
          telemetry[field] = Object.fromEntries(
            Object.entries(telemetry[field]!).flatMap(([key, ids]) => {
              if (!crossScene) return [[key, ids.map(remap)]];
              const mapped = ids.flatMap((id) => {
                const remapped = remapIfPasted(id);
                if (!remapped) cleanedRefCount += 1;
                return remapped ? [remapped] : [];
              });
              return mapped.length > 0 ? [[key, mapped]] : [];
            }),
          );
        }
      }
      const fetchDrive = entity.components.locator?.fetchDrive;
      if (fetchDrive?.cargoGeneratorId) {
        if (crossScene) {
          const remapped = remapIfPasted(fetchDrive.cargoGeneratorId);
          if (remapped) fetchDrive.cargoGeneratorId = remapped;
          else {
            delete fetchDrive.cargoGeneratorId;
            cleanedRefCount += 1;
          }
        } else {
          fetchDrive.cargoGeneratorId = remap(fetchDrive.cargoGeneratorId);
        }
      }
      for (const event of entity.components.autoPatrol?.events ?? []) {
        if (event.targetEntityId) {
          if (crossScene) {
            const remapped = remapIfPasted(event.targetEntityId);
            if (remapped) event.targetEntityId = remapped;
            else {
              event.targetEntityId = null;
              cleanedRefCount += 1;
            }
          } else {
            event.targetEntityId = remap(event.targetEntityId);
          }
        }
      }
    }

    const events = entity.components.chartMarker?.clickEvents;
    if (!events) continue;
    for (const event of events) {
      if (crossScene) {
        event.actions = event.actions.flatMap((action) => {
          if (action.type !== 'focus' && action.type !== 'select') return [action];
          const remapped = remapIfPasted(action.targetEntityId);
          if (remapped) return [{ ...action, targetEntityId: remapped }];
          cleanedRefCount += 1;
          return [];
        });
      } else {
        for (const action of event.actions) {
          if (action.type === 'focus' || action.type === 'select') action.targetEntityId = duplicatedIdBySourceId.get(action.targetEntityId) ?? action.targetEntityId;
        }
      }
    }
  }

  const pastedEntityById = new Map(entities.map(entity => [entity.id, entity]));
  // 内置货格资产编号跟随宿主货架副本的编号（宿主粘贴时会生成新编号）
  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    const binding = entity.components.locator?.builtInBinding;
    if (!binding) continue;
    const host = pastedEntityById.get(binding.hostEntityId);
    const assetCode = host?.components.modelAsset?.assetCode;
    if (!assetCode || entity.components.locator!.assetId === assetCode) continue;
    entities[index] = {
      ...entity,
      components: {
        ...entity.components,
        locator: { ...entity.components.locator!, assetId: assetCode },
      },
    };
  }

  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    const sourceEntityId = entity.components.modelArrayInstance?.sourceEntityId;
    if (!sourceEntityId) continue;
    const duplicatedSourceId = duplicatedIdBySourceId.get(sourceEntityId);
    if (duplicatedSourceId) {
      entities[index] = {
        ...entity,
        components: {
          ...entity.components,
          modelArrayInstance: { sourceEntityId: duplicatedSourceId },
        },
      };
    } else if (crossScene && !pastedIdSet.has(sourceEntityId)) {
      const nextComponents = { ...entity.components };
      delete nextComponents.modelArrayInstance;
      entities[index] = {
        ...entity,
        components: nextComponents,
      };
      cleanedRefCount += 1;
    }
  }

  const warnings: string[] = [];
  if (renamedAssetCodeCount > 0) {
    warnings.push(`有 ${renamedAssetCodeCount} 个对象的资产编号与目标场景冲突，已自动重新编号。`);
  }
  if (cleanedRefCount > 0) {
    warnings.push(`已自动清理 ${cleanedRefCount} 处指向原场景未复制对象的关联引用。`);
  }
  const targetProjectId = pasteOptions?.targetProjectId ?? null;
  const sourceProjectId = pasteOptions?.sourceProjectId ?? null;
  const hasMismatchedScreenBinding = crossScene && entities.some((entity) => {
    const screenProjectIds = collectEntityScreenProjectIds(entity);
    if (screenProjectIds.some((projectId) => projectId !== targetProjectId)) return true;
    return isCrossProjectScreenEntity(entity)
      && Boolean(sourceProjectId || targetProjectId)
      && sourceProjectId !== targetProjectId;
  });
  if (hasMismatchedScreenBinding) {
    warnings.push('部分图表立标或大屏绑定属于原项目，请在属性面板检查并重新关联当前项目大屏。');
  }

  return { entities, rootEntityIds, folderCount, entityCount, duplicatedIdBySourceId, warnings };
}

/** 收集本次复制到系统剪贴板的文件夹所关联的光照分组规则。 */
export function collectLightingGroupRulesForClipboard(
  scene: SceneDocument,
  entries: readonly EntityClipboardEntry[],
): Record<string, unknown>[] {
  const policy = scene.sceneSettings.lighting.policy;
  if (!policy || policy.rules.length === 0) return [];
  const copiedFolderIds = new Set<string>();
  for (const entry of entries) {
    for (const entity of entry.entities) {
      if (entity.isFolder) copiedFolderIds.add(entity.id);
    }
  }
  if (copiedFolderIds.size === 0) return [];
  return policy.rules
    .filter((rule) => rule.target.kind === 'group' && copiedFolderIds.has(rule.target.folderId))
    .map((rule) => structuredClone(rule) as unknown as Record<string, unknown>);
}

/** 跨场景粘贴文件夹时，把随剪贴板携带的分组光照规则映射并合并进目标场景。 */
export function mergeCrossSceneLightingGroupRules(
  scene: SceneDocument,
  rules: readonly Record<string, unknown>[] | undefined,
  mapping: ReadonlyMap<string, string>,
): SceneDocument {
  if (!rules?.length || !mapping.size) return scene;
  const existingPolicy = scene.sceneSettings.lighting.policy;
  const copiedRules: NonNullable<typeof existingPolicy>['rules'] = [];
  for (const rawRule of rules) {
    const target = rawRule.target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) continue;
    const record = target as Record<string, unknown>;
    if (record.kind !== 'group' || typeof record.folderId !== 'string') continue;
    const copiedFolderId = mapping.get(record.folderId);
    if (!copiedFolderId || !scene.entities[copiedFolderId]?.isFolder) continue;
    const clonedRule = structuredClone(rawRule) as unknown as NonNullable<typeof existingPolicy>['rules'][number];
    clonedRule.id = createId('lighting_rule');
    clonedRule.target = { kind: 'group', folderId: copiedFolderId };
    copiedRules.push(clonedRule);
  }
  if (copiedRules.length === 0) return scene;
  const basePolicy = existingPolicy ?? { version: 1 as const, defaults: {}, rules: [] };
  return {
    ...scene,
    sceneSettings: {
      ...scene.sceneSettings,
      lighting: {
        ...scene.sceneSettings.lighting,
        policy: {
          ...basePolicy,
          rules: [...basePolicy.rules, ...copiedRules],
        },
      },
    },
  };
}

/** 分组是规则的持久化作用域，复制分组时随同复制其规则，不展开为每个实体的例外。 */
export function copyLightingGroupRules(scene: SceneDocument, mappings: readonly ReadonlyMap<string, string>[]): SceneDocument {
  const policy = scene.sceneSettings.lighting.policy;
  if (!policy || !mappings.length) return scene;
  let changed = false;
  const rules = policy.rules.flatMap(rule => {
    if (rule.target.kind !== 'group') return [rule];
    const folderId = rule.target.folderId;
    const copies = mappings.flatMap(mapping => {
      const copiedFolderId = mapping.get(folderId);
      if (!copiedFolderId || !scene.entities[copiedFolderId]?.isFolder) return [];
      changed = true;
      const copiedRule = structuredClone(rule);
      copiedRule.id = createId('lighting_rule');
      copiedRule.name = (rule.name?.trim() || '分组规则') + '（副本）';
      copiedRule.target = { kind: 'group', folderId: copiedFolderId };
      return [copiedRule];
    });
    return [rule, ...copies];
  });
  return changed ? { ...scene, sceneSettings: { ...scene.sceneSettings, lighting: { ...scene.sceneSettings.lighting, policy: { ...policy, rules } } } } : scene;
}
