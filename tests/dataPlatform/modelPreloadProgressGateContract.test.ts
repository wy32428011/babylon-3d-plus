import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('模型同步订阅使用 realtime-first gate 丢弃迟到的旧快照', async () => {
  const [esmSource, cjsSource] = await Promise.all([
    readFile(new URL('../../electron/preload.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/preload.cts', import.meta.url), 'utf8'),
  ]);
  const contract = /onDataPlatformModelSyncProgress:[\s\S]*?createRealtimeFirstProgressGate\(handler\)[\s\S]*?handleRealtime\(payload\)[\s\S]*?handleSnapshot\(payload\)/;

  assert.match(esmSource, contract);
  assert.match(cjsSource, contract);
});

test('每个场景会话都会重新处理当前模型同步完成快照', async () => {
  const projectPanelSource = await readFile(
    new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    projectPanelSource,
    /beginScenePreparation\(sceneSessionId\);\s*skipSceneModelSync\(sceneSessionId, null\);\s*lastSceneRefreshModelSyncRunIdRef\.current = null;/,
  );
});
