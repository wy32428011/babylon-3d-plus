import assert from 'node:assert/strict';
import { createServer } from 'vite';

const MODULE_LOAD_TIMEOUT_MS = 60_000;
const CONDITION_TIMEOUT_MS = 5_000;

/** 在限定时间内通过 Vite SSR 加载 TypeScript 模块。 */
async function loadSsrModuleWithTimeout(server, modulePath) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule(modulePath),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`加载模块超时：${modulePath}`)), MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 创建可由 smoke 主流程手动完成的 Promise 闸门。 */
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

/** 等待异步调度状态满足断言前置条件。 */
async function waitForCondition(name, predicate) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > CONDITION_TIMEOUT_MS) {
      throw new Error(`等待条件超时：${name}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 断言默认调度器并发不超过 4，且排队任务按 FIFO 顺序启动。 */
async function verifyDefaultConcurrencyAndFifo(AssetLoadScheduler, defaultConcurrency) {
  const scheduler = new AssetLoadScheduler();
  const gates = Array.from({ length: 8 }, createDeferred);
  const startedOrder = [];
  let activeCount = 0;
  let maxActiveCount = 0;

  const tasks = gates.map((gate, index) => scheduler.run(async () => {
    startedOrder.push(index);
    activeCount += 1;
    maxActiveCount = Math.max(maxActiveCount, activeCount);
    try {
      await gate.promise;
      return index;
    } finally {
      activeCount -= 1;
    }
  }));

  await waitForCondition('默认并发窗口填满', () => startedOrder.length === defaultConcurrency);
  assert.equal(defaultConcurrency, 4, '默认并发数必须导出为 4');
  assert.equal(activeCount, 4, '默认调度器应同时运行 4 个任务');
  assert.deepEqual(startedOrder, [0, 1, 2, 3], '首批任务必须按提交顺序启动');
  assert.ok(maxActiveCount <= 4, `最大并发不能超过 4，实际 ${maxActiveCount}`);

  gates[0].resolve();
  await waitForCondition('第一个排队任务启动', () => startedOrder.length === 5);
  assert.deepEqual(startedOrder, [0, 1, 2, 3, 4], '释放一个窗口后必须启动最早排队任务');
  assert.ok(maxActiveCount <= 4, `排队补位后最大并发不能超过 4，实际 ${maxActiveCount}`);

  for (let index = 1; index < gates.length; index += 1) {
    gates[index].resolve();
  }
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7], '所有任务应保留各自结果');
  assert.deepEqual(startedOrder, [0, 1, 2, 3, 4, 5, 6, 7], '全部任务必须按 FIFO 顺序启动');
  scheduler.dispose();
}

/** 断言 dispose 会拒绝尚未开始的排队任务，但不会取消活动任务。 */
async function verifyDisposeRejectsQueuedTasks(AssetLoadScheduler) {
  const scheduler = new AssetLoadScheduler(1);
  const activeGate = createDeferred();
  const activeTask = scheduler.run(async () => {
    await activeGate.promise;
    return 'active-finished';
  });
  const queuedTask = scheduler.run(async () => 'queued-should-not-run');

  scheduler.dispose();
  await assert.rejects(queuedTask, /资产加载调度器已释放/, 'dispose 必须拒绝尚未开始的排队任务');
  await assert.rejects(
    scheduler.run(async () => 'new-should-not-run'),
    /资产加载调度器已释放/,
    'dispose 后必须拒绝新任务',
  );

  activeGate.resolve();
  assert.equal(await activeTask, 'active-finished', 'dispose 不应取消已经运行的任务');
}

/** 运行资产加载调度器 smoke 验证。 */
async function main() {
  const server = await createServer({
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });

  try {
    const { AssetLoadScheduler, DEFAULT_ASSET_LOAD_CONCURRENCY } = await loadSsrModuleWithTimeout(
      server,
      '/src/runtime/babylon/AssetLoadScheduler.ts',
    );
    await verifyDefaultConcurrencyAndFifo(AssetLoadScheduler, DEFAULT_ASSET_LOAD_CONCURRENCY);
    await verifyDisposeRejectsQueuedTasks(AssetLoadScheduler);
    console.log('[AssetLoadSchedulerSmoke] 通过：默认并发<=4、FIFO 启动、dispose 拒绝排队任务。');
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error('[AssetLoadSchedulerSmoke] 失败：', error);
  process.exitCode = 1;
});
