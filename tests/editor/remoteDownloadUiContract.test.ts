import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('远程模型与环境字节同时进入 Project 面板和全屏加载蒙版', async () => {
  const panel = await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8');
  const overlay = await readFile(new URL('../../src/editor/loading/ScenePreparationOverlay.tsx', import.meta.url), 'utf8');
  const mask = await readFile(new URL('../../src/shared/ui/SceneLoadingMask.tsx', import.meta.url), 'utf8');
  for (const kind of ['model', 'environment']) {
    assert.ok(panel.includes(`sceneRemoteDownloadStore.receive(sceneSessionId, '${kind}', progress)`));
    assert.ok(overlay.includes(`downloads.${kind}.download`));
  }
  assert.match(panel, /sceneRemoteDownloadStore\.clear\(sceneSessionId\)/);
  assert.match(overlay, /downloads\.sceneSessionId === state\.sceneSessionId/);
  assert.match(mask, /\{downloadDetail\}/);
  assert.match(overlay, /percent=\{state\.percent\}/);
  assert.match(overlay, /if \(state\.completed && !environmentError\) return null/);
  assert.match(overlay, /aria-label="场景资源状态"/);
  assert.match(overlay, /<details><summary>查看详情<\/summary>/);
});

test('字节更新不重复输出业务阶段日志，下载结束后面板隐藏字节明细', async () => {
  const panel = await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8');
  assert.equal((panel.match(/const logKey = remoteSyncLogKey\(progress\)/g) ?? []).length, 2);
  assert.equal((panel.match(/if \(lastLogKey !== logKey\)/g) ?? []).length, 2);
  assert.match(panel, /isRemoteDownloadVisible\(modelSyncProgress\) && modelSyncProgress\.download/);
  assert.match(panel, /isRemoteDownloadVisible\(environmentSyncProgress\) && environmentSyncProgress\.download/);
});

test('被退役的环境同步事件在写入新会话错误和完成回调前退出', async () => {
  const panel = await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8');
  const start = panel.indexOf("sceneRemoteDownloadStore.receive(sceneSessionId, 'environment', progress)");
  const failure = panel.indexOf('environmentPreparationStore.fail(sceneSessionId', start);
  assert.ok(start >= 0 && failure > start);
  assert.match(panel.slice(start, failure), /if \(!showDownload\) return;/);
});
