export const BACKGROUND_FRAME_INTERVAL_MS = 1000 / 30;

type BackgroundFrameCallback = (timestamp: number) => void;

export type BackgroundFrameTimer = {
  schedule: (requestId: number, delayMs: number) => void;
  cancel: (requestId: number) => void;
  dispose: () => void;
};

export type BackgroundFrameRequesterDependencies = {
  getVisibilityState: () => DocumentVisibilityState;
  subscribeVisibilityChange: (listener: () => void) => () => void;
  requestVisibleFrame: (callback: BackgroundFrameCallback) => number;
  cancelVisibleFrame: (requestId: number) => void;
  createBackgroundTimer: (onFrame: (requestId: number) => void) => BackgroundFrameTimer;
  now: () => number;
};

export type BackgroundFrameRequester = {
  requestAnimationFrame: (callback: BackgroundFrameCallback) => number;
  cancelAnimationFrame: (requestId: number) => void;
  dispose: () => void;
};

type PendingFrame = {
  callback: BackgroundFrameCallback;
  scheduleId: number;
  visibleRequestId: number | null;
  scheduledInBackground: boolean;
};

type WorkerTimerMessage = {
  type: 'frame';
  requestId: number;
};

/**
 * Worker 仅负责在页面隐藏时提供帧节拍；WebGL 绘制仍在主线程执行。
 * Worker 被 CSP 或运行环境拒绝时退回 window.setTimeout，保证 Viewer 仍可启动。
 */
function createBrowserBackgroundTimer(onFrame: (requestId: number) => void): BackgroundFrameTimer {
  const pendingDelays = new Map<number, number>();
  const fallbackTimeouts = new Map<number, number>();
  let worker: Worker | null = null;
  let fallbackActive = false;
  let disposed = false;

  const scheduleFallback = (requestId: number, delayMs: number): void => {
    const timeoutId = window.setTimeout(() => {
      fallbackTimeouts.delete(requestId);
      if (!pendingDelays.delete(requestId) || disposed) return;
      onFrame(requestId);
    }, delayMs);
    fallbackTimeouts.set(requestId, timeoutId);
  };

  const releaseWorker = (): void => {
    worker?.terminate();
    worker = null;
  };

  const activateFallback = (): void => {
    if (fallbackActive || disposed) return;
    fallbackActive = true;
    releaseWorker();
    for (const [requestId, delayMs] of pendingDelays) {
      scheduleFallback(requestId, delayMs);
    }
  };

  try {
    worker = new Worker(new URL('./backgroundFrameWorker.ts', import.meta.url), {
      type: 'module',
      name: 'zending-viewer-background-frame',
    });
    worker.addEventListener('message', (event: MessageEvent<WorkerTimerMessage>) => {
      const message = event.data;
      if (message?.type !== 'frame' || !pendingDelays.delete(message.requestId) || disposed) return;
      onFrame(message.requestId);
    });
    worker.addEventListener('error', activateFallback, { once: true });
  } catch {
    activateFallback();
  }

  return {
    schedule: (requestId, delayMs) => {
      if (disposed) return;
      const existingTimeoutId = fallbackTimeouts.get(requestId);
      if (existingTimeoutId !== undefined) window.clearTimeout(existingTimeoutId);
      fallbackTimeouts.delete(requestId);
      pendingDelays.set(requestId, delayMs);
      if (worker && !fallbackActive) {
        worker.postMessage({ type: 'schedule', requestId, delayMs });
      } else {
        scheduleFallback(requestId, delayMs);
      }
    },
    cancel: (requestId) => {
      pendingDelays.delete(requestId);
      const timeoutId = fallbackTimeouts.get(requestId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      fallbackTimeouts.delete(requestId);
      worker?.postMessage({ type: 'cancel', requestId });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      pendingDelays.clear();
      for (const timeoutId of fallbackTimeouts.values()) window.clearTimeout(timeoutId);
      fallbackTimeouts.clear();
      releaseWorker();
    },
  };
}

function createBrowserDependencies(): BackgroundFrameRequesterDependencies {
  return {
    getVisibilityState: () => document.visibilityState,
    subscribeVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    requestVisibleFrame: (callback) => window.requestAnimationFrame(callback),
    cancelVisibleFrame: (requestId) => window.cancelAnimationFrame(requestId),
    createBackgroundTimer: createBrowserBackgroundTimer,
    now: () => performance.now(),
  };
}

/** 可见时使用原生 RAF，隐藏或最小化时切换为 Worker 节拍。 */
export function createBackgroundFrameRequester(
  dependencies: BackgroundFrameRequesterDependencies = createBrowserDependencies(),
): BackgroundFrameRequester {
  const pendingFrames = new Map<number, PendingFrame>();
  let nextRequestId = 1;
  let nextScheduleId = 1;
  let disposed = false;

  const completeFrame = (requestId: number, scheduleId: number, timestamp: number): void => {
    const pending = pendingFrames.get(requestId);
    if (!pending || pending.scheduleId !== scheduleId) return;
    pendingFrames.delete(requestId);
    pending.callback(timestamp);
  };

  const backgroundTimer = dependencies.createBackgroundTimer((scheduleId) => {
    for (const [requestId, pending] of pendingFrames) {
      if (pending.scheduleId !== scheduleId || !pending.scheduledInBackground) continue;
      completeFrame(requestId, scheduleId, dependencies.now());
      return;
    }
  });

  const cancelScheduledFrame = (pending: PendingFrame): void => {
    if (pending.scheduledInBackground) {
      backgroundTimer.cancel(pending.scheduleId);
    } else if (pending.visibleRequestId !== null) {
      dependencies.cancelVisibleFrame(pending.visibleRequestId);
    }
    pending.visibleRequestId = null;
  };

  const scheduleFrame = (requestId: number, pending: PendingFrame): void => {
    const scheduleId = nextScheduleId;
    nextScheduleId += 1;
    pending.scheduleId = scheduleId;
    pending.scheduledInBackground = dependencies.getVisibilityState() === 'hidden';
    if (pending.scheduledInBackground) {
      pending.visibleRequestId = null;
      backgroundTimer.schedule(scheduleId, BACKGROUND_FRAME_INTERVAL_MS);
      return;
    }
    pending.visibleRequestId = dependencies.requestVisibleFrame((timestamp) => {
      completeFrame(requestId, scheduleId, timestamp);
    });
  };

  const handleVisibilityChange = (): void => {
    for (const [requestId, pending] of pendingFrames) {
      cancelScheduledFrame(pending);
      scheduleFrame(requestId, pending);
    }
  };
  const unsubscribeVisibilityChange = dependencies.subscribeVisibilityChange(handleVisibilityChange);

  return {
    requestAnimationFrame: (callback) => {
      if (disposed) return 0;
      const requestId = nextRequestId;
      nextRequestId += 1;
      const pending: PendingFrame = {
        callback,
        scheduleId: 0,
        visibleRequestId: null,
        scheduledInBackground: false,
      };
      pendingFrames.set(requestId, pending);
      scheduleFrame(requestId, pending);
      return requestId;
    },
    cancelAnimationFrame: (requestId) => {
      const pending = pendingFrames.get(requestId);
      if (!pending) return;
      pendingFrames.delete(requestId);
      cancelScheduledFrame(pending);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeVisibilityChange();
      for (const pending of pendingFrames.values()) cancelScheduledFrame(pending);
      pendingFrames.clear();
      backgroundTimer.dispose();
    },
  };
}
