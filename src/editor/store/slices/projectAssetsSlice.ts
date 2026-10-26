import { createModelTypeIdentityFromAsset } from '../../../../electron/shared/modelTypeIdentity';
import { executeCommand } from '../../commands/CommandHistory';
import { createEntityCommand, updateSceneDocumentCommand, updateSceneEnvironmentCommand } from '../../commands/entityCommands';
import { createId } from '../../../shared/ids';
import type { Entity } from '../../model/Entity';
import { createDefaultSceneEnvironmentTransform, createCadReferenceEntity, createModelEntity, createSkyboxComponent, getSceneSkyboxSettings, sanitizeSceneEnvironment, sanitizeSceneSkybox } from '../../model/SceneDocument';
import { createIdleEnvironmentRuntimeSnapshot, hasManagedEnvironmentCacheReference, resolveEnvironmentRuntimeSettings, type EnvironmentApplyRequest } from '../../model/environmentRuntime';
import { normalizeModelParameterConfig } from '../../model/modelParameters';
import { createModelLengthUnitInfo, type ModelLengthUnitInfo } from '../../model/sceneUnits';
import { deserializeScene } from '../../project/SceneSerializer';
import { CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES, createCadReferenceComponentMetadata, rememberCadReferenceParseResult, consumeCadReferenceParseResult } from '../../cad/cadReferenceCore';
import { formatCadReferenceUnitSummary } from '../../cad/cadUnits';
import { parseCadReferenceDxfForImport } from '../../cad/cadReferenceWorkerClient';
import { cancelCadReferenceLoad, waitForCadReferenceReady, selectCadReferenceRuntimeProgress, type CadReferenceLoadStatus } from '../../cad/cadReferenceLoadStatus';
import { isRuntimePreviewState, guardRuntimePreviewMutation, prependLog } from './editorMutationGuard';
import { isSceneEnvironmentEqual, sanitizeVector3 } from './entityValueOperations';
import { isSceneSkyboxEqual, upsertSkyboxEntityInScene, removeSkyboxEntitiesFromScene } from './sceneEnvironmentOperations';
import { sanitizeHierarchySelection, resolveSelectionTransformMode, getSelectedEntity, isRuntimeEntityEditable } from './selectionOperations';
import { areJsonValuesEqual, refreshSceneModelAssetsFromImportedAssets } from './projectAssetRefresh';
import { createCadImportProgress, readCadResponseText } from './cadImportOperations';
import { createLoadedSceneState } from './sceneSessionState';
import type { EditorSlice } from './editorStoreTypes';

let activeCadImport: { id: string; controller: AbortController } | null = null;

const cadRuntimeLoads = new Map<string, CadReferenceLoadStatus>();

/** 资源导入、环境应用及 CAD 加载会话。 */
export const createProjectAssetsSlice: EditorSlice<
  "environmentApplyRequest" |
  "environmentRuntimeOverride" |
  "environmentRuntimeSnapshot" |
  "environmentAdjustmentActive" |
  "environmentFocusRequest" |
  "cadImportProgress" |
  "updateEnvironmentConfig" |
  "requestEnvironmentApply" |
  "completeEnvironmentApply" |
  "failEnvironmentApply" |
  "setEnvironmentRuntimeSnapshot" |
  "updateEnvironmentDisplay" |
  "previewEnvironmentTransform" |
  "commitEnvironmentTransform" |
  "setEnvironmentAdjustmentActive" |
  "requestEnvironmentFocus" |
  "consumeEnvironmentFocusRequest" |
  "convertLegacyEnvironmentToSceneBase" |
  "updateSkyboxConfig" |
  "applyPreparedSkyboxEnvironment" |
  "placeSkybox" |
  "updateSelectedSkybox" |
  "setEnvironmentActiveVariant" |
  "importModelAsset" |
  "refreshModelInstancesFromAssets" |
  "reportCadReferenceRuntimeLoad" |
  "cancelCadImport" |
  "dismissCadImportProgress" |
  "importCadReference" |
  "loadSceneAsset"
