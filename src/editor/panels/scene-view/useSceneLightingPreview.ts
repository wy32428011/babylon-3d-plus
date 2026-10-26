import { useEffect, useRef } from 'react';
import { type BabylonViewport } from '../../../runtime/babylon/createEngine';
import { type SceneRuntime } from '../../../runtime/babylon/SceneRuntime';
import { useEditorStore } from '../../store/editorStore';
import { type SceneDocument } from '../../model/SceneDocument';
import { isScenePreparationActive } from '../../loading/scenePreparationProgress';
import type { RefObject } from 'react';
type EditorState = ReturnType<typeof useEditorStore.getState>;
type Options = {
  lightingBakeRequest: EditorState['lightingBakeRequest'];
  runtimeRef: RefObject<SceneRuntime | null>;
  isRuntimePreview: boolean;
  sceneSessionId: string;
  lightingDebugVisible: boolean;
  lightingComparisonEnabled: boolean;
  lightingNodeFocusRequest: EditorState['lightingNodeFocusRequest'];
  lightingManagerOpen: boolean;
  viewportRef: RefObject<BabylonViewport | null>;
  statisticsSceneSessionRef: RefObject<string | null>;
  lightingManagerPreviewRequest: EditorState['lightingManagerPreviewRequest'];
  sceneDocument: SceneDocument;
};

