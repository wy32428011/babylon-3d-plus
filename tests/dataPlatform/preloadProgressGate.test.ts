import assert from 'node:assert/strict';
import test from 'node:test';

import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ createRealtimeFirstProgressGate }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/preloadProgressGate'),
]>(['electron/preloadProgressGate.ts']);

test('实时 run B 到达后丢弃迟到的旧 run A 初始 snapshot', () => {
  const received: string[] = [];
  const gate = createRealtimeFirstProgressGate<{ runId: string }>((progress) => received.push(progress.runId));
  gate.handleRealtime({ runId: 'B' });
  gate.handleSnapshot({ runId: 'A' });
  assert.deepEqual(received, ['B']);
});

test('没有实时事件时接收初始 snapshot，dispose 后两类事件均忽略', () => {
  const received: string[] = [];
  const gate = createRealtimeFirstProgressGate<{ runId: string }>((progress) => received.push(progress.runId));
  gate.handleSnapshot({ runId: 'A' });
  gate.dispose();
  gate.handleRealtime({ runId: 'B' });
  gate.handleSnapshot({ runId: 'C' });
  assert.deepEqual(received, ['A']);
});
