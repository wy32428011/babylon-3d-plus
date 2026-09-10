import assert from 'node:assert/strict';
import test from 'node:test';
import { commitPublishRecovery, publishWithResourceRetry, waitForPublishCondition } from '../../src/editor/deployment/publishOrchestration.ts';
import { beginScenePreparation, beginSceneModelAssetRefresh, settleSceneModelAssetRefresh, skipSceneModelSync, reportSceneRuntimeProgress, getScenePreparationSnapshot } from '../../src/editor/loading/scenePreparationProgress.ts';

test('资源冲突重新准备与序列化，使用新的上传请求 ID', async () => {
  const events: string[] = [];
  let sequence = 0;
  const result = await publishWithResourceRetry({
    createRequestId: () => `attempt-${++sequence}`, assertCurrent: () => {},
    prepare: async id => { events.push(`prepare:${id}`); return `scene-${sequence}`; },
    publish: async (id, scene) => { events.push(`publish:${id}:${scene}`); return {
      status: sequence === 1 ? 'conflict' : 'completed', errorCode: sequence === 1 ? 'DIGITAL_TWIN_RESOURCE_REVISION_CONFLICT' : null,
    }; },
  });
  assert.equal(result.result.status, 'completed');
  assert.equal(result.sceneContent, 'scene-2');
  assert.deepEqual(events, ['prepare:attempt-1', 'publish:attempt-1:scene-1', 'prepare:attempt-2', 'publish:attempt-2:scene-2']);
});

test('工程版本冲突不自动覆盖', async () => {
  let calls = 0;
  const outcome = await publishWithResourceRetry({ createRequestId: () => 'one', assertCurrent: () => {},
    prepare: async () => '', publish: async () => { calls++; return { status: 'conflict', errorCode: 'DIGITAL_TWIN_VERSION_CONFLICT' }; } });
  assert.equal(calls, 1); assert.equal(outcome.result.status, 'conflict');
});

test('持续资源变化最多尝试三轮', async () => {
  let calls = 0;
  await publishWithResourceRetry({ createRequestId: () => String(++calls), assertCurrent: () => {},
    prepare: async () => '', publish: async () => ({ status: 'conflict', errorCode: 'DIGITAL_TWIN_RESOURCE_REVISION_CONFLICT' }) });
  assert.equal(calls, 3);
});

test('准备期间取消或切换场景不会上传', async () => {
  let canceled = false;
  await assert.rejects(publishWithResourceRetry({ createRequestId: () => 'one', assertCurrent: () => { if (canceled) throw Error('canceled'); },
    prepare: async () => { canceled = true; return ''; }, publish: async () => { assert.fail('must not upload'); } }), /canceled/);
});

test('等待就绪会持续检查直到实际完成', async () => {
  let ticks = 0;
  await waitForPublishCondition({ assertCurrent: () => {}, ready: () => ticks >= 2, wait: async () => { ticks++; }, timeoutMs: 1000 });
  assert.equal(ticks, 2);
});

test('等待超时和取消均终止流程', async () => {
  await assert.rejects(waitForPublishCondition({ assertCurrent: () => {}, ready: () => false, timeoutMs: 0 }), /超时/);
  await assert.rejects(waitForPublishCondition({ assertCurrent: () => { throw Error('canceled'); }, ready: () => true }), /canceled/);
});

test('上传成功后收到取消仍保留服务端的真实成功结果', async () => {
  let canceled = false;
  const outcome = await publishWithResourceRetry({ createRequestId: () => 'one', assertCurrent: () => { if (canceled) throw Error('canceled'); },
    prepare: async () => 'saved', publish: async () => { canceled = true; return { status: 'completed', errorCode: null }; } });
  assert.equal(outcome.result.status, 'completed');
});

test('资源冲突返回前取消不会创建下一轮请求', async () => {
  let canceled = false;
  let calls = 0;
  await assert.rejects(publishWithResourceRetry({ createRequestId: () => String(++calls), assertCurrent: () => { if (canceled) throw Error('canceled'); },
    prepare: async () => '', publish: async () => { canceled = true; return { status: 'conflict', errorCode: 'DIGITAL_TWIN_RESOURCE_REVISION_CONFLICT' }; } }), /canceled/);
  assert.equal(calls, 1);
});

test('准备快照时资源变化会重新捕获并继续，普通网络错误不会盲目重试', async () => {
  let calls = 0;
  await publishWithResourceRetry({ createRequestId: () => String(++calls), assertCurrent: () => {}, prepare: async () => {
    if (calls === 1) throw new Error('Error invoking remote method: DIGITAL_TWIN_RESOURCE_SNAPSHOT_CONFLICT');
    return 'latest';
  }, publish: async () => ({ status: 'completed', errorCode: null }) });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(publishWithResourceRetry({ createRequestId: () => String(++calls), assertCurrent: () => {},
    prepare: async () => { throw new Error('network unavailable'); }, publish: async () => ({ status: 'completed', errorCode: null }) }), /network/);
  assert.equal(calls, 1);
});

test('已完成同步之后再恢复模型，会重开真实首帧状态并接收新的运行时完成事件', () => {
  const session = 'publish-recovery';
  const runtime = { generation: 'before', totalModels: 1, settledModels: 1, expectedBatchedEntities: 0, batchedEntities: 0, stable: true };
  beginScenePreparation(session);
  skipSceneModelSync(session, null);
  beginSceneModelAssetRefresh(session, 'sync');
  settleSceneModelAssetRefresh(session, null, 'sync');
  reportSceneRuntimeProgress(session, runtime);
  assert.equal(getScenePreparationSnapshot().completed, true);
  commitPublishRecovery({
    beginRefresh: () => beginSceneModelAssetRefresh(session, 'recovery'),
    commit: () => {
      assert.equal(getScenePreparationSnapshot().completed, false);
      assert.equal(getScenePreparationSnapshot().runtime.stable, false);
      return true;
    },
    settleRefresh: error => settleSceneModelAssetRefresh(session, error, 'recovery'),
  });
  assert.equal(getScenePreparationSnapshot().completed, false);
  reportSceneRuntimeProgress(session, { ...runtime, generation: 'restored-models' });
  assert.equal(getScenePreparationSnapshot().completed, true);
  assert.equal(getScenePreparationSnapshot().runtime.generation, 'restored-models');
});

test('恢复提交失败也结算资源刷新并保留失败原因', () => {
  let failure: string | null = null;
  assert.throws(() => commitPublishRecovery({ beginRefresh: () => {}, commit: () => false, settleRefresh: error => { failure = error; } }), /未能提交/);
  assert.match(failure!, /未能提交/);
});
