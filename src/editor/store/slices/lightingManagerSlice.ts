import { normalizeEntityLightingSettings, normalizeSceneLightingBakeSettings, validateSceneLightingBakeSnapshot, getSceneLightingBakeSignature, requiresSceneLightingBake, type EntityLightingSettings } from '../../../../electron/shared/sceneLightingBakeContract';
import { prepareLightingManagementDraft } from '../lightingManagementState';
import { executeCommand } from '../../commands/CommandHistory';
import { updateSceneDocumentCommand } from '../../commands/entityCommands';
import { createId } from '../../../shared/ids';
import { isEntityEffectivelyLocked } from '../../model/entityHierarchy';
import { isRuntimePreviewState, prependLog, guardRuntimePreviewMutation } from './editorMutationGuard';
import type { EditorSlice } from './editorStoreTypes';

/** 光照管理草稿、分类与烘焙会话。 */
export const createLightingManagerSlice: EditorSlice<
  "lightingBakeRequest" |
  "lightingManagerOpen" |
  "lightingManagerTab" |
  "lightingManagerFocus" |
  "lightingManagerPreview" |
  "lightingManagerPreviewError" |
  "lightingManagerPreviewRequest" |
  "openLightingManager" |
  "closeLightingManager" |
  "setLightingManagerTab" |
  "refreshLightingManagerPreview" |
  "applyLightingManagementDraft" |
  "lightingBakeStatus" |
  "setLightingBakeRuntimeError" |
  "lightingClassification" |
  "lightingDebugVisible" |
  "lightingComparisonEnabled" |
  "lightingNodeFocusRequest" |
  "setLightingClassification" |
  "setLightingDebugVisible" |
  "setLightingComparisonEnabled" |
  "focusLightingNode" |
  "requestLightingBake" |
  "cancelLightingBake" |
  "completeLightingBake" |
  "failLightingBake" |
  "updateLightingBakeSettings" |
  "clearLightingBake" |
  "updateEntityLightingSettings" |
  "updateLightingNodeOverride"
