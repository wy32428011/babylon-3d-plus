import type { Entity } from '../model/Entity';

export type ScenePreparationPhase =
  | 'starting'
  | 'syncing-models'
  | 'refreshing-scene-models'
  | 'loading-scene-models'
  | 'batching-scene-models'
  | 'completed';

export type ScenePreparationModelSyncPhase =
  | 'querying'
  | 'downloading'
  | 'validating'
  | 'promoting'
  | 'completed'
  | 'failed';

export type ScenePreparationModelSyncProgress = {
  runId: string;
  phase: ScenePreparationModelSyncPhase;
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

type ModelSyncStatus = 'pending' | 'active' | 'settled' | 'skipped';
type AssetRefreshStatus = 'pending' | 'active' | 'settled';

export type ScenePreparationRuntimeProgress = {
  generation: string;
  totalModels: number;
  settledModels: number;
  expectedBatchedEntities: number;
  batchedEntities: number;
  stable: boolean;
  forcedSettled: boolean;
};

export type ScenePreparationState = {
  sceneSessionId: string;
  phase: ScenePreparationPhase;
  percent: number;
  label: string;
  detail: string;
  completed: boolean;
  warnings: string[];
  modelSyncStatus: ModelSyncStatus;
  modelSyncRunId: string | null;
  modelSyncProgress: ScenePreparationModelSyncProgress | null;
  assetRefreshStatus: AssetRefreshStatus;
  assetRefreshId: string | null;
  runtime: ScenePreparationRuntimeProgress;
};

export type ScenePreparationEvent =
  | { type: 'model-sync-progress'; progress: ScenePreparationModelSyncProgress }
  | { type: 'model-sync-skipped'; error: string | null }
  | { type: 'asset-refresh-started'; refreshId: string }
  | { type: 'asset-refresh-settled'; refreshId: string; error: string | null }
  | ({ type: 'runtime-progress' } & Omit<ScenePreparationRuntimeProgress, 'forcedSettled'>)
  | { type: 'runtime-settled-with-warning'; warning: string };

const EMPTY_RUNTIME_PROGRESS: ScenePreparationRuntimeProgress = {
  generation: '',
  totalModels: 0,
  settledModels: 0,
  expectedBatchedEntities: 0,
  batchedEntities: 0,
  stable: false,
  forcedSettled: false,
};

export const SCENE_PREPARATION_RUNTIME_TIMEOUT_MS = 120_000;

/**
 * 统计运行时应进入 Geometry 批次的可见逻辑实体。
 * 源模型也会作为批次中的一个矩阵提交；持久化实例不能只依赖本次自动派生计数。
 */
export function countExpectedSceneBatchedEntities(
  entityIds: readonly string[],
  entities: Record<string, Entity>,
): number {
  const effectiveVisibility = new Map<string, boolean>();
  for (const entityId of entityIds) {
    if (!entities[entityId] || effectiveVisibility.has(entityId)) continue;
    const chain: Entity[] = [];
    const chainIds = new Set<string>();
    let current: Entity | null | undefined = entities[entityId];
    while (current && !effectiveVisibility.has(current.id) && !chainIds.has(current.id)) {
      chain.push(current);
      chainIds.add(current.id);
      current = current.parentId ? entities[current.parentId] : null;
    }
    let visible = current ? effectiveVisibility.get(current.id) ?? true : true;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      visible = visible && chain[index].visible !== false;
      effectiveVisibility.set(chain[index].id, visible);
    }
  }
  const sourceEntityIds = new Set<string>();
  for (const entityId of entityIds) {
    const sourceEntityId = entities[entityId]?.components.modelArrayInstance?.sourceEntityId;
    const sourceEntity = sourceEntityId ? entities[sourceEntityId] : null;
    if (
      sourceEntityId
      && sourceEntity?.components.modelAsset
      && !sourceEntity.components.modelArrayInstance
    ) {
      sourceEntityIds.add(sourceEntityId);
    }
  }
  if (sourceEntityIds.size === 0) return 0;

  let expected = 0;
  for (const entityId of entityIds) {
    const entity = entities[entityId];
    if (!entity?.components.modelAsset || effectiveVisibility.get(entityId) === false) continue;
    const sourceEntityId = entity.components.modelArrayInstance?.sourceEntityId;
    if (sourceEntityId ? sourceEntityIds.has(sourceEntityId) : sourceEntityIds.has(entityId)) expected += 1;
  }
  return expected;
}

