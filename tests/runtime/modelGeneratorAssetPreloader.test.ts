import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelGeneratorAssetPreloader } from '../../src/runtime/babylon/ModelGeneratorAssetPreloader.ts';
import type {
  ModelAssetComponent,
  ModelGeneratorComponent,
  ModelGeneratorTarget,
} from '../../src/editor/model/components.ts';

type Lease = { dispose(): void };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function asset(name: string): ModelAssetComponent {
  return {
    assetCode: `original:${name}`,
    sourcePath: `${name}.glb`,
    sourceUrl: `editor-asset:///${name}.glb`,
    lengthUnit: 'm',
    unitScaleToMeters: 1,
  };
}

function model(name: string): Extract<ModelGeneratorTarget, { kind: 'model' }> {
  const { assetCode: _assetCode, ...modelAsset } = asset(name);
  return { kind: 'model', assetId: name, displayName: name, modelAsset };
}

function composition(name = 'assembly'): Extract<ModelGeneratorTarget, { kind: 'composition' }> {
  return { kind: 'composition', libraryId: name, revision: 'v1', displayName: name };
}

function component(defaultTarget: ModelGeneratorTarget | null, ...targets: (ModelGeneratorTarget | null)[]): ModelGeneratorComponent {
  return {
    defaultTarget,
    rules: targets.map((target, index) => ({ id: `rule-${index}`, attributeName: 'type', attributeValue: String(index), target })),
  };
}

function lease() {
  let disposed = 0;
  return { dispose: () => { disposed += 1; }, get disposed() { return disposed; } };
}

function harness() {
  const preloads: { modelAsset: ModelAssetComponent; signal: AbortSignal; result: ReturnType<typeof deferred<Lease>> }[] = [];
  const compositions: { target: Extract<ModelGeneratorTarget, { kind: 'composition' }>; result: ReturnType<typeof deferred<readonly ModelAssetComponent[]>> }[] = [];
  const errors: { error: unknown; target: ModelGeneratorTarget }[] = [];
  let changes = 0;
  const preloader = new ModelGeneratorAssetPreloader({
    getAssetKey: (modelAsset) => modelAsset.sourceUrl,
    preload: (modelAsset, signal) => {
      const result = deferred<Lease>();
      preloads.push({ modelAsset, signal, result });
      return result.promise;
    },
    loadCompositionModels: (target) => {
      const result = deferred<readonly ModelAssetComponent[]>();
      compositions.push({ target, result });
      return result.promise;
    },
    onError: (error, target) => { errors.push({ error, target }); },
    onChange: () => { changes += 1; },
  });
  return { preloader, preloads, compositions, errors, get changes() { return changes; } };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test('默认目标和全部规则按资产去重，忽略空目标与内置 Mesh，保持输入不变', async () => {
  const h = harness();
  const config = component(model('box'), model('box'), model('pallet'), null, {
    kind: 'mesh', meshKind: 'cube', displayName: 'cube', materialColor: '#ffffff',
  });
  const before = structuredClone(config);
  assert.equal(h.changes, 0);
  h.preloader.sync('generator', config, 'v1');
  assert.equal(h.preloads.length, 2);
  assert.equal(h.compositions.length, 0);
  assert.ok(h.preloads.every((call) => call.modelAsset.assetCode === '__cargo_preload__'));
  assert.deepEqual(config, before);
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 2, readyAssetCount: 0, failedCount: 0 });
  for (const call of h.preloads) call.result.resolve(lease());
  await h.preloader.waitForReady();
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 0, readyAssetCount: 2, failedCount: 0 });
  assert.ok(h.changes > 0);
  h.preloader.dispose();
});

