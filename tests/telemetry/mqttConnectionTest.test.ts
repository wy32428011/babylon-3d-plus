import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  startMqttConnectionTest,
  type ElectronMqttConnectionTestApi,
  type MqttConnectionTestClient,
  type MqttConnectionTestDependencies,
  type MqttConnectionTestRequest,
} from '../../src/runtime/mqtt/MqttConnectionTest.ts';
import { mqttRuntimeStatusStore } from '../../src/runtime/mqtt/mqttRuntimeStatus.ts';

type SubscribeCallback = (error?: Error | null) => void;

/** 可控临时 MQTT 客户端，测试只手动触发连接、错误和 SUBACK。 */
class FakeMqttConnectionTestClient extends EventEmitter implements MqttConnectionTestClient {
  readonly subscribeCalls: Array<{ topic: string; qos: 0 | 1 | 2; callback: SubscribeCallback }> = [];
  endCalls = 0;
  endError: Error | null = null;
  endPromise: Promise<void> | null = null;
  emitCloseOnFirstEnd = false;
  subscribeError: Error | null = null;

  subscribe(topic: string, options: { qos: 0 | 1 | 2 }, callback: SubscribeCallback): void {
    if (this.subscribeError) throw this.subscribeError;
    this.subscribeCalls.push({ topic, qos: options.qos, callback });
  }

  async endAsync(): Promise<void> {
    this.endCalls += 1;
    if (this.emitCloseOnFirstEnd && this.endCalls === 1) this.emit('close');
    if (this.endPromise) await this.endPromise;
    if (this.endError) throw this.endError;
  }
}

test('全部 Topic 收到成功 SUBACK 后返回成功并断开临时客户端', async () => {
  const client = new FakeMqttConnectionTestClient();
  const dependencies = createDependencies(client);
  const runtimeStatusBeforeTest = mqttRuntimeStatusStore.getSnapshot();

  const handle = startMqttConnectionTest(createRequest(), dependencies);

  client.emit('connect');
  assert.equal(client.subscribeCalls.length, 2);
  client.subscribeCalls[0].callback(null);
  client.subscribeCalls[1].callback(null);
  const result = await handle.result;

  assert.equal(result.status, 'success');
  assert.match(result.message, /2 个 Topic/);
  assert.equal(client.endCalls, 1);
  assert.equal(mqttRuntimeStatusStore.getSnapshot(), runtimeStatusBeforeTest);
});

test('任一 SUBACK 失败时返回具体 Topic 错误并断开', async () => {
  const client = new FakeMqttConnectionTestClient();
  const handle = startMqttConnectionTest(createRequest(), createDependencies(client));

  client.emit('connect');
  client.subscribeCalls[0].callback(new Error('not authorized'));
  client.subscribeCalls[1].callback(null);
  const result = await handle.result;

  assert.equal(result.status, 'error');
  assert.match(result.message, /factory\/a/);
  assert.match(result.message, /not authorized/);
  assert.equal(client.endCalls, 1);
});

test('连接错误会返回失败并断开，延迟 connect 不会继续订阅', async () => {
  const client = new FakeMqttConnectionTestClient();
  const handle = startMqttConnectionTest(createRequest(), createDependencies(client));

  client.emit('error', new Error('ECONNREFUSED'));
  client.emit('connect');
  const result = await handle.result;

  assert.equal(result.status, 'error');
  assert.match(result.message, /ECONNREFUSED/);
  assert.equal(client.subscribeCalls.length, 0);
  assert.equal(client.endCalls, 1);
});

test('建立会话前连接关闭会返回失败并断开', async () => {
  const client = new FakeMqttConnectionTestClient();
  const handle = startMqttConnectionTest(createRequest(), createDependencies(client));

  client.emit('close');
  const result = await handle.result;

  assert.equal(result.status, 'error');
  assert.match(result.message, /关闭/);
  assert.equal(client.endCalls, 1);
});

