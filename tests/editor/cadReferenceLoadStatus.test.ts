import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publishCadReferenceLoadStatus, forgetCadReferenceLoadStatus, selectCadReferenceRuntimeProgress,
  waitForCadReferenceReady, registerCadReferenceLoadCancellation, cancelCadReferenceLoad,
} from '../../src/editor/cad/cadReferenceLoadStatus.ts';

test('CAD 只有真实首帧就绪才结束等待，渲染批次状态继续保持等待', async () => {
  const id = 'cad-ready';
  let completed = false;
  const stages: string[] = [];
  const promise = waitForCadReferenceReady(id, { onProgress: status => stages.push(status.state) }).then(() => { completed = true; });
  publishCadReferenceLoadStatus({ entityId: id, sourceUrl: 'cad://ready', state: 'rendering', percent: 96, detail: '创建线稿' });
  await Promise.resolve();
  assert.equal(completed, false);
  publishCadReferenceLoadStatus({ entityId: id, sourceUrl: 'cad://ready', state: 'ready', percent: 100, detail: '首帧完成' });
  await promise;
  assert.equal(completed, true);
  assert.deepEqual(stages, ['rendering', 'ready']);
  forgetCadReferenceLoadStatus(id);
});

test('CAD 错误可见且只终止对应图纸等待，迟到等待也能读到结果', async () => {
  const id = 'cad-error';
  publishCadReferenceLoadStatus({ entityId: id, sourceUrl: 'cad://error', state: 'error', percent: 55, detail: 'CAD 几何内存预算不足' });
  await assert.rejects(waitForCadReferenceReady(id), /内存预算不足/);
  forgetCadReferenceLoadStatus(id);
});

test('取消和删除 CAD 结束尚未完成的等待，取消句柄仅释放本任务', async () => {
  const id = 'cad-cancel';
  const controller = new AbortController();
  let canceled = 0;
  const unregister = registerCadReferenceLoadCancellation(id, () => { canceled += 1; });
  const pending = waitForCadReferenceReady(id, { signal: controller.signal });
  cancelCadReferenceLoad(id);
  assert.equal(canceled, 1);
  controller.abort();
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
  unregister();
  cancelCadReferenceLoad(id);
  assert.equal(canceled, 1);
  const deleted = waitForCadReferenceReady(id);
  forgetCadReferenceLoadStatus(id);
  await assert.rejects(deleted, error => error instanceof Error && error.name === 'AbortError');
});

test('多 CAD 重开保持活动任务取消入口，全部结束后保留错误', () => {
  const small = { entityId: 'small', sourceUrl: 'cad://small', state: 'ready' as const, percent: 100, detail: '完成' };
  const large = { entityId: 'large', sourceUrl: 'cad://large', state: 'loading' as const, percent: 35, detail: '扫描大图' };
  const progress = selectCadReferenceRuntimeProgress([large, small], 'small');
  assert.equal(progress?.activeCount, 1);
  assert.equal(progress?.status.entityId, 'large');
  const failure = { ...large, state: 'error' as const, detail: '大图加载失败' };
  const done = selectCadReferenceRuntimeProgress([failure, small], 'small');
  assert.equal(done?.activeCount, 0);
  assert.equal(done?.status.state, 'error');
  assert.equal(done?.status.detail, '大图加载失败');
});
