type Snapshot = { sceneSessionId: string; error: string | null; retrying: boolean };

/** 只承载远程环境失败与恢复；下载完成不能代替运行时首帧就绪。 */
export function createEnvironmentPreparationStore() {
  let snapshot: Snapshot = { sceneSessionId: '', error: null, retrying: false };
  let retrySync: (() => Promise<boolean>) | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    begin(sceneSessionId: string, retry: () => Promise<boolean>) {
      retrySync = retry;
      publish({ sceneSessionId, error: null, retrying: false });
    },
    fail(sceneSessionId: string, error: string) {
      if (snapshot.sceneSessionId !== sceneSessionId) return;
      publish({ ...snapshot, error });
    },
    clearError(sceneSessionId: string) {
      if (snapshot.sceneSessionId !== sceneSessionId || !snapshot.error) return;
      publish({ ...snapshot, error: null });
    },
    clear(sceneSessionId: string) {
      if (snapshot.sceneSessionId !== sceneSessionId) return;
      retrySync = null;
      publish({ sceneSessionId: '', error: null, retrying: false });
    },
    async retry() {
      if (!retrySync || snapshot.retrying || !snapshot.error) return;
      const sceneSessionId = snapshot.sceneSessionId;
      publish({ ...snapshot, error: null, retrying: true });
      try {
        if (!await retrySync()) throw new Error('环境模型同步未能启动，请检查数据中台连接后重试。');
      } catch (error) {
        if (snapshot.sceneSessionId === sceneSessionId) {
          publish({ ...snapshot, error: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        if (snapshot.sceneSessionId === sceneSessionId) publish({ ...snapshot, retrying: false });
      }
    },
  };
}

export const environmentPreparationStore = createEnvironmentPreparationStore();
