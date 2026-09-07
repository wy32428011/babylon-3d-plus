import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createScenePreparationState, reduceScenePreparationState } from '../../src/editor/loading/scenePreparationProgress.ts';

async function sampleEnvironment(sourceUrl: string | null, phase: string, expected = true) {
  const source = await readFile(new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url), 'utf8');
  const total = source.match(/const totalSceneModels = [^;]+;/)?.[0];
  const readiness = source.match(/const environmentReady = [\s\S]+?(?=\s*const runtimeMetrics =)/)?.[0];
  assert.ok(total && readiness);
  return runInNewContext(`(() => { let settledModels = 1; ${total} ${readiness} return { totalSceneModels, settledModels, environmentReady }; })()`, {
    modelEntityIds: ['device'],
    sceneRuntimeEnvironmentExpected: expected,
    sceneRuntimeEnvironmentSourceUrl: sourceUrl,
    environmentSnapshot: { phase, sourceUrl },
  }) as { totalSceneModels: number; settledModels: number; environmentReady: boolean };
}

test('异机环境待同步时仍计入总模型，设备先就绪不能提前完成', async () => {
  const pending = await sampleEnvironment(null, 'idle');
  assert.equal(pending.totalSceneModels, 2);
  assert.equal(pending.settledModels, 1);
  assert.equal(pending.environmentReady, false);
  const failed = await sampleEnvironment('local-env.glb', 'error');
  assert.equal(failed.totalSceneModels, 2);
  assert.equal(failed.settledModels, 1);
  assert.equal(failed.environmentReady, false);
  const emptyScene = await sampleEnvironment(null, 'idle', false);
  assert.equal(emptyScene.totalSceneModels, 1);
  assert.equal(emptyScene.environmentReady, true);
});

test('下载并初始化环境后仍等待实际首帧，超时不完成；首帧后才100%', async () => {
  const ready = await sampleEnvironment('local-env.glb', 'ready');
  assert.equal(ready.settledModels, 2);
  let state = createScenePreparationState('remote-scene');
  state = reduceScenePreparationState(state, { type: 'model-sync-skipped', error: null });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-started', refreshId: 'refresh' });
  state = reduceScenePreparationState(state, { type: 'asset-refresh-settled', refreshId: 'refresh', error: null });
  const progress = { type: 'runtime-progress' as const, generation: 'g', totalModels: ready.totalSceneModels,
    settledModels: ready.settledModels, expectedBatchedEntities: 0, batchedEntities: 0, stable: false };
  state = reduceScenePreparationState(state, progress);
  assert.equal(state.completed, false);
  state = reduceScenePreparationState(state, { type: 'runtime-settled-with-warning', warning: '仍在等待首帧' });
  assert.equal(state.completed, false);
  assert.ok(state.percent < 100);
  state = reduceScenePreparationState(state, { ...progress, stable: true });
  assert.equal(state.completed, true);
  assert.equal(state.percent, 100);
});
