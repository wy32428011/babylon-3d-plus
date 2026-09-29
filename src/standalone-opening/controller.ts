import type { OpeningController, OpeningOptions, OpeningPhase, OpeningState, OpeningStatus } from './types.ts';

type RuntimeActions = { onSkip(): void; onSeek(seconds: number): void; onPauseToggle(): void; onRestart(): void };
type OpeningRuntime = { ready: Promise<void>; render(seconds: number, paused: boolean): void; dispose(): void };
export type OpeningDependencies = {
  totalDurationSeconds: number;
  initialElapsedSeconds: number;
  allowSkip: boolean;
  now(): number;
  getFrame(seconds: number): { phase: OpeningPhase; progress: number; stageIndex: number };
  createRuntime(actions: RuntimeActions): OpeningRuntime;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, milliseconds: number): number;
  clearTimer(id: number): void;
  subscribeVisibility(listener: () => void): () => void;
  isDocumentVisible(): boolean;
  isContainerVisible(): boolean;
};

const PREPARATION_TIMEOUT_MS = 30_000;
const PROGRESS_INTERVAL_MS = 50;
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
const cancelled = (message: string): Error => Object.assign(new Error(message), { name: 'AbortError' });

/** 单一时钟负责播放意图、可见性和每轮资源生命周期，渲染器只接收确定的时间。 */
export function createOpeningController(options: OpeningOptions, dependencies: OpeningDependencies): OpeningController {
  const d = dependencies;
  let status: OpeningStatus = 'loading';
  let elapsed = d.initialElapsedSeconds;
  let wantsToPlay = options.autoplay !== false;
  let hostVisible = options.hostVisible !== false;
  let documentVisible = d.isDocumentVisible();
  let errorMessage: string | null = null;
  let generation = 0;
  let runtime: OpeningRuntime | null = null;
  let removeVisibility: (() => void) | null = null;
  let frameId: number | null = null;
  let timerId: number | null = null;
  let previousTime: number | null = null;
  let lastProgressTime = -Infinity;
  let notifyingProgress = false;
  let notifyingError = false;
  let readyPromise: Promise<void>;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;

  const isTerminal = (): boolean => status === 'completed' || status === 'skipped' || status === 'failed' || status === 'destroyed';
  const getState = (): OpeningState => ({
    ...d.getFrame(elapsed), status, elapsedSeconds: elapsed, totalDurationSeconds: d.totalDurationSeconds,
    isPaused: status === 'paused' || status === 'ready' || status === 'loading',
    hostVisible, documentVisible, error: errorMessage,
  });
  const reportError = (error: Error): void => {
    if (notifyingError) { console.error('[ZendingOpening] 错误回调重入。', error); return; }
    notifyingError = true;
    try {
      if (options.onError) options.onError(error);
      else console.error('[ZendingOpening]', error);
    } catch (callbackError) { console.error('[ZendingOpening] onError 回调执行失败。', callbackError); }
    finally { notifyingError = false; }
  };
  const notify = (callback: (() => void) | undefined): void => {
    try { callback?.(); } catch (error) { reportError(asError(error)); }
  };
  const progress = (force = false): void => {
    if (notifyingProgress) return;
    const now = d.now();
    if (!force && now - lastProgressTime < PROGRESS_INTERVAL_MS) return;
    lastProgressTime = now;
    const snapshot = getState();
    notifyingProgress = true;
    try { notify(options.onProgress ? () => options.onProgress!(snapshot) : undefined); }
    finally { notifyingProgress = false; }
  };
  const settleReady = (error?: Error): void => {
    const resolve = resolveReady, reject = rejectReady;
    resolveReady = null; rejectReady = null;
    if (error) reject?.(error); else resolve?.();
  };
  const cancelFrame = (): void => {
    if (frameId !== null) d.cancelFrame(frameId);
    frameId = null; previousTime = null;
  };
  const cleanup = (): Error[] => {
    cancelFrame();
    if (timerId !== null) d.clearTimer(timerId);
    timerId = null;
    const unsubscribe = removeVisibility, currentRuntime = runtime;
    removeVisibility = null; runtime = null;
    // 清理期间不进入宿主回调；先完成旧轮次结算，避免 onError 重播后被外层覆盖。
    const errors: Error[] = [];
    try { unsubscribe?.(); } catch (error) { errors.push(asError(error)); }
    try { currentRuntime?.dispose(); } catch (error) { errors.push(asError(error)); }
    return errors;
  };
  const fail = (error: unknown): void => {
    if (isTerminal()) return;
    const failure = asError(error);
    status = 'failed'; errorMessage = failure.message;
    const cleanupErrors = cleanup();
    settleReady(failure); progress(true); reportError(failure); cleanupErrors.forEach(reportError);
  };
  const finish = (reason: 'completed' | 'skipped'): void => {
    if (isTerminal()) return;
    status = reason;
    if (reason === 'completed') elapsed = d.totalDurationSeconds;
    const cleanupErrors = cleanup();
    settleReady(cancelled('开场准备已结束。'));
    progress(true);
    notify(options.onComplete ? () => options.onComplete!({ reason }) : undefined);
    cleanupErrors.forEach(reportError);
  };
  const render = (): boolean => {
    try { runtime?.render(elapsed, status !== 'playing'); return true; }
    catch (error) { fail(error); return false; }
  };
  const advance = (): void => {
    if (status !== 'playing') return;
    const now = d.now();
    if (previousTime !== null) elapsed = Math.min(d.totalDurationSeconds, elapsed + Math.max(0, now - previousTime) / 1000);
    previousTime = now;
    if (elapsed >= d.totalDurationSeconds) finish('completed');
  };
  const tick = (): void => {
    frameId = null;
    advance();
    if (status !== 'playing' || !render()) return;
    progress(); schedule();
  };
  const schedule = (): void => {
    if (status === 'playing' && frameId === null) frameId = d.requestFrame(tick);
  };
  const updatePlayback = (): void => {
    if (isTerminal() || status === 'loading') return;
    documentVisible = d.isDocumentVisible();
    const playing = wantsToPlay && hostVisible && documentVisible && d.isContainerVisible();
    if (playing) {
      status = 'playing';
      if (previousTime === null) previousTime = d.now();
    } else {
      status = status === 'ready' && !wantsToPlay ? 'ready' : 'paused';
      cancelFrame();
    }
    if (render()) { progress(true); schedule(); }
  };
  const visibilityChanged = (): void => {
    advance();
    documentVisible = d.isDocumentVisible();
    updatePlayback();
  };
  const play = (): void => {
    if (isTerminal() || (wantsToPlay && status === 'playing')) return;
    wantsToPlay = true; updatePlayback();
  };
  const pause = (): void => {
    if (!wantsToPlay || isTerminal()) return;
    advance();
    if (isTerminal()) return;
    wantsToPlay = false; updatePlayback();
  };

  const begin = (): void => {
    const currentGeneration = ++generation;
    readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // 自动播放使用者可以只订阅 onError；显式 await ready 仍会收到原始拒绝。
    void readyPromise.catch(() => undefined);
    try {
      removeVisibility = d.subscribeVisibility(visibilityChanged);
      runtime = d.createRuntime({
        onSkip: () => controller.skip(), onSeek: seconds => controller.seek(seconds),
        onPauseToggle: () => { if (wantsToPlay) pause(); else play(); }, onRestart: () => controller.restart(),
      });
      timerId = d.setTimer(() => {
        if (currentGeneration === generation && status === 'loading') fail(new Error('开场资源准备超时，请检查素材地址和网络连接。'));
      }, PREPARATION_TIMEOUT_MS);
      void runtime.ready.then(() => {
        if (currentGeneration !== generation || status !== 'loading') return;
        if (timerId !== null) d.clearTimer(timerId);
        timerId = null; status = 'ready'; documentVisible = d.isDocumentVisible();
        updatePlayback();
        if (!isTerminal() && currentGeneration === generation) settleReady();
      }, error => {
        if (currentGeneration === generation && status === 'loading') fail(error);
      });
    } catch (error) { fail(error); }
  };

  const controller: OpeningController = {
    get ready() { return readyPromise; },
    play, pause, resume: play,
    skip: () => { if (d.allowSkip) finish('skipped'); },
    seek: seconds => {
      if (!d.allowSkip || isTerminal() || !Number.isFinite(seconds)) return;
      const nextElapsed = Math.max(d.initialElapsedSeconds, Math.min(d.totalDurationSeconds, seconds));
      if (nextElapsed === elapsed) return;
      elapsed = nextElapsed;
      if (elapsed >= d.totalDurationSeconds) { finish('completed'); return; }
      if (status === 'playing') previousTime = d.now();
      if (status !== 'loading' && render()) progress(true);
    },
    restart: () => {
      if (status === 'destroyed') return;
      generation += 1;
      const cleanupErrors = cleanup();
      settleReady(cancelled('开场已重新开始。'));
      status = 'loading'; elapsed = d.initialElapsedSeconds; wantsToPlay = true;
      errorMessage = null; documentVisible = d.isDocumentVisible(); lastProgressTime = -Infinity;
      begin();
      cleanupErrors.forEach(reportError);
    },
    setHostVisible: visible => {
      if (status === 'destroyed' || typeof visible !== 'boolean' || hostVisible === visible) return;
      advance(); hostVisible = visible; updatePlayback();
    },
    getState,
    destroy: () => {
      if (status === 'destroyed') return;
      generation += 1; status = 'destroyed';
      const cleanupErrors = cleanup();
      settleReady(cancelled('开场已销毁。')); cleanupErrors.forEach(reportError);
    },
  };
  begin();
  return controller;
}
