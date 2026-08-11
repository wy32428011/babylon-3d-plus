import type { ProjectSkyboxAssetEntry } from './AssetDatabase';
import {
  formatSkyboxSyncError,
  normalizeSkyboxSyncProgress,
  type SkyboxSyncPhase,
  type SkyboxSyncProgress,
} from './skyboxAssets';

export type SkyboxSyncApplyResult = 'applied' | 'unchanged' | 'blocked' | 'not-found';

export type SkyboxSyncControllerState = {
  progress: SkyboxSyncProgress | null;
  starting: boolean;
  retrying: boolean;
  reloadingAssets: boolean;
  pendingRunId: string | null;
  reloadError: string | null;
};

type SkyboxSyncContext = {
  readOnly: boolean;
  sceneId: string | null;
  contextKey: string | null;
  syncContextKey: string | null;
};

type SkyboxSyncContextIdentity = Pick<
  SkyboxSyncContext,
  'sceneId' | 'contextKey' | 'syncContextKey'
>;

type Schedule = (callback: () => void, delayMs: number) => unknown;
type CancelSchedule = (handle: unknown) => void;

export type SkyboxSyncControllerOptions = {
  startSync: () => Promise<boolean>;
  retrySync: () => Promise<boolean>;
  reloadAssets: () => Promise<ProjectSkyboxAssetEntry[]>;
  applyAssets: (assets: ProjectSkyboxAssetEntry[], sceneId: string) => SkyboxSyncApplyResult;
  onStateChange?: (state: SkyboxSyncControllerState) => void;
  onProgressLog?: (progress: SkyboxSyncProgress) => void;
  schedule?: Schedule;
  cancelSchedule?: CancelSchedule;
  progressThrottleMs?: number;
  completedDismissMs?: number;
};

export type SkyboxSyncController = {
  getState: () => SkyboxSyncControllerState;
  setContext: (context: SkyboxSyncContext) => void;
  receiveProgress: (payload: unknown) => void;
  start: () => Promise<boolean>;
  retry: () => Promise<boolean>;
  retryAssetReload: () => Promise<boolean>;
  dismissFailure: () => void;
  dispose: () => void;
};

const ACTIVE_PHASES = new Set<SkyboxSyncPhase>([
  'querying',
  'downloading',
  'validating',
  'promoting',
]);
const MAX_TRACKED_RUNS = 32;

function createLocalProgress(
  runId: string,
  contextKey: string | null,
  phase: 'querying' | 'failed',
  message: string,
  error: string | null,
): SkyboxSyncProgress {
  return { runId, contextKey, phase, completed: 0, total: 0, message, error };
}

function defaultSchedule(callback: () => void, delayMs: number): unknown {
  return globalThis.setTimeout(callback, delayMs);
}

