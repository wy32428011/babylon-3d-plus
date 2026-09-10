import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginScenePreparation,
  countExpectedSceneBatchedEntities,
  createScenePreparationState,
  reduceScenePreparationState,
  skipSceneModelSync,
} from '../../src/editor/loading/scenePreparationProgress.ts';
import type { Entity } from '../../src/editor/model/Entity.ts';

test('远端场景局部失败可带警告进入编辑，仍保留未通过运行时校验的标记', () => {
  let state = createScenePreparationState('remote');
  state = reduceScenePreparationState(state, { type: 'model-sync-skipped', error: null });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'retry' });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-settled', refreshId: 'retry', error: '模型下载失败' });
  state = reduceScenePreparationState(state, { type: 'runtime-settled-with-warning', warning: '模型下载失败', allowEditing: true });
  assert.equal(state.completed, false);
  assert.equal(state.phase, 'partial');
  assert.ok(state.percent < 100);
  assert.equal(state.runtime.forcedSettled, true);
  assert.deepEqual(state.warnings, ['模型下载失败']);
});

test('资源查询期间不能提前解除加载门控；本地原有失败仍保持门控', () => {
  const initial = createScenePreparationState('remote');
  const editable = reduceScenePreparationState(initial, { type: 'editing-allowed', allowed: true });
  assert.equal(editable.editingAllowed, false);
  assert.equal(editable.completed, false);
  let local = reduceScenePreparationState(initial, { type: 'model-sync-skipped', error: null });
  local = reduceScenePreparationState(local, { type: 'asset-refresh-started', refreshId: 'local' });
  local = reduceScenePreparationState(local, { type: 'asset-refresh-settled', refreshId: 'local', error: null });
  local = reduceScenePreparationState(local, { type: 'runtime-settled-with-warning', warning: '本地失败' });
  assert.equal(local.completed, false);
});

test('带问题继续编辑后重试立即恢复门控，并清除上一轮的终态', () => {
  let state = createScenePreparationState('retry-partial');
  state = reduceScenePreparationState(state, { type: 'model-sync-skipped', error: null });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'first' });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-settled', refreshId: 'first', error: null });
  state = reduceScenePreparationState(state, { type: 'runtime-settled-with-warning', warning: '加载失败', allowEditing: true });
  state = reduceScenePreparationState(state, { type: 'model-sync-progress', progress: {
    runId: 'retry', phase: 'querying', completed: 0, total: 0, message: '重试', error: null,
  } });
  assert.equal(state.editingAllowed, false);
  assert.equal(state.runtime.forcedSettled, false);
  assert.equal(state.completed, false);
  assert.deepEqual(state.warnings, []);
});

test('模型已全部就绪但天空盒仍在准备时，显示真实等待资源而不是合批完成', () => {
  let state = createScenePreparationState('skybox-pending');
  state = reduceScenePreparationState(state, { type: 'model-sync-skipped', error: null });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'one' });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-settled', refreshId: 'one', error: null });
  state = reduceScenePreparationState(state, { type: 'runtime-progress', generation: 'one',
    totalModels: 98, settledModels: 98, expectedBatchedEntities: 0, batchedEntities: 0,
    stable: false, waitingResource: '正在准备天空盒 skybox.exr' });
  assert.equal(state.completed, false);
  assert.ok(state.percent < 100);
  assert.equal(state.detail, '正在准备天空盒 skybox.exr');
});

function createPreparationModelEntity(
  id: string,
  options: {
    parentId?: string | null;
    visible?: boolean;
    sourceEntityId?: string;
  } = {},
): Entity {
  return {
    id,
    name: id,
    visible: options.visible ?? true,
    locked: false,
    parentId: options.parentId ?? null,
    childrenIds: [],
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      modelAsset: {
        sourcePath: `${id}.glb`,
        sourceUrl: `${id}.glb`,
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
      },
      ...(options.sourceEntityId
        ? { modelArrayInstance: { sourceEntityId: options.sourceEntityId } }
        : {}),
    },
  };
}

