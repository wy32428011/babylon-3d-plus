import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mqttRuntimeStatusStore } from '../../src/runtime/mqtt/mqttRuntimeStatus';
import type { MqttTelemetryClientConfig } from '../../src/runtime/mqtt/MqttTelemetryClient';

type SubscribeCallback = (error?: Error | null) => void;
type FakeMqttConnect = (...args: unknown[]) => FakeBrowserMqttClient;

let activeFakeConnect: FakeMqttConnect | null = null;

/** 记录浏览器 MQTT 客户端的订阅回调，便于测试精确控制 SUBACK 到达顺序。 */
class FakeBrowserMqttClient extends EventEmitter {
  readonly subscribeCallbacks: Array<{ topic: string; callback: SubscribeCallback }> = [];
  ended = false;

  /** 模拟 mqtt.js subscribe，只保存回调，不自动触发 SUBACK。 */
  subscribe(topic: string, _options: unknown, callback: SubscribeCallback): void {
    this.subscribeCallbacks.push({ topic, callback });
  }

  /** 模拟强制断开，保持旧回调仍可被测试手动触发。 */
  end(): void {
    this.ended = true;
  }
}

/** 安装可控的 mqtt.connect 替身，并返回所有创建出的假客户端。 */
function installFakeMqttConnect(): { clients: FakeBrowserMqttClient[]; restore: () => void } {
  const clients: FakeBrowserMqttClient[] = [];
  const require = createRequire(import.meta.url);
  const mqttModulePath = require.resolve('mqtt');
  const originalCacheEntry = require.cache[mqttModulePath];
  const fakeMqttModule = {
    connect: (...args: unknown[]) => {
      if (!activeFakeConnect) throw new Error('fake mqtt connect is not installed');
      return activeFakeConnect(...args);
    },
  };
  require.cache[mqttModulePath] = {
    id: mqttModulePath,
    path: mqttModulePath,
    filename: mqttModulePath,
    loaded: true,
    exports: fakeMqttModule,
    parent: null,
    children: [],
    paths: [],
    isPreloading: false,
    require,
  };
  activeFakeConnect = () => {
    const client = new FakeBrowserMqttClient();
    clients.push(client);
    return client;
  };

  return {
    clients,
    restore: () => {
      activeFakeConnect = null;
      if (originalCacheEntry) {
        require.cache[mqttModulePath] = originalCacheEntry;
      } else {
        delete require.cache[mqttModulePath];
      }
    },
  };
}

/** 生成启用状态的浏览器 MQTT 测试配置。 */
function createConfig(topicSuffixes: string[]): MqttTelemetryClientConfig {
  return {
    enabled: true,
    address: 'ws://broker.example/mqtt',
    subscriptions: topicSuffixes.map((suffix) => ({ topic: 'factory/' + suffix, qos: 0, adapter: { kind: 'epv' } })),
  };
}

test('浏览器 MQTT 客户端等待全部订阅 SUBACK 成功后才进入 connected', async () => {
  const fakeMqtt = installFakeMqttConnect();
  const { MqttTelemetryClient } = await import('../../src/runtime/mqtt/MqttTelemetryClient.js');
  const logs: string[] = [];
  const client = new MqttTelemetryClient((message) => logs.push(message));

  try {
    client.updateConfig(createConfig(['a', 'b']));
    const mqttClient = fakeMqtt.clients[0];

    mqttClient.emit('connect');
    assert.equal(client.getConnectionState(), 'connecting');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'connecting');

    mqttClient.subscribeCallbacks[0].callback(null);
    assert.equal(client.getConnectionState(), 'connecting');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'connecting');

    mqttClient.subscribeCallbacks[1].callback(null);
    assert.equal(client.getConnectionState(), 'connected');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'connected');
    assert.deepEqual(logs, ['MQTT 已连接并订阅：factory/a', 'MQTT 已连接并订阅：factory/b']);
  } finally {
    client.dispose();
    fakeMqtt.restore();
    mqttRuntimeStatusStore.update('disabled');
  }
});

test('浏览器 MQTT 客户端任一订阅 SUBACK 失败会进入 error 且不被后续成功覆盖', async () => {
  const fakeMqtt = installFakeMqttConnect();
  const { MqttTelemetryClient } = await import('../../src/runtime/mqtt/MqttTelemetryClient.js');
  const logs: string[] = [];
  const client = new MqttTelemetryClient((message) => logs.push(message));

  try {
    client.updateConfig(createConfig(['ok', 'bad']));
    const mqttClient = fakeMqtt.clients[0];

    mqttClient.emit('connect');
    mqttClient.subscribeCallbacks[1].callback(new Error('suback rejected'));
    assert.equal(client.getConnectionState(), 'error');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'error');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().lastError, 'suback rejected');

    mqttClient.subscribeCallbacks[0].callback(null);
    assert.equal(client.getConnectionState(), 'error');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'error');
    assert.equal(logs.some((message) => message.includes('MQTT 订阅失败：suback rejected')), true);
  } finally {
    client.dispose();
    fakeMqtt.restore();
    mqttRuntimeStatusStore.update('disabled');
  }
});

test('浏览器 MQTT 客户端连接 error 后延迟成功 SUBACK 不能覆盖 error 状态', async () => {
  const fakeMqtt = installFakeMqttConnect();
  const { MqttTelemetryClient } = await import('../../src/runtime/mqtt/MqttTelemetryClient.js');
  const logs: string[] = [];
  const client = new MqttTelemetryClient((message) => logs.push(message));

  try {
    client.updateConfig(createConfig(['a', 'b']));
    const mqttClient = fakeMqtt.clients[0];

    mqttClient.emit('connect');
    assert.equal(client.getConnectionState(), 'connecting');

    mqttClient.emit('error', new Error('socket failed'));
    assert.equal(client.getConnectionState(), 'error');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'error');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().lastError, 'socket failed');

    mqttClient.subscribeCallbacks[0].callback(null);
    mqttClient.subscribeCallbacks[1].callback(null);

    assert.equal(client.getConnectionState(), 'error');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'error');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().lastError, 'socket failed');
    assert.equal(logs.some((message) => message.includes('MQTT 连接错误：socket failed')), true);
  } finally {
    client.dispose();
    fakeMqtt.restore();
    mqttRuntimeStatusStore.update('disabled');
  }
});

test('浏览器 MQTT 客户端忽略旧连接周期的延迟 SUBACK，避免覆盖新周期状态', async () => {
  const fakeMqtt = installFakeMqttConnect();
  const { MqttTelemetryClient } = await import('../../src/runtime/mqtt/MqttTelemetryClient.js');
  const client = new MqttTelemetryClient(() => undefined);

  try {
    client.updateConfig(createConfig(['cycle']));
    const mqttClient = fakeMqtt.clients[0];

    mqttClient.emit('connect');
    const staleCallback = mqttClient.subscribeCallbacks[0].callback;
    mqttClient.emit('close');
    assert.equal(client.getConnectionState(), 'disconnected');

    mqttClient.emit('connect');
    const freshCallback = mqttClient.subscribeCallbacks[1].callback;
    assert.equal(client.getConnectionState(), 'connecting');

    staleCallback(null);
    assert.equal(client.getConnectionState(), 'connecting');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'connecting');

    freshCallback(null);
    assert.equal(client.getConnectionState(), 'connected');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'connected');
  } finally {
    client.dispose();
    fakeMqtt.restore();
    mqttRuntimeStatusStore.update('disabled');
  }
});
