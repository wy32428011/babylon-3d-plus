import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('sandbox preload 入口内联 gate，不得依赖相对模块 require', async () => {
  const [esmSource, cjsSource] = await Promise.all([
    readFile(new URL('../../electron/preload.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/preload.cts', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(esmSource, /from ['"]\.\/preloadProgressGate\.js['"]/);
  assert.doesNotMatch(cjsSource, /require\(['"]\.\/preloadProgressGate\.js['"]\)/);
  assert.match(esmSource, /function createRealtimeFirstProgressGate/);
  assert.match(cjsSource, /function createRealtimeFirstProgressGate/);

  const extractInlineGate = (source: string) => {
    const start = source.indexOf('function createRealtimeFirstProgressGate');
    const endMarker = '\n}\n\nconst dataPlatformDeepLinkHandlers';
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end >= 0, '无法定位 preload 内联 progress gate');
    return source.slice(start, end + 2).replace(/\r\n/g, '\n');
  };
  assert.equal(extractInlineGate(esmSource), extractInlineGate(cjsSource));
});
