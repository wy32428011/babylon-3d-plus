type BackgroundFrameWorkerRequest = {
  type: 'schedule' | 'cancel';
  requestId: number;
  delayMs?: number;
};

type BackgroundFrameWorkerResponse = {
  type: 'frame';
  requestId: number;
};

type BackgroundFrameWorkerScope = {
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<BackgroundFrameWorkerRequest>) => void,
  ) => void;
  postMessage: (message: BackgroundFrameWorkerResponse) => void;
};

const workerScope = self as unknown as BackgroundFrameWorkerScope;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

workerScope.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message.requestId !== 'number') return;

  if (message.type === 'schedule') {
    const existing = timers.get(message.requestId);
    if (existing !== undefined) clearTimeout(existing);
    const timeoutId = setTimeout(() => {
      timers.delete(message.requestId);
      workerScope.postMessage({ type: 'frame', requestId: message.requestId });
    }, Math.max(0, message.delayMs ?? 0));
    timers.set(message.requestId, timeoutId);
    return;
  }

  if (message.type === 'cancel') {
    const timeoutId = timers.get(message.requestId);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    timers.delete(message.requestId);
  }
});

export {};
