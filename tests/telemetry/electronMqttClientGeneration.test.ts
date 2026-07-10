import assert from 'node:assert/strict';
import test from 'node:test';

import { ElectronMqttTelemetryClient } from '../../src/runtime/mqtt/ElectronMqttTelemetryClient';
import { DeviceTelemetryStore } from '../../src/runtime/mqtt/deviceTelemetry';
import { mqttRuntimeStatusStore } from '../../src/runtime/mqtt/mqttRuntimeStatus';

type ConfigureRequest = {
  enabled: boolean;
  address: string;
  subscriptions: Array<{
    topic: string;
    qos: 0 | 1 | 2;
    adapter?:
      | { kind: 'epv'; sourceId?: string }
      | {
          kind: 'json-path';
          sourceId?: string;
          deviceTypePath?: string;
          assetCodePath?: string;
          timestampPath?: string;
          sequencePath?: string;
          fields: Record<string, string>;
        };
  }>;
};

type IpcStatus = {
  state: 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error';
  address?: string;
  subscriptions: ConfigureRequest['subscriptions'];
  lastError?: string;
};

type IpcEvent =
  | { type: 'status'; status: IpcStatus }
  | { type: 'log'; message: string; receivedAt: number }
  | {
      type: 'message';
      sourceId: string;
      subscription: ConfigureRequest['subscriptions'][number];
      topic: string;
      payloadText: string;
      receivedAt: number;
    };

test('ElectronMqttTelemetryClient 丢弃旧 configure Promise 和旧状态事件', async () => {
  const api = createControlledApi();
  const logs: string[] = [];
  const client = new ElectronMqttTelemetryClient((message) => logs.push(message), new DeviceTelemetryStore(), api);

  try {
    client.updateConfig(createConfig('mqtt://old', 'old/topic', 'OLD'));
    client.updateConfig(createConfig('mqtt://new', 'new/topic', 'NEW'));

    api.resolveConfigure(0, { state: 'error', address: 'mqtt://old', subscriptions: api.configureRequests[0].subscriptions, lastError: 'old failed' });
    await flushMicrotasks();
    assert.equal(client.getConnectionState(), 'connecting');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'connecting');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().lastError, null);

    api.emit({ type: 'status', status: { state: 'error', address: 'mqtt://old', subscriptions: api.configureRequests[0].subscriptions, lastError: 'old event' } });
    assert.equal(client.getConnectionState(), 'connecting');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'connecting');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().lastError, null);

    api.resolveConfigure(1, { state: 'connected', address: 'mqtt://new', subscriptions: api.configureRequests[1].subscriptions });
    await flushMicrotasks();
    assert.equal(client.getConnectionState(), 'connected');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'connected');
    assert.equal(mqttRuntimeStatusStore.getSnapshot().lastError, null);
    assert.deepEqual(logs, []);
  } finally {
    client.dispose();
    mqttRuntimeStatusStore.update('disabled');
  }
});

test('ElectronMqttTelemetryClient 丢弃旧订阅消息且保留当前订阅消息', async () => {
  const api = createControlledApi();
  const store = new DeviceTelemetryStore();
  const client = new ElectronMqttTelemetryClient(() => {}, store, api);
  const oldTopic = 'dt/factory/logistics/stacker/OLD/twindatadriven/joint';
  const newTopic = 'dt/factory/logistics/stacker/NEW/twindatadriven/joint';

  try {
    client.updateConfig(createConfig('mqtt://old', oldTopic, 'source-old'));
    client.updateConfig(createConfig('mqtt://new', newTopic, 'source-new'));
    api.resolveConfigure(1, { state: 'connected', address: 'mqtt://new', subscriptions: api.configureRequests[1].subscriptions });
    await flushMicrotasks();

    api.emit(createMessageEvent(oldTopic, 'source-old', 'OLD', api.configureRequests[0].subscriptions[0], 1));
    assert.equal(store.getSnapshot('OLD', 'stacker', 'source-old'), null);

    api.emit(createMessageEvent(newTopic, 'source-new', 'NEW', api.configureRequests[1].subscriptions[0], 2));
    assert.equal(store.getSnapshot('NEW', 'stacker', 'source-new')?.fields.normal, true);
  } finally {
    client.dispose();
    mqttRuntimeStatusStore.update('disabled');
  }
});