/** 保留视口原有执行顺序和依赖，集中管理光照预览与烘焙。 */
export function useSceneLightingPreview({
  lightingBakeRequest, runtimeRef, isRuntimePreview, sceneSessionId, lightingDebugVisible, lightingComparisonEnabled, lightingNodeFocusRequest, lightingManagerOpen, viewportRef, statisticsSceneSessionRef, lightingManagerPreviewRequest, sceneDocument,
}: Options) {
  const preflightRequest = useEditorStore(state => state.lightingBakePreflightRequest);
  const draftPreview = useEditorStore(state => state.lightingDraftPreview);
  const managerTab = useEditorStore(state => state.lightingManagerTab);
  const inspectorSelection = useEditorStore(state => state.lightingInspectorEntityIds.join('\0'));
  const previewOwner = useRef<SceneRuntime | null>(null);
  const previousSession = useRef(sceneSessionId);

  useEffect(() => {
    const state = useEditorStore.getState();
    if (!state.lightingBakePreflightRequest || state.lightingBakePreflightRequest.scene !== sceneDocument) {
      useEditorStore.setState({ lightingBakePreflightRequest: null, lightingBakePreflight: { phase: 'idle' } });
    }
    if (previousSession.current !== sceneSessionId) {
      previousSession.current = sceneSessionId;
      useEditorStore.setState({ lightingBakeTaskHistory: null, lightingBakeTaskHistoryError: null, lightingShadowCosts: null, lightingRuntimeDiagnostic: null });
    }
  }, [sceneDocument, sceneSessionId]);

  useEffect(() => {
    if (!preflightRequest) return;
    if (preflightRequest.sceneSessionId !== sceneSessionId || preflightRequest.scene !== sceneDocument) {
      useEditorStore.setState({ lightingBakePreflightRequest: null, lightingBakePreflight: { phase: 'idle' } }); return;
    }
    const runtime = runtimeRef.current, controller = new AbortController();
    if (!runtime || isRuntimePreview) { useEditorStore.getState().failLightingBakePreflight(preflightRequest.id, '请等待编辑场景就绪后检查。'); return; }
    let active = true;
    void runtime.preflightLightingBake(sceneDocument, controller.signal).then(report => {
      if (active) useEditorStore.getState().completeLightingBakePreflight(preflightRequest.id, report);
    }).catch(error => {
      if (active) useEditorStore.getState().failLightingBakePreflight(preflightRequest.id, error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; controller.abort(); };
  }, [preflightRequest, sceneDocument, sceneSessionId, isRuntimePreview, runtimeRef]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (draftPreview && (draftPreview.baseScene !== sceneDocument || draftPreview.sceneSessionId !== sceneSessionId || !lightingManagerOpen || isRuntimePreview)) {
      useEditorStore.getState().setLightingDraftPreview(null); return;
    }
    if (!draftPreview && !previewOwner.current) return;
    const readCurrentRuntime = () => runtimeRef.current;
    let active = true;
    previewOwner.current = draftPreview ? runtime : null;
    void runtime.setLightingDraftPreview(draftPreview).then(() => {
      if (active) useEditorStore.getState().refreshLightingManagerPreview();
    }).catch(error => {
      if (active) { useEditorStore.setState({ lightingManagerPreviewError: error instanceof Error ? error.message : String(error) });
        useEditorStore.getState().setLightingDraftPreview(null); }
    });
    return () => {
      active = false;
      if (readCurrentRuntime() === runtime && previewOwner.current === runtime) {
        previewOwner.current = null;
        void runtime.setLightingDraftPreview(null).catch(error => useEditorStore.getState().pushLog('恢复临时光照预览失败：' + String(error)));
      }
    };
  }, [draftPreview, sceneDocument, sceneSessionId, lightingManagerOpen, isRuntimePreview, runtimeRef]);
  useEffect(() => {
    if (!lightingBakeRequest) return;
    const runtime = runtimeRef.current;
    const state = useEditorStore.getState();
    if (!runtime || isRuntimePreview) {
      state.failLightingBake(lightingBakeRequest.id, '请在场景编辑就绪后烘焙材质与间接光。');
      return;
    }
    // 清理时读取当前所有者，不能把已退役运行时重新同步到新场景。
    const readCurrentRuntime = () => runtimeRef.current;
    const controller = new AbortController();
    let active = true;
    void runtime.bakeLighting(state.scene, controller.signal, (message, fraction, phase) => {
      if (active) useEditorStore.setState(current => current.lightingBakeRequest?.id === lightingBakeRequest.id
        ? { lightingBakeStatus: { phase: phase === 'applying' ? 'applying' : phase === 'preparing' ? 'preparing' : 'baking', message,
          ...(fraction !== undefined ? { progress: fraction } : {}) } } : {});
    }).then(snapshot => {
      if (active) useEditorStore.getState().completeLightingBake(lightingBakeRequest.id, snapshot);
    }).catch(error => {
      if (active) useEditorStore.getState().failLightingBake(lightingBakeRequest.id, error instanceof Error ? error.message : String(error));
    });
    return () => {
      active = false; controller.abort();
      const current = useEditorStore.getState();
      if (readCurrentRuntime() === runtime) runtime.syncLighting(current.scene);
    };
  }, [lightingBakeRequest, isRuntimePreview, sceneSessionId, runtimeRef]);

  useEffect(() => {
    runtimeRef.current?.setLightingPreview(lightingDebugVisible, lightingComparisonEnabled);
  }, [lightingDebugVisible, lightingComparisonEnabled, sceneSessionId, runtimeRef]);

  useEffect(() => {
    if (lightingNodeFocusRequest) runtimeRef.current?.focusLightingNode(lightingNodeFocusRequest.entityId, lightingNodeFocusRequest.nodeKey);
  }, [lightingNodeFocusRequest, runtimeRef]);

  useEffect(() => {
    if (!lightingManagerOpen || managerTab !== 'overview') return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const scene = viewport.scene, sourceCanvas = viewport.engine.getRenderingCanvas();
    if (!sourceCanvas) return;
    const previewCanvas = document.createElement('canvas');
    const context = previewCanvas.getContext('2d');
    if (!context) {
      useEditorStore.setState({ lightingManagerPreviewError: '当前环境无法创建场景预览。' });
      return;
    }
    let active = true, failed = false;
    let observer: ReturnType<typeof scene.onAfterRenderObservable.add> | null = null;
    let timeoutId: number | undefined, refreshTimer: number | undefined;
    const clearPending = () => {
      if (observer) scene.onAfterRenderObservable.remove(observer);
      observer = null;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      timeoutId = undefined;
    };
    const ownsPreview = () => {
      const state = useEditorStore.getState();
      return active && state.lightingManagerOpen && state.sceneSessionId === sceneSessionId;
    };
    const requestPreview = () => {
      if (!ownsPreview() || observer || failed) return;
      // 直接读取刚绘制的真实视口，不创建第二套 Scene/Runtime 或改变业务姿态。
      observer = scene.onAfterRenderObservable.add(() => {
        if (!ownsPreview()) { clearPending(); return; }
        if (statisticsSceneSessionRef.current !== sceneSessionId || isScenePreparationActive()
          || runtimeRef.current?.getInitialLoadSnapshot().progress.loading
          || !scene.isReady() || sourceCanvas.width === 0 || sourceCanvas.height === 0) return;
        clearPending();
        try {
          const scale = Math.min(1, 720 / sourceCanvas.width, 450 / sourceCanvas.height);
          previewCanvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
          previewCanvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
          context.drawImage(sourceCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
          const preview = previewCanvas.toDataURL('image/webp', 0.82);
          if (ownsPreview()) useEditorStore.setState({ lightingManagerPreview: preview, lightingManagerPreviewError: null });
        } catch (error) {
          failed = true;
          if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
          if (ownsPreview()) useEditorStore.setState({ lightingManagerPreviewError: '无法生成场景预览：' + (error instanceof Error ? error.message : String(error)) });
        }
      });
      timeoutId = window.setTimeout(() => {
        clearPending();
        if (ownsPreview()) useEditorStore.setState({ lightingManagerPreviewError: '场景尚未完成绘制，请等待资源就绪后刷新预览。' });
      }, 10_000);
    };
    requestPreview();
    // 编辑时只在打开、应用、定位或主动刷新后采样；运动预览最多每秒两次。
    if (isRuntimePreview) refreshTimer = window.setInterval(requestPreview, 500);
    return () => {
      active = false; clearPending();
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
      previewCanvas.width = 0; previewCanvas.height = 0;
    };
  }, [lightingManagerOpen, managerTab, lightingManagerPreviewRequest, sceneSessionId, isRuntimePreview,
    lightingDebugVisible, lightingComparisonEnabled, lightingNodeFocusRequest, sceneDocument.sceneSettings, sceneDocument.entities, runtimeRef, viewportRef, statisticsSceneSessionRef]);

  useEffect(() => {
    let previous: ReturnType<SceneRuntime['getLightingClassification']> | null = null;
    const poll = () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      const state = useEditorStore.getState();
      // 完整分类仅由打开的管理器消费；Inspector只读取选中实体的缓存。
      if (lightingManagerOpen) {
        // 准备完成/上下文换代可替换或清空profile；只读同步沿用现有poll，不启动probe或额外分类。
        const profile = runtime.getGpuCapabilityProfile();
        if (profile !== state.lightingGpuCapabilityProfile) state.setLightingGpuCapabilityProfile(profile);
        const entries = runtime.getLightingClassification();
        if (entries !== previous) { previous = entries; state.setLightingClassification(entries); }
      }
      if (state.lightingInspectorEntityIds.length) {
        const cached = runtime.peekLightingClassificationForEntities(state.lightingInspectorEntityIds);
        if (cached.entries !== state.lightingInspectorClassification || cached.stale !== state.lightingInspectorClassificationStale) {
          useEditorStore.setState({ lightingInspectorClassification: cached.entries, lightingInspectorClassificationStale: cached.stale });
        }
      }
      state.setLightingBakeRuntimeError(runtime.getLightingBakeRuntimeError());
      state.setLightingRuntimeDiagnostic(runtime.getLightingRuntimeDiagnostic());
      if (state.lightingManagerOpen && (state.lightingManagerTab === 'overview' || state.lightingManagerTab === 'resources')) state.setLightingShadowCosts(runtime.getHybridLightingMetrics());
    };
    poll();
    const timer = window.setInterval(poll, 400);
    return () => window.clearInterval(timer);
  }, [sceneSessionId, lightingManagerOpen, inspectorSelection, runtimeRef]);
}
