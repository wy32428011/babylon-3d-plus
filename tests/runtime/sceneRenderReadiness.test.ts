import assert from 'node:assert/strict';
import test from 'node:test';

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
