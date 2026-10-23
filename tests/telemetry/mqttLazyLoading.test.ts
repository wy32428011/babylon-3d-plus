import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createBrowserMqttLoader, type BrowserMqttModule, type MqttModuleLoader } from '../../src/runtime/mqtt/browserMqttLoader';
import { MqttTelemetryClient, type MqttTelemetryClientConfig } from '../../src/runtime/mqtt/MqttTelemetryClient';
import { MqttStackerTelemetryClient } from '../../src/runtime/mqtt/MqttStackerTelemetryClient';
import { startMqttConnectionTest, type MqttConnectionTestDependencies } from '../../src/runtime/mqtt/MqttConnectionTest';
import { DeviceTelemetryStore } from '../../src/runtime/mqtt/deviceTelemetry';
import { DEFAULT_MQTT_CONFIG } from '../../src/editor/model/SceneDocument';
import { mqttRuntimeStatusStore } from '../../src/runtime/mqtt/mqttRuntimeStatus';

class FakeMqttClient extends EventEmitter {
  readonly subscriptions: Array<{ topic: string; callback: (error?: Error | null) => void }> = [];
  endCalls = 0;

  subscribe(topic: string, _options: unknown, callback: (error?: Error | null) => void): void {
    this.subscriptions.push({ topic, callback });
  }

  end(): void { this.endCalls += 1; }
  async endAsync(): Promise<void> { this.end(); }
}

test('模块导入、禁用、模拟器与 Electron IPC 路径不加载浏览器 mqtt 包', async () => {
  const require = createRequire(import.meta.url);
  const mqttPath = require.resolve('mqtt');
  assert.equal(require.cache[mqttPath], undefined);
  const client = new MqttStackerTelemetryClient(() => undefined);
  const config = { ...DEFAULT_MQTT_CONFIG, enabled: true, address: 'ws://broker.example/mqtt' };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let ipcConfigureCalls = 0;
  const subscriptions: unknown[] = [];
  const status = { state: 'disabled' as const, subscriptions };
  const browserTimers = { setInterval: () => 1, clearInterval: () => undefined };
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: browserTimers });
    client.updateConfig({ ...config, enabled: false });
    client.updateConfig({ ...config, simulatorEnabled: true, simulatorAssetCode: 'LAZY-TEST' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { ...browserTimers, editorApi: {
      mqttConfigure: async () => { ipcConfigureCalls += 1; return status; },
      mqttDisconnect: async () => status,
      mqttGetStatus: async () => status,
      onMqttEvent: () => () => undefined,
      mqttTestConnection: async () => ({ requestId: 'lazy', status: 'success', message: 'IPC', durationMs: 1 }),
      mqttCancelConnectionTest: async () => true,
    } } });
    client.updateConfig(config);
    const result = await startMqttConnectionTest(createRequest()).result;
    assert.equal(result.status, 'success');
    assert.equal(ipcConfigureCalls, 1);
    assert.equal(require.cache[mqttPath], undefined);
  } finally {
    client.dispose();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    mqttRuntimeStatusStore.update('disabled');
  }
});

test('共享 MQTT loader 合并并发下载，失败后允许重新加载', async () => {
  const module = createFakeModule();
  const pending = createDeferred<BrowserMqttModule>();
  let attempts = 0;
  const load = createBrowserMqttLoader(() => {
    attempts += 1;
    return attempts === 1 ? pending.promise : Promise.resolve(module.mqtt);
  });
  const first = load();
  assert.equal(load(), first);
  await Promise.resolve();
  assert.equal(attempts, 1);
  pending.reject(new Error('chunk unavailable'));
  await assert.rejects(first, /chunk unavailable/);
  assert.equal(await load(), module.mqtt);
  assert.equal(attempts, 2);
  assert.equal(await load(), module.mqtt);
  assert.equal(attempts, 2);
});

