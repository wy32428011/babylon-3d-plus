import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptySceneDocument,
  DEFAULT_FETCH_SYNC_INTERVAL_SECONDS,
  FETCH_SYNC_INTERVAL_MAX_SECONDS,
  FETCH_SYNC_INTERVAL_MIN_SECONDS,
  sanitizeFetchSyncIntervalSeconds,
} from '../../src/editor/model/SceneDocument';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';

test('场景 fetch 定时同步间隔（秒）随序列化往返保留', () => {
  const scene = createEmptySceneDocument('定时同步');
  scene.fetchConfig.syncIntervalSeconds = 30;

  const restored = deserializeScene(serializeScene(scene));

  assert.equal(restored.fetchConfig.syncIntervalSeconds, 30);
});

test('旧场景文件缺少同步间隔字段时回退默认值且不阻断加载', () => {
  const sceneFile = JSON.parse(serializeScene(createEmptySceneDocument('旧场景'))) as {
    scene: { fetchConfig: Record<string, unknown> };
  };
  delete sceneFile.scene.fetchConfig.syncIntervalSeconds;

  const restored = deserializeScene(JSON.stringify(sceneFile));

  assert.equal(restored.fetchConfig.syncIntervalSeconds, DEFAULT_FETCH_SYNC_INTERVAL_SECONDS);
});

test('同步间隔非法值回退默认，0/负数表示关闭定时，1~9 秒收敛到最小 10 秒，超上限收敛到上限，小数取整', () => {
  assert.equal(sanitizeFetchSyncIntervalSeconds(undefined), DEFAULT_FETCH_SYNC_INTERVAL_SECONDS);
  assert.equal(sanitizeFetchSyncIntervalSeconds(null), DEFAULT_FETCH_SYNC_INTERVAL_SECONDS);
  assert.equal(sanitizeFetchSyncIntervalSeconds('60'), DEFAULT_FETCH_SYNC_INTERVAL_SECONDS);
  assert.equal(sanitizeFetchSyncIntervalSeconds(Number.NaN), DEFAULT_FETCH_SYNC_INTERVAL_SECONDS);
  assert.equal(sanitizeFetchSyncIntervalSeconds(Number.POSITIVE_INFINITY), DEFAULT_FETCH_SYNC_INTERVAL_SECONDS);
  assert.equal(sanitizeFetchSyncIntervalSeconds(0), 0);
  assert.equal(sanitizeFetchSyncIntervalSeconds(-5), 0);
  assert.equal(sanitizeFetchSyncIntervalSeconds(1), FETCH_SYNC_INTERVAL_MIN_SECONDS);
  assert.equal(sanitizeFetchSyncIntervalSeconds(9), FETCH_SYNC_INTERVAL_MIN_SECONDS);
  assert.equal(sanitizeFetchSyncIntervalSeconds(FETCH_SYNC_INTERVAL_MIN_SECONDS), FETCH_SYNC_INTERVAL_MIN_SECONDS);
  assert.equal(sanitizeFetchSyncIntervalSeconds(FETCH_SYNC_INTERVAL_MAX_SECONDS + 1), FETCH_SYNC_INTERVAL_MAX_SECONDS);
  assert.equal(sanitizeFetchSyncIntervalSeconds(60.7), 60);
});

test('同步间隔填 0 表示关闭定时，序列化往返保留 0 而不回退默认', () => {
  const scene = createEmptySceneDocument('关闭定时');
  scene.fetchConfig.syncIntervalSeconds = 0;

  assert.equal(deserializeScene(serializeScene(scene)).fetchConfig.syncIntervalSeconds, 0);
});
