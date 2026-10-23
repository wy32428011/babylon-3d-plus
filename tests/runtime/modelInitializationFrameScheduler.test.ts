import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelInitializationScheduler, yieldModelInitializationFrame } from '../../src/runtime/babylon/modelInitializationScheduler.ts';

test('低成本多宿主仍按每片数量跨帧分配，FIFO 与同步 onStart 完整保留', async () => {
  let frame = 0, now = 0;
  const calls: string[] = [];
  const scheduler = new ModelInitializationScheduler(6, () => now, async () => { frame++; }, { maxTasksPerSlice: 2, deferFirstSlice: true });
  await Promise.all([0, 1, 2, 3, 4].map(i => scheduler.run(() => {
    calls.push(`start-${i}@${frame}`);
    if (i === 2) now += 20;
    calls.push(`end-${i}@${frame}`);
  })));
  assert.deepEqual(calls, ['start-0@1', 'end-0@1', 'start-1@1', 'end-1@1', 'start-2@2', 'end-2@2', 'start-3@3', 'end-3@3', 'start-4@3', 'end-4@3']);
  assert.equal(scheduler.getMetrics().maxTaskMs, 20, '单个同步脚本仍不可抢占，指标须保留真实耗时');
  assert.equal(scheduler.getMetrics().completedTasks, 5);
});

test('排队取消释放任务并拒绝等待者，其它宿主与后续批次继续执行', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new ModelInitializationScheduler(6, () => 0, () => gate, { deferFirstSlice: true });
  const controller = new AbortController();
  let called = 0;
  const cancelled = scheduler.run(() => { called++; }, controller.signal);
  const active = scheduler.run(() => 42);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  release();
  assert.equal(await active, 42);
  assert.equal(called, 0);
  assert.equal(scheduler.getMetrics().cancelledTasks, 1);
  assert.equal(await scheduler.run(() => 43), 43);
});

test('没有 rAF 或后台暂停 rAF 时仍通过计时器结算', async t => {
  await yieldModelInitializationFrame();
  let requested = 0, cancelled = 0;
  const names = ['requestAnimationFrame', 'cancelAnimationFrame', 'document'] as const;
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  t.after(() => names.forEach((name, i) => {
    if (originals[i]) Object.defineProperty(globalThis, name, originals[i]!);
    else Reflect.deleteProperty(globalThis, name);
  }));
  const documentState = { hidden: false };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentState });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => { requested++; return 7; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => { cancelled++; } });
  await yieldModelInitializationFrame();
  assert.equal(requested, 1);
  assert.equal(cancelled, 1);
  documentState.hidden = true;
  await yieldModelInitializationFrame();
  assert.equal(requested, 1, '隐藏窗口不等待已暂停的 rAF');
});
