import assert from 'node:assert/strict';
import test from 'node:test';

import { DeferredAutoPatrolStartGate } from '../../src/player/deferredAutoPatrolStartGate.ts';

test('场景未真实加载完成时延迟自动巡检，并在就绪后只执行最新请求', () => {
  const gate = new DeferredAutoPatrolStartGate();
  const starts: string[] = [];

  gate.request(() => starts.push('auto-start'));
  gate.request(() => starts.push('host-command'));
  assert.deepEqual(starts, []);

  gate.markReady();
  gate.markReady();
  assert.deepEqual(starts, ['host-command']);
});

test('场景真实加载完成后的巡检请求立即执行，释放后丢弃待执行请求', () => {
  const readyGate = new DeferredAutoPatrolStartGate();
  const starts: string[] = [];
  readyGate.markReady();
  readyGate.request(() => starts.push('manual-control'));
  assert.deepEqual(starts, ['manual-control']);

  const disposedGate = new DeferredAutoPatrolStartGate();
  disposedGate.request(() => starts.push('disposed'));
  disposedGate.dispose();
  disposedGate.markReady();
  assert.deepEqual(starts, ['manual-control']);
});

test('互斥操作会取消加载期间排队的巡检启动', () => {
  const gate = new DeferredAutoPatrolStartGate();
  const starts: string[] = [];

  gate.request(() => starts.push('pending'));
  gate.cancelPending();
  gate.markReady();

  assert.deepEqual(starts, []);
  gate.request(() => starts.push('ready'));
  assert.deepEqual(starts, ['ready']);
});
