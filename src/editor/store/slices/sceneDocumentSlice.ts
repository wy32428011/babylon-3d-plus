import { updateSceneModelEntranceCommand } from '../../commands/sceneModelEntranceCommands';
import { normalizeSceneModelEntranceSettings } from '../../model/sceneModelEntrance';
import { normalizeSceneOpeningConfig } from '../../model/sceneOpeningAnimation';
import { updateSceneOpeningAnimationCommand } from '../../commands/sceneOpeningAnimationCommands';
import { compositionDescendants } from '../../composition/composition';
import { createAlarmManagerEntity, normalizeAlarmManager, type AlarmManagerComponent } from '../../model/alarmManager';
import { createCommandHistory, executeCommand, redoCommand, undoCommand } from '../../commands/CommandHistory';
import { commitFolderGroupRotation as commitFolderGroupRotationState, commitFolderGroupTranslation as commitFolderGroupTranslationState, commitHierarchyGroupRotation as commitHierarchyGroupRotationState, commitHierarchyGroupTranslation as commitHierarchyGroupTranslationState, updateAutoPatrolCommand, createEntityCommand, createFolderCommand, moveEntitiesToFolderCommand, renameEntityCommand, updateCadReferenceCommand, updateSceneDocumentCommand, updateSceneDefaultCargoGeneratorCommand, updateEntityLockCommand, updateEntityVisibilityCommand, updateLightCommand, updateLocatorCommand, updateMeshRendererCommand, updateModelAssetCodeCommand, updateModelGeneratorCommand, updateDeviceSpawnerCommand, updateClickEventBindingCommand, updatePoiEffectCommand, updateModelParameterValuesCommand, updateTelemetryBindingCommand, updateTransformCommand } from '../../commands/entityCommands';
import { createId } from '../../../shared/ids';
import type { ChartMarkerComponent, DeviceSpawnerComponent, LocatorComponent } from '../../model/components';
import { normalizeLightSettings } from '../../model/lightSettings';
import { collectEntitySubtreeIds, getTopLevelHierarchyEntityIds, isEntityAncestorOf, isEntityEffectivelyLocked, isEntityEffectivelyVisible } from '../../model/entityHierarchy';
import { getArrayAssetNumberRuleError } from '../../model/arrayAssetNumbering';
import { getEntityArrayIdentifierError, getCompositionArrayInfo, getEntityArrayParameterError, MODEL_ARRAY_COPY_COUNT_MAX } from '../../model/modelArray';
import { createChartMarkerEntity, normalizeChartMarker } from '../../model/chartMarker';
import { createDataPlatformScreenComponent } from '../../model/dataPlatformScreen';
import { normalizeChartMarkerScreenSource } from '../../assets/dataPlatformScreenDrag';
import { createEmptySceneDocument, createAutoPatrolEntity, createClickEventBindingEntity, createFolderEntity, createLightEntity, createLocatorEntity, createManualRoamSpawnEntity, createMeshEntity, createModelGeneratorEntity, createDeviceSpawnerEntity, createPoiEffectEntity, normalizeSkyboxSphereScale, type SceneDocument } from '../../model/SceneDocument';
import { findManualRoamSpawnEntity } from '../../model/manualRoamSpawn';
import { cloneAutoPatrolComponent, sanitizeAutoPatrolComponent, updateAutoPatrolWaypointView } from '../../model/autoPatrolInspection';
import { getBuiltInSlotBindingConfig, getLayerChangePlatformBindingConfig, patchBuiltInSlotDimensions, patchLayerChangePlatformDimensions } from '../../model/builtInSlotBinding';
import { areModelParameterValuesEqual, restoreModelParameterValues, sanitizeEditedModelParameterValues } from '../../model/modelParameters';
import { cloneModelGeneratorComponent, sanitizeModelGeneratorComponent } from '../../model/modelGenerator';
import { sanitizeDeviceSpawnerComponent } from '../../model/deviceSpawner';
import { cloneClickEventBindingComponent, sanitizeClickEventBindingComponent } from '../../model/clickEventBinding';
import { createDefaultTelemetryBinding, normalizeTelemetryBindingComponent } from '../../model/telemetryBinding';
import { sanitizePoiEffectComponent } from '../../model/poiEffect';
import { deserializeScene, serializeScene } from '../../project/SceneSerializer';
import { sanitizeCadReferenceDisplayPatch } from '../../cad/cadReferenceCore';
import { sanitizeSceneName, sanitizeVector3, cloneTransform, normalizeTransformForEntity, areTransformsEqual, sanitizeNonNegativeNumber, sanitizeEntityName, isColorLike, cloneMeshRenderer, cloneLocator, sanitizeLocatorAssetId, sanitizeLocatorDimension, sanitizeLocatorInt, sanitizeLocatorGap, sanitizeLocatorFetchDrivePatch, sanitizeLocatorBuiltInBindingPatch, areLocatorsEqual, cloneCadReference, areCadReferencesEqual, sanitizeModelAssetCode, RADIANS_TO_DEGREES, sanitizeSelectedModelParameterValue, getSelectedModelParameterValues, patchModelParameterValue, isFiniteTransform, normalizeGroupRotationTransforms } from './entityValueOperations';
import { isRuntimePreviewState, guardRuntimePreviewMutation, prependLog } from './editorMutationGuard';
import { createLoadedSceneState } from './sceneSessionState';
import { resolveSelectionTransformMode, isRuntimeEntityEditable, getSelectedEntity, sanitizeHierarchySelection, getUnlockedSelectionIds, getActiveHierarchySelectionIds, resolvePasteParentId, getSelectedRuntimeEntityIds, sanitizeSelectedAutoPatrolWaypointId } from './selectionOperations';
import { createNextAutoPatrolName, createNextModelGeneratorName, createNextEntityName, createNextFolderName, createEntityClipboardSnapshot, formatEntityClipboardCount, prepareEntityClipboardPaste, copyLightingGroupRules, hasEntityAssetNumber } from './entityClipboardOperations';
import { areJsonValuesEqual } from './projectAssetRefresh';
import { setEntitiesVisibleInScene, collectVisibilityShowTargetIds, setEntitiesLockedInScene, collectLockUnlockTargetIds, insertClipboardEntitiesInScene, groupEntitiesInScene, ungroupFoldersInScene, deleteEntitiesInScene, applyLayerChangePlatformSideEffects, applyBuiltInSlotSideEffects } from './sceneHierarchyOperations';
import { ENTITY_ARRAY_DIRECTION_VECTORS, prepareResolvedEntityArray, createResolvedEntityArrayCommand } from './sceneEntityArrayOperations';
import type { EntityArrayCommitResult } from './editorStoreTypes';
import { syncDataPlatformEnvironmentsAfterWorkspaceOpen, syncDataPlatformImagesAfterLocalSceneLoad } from './sceneWorkspaceSync';
import type { EditorSlice } from './editorStoreTypes';

const initialEditorScene = createEmptySceneDocument();

