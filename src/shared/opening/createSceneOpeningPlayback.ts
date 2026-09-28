import type { BabylonViewport } from '../../runtime/babylon/createEngine';
import type { SceneRuntime } from '../../runtime/babylon/SceneRuntime';
import { GeographicOpeningRuntime, type OpeningSnapshot } from '../../runtime/opening/GeographicOpeningRuntime';
import type { SceneOpeningAnimationSettings } from '../../editor/model/sceneOpeningAnimation';
import { OpeningPlaybackCoordinator, type OpeningTerminal } from './OpeningPlaybackCoordinator';

/** 编辑器和 Viewer 共用相机占用、可见性暂停及临时场景清理。 */
export function createSceneOpeningPlayback(options: {
  viewport: BabylonViewport;
  runtime: SceneRuntime;
  settings: SceneOpeningAnimationSettings;
  waitUntilVisible?: (signal: AbortSignal) => Promise<boolean>;
  isHostVisible?: () => boolean;
  subscribeToHostVisibility?: (listener: () => void) => () => void;
  beforeStart(): void;
  onActiveChange(active: boolean): void;
  onProgress(snapshot: OpeningSnapshot): void;
  onTerminal(result: OpeningTerminal): void;
  onError(error: unknown): void;
}): OpeningPlaybackCoordinator {
  const { viewport, runtime, settings } = options;
  const visibility = () => {
    const rect = canvas?.getBoundingClientRect();
    if (document.hidden || options.isHostVisible?.() === false || !rect?.width || !rect.height
      || (canvas && getComputedStyle(canvas).visibility === 'hidden')) playback.pause();
    else playback.resume();
  };
  const canvas = viewport.engine.getRenderingCanvas();
  let resizeObserver: ResizeObserver | null = null;
  let unsubscribeHostVisibility: (() => void) | null = null;
  const contextLost = () => playback.fail(new Error('开场播放期间 WebGL 上下文丢失，已回退普通场景。'));
  const playback = new OpeningPlaybackCoordinator({
    enabled: settings.enabled,
    waitUntilVisible: async signal => {
      const visible = await (options.waitUntilVisible?.(signal) ?? Promise.resolve(true));
      if (!visible || signal.aborted) return false;
      // React 撤去加载遮罩后，再从可见的下一帧开始计时。
      await new Promise<void>(resolve => {
        let frame = 0;
        const finish = () => { cancelAnimationFrame(frame); signal.removeEventListener('abort', finish); resolve(); };
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
        else frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
      });
      return !signal.aborted;
    },
    createRuntime: complete => new GeographicOpeningRuntime({
      scene: viewport.scene, settings, onComplete: complete,
      onSkip: () => playback.skip(),
      onProgress: options.onProgress,
      onError: error => playback.fail(error),
    }),
    onActiveChange: active => {
      if (active) {
        options.beforeStart();
        viewport.cancelCameraTransition('replaced');
        runtime.setOpeningCameraOwned(true);
        viewport.setCameraControlsEnabled(false);
        document.addEventListener('visibilitychange', visibility);
        // 宿主恢复可见不能覆盖浏览器后台暂停，所有入口共用同一组可见条件。
        unsubscribeHostVisibility = options.subscribeToHostVisibility?.(visibility) ?? null;
        canvas?.addEventListener('webglcontextlost', contextLost);
        if (canvas && typeof ResizeObserver !== 'undefined') { resizeObserver = new ResizeObserver(visibility); resizeObserver.observe(canvas); }
        visibility();
      } else {
        document.removeEventListener('visibilitychange', visibility);
        unsubscribeHostVisibility?.(); unsubscribeHostVisibility = null;
        canvas?.removeEventListener('webglcontextlost', contextLost);
        resizeObserver?.disconnect(); resizeObserver = null;
        runtime.setOpeningCameraOwned(false);
        viewport.setCameraControlsEnabled(true);
      }
      options.onActiveChange(active);
    },
    onTerminal: options.onTerminal,
    onError: options.onError,
  });
  return playback;
}