test('Geometry 合批期望值包含持久化实例，并忽略层级隐藏的逻辑实体', () => {
  const source = createPreparationModelEntity('source');
  const visibleInstance = createPreparationModelEntity('visible-instance', { sourceEntityId: source.id });
  const hiddenFolder: Entity = {
    ...createPreparationModelEntity('hidden-folder', { visible: false }),
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    },
    childrenIds: ['hidden-instance'],
  };
  const hiddenInstance = createPreparationModelEntity('hidden-instance', {
    parentId: hiddenFolder.id,
    sourceEntityId: source.id,
  });
  const hiddenSource = createPreparationModelEntity('hidden-source', { visible: false });
  const visibleInstanceOfHiddenSource = createPreparationModelEntity('visible-instance-of-hidden-source', {
    sourceEntityId: hiddenSource.id,
  });
  const orphanedInstance = createPreparationModelEntity('orphaned-instance', {
    sourceEntityId: 'missing-source',
  });
  const entities = {
    [source.id]: source,
    [visibleInstance.id]: visibleInstance,
    [hiddenFolder.id]: hiddenFolder,
    [hiddenInstance.id]: hiddenInstance,
    [hiddenSource.id]: hiddenSource,
    [visibleInstanceOfHiddenSource.id]: visibleInstanceOfHiddenSource,
    [orphanedInstance.id]: orphanedInstance,
  };

  assert.equal(
    countExpectedSceneBatchedEntities(
      [
        source.id,
        visibleInstance.id,
        hiddenFolder.id,
        hiddenInstance.id,
        hiddenSource.id,
        visibleInstanceOfHiddenSource.id,
        orphanedInstance.id,
      ],
      entities,
    ),
    3,
  );
});

test('模型同步阶段按真实数量推进且百分比不会倒退', () => {
  let state = createScenePreparationState('scene-a');
  state = reduceScenePreparationState(state, {
    type: 'model-sync-progress',
    progress: {
      runId: 'sync-1',
      phase: 'downloading',
      completed: 5,
      total: 10,
      message: '正在下载模型',
      error: null,
    },
  });

  assert.equal(state.phase, 'syncing-models');
  assert.ok(state.percent >= 20 && state.percent < 50);
  const advancedPercent = state.percent;

  state = reduceScenePreparationState(state, {
    type: 'model-sync-progress',
    progress: {
      runId: 'sync-1',
      phase: 'querying',
      completed: 0,
      total: 0,
      message: '收到延迟的查询事件',
      error: null,
    },
  });

  assert.equal(state.percent, advancedPercent);
});

test('模型同步完成后必须等待场景资产刷新', () => {
  let state = createScenePreparationState('scene-b');
  state = reduceScenePreparationState(state, {
    type: 'model-sync-progress',
    progress: {
      runId: 'sync-2',
      phase: 'querying',
      completed: 0,
      total: 0,
      message: '查询模型',
      error: null,
    },
  });
  state = reduceScenePreparationState(state, {
    type: 'model-sync-progress',
    progress: {
      runId: 'sync-2',
      phase: 'completed',
      completed: 12,
      total: 12,
      message: '同步完成',
      error: null,
    },
  });
  state = reduceScenePreparationState(state, {
    type: 'asset-refresh-started',
    refreshId: 'refresh-scene-b',
  });
  state = reduceScenePreparationState(state, {
    type: 'asset-refresh-settled',
    refreshId: 'refresh-scene-b',
    error: null,
  });
  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-b:runtime-1',
    totalModels: 4,
    settledModels: 4,
    expectedBatchedEntities: 8,
    batchedEntities: 8,
    stable: true,
  });

  assert.equal(state.phase, 'completed');
  assert.equal(state.percent, 100);
  assert.equal(state.completed, true);
});

test('场景资产刷新后分别展示模型加载和 Geometry 合批进度', () => {
  let state = createScenePreparationState('scene-c');
  state = reduceScenePreparationState(state, { type: 'model-sync-skipped', error: null });
  assert.equal(state.phase, 'refreshing-scene-models');
  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'refresh-scene-c' });
  state = reduceScenePreparationState(state, {
    type: 'asset-refresh-settled',
    refreshId: 'refresh-scene-c',
    error: null,
  });
  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-c:runtime-1',
    totalModels: 10,
    settledModels: 4,
    expectedBatchedEntities: 20,
    batchedEntities: 0,
    stable: false,
  });

  assert.equal(state.phase, 'loading-scene-models');
  assert.match(state.detail, /4\/10/);
  const loadingPercent = state.percent;

  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-c:runtime-1',
    totalModels: 10,
    settledModels: 10,
    expectedBatchedEntities: 20,
    batchedEntities: 12,
    stable: false,
  });

  assert.equal(state.phase, 'batching-scene-models');
  assert.match(state.detail, /12\/20/);
  assert.ok(state.percent > loadingPercent && state.percent < 100);

  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-c:runtime-1',
    totalModels: 10,
    settledModels: 10,
    expectedBatchedEntities: 20,
    batchedEntities: 20,
    stable: true,
  });

  assert.equal(state.phase, 'completed');
  assert.equal(state.percent, 100);
});

