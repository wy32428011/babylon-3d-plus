import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPlayerInitialLoadSettled,
  PlayerInitialLoadGate,
} from '../../src/player/playerInitialLoadState.ts';

function createGateFixture() {
  const scheduled = new Map<number, () => void>();
  const cancelled: number[] = [];
  let nextHandle = 1;
  let completedCount = 0;
  let settledCount = 0;
  const gate = new PlayerInitialLoadGate(
    () => { completedCount += 1; },
    {
      onSettled: () => { settledCount += 1; },
      schedule: (callback) => {
        const handle = nextHandle;
        nextHandle += 1;
        scheduled.set(handle, callback);
        return handle;
      },
      cancel: (handle) => {
        const numericHandle = Number(handle);
        cancelled.push(numericHandle);
        scheduled.delete(numericHandle);
      },
    },
  );
  return {
    gate,
    scheduled,
    cancelled,
    getCompletedCount: () => completedCount,
    getSettledCount: () => settledCount,
    flushNext: () => {
      const entry = scheduled.entries().next().value as [number, () => void] | undefined;
      if (!entry) return;
      scheduled.delete(entry[0]);
      entry[1]();
    },
  };
}

test('无加载单元或全部结算时首次场景加载完成', () => {
  assert.equal(isPlayerInitialLoadSettled(null), true);
  assert.equal(isPlayerInitialLoadSettled({ loading: false, totalCount: 0 }), true);
  assert.equal(isPlayerInitialLoadSettled({ loading: false, totalCount: 3 }), true);
});

test('仍有模型或环境加载单元在途时首次场景加载未完成', () => {
  assert.equal(isPlayerInitialLoadSettled({ loading: true, totalCount: 1 }), false);
  assert.equal(isPlayerInitialLoadSettled({ loading: true, totalCount: 8 }), false);
});

test('无加载单元时等待下一帧稳定后完成', () => {
  const fixture = createGateFixture();
  fixture.gate.startTracking();

  assert.equal(fixture.getCompletedCount(), 0);
  assert.equal(fixture.scheduled.size, 1);

  fixture.flushNext();
  assert.equal(fixture.getCompletedCount(), 1);
  fixture.gate.forceComplete();
  assert.equal(fixture.getCompletedCount(), 1);
});

test('结算后的下一帧前重新进入 loading 会取消完成检查', () => {
  const fixture = createGateFixture();
  fixture.gate.update({ loading: false, totalCount: 2 });
  fixture.gate.startTracking();
  assert.equal(fixture.scheduled.size, 1);

  fixture.gate.update({ loading: true, totalCount: 3 });
  assert.equal(fixture.scheduled.size, 0);
  assert.deepEqual(fixture.cancelled, [1]);
  assert.equal(fixture.getCompletedCount(), 0);

  fixture.gate.update({ loading: false, totalCount: 3 });
  fixture.flushNext();
  assert.equal(fixture.getCompletedCount(), 1);
});

test('超时可强制完成，dispose 会取消未执行的稳定检查', () => {
  const timeoutFixture = createGateFixture();
  timeoutFixture.gate.update({ loading: true, totalCount: 1 });
  timeoutFixture.gate.startTracking();
  timeoutFixture.gate.forceComplete();
  timeoutFixture.gate.forceComplete();
  assert.equal(timeoutFixture.getCompletedCount(), 1);

  const disposedFixture = createGateFixture();
  disposedFixture.gate.startTracking();
  disposedFixture.gate.dispose();
  assert.equal(disposedFixture.scheduled.size, 0);
  assert.deepEqual(disposedFixture.cancelled, [1]);
  disposedFixture.gate.forceComplete();
  assert.equal(disposedFixture.getCompletedCount(), 0);
});

test('超时只放行加载界面，资源真实结算后才触发 settled', () => {
  const fixture = createGateFixture();
  fixture.gate.update({ loading: true, totalCount: 2 });
  fixture.gate.startTracking();

  fixture.gate.forceComplete();
  assert.equal(fixture.getCompletedCount(), 1);
  assert.equal(fixture.getSettledCount(), 0);

  fixture.gate.update({ loading: false, totalCount: 2 });
  fixture.flushNext();
  assert.equal(fixture.getCompletedCount(), 1);
  assert.equal(fixture.getSettledCount(), 1);
});
