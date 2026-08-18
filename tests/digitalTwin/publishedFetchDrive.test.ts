import assert from 'node:assert/strict';
import test from 'node:test';

import type { FetchConfig } from '../../src/editor/model/SceneDocument.ts';
import type { DigitalTwinProjectRuntimeConfig } from '../../src/player/runtimeConfig.ts';
import {
  resolvePublishedFetchConfig,
  startPublishedFetchDrive,
} from '../../src/player/publishedFetchDrive.ts';

const PUBLISHED_FETCH_CONFIG: FetchConfig = {
  url: 'https://published.example.test/inventory',
  apiKey: 'editor-only-api-key',
};

function createRuntimeConfig(apiBaseUrl: string | null): DigitalTwinProjectRuntimeConfig {
  return {
    projectId: '2054201280000000001',
    mqttBrokerUrl: null,
    apiBaseUrl,
    runtimeEnabled: true,
    config: {},
  };
}

test('发布 Viewer 在中台未配置地址时保留包内 Fetch 地址，但不下发编辑器 API Key', () => {
  assert.deepEqual(
    resolvePublishedFetchConfig(PUBLISHED_FETCH_CONFIG, createRuntimeConfig(null)),
    { url: 'https://published.example.test/inventory', apiKey: '' },
  );
});

test('发布 Viewer 缺少中台运行配置时也不向浏览器传递编辑器 API Key', () => {
  assert.deepEqual(
    resolvePublishedFetchConfig(PUBLISHED_FETCH_CONFIG, null),
    { url: 'https://published.example.test/inventory', apiKey: '' },
  );
});

test('发布 Viewer 使用数据中台实时 Fetch 地址覆盖包内默认地址', () => {
  assert.deepEqual(
    resolvePublishedFetchConfig(PUBLISHED_FETCH_CONFIG, createRuntimeConfig('https://platform.example.test/current-inventory')),
    { url: 'https://platform.example.test/current-inventory', apiKey: '' },
  );
});

test('发布 Viewer 启动运行态后触发有效的 Fetch 数据驱动', async () => {
  const calls: FetchConfig[] = [];
  const runtime = {
    handleFetchDriveEvent: async (config: FetchConfig) => {
      calls.push(config);
    },
  };
  const effectiveConfig = resolvePublishedFetchConfig(
    PUBLISHED_FETCH_CONFIG,
    createRuntimeConfig('https://platform.example.test/current-inventory'),
  );

  await startPublishedFetchDrive(runtime, effectiveConfig);

  assert.deepEqual(calls, [effectiveConfig]);
});

test('发布 Viewer 在自身生命周期已取消时不再启动 Fetch 请求', async () => {
  const controller = new AbortController();
  let callCount = 0;
  const runtime = {
    handleFetchDriveEvent: async (_config: FetchConfig) => {
      callCount += 1;
    },
  };

  await startPublishedFetchDrive(runtime, PUBLISHED_FETCH_CONFIG);
  assert.equal(callCount, 1);

  controller.abort();
  await startPublishedFetchDrive(runtime, PUBLISHED_FETCH_CONFIG, controller.signal);
  assert.equal(callCount, 1);
});