test('同步或合批警告保留原因，缺失批次不能被超时标记为100%', () => {
  let state = createScenePreparationState('scene-d');
  state = reduceScenePreparationState(state, {
    type: 'model-sync-progress',
    progress: {
      runId: 'sync-3',
      phase: 'downloading',
      completed: 1,
      total: 5,
      message: '下载模型',
      error: null,
    },
  });
  state = reduceScenePreparationState(state, {
    type: 'model-sync-progress',
    progress: {
      runId: 'sync-3',
      phase: 'failed',
      completed: 2,
      total: 5,
      message: '同步失败',
      error: '网络不可用',
    },
  });
  assert.equal(state.phase, 'refreshing-scene-models');
  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'refresh-scene-d' });
  state = reduceScenePreparationState(state, {
    type: 'asset-refresh-settled',
    refreshId: 'refresh-scene-d',
    error: null,
  });
  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-d:runtime-1',
    totalModels: 2,
    settledModels: 2,
    expectedBatchedEntities: 5,
    batchedEntities: 2,
    stable: false,
  });
  state = reduceScenePreparationState(state, {
    type: 'runtime-settled-with-warning',
    warning: '部分模型无法完成合批',
  });

  assert.equal(state.completed, false);
  assert.ok(state.percent < 100);
  assert.deepEqual(state.warnings, ['网络不可用', '部分模型无法完成合批']);
  state = reduceScenePreparationState(state, {
    type: 'runtime-progress', generation: 'scene-d:runtime-1', totalModels: 2,
    settledModels: 2, expectedBatchedEntities: 5, batchedEntities: 5, stable: true,
  });
  assert.equal(state.completed, true);
  assert.equal(state.percent, 100);
});

test('运行时超时只记录警告，模型与渲染自然稳定后才完成场景准备', () => {
  let state = createScenePreparationState('scene-timeout');
  state = reduceScenePreparationState(state, { type: 'model-sync-skipped', error: null });
  state = reduceScenePreparationState(state, {
    type: 'asset-refresh-started',
    refreshId: 'refresh-scene-timeout',
  });
  state = reduceScenePreparationState(state, {
    type: 'asset-refresh-settled',
    refreshId: 'refresh-scene-timeout',
    error: null,
  });
  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-timeout:runtime',
    totalModels: 2,
    settledModels: 1,
    expectedBatchedEntities: 4,
    batchedEntities: 2,
    stable: false,
  });
  state = reduceScenePreparationState(state, {
    type: 'runtime-settled-with-warning',
    warning: '运行时准备超时',
  });

  assert.equal(state.completed, false);
  assert.ok(state.percent < 100);
  assert.equal(state.runtime.forcedSettled, true);
  assert.deepEqual(state.warnings, ['运行时准备超时']);

  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-timeout:runtime',
    totalModels: 2,
    settledModels: 2,
    expectedBatchedEntities: 4,
    batchedEntities: 4,
    stable: false,
  });
  assert.equal(state.completed, false);
  assert.ok(state.percent < 100);
  assert.equal(state.runtime.forcedSettled, false);

  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-timeout:runtime',
    totalModels: 2,
    settledModels: 2,
    expectedBatchedEntities: 4,
    batchedEntities: 4,
    stable: true,
  });
  assert.equal(state.completed, true);
  assert.equal(state.runtime.forcedSettled, false);
  assert.equal(state.runtime.stable, true);
});

test('完成后的普通场景更新不会重新打开蒙版，资产刷新会重新建立运行时门控', () => {
  let state = createScenePreparationState('scene-e');
  state = reduceScenePreparationState(state, { type: 'model-sync-skipped', error: null });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'refresh-scene-e-1' });
  state = reduceScenePreparationState(state, {
    type: 'asset-refresh-settled',
    refreshId: 'refresh-scene-e-1',
    error: null,
  });
  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-e:runtime',
    totalModels: 1,
    settledModels: 1,
    expectedBatchedEntities: 0,
    batchedEntities: 0,
    stable: true,
  });
  assert.equal(state.completed, true);

  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-e:runtime',
    totalModels: 1,
    settledModels: 0,
    expectedBatchedEntities: 0,
    batchedEntities: 0,
    stable: false,
  });
  assert.equal(state.completed, true);

  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'refresh-scene-e-2' });
  assert.equal(state.completed, false);
  assert.equal(state.runtime.generation, '');
  state = reduceScenePreparationState(state, {
    type: 'asset-refresh-settled',
    refreshId: 'refresh-scene-e-2',
    error: null,
  });
  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-e:runtime',
    totalModels: 1,
    settledModels: 1,
    expectedBatchedEntities: 0,
    batchedEntities: 0,
    stable: true,
  });
  assert.equal(state.completed, true);
});