test('组合异步解析包含在就绪等待中，重复组合与普通目标共用同生成器资产 lease', async () => {
  const h = harness();
  h.preloader.sync('generator', component(composition(), composition(), model('box')), 'v1');
  assert.equal(h.compositions.length, 1);
  assert.equal(h.preloads.length, 1);
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 2, readyAssetCount: 0, failedCount: 0 });
  let ready = false;
  const waiting = h.preloader.waitForReady().then(() => { ready = true; });
  h.preloads[0].result.resolve(lease());
  await flush();
  assert.equal(ready, false);
  const members = [asset('box'), asset('pallet'), asset('pallet')];
  const before = structuredClone(members);
  h.compositions[0].result.resolve(members);
  await flush();
  assert.equal(h.preloads.length, 2);
  assert.equal(ready, false);
  assert.deepEqual(members, before);
  h.preloads[1].result.resolve(lease());
  await waiting;
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 0, readyAssetCount: 2, failedCount: 0 });
  h.preloader.dispose();
});

test('相同签名在准备中和就绪后均不重复预取', async () => {
  const h = harness();
  h.preloader.sync('generator', component(model('box')), 'v1');
  const changes = h.changes;
  h.preloader.sync('generator', component(model('other')), 'v1');
  assert.equal(h.preloads.length, 1);
  assert.equal(h.changes, changes);
  h.preloads[0].result.resolve(lease());
  await h.preloader.waitForReady();
  h.preloader.sync('generator', component(model('box')), 'v1');
  assert.equal(h.preloads.length, 1);
  h.preloader.dispose();
});

test('不同生成器各自持有 lease，删除仅归还所属引用且可重复删除', async () => {
  const h = harness();
  h.preloader.sync('one', component(model('box')), 'v1');
  h.preloader.sync('two', component(model('box')), 'v1');
  assert.equal(h.preloads.length, 2);
  const first = lease();
  const second = lease();
  h.preloads[0].result.resolve(first);
  h.preloads[1].result.resolve(second);
  await h.preloader.waitForReady();
  h.preloader.remove('one');
  h.preloader.remove('one');
  assert.equal(first.disposed, 1);
  assert.equal(second.disposed, 0);
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 0, readyAssetCount: 1, failedCount: 0 });
  h.preloader.dispose();
  assert.equal(second.disposed, 1);
});

test('配置换代取消旧预取，等待转向当前配置，晚到 lease 必须归还', async () => {
  const h = harness();
  h.preloader.sync('generator', component(model('old')), 'v1');
  let ready = false;
  const waiting = h.preloader.waitForReady().then(() => { ready = true; });
  h.preloader.sync('generator', component(model('new')), 'v2');
  assert.equal(h.preloads[0].signal.aborted, true);
  assert.equal(h.preloads[1].signal.aborted, false);
  const stale = lease();
  h.preloads[0].result.resolve(stale);
  await flush();
  assert.equal(stale.disposed, 1);
  assert.equal(ready, false);
  h.preloads[1].result.resolve(lease());
  await waiting;
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 0, readyAssetCount: 1, failedCount: 0 });
  assert.equal(h.errors.length, 0);
  h.preloader.dispose();
});

test('删除尚未完成的组合不能阻塞就绪，晚到组合或错误不会继续加载或记录失败', async () => {
  const h = harness();
  h.preloader.sync('removed', component(composition()), 'v1');
  const waiting = h.preloader.waitForReady();
  h.preloader.remove('removed');
  await waiting;
  h.compositions[0].result.resolve([asset('stale')]);
  await flush();
  assert.equal(h.preloads.length, 0);
  h.preloader.sync('rejected', component(model('box')), 'v1');
  h.preloader.remove('rejected');
  h.preloads[0].result.reject(new Error('late abort rejection'));
  await flush();
  assert.equal(h.errors.length, 0);
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 0, readyAssetCount: 0, failedCount: 0 });
  h.preloader.dispose();
});

test('dispose 取消全部工作并释放已完成和晚到 lease，之后不再接受 sync 或 retry', async () => {
  const h = harness();
  h.preloader.sync('generator', component(model('ready'), model('pending')), 'v1');
  const readyLease = lease();
  h.preloads[0].result.resolve(readyLease);
  await flush();
  const waiting = h.preloader.waitForReady();
  h.preloader.dispose();
  h.preloader.dispose();
  await waiting;
  assert.equal(readyLease.disposed, 1);
  assert.ok(h.preloads.every((call) => call.signal.aborted));
  const late = lease();
  h.preloads[1].result.resolve(late);
  await flush();
  assert.equal(late.disposed, 1);
  h.preloader.sync('new', component(model('new')), 'v1');
  h.preloader.retryFailed();
  assert.equal(h.preloads.length, 2);
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 0, readyAssetCount: 0, failedCount: 0 });
});