/** 运行时准备超时只基于同一观察窗口内的单调时间，系统时钟回拨不会误触发。 */
export function hasScenePreparationRuntimeTimedOut(startedAtMs: number, nowMs: number): boolean {
  return nowMs >= startedAtMs
    && nowMs - startedAtMs >= SCENE_PREPARATION_RUNTIME_TIMEOUT_MS;
}

/** 为一次场景会话创建独立准备状态，避免上一场景的异步事件污染新场景。 */
export function createScenePreparationState(sceneSessionId: string): ScenePreparationState {
  return {
    sceneSessionId,
    phase: 'starting',
    percent: 2,
    label: '正在准备场景',
    detail: '正在确认模型同步状态…',
    completed: false,
    warnings: [],
    modelSyncStatus: 'pending',
    modelSyncRunId: null,
    modelSyncProgress: null,
    assetRefreshStatus: 'pending',
    assetRefreshId: null,
    runtime: { ...EMPTY_RUNTIME_PROGRESS },
  };
}

/** 归一化服务端数量，避免异常事件生成负数、NaN 或超过 100% 的进度。 */
function normalizeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeRatio(completed: number, total: number): number {
  const normalizedTotal = normalizeCount(total);
  if (normalizedTotal === 0) return 0;
  return Math.min(1, normalizeCount(completed) / normalizedTotal);
}

function appendWarning(warnings: string[], warning: string | null | undefined): string[] {
  const normalized = warning?.trim();
  if (!normalized || warnings.includes(normalized)) return warnings;
  return [...warnings, normalized];
}

/** 将数据中台同步阶段映射到整个场景准备流程的前 55%。 */
function getModelSyncPercent(progress: ScenePreparationModelSyncProgress | null): number {
  if (!progress) return 4;
  const ratio = normalizeRatio(progress.completed, progress.total);
  switch (progress.phase) {
    case 'querying':
      return 8;
    case 'downloading':
      return 12 + ratio * 25;
    case 'validating':
      return 39 + ratio * 8;
    case 'promoting':
      return 49 + ratio * 5;
    case 'completed':
    case 'failed':
      return 55;
  }
}

function isRuntimeSettled(runtime: ScenePreparationRuntimeProgress): boolean {
  if (runtime.forcedSettled) return true;
  return runtime.stable
    && runtime.settledModels >= runtime.totalModels
    && runtime.batchedEntities >= runtime.expectedBatchedEntities;
}

/** 根据三个门控阶段生成用户可见状态；进度在同一任务代次内只增不减。 */
function deriveScenePreparationState(
  state: ScenePreparationState,
  previousPercent: number,
): ScenePreparationState {
  let phase: ScenePreparationPhase;
  let percent: number;
  let label: string;
  let detail: string;

  if (state.modelSyncStatus === 'pending') {
    phase = 'starting';
    percent = 4;
    label = '正在准备场景';
    detail = '正在确认模型同步状态…';
  } else if (state.modelSyncStatus === 'active') {
    phase = 'syncing-models';
    percent = getModelSyncPercent(state.modelSyncProgress);
    label = '正在同步模型';
    const progress = state.modelSyncProgress;
    const count = progress && progress.total > 0
      ? `（${normalizeCount(progress.completed)}/${normalizeCount(progress.total)}）`
      : '';
    detail = `${progress?.message || '正在从数据中台同步模型…'}${count}`;
  } else if (state.assetRefreshStatus !== 'settled') {
    phase = 'refreshing-scene-models';
    percent = state.assetRefreshStatus === 'active' ? 61 : 57;
    label = '正在刷新场景内模型';
    detail = state.assetRefreshStatus === 'active'
      ? '正在重新关联场景模型与最新资源…'
      : '模型同步完成，等待刷新场景资源…';
  } else if (
    !state.runtime.stable
    && !state.runtime.forcedSettled
    && state.runtime.totalModels === 0
    && state.runtime.expectedBatchedEntities === 0
  ) {
    phase = 'loading-scene-models';
    percent = 65;
    label = '正在加载场景内模型';
    detail = '正在初始化模型运行时…';
  } else if (state.runtime.settledModels < state.runtime.totalModels) {
    phase = 'loading-scene-models';
    const ratio = normalizeRatio(state.runtime.settledModels, state.runtime.totalModels);
    percent = 65 + ratio * 20;
    label = '正在加载场景内模型';
    detail = `模型加载 ${normalizeCount(state.runtime.settledModels)}/${normalizeCount(state.runtime.totalModels)}`;
  } else if (!isRuntimeSettled(state.runtime)) {
    phase = 'batching-scene-models';
    const expected = normalizeCount(state.runtime.expectedBatchedEntities);
    const batched = Math.min(expected, normalizeCount(state.runtime.batchedEntities));
    const ratio = expected === 0 ? (state.runtime.stable ? 1 : 0.9) : normalizeRatio(batched, expected);
    percent = Math.min(99, 86 + ratio * 13);
    label = '正在完成场景内模型合批';
    detail = expected > 0 ? `Geometry 合批 ${batched}/${expected}` : '正在确认 Geometry 合批结果…';
  } else {
    phase = 'completed';
    percent = 100;
    label = '场景准备完成';
    detail = state.warnings.length > 0 ? `已完成，存在 ${state.warnings.length} 条警告` : '模型已同步、刷新并完成合批';
  }

  const completed = phase === 'completed';
  return {
    ...state,
    phase,
    percent: completed ? 100 : Math.min(99, Math.max(previousPercent, Math.round(percent))),
    label,
    detail,
    completed,
  };
}