function defaultCancelSchedule(handle: unknown): void {
  globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function captureContextIdentity(context: SkyboxSyncContext): SkyboxSyncContextIdentity {
  return {
    sceneId: context.sceneId,
    contextKey: context.contextKey,
    syncContextKey: context.syncContextKey,
  };
}

function isSameContextIdentity(
  left: SkyboxSyncContextIdentity,
  right: SkyboxSyncContextIdentity,
): boolean {
  return left.sceneId === right.sceneId
    && left.contextKey === right.contextKey
    && left.syncContextKey === right.syncContextKey;
}

/** 管理天空盒同步的有序进度、资源重载与受编辑权限保护的稳定 ID 重关联。 */
export function createSkyboxSyncController(
  options: SkyboxSyncControllerOptions,
): SkyboxSyncController {
  const schedule = options.schedule ?? defaultSchedule;
  const cancelSchedule = options.cancelSchedule ?? defaultCancelSchedule;
  const progressThrottleMs = options.progressThrottleMs ?? 225;
  const completedDismissMs = options.completedDismissMs ?? 2200;
  let state: SkyboxSyncControllerState = {
    progress: null,
    starting: false,
    retrying: false,
    reloadingAssets: false,
    pendingRunId: null,
    reloadError: null,
  };
  let context: SkyboxSyncContext = {
    readOnly: true,
    sceneId: null,
    contextKey: null,
    syncContextKey: null,
  };
  let disposed = false;
  let localRunCounter = 0;
  let throttleHandle: unknown = null;
  let throttledProgress: SkyboxSyncProgress | null = null;
  let completedDismissHandle: unknown = null;
  let pendingAssets: ProjectSkyboxAssetEntry[] | null = null;
  let pendingCompletedProgress: SkyboxSyncProgress | null = null;
  let pendingContextIdentity: SkyboxSyncContextIdentity | null = null;
  let loadingRunId: string | null = null;
  let applying = false;
  const processedRuns = new Set<string>();
  const loggedPhases = new Map<string, SkyboxSyncPhase>();
  const runContextIdentities = new Map<string, SkyboxSyncContextIdentity>();

  const clearPendingData = (): void => {
    pendingAssets = null;
    pendingCompletedProgress = null;
    pendingContextIdentity = null;
  };

  const publishState = (): void => {
    if (disposed) return;
    options.onStateChange?.({ ...state });
  };

  const updateState = (patch: Partial<SkyboxSyncControllerState>): void => {
    state = { ...state, ...patch };
    publishState();
  };

  const rememberBounded = <T>(collection: Set<T>, value: T): void => {
    collection.add(value);
    if (collection.size <= MAX_TRACKED_RUNS) return;
    const oldest = collection.values().next().value as T | undefined;
    if (oldest !== undefined) collection.delete(oldest);
  };

  const getRunContextIdentity = (runId: string): SkyboxSyncContextIdentity => {
    const existing = runContextIdentities.get(runId);
    if (existing) return existing;

    const identity = captureContextIdentity(context);
    runContextIdentities.set(runId, identity);
    if (runContextIdentities.size > MAX_TRACKED_RUNS) {
      const oldest = runContextIdentities.keys().next().value as string | undefined;
      if (oldest !== undefined && oldest !== runId) runContextIdentities.delete(oldest);
    }
    return identity;
  };

  const logPhaseTransition = (progress: SkyboxSyncProgress): void => {
    if (loggedPhases.get(progress.runId) === progress.phase) return;
    loggedPhases.set(progress.runId, progress.phase);
    if (loggedPhases.size > MAX_TRACKED_RUNS) {
      const oldest = loggedPhases.keys().next().value as string | undefined;
      if (oldest !== undefined && oldest !== progress.runId) loggedPhases.delete(oldest);
    }
    options.onProgressLog?.(progress);
  };

  const clearThrottle = (): void => {
    if (throttleHandle !== null) cancelSchedule(throttleHandle);
    throttleHandle = null;
    throttledProgress = null;
  };

  const clearCompletedDismiss = (): void => {
    if (completedDismissHandle !== null) cancelSchedule(completedDismissHandle);
    completedDismissHandle = null;
  };

  const commitProgress = (progress: SkyboxSyncProgress): void => {
    updateState({ progress });
  };

  const scheduleCompletedDismiss = (runId: string): void => {
    clearCompletedDismiss();
    completedDismissHandle = schedule(() => {
      completedDismissHandle = null;
      if (disposed) return;
      if (
        state.pendingRunId === null
        && state.progress?.runId === runId
        && state.progress.phase === 'completed'
      ) {
        updateState({ progress: null });
      }
    }, completedDismissMs);
  };

  const failRendererRun = (runId: string, message: string, reloadError: string | null): void => {
    const failed = createLocalProgress(runId, context.syncContextKey, 'failed', message, message);
    clearCompletedDismiss();
    logPhaseTransition(failed);
    updateState({ progress: failed, reloadError, reloadingAssets: false });
  };

  const tryApplyPending = (): void => {
    if (
      disposed
      || applying
      || context.readOnly
      || !context.sceneId
      || !state.pendingRunId
      || !pendingAssets
      || !pendingCompletedProgress
      || !pendingContextIdentity
      || !isSameContextIdentity(context, pendingContextIdentity)
    ) return;

    const runId = state.pendingRunId;
    const sceneId = context.sceneId;
    applying = true;
    try {
      const result = options.applyAssets(pendingAssets, sceneId);
      if (disposed || state.pendingRunId !== runId) return;
      if (result !== 'applied' && result !== 'unchanged') return;

      rememberBounded(processedRuns, runId);
      clearPendingData();
      updateState({
        progress: state.progress?.runId === runId && state.progress.phase === 'failed'
          ? { ...state.progress, phase: 'completed', message: '天空盒同步完成。', error: null }
          : state.progress,
        pendingRunId: null,
        reloadError: null,
      });
      scheduleCompletedDismiss(runId);
    } catch (error) {
      const detail = formatSkyboxSyncError(error);
      failRendererRun(runId, `天空盒资源已加载，但当前场景重关联失败：${detail}`, null);
    } finally {
      applying = false;
    }
  };

  const reloadCompletedRun = async (runId: string): Promise<boolean> => {
    if (disposed || state.pendingRunId !== runId || loadingRunId !== null) return false;
    loadingRunId = runId;
    updateState({ reloadingAssets: true });
    try {
      const assets = await options.reloadAssets();
      if (disposed || state.pendingRunId !== runId) return false;
      pendingAssets = assets;
      const completedProgress = pendingCompletedProgress;
      if (!completedProgress) return false;
      loadingRunId = null;
      logPhaseTransition(completedProgress);
      updateState({
        progress: completedProgress,
        reloadError: null,
        reloadingAssets: false,
      });
      tryApplyPending();
      return true;
    } catch (error) {
      if (disposed || state.pendingRunId !== runId) return false;
      loadingRunId = null;
      const detail = formatSkyboxSyncError(error);
      const message = `重新加载资源库失败：${detail}`;
      failRendererRun(runId, message, message);
      return false;
    } finally {
      if (loadingRunId === runId) {
        loadingRunId = null;
        const nextRunId = !disposed
          && state.pendingRunId !== runId
          && pendingCompletedProgress?.runId === state.pendingRunId
          ? state.pendingRunId
          : null;
        if (!disposed) updateState({ reloadingAssets: false });
        // completed 可能在上一次资源重载期间到达；释放后只处理最新 pending run。
        if (nextRunId) void reloadCompletedRun(nextRunId);
      }
    }
  };

  const handleCompleted = (progress: SkyboxSyncProgress): void => {
    if (processedRuns.has(progress.runId)) {
      scheduleCompletedDismiss(progress.runId);
      return;
    }
    if (state.pendingRunId === progress.runId) return;

    state = {
      ...state,
      pendingRunId: progress.runId,
      reloadError: null,
    };
    pendingAssets = null;
    pendingCompletedProgress = progress;
    pendingContextIdentity = captureContextIdentity(context);
    publishState();
    void reloadCompletedRun(progress.runId);
  };

  const receiveProgress = (payload: unknown): void => {
    if (disposed) return;
    clearCompletedDismiss();
    const normalized = normalizeSkyboxSyncProgress(payload);
    const progress = normalized.progress;

    if (!normalized.valid) {
      logPhaseTransition(progress);
      clearThrottle();
      commitProgress(progress);
      return;
    }

    if (progress.contextKey !== context.syncContextKey) return;
    const runContextIdentity = getRunContextIdentity(progress.runId);
    if (!isSameContextIdentity(context, runContextIdentity)) return;
    logPhaseTransition(progress);

    if (progress.phase === 'completed' || progress.phase === 'failed') {
      clearThrottle();
      if (progress.phase === 'failed') updateState({ reloadError: null });
      commitProgress(progress);
      if (normalized.shouldReloadProjectAssets) handleCompleted(progress);
      return;
    }

    if (state.pendingRunId && state.pendingRunId !== progress.runId) {
      state = { ...state, pendingRunId: null, reloadError: null };
      clearPendingData();
    }
    throttledProgress = progress;
    if (throttleHandle !== null) return;
    throttleHandle = schedule(() => {
      throttleHandle = null;
      const latest = throttledProgress;
      throttledProgress = null;
      if (!disposed && latest) commitProgress(latest);
    }, progressThrottleMs);
  };

  const runOperation = async (kind: 'start' | 'retry'): Promise<boolean> => {
    if (
      disposed
      || context.readOnly
      || state.starting
      || state.retrying
      || (state.progress !== null && ACTIVE_PHASES.has(state.progress.phase))
      || (kind === 'retry' && state.progress?.phase !== 'failed')
    ) return false;

    clearCompletedDismiss();
    const operationContextIdentity = captureContextIdentity(context);
    localRunCounter += 1;
    const runId = `renderer-skybox-${kind}-${localRunCounter}`;
    const queryingMessage = kind === 'start'
      ? '正在启动数据中台天空盒同步...'
      : '已提交重试，正在重新查询天空盒...';
    const querying = createLocalProgress(
      runId,
      context.syncContextKey,
      'querying',
      queryingMessage,
      null,
    );
    logPhaseTransition(querying);
    updateState({
      progress: querying,
      starting: kind === 'start',
      retrying: kind === 'retry',
      reloadError: null,
    });

    try {
      const started = await (kind === 'start' ? options.startSync() : options.retrySync());
      if (disposed || !isSameContextIdentity(context, operationContextIdentity)) return false;
      if (!started) {
        const message = kind === 'start'
          ? '数据中台天空盒同步未能启动，请检查数据中台连接配置。'
          : '当前没有可重试的天空盒同步任务。';
        failRendererRun(runId, message, null);
      }
      return started;
    } catch (error) {
      if (disposed || !isSameContextIdentity(context, operationContextIdentity)) return false;
      const detail = formatSkyboxSyncError(error);
      const message = kind === 'start'
        ? `启动数据中台天空盒同步失败：${detail}`
        : `重试数据中台天空盒同步失败：${detail}`;
      failRendererRun(runId, message, null);
      return false;
    } finally {
      if (!disposed && isSameContextIdentity(context, operationContextIdentity)) {
        updateState({
          starting: kind === 'start' ? false : state.starting,
          retrying: kind === 'retry' ? false : state.retrying,
        });
      }
    }
  };

  return {
    getState: () => ({ ...state }),
    setContext(nextContext) {
      if (disposed) return;
      const identityChanged = !isSameContextIdentity(context, nextContext);
      const shouldRetryPending = !identityChanged
        && context.readOnly
        && !nextContext.readOnly
        && Boolean(nextContext.sceneId);
      context = { ...nextContext };

      if (identityChanged) {
        clearThrottle();
        clearCompletedDismiss();
        clearPendingData();
        state = {
          ...state,
          progress: null,
          starting: false,
          retrying: false,
          reloadingAssets: false,
          pendingRunId: null,
          reloadError: null,
        };
        publishState();
        return;
      }
      if (shouldRetryPending) tryApplyPending();
    },
    receiveProgress,
    start: () => runOperation('start'),
    retry: () => runOperation('retry'),
    retryAssetReload: async () => {
      if (
        disposed
        || state.reloadingAssets
        || !state.reloadError
        || !state.pendingRunId
        || !pendingCompletedProgress
        || !pendingContextIdentity
        || !isSameContextIdentity(context, pendingContextIdentity)
      ) return false;
      return reloadCompletedRun(state.pendingRunId);
    },
    dismissFailure() {
      if (disposed || state.progress?.phase !== 'failed') return;
      clearPendingData();
      updateState({ progress: null, pendingRunId: null, reloadError: null });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearThrottle();
      clearCompletedDismiss();
      clearPendingData();
      runContextIdentities.clear();
    },
  };
}
