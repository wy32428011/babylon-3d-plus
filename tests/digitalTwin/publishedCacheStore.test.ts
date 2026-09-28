import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { IndexedDbPublishedCacheStore } from '../../src/runtime/assets/publishedCacheStore.ts';

/** 分离原生事务状态与 JS 事件派发，复现繁忙渲染线程下的跨任务队列竞态。 */
function databaseHarness(context: TestContext) {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  context.mock.method(performance, 'now', () => Date.now());
  type Request = { result: unknown; onsuccess?: () => void; onerror?: () => void };
  const transactions: Array<{
    stores: string[]; mode: string; finished: boolean; abortCalls: number; putError?: Error;
    requests: Array<{ operation: string; store: string; key?: string; request: Request }>;
    error: DOMException | null; oncomplete?: () => void; onabort?: () => void; onerror?: () => void;
    objectStore(name: string): object; abort(): void;
  }> = [];
  const database = {
    close() {},
    transaction(stores: string[], mode: string) {
      const transaction: typeof transactions[number] = {
        stores, mode, finished: false, abortCalls: 0, requests: [], error: null,
        objectStore(name) {
          const enqueue = (operation: string, key?: string) => {
            const request: Request = { result: undefined };
            transaction.requests.push({ operation, store: name, key, request });
            return request;
          };
          return {
            get: (key: string) => enqueue('get', key), getAll: () => enqueue('getAll'),
            put: (_value: unknown, key?: string) => { if (transaction.putError) throw transaction.putError; return enqueue('put', key); }, delete: (key: string) => enqueue('delete', key),
          };
        },
        abort() {
          transaction.abortCalls++;
          if (transaction.finished) throw new DOMException('The transaction has finished.', 'InvalidStateError');
          transaction.finished = true;
          queueMicrotask(() => transaction.onabort?.());
        },
      };
      transactions.push(transaction);
      return transaction;
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
    open() {
      const request = { result: database, onsuccess: undefined as (() => void) | undefined };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  } });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
  return { transactions };
}

async function flushMicrotasks(): Promise<void> { for (let index = 0; index < 8; index++) await Promise.resolve(); }

test('已完成事务的完成事件晚于超时任务：不抛 InvalidStateError，仍交付读取结果', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const read = store.get('model');
  await flushMicrotasks();
  const transaction = transactions[0];
  const request = transaction.requests.find(item => item.store === 'values' && item.operation === 'get')!.request;
  request.result = 'cached-model'; request.onsuccess?.();
  transaction.finished = true;
  try {
    assert.doesNotThrow(() => context.mock.timers.tick(30_000), '事务已结束时超时回调不能产生未捕获异常');
  } finally {
    transaction.oncomplete?.();
    assert.equal(await read, 'cached-model');
    store.close();
  }
});

test('读取大模型使用 readonly 数据事务，不为访问时间持有 values 写锁', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const read = store.get('model');
  await flushMicrotasks();
  const transaction = transactions[0];
  transaction.finished = true; transaction.oncomplete?.();
  await read; store.close();
  assert.equal(transaction.mode, 'readonly');
  assert.deepEqual(transaction.stores, ['values']);
});

test('真实挂起的事务只中止一次，Promise 拒绝且迟到事件不能改变结果', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const read = store.get('model');
  const rejected = assert.rejects(read, /超时/);
  await flushMicrotasks();
  const transaction = transactions[0];
  context.mock.timers.tick(30_000);
  await rejected;
  transaction.oncomplete?.();
  context.mock.timers.tick(60_000);
  assert.equal(transaction.abortCalls, 1);
  store.close();
});

test('关闭缓存会结算在途操作并撤销超时，迟到的完成事件不重复 abort', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const read = store.get('model');
  const rejected = assert.rejects(read, { name: 'AbortError' });
  await flushMicrotasks();
  const transaction = transactions[0];
  store.close(); store.close();
  await rejected;
  assert.doesNotThrow(() => context.mock.timers.tick(60_000));
  transaction.oncomplete?.();
  assert.equal(transaction.abortCalls, 1);
  await assert.rejects(store.get('later'), /已关闭/);
});

test('排队超过三秒仍可完成；请求有进展时重新计算停滞期限', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const read = store.get('model');
  await flushMicrotasks();
  const transaction = transactions[0];
  context.mock.timers.tick(29_000);
  assert.equal(transaction.abortCalls, 0);
  const request = transaction.requests.find(item => item.store === 'values')!.request;
  request.result = 'large-model'; request.onsuccess?.();
  context.mock.timers.tick(2_000);
  assert.equal(transaction.abortCalls, 0);
  transaction.finished = true; transaction.oncomplete?.();
  assert.equal(await read, 'large-model');
  store.close();
});

test('原生事务已中止但 abort 事件尚未派发：保留原始错误而非误报超时', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const read = store.get('model');
  const rejected = assert.rejects(read, { name: 'QuotaExceededError' });
  await flushMicrotasks();
  const transaction = transactions[0];
  transaction.error = new DOMException('quota', 'QuotaExceededError');
  transaction.finished = true;
  assert.doesNotThrow(() => context.mock.timers.tick(30_000));
  transaction.onabort?.();
  await rejected;
  store.close();
});

