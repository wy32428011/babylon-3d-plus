export type SceneRenderReadySource<TObserver> = {
  whenReadyAsync: () => Promise<unknown>;
  onAfterRenderObservable: {
    addOnce: (callback: () => void) => TObserver | null;
    remove: (observer: TObserver) => unknown;
  };
};

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
