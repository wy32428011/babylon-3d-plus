import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDigitalTwinRuntimeConfigSavePayload,
  createDefaultDigitalTwinAllowedParentOrigins,
  mergeDigitalTwinAllowedParentOrigins,
  normalizeDigitalTwinAllowedParentOrigins,
  readDigitalTwinAllowedParentOrigins,
} from '../../electron/shared/digitalTwinRuntimeConfig.ts';

test('发布弹窗默认保留现有白名单并补入当前数据中台 Origin', () => {
  const configJson = JSON.stringify({
    telemetryInterval: 1000,
    integration: {
      futureField: true,
      allowedParentOrigins: ['https://screen.example.com'],
    },
  });

  assert.deepEqual(
    createDefaultDigitalTwinAllowedParentOrigins('http://127.0.0.1:8001/platform/', configJson),
    ['https://screen.example.com', 'http://127.0.0.1:8001'],
  );
});

test('数据中台 Origin 已存在时不重复追加', () => {
  assert.deepEqual(
    createDefaultDigitalTwinAllowedParentOrigins(
      'https://screen.example.com/app',
      '{"integration":{"allowedParentOrigins":["https://screen.example.com/"]}}',
    ),
    ['https://screen.example.com'],
  );
});

test('发布时只覆盖 allowedParentOrigins 并保留其他扩展配置', () => {
  const merged = mergeDigitalTwinAllowedParentOrigins(JSON.stringify({
    telemetryInterval: 1000,
    integration: {
      futureField: { enabled: true },
      allowedParentOrigins: ['https://old.example.com'],
    },
  }), ['https://screen.example.com/', 'http://127.0.0.1:8001']);

  assert.deepEqual(JSON.parse(merged), {
    telemetryInterval: 1000,
    integration: {
      futureField: { enabled: true },
      allowedParentOrigins: ['https://screen.example.com', 'http://127.0.0.1:8001'],
    },
  });
  assert.deepEqual(readDigitalTwinAllowedParentOrigins(merged), [
    'https://screen.example.com',
    'http://127.0.0.1:8001',
  ]);
});

test('运行配置保存载荷保留 MQTT、API 和启用状态', () => {
  assert.deepEqual(buildDigitalTwinRuntimeConfigSavePayload({
    projectId: '2054201280000000001',
    mqttBrokerUrl: 'ws://broker.internal:8083/mqtt',
    apiBaseUrl: 'https://api.internal/runtime',
    runtimeEnabled: false,
    configJson: '{"future":{"enabled":true}}',
    updatedAt: '2026-08-06T17:00:00',
  }, ['http://127.0.0.1:8001']), {
    projectId: '2054201280000000001',
    mqttBrokerUrl: 'ws://broker.internal:8083/mqtt',
    apiBaseUrl: 'https://api.internal/runtime',
    runtimeEnabled: false,
    configJson: '{"future":{"enabled":true},"integration":{"allowedParentOrigins":["http://127.0.0.1:8001"]}}',
  });
});

test('父页面 Origin 校验拒绝通配符、凭据、路径、Query、Fragment、非 HTTP 和重复项', () => {
  for (const origins of [
    ['*'],
    ['https://user:pass@screen.example.com'],
    ['https://screen.example.com/path'],
    ['https://screen.example.com?x=1'],
    ['https://screen.example.com#hash'],
    ['file:///C:/screen.html'],
    ['https://screen.example.com', 'https://screen.example.com/'],
  ]) {
    assert.throws(() => normalizeDigitalTwinAllowedParentOrigins(origins), /Origin/);
  }
});

test('父页面 Origin 支持显式清空，但拒绝超过 64 项', () => {
  assert.deepEqual(normalizeDigitalTwinAllowedParentOrigins([]), []);
  assert.throws(
    () => normalizeDigitalTwinAllowedParentOrigins(
      Array.from({ length: 65 }, (_, index) => `https://screen-${index}.example.com`),
    ),
    /64/,
  );
});