test('ElectronMqttTelemetryClient 接受当前通配订阅命中的实际 Topic', async () => {
  const api = createControlledApi();
  const store = new DeviceTelemetryStore();
  const client = new ElectronMqttTelemetryClient(() => {}, store, api);
  const filter = 'dt/factory/logistics/+/+/twindatadriven/joint';
  const actualTopic = 'dt/factory/logistics/stacker/EQ-01/twindatadriven/joint';

  try {
    client.updateConfig(createConfig('mqtt://live', filter, 'line-a'));
    api.resolveConfigure(0, { state: 'connected', address: 'mqtt://live', subscriptions: api.configureRequests[0].subscriptions });
    await flushMicrotasks();

    api.emit(createMessageEvent(actualTopic, 'line-a', 'EQ-01', api.configureRequests[0].subscriptions[0], 3));
    assert.equal(store.getSnapshot('EQ-01', 'stacker', 'line-a')?.fields.normal, true);
  } finally {
    client.dispose();
    mqttRuntimeStatusStore.update('disabled');
  }
});

test('ElectronMqttTelemetryClient 丢弃 dispose 后旧 disconnect 返回和事件', async () => {
  const api = createControlledApi();
  const client = new ElectronMqttTelemetryClient(() => {}, new DeviceTelemetryStore(), api);

  client.updateConfig(createConfig('mqtt://live', 'live/topic', 'LIVE'));
  client.dispose();
  api.resolveDisconnect({ state: 'error', address: 'mqtt://live', subscriptions: api.configureRequests[0].subscriptions, lastError: 'disconnect late' });
  await flushMicrotasks();
  api.emit({ type: 'status', status: { state: 'connected', address: 'mqtt://live', subscriptions: api.configureRequests[0].subscriptions } });

  assert.equal(client.getConnectionState(), 'disabled');
  assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'disabled');
});

function createControlledApi() {
  let handler: ((event: IpcEvent) => void) | null = null;
  const configureRequests: ConfigureRequest[] = [];
  const configureDeferred: Array<Deferred<IpcStatus>> = [];
  const disconnectDeferred = createDeferred<IpcStatus>();

  return {
    configureRequests,
    mqttConfigure(request: ConfigureRequest): Promise<IpcStatus> {
      configureRequests.push(request);
      const deferred = createDeferred<IpcStatus>();
      configureDeferred.push(deferred);
      return deferred.promise;
    },
    mqttDisconnect(): Promise<IpcStatus> {
      return disconnectDeferred.promise;
    },
    mqttGetStatus(): Promise<IpcStatus> {
      return Promise.resolve({ state: 'disabled', subscriptions: [] });
    },
    onMqttEvent(nextHandler: (event: IpcEvent) => void): () => void {
      handler = nextHandler;
      return () => {
        handler = null;
      };
    },
    emit(event: IpcEvent): void {
      handler?.(event);
    },
    resolveConfigure(index: number, status: IpcStatus): void {
      configureDeferred[index].resolve(status);
    },
    resolveDisconnect(status: IpcStatus): void {
      disconnectDeferred.resolve(status);
    },
  };
}

function createConfig(address: string, topic: string, sourceId: string) {
  return {
    enabled: true,
    address,
    sourceId,
    subscriptions: [{ topic, qos: 0 as const, adapter: { kind: 'epv' as const, sourceId } }],
  };
}

/** 创建主进程向 renderer 推送的标准 EPV 消息事件。 */
function createMessageEvent(
  topic: string,
  sourceId: string,
  assetCode: string,
  subscription: ConfigureRequest['subscriptions'][number],
  sequence: number,
): IpcEvent {
  return {
    type: 'message',
    sourceId,
    subscription,
    topic,
    payloadText: JSON.stringify({ seq: sequence, data: [{ e: assetCode, p: 'normal', v: true }] }),
    receivedAt: 1_700_000_000_000 + sequence,
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