> = (set, get) => ({
  lightingBakeRequest: null,
  lightingManagerOpen: false,
  lightingManagerTab: 'overview',
  lightingManagerFocus: null,
  lightingManagerPreview: null,
  lightingManagerPreviewError: null,
  lightingManagerPreviewRequest: 0,
  openLightingManager: options => set(state => ({
    lightingManagerOpen: true,
    lightingManagerTab: options?.tab ?? (options?.entityIds ? 'objects' : state.lightingManagerTab),
    ...(options?.entityIds ? { lightingManagerFocus: {
      entityIds: [...new Set(options.entityIds)].filter(id => id === '$environment' || Object.hasOwn(state.scene.entities, id)),
      ...(options.nodeKey ? { nodeKey: options.nodeKey } : {}),
    } } : {}),
    lightingManagerPreviewRequest: state.lightingManagerPreviewRequest + 1,
  })),
  closeLightingManager: () => set(state => ({ lightingManagerOpen: false, lightingManagerPreview: null, lightingManagerPreviewError: null,
    lightingDraftPreview: null, lightingBakePreflightRequest: null,
    // 关闭会中止视口捕获；同步释放checking，避免同场景重开后永远禁用检查与烘焙。
    ...(state.lightingBakePreflight.phase === 'checking' ? { lightingBakePreflight: { phase: 'idle' as const } } : {}),
  })),
  setLightingManagerTab: tab => set({ lightingManagerTab: tab }),
  refreshLightingManagerPreview: () => set(state => ({ lightingManagerPreviewRequest: state.lightingManagerPreviewRequest + 1 })),
  applyLightingManagementDraft: draft => {
    const state = get();
    if (isRuntimePreviewState(state)) return { ok: false, message: '请停止运行预览后再应用光照配置。' };
    if (state.lightingBakeRequest
      || ['preparing', 'baking', 'applying'].includes(state.lightingBakeStatus.phase)) {
      return { ok: false, message: '烘焙任务正在进行，请等待完成或取消后再应用配置。' };
    }
    const prepared = prepareLightingManagementDraft(state.scene, state.sceneSessionId, draft, state.lightingClassification);
    if (!prepared.ok || !prepared.scene) return prepared;
    if (prepared.scene === state.scene) { set({ lightingDraftPreview: null }); return { ok: true, message: '配置没有变化。' }; }
    const nextScene = prepared.scene;
    set(current => {
      // 验证与写入保持同步；一条编辑命令同时记录规则、参数及集中例外。
      if (current.scene !== state.scene || current.sceneSessionId !== state.sceneSessionId) return current;
      const command = updateSceneDocumentCommand('应用集中光照配置', () => nextScene);
      return { ...executeCommand(current.scene, current.history, command), lightingDraftPreview: null,
        lightingManagerPreviewRequest: current.lightingManagerPreviewRequest + 1,
        logs: prependLog(current.logs, '已应用集中光照配置；可统一撤销，受影响结果需重新烘焙。') };
    });
    return { ok: true, message: '集中光照配置已应用。' };
  },
  lightingBakeStatus: { phase: 'idle', message: null },
  setLightingBakeRuntimeError: message => set(state => {
    if (state.lightingBakeRequest) return state;
    const status = state.lightingBakeStatus;
    // 任务失败比旧运行时诊断更具体；后续轮询不能覆盖其原因或改写来源。
    if (status.phase === 'error' && status.source !== 'runtime') return state;
    if (message !== null) {
      if (status.phase === 'error' && status.source === 'runtime' && status.message === message) return state;
      return { lightingBakeStatus: { phase: 'error', message, source: 'runtime' } };
    }
    // 撤销或资源恢复只清除运行时自身的错误，不抹掉真实烘焙任务的失败原因。
    return status.phase === 'error' && status.source === 'runtime'
      ? { lightingBakeStatus: { phase: 'idle', message: null } } : state;
  }),
  lightingClassification: [],
  lightingDebugVisible: false,
  lightingComparisonEnabled: false,
  lightingNodeFocusRequest: null,
  setLightingClassification: entries => set({ lightingClassification: entries }),
  setLightingDebugVisible: visible => set({ lightingDebugVisible: visible }),
  setLightingComparisonEnabled: enabled => set({ lightingComparisonEnabled: enabled }),
  focusLightingNode: (entityId, nodeKey) => set(state => ({
    lightingNodeFocusRequest: { entityId, nodeKey, sequence: (state.lightingNodeFocusRequest?.sequence ?? 0) + 1 },
  })),
  requestLightingBake: () => set(state => {
    if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '烘焙材质与光照');
    if (state.lightingBakeRequest
      || ['preparing', 'baking', 'applying'].includes(state.lightingBakeStatus.phase)) return state;
    if (state.lightingDraftPreview) return { lightingBakeStatus: { phase: 'error', message: '请先恢复已应用配置或应用草稿，再开始烘焙。' } };
    if (!requiresSceneLightingBake(state.scene)) return { lightingBakeStatus: { phase: 'idle', message: '当前没有静态接收表面，无需烘焙；动态对象继续使用实时阴影。' } };
    if (state.environmentApplyRequest || state.environmentRuntimeSnapshot.phase === 'loading' || state.cadImportProgress?.active) {
      return { lightingBakeStatus: { phase: 'error', message: '请等待场景资源加载完成，再开始烘焙。' } };
    }
    return {
      lightingBakeRequest: { id: createId('lighting_bake') },
      lightingBakeStatus: { phase: 'preparing', message: '正在检查动静分类并准备烘焙…', progress: 0 },
    };
  }),
  cancelLightingBake: () => set(state => !state.lightingBakeRequest ? state : {
    lightingBakeRequest: null,
    lightingBakeStatus: { phase: 'cancelled', message: '烘焙已取消，保留上次有效结果。' },
  }),
  completeLightingBake: (requestId, snapshot) => set(state => {
    if (state.lightingBakeRequest?.id !== requestId) return state;
    const result = validateSceneLightingBakeSnapshot(snapshot);
    if (!result || result.signature !== getSceneLightingBakeSignature(state.scene) || isRuntimePreviewState(state)) return {
      lightingBakeRequest: null,
      lightingBakeStatus: { phase: 'error', message: '烘焙期间场景已变化或结果无效；保留上次结果，请重新烘焙。' },
    };
    const command = updateSceneDocumentCommand('更新材质与光照烘焙', scene => ({
      ...scene, sceneSettings: { ...scene.sceneSettings, lighting: { ...scene.sceneSettings.lighting, result } },
    }));
    return { ...executeCommand(state.scene, state.history, command), lightingBakeRequest: null,
      lightingBakeStatus: { phase: 'idle', message: '材质与光照烘焙已完成。', progress: 1 },
      logs: prependLog(state.logs, '材质与光照已更新：' + result.statistics.meshCount + ' 个表面，' + result.statistics.probeCount + ' 个光照探针。') };
  }),
  failLightingBake: (requestId, message) => set(state => state.lightingBakeRequest?.id !== requestId ? state : {
    lightingBakeRequest: null, lightingBakeStatus: { phase: 'error', message },
    logs: prependLog(state.logs, '材质与光照烘焙失败：' + message),
  }),
  updateLightingBakeSettings: patch => set(state => {
    if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改光照烘焙设置');
    const settings = normalizeSceneLightingBakeSettings({ ...state.scene.sceneSettings.lighting.bake, ...patch });
    if (JSON.stringify(settings) === JSON.stringify(state.scene.sceneSettings.lighting.bake)) return state;
    const command = updateSceneDocumentCommand('修改光照烘焙设置', scene => ({
      ...scene, sceneSettings: { ...scene.sceneSettings, lighting: { ...scene.sceneSettings.lighting, bake: settings } },
    }));
    return { ...executeCommand(state.scene, state.history, command), ...(state.lightingBakeRequest ? {
      lightingBakeRequest: null, lightingBakeStatus: { phase: 'cancelled' as const, message: '烘焙设置已更改，本次任务已取消。' },
    } : {}) };
  }),
  clearLightingBake: () => set(state => {
    if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '清除光照烘焙');
    const cleared = state.scene.sceneSettings.lighting.result ? executeCommand(state.scene, state.history,
      updateSceneDocumentCommand('清除光照烘焙', scene => ({ ...scene, sceneSettings: { ...scene.sceneSettings, lighting: { ...scene.sceneSettings.lighting, result: null } } }))) : {};
    return { ...cleared, lightingBakeRequest: null, lightingComparisonEnabled: false,
      lightingBakeStatus: { phase: 'idle', message: '已清除光照烘焙结果。' } };
  }),
  updateEntityLightingSettings: (entityIds, patch) => set(state => {
    if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改对象光照分类');
    const changes = new Map<string, EntityLightingSettings>();
    for (const id of new Set(entityIds)) {
      const entity = state.scene.entities[id];
      if (!entity || entity.isFolder || isEntityEffectivelyLocked(state.scene.entities, entity)) continue;
      const before = normalizeEntityLightingSettings(entity.components.lighting);
      const next = normalizeEntityLightingSettings({ ...before, ...patch });
      if (JSON.stringify(before) !== JSON.stringify(next)) changes.set(id, next);
    }
    if (!changes.size) return state;
    const command = updateSceneDocumentCommand('修改对象光照分类', scene => {
      const entities = { ...scene.entities };
      for (const [id, lighting] of changes) entities[id] = { ...entities[id], components: { ...entities[id].components, lighting } };
      return { ...scene, entities };
    });
    return { ...executeCommand(state.scene, state.history, command), ...(state.lightingBakeRequest ? {
      lightingBakeRequest: null, lightingBakeStatus: { phase: 'cancelled' as const, message: '动静分类已更改，本次任务已取消。' },
    } : {}) };
  }),
  updateLightingNodeOverride: (entityId, nodeKey, patch) => set(state => {
    if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改部件光照分类');
    const entity = state.scene.entities[entityId];
    if (!entity || isEntityEffectivelyLocked(state.scene.entities, entity) || !nodeKey || ['__proto__', 'constructor', 'prototype'].includes(nodeKey)) return state;
    const before = normalizeEntityLightingSettings(entity.components.lighting);
    const entry = state.lightingClassification.find(item => item.entityId === entityId && item.nodeKey === nodeKey && !item.unmatchedOverride);
    if (patch?.mobility === 'static' && entry?.parentDynamic) return {
      logs: prependLog(state.logs, '动态祖先会带动该部件，请先调整上级分类或实际运动关系。'),
    };
    if (patch && before.resourceIdentity && entry?.resourceIdentity && before.resourceIdentity !== entry.resourceIdentity && Object.keys(before.nodeOverrides).length) return {
      logs: prependLog(state.logs, '旧节点覆盖与当前模型资源不匹配，请先清除失配规则，再设置新部件。'),
    };
    const nodeOverrides = { ...before.nodeOverrides };
    if (patch === null) delete nodeOverrides[nodeKey];
    else nodeOverrides[nodeKey] = { ...nodeOverrides[nodeKey], ...patch, mobility: patch.mobility ?? nodeOverrides[nodeKey]?.mobility ?? 'auto' };
    const next = normalizeEntityLightingSettings({ ...before, nodeOverrides,
      ...(patch && entry?.resourceIdentity ? { resourceIdentity: entry.resourceIdentity } : {}),
    });
    if (JSON.stringify(before) === JSON.stringify(next)) return state;
    const command = updateSceneDocumentCommand('修改部件光照分类', scene => ({ ...scene, entities: {
      ...scene.entities, [entityId]: { ...scene.entities[entityId], components: { ...scene.entities[entityId].components, lighting: next } },
    } }));
    return { ...executeCommand(state.scene, state.history, command), ...(state.lightingBakeRequest ? {
      lightingBakeRequest: null, lightingBakeStatus: { phase: 'cancelled' as const, message: '部件分类已更改，本次任务已取消。' },
    } : {}) };
  }),
});
