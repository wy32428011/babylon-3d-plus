export type RealtimeFirstProgressGate<T> = {
  handleRealtime: (payload: T) => void;
  handleSnapshot: (payload: T | null) => void;
  dispose: () => void;
};

/** 实时事件一旦到达，就丢弃可能更旧的异步初始快照。 */
export function createRealtimeFirstProgressGate<T>(
  handler: (payload: T) => void,
): RealtimeFirstProgressGate<T> {
  let active = true;
  let receivedRealtime = false;

  return {
    handleRealtime(payload) {
      if (!active) return;
      receivedRealtime = true;
      handler(payload);
    },
    handleSnapshot(payload) {
      if (!active || receivedRealtime || payload === null) return;
      handler(payload);
    },
    dispose() {
      active = false;
    },
  };
}
