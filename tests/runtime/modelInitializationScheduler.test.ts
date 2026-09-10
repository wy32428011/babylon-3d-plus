import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelInitializationScheduler } from '../../src/runtime/babylon/modelInitializationScheduler.ts';

test('初始化按调用顺序执行，超过时间片后先让出给文件与界面任务', async () => {
  let now = 0;
  const order: string[] = [];
  const scheduler = new ModelInitializationScheduler(6, () => now, async () => { order.push('io'); });
  const results = [0, 1, 2, 3, 4].map(i => scheduler.run(() => { now += 4; order.push(`model-${i}`); return i; }));
  assert.deepEqual(await Promise.all(results), [0, 1, 2, 3, 4]);
  assert.deepEqual(order, ['model-0', 'model-1', 'io', 'model-2', 'model-3', 'io', 'model-4']);
});

test('单个模型初始化失败不阻断其他模型，后续批次仍能执行', async () => {
  const scheduler = new ModelInitializationScheduler();
  const results = await Promise.allSettled([scheduler.run(() => { throw new Error('broken'); }), scheduler.run(() => 2)]);
  assert.equal(results[0].status, 'rejected');
  assert.deepEqual(results[1], { status: 'fulfilled', value: 2 });
  assert.equal(await scheduler.run(() => 3), 3);
});

test('浏览器让出调度失败后队列继续结算，下一批仍可执行', async () => {
  let now = 0;
  const scheduler = new ModelInitializationScheduler(1, () => now, async () => { throw new Error('yield failed'); });
  const first = scheduler.run(() => { now += 2; return 1; });
  const second = scheduler.run(() => 2);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(await scheduler.run(() => 3), 3);
});

test('等待中的模型在被取消后不会启动，随后任务可以在同一轮次加入', async () => {
  let now = 0, cancelled = false, started = 0;
  const scheduler = new ModelInitializationScheduler(1, () => now, async () => { cancelled = true; });
  const first = scheduler.run(() => { now += 2; });
  const second = scheduler.run(() => { if (!cancelled) started++; });
  await Promise.all([first, second]);
  assert.equal(started, 0);
  assert.equal(await scheduler.run(() => scheduler.run(() => 4)), 4);
});
