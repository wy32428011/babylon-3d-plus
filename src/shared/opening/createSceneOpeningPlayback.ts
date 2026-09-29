import { GeographicOpeningRuntime, type OpeningSnapshot } from '../../runtime/opening/GeographicOpeningRuntime';
import type { SceneOpeningAnimationSettings } from '../../editor/model/sceneOpeningAnimation';
import { OpeningPlaybackCoordinator, type OpeningTerminal } from './OpeningPlaybackCoordinator';

/** 只管理开场的 DOM 和可见性，不接收任何三维业务控制接口。 */
export function createSceneOpeningPlayback(options: {
  container: HTMLElement;
  settings: SceneOpeningAnimationSettings;
  waitUntilVisible?: (signal: AbortSignal) => Promise<boolean>;
  isHostVisible?: () => boolean;
  subscribeToHostVisibility?: (listener: () => void) => () => void;
  onActiveChange(active: boolean): void;
  onProgress(snapshot: OpeningSnapshot): void;
  onTerminal(result: OpeningTerminal): void;
  onError(error: unknown): void;
}): OpeningPlaybackCoordinator {
  const { container, settings } = options;
  const visibility = () => {
    const rect = container.getBoundingClientRect();
    if (document.hidden || options.isHostVisible?.() === false || !rect?.width || !rect.height
      || getComputedStyle(container).visibility === 'hidden') playback.pause();
    else playback.resume();
  };
  let resizeObserver: ResizeObserver | null = null;
  let unsubscribeHostVisibility: (() => void) | null = null;
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
      container, settings, onComplete: complete,
      onSkip: () => playback.skip(),
      onProgress: options.onProgress,
      onError: error => playback.fail(error),
    }),
    onActiveChange: active => {
      if (active) {
        document.addEventListener('visibilitychange', visibility);
        // 宿主恢复可见不能覆盖浏览器后台暂停，所有入口共用同一组可见条件。
        unsubscribeHostVisibility = options.subscribeToHostVisibility?.(visibility) ?? null;
        if (typeof ResizeObserver !== 'undefined') { resizeObserver = new ResizeObserver(visibility); resizeObserver.observe(container); }
        visibility();
      } else {
        document.removeEventListener('visibilitychange', visibility);
        unsubscribeHostVisibility?.(); unsubscribeHostVisibility = null;
        resizeObserver?.disconnect(); resizeObserver = null;
      }
      options.onActiveChange(active);
    },
    onTerminal: options.onTerminal,
    onError: options.onError,
  });
  return playback;
}