/** 纯 reducer 供 React 外部 Store 与 Node 回归测试共同复用。 */
export function reduceScenePreparationState(
  state: ScenePreparationState,
  event: ScenePreparationEvent,
): ScenePreparationState {
  let nextState = state;
  let previousPercent = state.percent;

  switch (event.type) {
    case 'model-sync-progress': {
      const progress = {
        ...event.progress,
        completed: normalizeCount(event.progress.completed),
        total: normalizeCount(event.progress.total),
      };
      const isNewRun = state.modelSyncRunId !== progress.runId;
      const isRepeatedTerminal = !isNewRun
        && state.modelSyncStatus === 'settled'
        && (progress.phase === 'completed' || progress.phase === 'failed');
      if (!isNewRun && state.modelSyncStatus === 'settled' && progress.phase !== 'completed' && progress.phase !== 'failed') {
        return state;
      }
      if (isRepeatedTerminal) {
        nextState = {
          ...state,
          modelSyncProgress: progress,
          warnings: progress.phase === 'failed'
            ? appendWarning(state.warnings, progress.error || progress.message)
            : state.warnings,
        };
        break;
      }
      if (isNewRun) previousPercent = 2;
      if (progress.phase === 'failed') {
        nextState = {
          ...state,
          modelSyncStatus: 'settled',
          modelSyncRunId: progress.runId,
          modelSyncProgress: progress,
          assetRefreshStatus: 'pending',
          assetRefreshId: null,
          completed: false,
          warnings: appendWarning(state.warnings, progress.error || progress.message),
        };
      } else if (progress.phase === 'completed') {
        nextState = {
          ...state,
          modelSyncStatus: 'settled',
          modelSyncRunId: progress.runId,
          modelSyncProgress: progress,
          assetRefreshStatus: 'pending',
          assetRefreshId: null,
          completed: false,
        };
      } else {
        nextState = {
          ...state,
          modelSyncStatus: 'active',
          modelSyncRunId: progress.runId,
          modelSyncProgress: progress,
          assetRefreshStatus: isNewRun ? 'pending' : state.assetRefreshStatus,
          assetRefreshId: isNewRun ? null : state.assetRefreshId,
          completed: false,
        };
      }
      break;
    }
    case 'model-sync-skipped':
      if (state.modelSyncStatus !== 'pending') return state;
      nextState = {
        ...state,
        modelSyncStatus: 'skipped',
        assetRefreshStatus: 'pending',
        assetRefreshId: null,
        warnings: appendWarning(state.warnings, event.error),
      };
      break;
    case 'asset-refresh-started':
      previousPercent = state.completed ? 55 : state.percent;
      nextState = {
        ...state,
        assetRefreshStatus: 'active',
        assetRefreshId: event.refreshId,
        completed: false,
        runtime: { ...EMPTY_RUNTIME_PROGRESS },
      };
      break;
    case 'asset-refresh-settled':
      if (event.refreshId !== state.assetRefreshId) return state;
      nextState = {
        ...state,
        assetRefreshStatus: 'settled',
        warnings: appendWarning(state.warnings, event.error),
      };
      break;
    case 'runtime-progress': {
      if (state.completed) return state;
      // 资源热刷新落定前的采样仍属于旧运行时，不能用于解除新资源的准备门控。
      if (state.assetRefreshStatus !== 'settled') return state;
      nextState = {
        ...state,
        completed: false,
        runtime: {
          generation: event.generation,
          totalModels: normalizeCount(event.totalModels),
          settledModels: normalizeCount(event.settledModels),
          expectedBatchedEntities: normalizeCount(event.expectedBatchedEntities),
          batchedEntities: normalizeCount(event.batchedEntities),
          stable: event.stable,
          forcedSettled: false,
        },
      };
      break;
    }
    case 'runtime-settled-with-warning':
      if (state.assetRefreshStatus !== 'settled') return state;
      nextState = {
        ...state,
        runtime: {
          ...state.runtime,
          stable: true,
          forcedSettled: true,
        },
        warnings: appendWarning(state.warnings, event.warning),
      };
      break;
  }

  return deriveScenePreparationState(nextState, previousPercent);
}

