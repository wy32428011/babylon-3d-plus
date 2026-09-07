import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSceneRemoteDownloadStore,
  formatRemoteDownloadProgress,
  isRemoteDownloadVisible,
  remoteSyncLogKey,
} from '../../src/editor/loading/sceneRemoteDownloadProgress.ts';

const download = {
  downloadedBytes: 1536, totalBytes: 4096, activeFiles: 2,
  currentFile: '工厂.glb', currentFileDownloadedBytes: 512, currentFileTotalBytes: 2048,
};
const progress = { runId: 'run-1', phase: 'downloading', completed: 0, total: 2, message: '下载中', error: null, download };

test('KB 使用 1024 字节并展示总量、百分比和当前文件', () => {
  assert.deepEqual(formatRemoteDownloadProgress(download), {
    summary: '已下载 1.5 KB / 4.0 KB（37.5%）',
    currentFile: '工厂.glb：0.5 KB / 2.0 KB',
  });
});

test('未知总量不伪造百分比，字节超过总量时百分比不溢出', () => {
  assert.deepEqual(formatRemoteDownloadProgress({ ...download, totalBytes: null, currentFileTotalBytes: null }), {
    summary: '已下载 1.5 KB（总大小未知）', currentFile: '工厂.glb：已下载 0.5 KB（总大小未知）',
  });
  assert.equal(formatRemoteDownloadProgress({ ...download, totalBytes: 0 }).summary, '已下载 1.5 KB（总大小未知）');
  assert.equal(formatRemoteDownloadProgress({ ...download, downloadedBytes: 0, totalBytes: 0 }).summary, '已下载 0.0 KB / 0.0 KB');
  assert.equal(formatRemoteDownloadProgress({ ...download, downloadedBytes: 8192 }).summary, '已下载 8.0 KB / 4.0 KB（100.0%）');
});

test('模型和环境独立显示；结束、新任务和场景切换清理旧字节', () => {
  const store = createSceneRemoteDownloadStore();
  store.begin('scene-1');
  assert.equal(store.receive('scene-1', 'model', progress), true);
  store.receive('scene-1', 'environment', { ...progress, runId: 'env-1' });
  assert.equal(store.getSnapshot().environment?.download.downloadedBytes, 1536);
  store.receive('scene-1', 'model', { ...progress, phase: 'completed' });
  assert.equal(store.getSnapshot().model, null);
  assert.equal(store.receive('scene-1', 'model', progress), false);
  store.receive('scene-1', 'model', { ...progress, runId: 'run-2', phase: 'querying', download: undefined });
  assert.equal(store.getSnapshot().model, null);
  store.receive('scene-1', 'model', { ...progress, runId: 'run-2' });
  store.begin('scene-2');
  assert.equal(store.getSnapshot().model, null);
  assert.equal(store.getSnapshot().environment, null);
  assert.equal(store.receive('scene-1', 'model', { ...progress, runId: 'run-3' }), false);
  assert.equal(store.receive('scene-2', 'model', { ...progress, runId: 'run-2' }), true, '新场景仍能观察全局共享的在途任务');
  assert.equal(store.receive('scene-2', 'environment', { ...progress, runId: 'env-1' }), true);
});

test('校验阶段清理字节，失败不被迟到的下载事件恢复', () => {
  const store = createSceneRemoteDownloadStore();
  store.begin('scene');
  store.receive('scene', 'model', progress);
  store.receive('scene', 'model', { ...progress, phase: 'validating', download: { ...download, activeFiles: 0 } });
  assert.equal(store.getSnapshot().model, null);
  store.receive('scene', 'model', { ...progress, phase: 'failed' });
  assert.equal(store.receive('scene', 'model', progress), false);
});

test('并行文件校验期间仍有下载时继续展示，查询和终态不残留字节', () => {
  const store = createSceneRemoteDownloadStore();
  store.begin('scene');
  store.receive('scene', 'environment', { ...progress, phase: 'validating' });
  assert.equal(store.getSnapshot().environment?.download.downloadedBytes, 1536);
  assert.equal(isRemoteDownloadVisible({ ...progress, phase: 'querying' }), false);
  assert.equal(isRemoteDownloadVisible({ ...progress, phase: 'completed' }), false);
});

test('订阅更新和取消订阅有效，旧会话清理不影响新会话', () => {
  const store = createSceneRemoteDownloadStore();
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  store.begin('scene');
  store.begin('scene');
  assert.equal(updates, 1);
  store.clear('old-scene');
  assert.equal(updates, 1);
  store.receive('scene', 'model', progress);
  unsubscribe();
  store.clear('scene');
  assert.equal(updates, 2);
  assert.equal(store.getSnapshot().sceneSessionId, '');
});

test('字节变化不会产生重复日志，阶段和完成文件数变化会记录', () => {
  assert.equal(remoteSyncLogKey(progress), remoteSyncLogKey({ ...progress, download: { ...download, downloadedBytes: 3072 } }));
  assert.notEqual(remoteSyncLogKey(progress), remoteSyncLogKey({ ...progress, completed: 1 }));
  assert.notEqual(remoteSyncLogKey(progress), remoteSyncLogKey({ ...progress, phase: 'validating' }));
});