test('超时会返回失败并断开', async () => {
  const client = new FakeMqttConnectionTestClient();
  const clock = createControlledClock();
  const handle = startMqttConnectionTest(createRequest(), createDependencies(client, clock));

  clock.fireTimeout();
  const result = await handle.result;

  assert.equal(result.status, 'error');
  assert.match(result.message, /8 秒/);
  assert.equal(client.endCalls, 1);
});

test('取消测试会返回 canceled 且延迟事件不能覆盖结果', async () => {
  const client = new FakeMqttConnectionTestClient();
  const handle = startMqttConnectionTest(createRequest(), createDependencies(client));

  handle.cancel();
  client.emit('connect');
  const result = await handle.result;

  assert.equal(result.status, 'canceled');
  assert.equal(client.subscribeCalls.length, 0);
  assert.equal(client.endCalls, 1);
});

test('取消返回的 Promise 会等待浏览器临时连接物理清理完成', async () => {
  const client = new FakeMqttConnectionTestClient();
  const cleanup = createDeferred<void>();
  client.endPromise = cleanup.promise;
  const handle = startMqttConnectionTest(createRequest(), createDependencies(client));
  let cancelCompleted = false;

  const cancelPromise = handle.cancel().then(() => {
    cancelCompleted = true;
  });
  await Promise.resolve();

  assert.equal(client.endCalls, 1);
  assert.equal(cancelCompleted, false);
  cleanup.resolve();
  await cancelPromise;
  assert.equal(cancelCompleted, true);
  assert.equal((await handle.result).status, 'canceled');
});


test('浏览器临时连接清理同步触发 close 时只断开一次', async () => {
  const client = new FakeMqttConnectionTestClient();
  client.emitCloseOnFirstEnd = true;
  const handle = startMqttConnectionTest(createRequest(), createDependencies(client));

  client.emit('connect');
  client.subscribeCalls[0].callback(null);
  client.subscribeCalls[1].callback(null);
  const result = await handle.result;

  assert.equal(result.status, 'success');
  assert.equal(client.endCalls, 1);
});

test('subscribe 同步抛错会归入对应 Topic 失败', async () => {
  const client = new FakeMqttConnectionTestClient();
  client.subscribeError = new Error('subscribe crashed');
  const handle = startMqttConnectionTest(createRequest(), createDependencies(client));

  client.emit('connect');
  const result = await handle.result;

  assert.equal(result.status, 'error');
  assert.match(result.message, /factory\/a/);
  assert.match(result.message, /subscribe crashed/);
  assert.equal(client.endCalls, 1);
});

test('连接工厂同步抛错时返回结构化失败', async () => {
  const client = new FakeMqttConnectionTestClient();
  const handle = startMqttConnectionTest(createRequest(), {
    ...createDependencies(client),
    connect: () => { throw new Error('connect crashed'); },
  });

  const result = await handle.result;

  assert.equal(result.status, 'error');
  assert.match(result.message, /connect crashed/);
  assert.equal(client.endCalls, 0);
});

test('同步 SUBACK 失败后不再订阅后续 Topic', async () => {
  const client = new FakeMqttConnectionTestClient();
  client.subscribe = function subscribe(topic, options, callback): void {
    this.subscribeCalls.push({ topic, qos: options.qos, callback });
    callback(new Error('sync rejected'));
  };
  const handle = startMqttConnectionTest(createRequest(), createDependencies(client));

  client.emit('connect');
  const result = await handle.result;

  assert.equal(result.status, 'error');
  assert.equal(client.subscribeCalls.length, 1);
  assert.equal(client.subscribeCalls[0].topic, 'factory/a');
});

