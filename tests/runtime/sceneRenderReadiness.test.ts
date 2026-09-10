import assert from 'node:assert/strict';
import test from 'node:test';
import { Observable } from '@babylonjs/core/Misc/observable.js';

import { waitForSceneRenderReady } from '../../src/runtime/babylon/sceneRenderReadiness.ts';

class TestAfterRenderObservable {
  private observer: (() => void) | null = null;

  addOnce(callback: () => void): object {
    this.observer = callback;
    return callback;
  }

  remove(observer: object): boolean {
    if (this.observer !== observer) return false;
    this.observer = null;
    return true;
  }

  hasObserver(): boolean {
    return this.observer !== null;
  }

  notify(): void {
    const observer = this.observer;
    this.observer = null;
    observer?.();
  }
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test('材质纹理就绪后仍等待包含新模型的首个完整渲染帧', async () => {
  const sceneReady = createDeferred();
  const afterRender = new TestAfterRenderObservable();
  let settled = false;
  const waiting = waitForSceneRenderReady({
    whenReadyAsync: () => sceneReady.promise,
    onAfterRenderObservable: afterRender,
  }).then(() => { settled = true; });

  assert.equal(afterRender.hasObserver(), false);
  sceneReady.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(afterRender.hasObserver(), true);
  assert.equal(settled, false);

  afterRender.notify();
  await waiting;
  assert.equal(settled, true);
});

test('等待可渲染帧期间取消会移除观察者并按 AbortError 终止', async () => {
  const afterRender = new TestAfterRenderObservable();
  const abortController = new AbortController();
  const waiting = waitForSceneRenderReady({
    whenReadyAsync: async () => undefined,
    onAfterRenderObservable: afterRender,
  }, abortController.signal);

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(afterRender.hasObserver(), true);
  abortController.abort();

  await assert.rejects(waiting, (error: unknown) => (
    error instanceof Error && error.name === 'AbortError'
  ));
  assert.equal(afterRender.hasObserver(), false);
});

test('支持实时就绪查询时不等待轮询，但首次发现ready后仍须再渲染完整一帧', async () => {
  const afterRender = new TestAfterRenderObservable();
  let ready = false, settled = false, fallbackCalls = 0;
  const waiting = waitForSceneRenderReady({
    isReady: () => ready,
    whenReadyAsync: () => { fallbackCalls++; return new Promise<void>(() => {}); },
    onAfterRenderObservable: afterRender,
  }).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(afterRender.hasObserver(), true);
  assert.equal(fallbackCalls, 0);
  afterRender.notify();
  await Promise.resolve();
  assert.equal(settled, false);
  ready = true;
  afterRender.notify();
  await Promise.resolve();
  assert.equal(settled, false, '本帧末尾刚ready不能被算成完整渲染帧');
  assert.equal(afterRender.hasObserver(), true);
  afterRender.notify();
  await waiting;
  assert.equal(settled, true);
  assert.equal(afterRender.hasObserver(), false);
});

test('ready后重新busy会重新门控，直到下一次ready后的完整帧', async () => {
  const afterRender = new TestAfterRenderObservable();
  let ready = true, settled = false;
  const waiting = waitForSceneRenderReady({
    isReady: () => ready,
    whenReadyAsync: async () => undefined,
    onAfterRenderObservable: afterRender,
  }).then(() => { settled = true; });
  await Promise.resolve();
  ready = false;
  afterRender.notify();
  await Promise.resolve();
  assert.equal(settled, false);
  ready = true;
  afterRender.notify();
  await Promise.resolve();
  assert.equal(settled, false);
  afterRender.notify();
  await waiting;
  assert.equal(settled, true);
});

test('实时就绪检查在取消和帧回调间隙均不残留观察者', async () => {
  for (const cancelBetweenFrames of [false, true]) {
    const afterRender = new TestAfterRenderObservable();
    const controller = new AbortController();
    const waiting = waitForSceneRenderReady({
      isReady: () => false,
      whenReadyAsync: async () => undefined,
      onAfterRenderObservable: afterRender,
    }, controller.signal);
    await Promise.resolve();
    assert.equal(afterRender.hasObserver(), true);
    if (cancelBetweenFrames) afterRender.notify();
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    await Promise.resolve();
    assert.equal(afterRender.hasObserver(), false);
  }
});

test('已取消的实时检查不注册观察者；就绪查询异常不会泄漏或静默成功', async () => {
  const afterRender = new TestAfterRenderObservable();
  const controller = new AbortController();
  controller.abort();
  let queries = 0;
  await assert.rejects(waitForSceneRenderReady({
    isReady: () => { queries++; return true; },
    whenReadyAsync: async () => undefined,
    onAfterRenderObservable: afterRender,
  }, controller.signal), { name: 'AbortError' });
  assert.equal(queries, 0);
  assert.equal(afterRender.hasObserver(), false);
  for (const failInitially of [true, false]) {
    let fail = failInitially;
    const waiting = waitForSceneRenderReady({
      isReady: () => { if (fail) throw new Error('材质检查失败'); return false; },
      whenReadyAsync: async () => undefined,
      onAfterRenderObservable: afterRender,
    });
    if (!failInitially) { await Promise.resolve(); fail = true; afterRender.notify(); }
    await assert.rejects(waiting, /材质检查失败/);
    assert.equal(afterRender.hasObserver(), false);
  }
});

test('准备期5FPS也可在ready后的下一完整帧结束，取消一个等待不影响其它调用', async () => {
  const before = new Observable<void>();
  const after = new Observable<void>();
  let ready = false;
  const scene = {
    isReady: () => ready,
    whenReadyAsync: () => new Promise<void>(() => {}),
    onBeforeRenderObservable: before,
    onAfterRenderObservable: after,
  };
  const controller = new AbortController();
  const canceled = waitForSceneRenderReady(scene, controller.signal);
  const remaining = waitForSceneRenderReady(scene);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(canceled, { name: 'AbortError' });
  assert.equal(before.hasObservers(), true, '取消单个调用不影响其它等待者');
  ready = true;
  before.notifyObservers();
  after.notifyObservers();
  await remaining;
  assert.equal(before.hasObservers(), false);
  assert.equal(after.hasObservers(), false);
});

test('帧前busy而帧后才ready不会假完成，最后一个等待者取消时移除帧前和帧后观察者', async () => {
  const before = new TestAfterRenderObservable();
  const after = new TestAfterRenderObservable();
  const controller = new AbortController();
  let ready = false, settled = false;
  const waiting = waitForSceneRenderReady({
    isReady: () => ready, whenReadyAsync: async () => undefined,
    onBeforeRenderObservable: before, onAfterRenderObservable: after,
  }, controller.signal).then(() => { settled = true; });
  await Promise.resolve();
  before.notify();
  ready = true;
  after.notify();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(before.hasObserver(), true);
  assert.equal(after.hasObserver(), true);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(before.hasObserver(), false);
  assert.equal(after.hasObserver(), false);
});

test('在帧前之后或其它帧末回调中新建等待，都必须完成自己的下一帧', async () => {
  for (const createdDuring of ['before', 'after'] as const) {
    const before = new Observable<void>();
    const after = new Observable<void>();
    const scene = { isReady: () => true, whenReadyAsync: async () => undefined,
      onBeforeRenderObservable: before, onAfterRenderObservable: after };
    let second: Promise<void> | null = null, secondSettled = false;
    const first = waitForSceneRenderReady(scene);
    await Promise.resolve();
    const createSecond = () => { second = waitForSceneRenderReady(scene).then(() => { secondSettled = true; }); };
    if (createdDuring === 'before') before.addOnce(createSecond);
    else after.addOnce(createSecond);
    before.notifyObservers();
    after.notifyObservers();
    await first;
    assert.ok(second);
    assert.equal(secondSettled, false, '晚加入者不能继承另一个等待的当前帧或已完成Promise');
    before.notifyObservers();
    after.notifyObservers();
    await second;
    assert.equal(secondSettled, true);
    assert.equal(before.hasObservers(), false);
    assert.equal(after.hasObservers(), false);
  }
});
