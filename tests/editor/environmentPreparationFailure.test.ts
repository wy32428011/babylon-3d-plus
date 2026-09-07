import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnvironmentPreparationStore } from '../../src/editor/loading/environmentPreparationProgress.ts';

test('异机环境下载失败显示原因，重试不会将场景标记完成', async () => {
  const store = createEnvironmentPreparationStore();
  let attempts = 0;
  store.begin('new-machine', async () => { attempts += 1; return true; });
  store.fail('new-machine', '环境文件校验失败');
  assert.equal(store.getSnapshot().error, '环境文件校验失败');
  await store.retry();
  assert.equal(attempts, 1);
  assert.equal(store.getSnapshot().error, null);
  assert.equal(store.getSnapshot().retrying, false);
  assert.equal('completed' in store.getSnapshot(), false);
});

test('同步成功但本地环境缺失仍报告错误；重试启动失败保留可恢复状态', async () => {
  const store = createEnvironmentPreparationStore();
  store.begin('scene', async () => false);
  store.fail('scene', '未找到当前场景引用的环境资源');
  await store.retry();
  assert.match(store.getSnapshot().error ?? '', /未能启动/);
  assert.equal(store.getSnapshot().retrying, false);
});

test('场景切换后旧失败和重试结果不能污染新项目', async () => {
  const store = createEnvironmentPreparationStore();
  let reject!: (error: Error) => void;
  store.begin('old', () => new Promise<boolean>((_resolve, failure) => { reject = failure; }));
  store.fail('old', '旧环境失败');
  const retry = store.retry();
  store.begin('new', async () => true);
  store.fail('old', '迟到失败');
  reject(new Error('旧请求失败'));
  await retry;
  assert.deepEqual(store.getSnapshot(), { sceneSessionId: 'new', error: null, retrying: false });
});

test('重复重试只启动一次；新失败不会被启动成功覆盖，取消后清除入口', async () => {
  const store = createEnvironmentPreparationStore();
  let resolve!: (started: boolean) => void;
  let attempts = 0;
  let updates = 0;
  const unsubscribe = store.subscribe(() => { updates += 1; });
  store.begin('scene', () => { attempts += 1; return new Promise<boolean>((done) => { resolve = done; }); });
  store.fail('scene', '首次失败');
  const pending = store.retry();
  await store.retry();
  store.fail('scene', '重试任务下载失败');
  resolve(true);
  await pending;
  assert.equal(attempts, 1);
  assert.equal(store.getSnapshot().error, '重试任务下载失败');
  store.clearError('old');
  assert.equal(store.getSnapshot().error, '重试任务下载失败');
  store.clearError('scene');
  assert.equal(store.getSnapshot().error, null);
  store.clear('old');
  assert.equal(store.getSnapshot().sceneSessionId, 'scene');
  unsubscribe();
  const previousUpdates = updates;
  store.clear('scene');
  await store.retry();
  assert.equal(updates, previousUpdates);
  assert.equal(attempts, 1);
  assert.equal(store.getSnapshot().sceneSessionId, '');
});