type ScenePreparationListener = () => void;

let currentScenePreparationState = createScenePreparationState('initial');
const scenePreparationListeners = new Set<ScenePreparationListener>();

function publishScenePreparationState(nextState: ScenePreparationState): void {
  if (nextState === currentScenePreparationState) return;
  currentScenePreparationState = nextState;
  for (const listener of scenePreparationListeners) listener();
}

/** 切换场景时建立新代次；相同会话重复挂载不会清空已有进度。 */
export function beginScenePreparation(sceneSessionId: string): void {
  if (currentScenePreparationState.sceneSessionId === sceneSessionId) return;
  publishScenePreparationState(createScenePreparationState(sceneSessionId));
}

function dispatchScenePreparationEvent(sceneSessionId: string, event: ScenePreparationEvent): boolean {
  if (currentScenePreparationState.sceneSessionId !== sceneSessionId) return false;
  const nextState = reduceScenePreparationState(currentScenePreparationState, event);
  if (nextState === currentScenePreparationState) return false;
  publishScenePreparationState(nextState);
  return true;
}

export function reportSceneModelSyncProgress(
  sceneSessionId: string,
  progress: ScenePreparationModelSyncProgress,
): void {
  dispatchScenePreparationEvent(sceneSessionId, { type: 'model-sync-progress', progress });
}

export function skipSceneModelSync(sceneSessionId: string, error: string | null): boolean {
  return dispatchScenePreparationEvent(sceneSessionId, { type: 'model-sync-skipped', error });
}

export function beginSceneModelAssetRefresh(sceneSessionId: string, refreshId: string): void {
  dispatchScenePreparationEvent(sceneSessionId, { type: 'asset-refresh-started', refreshId });
}

export function settleSceneModelAssetRefresh(
  sceneSessionId: string,
  error: string | null,
  refreshId: string,
): void {
  dispatchScenePreparationEvent(sceneSessionId, { type: 'asset-refresh-settled', refreshId, error });
}

export function reportSceneRuntimeProgress(
  sceneSessionId: string,
  progress: Omit<ScenePreparationRuntimeProgress, 'forcedSettled'>,
): void {
  dispatchScenePreparationEvent(sceneSessionId, { type: 'runtime-progress', ...progress });
}

export function settleSceneRuntimeWithWarning(sceneSessionId: string, warning: string): void {
  dispatchScenePreparationEvent(sceneSessionId, { type: 'runtime-settled-with-warning', warning });
}

export function getScenePreparationSnapshot(): ScenePreparationState {
  return currentScenePreparationState;
}

/** 全局键盘入口通过同一快照判断是否应阻止编辑操作。 */
export function isScenePreparationActive(): boolean {
  return !currentScenePreparationState.completed;
}

export function subscribeScenePreparation(listener: ScenePreparationListener): () => void {
  scenePreparationListeners.add(listener);
  return () => scenePreparationListeners.delete(listener);
}