/** 文档、实体命令与历史提交的同一入口。 */
export const createSceneDocumentSlice: EditorSlice<
  "scene" |
  "sceneSessionId" |
  "persistedSceneContent" |
  "history" |
  "entityClipboard" |
  "entityArrayRequest" |
  "logs" |
  "renameScene" |
  "resetSceneToBlank" |
  "setDefaultCargoGenerator" |
  "updateSceneModelEntranceSettings" |
  "updateSceneOpeningAnimation" |
  "createMesh" |
  "createLocator" |
  "createLight" |
  "createAutoPatrol" |
  "createManualRoamSpawn" |
  "createModelGenerator" |
  "createClickEventBinding" |
  "createDeviceSpawner" |
  "createAlarmManager" |
  "updateAlarmManager" |
  "createChartMarker" |
  "updateChartMarker" |
  "bindChartMarkerScreen" |
  "createPoiEffect" |
  "createFolder" |
  "moveEntitiesToFolder" |
  "toggleEntityVisible" |
  "toggleEntityLocked" |
  "hideSelectedEntities" |
  "lockSelectedEntities" |
  "copySelectedEntities" |
  "pasteEntityClipboard" |
  "requestEntityArray" |
  "resolveEntityArrayRequest" |
  "commitResolvedEntityArray" |
  "compositionEditRootId" |
  "compositionSaveRequest" |
  "requestCompositionSave" |
  "setCompositionEditRoot" |
  "commitCompositionEdit" |
  "groupSelectedEntities" |
  "ungroupSelectedEntities" |
  "renameSelectedEntity" |
  "deleteSelectedEntity" |
  "updateSelectedTransform" |
  "updateSelectedMaterialColor" |
  "updateSelectedDataPlatformScreen" |
  "updateSelectedLocator" |
  "updateSelectedCadReference" |
  "updateSelectedLight" |
  "updateSelectedModelAssetCode" |
  "updateSelectedModelGenerator" |
  "updateSelectedDeviceSpawner" |
  "updateSelectedClickEventBinding" |
  "updateSelectedPoiEffect" |
  "setManualRoamAvatar" |
  "updateSelectedAutoPatrol" |
  "commitSelectedAutoPatrolWaypointTransform" |
  "updateSelectedTelemetryBinding" |
  "restoreSelectedTelemetryBindingDefault" |
  "updateSelectedModelParameterValue" |
  "previewSelectedModelParameterValue" |
  "commitSelectedModelParameterValues" |
  "previewEntityTransform" |
  "commitEntityTransform" |
  "commitFolderGroupTranslation" |
  "commitFolderGroupRotation" |
  "commitHierarchyGroupTranslation" |
  "commitHierarchyGroupRotation" |
  "previewSelectedTransform" |
  "commitSelectedTransform" |
  "undo" |
  "redo" |
  "newScene" |
  "hasUnsavedChanges" |
  "markScenePersisted" |
  "saveScene" |
  "loadScene" |
  "loadSceneFromFile" |
  "loadSceneFromContent" |
  "pushLog"
