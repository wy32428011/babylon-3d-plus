import assert from 'node:assert/strict';
import test from 'node:test';
import { beginScenePreparation, skipSceneModelSync, beginSceneModelAssetRefresh, settleSceneModelAssetRefresh,
  reportSceneRuntimeProgress, settleSceneRuntimeWithWarning, getScenePreparationTimings } from '../../src/editor/loading/scenePreparationProgress.ts';

test('准备耗时在自然完成后冻结，新会话清空，超时警告不能提前结束计时', (context) => {
  let now = 100;
  context.mock.method(performance, 'now', () => now);
  beginScenePreparation('timings-first');
  skipSceneModelSync('timings-first', null);
  beginSceneModelAssetRefresh('timings-first', 'refresh');
  now = 110;
  settleSceneModelAssetRefresh('timings-first', null, 'refresh');
  settleSceneRuntimeWithWarning('timings-first', '仍在等待');
  assert.equal(getScenePreparationTimings().completed, false);
  now = 130;
  reportSceneRuntimeProgress('timings-first', { generation: 'one', totalModels: 1,
    settledModels: 1, expectedBatchedEntities: 0, batchedEntities: 0, stable: true });
  assert.equal(getScenePreparationTimings().completed, true);
  assert.equal(getScenePreparationTimings().forcedSettled, false);
  assert.equal(getScenePreparationTimings().totalMs, 30);
  now = 200;
  assert.equal(getScenePreparationTimings().totalMs, 30);
  beginScenePreparation('timings-second');
  assert.equal(getScenePreparationTimings().totalMs, 0);
  assert.equal(getScenePreparationTimings().completed, false);
});

test('明确带问题继续后冻结本轮耗时，但不报告加载成功', context => {
  let now = 500;
  context.mock.method(performance, 'now', () => now);
  beginScenePreparation('timings-partial');
  skipSceneModelSync('timings-partial', null);
  beginSceneModelAssetRefresh('timings-partial', 'partial');
  settleSceneModelAssetRefresh('timings-partial', null, 'partial');
  now = 700;
  settleSceneRuntimeWithWarning('timings-partial', '资源不可用', true);
  assert.equal(getScenePreparationTimings().completed, false);
  assert.equal(getScenePreparationTimings().settled, true);
  now = 1200;
  assert.equal(getScenePreparationTimings().totalMs, 200);
});