> = (set, get, api) => ({
  environmentApplyRequest: null,
  environmentRuntimeOverride: null,
  environmentRuntimeSnapshot: createIdleEnvironmentRuntimeSnapshot(),
  environmentAdjustmentActive: false,
  environmentFocusRequest: null,
  cadImportProgress: null,
  updateEnvironmentConfig: (environment) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改环境模型');
      const before = state.scene.sceneSettings.environment;
      const nextEnvironment = sanitizeSceneEnvironment(environment);
      if (isSceneEnvironmentEqual(before, nextEnvironment)) return state;

      const historyBefore = resolveEnvironmentRuntimeSettings(
        before,
        state.environmentRuntimeOverride,
        { deferManagedCacheLoad: state.environmentStartupRelinkSessionId === state.sceneSessionId },
      );
      const command = updateSceneEnvironmentCommand('更新环境模型', historyBefore, nextEnvironment);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        environmentApplyRequest: null,
        environmentRuntimeOverride: null,
        environmentStartupRelinkSessionId: null,
        environmentAdjustmentActive: false,
        environmentRuntimeSnapshot: nextEnvironment
          ? state.environmentRuntimeSnapshot
          : createIdleEnvironmentRuntimeSnapshot(),
        logs: prependLog(state.logs, nextEnvironment ? '环境模型已更新。' : '环境模型已清除。'),
      };
    });
  },
  requestEnvironmentApply: (environment, options = {}) => {
    let requestId: string | null = null;
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '加载环境模型');
      if (options.expectedSceneSessionId && options.expectedSceneSessionId !== state.sceneSessionId) return state;
      if (
        options.expectedEnvironmentState
        && (
          !isSceneEnvironmentEqual(
            state.scene.sceneSettings.environment,
            options.expectedEnvironmentState.environment,
          )
          || (state.environmentApplyRequest?.id ?? null) !== options.expectedEnvironmentState.applyRequestId
        )
      ) return state;
      const normalized = sanitizeSceneEnvironment(environment);
      if (!normalized) {
        return { logs: prependLog(state.logs, '环境模型配置无效，未开始加载。') };
      }

      const explicitRuntimeEnvironment = options.runtimeEnvironment
        ? sanitizeSceneEnvironment(options.runtimeEnvironment)
        : null;
      if (options.runtimeEnvironment && !explicitRuntimeEnvironment) {
        return { logs: prependLog(state.logs, '环境模型当前缓存配置无效，未开始加载。') };
      }
      if (
        state.environmentStartupRelinkSessionId === state.sceneSessionId
        && hasManagedEnvironmentCacheReference(normalized)
        && !explicitRuntimeEnvironment
      ) {
        return {
          logs: prependLog(state.logs, '环境模型正在重关联当前缓存，已阻止加载旧机器路径。'),
        };
      }

      const resolvedRuntimeEnvironment = explicitRuntimeEnvironment
        ? explicitRuntimeEnvironment
        : resolveEnvironmentRuntimeSettings(normalized, state.environmentRuntimeOverride);
      const runtimeEnvironment = explicitRuntimeEnvironment
        ? explicitRuntimeEnvironment
        : resolvedRuntimeEnvironment && !isSceneEnvironmentEqual(normalized, resolvedRuntimeEnvironment)
          ? resolvedRuntimeEnvironment
          : undefined;

      requestId = createId('environment-load');
      const request: EnvironmentApplyRequest = {
        id: requestId,
        environment: normalized,
        autoAlign: options.autoAlign === true,
        focusAfterLoad: options.focusAfterLoad === true,
        commandLabel: options.commandLabel?.trim() || '更新环境模型',
        successMessage: options.successMessage?.trim() || '环境模型已更新。',
        persistSceneChange: options.persistSceneChange !== false,
        preserveSceneResourceUrls: options.preserveSceneResourceUrls === true,
        runtimeEnvironment,
      };
      return {
        environmentApplyRequest: request,
        environmentAdjustmentActive: false,
        environmentRuntimeSnapshot: {
          ...state.environmentRuntimeSnapshot,
          phase: 'loading',
          requestId,
          sourceUrl: runtimeEnvironment?.activeVariantUrl ?? normalized.activeVariantUrl,
          message: '环境模型正在加载...',
        },
      };
    });
    return requestId;
  },
  completeEnvironmentApply: (requestId, applyResult) => {
    set((state) => {
      const request = state.environmentApplyRequest;
      if (!request || request.id !== requestId) return state;
      const nextEnvironment = sanitizeSceneEnvironment(applyResult.environment);
      if (!nextEnvironment) {
        return {
          environmentApplyRequest: null,
          environmentRuntimeSnapshot: {
            ...applyResult.snapshot,
            phase: 'error',
            message: '环境模型加载完成，但返回配置无效。',
          },
          logs: prependLog(state.logs, '环境模型加载失败：运行时返回配置无效。'),
        };
      }

      const before = state.scene.sceneSettings.environment;
      const historyBefore = request.persistSceneChange
        ? resolveEnvironmentRuntimeSettings(
          before,
          state.environmentRuntimeOverride,
          { deferManagedCacheLoad: state.environmentStartupRelinkSessionId === state.sceneSessionId },
        )
        : before;
      const persistedEnvironment = request.preserveSceneResourceUrls
        ? { ...nextEnvironment, activeVariantUrl: request.environment.activeVariantUrl, variants: request.environment.variants }
        : nextEnvironment;
      const command = updateSceneEnvironmentCommand(request.commandLabel, historyBefore, persistedEnvironment);
      const result = !request.persistSceneChange || isSceneEnvironmentEqual(before, persistedEnvironment)
        ? { scene: state.scene, history: state.history }
        : executeCommand(state.scene, state.history, command);
      return {
        ...result,
        environmentApplyRequest: null,
        environmentRuntimeOverride: request.persistSceneChange && !request.preserveSceneResourceUrls ? null : nextEnvironment,
        environmentStartupRelinkSessionId: null,
        environmentRuntimeSnapshot: applyResult.snapshot,
        environmentAdjustmentActive: false,
        environmentFocusRequest: request.focusAfterLoad ? { id: createId('environment-focus') } : state.environmentFocusRequest,
        logs: prependLog(state.logs, request.successMessage),
      };
    });
  },
  failEnvironmentApply: (requestId, message) => {
    set((state) => {
      if (state.environmentApplyRequest?.id !== requestId) return state;
      return {
        environmentApplyRequest: null,
        environmentRuntimeSnapshot: {
          ...state.environmentRuntimeSnapshot,
          phase: 'error',
          requestId,
          message,
        },
        logs: prependLog(state.logs, `环境模型加载失败：${message}`),
      };
    });
  },
  setEnvironmentRuntimeSnapshot: (snapshot) => {
    set((state) => {
      if (JSON.stringify(state.environmentRuntimeSnapshot) === JSON.stringify(snapshot)) return state;
      return { environmentRuntimeSnapshot: snapshot };
    });
  },
  updateEnvironmentDisplay: (patch, label) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const before = resolveEnvironmentRuntimeSettings(
        state.scene.sceneSettings.environment,
        state.environmentRuntimeOverride,
        { deferManagedCacheLoad: state.environmentStartupRelinkSessionId === state.sceneSessionId },
      );
      if (!before) return state;
      const after = sanitizeSceneEnvironment({ ...before, ...patch });
      if (!after || isSceneEnvironmentEqual(before, after)) return state;

      const command = updateSceneEnvironmentCommand(label, before, after);
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        environmentRuntimeOverride: null,
        environmentStartupRelinkSessionId: null,
        environmentAdjustmentActive: after.visible && after.opacity > 0 ? state.environmentAdjustmentActive : false,
        logs: prependLog(state.logs, label),
      };
    });
  },
  previewEnvironmentTransform: (transform) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '预览环境变换');
      const environment = resolveEnvironmentRuntimeSettings(
        state.scene.sceneSettings.environment,
        state.environmentRuntimeOverride,
        { deferManagedCacheLoad: state.environmentStartupRelinkSessionId === state.sceneSessionId },
      );
      if (!environment || environment.placementMode !== 'scene-base') return state;
      const nextEnvironment = sanitizeSceneEnvironment({ ...environment, transform });
      if (!nextEnvironment || isSceneEnvironmentEqual(environment, nextEnvironment)) return state;
      return {
        scene: {
          ...state.scene,
          sceneSettings: {
            ...state.scene.sceneSettings,
            environment: nextEnvironment,
          },
        },
        environmentRuntimeOverride: null,
        environmentStartupRelinkSessionId: null,
      };
    });
  },
  commitEnvironmentTransform: (beforeTransform, afterTransform) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '提交环境变换');
      const current = resolveEnvironmentRuntimeSettings(
        state.scene.sceneSettings.environment,
        state.environmentRuntimeOverride,
        { deferManagedCacheLoad: state.environmentStartupRelinkSessionId === state.sceneSessionId },
      );
      if (!current || current.placementMode !== 'scene-base') return state;
      const before = sanitizeSceneEnvironment({ ...current, transform: beforeTransform });
      const after = sanitizeSceneEnvironment({ ...current, transform: afterTransform });
      if (!before || !after || isSceneEnvironmentEqual(before, after)) return state;

      const command = updateSceneEnvironmentCommand('调整环境模型', before, after);
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        environmentRuntimeOverride: null,
        environmentStartupRelinkSessionId: null,
        logs: prependLog(state.logs, '环境模型 Transform 已更新。'),
      };
    });
  },
  setEnvironmentAdjustmentActive: (active) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return active
        ? guardRuntimePreviewMutation(state, '调整环境模型')
        : { environmentAdjustmentActive: false };
      const environment = state.scene.sceneSettings.environment;
      const nextActive = Boolean(
        active
        && environment?.placementMode === 'scene-base'
        && environment.visible
        && environment.opacity > 0,
      );
      if (state.environmentAdjustmentActive === nextActive) return state;
      return { environmentAdjustmentActive: nextActive };
    });
  },
  requestEnvironmentFocus: () => {
    set((state) => state.scene.sceneSettings.environment
      ? { environmentFocusRequest: { id: createId('environment-focus') } }
      : state);
  },
  consumeEnvironmentFocusRequest: (requestId) => {
    set((state) => state.environmentFocusRequest?.id === requestId
      ? { environmentFocusRequest: null }
      : state);
  },
  convertLegacyEnvironmentToSceneBase: () => {
    const state = get();
    const environment = state.scene.sceneSettings.environment;
    if (!environment || environment.placementMode !== 'legacy-left') return;
    get().requestEnvironmentApply(
      {
        ...environment,
        placementMode: 'scene-base',
        transform: createDefaultSceneEnvironmentTransform(),
      },
      {
        autoAlign: true,
        focusAfterLoad: true,
        commandLabel: '转换环境为场景底座',
        successMessage: '旧版环境已转换为场景底座。',
      },
    );
  },
  applyPreparedSkyboxEnvironment: (entityId, source, environment) => {
    set(state => {
      const current = entityId === null ? state.scene.sceneSettings.skybox : state.scene.entities[entityId]?.components.skybox;
      if (!current || ['sourcePath', 'sourceUrl', 'format', 'assetRevision', 'resolution'].some(key =>
        current[key as keyof typeof current] !== source[key as keyof typeof source])) return state;
      if (JSON.stringify(current.environment) === JSON.stringify(environment)) return state;
      // 派生资源不是一次业务编辑；保持历史和当前位姿，脏状态比较会忽略该缓存描述。
      const entity = entityId === null ? null : state.scene.entities[entityId];
      const scene = entity ? { ...state.scene, entities: { ...state.scene.entities,
        [entity.id]: { ...entity, components: { ...entity.components, skybox: { ...entity.components.skybox!, environment } } } } }
        : { ...state.scene, sceneSettings: { ...state.scene.sceneSettings,
          skybox: { ...state.scene.sceneSettings.skybox!, environment } } };
      const transaction = state.latestSceneResourceTransaction;
      const recovery = state.latestSceneResourceRecovery;
      // 同一文档的缓存写回须原子推进事务快照，否则首帧成功后仍无法结算；不接管已失配的旧事务。
      return { scene,
        ...(transaction?.after === state.scene ? { latestSceneResourceTransaction: { ...transaction, after: scene } } : {}),
        ...(recovery?.after === state.scene ? { latestSceneResourceRecovery: { ...recovery, after: scene } } : {}),
      };
    });
  },
  updateSkyboxConfig: (skybox) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改天空盒');
      const nextSkybox = sanitizeSceneSkybox(skybox);
      const currentSkybox = getSceneSkyboxSettings(state.scene);
      if (isSceneSkyboxEqual(currentSkybox, nextSkybox)) return state;

      const command = updateSceneDocumentCommand('更新天空盒', (scene) => (
        nextSkybox
          ? upsertSkyboxEntityInScene(scene, nextSkybox, { selectEntity: false }).scene
          : removeSkyboxEntitiesFromScene(scene)
      ));
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds);
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, nextSkybox ? '天空背景已更新。' : '天空背景已清除。'),
      };
    });
  },
  placeSkybox: (skybox) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '放置天空盒');
      const nextSkybox = sanitizeSceneSkybox(skybox);
      if (!nextSkybox) return state;
      let created = false;
      const command = updateSceneDocumentCommand('应用天空背景', (scene) => {
        const result = upsertSkyboxEntityInScene(scene, nextSkybox, {
          revealEntity: true,
          selectEntity: false,
        });
        created = result.created;
        return result.scene;
      });
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds);
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, created ? '天空背景已创建。' : '天空背景已更新并选中。'),
      };
    });
  },
  updateSelectedSkybox: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改天空盒');
      const entity = getSelectedEntity(state);
      const current = entity?.components.skybox;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;
      const currentSettings = getSceneSkyboxSettings(state.scene);
      if (!currentSettings) return state;
      const nextSettings = sanitizeSceneSkybox({ ...currentSettings, ...patch });
      if (!nextSettings) return state;
      const nextComponent = createSkyboxComponent(nextSettings);
      if (areJsonValuesEqual(current, nextComponent)) return state;

      const command = updateSceneDocumentCommand('更新天空盒参数', (scene) => ({
        ...scene,
        entities: {
          ...scene.entities,
          [entity.id]: {
            ...scene.entities[entity.id],
            components: { ...scene.entities[entity.id].components, skybox: nextComponent },
          },
        },
        sceneSettings: { ...scene.sceneSettings, skybox: null },
      }));
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, `${command.label}: ${entity.name}`) };
    });
  },
  setEnvironmentActiveVariant: (sourceUrl) => {
    const state = get();
    if (isRuntimePreviewState(state)) {
      set((current) => guardRuntimePreviewMutation(current, '切换环境效果'));
      return;
    }
    const environment = state.scene.sceneSettings.environment;
    if (!environment || environment.activeVariantUrl === sourceUrl) return;
    const activeVariant = environment.variants.find((variant) => variant.sourceUrl === sourceUrl);
    if (!activeVariant) return;

    get().requestEnvironmentApply(
      { ...environment, activeVariantUrl: activeVariant.sourceUrl },
      {
        autoAlign: false,
        focusAfterLoad: false,
        commandLabel: '切换环境效果',
        successMessage: `切换环境效果：${activeVariant.name}`,
      },
    );
  },
  importModelAsset: (asset, placementPosition) => {
    if (asset.kind !== 'model') return;

    const displayName = asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, '');
    const unitInfo: ModelLengthUnitInfo = createModelLengthUnitInfo(asset.lengthUnit);
    const entity = createModelEntity(
      asset.path,
      asset.sourceUrl,
      displayName,
      unitInfo,
      sanitizeVector3(placementPosition),
      normalizeModelParameterConfig(asset.parameterConfig) ?? undefined,
      asset.scriptAssets,
      asset.parameterScriptMetadata,
      asset.animationScriptMetadata,
      asset.defaultAssetCode,
      asset.assetRevision,
      asset.dataDrivenConfig,
      asset.builtInSlotBindingConfig,
      asset.layerChangePlatformBindingConfig,
      asset.runtimeCapabilities,
    );
    const modelIdentity = createModelTypeIdentityFromAsset(asset);
    if (modelIdentity && entity.components.modelAsset) entity.components.modelAsset.dataPlatformModel = modelIdentity;
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '导入模型');
      const result = executeCommand(state.scene, state.history, command);
      const hierarchySelectionIds = [entity.id];
      return {
        ...result,
        hierarchySelectionIds,
        ...resolveSelectionTransformMode(state, result.scene, hierarchySelectionIds),
        logs: prependLog(state.logs, `导入模型：${asset.name}`),
      };
    });
  },
  refreshModelInstancesFromAssets: (assets, options = {}) => {
    let refreshedCount = 0;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '刷新模型实例');
      const refreshResult = refreshSceneModelAssetsFromImportedAssets(state.scene, assets, options.preserveResolvedSnapshots);
      refreshedCount = refreshResult.refreshedCount;
      if (refreshResult.scene === state.scene) return state;

      const command = updateSceneDocumentCommand('刷新导入模型', () => refreshResult.scene);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(
          state.logs,
          refreshedCount > 0
            ? `已刷新 ${refreshedCount} 个场景模型实例${refreshResult.detachedMotionInstanceCount > 0 ? `，并拆分 ${refreshResult.detachedMotionInstanceCount} 个 motion 合批实例` : ''}。`
            : `已拆分 ${refreshResult.detachedMotionInstanceCount} 个 motion 合批实例。`,
        ),
      };
    });

    return refreshedCount;
  },
  reportCadReferenceRuntimeLoad: (status) => {
    const state = get();
    for (const [entityId, current] of cadRuntimeLoads) {
      if (state.scene.entities[entityId]?.components.cadReference?.sourceUrl !== current.sourceUrl) cadRuntimeLoads.delete(entityId);
    }
    if (activeCadImport || state.scene.entities[status.entityId]?.components.cadReference?.sourceUrl !== status.sourceUrl) return;
    cadRuntimeLoads.set(status.entityId, status);
    const currentId = state.cadImportProgress?.entityId;
    const selection = selectCadReferenceRuntimeProgress([...cadRuntimeLoads.values()], currentId);
    if (!selection) return;
    const display = selection.status;
    const entity = state.scene.entities[display.entityId];
    if (!entity) return;
    const active = selection.activeCount > 0;
    const tone = active ? 'active' : display.state === 'ready' ? 'success' : display.state === 'error' ? 'error' : 'canceled';
    const label = active ? '加载 CAD 参考图（' + selection.activeCount + ' 个）' : display.state === 'ready' ? 'CAD 加载完成' : display.state === 'error' ? 'CAD 加载失败' : 'CAD 加载已取消';
    set({ cadImportProgress: { ...createCadImportProgress(display.entityId, display.percent, label, display.detail, entity.name, tone), entityId: display.entityId } });
  },
  cancelCadImport: () => {
    if (activeCadImport) {
      activeCadImport.controller.abort();
      const progress = get().cadImportProgress;
      if (progress?.entityId) cancelCadReferenceLoad(progress.entityId);
    } else {
      for (const status of [...cadRuntimeLoads.values()]) {
        if (status.state === 'loading' || status.state === 'rendering') cancelCadReferenceLoad(status.entityId);
      }
    }
  },
  dismissCadImportProgress: () => {
    if (!get().cadImportProgress?.active) { cadRuntimeLoads.clear(); set({ cadImportProgress: null }); }
  },
  importCadReference: async () => {
    if (get().runtimeMode === 'preview') {
      set(state => guardRuntimePreviewMutation(state, '导入 CAD'));
      return;
    }
    if (get().cadImportProgress?.active) {
      set(state => ({ logs: prependLog(state.logs, 'CAD 正在导入，请等待当前任务完成。') }));
      return;
    }
    if (!window.editorApi?.importCadFile) {
      set(state => ({ logs: prependLog(state.logs, '导入 CAD 需要 Electron 桌面环境。') }));
      return;
    }
    const id = crypto.randomUUID();
    const sessionId = get().sceneSessionId;
    const controller = new AbortController();
    activeCadImport = { id, controller };
    let importedEntity: Entity | null = null;
    let importCommand: ReturnType<typeof createEntityCommand> | null = null;
    let cachedSource: { url: string; scale: number } | null = null;
    const unsubscribe = api.subscribe(state => {
      if (state.sceneSessionId !== sessionId) controller.abort();
    });
    const assertCurrent = (): void => {
      if (controller.signal.aborted || get().sceneSessionId !== sessionId) {
        const error = new Error('CAD 导入已取消。'); error.name = 'AbortError'; throw error;
      }
    };
    try {
      set({ cadImportProgress: createCadImportProgress(id, 0, '选择 CAD 文件', '等待选择 .dxf 文件...', null) });
      const result = await window.editorApi.importCadFile();
      assertCurrent();
      if (result.canceled || !result.filePath || !result.sourceUrl) {
        controller.abort();
        const error = new Error('CAD 导入已取消。'); error.name = 'AbortError'; throw error;
      }
      const sourceUrl = result.sourceUrl;
      const displayName = result.filePath.split(/[\\/]/).pop()?.replace(/\.dxf$/i, '') || 'CAD参考图';
      set({ cadImportProgress: createCadImportProgress(id, 5, '准备读取 CAD', '正在打开 ' + displayName + '...', displayName) });
      const parseResult = await parseCadReferenceDxfForImport({
        sourceUrl, fileSizeBytes: result.fileSizeBytes, signal: controller.signal,
        readSmallFileText: async onProgress => {
          const response = await fetch(sourceUrl, { signal: controller.signal });
          if (!response.ok) throw new Error('读取 CAD 文件失败：HTTP ' + response.status);
          return readCadResponseText(response, result.fileSizeBytes, onProgress);
        },
        onProgress: ({ percent, detail }) => {
          if (controller.signal.aborted || get().sceneSessionId !== sessionId) return;
          set({ cadImportProgress: createCadImportProgress(id, Math.min(89, percent * 0.9), '解析 CAD 图元', detail, displayName) });
        },
      });
      assertCurrent();
      rememberCadReferenceParseResult(sourceUrl, parseResult);
      cachedSource = { url: sourceUrl, scale: parseResult.unitScaleToMeters };
      const entity = createCadReferenceEntity(result.filePath, sourceUrl, displayName,
        createCadReferenceComponentMetadata(parseResult, { sourceFileSizeBytes: result.fileSizeBytes,
          importMode: result.fileSizeBytes >= CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES ? 'large-preview' : 'exact' }));
      importedEntity = entity;
      const command = createEntityCommand(entity);
      importCommand = command;
      set(state => {
        const commandResult = executeCommand(state.scene, state.history, command);
        const hierarchySelectionIds = [entity.id];
        return { ...commandResult, hierarchySelectionIds,
          ...resolveSelectionTransformMode(state, commandResult.scene, hierarchySelectionIds),
          cadImportProgress: { ...createCadImportProgress(id, 90, '构建 CAD 线稿', '正在分批创建参考层...', displayName), entityId: entity.id } };
      });
      await waitForCadReferenceReady(entity.id, { signal: controller.signal, onProgress: status => {
        if (controller.signal.aborted || get().sceneSessionId !== sessionId) return;
        set({ cadImportProgress: { ...createCadImportProgress(id, Math.max(90, status.percent), '构建 CAD 线稿', status.detail, displayName), entityId: entity.id } });
      } });
      assertCurrent();
      set(state => ({
        cadImportProgress: { ...createCadImportProgress(id, 100, '导入完成', 'CAD 参考图已显示。', displayName, 'success'), entityId: entity.id },
        logs: prependLog(state.logs, '导入CAD参考图：' + displayName + '，' + formatCadReferenceUnitSummary(parseResult)
          + '，' + parseResult.polylineCount + ' 条折线，' + parseResult.pointCount + ' 个点'),
      }));
    } catch (error) {
      if (cachedSource) consumeCadReferenceParseResult(cachedSource.url, cachedSource.scale);
      if (importedEntity) cancelCadReferenceLoad(importedEntity.id);
      if (get().sceneSessionId !== sessionId) return;
      const canceled = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const message = canceled ? 'CAD 导入已取消。' : error instanceof Error ? error.message : String(error);
      const entity = importedEntity, command = importCommand;
      set(state => {
        const scene = entity && command && state.scene.entities[entity.id] ? command.undo(state.scene) : state.scene;
        const hierarchySelectionIds = state.hierarchySelectionIds.filter(entityId => entityId !== entity?.id && Boolean(scene.entities[entityId]));
        return { scene, hierarchySelectionIds,
          history: command ? { undoStack: state.history.undoStack.filter(item => item !== command), redoStack: state.history.redoStack.filter(item => item !== command) } : state.history,
          cadImportProgress: createCadImportProgress(id, state.cadImportProgress?.percent ?? 0, canceled ? '导入已取消' : '导入失败', message, state.cadImportProgress?.fileName ?? null, canceled ? 'canceled' : 'error'),
          logs: prependLog(state.logs, (canceled ? '取消导入 CAD：' : '导入 CAD 失败：') + message),
        };
      });
    } finally {
      unsubscribe();
      if (activeCadImport?.id === id) activeCadImport = null;
    }
  },
  loadSceneAsset: async (asset) => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '加载资产场景'));
      return;
    }

    if (asset.kind !== 'scene') return;

    try {
      const result = await window.editorApi.readTextFile({ filePath: asset.path });
      const scene = deserializeScene(result.content);

      set((state) => {
        if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '加载资产场景');
        return createLoadedSceneState(state, scene, `场景已加载：${asset.name}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `加载资产场景失败：${message}`) }));
    }
  },
});