test('订阅建立时首次收到已完成同步快照仍进入刷新阶段', () => {
  let state = createScenePreparationState('scene-f');
  state = reduceScenePreparationState(state, {
    type: 'model-sync-progress',
    progress: {
      runId: 'sync-before-subscribe',
      phase: 'completed',
      completed: 1,
      total: 1,
      message: '同步完成',
      error: null,
    },
  });

  assert.equal(state.modelSyncStatus, 'settled');
  assert.equal(state.phase, 'refreshing-scene-models');

  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'refresh-scene-f' });
  state = reduceScenePreparationState(state, {
    type: 'asset-refresh-settled',
    refreshId: 'refresh-scene-f',
    error: null,
  });
  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-f:runtime',
    totalModels: 1,
    settledModels: 1,
    expectedBatchedEntities: 0,
    batchedEntities: 0,
    stable: true,
  });

  assert.equal(state.completed, true);
});

test('模型发现窗口只在同步待定时收口且不会提前结束真实刷新', () => {
  let skippedState = createScenePreparationState('scene-g');
  skippedState = reduceScenePreparationState(skippedState, {
    type: 'model-sync-skipped',
    error: '初始项目资源加载失败',
  });

  assert.equal(skippedState.modelSyncStatus, 'skipped');
  assert.equal(skippedState.assetRefreshStatus, 'pending');
  assert.equal(skippedState.phase, 'refreshing-scene-models');
  assert.deepEqual(skippedState.warnings, ['初始项目资源加载失败']);

  let refreshingState = createScenePreparationState('scene-h');
  refreshingState = reduceScenePreparationState(refreshingState, {
    type: 'model-sync-progress',
    progress: {
      runId: 'sync-refreshing',
      phase: 'completed',
      completed: 1,
      total: 1,
      message: '同步完成',
      error: null,
    },
  });
  refreshingState = reduceScenePreparationState(refreshingState, {
    type: 'asset-refresh-started',
    refreshId: 'refresh-scene-h',
  });
  const unchangedState = reduceScenePreparationState(refreshingState, {
    type: 'model-sync-skipped',
    error: '初始请求已被刷新请求取代',
  });

  assert.equal(unchangedState, refreshingState);
  assert.equal(unchangedState.assetRefreshStatus, 'active');
});

test('场景资产刷新期间忽略旧运行时完成结果', () => {
  let state = createScenePreparationState('scene-i');
  state = reduceScenePreparationState(state, {
    type: 'model-sync-progress',
    progress: {
      runId: 'sync-with-refresh',
      phase: 'completed',
      completed: 4,
      total: 4,
      message: '同步完成',
      error: null,
    },
  });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'refresh-scene-i' });
  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'stale-runtime',
    totalModels: 2,
    settledModels: 2,
    expectedBatchedEntities: 6,
    batchedEntities: 6,
    stable: true,
  });
  state = reduceScenePreparationState(state, {
    type: 'asset-refresh-settled',
    refreshId: 'refresh-scene-i',
    error: null,
  });

  assert.equal(state.completed, false);
  assert.equal(state.phase, 'loading-scene-models');
  assert.equal(state.runtime.generation, '');

  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'refreshed-runtime',
    totalModels: 2,
    settledModels: 2,
    expectedBatchedEntities: 6,
    batchedEntities: 6,
    stable: true,
  });
  assert.equal(state.completed, true);
});

test('较早的场景资产刷新完成事件不能结算较新的刷新请求', () => {
  let state = createScenePreparationState('scene-j');
  state = reduceScenePreparationState(state, { type: 'model-sync-skipped', error: null });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'refresh-1' });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'refresh-2' });
  const staleSettledState = reduceScenePreparationState(state, {
    type: 'asset-refresh-settled',
    refreshId: 'refresh-1',
    error: null,
  });

  assert.equal(staleSettledState, state);
  assert.equal(staleSettledState.assetRefreshStatus, 'active');

  const settledState = reduceScenePreparationState(state, {
    type: 'asset-refresh-settled',
    refreshId: 'refresh-2',
    error: null,
  });
  assert.equal(settledState.assetRefreshStatus, 'settled');
});

