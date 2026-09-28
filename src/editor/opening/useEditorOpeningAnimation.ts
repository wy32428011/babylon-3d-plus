import { useCallback, useEffect, useRef, useState } from 'react';
import type { SceneDocument } from '../model/SceneDocument';
import { normalizeSceneOpeningAnimation } from '../model/sceneOpeningAnimation';
import { useEditorStore } from '../store/editorStore';
import type { BabylonViewport } from '../../runtime/babylon/createEngine';
import type { SceneRuntime } from '../../runtime/babylon/SceneRuntime';
import type { OpeningSnapshot } from '../../runtime/opening/GeographicOpeningRuntime';
import { applySavedSceneCameraView } from '../../runtime/babylon/sceneCameraView';
import { createSceneOpeningPlayback } from '../../shared/opening/createSceneOpeningPlayback';
import type { OpeningPlaybackCoordinator, OpeningTerminal } from '../../shared/opening/OpeningPlaybackCoordinator';

export function useEditorOpeningAnimation(options: {
  viewport: BabylonViewport | null; runtime: SceneRuntime | null; ready: boolean;
  sceneDocument: SceneDocument; sceneSessionId: string; isRuntimePreview: boolean;
  beforeStart(): void;
  onTerminal?(result: OpeningTerminal): void;
}) {
  const { viewport, runtime, ready, sceneDocument, sceneSessionId, isRuntimePreview } = options;
  const settings = normalizeSceneOpeningAnimation(sceneDocument.sceneSettings.openingAnimation);
  const request = useEditorStore(state => state.openingAnimationPreviewRequest);
  const playback = useRef<OpeningPlaybackCoordinator | null>(null);
  const [active, setActive] = useState(false);
  const [snapshot, setSnapshot] = useState<OpeningSnapshot | null>(null);
  const runKey = `${sceneSessionId}:${isRuntimePreview}`;
  const [completedRunKey, setCompletedRunKey] = useState<string | null>(null);
  const played = useRef(false);
  const mounted = useRef(true);
  const latest = useRef(options);
  latest.current = options;
  const stop = useCallback(() => { playback.current?.cancel(); playback.current = null; }, []);
  const skip = useCallback(() => playback.current?.skip(), []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; playback.current?.dispose(); playback.current = null; };
  }, []);
  useEffect(() => {
    stop(); played.current = false; setCompletedRunKey(null); setSnapshot(null); setActive(false);
  }, [sceneSessionId, isRuntimePreview, stop]);
  useEffect(() => { if (!settings.enabled) stop(); }, [settings.enabled, stop]);

  const start = useCallback((restoreEditView: boolean) => {
    const current = latest.current;
    const vp = current.viewport, rt = current.runtime;
    if (!vp || !rt || !current.ready) return;
    stop();
    const config = normalizeSceneOpeningAnimation(current.sceneDocument.sceneSettings.openingAnimation);
    const originalSession = current.sceneSessionId;
    const reportFailure = (error: unknown) => {
      console.error('[编辑器开场动画]', error);
      useEditorStore.getState().pushLog(`开场动画失败，已恢复场景：${error instanceof Error ? error.message : String(error)}`);
    };
    try {
      // 相机过渡中不能读取完整视角；先保留当前帧，运行态无需编辑视角快照。
      vp.cancelCameraTransition('replaced');
      const originalView = restoreEditView
        ? { ...vp.getCameraView(), viewDistance: current.sceneDocument.sceneSettings.camera.viewDistance }
        : null;
      let session: OpeningPlaybackCoordinator;
      session = createSceneOpeningPlayback({
        viewport: vp, runtime: rt, settings: config,
        beforeStart: () => {
          latest.current.beforeStart();
          applySavedSceneCameraView(vp, current.sceneDocument.sceneSettings.camera, { animate: false, lockStandardOrientation: !current.isRuntimePreview });
        },
        onActiveChange: value => { if (mounted.current) setActive(value); },
        onProgress: value => { if (mounted.current) setSnapshot(value); },
        onTerminal: result => {
          if (originalView && mounted.current && latest.current.sceneSessionId === originalSession
            && !latest.current.isRuntimePreview && !vp.scene.isDisposed) {
            vp.applyCameraView(originalView, { animate: false });
          }
          if (mounted.current) { setSnapshot(null); setCompletedRunKey(`${originalSession}:${current.isRuntimePreview}`); }
          if (mounted.current && latest.current.sceneSessionId === originalSession) latest.current.onTerminal?.(result);
          if (playback.current === session) playback.current = null;
        },
        onError: reportFailure,
      });
      playback.current = session;
      void session.start();
    } catch (error) {
      reportFailure(error);
      if (mounted.current) {
        setActive(false); setSnapshot(null); setCompletedRunKey(`${originalSession}:${current.isRuntimePreview}`);
        latest.current.onTerminal?.('failed');
      }
    }
  }, [stop]);

  useEffect(() => {
    if (!request || request.sceneSessionId !== sceneSessionId) return;
    useEditorStore.getState().consumeOpeningAnimationPreviewRequest(request.requestId, request.sceneSessionId);
    if (request.action === 'stop') { stop(); return; }
    if (!ready) { useEditorStore.getState().pushLog('场景尚未准备完成，请加载完成后预览开场动画。'); return; }
    if (!isRuntimePreview && settings.enabled) start(true);
  }, [request, sceneSessionId, ready, isRuntimePreview, settings.enabled, start, stop]);

  useEffect(() => {
    if (!isRuntimePreview || !ready || !viewport || !runtime || played.current || !settings.enabled) return;
    played.current = true;
    start(false);
  }, [isRuntimePreview, ready, viewport, runtime, settings.enabled, start]);

  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!isRuntimePreview) stop(); else if (settings.allowSkip) skip();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [active, isRuntimePreview, settings.allowSkip, stop, skip]);

  return { active, snapshot, settings, stop, skip,
    // 编辑态预览完成不能放行下一次运行预览的巡检，避免模式切换同一提交中的竞态。
    blockAutoPatrol: isRuntimePreview && settings.enabled && (completedRunKey !== runKey || settings.afterOpening === 'stay'),
  };
}
