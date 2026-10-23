import { updateSceneDocumentCommand } from '../../commands/entityCommands';
import type { Entity } from '../../model/Entity';
import { isEntityEffectivelyLocked } from '../../model/entityHierarchy';
import { createArrayAssetNumber } from '../../model/arrayAssetNumbering';
import { createEntityArrayName, createModelArrayIdentity, getEntityArrayIdentifierError, getCompositionArrayInfo, getEntityArrayParameterError, MODEL_ARRAY_ITEM_COUNT_MAX, normalizeModelArrayDirection } from '../../model/modelArray';
import { type SceneDocument } from '../../model/SceneDocument';
import type { Vector3Data } from '../../model/math';
import { findBuiltInSlotEntities } from '../../model/builtInSlotBinding';
import type { EntityArrayDirection, EditorState, ResolvedEntityArrayInput } from './editorStoreTypes';
import { createEntityClipboardSnapshot, prepareEntityClipboardPaste, createModelArrayInstanceEntity, type EntityDuplicateOverrides, createDuplicatedRuntimeEntity, getEntityAssetNumberTarget, copyLightingGroupRules } from './entityClipboardOperations';
import { insertClipboardEntitiesInScene } from './sceneHierarchyOperations';

/** 模型阵列方向到世界坐标单位偏移的映射，负方向通过向量符号表达。 */
export const ENTITY_ARRAY_DIRECTION_VECTORS: Record<EntityArrayDirection, Vector3Data> = {
  x: { x: 1, y: 0, z: 0 },
  '-x': { x: -1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  '-y': { x: 0, y: -1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
  '-z': { x: 0, y: 0, z: -1 },
};

/** 返回模型矩阵实例最终引用的独立源实体，避免对已有阵列副本再次阵列时形成引用链。 */
function resolveModelArraySourceEntityId(scene: SceneDocument, source: Entity): string {
  const referencedSourceId = source.components.modelArrayInstance?.sourceEntityId;
  const referencedSource = referencedSourceId ? scene.entities[referencedSourceId] : null;
  return referencedSource?.components.modelAsset && !referencedSource.components.modelArrayInstance
    ? referencedSource.id
    : source.id;
}

/** 统计一个源模型已经拥有的独立矩阵实例，并兼容尚未迁移的旧版隐藏阵列项。 */
function countModelArrayInstances(scene: SceneDocument, sourceEntityId: string): number {
  const source = scene.entities[sourceEntityId];
  let count = source?.components.modelArray?.items.length ?? 0;
  for (const entity of Object.values(scene.entities)) {
    if (entity.components.modelArrayInstance?.sourceEntityId === sourceEntityId) count += 1;
  }
  return count;
}

type PreparedResolvedEntityArray =
  | {
      ok: true;
      sourceIds: string[];
      copyCount: number;
      spacingMeters: number;
      primarySourceId: string | null;
      duplicatedEntities: Entity[];
      lightingFolderCopies?: Map<string, string>[];
    }
  | { ok: false; error: string };

/** 基于已解析的轴向跨度与世界方向创建正式阵列实体，但不直接写入场景。 */
export function prepareResolvedEntityArray(
  state: EditorState,
  input: ResolvedEntityArrayInput,
): PreparedResolvedEntityArray {
  const parameterError = getEntityArrayParameterError(input.copyCount, input.spacingMeters);
  if (parameterError) return { ok: false, error: parameterError };

  const direction = normalizeModelArrayDirection(input.directionVector);
  if (!direction) return { ok: false, error: '阵列方向无效。' };
  if (!Number.isFinite(input.selectionSpanMeters) || input.selectionSpanMeters < 0) {
    return { ok: false, error: '对象轴向尺寸无效。' };
  }

  const requestedSourceIds = [...new Set(input.sourceIds)];
  const compositionInfo = getCompositionArrayInfo(state.scene, requestedSourceIds, input.copyCount);
  if (compositionInfo) {
    const error = compositionInfo.error ?? getEntityArrayIdentifierError(state.scene, requestedSourceIds, input.copyCount, input.assetNumberRule);
    if (error) return { ok: false, error };
    const root = state.scene.entities[requestedSourceIds[0]];
    const step = input.selectionSpanMeters + input.spacingMeters;
    if (!Number.isFinite(step * input.copyCount)) return { ok: false, error: '净间距或副本数量过大。' };
    const snapshot = createEntityClipboardSnapshot(state.scene, requestedSourceIds);
    const existingNames = new Set(Object.values(state.scene.entities).flatMap(entity => [entity.name, ...(entity.components.modelArray?.items.map(item => item.name) ?? [])]));
    const rootNames: string[] = [];
    for (let index = 1; index <= input.copyCount; index++) {
      const name = createEntityArrayName(root.name, index);
      if (!name.ok) return name;
      rootNames.push(name.name);
      existingNames.add(name.name);
    }
    const duplicatedEntities: Entity[] = [];
    const lightingFolderCopies: Map<string, string>[] = [];
    for (let index = 1; index <= input.copyCount; index++) {
      const prepared = prepareEntityClipboardPaste(state.scene, { id: '', entries: snapshot.entries }, root.parentId, { existingNames, rootName: rootNames[index - 1] });
      for (const entity of prepared.entities) {
        const position = entity.components.transform.position;
        entity.components.transform.position = { x: position.x + direction.x * step * index, y: position.y + direction.y * step * index, z: position.z + direction.z * step * index };
      }
      duplicatedEntities.push(...prepared.entities);
      lightingFolderCopies.push(prepared.duplicatedIdBySourceId);
    }
    return { ok: true, sourceIds: requestedSourceIds, copyCount: input.copyCount, spacingMeters: input.spacingMeters, primarySourceId: root.id, duplicatedEntities, lightingFolderCopies };
  }

  const sourceIds = requestedSourceIds.filter((sourceId) => {
    const source = state.scene.entities[sourceId];
    return Boolean(
      source
      && !source.isFolder
      && !source.components.modelGenerator
      && !source.components.skybox
      && !source.components.manualRoamSpawn
      && !isEntityEffectivelyLocked(state.scene.entities, source),
    );
  });
  if (sourceIds.length === 0 || sourceIds.length !== requestedSourceIds.length) {
    return { ok: false, error: '原选区已失效、被锁定或包含不支持阵列的模型生成器/天空盒/手动漫游初始位置。' };
  }

  const copyCount = input.copyCount;
  const spacingMeters = input.spacingMeters;
  const assetNumberRule = input.assetNumberRule.trim();
  const identifierError = getEntityArrayIdentifierError(
    state.scene,
    sourceIds,
    copyCount,
    assetNumberRule,
  );
  if (identifierError) return { ok: false, error: identifierError };

  const arrayStepMeters = input.selectionSpanMeters + spacingMeters;
  const maximumOffsetMeters = arrayStepMeters * copyCount;
  if (!Number.isFinite(arrayStepMeters) || !Number.isFinite(maximumOffsetMeters)) {
    return { ok: false, error: '净间距或副本数量过大。' };
  }

  const modelSourceSelectionCounts = new Map<string, number>();
  for (const sourceId of sourceIds) {
    const source = state.scene.entities[sourceId];
    if (!source?.components.modelAsset) continue;
    const modelSourceId = resolveModelArraySourceEntityId(state.scene, source);
    modelSourceSelectionCounts.set(modelSourceId, (modelSourceSelectionCounts.get(modelSourceId) ?? 0) + 1);
  }
  for (const [modelSourceId, selectedSourceCount] of modelSourceSelectionCounts) {
    const modelSource = state.scene.entities[modelSourceId];
    const nextInstanceCount = countModelArrayInstances(state.scene, modelSourceId) + copyCount * selectedSourceCount;
    if (nextInstanceCount > MODEL_ARRAY_ITEM_COUNT_MAX) {
      return {
        ok: false,
        error: `模型“${modelSource?.name ?? modelSourceId}”的阵列实例总数不能超过 ${MODEL_ARRAY_ITEM_COUNT_MAX}。`,
      };
    }
  }

  const existingNames = new Set(Object.values(state.scene.entities).map((entity) => entity.name));
  const duplicatedEntities: Entity[] = [];

  for (let copyIndex = 1; copyIndex <= copyCount; copyIndex += 1) {
    const offset = {
      x: direction.x * arrayStepMeters * copyIndex,
      y: direction.y * arrayStepMeters * copyIndex,
      z: direction.z * arrayStepMeters * copyIndex,
    };

    for (const sourceId of sourceIds) {
      const source = state.scene.entities[sourceId];
      if (!source || source.isFolder) continue;

      if (source.components.modelAsset) {
        const identity = createModelArrayIdentity(
          source.name,
          source.components.modelAsset.assetCode,
          copyIndex,
          assetNumberRule,
        );
        if (!identity.ok) return identity;

        const copyEntity = createModelArrayInstanceEntity(
          source,
          resolveModelArraySourceEntityId(state.scene, source),
          offset,
          identity.name,
          identity.assetCode,
          existingNames,
        );
        duplicatedEntities.push(copyEntity);

        // 源模型开着内置货格时副本同步生成绑定货格（每一排各一个）；副本无独立模型宿主，
        // 运行时经 modelArrayInstanceEntities 解析其渲染源布局后放置。
        for (const sourceSlot of findBuiltInSlotEntities(state.scene, sourceId)) {
          const sourceBinding = sourceSlot.components.locator?.builtInBinding;
          if (!sourceBinding) continue;
          const slotNameResult = createEntityArrayName(sourceSlot.name, copyIndex);
          if (!slotNameResult.ok) return slotNameResult;
          const slotOverrides: EntityDuplicateOverrides = { name: slotNameResult.name };
          const slotCopy = createDuplicatedRuntimeEntity(sourceSlot, sourceSlot.parentId, offset, existingNames, slotOverrides);
          slotCopy.components = {
            ...slotCopy.components,
            locator: {
              ...slotCopy.components.locator!,
              // 内置货格资产编号跟随宿主货架副本，不按规则独立生成
              assetId: copyEntity.components.modelAsset?.assetCode ?? slotCopy.components.locator!.assetId,
              builtInBinding: { ...sourceBinding, hostEntityId: copyEntity.id, originOffset: { ...sourceBinding.originOffset } },
            },
          };
          duplicatedEntities.push(slotCopy);
        }
        continue;
      }

      const overrides: EntityDuplicateOverrides = {};
      const nameResult = createEntityArrayName(source.name, copyIndex);
      if (!nameResult.ok) return nameResult;
      overrides.name = nameResult.name;

      const assetNumberTarget = getEntityAssetNumberTarget(source);
      if (assetNumberTarget) {
        const assetNumberResult = createArrayAssetNumber(
          assetNumberTarget.value,
          copyIndex,
          assetNumberRule,
        );
        if (!assetNumberResult.ok) return assetNumberResult;
        overrides.assetNumber = { kind: assetNumberTarget.kind, value: assetNumberResult.value };
      }

      duplicatedEntities.push(
        createDuplicatedRuntimeEntity(source, source.parentId, offset, existingNames, overrides),
      );
    }
  }

  const primarySourceId =
    state.scene.selectedEntityId && sourceIds.includes(state.scene.selectedEntityId)
      ? state.scene.selectedEntityId
      : sourceIds[0] ?? null;

  return {
    ok: true,
    sourceIds,
    copyCount,
    spacingMeters,
    primarySourceId,
    duplicatedEntities,
  };
}

/** 用一条命令插入全部阵列实体，并保持原始主对象选中。 */
export function createResolvedEntityArrayCommand(prepared: Extract<PreparedResolvedEntityArray, { ok: true }>) {
  return updateSceneDocumentCommand('模型阵列', (scene) => {
    const nextScene = copyLightingGroupRules(insertClipboardEntitiesInScene(scene, prepared.duplicatedEntities, []), prepared.lightingFolderCopies ?? []);

    return {
      ...nextScene,
      selectedEntityId: prepared.primarySourceId,
    };
  });
}