test('只有同步仍待定时才允许跳过同步并启动兜底刷新', () => {
  const sceneSessionId = 'scene-k';
  beginScenePreparation(sceneSessionId);

  assert.equal(skipSceneModelSync(sceneSessionId, null), true);
  assert.equal(skipSceneModelSync(sceneSessionId, null), false);
});

test('资源刷新完成前的运行时超时不能解除蒙版', () => {
  let state = createScenePreparationState('scene-l');
  state = reduceScenePreparationState(state, { type: 'model-sync-skipped', error: null });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'refresh-l' });

  const unchangedState = reduceScenePreparationState(state, {
    type: 'runtime-settled-with-warning',
    warning: '不应提前解除',
  });

  assert.equal(unchangedState, state);
  assert.equal(unchangedState.completed, false);
  assert.deepEqual(unchangedState.warnings, []);
});

test('运行时准备超时判断覆盖未创建运行时的边界', async () => {
  const progressModule = await import('../../src/editor/loading/scenePreparationProgress.ts');
  const hasTimedOut = Reflect.get(progressModule, 'hasScenePreparationRuntimeTimedOut');

  assert.equal(typeof hasTimedOut, 'function');
  if (typeof hasTimedOut !== 'function') return;
  assert.equal(hasTimedOut(1_000, 120_999), false);
  assert.equal(hasTimedOut(1_000, 121_000), true);
  assert.equal(hasTimedOut(5_000, 4_000), false);
});

test('同一同步任务的重复终态事件不会重置正在执行的场景刷新', () => {
  for (const phase of ['completed', 'failed'] as const) {
    let state = createScenePreparationState(`scene-duplicate-${phase}`);
    state = reduceScenePreparationState(state, {
      type: 'model-sync-progress',
      progress: {
        runId: `sync-${phase}`,
        phase,
        completed: phase === 'completed' ? 3 : 1,
        total: 3,
        message: phase === 'completed' ? '同步完成' : '同步失败',
        error: phase === 'failed' ? '网络不可用' : null,
      },
    });
    state = reduceScenePreparationState(state, {
      type: 'asset-refresh-started',
      refreshId: `refresh-${phase}`,
    });

    const duplicateState = reduceScenePreparationState(state, {
      type: 'model-sync-progress',
      progress: {
        runId: `sync-${phase}`,
        phase,
        completed: phase === 'completed' ? 3 : 1,
        total: 3,
        message: phase === 'completed' ? '同步完成' : '同步失败',
        error: phase === 'failed' ? '网络不可用' : null,
      },
    });

    assert.equal(duplicateState.assetRefreshStatus, 'active');
    assert.equal(duplicateState.assetRefreshId, `refresh-${phase}`);
  }
});

test('同一失败同步任务在场景准备完成后重放不会重新打开蒙版', () => {
  const failedProgress = {
    runId: 'sync-failed-replayed',
    phase: 'failed' as const,
    completed: 1,
    total: 3,
    message: '同步失败',
    error: '网络不可用',
  };
  let state = createScenePreparationState('scene-failed-replayed');
  state = reduceScenePreparationState(state, {
    type: 'model-sync-progress',
    progress: failedProgress,
  });
  state = reduceScenePreparationState(state, {
    type: 'asset-refresh-started',
    refreshId: 'refresh-failed-replayed',
  });
  state = reduceScenePreparationState(state, {
    type: 'asset-refresh-settled',
    refreshId: 'refresh-failed-replayed',
    error: null,
  });
  state = reduceScenePreparationState(state, {
    type: 'runtime-progress',
    generation: 'scene-failed-replayed:runtime',
    totalModels: 1,
    settledModels: 1,
    expectedBatchedEntities: 0,
    batchedEntities: 0,
    stable: true,
  });
  assert.equal(state.completed, true);

  const replayedState = reduceScenePreparationState(state, {
    type: 'model-sync-progress',
    progress: failedProgress,
  });

  assert.equal(replayedState.completed, true);
  assert.equal(replayedState.assetRefreshStatus, 'settled');
  assert.equal(replayedState.assetRefreshId, 'refresh-failed-replayed');
});