test('异步请求回调内 put 抛出 DataCloneError 时安全中止并拒绝，不产生未捕获异常', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const write = store.put('bad-data', () => undefined, 1);
  const rejected = assert.rejects(write, { name: 'DataCloneError' });
  await flushMicrotasks();
  const transaction = transactions[0];
  transaction.putError = new DOMException('cannot clone data', 'DataCloneError');
  const request = transaction.requests.find(item => item.operation === 'getAll')!.request;
  request.result = [];
  assert.doesNotThrow(() => request.onsuccess?.());
  await rejected;
  assert.equal(transaction.abortCalls, 1);
  store.close();
});

test('缓存数据读取完成后即可返回，批量 LRU 写入只锁 metadata 并可独立取消', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const reads = [store.get('a'), store.get('b')];
  await flushMicrotasks();
  for (const transaction of transactions) {
    const request = transaction.requests[0].request;
    request.result = 'cached';
    request.onsuccess?.(); transaction.finished = true; transaction.oncomplete?.();
  }
  assert.deepEqual(await Promise.all(reads), ['cached', 'cached']);
  context.mock.timers.tick(100);
  assert.equal(transactions.length, 3, '合并两个读取的 LRU 更新');
  assert.deepEqual(transactions[2].stores, ['metadata']);
  assert.equal(transactions[2].mode, 'readwrite');
  store.close();
  await flushMicrotasks();
  context.mock.timers.tick(60_000);
});

test('完整发布原始文件独立存储且不参与逐条 LRU 淘汰', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore({ databaseName: 'release-test', evict: false, maxEntryBytes: 1024 });
  const write = store.put('chunk', new Blob(['model']), 5);
  await flushMicrotasks();
  const transaction = transactions[0];
  assert.equal(transaction.requests.some(item => item.operation === 'getAll'), false);
  assert.equal(transaction.requests.filter(item => item.operation === 'put').length, 2);
  transaction.finished = true; transaction.oncomplete?.();
  await write;
  store.close();
});

test('watchdog 晚交付时先给排队成功事件短宽限，不把渲染阻塞误判为存储停滞', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const read = store.get('environment-chunk');
  const outcome = read.catch(error => error);
  await flushMicrotasks();
  const transaction = transactions[0];
  const request = transaction.requests[0].request;
  request.result = 'cached-environment';
  try {
    context.mock.timers.tick(90_000);
    assert.equal(transaction.abortCalls, 0, '30 秒定时器晚了 60 秒，不能立即中止仍待派发成功事件的事务');
    request.onsuccess?.();
    transaction.finished = true; transaction.oncomplete?.();
    assert.equal(await outcome, 'cached-environment');
  } finally { store.close(); }
});

test('迟到补偿只有一秒，宽限期间仍无进展则必须中止', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const read = store.get('hung-after-render');
  const rejected = assert.rejects(read, /超时/);
  await flushMicrotasks();
  try {
    context.mock.timers.tick(90_000);
    assert.equal(transactions[0].abortCalls, 0);
    context.mock.timers.tick(999);
    assert.equal(transactions[0].abortCalls, 0);
    context.mock.timers.tick(1);
    await rejected;
    assert.equal(transactions[0].abortCalls, 1);
  } finally { store.close(); }
});

test('同一无进展周期即使宽限定时器再次迟到，也不能再次补偿', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const read = store.get('always-late');
  const rejected = assert.rejects(read, /超时/);
  await flushMicrotasks();
  try {
    context.mock.timers.tick(90_000);
    assert.equal(transactions[0].abortCalls, 0);
    context.mock.timers.tick(60_000);
    await rejected;
    assert.equal(transactions[0].abortCalls, 1);
  } finally { store.close(); }
});

test('真实请求成功后重新计时，后续独立停滞周期可获得一次迟到补偿', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore({ evict: false });
  const write = store.put('chunk', new Blob(['model']), 5);
  const outcome = write.catch(error => error);
  await flushMicrotasks();
  const transaction = transactions[0];
  assert.equal(transaction.requests.length, 2);
  try {
    context.mock.timers.tick(90_000);
    assert.equal(transaction.abortCalls, 0);
    transaction.requests[0].request.onsuccess?.();
    context.mock.timers.tick(90_000);
    assert.equal(transaction.abortCalls, 0);
    transaction.requests[1].request.onsuccess?.();
    transaction.finished = true; transaction.oncomplete?.();
    assert.equal(await outcome, undefined);
  } finally { store.close(); }
});

test('迟到宽限期间 close 仍即时中止并撤销全部定时器', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const read = store.get('closing');
  const outcome = read.catch(error => error);
  await flushMicrotasks();
  context.mock.timers.tick(90_000);
  assert.equal(transactions[0].abortCalls, 0);
  store.close();
  assert.equal((await outcome).name, 'AbortError');
  context.mock.timers.tick(60_000);
  assert.equal(transactions[0].abortCalls, 1);
});

test('定时器仅有一秒正常调度误差时不延长真实停滞', async context => {
  const { transactions } = databaseHarness(context);
  const store = new IndexedDbPublishedCacheStore();
  const read = store.get('regular-stall');
  const rejected = assert.rejects(read, /超时/);
  await flushMicrotasks();
  context.mock.timers.tick(31_000);
  await rejected;
  assert.equal(transactions[0].abortCalls, 1);
  store.close();
});
