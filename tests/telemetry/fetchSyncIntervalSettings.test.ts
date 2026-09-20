import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptySceneDocument,
  DEFAULT_FETCH_SYNC_INTERVAL_MS,
  FETCH_SYNC_INTERVAL_MAX_MS,
  sanitizeFetchSyncIntervalMs,
} from '../../src/editor/model/SceneDocument';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';

test('场景 fetch 定时同步间隔随序列化往返保留', () => {
  const scene = createEmptySceneDocument('定时同步');
  scene.fetchConfig.syncIntervalMs = 30_000;

  const restored = deserializeScene(serializeScene(scene));

  assert.equal(restored.fetchConfig.syncIntervalMs, 30_000);
});

test('旧场景文件缺少同步间隔字段时回退默认值且不阻断加载', () => {
  const sceneFile = JSON.parse(serializeScene(createEmptySceneDocument('旧场景'))) as {
    scene: { fetchConfig: Record<string, unknown> };
  };
  delete sceneFile.scene.fetchConfig.syncIntervalMs;

  const restored = deserializeScene(JSON.stringify(sceneFile));

  assert.equal(restored.fetchConfig.syncIntervalMs, DEFAULT_FETCH_SYNC_INTERVAL_MS);
});

test('同步间隔非法值回退默认，负数收敛到 0，超上限收敛到上限，小数取整', () => {
  assert.equal(sanitizeFetchSyncIntervalMs(undefined), DEFAULT_FETCH_SYNC_INTERVAL_MS);
  assert.equal(sanitizeFetchSyncIntervalMs(null), DEFAULT_FETCH_SYNC_INTERVAL_MS);
  assert.equal(sanitizeFetchSyncIntervalMs('60000'), DEFAULT_FETCH_SYNC_INTERVAL_MS);
  assert.equal(sanitizeFetchSyncIntervalMs(Number.NaN), DEFAULT_FETCH_SYNC_INTERVAL_MS);
  assert.equal(sanitizeFetchSyncIntervalMs(Number.POSITIVE_INFINITY), DEFAULT_FETCH_SYNC_INTERVAL_MS);
  assert.equal(sanitizeFetchSyncIntervalMs(-5), 0);
  assert.equal(sanitizeFetchSyncIntervalMs(FETCH_SYNC_INTERVAL_MAX_MS + 1), FETCH_SYNC_INTERVAL_MAX_MS);
  assert.equal(sanitizeFetchSyncIntervalMs(60_000.7), 60_000);
});

test('同步间隔填 0 表示关闭定时，序列化往返保留 0 而不回退默认', () => {
  assert.equal(sanitizeFetchSyncIntervalMs(0), 0);

  const scene = createEmptySceneDocument('关闭定时');
  scene.fetchConfig.syncIntervalMs = 0;

  assert.equal(deserializeScene(serializeScene(scene)).fetchConfig.syncIntervalMs, 0);
});
