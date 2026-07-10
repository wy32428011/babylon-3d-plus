import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const mqttIpcSource = readFileSync(new URL('../electron/ipc/mqttIpc.ts', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const preloadCtsSource = readFileSync(new URL('../electron/preload.cts', import.meta.url), 'utf8');
const electronTypesSource = readFileSync(new URL('../electron/types.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const stackerClientSource = readFileSync(new URL('../src/runtime/mqtt/MqttStackerTelemetryClient.ts', import.meta.url), 'utf8');
const electronClientSource = readFileSync(new URL('../src/runtime/mqtt/ElectronMqttTelemetryClient.ts', import.meta.url), 'utf8');

test('Electron MQTT IPC 只接收无凭据配置并按 webContents 管理客户端', () => {
  assert.match(mqttIpcSource, /export function registerMqttIpc/);
  assert.match(mqttIpcSource, /webContents\.id/);
  assert.match(mqttIpcSource, /mqtt:configure/);
  assert.match(mqttIpcSource, /mqtt:disconnect/);
  assert.match(mqttIpcSource, /mqtt:getStatus/);
  assert.match(mqttIpcSource, /mqtt:event/);
  const configureType = electronTypesSource.match(/export type MqttIpcConfigureRequest = \{[\s\S]*?\};/)?.[0] ?? '';
  assert.match(configureType, /enabled/);
  assert.match(configureType, /address/);
  assert.match(configureType, /subscriptions/);
  assert.doesNotMatch(configureType, /password|token|username|credential/i);
  assert.doesNotMatch(mqttIpcSource, /\.\.\/\.\.\/src|from ['"]src\//);
});

test('Electron MQTT IPC 包含 stale client 与订阅快照防护', () => {
  assert.match(mqttIpcSource, /generation/);
  assert.match(mqttIpcSource, /subscriptionSnapshot/);
  assert.match(mqttIpcSource, /connect/);
  assert.match(mqttIpcSource, /message/);
  assert.match(mqttIpcSource, /error/);
  assert.match(mqttIpcSource, /close/);
  assert.match(mqttIpcSource, /mqttTopicMatches/);
  assert.match(mqttIpcSource, /filterLevel === '#'/);
  assert.match(mqttIpcSource, /filterLevel === '\+'/);
});

test('Electron MQTT 地址只允许 ws/wss 且拒绝敏感凭据', () => {
  assert.match(mqttIpcSource, /url\.protocol !== 'ws:' && url\.protocol !== 'wss:'/);
  assert.match(mqttIpcSource, /url\.username \|\| url\.password/);
  assert.match(mqttIpcSource, /'token'/);
  assert.match(mqttIpcSource, /'access_token'/);
  assert.match(mqttIpcSource, /'password'/);
  assert.match(mqttIpcSource, /'username'/);
});

test('配置切换和显式断开必须等待旧 MQTT 物理连接关闭', () => {
  assert.match(mqttIpcSource, /async function disconnectRendererClient/);
  assert.match(mqttIpcSource, /await client\.endAsync\(true\)/);
  assert.match(mqttIpcSource, /await disconnectRendererClient\(rendererClient, 'MQTT 配置已切换/);
  assert.match(mqttIpcSource, /if \(rendererClient\.generation !== generation\) return rendererClient\.status/);
  assert.match(mqttIpcSource, /await disconnectRendererClient\(rendererClient, 'MQTT 已由 renderer 断开/);
  assert.match(mqttIpcSource, /void Promise\.allSettled/);
});

test('过期 configure 等待旧连接断开后不得创建连接或覆盖较新配置', async () => {
  const harness = createMqttIpcHarness();
  const sender = createFakeWebContents(1);
  const staleEnd = createDeferred();
  const oldClient = createFakeMqttClient(staleEnd.promise);
  harness.clientsByWebContentsId.set(sender.id, {
    webContents: sender,
    generation: 0,
    client: oldClient,
    status: { state: 'connected', address: 'ws://old.example/mqtt', subscriptions: [] },
    subscriptions: [],
  });

  const firstConfigure = harness.handleConfigure(
    { sender },
    createConfigureRequest('ws://first.example/mqtt', 'factory/first'),
  );
  await Promise.resolve();

  const secondStatus = await harness.handleConfigure(
    { sender },
    createConfigureRequest('ws://second.example/mqtt', 'factory/second'),
  );
  assert.equal(harness.connectCalls.length, 1);
  assert.equal(harness.connectCalls[0].address, 'ws://second.example/mqtt');
  assert.equal(secondStatus.address, 'ws://second.example/mqtt');

  staleEnd.resolve();
  const staleStatus = await firstConfigure;
  assert.equal(harness.connectCalls.length, 1);
  assert.equal(staleStatus.address, 'ws://second.example/mqtt');
  assert.equal(harness.clientsByWebContentsId.get(sender.id).status.address, 'ws://second.example/mqtt');
});

test('过期 disconnect 等待旧连接断开后不得覆盖较新 configure 状态', async () => {
  const harness = createMqttIpcHarness();
  const sender = createFakeWebContents(2);
  const staleEnd = createDeferred();
  harness.clientsByWebContentsId.set(sender.id, {
    webContents: sender,
    generation: 0,
    client: createFakeMqttClient(staleEnd.promise),
    status: { state: 'connected', address: 'ws://old.example/mqtt', subscriptions: [] },
    subscriptions: [],
  });

  const staleDisconnect = harness.handleDisconnect({ sender });
  await Promise.resolve();
  const configureStatus = await harness.handleConfigure(
    { sender },
    createConfigureRequest('ws://new.example/mqtt', 'factory/new'),
  );
  assert.equal(configureStatus.address, 'ws://new.example/mqtt');

  staleEnd.resolve();
  const disconnectStatus = await staleDisconnect;
  assert.equal(disconnectStatus.address, 'ws://new.example/mqtt');
  assert.equal(harness.clientsByWebContentsId.get(sender.id).status.state, 'connecting');
});

test('所有订阅失败时不得发布 connected 状态，并聚合订阅错误', async () => {
  const subscriptionErrors = new Map([
    ['factory/device-a', new Error('权限不足')],
    ['factory/device-b', new Error('Topic 不存在')],
  ]);
  const harness = createMqttIpcHarness({
    createClient: () => createFakeMqttClient(Promise.resolve(), subscriptionErrors),
  });
  const sender = createFakeWebContents(3);

  const configureStatus = await harness.handleConfigure(
    { sender },
    {
      enabled: true,
      address: 'ws://broker.example/mqtt',
      subscriptions: [
        { topic: 'factory/device-a', qos: 0, adapter: { kind: 'epv' } },
        { topic: 'factory/device-b', qos: 1, adapter: { kind: 'epv' } },
      ],
    },
  );
  assert.equal(configureStatus.state, 'connecting');

  const connectedClient = harness.connectCalls[0].client;
  connectedClient.handlers.get('connect')();

  const finalStatus = harness.clientsByWebContentsId.get(sender.id).status;
  assert.equal(finalStatus.state, 'error');
  assert.match(finalStatus.lastError, /factory\/device-a/);
  assert.match(finalStatus.lastError, /factory\/device-b/);
  assert.equal(
    sender.events.some((event) => event.payload?.type === 'status' && event.payload.status.state === 'connected'),
    false,
  );
});

test('endAsync 拒绝时显式 disconnect 返回结构化错误而不是裸抛', async () => {
  const harness = createMqttIpcHarness();
  const sender = createFakeWebContents(4);
  harness.clientsByWebContentsId.set(sender.id, {
    webContents: sender,
    generation: 0,
    client: createFakeMqttClient(Promise.reject(new Error('socket close failed'))),
    status: { state: 'connected', address: 'ws://old.example/mqtt', subscriptions: [] },
    subscriptions: [],
  });

  const status = await harness.handleDisconnect({ sender });

  assert.equal(status.state, 'error');
  assert.match(status.lastError, /socket close failed/);
  assert.equal(harness.clientsByWebContentsId.get(sender.id).client, null);
  assert.equal(
    sender.events.some((event) => event.payload?.type === 'log' && /断开失败/.test(event.payload.message)),
    true,
  );
});

test('配置切换遇到 endAsync 拒绝时记录错误并继续建立新连接', async () => {
  const harness = createMqttIpcHarness();
  const sender = createFakeWebContents(5);
  harness.clientsByWebContentsId.set(sender.id, {
    webContents: sender,
    generation: 0,
    client: createFakeMqttClient(Promise.reject(new Error('old socket close failed'))),
    status: { state: 'connected', address: 'ws://old.example/mqtt', subscriptions: [] },
    subscriptions: [],
  });

  const status = await harness.handleConfigure(
    { sender },
    createConfigureRequest('ws://new.example/mqtt', 'factory/new'),
  );

  assert.equal(status.state, 'connecting');
  assert.equal(status.address, 'ws://new.example/mqtt');
  assert.equal(harness.connectCalls.length, 1);
  assert.equal(
    sender.events.some((event) => event.payload?.type === 'status' && event.payload.status.state === 'error'),
    true,
  );
});

test('preload 只暴露窄 MQTT API 且事件订阅返回 unsubscribe', () => {
  for (const source of [preloadSource, preloadCtsSource]) {
    assert.match(source, /mqttConfigure/);
    assert.match(source, /mqttDisconnect/);
    assert.match(source, /mqttGetStatus/);
    assert.match(source, /onMqttEvent/);
    assert.match(source, /return \(\) =>/);
    assert.doesNotMatch(source, /editorApi[\s\S]*ipcRenderer\s*[,}]/);
  }
});

test('主进程注册 MQTT IPC 并在退出前清理', () => {
  assert.match(mainSource, /registerMqttIpc/);
  assert.match(mainSource, /app\.on\('will-quit'/);
});

test('渲染端在 Electron 和浏览器之间二选一，本地 simulator 保持浏览器路径', () => {
  assert.match(stackerClientSource, /ElectronMqttTelemetryClient/);
  assert.match(electronClientSource, /mqttConfigure/);
  assert.match(stackerClientSource, /simulatorEnabled/);
  assert.match(stackerClientSource, /MqttTelemetryClient/);
});

function createMqttIpcHarness(options = {}) {
  const connectCalls = [];
  const source = mqttIpcSource + '\nObject.assign(globalThis.__mqttIpcHarness, { handleConfigure, handleDisconnect, clientsByWebContentsId });';
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const sandbox = {
    exports: {},
    globalThis: { __mqttIpcHarness: {} },
    crypto: { randomUUID: () => 'test-uuid' },
    URL,
    Set,
    Map,
    Array,
    Date,
    Promise,
    require: (specifier) => {
      if (specifier === 'electron') return { ipcMain: { handle: () => undefined } };
      if (specifier === 'mqtt') {
        return {
          __esModule: true,
          default: {
            connect: (address, mqttOptions) => {
              const client = options.createClient?.({ address, options: mqttOptions }) ?? createFakeMqttClient(Promise.resolve());
              connectCalls.push({ address, options: mqttOptions, client });
              return client;
            },
          },
        };
      }
      throw new Error('Unexpected require: ' + specifier);
    },
  };
  vm.runInNewContext(output, sandbox);
  return { ...sandbox.globalThis.__mqttIpcHarness, connectCalls };
}

function createConfigureRequest(address, topic) {
  return {
    enabled: true,
    address,
    subscriptions: [{ topic, qos: 0, adapter: { kind: 'epv' } }],
  };
}

function createFakeWebContents(id) {
  return {
    id,
    events: [],
    once: () => undefined,
    isDestroyed: () => false,
    send(channel, payload) {
      this.events.push({ channel, payload });
    },
  };
}

function createFakeMqttClient(endPromise, subscriptionErrors = new Map()) {
  return {
    handlers: new Map(),
    endAsync: () => endPromise,
    on(event, handler) {
      this.handlers.set(event, handler);
      return this;
    },
    subscribe(topic, _options, callback) {
      callback?.(subscriptionErrors.get(topic) ?? null);
      return this;
    },
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