test('遥测模块下载期间仍为 connecting，全部 SUBACK 后 connected，消息按原顺序写入', async () => {
  const pending = createDeferred<BrowserMqttModule>();
  const module = createFakeModule();
  const store = new DeviceTelemetryStore();
  const received: unknown[] = [];
  const unsubscribe = store.subscribe(snapshot => { if (snapshot) received.push(snapshot.fields.normal); });
  const client = new MqttTelemetryClient(() => undefined, store, () => pending.promise);
  try {
    client.updateConfig(createConfig());
    assert.equal(client.getConnectionState(), 'connecting');
    assert.equal(module.clients.length, 0);
    pending.resolve(module.mqtt);
    await flushMicrotasks();
    const mqtt = module.clients[0];
    mqtt.emit('connect');
    assert.deepEqual(mqtt.subscriptions.map(s => s.topic), ['dt/factory/logistics/+/+/twindatadriven/joint']);
    assert.equal(client.getConnectionState(), 'connecting');
    mqtt.subscriptions[0].callback(null);
    assert.equal(client.getConnectionState(), 'connected');
    for (const [seq, normal] of [[1, false], [2, true]] as const) {
      mqtt.emit('message', 'dt/factory/logistics/stacker/EQ-1/twindatadriven/joint', Buffer.from(JSON.stringify({ seq, data: [{ e: 'EQ-1', p: 'normal', v: normal }] })));
    }
    assert.deepEqual(received, [false, true]);
  } finally {
    unsubscribe();
    client.dispose();
    mqttRuntimeStatusStore.update('disabled');
  }
});

for (const action of ['disable', 'dispose'] as const) {
  test('遥测模块下载期间 ' + action + ' 后不建立迟到连接', async () => {
    const pending = createDeferred<BrowserMqttModule>();
    const module = createFakeModule();
    const client = new MqttTelemetryClient(() => undefined, undefined, () => pending.promise);
    client.updateConfig(createConfig());
    if (action === 'dispose') client.dispose();
    else client.updateConfig({ ...createConfig(), enabled: false });
    pending.resolve(module.mqtt);
    await flushMicrotasks();
    assert.equal(module.clients.length, 0);
    assert.equal(client.getConnectionState(), 'disabled');
    client.dispose();
  });
}

test('遥测配置切换丢弃旧模块加载请求，只连接最新地址与订阅', async () => {
  const oldLoad = createDeferred<BrowserMqttModule>();
  const newLoad = createDeferred<BrowserMqttModule>();
  const module = createFakeModule();
  let loads = 0;
  const client = new MqttTelemetryClient(() => undefined, undefined, () => (++loads === 1 ? oldLoad.promise : newLoad.promise));
  try {
    client.updateConfig(createConfig());
    client.updateConfig({ ...createConfig(), address: 'wss://new.example/mqtt', subscriptions: [{ topic: 'new/+', qos: 1 }] });
    newLoad.resolve(module.mqtt);
    await flushMicrotasks();
    oldLoad.resolve(module.mqtt);
    await flushMicrotasks();
    assert.deepEqual(module.addresses, ['wss://new.example/mqtt']);
    module.clients[0].emit('connect');
    assert.deepEqual(module.clients[0].subscriptions.map(s => s.topic), ['new/+']);
  } finally { client.dispose(); }
});

test('遥测模块加载失败进入 error，同一配置可重试并恢复连接', async () => {
  const module = createFakeModule();
  const logs: string[] = [];
  let attempts = 0;
  const client = new MqttTelemetryClient(message => logs.push(message), undefined, async () => {
    if (++attempts === 1) throw new Error('chunk failed');
    return module.mqtt;
  });
  try {
    client.updateConfig(createConfig());
    await flushMicrotasks();
    assert.equal(client.getConnectionState(), 'error');
    assert.match(logs[0], /chunk failed/);
    client.updateConfig(createConfig());
    await flushMicrotasks();
    assert.equal(attempts, 2);
    module.clients[0].emit('connect');
    module.clients[0].subscriptions[0].callback(null);
    assert.equal(client.getConnectionState(), 'connected');
  } finally { client.dispose(); }
});

