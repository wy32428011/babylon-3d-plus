export type SceneRenderReadySource<TObserver> = {
  whenReadyAsync: () => Promise<unknown>;
  isReady?: () => boolean;
  onBeforeRenderObservable?: {
    addOnce: (callback: () => void) => TObserver | null;
    remove: (observer: TObserver) => unknown;
  };
  onAfterRenderObservable: {
    addOnce: (callback: () => void) => TObserver | null;
    remove: (observer: TObserver) => unknown;
  };
};

/**
 * 在真实帧间查询就绪状态，避开 whenReadyAsync 的固定轮询延迟。
 * 有帧前事件时在同一帧前后确认 ready，兼容准备期低帧率；仅有帧末事件时再等后续完整帧。
 */
function waitForReadyRenderFrame<TObserver>(
  scene: SceneRenderReadySource<TObserver>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise<void>((resolve, reject) => {
    let observer: TObserver | null = null;
    let beforeObserver: TObserver | null = null;
    let settled = false;
    let readyBeforeFrame = false;
    const finish = (failure?: { cause: unknown }): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      if (observer !== null) scene.onAfterRenderObservable.remove(observer);
      if (beforeObserver !== null) scene.onBeforeRenderObservable?.remove(beforeObserver);
      observer = null;
      beforeObserver = null;
      if (failure) reject(failure.cause);
      else resolve();
    };
    const handleAbort = (): void => finish({ cause: createAbortError() });
    const observeFrame = (): void => {
      if (settled) return;
      try {
        if (scene.onBeforeRenderObservable) {
          beforeObserver = scene.onBeforeRenderObservable.addOnce(() => {
            beforeObserver = null;
            if (settled) return;
            try { readyBeforeFrame = scene.isReady!(); }
            catch (error) { finish({ cause: error }); }
          });
        }
        observer = scene.onAfterRenderObservable.addOnce(handleFrame);
      } catch (error) { finish({ cause: error }); }
    };
    const handleFrame = (): void => {
      observer = null;
      if (settled) return;
      try {
        const ready = scene.isReady!();
        if (readyBeforeFrame && ready) { finish(); return; }
        readyBeforeFrame = ready;
        // Babylon Observable 可在当前通知中访问新注册项；移到微任务，避免同一帧被结算两次。
        queueMicrotask(observeFrame);
      } catch (error) { finish({ cause: error }); }
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
    try {
      const initiallyReady = scene.isReady!();
      readyBeforeFrame = scene.onBeforeRenderObservable ? false : initiallyReady;
      if (signal?.aborted) handleAbort();
      // 等待可能由其它帧末观察者发起；不能在当前旧帧的通知中注册并结算新资源。
      else queueMicrotask(observeFrame);
    } catch (error) { finish({ cause: error }); }
  });
}

function createAbortError(): Error {
  const error = new Error('场景可渲染状态等待已取消。');
  error.name = 'AbortError';
  return error;
}

function waitForPromiseWithAbort(
  promise: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError());

  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener('abort', handleAbort);
    const handleAbort = (): void => {
      cleanup();
      reject(createAbortError());
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** 等待场景资源就绪，并确认至少完成一帧包含这些资源的渲染。 */
export async function waitForSceneRenderReady<TObserver>(
  scene: SceneRenderReadySource<TObserver>,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof scene.isReady === 'function') return waitForReadyRenderFrame(scene, signal);
  await waitForPromiseWithAbort(scene.whenReadyAsync(), signal);
  if (signal?.aborted) throw createAbortError();

  await new Promise<void>((resolve, reject) => {
    let observer: TObserver | null = null;
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener('abort', handleAbort);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      observer = null;
      resolve();
    };
    const handleAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (observer !== null) scene.onAfterRenderObservable.remove(observer);
      observer = null;
      reject(createAbortError());
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
    observer = scene.onAfterRenderObservable.addOnce(finish);
    if (signal?.aborted) handleAbort();
  });
}
