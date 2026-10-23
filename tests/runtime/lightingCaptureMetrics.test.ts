import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureLightingInputWithMetrics } from '../../src/runtime/babylon/lightingCaptureMetrics.ts';

test('准备计量保留原输入，记录最大观察堆与实际耗时，不冒充RSS', async () => {
  let heap = 100, now = 0;
  const input = { meshes: ['actual-source'] };
  const measured = await captureLightingInputWithMetrics(async sample => {
    heap = 300; sample(); heap = 200; now = 42; return input;
  }, undefined, () => heap, () => now);
  assert.equal(measured.value, input);
  assert.deepEqual(measured.metrics, { durationMs: 42, rendererHeapMaxObservedBytes: 300, rendererHeapBasis: 'performance.memory.usedJSHeapSize' });
});
test('缺少测量能力时保留null，取消可立即结束并释放计量定时器', async () => {
  const measured = await captureLightingInputWithMetrics(async () => true, undefined, () => null);
  assert.equal(measured.metrics.rendererHeapMaxObservedBytes, null);
  assert.equal(measured.metrics.rendererHeapBasis, 'unavailable');
  let reads = 0;
  const abort = new AbortController();
  const pending = captureLightingInputWithMetrics(async () => new Promise(() => {}), abort.signal, () => { reads++; return 10; });
  abort.abort(new Error('停止准备'));
  await assert.rejects(pending, /停止准备/);
  const settledReads = reads;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(reads, settledReads);
});
test('非关键堆计量访问失败不能改变真实捕获的成功或错误', async () => {
  const read = () => { throw new Error('计量不可用'); };
  const measured = await captureLightingInputWithMetrics(async () => '真实输入', undefined, read);
  assert.equal(measured.value, '真实输入');
  assert.equal(measured.metrics.rendererHeapMaxObservedBytes, null);
  await assert.rejects(captureLightingInputWithMetrics(async () => { throw new Error('真实捕获错误'); }, undefined, read), /真实捕获错误/);
});
test('计时时钟抛错、非有限或倒退均标为未测，仍交付真实捕获', async () => {
  let calls = 0;
  const clocks = [() => { throw new Error('时钟不可用'); }, () => NaN,
    () => ++calls === 1 ? 10 : 5];
  for (const clock of clocks) {
    let captured = false;
    const measured = await captureLightingInputWithMetrics(async () => { captured = true; return '真实几何'; }, undefined, () => 200, clock);
    assert.equal(captured, true);
    assert.equal(measured.value, '真实几何');
    assert.equal(measured.metrics.durationMs, null);
  }
});