test('旧配置模块加载失败不能覆盖新配置连接状态', async () => {
  const oldLoad = createDeferred<BrowserMqttModule>();
  const module = createFakeModule();
  let attempts = 0;
  const client = new MqttTelemetryClient(() => undefined, undefined, () => ++attempts === 1 ? oldLoad.promise : Promise.resolve(module.mqtt));
  try {
    client.updateConfig(createConfig());
    client.updateConfig({ ...createConfig(), address: 'wss://new.example/mqtt' });
    await flushMicrotasks();
    module.clients[0].emit('connect');
    module.clients[0].subscriptions[0].callback(null);
    oldLoad.reject(new Error('obsolete chunk failure'));
    await flushMicrotasks();
    assert.equal(client.getConnectionState(), 'connected');
  } finally { client.dispose(); }
});

for (const action of ['cancel', 'timeout'] as const) {
  test('连接测试模块下载期间 ' + action + ' 及时结算并阻止迟到连接', async () => {
    const pending = createDeferred<BrowserMqttModule>();
    const module = createFakeModule();
    const clock = createClock();
    const handle = startMqttConnectionTest(createRequest(), createTestDependencies(() => pending.promise, clock));
    await flushMicrotasks();
    if (action === 'cancel') await handle.cancel();
    else clock.fireTimeout();
    const result = await handle.result;
    assert.equal(result.status, action === 'cancel' ? 'canceled' : 'error');
    pending.resolve(module.mqtt);
    await flushMicrotasks();
    assert.equal(module.clients.length, 0);
  });
}

test('连接测试模块下载失败返回结构化错误，下一次测试能够重新加载', async () => {
  const module = createFakeModule();
  let attempts = 0;
  const load = createBrowserMqttLoader(async () => {
    if (++attempts === 1) throw new Error('download failed');
    return module.mqtt;
  });
  const dependencies = createTestDependencies(load);
  const first = await startMqttConnectionTest(createRequest(), dependencies).result;
  assert.equal(first.status, 'error');
  assert.match(first.message, /download failed/);
  const second = startMqttConnectionTest(createRequest(), dependencies);
  await flushMicrotasks();
  assert.equal(attempts, 2);
  const mqtt = module.clients[0];
  mqtt.emit('connect');
  mqtt.subscriptions[0].callback(null);
  assert.equal((await second.result).status, 'success');
  assert.equal(mqtt.endCalls, 1);
});

function createFakeModule() {
  const clients: FakeMqttClient[] = [];
  const addresses: string[] = [];
  const mqtt = { connect: (address: string) => {
    addresses.push(address);
    const client = new FakeMqttClient();
    clients.push(client);
    return client;
  } } as unknown as BrowserMqttModule;
  return { mqtt, clients, addresses };
}

function createConfig(): MqttTelemetryClientConfig {
  return { enabled: true, address: 'ws://broker.example/mqtt', subscriptions: [{ topic: 'dt/factory/logistics/+/+/twindatadriven/joint', qos: 0, adapter: { kind: 'epv' } }] };
}

function createRequest() {
  return { requestId: 'lazy', address: 'ws://broker.example/mqtt', subscriptions: [{ topic: 'dt/factory/logistics/+/+/twindatadriven/joint', qos: 0 as const }] };
}

function createClock() {
  let handler: (() => void) | null = null;
  return {
    now: () => 100,
    setTimeout: (next: () => void) => { handler = next; return 1 as unknown as ReturnType<typeof globalThis.setTimeout>; },
    clearTimeout: () => { handler = null; },
    fireTimeout: () => { assert.ok(handler); handler(); },
  };
}

function createTestDependencies(loadMqtt: MqttModuleLoader, clock = createClock()): MqttConnectionTestDependencies {
  return { loadMqtt, ...clock, randomUUID: () => 'uuid', electronApi: null };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