test('非法地址和空订阅不创建网络客户端', async () => {
  let connectCalls = 0;
  const client = new FakeMqttConnectionTestClient();
  const dependencies = {
    ...createDependencies(client),
    connect: () => {
      connectCalls += 1;
      return client;
    },
  };

  const invalidAddress = await startMqttConnectionTest({
    requestId: 'invalid-address',
    address: 'mqtt://broker.example:1883',
    subscriptions: [{ topic: 'factory/a', qos: 0 }],
  }, dependencies).result;
  const sensitiveAddress = await startMqttConnectionTest({
    requestId: 'sensitive-address',
    address: 'wss://broker.example/mqtt?token=secret',
    subscriptions: [{ topic: 'factory/a', qos: 0 }],
  }, dependencies).result;
  const emptySubscriptions = await startMqttConnectionTest({
    requestId: 'empty-subscriptions',
    address: 'ws://broker.example/mqtt',
    subscriptions: [{ topic: '   ', qos: 0 }],
  }, dependencies).result;

  assert.equal(invalidAddress.status, 'error');
  assert.match(invalidAddress.message, /ws:\/\/ 或 wss:\/\//);
  assert.equal(sensitiveAddress.status, 'error');
  assert.match(sensitiveAddress.message, /敏感查询参数/);
  assert.equal(emptySubscriptions.status, 'error');
  assert.match(emptySubscriptions.message, /至少需要一个/);
  assert.equal(connectCalls, 0);
});


test('Electron 取消返回的 Promise 会等待主进程确认清理', async () => {
  const cleanup = createDeferred<boolean>();
  const api: ElectronMqttConnectionTestApi = {
    mqttTestConnection: () => new Promise(() => undefined),
    mqttCancelConnectionTest: () => cleanup.promise,
  };
  const client = new FakeMqttConnectionTestClient();
  const handle = startMqttConnectionTest(createRequest(), {
    ...createDependencies(client),
    electronApi: api,
  });
  let cancelCompleted = false;

  const cancelPromise = handle.cancel().then(() => {
    cancelCompleted = true;
  });
  await Promise.resolve();

  assert.equal(cancelCompleted, false);
  cleanup.resolve(true);
  await cancelPromise;
  assert.equal(cancelCompleted, true);
  assert.equal((await handle.result).status, 'canceled');
});

test('Electron 测试调用取消窄 API 并忽略取消后的成功结果', async () => {
  let cancelCalls = 0;
  let resolveTest!: (value: Awaited<ReturnType<ElectronMqttConnectionTestApi['mqttTestConnection']>>) => void;
  const api: ElectronMqttConnectionTestApi = {
    mqttTestConnection: () => new Promise((resolve) => { resolveTest = resolve; }),
    mqttCancelConnectionTest: async () => {
      cancelCalls += 1;
      return true;
    },
  };
  const client = new FakeMqttConnectionTestClient();
  const handle = startMqttConnectionTest(createRequest(), {
    ...createDependencies(client),
    electronApi: api,
  });

  handle.cancel();
  resolveTest({ requestId: handle.requestId, status: 'success', message: 'late success', durationMs: 10 });
  const result = await handle.result;

  assert.equal(cancelCalls, 1);
  assert.equal(result.status, 'canceled');
  assert.equal(client.endCalls, 0);
});

function createRequest(): MqttConnectionTestRequest {
  return {
    requestId: 'test-request',
    address: 'ws://broker.example/mqtt',
    subscriptions: [
      { topic: 'factory/a', qos: 0 },
      { topic: 'factory/b', qos: 1 },
    ],
  };
}

type ControlledClock = ReturnType<typeof createControlledClock>;

function createDependencies(
  client: FakeMqttConnectionTestClient,
  clock: ControlledClock = createControlledClock(),
): MqttConnectionTestDependencies {
  return {
    connect: () => client,
    now: clock.now,
    randomUUID: () => 'uuid',
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    electronApi: null,
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

/** 创建可手动结算的 Promise，用于验证取消会等待物理连接清理。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

/** 控制定时器与耗时，避免单元测试真实等待 8 秒。 */
function createControlledClock() {
  let timeoutHandler: (() => void) | null = null;
  let currentTime = 100;
  return {
    now: () => currentTime,
    setTimeout: (handler: () => void) => {
      timeoutHandler = () => {
        currentTime += 8000;
        handler();
      };
      return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout: () => {
      timeoutHandler = null;
    },
    fireTimeout: () => {
      const handler = timeoutHandler;
      if (!handler) throw new Error('没有待触发的超时。');
      handler();
    },
  };
}
