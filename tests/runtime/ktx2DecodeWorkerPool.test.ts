import assert from 'node:assert/strict';
import test from 'node:test';
import { Ktx2DecodeWorkerPool, Ktx2WorkerInfrastructureError } from '../../src/runtime/babylon/ktx2DecodeWorkerPool.ts';
import type { LocalKtx2DecoderUrls } from '../../src/runtime/babylon/ktx2DecoderConfiguration.ts';

class FakeWorker extends EventTarget {
  readonly requests: Array<{ action: string; data?: Uint8Array; options?: unknown; transfer?: Transferable[] }> = [];
  terminated = false;
  postMessage(value: { action: string; data?: Uint8Array; options?: unknown }, transfer?: Transferable[]) { this.requests.push({ ...value, transfer }); }
  terminate() { this.terminated = true; }
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
  ready() { this.message({ action: 'init' }); }
  finish(value: unknown) { this.message({ action: 'decoded', success: true, decodedData: value }); }
}
const urls = {} as LocalKtx2DecoderUrls;
const request = (data = new Uint8Array([1, 2, 3])) => ({ data, caps: { s3tc: true }, options: { forceRGBA: true } });
function fixture(context: Parameters<Parameters<typeof test>[1]>[0], count = 2) {
  const workers: FakeWorker[] = [];
  const pool = new Ktx2DecodeWorkerPool(urls, count, () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; });
  context.after(() => pool.dispose());
  return { workers, pool };
}

test('最多两个初始化/执行槽，排队第三个请求完成后复用空闲worker', async context => {
  const { workers, pool } = fixture(context);
  const a = pool.decode(request()), b = pool.decode(request()), c = pool.decode(request());
  assert.equal(workers.length, 2);
  workers.forEach(w => w.ready());
  assert.equal(workers.flatMap(w => w.requests.filter(r => r.action === 'decode')).length, 2);
  workers[0].finish({ width: 1 });
  assert.equal(workers[0].requests.filter(r => r.action === 'decode').length, 2);
  workers[1].finish({ width: 2 }); workers[0].finish({ width: 3 });
  assert.deepEqual(await Promise.all([a, b, c]), [{ width: 1 }, { width: 2 }, { width: 3 }]);
});

test('只转移自有副本，保留调用方buffer且排队期间的后续写入不改已提交数据', async context => {
  const { workers, pool } = fixture(context, 1);
  const input = new Uint8Array([7, 8, 9]), a = pool.decode(request()), b = pool.decode(request(input));
  void a.catch(() => {}); void b.catch(() => {});
  input[0] = 99;
  workers[0].ready(); workers[0].finish({});
  const second = workers[0].requests.filter(r => r.action === 'decode')[1];
  assert.deepEqual([...second.data!], [7, 8, 9]);
  assert.notEqual(second.data!.buffer, input.buffer);
  assert.equal(input.byteLength, 3);
  assert.deepEqual(second.transfer, [second.data!.buffer]);
  workers[0].finish({}); await Promise.all([a, b]);
});

test('worker格式错误按原拒绝值传播，后续任务继续使用健康槽', async context => {
  const { workers, pool } = fixture(context, 1), error = new Error('Invalid KT2 file: wrong signature');
  const a = pool.decode(request()), aRejected = assert.rejects(a, value => value === error), b = pool.decode(request());
  workers[0].ready(); workers[0].message({ action: 'decoded', success: false, msg: error });
  await aRejected; assert.equal(workers.length, 1); assert.equal(workers[0].terminated, false);
  workers[0].finish({ width: 2 }); assert.deepEqual(await b, { width: 2 });
});

test('初始化报错收束全部排队请求并终止所有自有worker，后续不重启故障pool', async context => {
  const { workers, pool } = fixture(context), requests = [pool.decode(request()), pool.decode(request()), pool.decode(request())];
  const checked = Promise.all(requests.map(p => assert.rejects(p, Ktx2WorkerInfrastructureError)));
  workers[0].dispatchEvent(new Event('messageerror'));
  await checked; assert.ok(workers.every(w => w.terminated));
  await assert.rejects(pool.decode(request()), Ktx2WorkerInfrastructureError); assert.equal(workers.length, 2);
});

test('worker构造异常不会留下悬挂promise', async () => {
  const pool = new Ktx2DecodeWorkerPool(urls, 2, () => { throw new Error('CSP blocked'); });
  await assert.rejects(pool.decode(request()), /CSP blocked/); pool.dispose();
});

test('无初始化响应会拒绝并释放，空闲健康槽到期释放后可按需重建', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { workers, pool } = fixture(context, 1);
  const a = pool.decode(request()), rejected = assert.rejects(a, /initialization timed out/);
  context.mock.timers.tick(10001); await rejected; assert.equal(workers[0].terminated, true);
  const healthy = fixture(context, 1), b = healthy.pool.decode(request());
  healthy.workers[0].ready(); healthy.workers[0].finish({}); await b;
  context.mock.timers.tick(10001); assert.equal(healthy.workers[0].terminated, true);
  const c = healthy.pool.decode(request()); assert.equal(healthy.workers.length, 2);
  healthy.workers[1].ready(); healthy.workers[1].finish({}); await c;
});

test('dispose拒绝执行中及待执行请求，终止自有worker且无重复完成', async context => {
  const { workers, pool } = fixture(context, 1), a = pool.decode(request()), b = pool.decode(request());
  const checked = Promise.all([assert.rejects(a, Ktx2WorkerInfrastructureError), assert.rejects(b, Ktx2WorkerInfrastructureError)]);
  workers[0].ready(); pool.dispose(); await checked;
  assert.equal(workers[0].terminated, true); workers[0].finish({});
  await assert.rejects(pool.decode(request()), Ktx2WorkerInfrastructureError);
});
