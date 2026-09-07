import assert from 'node:assert/strict';

/** 新进程打开验收必须同时证明自然就绪与全链路无失败，不能用消失的模型条目掩盖异常。 */
export function assertSceneOpenReady(preparation, loading) {
  assert.ok(preparation?.completed && preparation.runtimeStable && !preparation.forcedSettled,
    '场景准备尚未自然完成');
  assert.ok(loading?.pendingModelCount === 0 && loading.active?.length === 0
    && ['idle', 'ready'].includes(loading.environmentPhase), '仍有未就绪模型或环境');
  assert.equal(loading.failedModelAcquisitions, 0, '模型加载或实例创建失败');
  for (const [stage, metric] of Object.entries(loading.stages ?? {})) {
    assert.equal(metric.failedCount, 0, `加载阶段失败：${stage}`);
  }
}