test('预取失败仅报告一次且不阻断就绪，显式重试只重做失败资产并保留成功 lease', async () => {
  const h = harness();
  const config = component(model('good'), model('bad'), model('bad'));
  h.preloader.sync('generator', config, 'v1');
  const successful = lease();
  h.preloads[0].result.resolve(successful);
  const error = new Error('decode failed');
  h.preloads[1].result.reject(error);
  await h.preloader.waitForReady();
  assert.deepEqual(h.errors, [{ error, target: config.rules[0].target }]);
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 0, readyAssetCount: 1, failedCount: 1 });
  h.preloader.sync('generator', config, 'v1');
  assert.equal(h.preloads.length, 2);
  h.preloader.retryFailed();
  h.preloader.retryFailed();
  assert.equal(h.preloads.length, 3);
  assert.equal(successful.disposed, 0);
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 1, readyAssetCount: 1, failedCount: 0 });
  h.preloads[2].result.resolve(lease());
  await h.preloader.waitForReady();
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 0, readyAssetCount: 2, failedCount: 0 });
  h.preloader.dispose();
});

test('组合解析失败可单独重试，不会释放成功目标或重复预取已持有的成员', async () => {
  const h = harness();
  h.preloader.sync('generator', component(model('box'), composition()), 'v1');
  const successful = lease();
  h.preloads[0].result.resolve(successful);
  h.compositions[0].result.reject(new Error('composition unavailable'));
  await h.preloader.waitForReady();
  assert.equal(h.errors.length, 1);
  assert.equal(h.preloader.getMetrics().failedCount, 1);
  h.preloader.retryFailed();
  assert.equal(h.compositions.length, 2);
  h.compositions[1].result.resolve([asset('box'), asset('member')]);
  await flush();
  assert.equal(h.preloads.length, 2);
  assert.equal(successful.disposed, 0);
  h.preloads[1].result.resolve(lease());
  await h.preloader.waitForReady();
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 0, readyAssetCount: 2, failedCount: 0 });
  h.preloader.dispose();
});

test('等待支持调用方取消且不会中断共享预取，已取消信号立即拒绝', async () => {
  const h = harness();
  h.preloader.sync('generator', component(model('box')), 'v1');
  const controller = new AbortController();
  const waiting = h.preloader.waitForReady(controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(h.preloads[0].signal.aborted, false);
  await assert.rejects(h.preloader.waitForReady(controller.signal), { name: 'AbortError' });
  h.preloads[0].result.resolve(lease());
  await h.preloader.waitForReady();
  await h.preloader.waitForReady();
  h.preloader.dispose();
});

test('组合配置换代后等待当前解析与成员完成，旧解析失败不污染计数', async () => {
  const h = harness();
  h.preloader.sync('generator', component(composition('old')), 'v1');
  let ready = false;
  const waiting = h.preloader.waitForReady().then(() => { ready = true; });
  h.preloader.sync('generator', component(composition('current')), 'v2');
  h.compositions[0].result.reject(new Error('stale lookup'));
  await flush();
  assert.equal(ready, false);
  assert.deepEqual(h.preloader.getMetrics(), { pendingCount: 1, readyAssetCount: 0, failedCount: 0 });
  h.compositions[1].result.resolve([asset('box')]);
  await flush();
  assert.equal(ready, false);
  h.preloads[0].result.resolve(lease());
  await waiting;
  assert.equal(h.errors.length, 0);
  h.preloader.dispose();
});

test('同步抛出的预取和组合读取异常同样属于非致命失败', async () => {
  const errors: unknown[] = [];
  const preloader = new ModelGeneratorAssetPreloader({
    getAssetKey: (modelAsset) => modelAsset.sourceUrl,
    preload: () => { throw new Error('synchronous preload error'); },
    loadCompositionModels: () => { throw new Error('synchronous composition error'); },
    onError: (error) => { errors.push(error); },
  });
  preloader.sync('generator', component(model('box'), composition()), 'v1');
  await preloader.waitForReady();
  assert.equal(errors.length, 2);
  assert.deepEqual(preloader.getMetrics(), { pendingCount: 0, readyAssetCount: 0, failedCount: 2 });
  preloader.dispose();
});

test('进度观察者抛错只产生警告，预取仍成功并结算已有等待', async (context) => {
  const warnings: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const result = deferred<Lease>();
  let throwProgress = false;
  const errors: unknown[] = [];
  const preloader = new ModelGeneratorAssetPreloader({
    getAssetKey: (modelAsset) => modelAsset.sourceUrl,
    preload: () => result.promise,
    loadCompositionModels: async () => [],
    onError: (error) => { errors.push(error); },
    onChange: () => { if (throwProgress) throw new Error('progress observer failed'); },
  });
  preloader.sync('generator', component(model('box')), 'v1');
  let ready = false;
  const waiting = preloader.waitForReady().then(() => { ready = true; });
  throwProgress = true;
  result.resolve(lease());
  await flush();
  assert.equal(ready, true);
  await waiting;
  assert.deepEqual(preloader.getMetrics(), { pendingCount: 0, readyAssetCount: 1, failedCount: 0 });
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /观察者/);
  preloader.dispose();
});

