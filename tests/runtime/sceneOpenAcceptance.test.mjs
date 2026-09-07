import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSceneOpenReady } from '../../scripts/lib/sceneOpenAcceptance.mjs';

test('失败模型移出运行时后pending归零，仍不得通过验收', () => {
  const preparation = { completed: true, runtimeStable: true, forcedSettled: false };
  const loading = { pendingModelCount: 0, active: [], environmentPhase: 'ready', failedModelAcquisitions: 0,
    stages: { assetReadDecode: { failedCount: 0 } } };
  assert.doesNotThrow(() => assertSceneOpenReady(preparation, loading));
  assert.throws(() => assertSceneOpenReady(preparation, { ...loading, failedModelAcquisitions: 1 }), /实例创建失败/);
  assert.throws(() => assertSceneOpenReady(preparation, { ...loading, stages: { assetReadDecode: { failedCount: 1 } } }), /加载阶段失败/);
  assert.throws(() => assertSceneOpenReady({ ...preparation, forcedSettled: true }, loading), /自然完成/);
  assert.throws(() => assertSceneOpenReady(preparation, { ...loading, environmentPhase: 'error' }), /环境/);
});
