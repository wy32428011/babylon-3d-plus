import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteDownloadTracker } from '../../electron/shared/remoteDownloadProgress.ts';

test('并行下载按绝对已写入量汇总，不重复累加续传前缀或重复进度', () => {
  let now = 0;
  const snapshots: any[] = [];
  const tracker = new RemoteDownloadTracker([
    { id: 'a', fileName: '环境A', totalBytes: 4096 }, { id: 'b', fileName: '环境B', totalBytes: 2048 },
  ], (value) => snapshots.push(value), () => now);
  tracker.start('a');
  tracker.start('b');
  tracker.update('a', { downloadedBytes: 1024, totalBytes: 4096 });
  tracker.update('a', { downloadedBytes: 1024, totalBytes: 4096 });
  tracker.update('b', { downloadedBytes: 512, totalBytes: 2048 });
  assert.equal(tracker.snapshot().downloadedBytes, 1536);
  assert.equal(tracker.snapshot().totalBytes, 6144);
  assert.equal(tracker.snapshot().activeFiles, 2);
  assert.equal(snapshots.length, 1, '字节更新不能逐块广播IPC');
  now = 200;
  tracker.update('a', { downloadedBytes: 2048, totalBytes: 4096 });
  assert.equal(snapshots.length, 2);
  tracker.finish('a', 4096);
  tracker.finish('b', 2048);
  assert.equal(snapshots.at(-1).downloadedBytes, 6144);
  assert.equal(snapshots.at(-1).activeFiles, 0);
});

test('排队文件大小未知时总量未知，完成后用实际字节结算；关闭后无广播', () => {
  let notifications = 0;
  const tracker = new RemoteDownloadTracker([{ id: 'a', fileName: '模型' }, { id: 'b', fileName: '附件' }], () => notifications++);
  tracker.start('a');
  tracker.update('a', { downloadedBytes: 1234, totalBytes: 2048 });
  assert.equal(tracker.snapshot().totalBytes, null);
  assert.equal(tracker.snapshot().currentFileTotalBytes, 2048);
  tracker.finish('a', 2048);
  tracker.start('b');
  tracker.update('b', { downloadedBytes: 100, totalBytes: null });
  tracker.finish('b', 100);
  assert.equal(tracker.snapshot().totalBytes, 2148);
  const beforeClose = notifications;
  tracker.close();
  tracker.update('b', { downloadedBytes: 200, totalBytes: 200 });
  assert.equal(notifications, beforeClose);
});

test('节流窗口后补发最后一次字节，服务端停顿时显示仍然准确；关闭清理补发任务', async () => {
  const snapshots: number[] = [];
  const tracker = new RemoteDownloadTracker([{ id: 'a', fileName: '环境', totalBytes: 8192 }],
    (value) => snapshots.push(value.downloadedBytes));
  tracker.start('a');
  tracker.update('a', { downloadedBytes: 4096, totalBytes: 8192 });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(snapshots, [0, 4096]);
  tracker.update('a', { downloadedBytes: 6000, totalBytes: 8192 });
  tracker.close();
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.deepEqual(snapshots, [0, 4096]);
});