test('错误日志观察者抛错不会覆盖原失败、再次上报或留下后台拒绝', async (context) => {
  const warnings: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const assetResult = deferred<Lease>();
  const compositionResult = deferred<readonly ModelAssetComponent[]>();
  const reported: unknown[] = [];
  const preloader = new ModelGeneratorAssetPreloader({
    getAssetKey: (modelAsset) => modelAsset.sourceUrl,
    preload: () => assetResult.promise,
    loadCompositionModels: () => compositionResult.promise,
    onError: (error) => {
      reported.push(error);
      throw new Error('error observer failed');
    },
  });
  preloader.sync('generator', component(model('box'), composition()), 'v1');
  const waiting = preloader.waitForReady();
  const assetError = new Error('original asset failure');
  const compositionError = new Error('original composition failure');
  assetResult.reject(assetError);
  compositionResult.reject(compositionError);
  await waiting;
  await flush();
  assert.deepEqual(reported, [assetError, compositionError]);
  assert.deepEqual(preloader.getMetrics(), { pendingCount: 0, readyAssetCount: 0, failedCount: 2 });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((args) => /观察者/.test(String(args[0]))));
  preloader.dispose();
});

test('进度回调重入并同步新配置时，不会提前结算旧等待', async () => {
  const results: ReturnType<typeof deferred<Lease>>[] = [];
  let switchOnReady = false;
  let preloader!: ModelGeneratorAssetPreloader;
  preloader = new ModelGeneratorAssetPreloader({
    getAssetKey: (modelAsset) => modelAsset.sourceUrl,
    preload: () => {
      const result = deferred<Lease>();
      results.push(result);
      return result.promise;
    },
    loadCompositionModels: async () => [],
    onError: () => { assert.fail('不应发生预取失败'); },
    onChange: () => {
      if (!switchOnReady || preloader.getMetrics().pendingCount > 0) return;
      switchOnReady = false;
      preloader.sync('generator', component(model('new')), 'v2');
    },
  });
  preloader.sync('generator', component(model('old')), 'v1');
  let ready = false;
  const waiting = preloader.waitForReady().then(() => { ready = true; });
  switchOnReady = true;
  results[0].resolve(lease());
  await flush();
  assert.equal(results.length, 2);
  assert.equal(ready, false);
  assert.equal(preloader.getMetrics().pendingCount, 1);
  results[1].resolve(lease());
  await waiting;
  assert.equal(ready, true);
  preloader.dispose();
});
