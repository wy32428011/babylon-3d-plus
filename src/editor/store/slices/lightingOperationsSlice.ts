import { createId } from '../../../shared/ids';
import { getSceneLightingBakeSignature } from '../../../../electron/shared/sceneLightingBakeContract';
import { getSceneLightingConfig, getSceneAppearanceConfig } from '../../../../electron/shared/sceneLightingConfig';
import { prepareLightingManagementDraft } from '../lightingManagementState';
import { isRuntimePreviewState } from './editorMutationGuard';
import type { EditorSlice } from './editorStoreTypes';

/** 预检、成本和临时预览仅属于当前会话，不能进入场景文档与撤销栈。 */
export const createLightingOperationsSlice: EditorSlice<
  'lightingBakePreflight' | 'lightingBakePreflightRequest' | 'requestLightingBakePreflight' |
  'completeLightingBakePreflight' | 'failLightingBakePreflight' | 'lightingBakeTaskHistory' |
  'lightingBakeTaskHistoryError' | 'refreshLightingBakeTaskHistory' | 'cleanupLightingBakeTasks' |
  'lightingRuntimeDiagnostic' | 'setLightingRuntimeDiagnostic' | 'lightingShadowCosts' | 'setLightingShadowCosts' | 'lightingDraftPreview' | 'setLightingDraftPreview'
> = (set, get) => {
  let historyGeneration = 0;
  return {
    lightingBakePreflight: { phase: 'idle' },
    lightingBakePreflightRequest: null,
    requestLightingBakePreflight: () => set(state => {
      if (isRuntimePreviewState(state) || state.lightingBakeRequest || state.lightingDraftPreview) return state;
      return { lightingBakePreflightRequest: { id: createId('lighting_check'), scene: state.scene, sceneSessionId: state.sceneSessionId },
        lightingBakePreflight: { phase: 'checking', signature: getSceneLightingBakeSignature(state.scene) } };
    }),
    completeLightingBakePreflight: (id, report) => set(state => {
      const request = state.lightingBakePreflightRequest;
      if (!request || request.id !== id || request.sceneSessionId !== state.sceneSessionId || request.scene !== state.scene
        || report.signature !== getSceneLightingBakeSignature(state.scene)) return state;
      return { lightingBakePreflightRequest: null,
        lightingBakePreflight: { phase: report.issues.some(issue => issue.severity === 'error') ? 'blocked' : 'ready',
          signature: report.signature, report } };
    }),
    failLightingBakePreflight: (id, message) => set(state => {
      const request = state.lightingBakePreflightRequest;
      if (!request || request.id !== id || request.sceneSessionId !== state.sceneSessionId || request.scene !== state.scene) return state;
      return { lightingBakePreflightRequest: null, lightingBakePreflight: { phase: 'error', message } };
    }),
    lightingBakeTaskHistory: null,
    lightingBakeTaskHistoryError: null,
    refreshLightingBakeTaskHistory: async () => {
      const session = get().sceneSessionId, generation = ++historyGeneration;
      try {
        const api = typeof window !== 'undefined' ? window.editorApi : undefined;
        if (!api?.getLightingBakeHistory) return;
        const history = await api.getLightingBakeHistory();
        if (get().sceneSessionId === session && generation === historyGeneration) set({ lightingBakeTaskHistory: history, lightingBakeTaskHistoryError: null });
      } catch (error) {
        if (get().sceneSessionId === session && generation === historyGeneration) set({ lightingBakeTaskHistoryError: error instanceof Error ? error.message : String(error) });
      }
    },
    cleanupLightingBakeTasks: async taskIds => {
      const session = get().sceneSessionId;
      try {
        const api = typeof window !== 'undefined' ? window.editorApi : undefined;
        if (!api?.cleanupLightingBakeTasks) throw new Error('当前环境不支持清理烘焙临时任务。');
        await api.cleanupLightingBakeTasks([...new Set(taskIds)]);
        if (get().sceneSessionId === session) await get().refreshLightingBakeTaskHistory();
      } catch (error) {
        if (get().sceneSessionId === session) set({ lightingBakeTaskHistoryError: error instanceof Error ? error.message : String(error) });
      }
    },
    lightingRuntimeDiagnostic: null,
    setLightingRuntimeDiagnostic: diagnostic => set(state => state.lightingRuntimeDiagnostic === diagnostic ? state : { lightingRuntimeDiagnostic: diagnostic }),
    lightingShadowCosts: null,
    setLightingShadowCosts: costs => set({ lightingShadowCosts: costs }),
    lightingDraftPreview: null,
    setLightingDraftPreview: draft => {
      if (!draft) { set({ lightingDraftPreview: null }); return { ok: true }; }
      const state = get();
      if (!state.lightingManagerOpen || state.lightingBakeRequest || state.lightingBakePreflightRequest || isRuntimePreviewState(state)) {
        return { ok: false, message: '请在编辑状态且没有预检或烘焙任务时预览草稿。' };
      }
      const prepared = prepareLightingManagementDraft(state.scene, state.sceneSessionId, draft, state.lightingClassification);
      if (!prepared.ok || !prepared.scene) return prepared;
      set({ lightingDraftPreview: { baseScene: state.scene, sceneSessionId: state.sceneSessionId,
        lighting: getSceneLightingConfig(prepared.scene), appearance: getSceneAppearanceConfig(prepared.scene),
        suppressIndirect: getSceneLightingBakeSignature(prepared.scene) !== getSceneLightingBakeSignature(state.scene) },
        lightingManagerPreviewRequest: state.lightingManagerPreviewRequest + 1 });
      return { ok: true };
    },
  };
};