> = (set, get) => ({
  scene: initialEditorScene,
  sceneSessionId: createId('scene_session'),
  persistedSceneContent: serializeScene(initialEditorScene),
  history: createCommandHistory(),
  entityClipboard: null,
  entityArrayRequest: null,
  logs: [{ id: 'log_boot', message: '编辑器已启动。' }],
  renameScene: (name) => {
    const nextName = sanitizeSceneName(name);
    if (!nextName) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '重命名场景');
      if (state.scene.name === nextName) return state;

      const command = updateSceneDocumentCommand('重命名场景', (scene) => ({
        ...scene,
        name: nextName,
      }));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${nextName}`),
      };
    });
  },
  resetSceneToBlank: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '清空场景');
      return createLoadedSceneState(state, createEmptySceneDocument(), '场景已初始化。');
    });
  },
  setDefaultCargoGenerator: (generatorId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改默认模型生成器');
      const before = state.scene.sceneSettings.defaultCargoGeneratorId;
      const after = generatorId?.trim() || null;
      if (before === after) return state;

      const command = updateSceneDefaultCargoGeneratorCommand(before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, after ? '默认模型生成器已更新。' : '默认模型生成器已清除。'),
      };
    });
  },
  updateSceneModelEntranceSettings: patch => {
    set(state => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改模型入场动画');
      const before = state.scene.sceneSettings.modelEntrance;
      const current = normalizeSceneModelEntranceSettings(before);
      const after = normalizeSceneModelEntranceSettings({ ...current, ...patch });
      if (JSON.stringify(current) === JSON.stringify(after)) return state;
      return executeCommand(state.scene, state.history, updateSceneModelEntranceCommand(before, after));
    });
  },
  updateSceneOpeningAnimation: patch => {
    set(state => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改开场动画');
      const before = state.scene.sceneSettings.openingAnimation;
      if (!before && patch && !patch.template && !patch.package && !patch.reference) return state;
      const normalizedBefore = normalizeSceneOpeningConfig(before);
      const previousPackage = normalizedBefore?.package;
      const switchingPackage = patch?.template === 'package' && patch.package && (normalizedBefore?.template !== 'package'
        || patch.package.id !== previousPackage?.id || patch.package.version !== previousPackage?.version || patch.package.contentHash !== previousPackage?.contentHash);
      const base = switchingPackage ? { enabled: normalizedBefore?.enabled, allowSkip: normalizedBefore?.allowSkip, motionPreference: normalizedBefore?.motionPreference } : normalizedBefore;
      const after = patch === null ? undefined : normalizeSceneOpeningConfig({ ...base, ...patch });
      if (JSON.stringify(normalizedBefore) === JSON.stringify(after)) return state;
      return executeCommand(state.scene, state.history, updateSceneOpeningAnimationCommand(before, after));
    });
  },
  createMesh: (meshKind, placementPosition) => {
    const entity = createMeshEntity(meshKind, sanitizeVector3(placementPosition));
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建网格');
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createLocator: (placementPosition) => {
    const entity = createLocatorEntity(sanitizeVector3(placementPosition));
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建定位器');
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createLight: (lightKind, placementPosition) => {
    const entity = createLightEntity(lightKind, placementPosition ? sanitizeVector3(placementPosition) : undefined);
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建灯光');
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createAutoPatrol: (placementPosition) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建自动巡检');
      const baseEntity = createAutoPatrolEntity(sanitizeVector3(placementPosition));
      const entity = { ...baseEntity, name: createNextAutoPatrolName(state.scene) };
      const command = createEntityCommand(entity);
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        selectedAutoPatrolWaypointId: null,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  /** 手动漫游初始位置全场唯一；重复放置只移动并选中已有实体。 */
  createManualRoamSpawn: (placementPosition) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '设置手动漫游初始位置');

      const existing = findManualRoamSpawnEntity(state.scene);
      if (existing) {
        const hierarchySelectionIds = [existing.id];
        const selectedScene = { ...state.scene, selectedEntityId: existing.id };
        if (!placementPosition) {
          return {
            scene: selectedScene,
            hierarchySelectionIds,
            ...resolveSelectionTransformMode(state, selectedScene, hierarchySelectionIds),
          };
        }
        if (isEntityEffectivelyLocked(state.scene.entities, existing)) {
          return {
            scene: selectedScene,
            hierarchySelectionIds,
            logs: prependLog(state.logs, '手动漫游初始位置已锁定，无法移动。'),
            ...resolveSelectionTransformMode(state, selectedScene, hierarchySelectionIds),
          };
        }

        const before = cloneTransform(existing.components.transform);
        const after = normalizeTransformForEntity(existing, {
          ...before,
          position: sanitizeVector3(placementPosition),
        });
        if (areTransformsEqual(before, after)) {
          return {
            scene: selectedScene,
            hierarchySelectionIds,
            ...resolveSelectionTransformMode(state, selectedScene, hierarchySelectionIds),
          };
        }

        const command = updateTransformCommand(existing.id, before, after);
        const result = executeCommand(state.scene, state.history, command);
        const movedScene = { ...result.scene, selectedEntityId: existing.id };
        return {
          ...result,
          scene: movedScene,
          hierarchySelectionIds,
          ...resolveSelectionTransformMode(state, movedScene, hierarchySelectionIds),
          logs: prependLog(state.logs, '移动手动漫游初始位置'),
        };
      }

      const entity = createManualRoamSpawnEntity(sanitizeVector3(placementPosition));
      const command = createEntityCommand(entity);
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, '创建手动漫游初始位置'),
      };
    });
  },
  createModelGenerator: (placementPosition) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建模型生成器');

      const baseEntity = createModelGeneratorEntity(sanitizeVector3(placementPosition));
      const entity = { ...baseEntity, name: createNextModelGeneratorName(state.scene) };
      const command = createEntityCommand(entity);
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createClickEventBinding: (placementPosition) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建点击事件绑定');

      const baseEntity = createClickEventBindingEntity(sanitizeVector3(placementPosition));
      const entity = { ...baseEntity, name: createNextEntityName(state.scene, '点击事件绑定') };
      const command = createEntityCommand(entity);
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createDeviceSpawner: (placementPosition) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建设备产生器');

      const baseEntity = createDeviceSpawnerEntity(sanitizeVector3(placementPosition));
      const entity = { ...baseEntity, name: createNextEntityName(state.scene, '设备产生器') };
      const command = createEntityCommand(entity);
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createAlarmManager: (placementPosition) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建报警管理器');
      const baseEntity = createAlarmManagerEntity(sanitizeVector3(placementPosition));
      const entity = { ...baseEntity, name: createNextEntityName(state.scene, '报警管理器') };
      const command = createEntityCommand(entity);
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  updateAlarmManager: (entityId, patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改报警管理器');
      const entity = state.scene.entities[entityId];
      if (!isRuntimeEntityEditable(state.scene, entity) || !entity.components.alarmManager) return state;
      let alarmManager: AlarmManagerComponent;
      try {
        alarmManager = normalizeAlarmManager({ ...entity.components.alarmManager, ...patch });
      } catch (error) {
        return { logs: prependLog(state.logs, '修改报警管理器失败: ' + (error instanceof Error ? error.message : String(error))) };
      }
      if (areJsonValuesEqual(alarmManager, entity.components.alarmManager)) return state;
      const command = updateSceneDocumentCommand('修改报警管理器', (scene) => ({
        ...scene,
        entities: {
          ...scene.entities,
          [entityId]: { ...scene.entities[entityId], components: { ...scene.entities[entityId].components, alarmManager } },
        },
      }));
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, command.label + ': ' + entity.name) };
    });
  },
  createChartMarker: (placementPosition) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建图表立标');
      const baseEntity = createChartMarkerEntity(sanitizeVector3(placementPosition));
      const entity = { ...baseEntity, name: createNextEntityName(state.scene, '图表立标') };
      const command = createEntityCommand(entity);
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  updateChartMarker: (entityId, patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改图表立标');
      const entity = state.scene.entities[entityId];
      if (!isRuntimeEntityEditable(state.scene, entity) || !entity.components.chartMarker) return state;
      let chartMarker: ChartMarkerComponent;
      try {
        chartMarker = normalizeChartMarker({ ...entity.components.chartMarker, ...normalizeChartMarker(patch) });
      } catch (error) {
        return { logs: prependLog(state.logs, '修改图表立标失败: ' + (error instanceof Error ? error.message : String(error))) };
      }
      if (areJsonValuesEqual(chartMarker, entity.components.chartMarker)) return state;
      const command = updateSceneDocumentCommand('修改图表立标', (scene) => ({
        ...scene,
        entities: {
          ...scene.entities,
          [entityId]: { ...scene.entities[entityId], components: { ...scene.entities[entityId].components, chartMarker } },
        },
      }));
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, command.label + ': ' + entity.name) };
    });
  },
  bindChartMarkerScreen: (entityId, source) => {
    const screenSource = source === null ? null : normalizeChartMarkerScreenSource(source);
    if (source !== null && !screenSource) return false;
    let accepted = false;
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '绑定图表立标大屏');
      const entity = state.scene.entities[entityId];
      if (!isRuntimeEntityEditable(state.scene, entity) || !entity.components.chartMarker) return state;
      const chartMarker: ChartMarkerComponent = { ...entity.components.chartMarker, contentType: 'screen' };
      if (screenSource) chartMarker.screenName = screenSource.name;
      else delete chartMarker.screenName;
      const components = { ...entity.components, chartMarker };
      if (screenSource) components.dataPlatformScreen = createDataPlatformScreenComponent(screenSource);
      else delete components.dataPlatformScreen;
      accepted = true;
      if (JSON.stringify(components) === JSON.stringify(entity.components)) return state;
      const command = updateSceneDocumentCommand(screenSource ? '绑定图表立标大屏' : '清空图表立标大屏', (scene) => ({
        ...scene,
        entities: { ...scene.entities, [entityId]: { ...scene.entities[entityId], components } },
      }));
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, `${command.label}: ${entity.name}`) };
    });
    return accepted;
  },
  /** 创建可撤销的 POI 内置 EFF 实体，并把新实体设为当前选择。 */
  createPoiEffect: (effectKind, placementPosition, targetEntityId) => {
    const entity = createPoiEffectEntity(effectKind, sanitizeVector3(placementPosition));
    if (entity.components.poiEffect?.visual && targetEntityId) entity.components.poiEffect.visual.targetEntityId = targetEntityId;
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建 EFF 特效');
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createFolder: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '新建文件夹');
      const selectedEntity = getSelectedEntity(state);
      const parentId = selectedEntity?.isFolder
        && !isEntityEffectivelyLocked(state.scene.entities, selectedEntity)
          ? selectedEntity.id
          : null;
      const folder = createFolderEntity(createNextFolderName(state.scene));
      const command = createFolderCommand(folder, parentId);
      const result = executeCommand(state.scene, state.history, command);

      const hierarchySelectionIds = [folder.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  moveEntitiesToFolder: (entityIds, folderId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '拖放移动对象');
      const targetFolder = folderId ? state.scene.entities[folderId] : null;
      if (folderId && !targetFolder?.isFolder) return state;
      if (targetFolder && isEntityEffectivelyLocked(state.scene.entities, targetFolder)) return state;

      const movableIds = getTopLevelHierarchyEntityIds(state.scene.entities, entityIds).filter((entityId) => {
        const entity = state.scene.entities[entityId];
        return Boolean(
          entity
          && entity.parentId !== folderId
          && !isEntityEffectivelyLocked(state.scene.entities, entity)
        );
      });
      if (
        movableIds.length === 0
        || (
          folderId
          && movableIds.some((entityId) => (
            entityId === folderId
            || isEntityAncestorOf(state.scene.entities, entityId, folderId)
          ))
        )
      ) {
        return state;
      }

      const command = moveEntitiesToFolderCommand(movableIds, folderId);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${movableIds.length} 个项目`),
      };
    });
  },
  toggleEntityVisible: (entityId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换显隐');
      const entities = state.scene.entities;
      const entity = entities[entityId];
      if (!entity) return state;

      // 按钮图标展示继承后的有效显隐；点击也按有效状态切换：
      // 显示被祖先隐藏的模型时必须连同隐藏祖先一起显示，
      // 否则会把自身 visible 反向翻转为 false，保存重开后模型永远无法出现。
      const effectivelyVisible = isEntityEffectivelyVisible(entities, entity);
      const command = effectivelyVisible
        ? updateEntityVisibilityCommand(entityId, true, false)
        : updateSceneDocumentCommand('显示对象', (scene) => setEntitiesVisibleInScene(
            scene,
            collectVisibilityShowTargetIds(scene.entities, entityId),
            true,
          ));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  toggleEntityLocked: (entityId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换锁定');
      const entities = state.scene.entities;
      const entity = entities[entityId];
      if (!entity) return state;

      // 与显隐按钮一致：图标展示继承后的有效锁定；解锁被祖先锁定的实体时
      // 必须连同锁定祖先一起解锁，否则会把自身 locked 反向翻转为 true。
      const effectivelyLocked = isEntityEffectivelyLocked(entities, entity);
      const command = effectivelyLocked
        ? updateSceneDocumentCommand('解锁对象', (scene) => setEntitiesLockedInScene(
            scene,
            collectLockUnlockTargetIds(scene.entities, entityId),
            false,
          ))
        : updateEntityLockCommand(entityId, false, true);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  hideSelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '隐藏对象');
      const targetIds = getUnlockedSelectionIds(state);
      const changingIds = targetIds.filter((entityId) => state.scene.entities[entityId]?.visible !== false);
      if (changingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('隐藏对象', (scene) => setEntitiesVisibleInScene(scene, changingIds, false));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${changingIds.length} 个对象`),
      };
    });
  },
  lockSelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '锁定对象');
      const targetIds = getUnlockedSelectionIds(state);
      const changingIds = targetIds.filter((entityId) => state.scene.entities[entityId]?.locked !== true);
      if (changingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('锁定对象', (scene) => setEntitiesLockedInScene(scene, changingIds, true));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${changingIds.length} 个对象`),
      };
    });
  },
  copySelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '复制对象');
      const selectedIds = getActiveHierarchySelectionIds(state);
      const containsSkybox = getTopLevelHierarchyEntityIds(state.scene.entities, selectedIds).some((rootId) => (
        collectEntitySubtreeIds(state.scene.entities, rootId)
          .some((entityId) => Boolean(state.scene.entities[entityId]?.components.skybox))
      ));
      if (containsSkybox) {
        return { logs: prependLog(state.logs, '球形天空盒是场景唯一对象，不能复制或随文件夹复制。') };
      }
      const containsManualRoamSpawn = getTopLevelHierarchyEntityIds(state.scene.entities, selectedIds).some((rootId) => (
        collectEntitySubtreeIds(state.scene.entities, rootId)
          .some((entityId) => Boolean(state.scene.entities[entityId]?.components.manualRoamSpawn))
      ));
      if (containsManualRoamSpawn) {
        return { logs: prependLog(state.logs, '手动漫游初始位置是场景唯一对象，不能复制或随文件夹复制。') };
      }
      const snapshot = createEntityClipboardSnapshot(state.scene, selectedIds);
      if (snapshot.entries.length === 0) return state;

      return {
        entityClipboard: {
          id: createId('clipboard'),
          entries: snapshot.entries,
        },
        logs: prependLog(
          state.logs,
          `复制对象: ${formatEntityClipboardCount(snapshot.folderCount, snapshot.entityCount)}`,
        ),
      };
    });
  },
  pasteEntityClipboard: (targetFolderId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '粘贴对象');
      const clipboard = state.entityClipboard;
      if (!clipboard || clipboard.entries.length === 0) return state;
      if (clipboard.entries.some((entry) => entry.entities.some((entity) => Boolean(entity.components.skybox)))) {
        return { logs: prependLog(state.logs, '剪贴板包含球形天空盒，已拒绝创建重复天空盒。') };
      }
      if (clipboard.entries.some((entry) => entry.entities.some((entity) => Boolean(entity.components.manualRoamSpawn)))) {
        return { logs: prependLog(state.logs, '剪贴板包含手动漫游初始位置，已拒绝创建重复出生点。') };
      }

      const selectedEntity = getSelectedEntity(state);
      const inferredTargetFolderId =
        targetFolderId === undefined
          ? selectedEntity?.isFolder
            ? selectedEntity.id
            : selectedEntity?.parentId ?? null
          : targetFolderId;
      const parentId = resolvePasteParentId(state.scene, inferredTargetFolderId);
      const parentFolder = parentId ? state.scene.entities[parentId] : null;
      if (parentFolder && isEntityEffectivelyLocked(state.scene.entities, parentFolder)) return state;

      const prepared = prepareEntityClipboardPaste(state.scene, clipboard, parentId);

      const command = updateSceneDocumentCommand('粘贴对象', (scene) =>
        copyLightingGroupRules(insertClipboardEntitiesInScene(scene, prepared.entities, prepared.rootEntityIds), [prepared.duplicatedIdBySourceId]),
      );
      const result = executeCommand(state.scene, state.history, command);

      const hierarchySelectionIds = sanitizeHierarchySelection(result.scene, prepared.rootEntityIds);
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(
          state.logs,
          `${command.label}: ${formatEntityClipboardCount(prepared.folderCount, prepared.entityCount)}`,
        ),
      };
    });
  },
  requestEntityArray: (copyCount, direction, spacingMeters, assetNumberRule) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '阵列对象');
      const selectionIds = getActiveHierarchySelectionIds(state);
      const compositionInfo = getCompositionArrayInfo(state.scene, selectionIds, copyCount);
      const compositionError = compositionInfo && (compositionInfo.error ?? getEntityArrayParameterError(copyCount, spacingMeters) ?? getEntityArrayIdentifierError(state.scene, selectionIds, copyCount, assetNumberRule));
      if (compositionError) return { entityArrayRequest: null, logs: prependLog(state.logs, '模型阵列失败：' + compositionError) };
      const sourceIds = compositionInfo ? selectionIds : getSelectedRuntimeEntityIds(state);
      if (sourceIds.length === 0) return state;

      const normalizedAssetNumberRule = assetNumberRule.trim();
      const ruleError = getArrayAssetNumberRuleError(normalizedAssetNumberRule);
      if (ruleError) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, `模型阵列失败：${ruleError}`),
        };
      }

      const assetNumberedSourceCount = sourceIds.reduce((count, sourceId) => {
        const source = state.scene.entities[sourceId];
        return source && hasEntityAssetNumber(source) ? count + 1 : count;
      }, 0);
      if (normalizedAssetNumberRule && assetNumberedSourceCount !== 1) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, '模型阵列失败：自定义资产编号规则仅支持一个带资产编号的源对象。'),
        };
      }

      const normalizedCopyCount = Math.min(
        MODEL_ARRAY_COPY_COUNT_MAX,
        Math.max(1, Math.floor(Number.isFinite(copyCount) ? copyCount : 3)),
      );
      const normalizedDirection = ENTITY_ARRAY_DIRECTION_VECTORS[direction] ? direction : 'x';
      const spacing = sanitizeNonNegativeNumber(spacingMeters, 1);

      return {
        entityArrayRequest: {
          id: createId('entity_array'),
          sourceIds,
          copyCount: normalizedCopyCount,
          direction: normalizedDirection,
          spacingMeters: spacing,
          assetNumberRule: normalizedAssetNumberRule,
        },
      };
    });
  },
  resolveEntityArrayRequest: (requestId, selectionSpanMeters) => {
    set((state) => {
      const request = state.entityArrayRequest;
      if (!request || request.id !== requestId) return state;
      if (!Number.isFinite(selectionSpanMeters) || selectionSpanMeters === null || selectionSpanMeters < 0) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, '模型阵列失败：选区几何尚未加载完成，请稍后重试。'),
        };
      }

      const prepared = prepareResolvedEntityArray(state, {
        sourceIds: request.sourceIds,
        copyCount: request.copyCount,
        directionVector: ENTITY_ARRAY_DIRECTION_VECTORS[request.direction] ?? ENTITY_ARRAY_DIRECTION_VECTORS.x,
        selectionSpanMeters,
        spacingMeters: request.spacingMeters,
        assetNumberRule: request.assetNumberRule,
      });
      if (!prepared.ok) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, `模型阵列失败：${prepared.error}`),
        };
      }

      const command = createResolvedEntityArrayCommand(prepared);
      const result = executeCommand(state.scene, state.history, command);
      void prepared.duplicatedEntities
        .filter((entity) => Boolean(entity.components.modelArrayInstance))
        .map((entity) => entity.id);
      void prepared.duplicatedEntities
        .filter((entity) => !entity.components.modelArrayInstance)
        .map((entity) => entity.id);
      const createdCount = prepared.duplicatedEntities.length;

      return {
        ...result,
        entityArrayRequest: null,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, prepared.sourceIds),
        logs: prependLog(
          state.logs,
          `${command.label}: ${createdCount} 个对象，净间距 ${prepared.spacingMeters} m`,
        ),
      };
    });
  },
  commitResolvedEntityArray: (input) => {
    let commitResult: EntityArrayCommitResult = { ok: false, error: '模型阵列未执行。' };

    set((state) => {
      if (isRuntimePreviewState(state)) {
        const error = '运行预览期间不能创建模型阵列。';
        commitResult = { ok: false, error };
        return { logs: prependLog(state.logs, `模型阵列失败：${error}`) };
      }

      const prepared = prepareResolvedEntityArray(state, input);
      if (!prepared.ok) {
        commitResult = { ok: false, error: prepared.error };
        return { logs: prependLog(state.logs, `模型阵列失败：${prepared.error}`) };
      }

      const command = createResolvedEntityArrayCommand(prepared);
      const result = executeCommand(state.scene, state.history, command);
      const modelArrayItemIds = prepared.duplicatedEntities
        .filter((entity) => Boolean(entity.components.modelArrayInstance))
        .map((entity) => entity.id);
      const duplicatedIds = prepared.duplicatedEntities
        .filter((entity) => !entity.components.modelArrayInstance)
        .map((entity) => entity.id);
      const createdCount = prepared.duplicatedEntities.length;
      commitResult = { ok: true, duplicatedIds, modelArrayItemIds, createdCount };

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, prepared.sourceIds),
        logs: prependLog(
          state.logs,
          `${command.label}: ${createdCount} 个对象，净间距 ${prepared.spacingMeters} m`,
        ),
      };
    });

    return commitResult;
  },
  compositionEditRootId: null,
  compositionSaveRequest: null,
  requestCompositionSave: () => set(state => state.runtimeMode !== 'edit' ? state : { compositionSaveRequest: { id: createId('composition_save'), sceneSessionId: state.sceneSessionId, ids: getUnlockedSelectionIds(state) } }),
  setCompositionEditRoot: (id) => set({ compositionEditRootId: id }),
  commitCompositionEdit: (before, after, label) => {
    let committed = false;
    set(state => {
      if (state.runtimeMode !== 'edit' || state.scene !== before) return state;
      const result = executeCommand(state.scene, state.history, updateSceneDocumentCommand(label, () => after));
      committed = true;
      return { ...result, hierarchySelectionIds: after.selectedEntityId === before.selectedEntityId ? sanitizeHierarchySelection(after, state.hierarchySelectionIds) : after.selectedEntityId ? [after.selectedEntityId] : [], logs: prependLog(state.logs, label) };
    });
    return committed;
  },
  groupSelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '群组对象');
      const groupingIds = getSelectedRuntimeEntityIds(state);
      if (groupingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('群组对象', (scene) => groupEntitiesInScene(scene, groupingIds));
      const result = executeCommand(state.scene, state.history, command);

      const hierarchySelectionIds = result.scene.selectedEntityId ? [result.scene.selectedEntityId] : [];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${groupingIds.length} 个对象`),
      };
    });
  },
  ungroupSelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '解组对象');
      const selectionIds = getUnlockedSelectionIds(state);
      const folderIds = selectionIds.flatMap((entityId) => {
        const entity = state.scene.entities[entityId];
        if (!entity) return [];
        if (entity.isFolder) return [entity.id];
        return entity.parentId ? [entity.parentId] : [];
      });
      const ungroupingIds = [...new Set(folderIds)].filter((folderId) => {
        const folder = state.scene.entities[folderId];
        return Boolean(folder?.isFolder && !isEntityEffectivelyLocked(state.scene.entities, folder));
      });
      if (ungroupingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('解组对象', (scene) => ungroupFoldersInScene(scene, ungroupingIds));
      const result = executeCommand(state.scene, state.history, command);

      const hierarchySelectionIds = result.scene.selectedEntityId ? [result.scene.selectedEntityId] : [];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${ungroupingIds.length} 个分组`),
      };
    });
  },
  renameSelectedEntity: (name) => {
    const nextName = sanitizeEntityName(name);
    if (!nextName) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '重命名对象');
      const entity = getSelectedEntity(state);
      if (!entity || isEntityEffectivelyLocked(state.scene.entities, entity) || entity.name === nextName) return state;

      const command = renameEntityCommand(entity.id, entity.name, nextName);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${nextName}`),
      };
    });
  },
  deleteSelectedEntity: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '删除对象');
      const selectedEntity = getSelectedEntity(state);
      const selectedWaypointId = sanitizeSelectedAutoPatrolWaypointId(
        state.scene,
        state.selectedAutoPatrolWaypointId,
      );
      if (selectedWaypointId && isRuntimeEntityEditable(state.scene, selectedEntity) && selectedEntity.components.autoPatrol) {
        const current = selectedEntity.components.autoPatrol;
        const before = cloneAutoPatrolComponent(current);
        const after = cloneAutoPatrolComponent({
          ...current,
          autoStart: current.autoStart,
          waypoints: current.waypoints.filter((waypoint) => waypoint.id !== selectedWaypointId),
        });
        const command = updateAutoPatrolCommand(selectedEntity.id, before, after, '删除巡检点位');
        const result = executeCommand(state.scene, state.history, command);
        return {
          ...result,
          selectedAutoPatrolWaypointId: null,
          autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
          logs: prependLog(state.logs, command.label),
        };
      }
      const originalDeletingIds = getUnlockedSelectionIds(state);
      const deletingIds = [...new Set(originalDeletingIds.flatMap(id => state.scene.entities[id]?.composition
        ? compositionDescendants(state.scene, [id]).map(e => e.id) : [id]))];
      if (deletingIds.some(id => isEntityEffectivelyLocked(state.scene.entities, state.scene.entities[id]))) return state;
      if (deletingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('删除对象', (scene) => deleteEntitiesInScene(scene, deletingIds));
      const result = executeCommand(state.scene, state.history, command);

      const hierarchySelectionIds = sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds);
      return {
        ...result,
        hierarchySelectionIds,
        selectedAutoPatrolWaypointId: null,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${deletingIds.length} 个对象`),
      };
    });
  },
  updateSelectedTransform: (field, axis, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改变换');
      const entity = getSelectedEntity(state);
      if (!isRuntimeEntityEditable(state.scene, entity)) return state;
      if (entity.components.locator?.builtInBinding) return state;

      const before = normalizeTransformForEntity(entity, entity.components.transform);
      const candidate = cloneTransform(before);
      if (entity.components.skybox && field === 'scale') {
        candidate.scale = normalizeSkyboxSphereScale({ x: value, y: value, z: value });
      } else {
        candidate[field][axis] = value;
      }
      const after = normalizeTransformForEntity(entity, candidate);
      if (areTransformsEqual(before, after)) return state;

      const command = updateTransformCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedMaterialColor: (materialColor) => {
    if (!isColorLike(materialColor)) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改材质颜色');
      const entity = getSelectedEntity(state);
      const meshRenderer = entity?.components.meshRenderer;
      if (!isRuntimeEntityEditable(state.scene, entity) || !meshRenderer || meshRenderer.materialColor === materialColor) return state;

      const before = cloneMeshRenderer(meshRenderer);
      const after = { ...before, materialColor };
      const command = updateMeshRendererCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedDataPlatformScreen: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改大屏显示模式');
      const entity = getSelectedEntity(state);
      const screen = entity?.components.dataPlatformScreen;
      if (!isRuntimeEntityEditable(state.scene, entity) || !screen) return state;

      if (patch.renderMode !== 'iframe' && patch.renderMode !== 'texture') return state;
      const renderMode = patch.renderMode;
      if (screen.renderMode === renderMode) return state;

      const command = updateSceneDocumentCommand('更新大屏显示模式', (scene) => ({
        ...scene,
        entities: {
          ...scene.entities,
          [entity.id]: {
            ...scene.entities[entity.id],
            components: {
              ...scene.entities[entity.id].components,
              dataPlatformScreen: {
                ...screen,
                renderMode,
              },
            },
          },
        },
      }));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedLocator: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改定位器');
      const entity = getSelectedEntity(state);
      const locator = entity?.components.locator;
      if (!isRuntimeEntityEditable(state.scene, entity) || !locator) return state;

      const before = cloneLocator(locator);
      // 换层站台位于货架头部（列 0 之前），起始列允许负值；普通货格仍从 0 起。
      const startColumnMin = before.builtInBinding?.kind === 'layerChangePlatform' ? -99 : 0;
      const retainCargo = patch.retainCargo === undefined ? before.retainCargo : patch.retainCargo === true;
      const after: LocatorComponent = {
        // 内置货格资产编号始终跟随宿主货架，忽略外部 patch
        assetId: before.builtInBinding ? before.assetId : sanitizeLocatorAssetId(patch.assetId, before.assetId),
        storageDepth: patch.storageDepth === 'far' ? 'far' : (patch.storageDepth === 'near' ? 'near' : before.storageDepth),
        length: sanitizeLocatorDimension(patch.length, before.length),
        width: sanitizeLocatorDimension(patch.width, before.width),
        height: sanitizeLocatorDimension(patch.height, before.height),
        columns: sanitizeLocatorInt(patch.columns, before.columns, 1, 100),
        layers: sanitizeLocatorInt(patch.layers, before.layers, 1, 100),
        startColumn: sanitizeLocatorInt(patch.startColumn, before.startColumn, startColumnMin, 999),
        startLayer: sanitizeLocatorInt(patch.startLayer, before.startLayer, 0, 999),
        columnReversed: patch.columnReversed ?? before.columnReversed,
        columnGap: sanitizeLocatorGap(patch.columnGap, before.columnGap),
        layerGap: sanitizeLocatorGap(patch.layerGap, before.layerGap),
        deviceAssetCode: patch.deviceAssetCode !== undefined ? patch.deviceAssetCode.trim().slice(0, 128) : before.deviceAssetCode,
        aisleCode: patch.aisleCode !== undefined ? patch.aisleCode.trim().slice(0, 128) : before.aisleCode,
        rowNumber: sanitizeLocatorInt(patch.rowNumber, before.rowNumber, 0, 999),
        fetchDrive: sanitizeLocatorFetchDrivePatch(patch.fetchDrive, before.fetchDrive),
        builtInBinding: sanitizeLocatorBuiltInBindingPatch(patch.builtInBinding, before.builtInBinding),
        ...(retainCargo ? { retainCargo: true } : {}),
      };

      if (areLocatorsEqual(before, after)) return state;

      const command = updateLocatorCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedCadReference: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改 CAD 参考图');
      const entity = getSelectedEntity(state);
      const cadReference = entity?.components.cadReference;
      if (!isRuntimeEntityEditable(state.scene, entity) || !cadReference) return state;

      const before = cloneCadReference(cadReference);
      const after = sanitizeCadReferenceDisplayPatch(before, patch);
      if (areCadReferencesEqual(before, after)) return state;

      const command = updateCadReferenceCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedLight: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改灯光');
      const entity = getSelectedEntity(state);
      const light = entity?.components.light;
      if (!isRuntimeEntityEditable(state.scene, entity) || !light) return state;

      const before = { ...light };
      const after = normalizeLightSettings({
        ...before,
        ...patch,
        intensity: patch.intensity === undefined ? before.intensity : sanitizeNonNegativeNumber(patch.intensity, before.intensity),
      });

      if (
        before.lightKind === after.lightKind && before.intensity === after.intensity &&
        before.color === after.color && before.groundColor === after.groundColor &&
        before.range === after.range && before.nightBehavior === after.nightBehavior &&
        before.angle === after.angle && before.exponent === after.exponent &&
        before.width === after.width && before.height === after.height
      ) return state;

      const command = updateLightCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        ...resolveSelectionTransformMode(state, result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedModelAssetCode: (assetCode) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改资产编号');
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!isRuntimeEntityEditable(state.scene, entity) || !modelAsset) return state;

      const before = modelAsset.assetCode;
      const after = sanitizeModelAssetCode(assetCode, before);
      if (before === after) return state;

      const command = updateModelAssetCodeCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${after}`),
      };
    });
  },
  updateSelectedModelGenerator: (component, label = '更新模型生成器') => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const entity = getSelectedEntity(state);
      const current = entity?.components.modelGenerator;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;

      const normalized = sanitizeModelGeneratorComponent(component);
      if (!normalized) return state;
      const before = cloneModelGeneratorComponent(current);
      const after = cloneModelGeneratorComponent(normalized);
      if (areJsonValuesEqual(before, after)) return state;

      const command = updateModelGeneratorCommand(entity.id, before, after, label);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, command.label + ': ' + entity.name) };
    });
  },
  /** 更新选中设备产生器的完整配置快照，并通过命令历史支持撤销和重做。 */
  updateSelectedDeviceSpawner: (component, label = '更新设备产生器') => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const entity = getSelectedEntity(state);
      const current = entity?.components.deviceSpawner;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;

      const normalized = sanitizeDeviceSpawnerComponent(component);
      if (!normalized) return state;
      const before = JSON.parse(JSON.stringify(current)) as DeviceSpawnerComponent;
      const after = JSON.parse(JSON.stringify(normalized)) as DeviceSpawnerComponent;
      if (areJsonValuesEqual(before, after)) return state;

      const command = updateDeviceSpawnerCommand(entity.id, before, after, label);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, command.label + ': ' + entity.name) };
    });
  },
  /** 更新选中点击事件绑定的完整配置快照，并通过命令历史支持撤销和重做。 */
  updateSelectedClickEventBinding: (component, label = '更新点击事件绑定') => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const entity = getSelectedEntity(state);
      const current = entity?.components.clickEventBinding;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;

      const normalized = sanitizeClickEventBindingComponent(component);
      const before = cloneClickEventBindingComponent(current);
      const after = cloneClickEventBindingComponent(normalized);
      if (areJsonValuesEqual(before, after)) return state;

      const command = updateClickEventBindingCommand(entity.id, before, after, label);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, command.label + ': ' + entity.name) };
    });
  },
  /** 更新选中 EFF 的完整配置快照，并通过命令历史支持撤销和重做。 */
  updateSelectedPoiEffect: (component, label = '更新 EFF 特效') => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const entity = getSelectedEntity(state);
      const current = entity?.components.poiEffect;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;

      const before = { ...current };
      const after = sanitizePoiEffectComponent(component);
      if (areJsonValuesEqual(before, after)) return state;

      const command = updatePoiEffectCommand(entity.id, before, after, label);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, `${command.label}: ${entity.name}`) };
    });
  },
  setManualRoamAvatar: (entityId, avatar) => {
    set((state) => {
      const label = '更换漫游人物';
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const entity = state.scene.entities[entityId];
      if (!isRuntimeEntityEditable(state.scene, entity) || !entity.components.manualRoamSpawn) return state;
      if (avatar && (!avatar.name.trim() || !avatar.sourcePath.trim() || !avatar.sourceUrl.trim())) return state;
      const after = avatar ? { avatar: { ...avatar } } : {};
      if (areJsonValuesEqual(entity.components.manualRoamSpawn, after)) return state;
      const command = updateSceneDocumentCommand(label, (scene) => ({
        ...scene,
        entities: { ...scene.entities, [entityId]: {
          ...scene.entities[entityId],
          components: { ...scene.entities[entityId].components, manualRoamSpawn: after },
        } },
      }));
      return { ...executeCommand(state.scene, state.history, command), logs: prependLog(state.logs, label) };
    });
  },
  updateSelectedAutoPatrol: (component, label = '更新自动巡检') => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const entity = getSelectedEntity(state);
      const current = entity?.components.autoPatrol;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;
      const sanitized = sanitizeAutoPatrolComponent(component);
      if (!sanitized) return state;
      const after = cloneAutoPatrolComponent({
        ...sanitized,
        autoStart: sanitized.autoStart,
      });
      const before = cloneAutoPatrolComponent(current);
      if (areJsonValuesEqual(before, after)) return state;

      const command = after.autoStart || after.isDefault
        ? updateSceneDocumentCommand(label, (scene) => {
            const entities = { ...scene.entities };
            for (const entityId of scene.entityIds) {
              const candidate = entities[entityId];
              const candidatePatrol = candidate?.components.autoPatrol;
              if (!candidatePatrol) continue;
              const nextPatrol = entityId === entity.id
                ? after
                : candidatePatrol.autoStart || candidatePatrol.isDefault
                  ? {
                      ...candidatePatrol,
                      ...(after.autoStart && candidatePatrol.autoStart ? { autoStart: false } : {}),
                      ...(after.isDefault && candidatePatrol.isDefault ? { isDefault: false } : {}),
                    }
                  : candidatePatrol;
              if (nextPatrol === candidatePatrol) continue;
              entities[entityId] = {
                ...candidate,
                components: { ...candidate.components, autoPatrol: nextPatrol },
              };
            }
            return { ...scene, entities };
          })
        : updateAutoPatrolCommand(entity.id, before, after, label);
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        selectedAutoPatrolWaypointId: sanitizeSelectedAutoPatrolWaypointId(
          result.scene,
          state.selectedAutoPatrolWaypointId,
        ),
        autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  commitSelectedAutoPatrolWaypointTransform: (waypointId, transform) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '调整巡检点位');
      const entity = getSelectedEntity(state);
      const current = entity?.components.autoPatrol;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;
      const waypointIndex = current.waypoints.findIndex((waypoint) => waypoint.id === waypointId);
      if (waypointIndex < 0) return state;
      const updatedWaypoint = updateAutoPatrolWaypointView(
        current.waypoints[waypointIndex],
        entity.components.transform,
        {
          position: transform.position,
          headingDegrees: transform.rotation.y * RADIANS_TO_DEGREES,
          pitchDegrees: -transform.rotation.x * RADIANS_TO_DEGREES,
        },
      );
      const before = cloneAutoPatrolComponent(current);
      const after = cloneAutoPatrolComponent({
        ...current,
        waypoints: current.waypoints.map((waypoint, index) => index === waypointIndex ? updatedWaypoint : waypoint),
      });
      if (areJsonValuesEqual(before, after)) return state;
      const command = updateAutoPatrolCommand(entity.id, before, after, '调整巡检点位');
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        selectedAutoPatrolWaypointId: waypointId,
        autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedTelemetryBinding: (binding) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改遥测绑定');
      const entity = getSelectedEntity(state);
      if (!entity?.components.modelAsset) return state;
      const before = entity.components.telemetryBinding ?? null;
      const after = binding ? normalizeTelemetryBindingComponent(binding) : null;
      if (JSON.stringify(before) === JSON.stringify(after)) return state;
      const command = updateTelemetryBindingCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, command.label) };
    });
  },
  restoreSelectedTelemetryBindingDefault: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '恢复遥测绑定');
      const entity = getSelectedEntity(state);
      const devType = entity?.components.modelAsset?.dataDrivenConfig?.device.devType;
      if (!entity || !devType) return state;
      const before = entity.components.telemetryBinding ?? null;
      const after = createDefaultTelemetryBinding(devType);
      if (JSON.stringify(before) === JSON.stringify(after)) return state;
      const command = updateTelemetryBindingCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, '已恢复模型默认数据驱动绑定') };
    });
  },
  updateSelectedModelParameterValue: (key, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改模型参数');
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!isRuntimeEntityEditable(state.scene, entity) || !modelAsset?.parameterConfig) return state;

      const sanitizedValue = sanitizeSelectedModelParameterValue(state, key, value);
      if (sanitizedValue === null) return state;

      const before = getSelectedModelParameterValues(state);
      if (!before) return state;

      const after = patchModelParameterValue(before, key, sanitizedValue);
      if (areModelParameterValuesEqual(before, after)) return state;

      // 声明了内置货格/换层站台绑定时，参数变化与绑定副作用（创建/删除/维度派生）合并为单条快照命令，保证 undo 整体回滚。
      const command = getBuiltInSlotBindingConfig(entity) || getLayerChangePlatformBindingConfig(entity)
        ? updateSceneDocumentCommand('更新模型参数', (scene) => applyLayerChangePlatformSideEffects(
            applyBuiltInSlotSideEffects(
              updateModelParameterValuesCommand(entity.id, before, after).execute(scene),
              entity.id,
            ),
            entity.id,
          ))
        : updateModelParameterValuesCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  previewSelectedModelParameterValue: (key, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '预览模型参数');
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!isRuntimeEntityEditable(state.scene, entity) || !modelAsset?.parameterConfig) return state;

      const sanitizedValue = sanitizeSelectedModelParameterValue(state, key, value);
      if (sanitizedValue === null) return state;

      const before = getSelectedModelParameterValues(state);
      if (!before) return state;

      const after = patchModelParameterValue(before, key, sanitizedValue);
      if (areModelParameterValuesEqual(before, after)) return state;

      const previewScene: SceneDocument = {
        ...state.scene,
        entities: {
          ...state.scene.entities,
          [entity.id]: {
            ...entity,
            components: {
              ...entity.components,
              modelAsset: {
                ...modelAsset,
                parameterValues: after,
              },
            },
          },
        },
      };

      // preview 不写撤销历史，仅同步派生货格/站台维度；创建/解绑由 commit 路径处理。
      return {
        scene: patchLayerChangePlatformDimensions(patchBuiltInSlotDimensions(previewScene, entity.id), entity.id),
      };
    });
  },
  commitSelectedModelParameterValues: (before, after) => {
    if (areModelParameterValuesEqual(before, after)) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '提交模型参数');
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!isRuntimeEntityEditable(state.scene, entity) || !modelAsset?.parameterConfig) return state;

      const sanitizedBefore = restoreModelParameterValues(modelAsset.parameterConfig, before);
      const sanitizedAfter = sanitizeEditedModelParameterValues(modelAsset.parameterConfig, before, after);
      if (areModelParameterValuesEqual(sanitizedBefore, sanitizedAfter)) return state;

      const command = getBuiltInSlotBindingConfig(entity) || getLayerChangePlatformBindingConfig(entity)
        ? updateSceneDocumentCommand('更新模型参数', (scene) => applyLayerChangePlatformSideEffects(
            applyBuiltInSlotSideEffects(
              updateModelParameterValuesCommand(entity.id, sanitizedBefore, sanitizedAfter).execute(scene),
              entity.id,
            ),
            entity.id,
          ))
        : updateModelParameterValuesCommand(entity.id, sanitizedBefore, sanitizedAfter);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  previewEntityTransform: (entityId, transform) => {
    if (!isFiniteTransform(transform)) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '预览变换');
      const entity = state.scene.entities[entityId];
      if (!isRuntimeEntityEditable(state.scene, entity)) return state;
      if (entity.components.locator?.builtInBinding) return state;

      const normalizedTransform = normalizeTransformForEntity(entity, transform);
      if (areTransformsEqual(entity.components.transform, normalizedTransform)) return state;

      return {
        scene: {
          ...state.scene,
          entities: {
            ...state.scene.entities,
            [entityId]: {
              ...entity,
              components: {
                ...entity.components,
                transform: normalizedTransform,
              },
            },
          },
        },
      };
    });
  },
  commitEntityTransform: (entityId, before, after) => {
    if (!isFiniteTransform(before) || !isFiniteTransform(after)) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '提交变换');
      const entity = state.scene.entities[entityId];
      if (!isRuntimeEntityEditable(state.scene, entity)) return state;
      if (entity.components.locator?.builtInBinding) return state;

      const normalizedBefore = normalizeTransformForEntity(entity, before);
      const normalizedAfter = normalizeTransformForEntity(entity, after);
      if (areTransformsEqual(normalizedBefore, normalizedAfter)) return state;

      const command = updateTransformCommand(entityId, normalizedBefore, normalizedAfter);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  commitFolderGroupTranslation: (input) => {
    let committed = false;
    set((state) => {
      if (isRuntimePreviewState(state)) {
        return guardRuntimePreviewMutation(state, '移动文件夹对象');
      }

      const result = commitFolderGroupTranslationState(
        state.scene,
        state.history,
        state.hierarchySelectionIds,
        input,
      );
      committed = result.committed;
      if (!result.committed) {
        return { logs: prependLog(state.logs, result.message) };
      }

      return {
        scene: result.scene,
        history: result.history,
        hierarchySelectionIds: state.hierarchySelectionIds,
        selectedModelMeasurement: null,
        logs: prependLog(state.logs, result.message),
      };
    });
    return committed;
  },
  commitFolderGroupRotation: (input) => {
    let committed = false;
    set((state) => {
      if (isRuntimePreviewState(state)) {
        return guardRuntimePreviewMutation(state, '旋转文件夹对象');
      }

      const normalizedInput = {
        ...input,
        beforeTransforms: normalizeGroupRotationTransforms(
          state.scene,
          input.entityIds,
          input.beforeTransforms,
        ),
        afterTransforms: normalizeGroupRotationTransforms(
          state.scene,
          input.entityIds,
          input.afterTransforms,
        ),
      };
      const result = commitFolderGroupRotationState(
        state.scene,
        state.history,
        state.hierarchySelectionIds,
        normalizedInput,
      );
      committed = result.committed;
      if (!result.committed) {
        return { logs: prependLog(state.logs, result.message) };
      }

      return {
        scene: result.scene,
        history: result.history,
        hierarchySelectionIds: state.hierarchySelectionIds,
        selectedModelMeasurement: null,
        logs: prependLog(state.logs, result.message),
      };
    });
    return committed;
  },
  commitHierarchyGroupTranslation: (input) => {
    let committed = false;
    set((state) => {
      if (isRuntimePreviewState(state)) {
        return guardRuntimePreviewMutation(state, '移动选中对象');
      }

      const result = commitHierarchyGroupTranslationState(
        state.scene,
        state.history,
        state.hierarchySelectionIds,
        input,
      );
      committed = result.committed;
      if (!result.committed) {
        return { logs: prependLog(state.logs, result.message) };
      }

      return {
        scene: result.scene,
        history: result.history,
        hierarchySelectionIds: state.hierarchySelectionIds,
        selectedModelMeasurement: null,
        logs: prependLog(state.logs, result.message),
      };
    });
    return committed;
  },
  commitHierarchyGroupRotation: (input) => {
    let committed = false;
    set((state) => {
      if (isRuntimePreviewState(state)) {
        return guardRuntimePreviewMutation(state, '旋转选中对象');
      }

      const result = commitHierarchyGroupRotationState(
        state.scene,
        state.history,
        state.hierarchySelectionIds,
        {
          ...input,
          beforeTransforms: normalizeGroupRotationTransforms(
            state.scene,
            input.entityIds,
            input.beforeTransforms,
          ),
          afterTransforms: normalizeGroupRotationTransforms(
            state.scene,
            input.entityIds,
            input.afterTransforms,
          ),
        },
      );
      committed = result.committed;
      if (!result.committed) {
        return { logs: prependLog(state.logs, result.message) };
      }

      return {
        scene: result.scene,
        history: result.history,
        hierarchySelectionIds: state.hierarchySelectionIds,
        selectedModelMeasurement: null,
        logs: prependLog(state.logs, result.message),
      };
    });
    return committed;
  },
  previewSelectedTransform: (transform) => {
    const selectedId = get().scene.selectedEntityId;
    if (!selectedId) return;

    get().previewEntityTransform(selectedId, transform);
  },
  commitSelectedTransform: (before, after) => {
    const selectedId = get().scene.selectedEntityId;
    if (!selectedId) return;

    get().commitEntityTransform(selectedId, before, after);
  },
  undo: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '撤销');
      const result = undoCommand(state.scene, state.history);
      if (result.history === state.history) return state;

      const hierarchySelectionIds = result.scene.selectedEntityId ? [result.scene.selectedEntityId] : [];
      return {
        ...result,
        hierarchySelectionIds,
        selectedAutoPatrolWaypointId: sanitizeSelectedAutoPatrolWaypointId(
          result.scene,
          state.selectedAutoPatrolWaypointId,
        ),
        autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        environmentApplyRequest: null,
        environmentAdjustmentActive: false,
        environmentFocusRequest: null,
        logs: prependLog(state.logs, 'Undo'),
      };
    });
  },
  redo: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '重做');
      const result = redoCommand(state.scene, state.history);
      if (result.history === state.history) return state;

      const hierarchySelectionIds = result.scene.selectedEntityId ? [result.scene.selectedEntityId] : [];
      return {
        ...result,
        hierarchySelectionIds,
        selectedAutoPatrolWaypointId: sanitizeSelectedAutoPatrolWaypointId(
          result.scene,
          state.selectedAutoPatrolWaypointId,
        ),
        autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        environmentApplyRequest: null,
        environmentAdjustmentActive: false,
        environmentFocusRequest: null,
        logs: prependLog(state.logs, 'Redo'),
      };
    });
  },
  newScene: () => {
    let opened = false;
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '新建场景');
      opened = true;
      return createLoadedSceneState(state, createEmptySceneDocument(), '已新建空白场景。');
    });
    if (opened) void syncDataPlatformEnvironmentsAfterWorkspaceOpen(get, (message) => get().pushLog(message));
  },
  hasUnsavedChanges: () => {
    const state = get();
    return serializeScene(state.scene) !== state.persistedSceneContent;
  },
  markScenePersisted: (content) => {
    const persistedSceneContent = content ?? serializeScene(get().scene);
    set({ persistedSceneContent });
  },
  saveScene: async () => {
    if (get().latestSceneResourceTransaction) {
      get().pushLog('新版模型尚未完成渲染校验，请等待同步完成后保存。');
      return false;
    }
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '保存场景'));
      return false;
    }

    const sceneSnapshot = get().scene;

    try {
      const content = serializeScene(sceneSnapshot);
      const result = await window.editorApi.saveScene({
        suggestedName: `${sceneSnapshot.name}.scene.json`,
        content,
      });

      if (result.canceled) {
        set((state) => ({ logs: prependLog(state.logs, '已取消保存场景。') }));
        return false;
      }

      set((state) => ({
        persistedSceneContent: content,
        logs: prependLog(state.logs, `场景已保存：${result.filePath ?? '未知路径'}`),
      }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `保存场景失败：${message}`) }));
      return false;
    }
  },
  loadScene: async () => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '加载场景'));
      return false;
    }

    const openingSceneSessionId = get().sceneSessionId;
    try {
      const result = await window.editorApi.loadScene();
      if (get().sceneSessionId !== openingSceneSessionId) return false;

      if (result.canceled || result.content === null) {
        set((state) => ({ logs: prependLog(state.logs, '已取消加载场景。') }));
        return false;
      }

      const scene = deserializeScene(result.content);
      const sceneOpenToken = result.sceneOpenToken;
      if (typeof sceneOpenToken !== 'number' || !Number.isSafeInteger(sceneOpenToken) || sceneOpenToken <= 0
        || !window.editorApi.confirmSceneOpen) throw new Error('当前编辑器缺少场景打开确认能力，请更新编辑器。');
      if (!await window.editorApi.confirmSceneOpen({ sceneOpenToken })
        || get().sceneSessionId !== openingSceneSessionId) return false;

      set((state) => {
        const loaded = createLoadedSceneState(state, scene, `场景已加载：${result.filePath ?? scene.name}`);
        return { ...loaded, sceneResourcePolicy: 'local-refresh',
          sceneSourceFilePath: result.filePath ?? null,
          sceneStartupResourceSessionId: loaded.sceneSessionId,
          environmentStartupRelinkSessionId: scene.sceneSettings.environment ? loaded.sceneSessionId : null };
      });
      void syncDataPlatformImagesAfterLocalSceneLoad((message) => get().pushLog(message));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (get().sceneSessionId !== openingSceneSessionId) return false;
      set((state) => ({ logs: prependLog(state.logs, `加载场景失败：${message}`) }));
      return false;
    }
  },
  loadSceneFromFile: async (filePath, isCurrent = () => true, deferEnvironmentUntilSync = false) => {
    if (!isCurrent()) return false;
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '加载最近场景'));
      return false;
    }

    const openingSceneSessionId = get().sceneSessionId;
    try {
      if (!window.editorApi?.loadSceneFile) {
        throw new Error('按路径加载场景需要 Electron 桌面环境。');
      }

      const result = await window.editorApi.loadSceneFile({ filePath });
      if (!isCurrent() || get().sceneSessionId !== openingSceneSessionId) return false;

      if (result.canceled || result.content === null) {
        set((state) => ({ logs: prependLog(state.logs, '已取消加载场景。') }));
        return false;
      }

      const scene = deserializeScene(result.content);
      const sceneOpenToken = result.sceneOpenToken;
      if (typeof sceneOpenToken !== 'number' || !Number.isSafeInteger(sceneOpenToken) || sceneOpenToken <= 0
        || !window.editorApi.confirmSceneOpen) throw new Error('当前编辑器缺少场景打开确认能力，请更新编辑器。');
      if (!await window.editorApi.confirmSceneOpen({ sceneOpenToken })
        || !isCurrent() || get().sceneSessionId !== openingSceneSessionId) return false;
      set((state) => {
        const loaded = createLoadedSceneState(state, scene, `场景已加载：${result.filePath ?? scene.name}`);
        return { ...loaded,
          sceneResourcePolicy: deferEnvironmentUntilSync ? 'data-platform-refresh' : 'local-refresh',
          sceneSourceFilePath: result.filePath ?? filePath,
          sceneStartupResourceSessionId: loaded.sceneSessionId,
          environmentStartupRelinkSessionId: scene.sceneSettings.environment ? loaded.sceneSessionId : null };
      });
      void syncDataPlatformImagesAfterLocalSceneLoad((message) => get().pushLog(message));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isCurrent() || get().sceneSessionId !== openingSceneSessionId) return false;
      set((state) => ({ logs: prependLog(state.logs, `加载最近场景失败：${message}`) }));
      return false;
    }
  },
  loadSceneFromContent: (content, sourceName) => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '加载内置场景'));
      return false;
    }

    try {
      const scene = deserializeScene(content);
      set((state) => createLoadedSceneState(state, scene, `场景已加载：${sourceName || scene.name}`));
      void syncDataPlatformEnvironmentsAfterWorkspaceOpen(get, (message) => get().pushLog(message));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `加载内置场景失败：${message}`) }));
      return false;
    }
  },
  pushLog: (message) => {
    set((state) => ({ logs: prependLog(state.logs, message) }));
  },
});
