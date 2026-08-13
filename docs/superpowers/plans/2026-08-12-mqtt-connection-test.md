# MQTT 配置弹窗测试连接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在数字孪生编辑器 MQTT 配置弹窗中增加隔离的临时连接测试，只有 Broker 会话和全部 Topic SUBACK 成功后才显示连接成功。

**Architecture:** renderer 新增独立的 MQTT 连接测试服务，根据环境选择 Electron 窄 IPC 或浏览器 `mqtt.js` 临时客户端；Electron 主进程用独立测试任务映射管理一次性连接，绝不复用正式运行客户端。Toolbar 只持有弹窗会话级测试状态，配置变化或弹窗关闭时取消当前请求，测试结果不写入正式 MQTT 状态和遥测仓库。

**Tech Stack:** React 19、TypeScript 6、mqtt.js 5、Electron 42 IPC、Node.js test runner、Vite 8。

---

## 文件结构

- Create: `src/runtime/mqtt/MqttConnectionTest.ts`
  - renderer 侧连接测试请求/结果/句柄类型、输入校验、浏览器临时客户端、Electron API 调度和取消。
- Create: `tests/telemetry/mqttConnectionTest.test.ts`
  - 使用可控假客户端验证连接、SUBACK、错误、超时、取消、Electron 调度和正式状态隔离。
- Modify: `electron/types.ts`
  - 增加连接测试 request/result/cancel 类型。
- Modify: `electron/ipc/mqttIpc.ts`
  - 注册测试和取消 IPC，管理独立临时测试任务并完成资源清理。
- Modify: `electron/preload.ts`
  - 暴露 `mqttTestConnection`、`mqttCancelConnectionTest` 窄 API。
- Modify: `electron/preload.cts`
  - 与 TypeScript preload 保持完全一致。
- Modify: `src/vite-env.d.ts`
  - 声明 renderer 可见的连接测试契约。
- Modify: `scripts/electron-mqtt-test.mjs`
  - 回归 Electron IPC、preload、安全校验、SUBACK、取消和正式客户端隔离。
- Modify: `src/editor/ui/Toolbar.tsx`
  - 接入测试服务、维护弹窗状态、取消旧请求并渲染按钮和状态。
- Modify: `src/styles/global.css`
  - 增加测试按钮区域及 idle/testing/success/error 样式。
- Create: `tests/telemetry/mqttConnectionTestUiContract.test.ts`
  - 校验 Toolbar 状态语义、可访问性、取消入口和 CSS 状态类存在。
- Modify: `README.md`
  - 记录用户可见的 MQTT 测试连接能力和成功判定。

### Task 1: Renderer MQTT 连接测试服务

**Files:**
- Create: `src/runtime/mqtt/MqttConnectionTest.ts`
- Create: `tests/telemetry/mqttConnectionTest.test.ts`

- [ ] **Step 1: 编写输入校验和成功订阅的失败测试**

```ts
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  startMqttConnectionTest,
  type MqttConnectionTestClient,
  type MqttConnectionTestDependencies,
} from '../../src/runtime/mqtt/MqttConnectionTest';
import { mqttRuntimeStatusStore } from '../../src/runtime/mqtt/mqttRuntimeStatus';

class FakeClient extends EventEmitter implements MqttConnectionTestClient {
  readonly subscribeCalls: Array<{ topic: string; qos: 0 | 1 | 2; callback: (error?: Error | null) => void }> = [];
  endCalls = 0;

  subscribe(topic: string, options: { qos: 0 | 1 | 2 }, callback: (error?: Error | null) => void): void {
    this.subscribeCalls.push({ topic, qos: options.qos, callback });
  }

  async endAsync(): Promise<void> {
    this.endCalls += 1;
  }
}

test('全部 Topic 收到成功 SUBACK 后返回成功并断开临时客户端', async () => {
  const client = new FakeClient();
  const dependencies = createDependencies(client);
  mqttRuntimeStatusStore.update('disabled');

  const handle = startMqttConnectionTest({
    requestId: 'test-success',
    address: 'ws://broker.example/mqtt',
    subscriptions: [
      { topic: 'factory/a', qos: 0 },
      { topic: 'factory/b', qos: 1 },
    ],
  }, dependencies);

  client.emit('connect');
  client.subscribeCalls[0].callback(null);
  client.subscribeCalls[1].callback(null);
  const result = await handle.result;

  assert.equal(result.status, 'success');
  assert.match(result.message, /2 个 Topic/);
  assert.equal(client.endCalls, 1);
  assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'disabled');
});

function createDependencies(client: FakeClient): MqttConnectionTestDependencies {
  return {
    connect: () => client,
    now: () => 100,
    randomUUID: () => 'uuid',
    setTimeout: (handler) => setTimeout(handler, 1000),
    clearTimeout,
  };
}
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
npm run test:telemetry
```

Expected: FAIL，提示无法找到 `src/runtime/mqtt/MqttConnectionTest.ts` 或导出不存在。

- [ ] **Step 3: 实现最小请求、结果、校验和成功路径**

```ts
import mqtt from 'mqtt';

export type MqttConnectionTestSubscription = {
  topic: string;
  qos: 0 | 1 | 2;
};

export type MqttConnectionTestRequest = {
  requestId: string;
  address: string;
  subscriptions: MqttConnectionTestSubscription[];
  timeoutMs?: number;
};

export type MqttConnectionTestResult = {
  requestId: string;
  status: 'success' | 'error' | 'canceled';
  message: string;
  durationMs: number;
};

export type MqttConnectionTestClient = {
  on(event: 'connect' | 'error' | 'close', handler: (...args: any[]) => void): unknown;
  subscribe(topic: string, options: { qos: 0 | 1 | 2 }, callback: (error?: Error | null) => void): void;
  endAsync(force?: boolean): Promise<void>;
};

export type MqttConnectionTestDependencies = {
  connect: (address: string, options: Record<string, unknown>) => MqttConnectionTestClient;
  now: () => number;
  randomUUID: () => string;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  electronApi?: ElectronMqttConnectionTestApi | null;
};

export type MqttConnectionTestHandle = {
  requestId: string;
  result: Promise<MqttConnectionTestResult>;
  cancel: () => void;
};

export function startMqttConnectionTest(
  request: MqttConnectionTestRequest,
  dependencies: MqttConnectionTestDependencies = createDefaultDependencies(),
): MqttConnectionTestHandle {
  const normalized = normalizeRequest(request);
  if ('error' in normalized) return createImmediateHandle(request.requestId, normalized.error, dependencies.now);
  if (dependencies.electronApi) return startElectronConnectionTest(normalized, dependencies);
  return startBrowserConnectionTest(normalized, dependencies);
}
```

实现 `normalizeRequest` 时必须：

```ts
function normalizeRequest(request: MqttConnectionTestRequest): NormalizedRequest | { error: string } {
  const address = request.address.trim();
  if (!address) return { error: '请填写 MQTT Broker 地址。' };

  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { error: 'MQTT Broker 地址格式不正确。' };
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { error: 'MQTT 地址仅支持 ws:// 或 wss://。' };
  }
  if (url.username || url.password) {
    return { error: 'MQTT 测试地址不能包含账号或密码。' };
  }
  const sensitiveKeys = new Set(['token', 'access_token', 'password', 'username']);
  if (Array.from(url.searchParams.keys()).some((key) => sensitiveKeys.has(key.toLowerCase()))) {
    return { error: 'MQTT 测试地址不能包含敏感查询参数。' };
  }

  const subscriptions = request.subscriptions
    .map((item) => ({ topic: item.topic.trim(), qos: item.qos === 1 || item.qos === 2 ? item.qos : 0 as const }))
    .filter((item) => item.topic.length > 0);
  if (subscriptions.length === 0) return { error: '至少需要一个有效订阅 Topic。' };

  return {
    requestId: request.requestId,
    address,
    subscriptions,
    timeoutMs: Math.max(1, request.timeoutMs ?? 8000),
  };
}
```

浏览器成功路径必须使用：

```ts
const client = dependencies.connect(request.address, {
  clean: true,
  clientId: 'babylon-editor-connection-test-' + dependencies.randomUUID(),
  connectTimeout: request.timeoutMs,
  reconnectPeriod: 0,
});
```

连接后逐条 `subscribe`，全部回调无错误才完成成功结果；完成前将 settled 标志设为 true、清理超时并 `await client.endAsync(true)`，保证事件延迟到达时不能二次结算。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run:

```powershell
npm run test:telemetry
```

Expected: 新增成功路径测试 PASS，原 telemetry 测试保持通过。

- [ ] **Step 5: 编写失败、超时和取消的失败测试**

新增测试：

```ts
test('任一 SUBACK 失败时返回具体 Topic 错误并断开', async () => {
  const client = new FakeClient();
  const handle = startMqttConnectionTest(createRequest(), createDependencies(client));
  client.emit('connect');
  client.subscribeCalls[0].callback(new Error('not authorized'));
  const result = await handle.result;
  assert.equal(result.status, 'error');
  assert.match(result.message, /factory\/a/);
  assert.match(result.message, /not authorized/);
  assert.equal(client.endCalls, 1);
});

test('超时会返回失败并断开', async () => {
  const client = new FakeClient();
  let timeoutHandler: (() => void) | null = null;
  const dependencies = {
    ...createDependencies(client),
    setTimeout: (handler: () => void) => { timeoutHandler = handler; return 1 as any; },
    clearTimeout: () => undefined,
  };
  const handle = startMqttConnectionTest(createRequest(), dependencies);
  timeoutHandler?.();
  const result = await handle.result;
  assert.equal(result.status, 'error');
  assert.match(result.message, /8 秒/);
  assert.equal(client.endCalls, 1);
});

test('取消测试会返回 canceled 且延迟事件不能覆盖结果', async () => {
  const client = new FakeClient();
  const handle = startMqttConnectionTest(createRequest(), createDependencies(client));
  handle.cancel();
  client.emit('connect');
  const result = await handle.result;
  assert.equal(result.status, 'canceled');
  assert.equal(client.subscribeCalls.length, 0);
  assert.equal(client.endCalls, 1);
});
```

同时覆盖地址为空、非法协议、敏感 query、连接 `error` 和连接前 `close`。

- [ ] **Step 6: 运行测试确认 RED**

Run: `npm run test:telemetry`

Expected: FAIL，失败点分别是尚未实现 error/close/timeout/cancel 结算。

- [ ] **Step 7: 实现错误、超时、取消和 Electron 调度**

实现统一 `finish`：

```ts
const finish = async (status: MqttConnectionTestResult['status'], message: string): Promise<void> => {
  if (settled) return;
  settled = true;
  dependencies.clearTimeout(timeoutId);
  try {
    await client.endAsync(true);
    resolve({ requestId: request.requestId, status, message, durationMs: dependencies.now() - startedAt });
  } catch (error) {
    resolve({
      requestId: request.requestId,
      status: status === 'canceled' ? 'canceled' : 'error',
      message: 'MQTT 测试连接清理失败：' + getErrorMessage(error),
      durationMs: dependencies.now() - startedAt,
    });
  }
};
```

Electron 分支只调用窄 API，并在 `cancel()` 时调用取消接口：

```ts
function startElectronConnectionTest(request: NormalizedRequest, dependencies: MqttConnectionTestDependencies): MqttConnectionTestHandle {
  const api = dependencies.electronApi!;
  let canceled = false;
  return {
    requestId: request.requestId,
    result: api.mqttTestConnection(request).then((result) => canceled
      ? { ...result, status: 'canceled', message: '连接测试已取消。' }
      : result),
    cancel: () => {
      if (canceled) return;
      canceled = true;
      void api.mqttCancelConnectionTest({ requestId: request.requestId });
    },
  };
}
```

默认依赖通过 `window.editorApi?.mqttTestConnection` 和 `mqttCancelConnectionTest` 判断 Electron 能力，否则使用 `mqtt.connect`。

- [ ] **Step 8: 运行完整 renderer 测试并提交**

Run:

```powershell
npm run test:telemetry
```

Expected: PASS，无新增 warning/error。

Commit:

```powershell
git add src/runtime/mqtt/MqttConnectionTest.ts tests/telemetry/mqttConnectionTest.test.ts
git commit -m "feat: add isolated MQTT connection tester"
```

### Task 2: Electron 独立测试 IPC

**Files:**
- Modify: `electron/types.ts`
- Modify: `electron/ipc/mqttIpc.ts`
- Modify: `scripts/electron-mqtt-test.mjs`

- [ ] **Step 1: 先扩展 Electron 回归测试**

在 `scripts/electron-mqtt-test.mjs` 增加源码契约断言：

```js
test('Electron MQTT 提供独立测试连接 IPC 且不复用正式客户端映射', () => {
  assert.match(mqttIpcSource, /mqtt:testConnection/);
  assert.match(mqttIpcSource, /mqtt:cancelConnectionTest/);
  assert.match(mqttIpcSource, /connectionTestsByKey/);
  assert.match(mqttIpcSource, /reconnectPeriod:\s*0/);
  assert.match(mqttIpcSource, /connectTimeout:\s*8000/);
});
```

将 harness 暴露内容扩展为：

```js
Object.assign(globalThis.__mqttIpcHarness, {
  handleConfigure,
  handleDisconnect,
  handleTestConnection,
  handleCancelConnectionTest,
  clientsByWebContentsId,
  connectionTestsByKey,
});
```

新增行为测试：

```js
test('临时测试全部 SUBACK 成功后返回成功、断开且不写正式客户端映射', async () => {
  const harness = createMqttIpcHarness({ autoConnect: false });
  const sender = createFakeWebContents(30);
  const promise = harness.handleTestConnection(
    { sender },
    createTestRequest('req-1', 'ws://broker.example/mqtt', ['factory/a', 'factory/b']),
  );
  const client = harness.connectCalls[0].client;
  client.emit('connect');
  client.completeSubscription('factory/a', null);
  client.completeSubscription('factory/b', null);
  const result = await promise;

  assert.equal(result.status, 'success');
  assert.equal(client.endCalls, 1);
  assert.equal(harness.clientsByWebContentsId.has(sender.id), false);
  assert.equal(harness.connectionTestsByKey.size, 0);
});
```

再增加订阅失败、取消和超时测试。

- [ ] **Step 2: 运行 Electron 测试确认 RED**

Run:

```powershell
node --test scripts/electron-mqtt-test.mjs
```

Expected: FAIL，缺少测试 IPC 类型、handler 和任务映射。

- [ ] **Step 3: 增加 Electron 契约类型**

在 `electron/types.ts` 增加：

```ts
export type MqttConnectionTestRequest = {
  requestId: string;
  address: string;
  subscriptions: MqttIpcSubscriptionConfig[];
  timeoutMs?: number;
};

export type MqttConnectionTestCancelRequest = {
  requestId: string;
};

export type MqttConnectionTestResult = {
  requestId: string;
  status: 'success' | 'error' | 'canceled';
  message: string;
  durationMs: number;
};
```

- [ ] **Step 4: 注册独立测试 IPC 和任务映射**

在 `electron/ipc/mqttIpc.ts` 增加：

```ts
type MqttConnectionTestTask = {
  key: string;
  requestId: string;
  webContentsId: number;
  client: MqttClient;
  timeout: NodeJS.Timeout;
  settled: boolean;
  startedAt: number;
  resolve: (result: MqttConnectionTestResult) => void;
};

const connectionTestsByKey = new Map<string, MqttConnectionTestTask>();
```

注册：

```ts
ipcMain.handle('mqtt:testConnection', handleTestConnection);
ipcMain.handle('mqtt:cancelConnectionTest', handleCancelConnectionTest);
```

`handleTestConnection` 必须：

1. 用现有 `normalizeSubscription`、`isSafeMqttAddress` 归一化输入；
2. 地址或订阅非法时直接返回结构化 error；
3. 创建 `reconnectPeriod: 0`、`connectTimeout: 8000` 的临时客户端；
4. `connect` 后逐条订阅，全部 SUBACK 成功才 success；
5. 任一订阅失败、`error`、提前 `close` 或 timeout 时 error；
6. 所有路径通过同一个异步 `finishConnectionTest` 清理 timer、map 和 `endAsync(true)`；
7. 不调用 `setStatus`、`sendEvent`，不写 `clientsByWebContentsId`。

取消 handler：

```ts
async function handleCancelConnectionTest(
  event: IpcMainInvokeEvent,
  request: MqttConnectionTestCancelRequest,
): Promise<boolean> {
  const task = connectionTestsByKey.get(createConnectionTestKey(event.sender.id, request.requestId));
  if (!task) return false;
  await finishConnectionTest(task, 'canceled', '连接测试已取消。');
  return true;
}
```

- [ ] **Step 5: 补齐窗口销毁和应用退出清理**

在 renderer `destroyed` 事件和 `disposeAllMqttIpcClients()` 中调用：

```ts
function cancelConnectionTestsForWebContents(webContentsId: number): void {
  for (const task of connectionTestsByKey.values()) {
    if (task.webContentsId === webContentsId) {
      void finishConnectionTest(task, 'canceled', '连接测试已取消。');
    }
  }
}
```

应用退出时遍历全部测试任务并结算 canceled，随后清空映射。

- [ ] **Step 6: 运行 Electron 测试和构建并提交**

Run:

```powershell
node --test scripts/electron-mqtt-test.mjs
npm run build:electron
```

Expected: 两条命令均 exit 0。

Commit:

```powershell
git add electron/types.ts electron/ipc/mqttIpc.ts scripts/electron-mqtt-test.mjs
git commit -m "feat: add Electron MQTT connection test IPC"
```

### Task 3: Preload 和 renderer 类型契约

**Files:**
- Modify: `electron/preload.ts`
- Modify: `electron/preload.cts`
- Modify: `src/vite-env.d.ts`
- Modify: `scripts/electron-mqtt-test.mjs`

- [ ] **Step 1: 编写 preload 契约失败测试**

扩展现有 preload 测试：

```js
test('preload 只暴露 MQTT 测试连接和取消窄 API', () => {
  for (const source of [preloadSource, preloadCtsSource]) {
    assert.match(source, /mqttTestConnection/);
    assert.match(source, /mqttCancelConnectionTest/);
    assert.match(source, /mqtt:testConnection/);
    assert.match(source, /mqtt:cancelConnectionTest/);
  }
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test scripts/electron-mqtt-test.mjs`

Expected: FAIL，preload 尚未暴露测试 API。

- [ ] **Step 3: 同步修改两个 preload**

两个文件都导入新增类型，并在 `editorApi` 中增加：

```ts
mqttTestConnection: (request: MqttConnectionTestRequest): Promise<MqttConnectionTestResult> =>
  ipcRenderer.invoke('mqtt:testConnection', request),
mqttCancelConnectionTest: (request: MqttConnectionTestCancelRequest): Promise<boolean> =>
  ipcRenderer.invoke('mqtt:cancelConnectionTest', request),
```

- [ ] **Step 4: 更新 `src/vite-env.d.ts`**

增加与 Electron 完全一致的三个类型，并在 `Window.editorApi` 中增加可选方法：

```ts
mqttTestConnection?: (request: MqttConnectionTestRequest) => Promise<MqttConnectionTestResult>;
mqttCancelConnectionTest?: (request: MqttConnectionTestCancelRequest) => Promise<boolean>;
```

- [ ] **Step 5: 运行测试、类型检查并提交**

Run:

```powershell
node --test scripts/electron-mqtt-test.mjs
npm run typecheck
```

Expected: PASS。

Commit:

```powershell
git add electron/preload.ts electron/preload.cts src/vite-env.d.ts scripts/electron-mqtt-test.mjs
git commit -m "feat: expose MQTT connection test preload API"
```

### Task 4: MQTT 弹窗状态和测试按钮

**Files:**
- Modify: `src/editor/ui/Toolbar.tsx`
- Modify: `src/styles/global.css`
- Create: `tests/telemetry/mqttConnectionTestUiContract.test.ts`

- [ ] **Step 1: 编写 UI 契约失败测试**

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const toolbarSource = readFileSync(new URL('../../src/editor/ui/Toolbar.tsx', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../../src/styles/global.css', import.meta.url), 'utf8');

test('MQTT 弹窗提供可访问的测试按钮和四态结果', () => {
  assert.match(toolbarSource, /aria-label="测试 MQTT 连接"/);
  assert.match(toolbarSource, /aria-live="polite"/);
  assert.match(toolbarSource, /连接测试中/);
  assert.match(toolbarSource, /连接成功/);
  assert.match(toolbarSource, /连接失败/);
  assert.match(toolbarSource, /startMqttConnectionTest/);
});

test('MQTT 弹窗关闭和连接字段变化会取消旧测试', () => {
  assert.match(toolbarSource, /mqttConnectionTestHandleRef\.current\?\.cancel\(\)/);
  assert.match(toolbarSource, /resetMqttConnectionTest/);
});

test('MQTT 测试状态包含 idle testing success error 样式', () => {
  for (const state of ['idle', 'testing', 'success', 'error']) {
    assert.match(cssSource, new RegExp('mqtt-connection-test-status-' + state));
  }
});
```

- [ ] **Step 2: 运行 telemetry 测试确认 RED**

Run: `npm run test:telemetry`

Expected: FAIL，Toolbar 尚无测试按钮和状态样式。

- [ ] **Step 3: 在 Toolbar 中维护弹窗测试状态**

导入：

```ts
import {
  startMqttConnectionTest,
  type MqttConnectionTestHandle,
  type MqttConnectionTestResult,
} from '../../runtime/mqtt/MqttConnectionTest';
import { resolveMqttStackerSubscriptions } from '../../runtime/mqtt/MqttStackerTelemetryConfig';
```

增加状态：

```ts
type MqttConnectionTestViewState = {
  state: 'idle' | 'testing' | 'success' | 'error';
  message: string;
};

const MQTT_CONNECTION_TEST_IDLE: MqttConnectionTestViewState = {
  state: 'idle',
  message: '未测试',
};

const [mqttConnectionTestState, setMqttConnectionTestState] = useState(MQTT_CONNECTION_TEST_IDLE);
const mqttConnectionTestHandleRef = useRef<MqttConnectionTestHandle | null>(null);
```

将 React import 增加 `useRef`。

实现取消和测试：

```ts
function resetMqttConnectionTest(): void {
  mqttConnectionTestHandleRef.current?.cancel();
  mqttConnectionTestHandleRef.current = null;
  setMqttConnectionTestState(MQTT_CONNECTION_TEST_IDLE);
}

function handleTestMqttConnection(): void {
  resetMqttConnectionTest();
  const config = sanitizeMqttConfig(mqttDraft);
  const handle = startMqttConnectionTest({
    requestId: crypto.randomUUID(),
    address: config.address,
    subscriptions: resolveMqttStackerSubscriptions(config).map(({ topic, qos }) => ({ topic, qos })),
  });
  mqttConnectionTestHandleRef.current = handle;
  setMqttConnectionTestState({ state: 'testing', message: '连接测试中…' });

  void handle.result.then((result: MqttConnectionTestResult) => {
    if (mqttConnectionTestHandleRef.current !== handle) return;
    mqttConnectionTestHandleRef.current = null;
    if (result.status === 'success') {
      setMqttConnectionTestState({ state: 'success', message: result.message });
    } else if (result.status === 'error') {
      setMqttConnectionTestState({ state: 'error', message: `连接失败：${result.message}` });
    }
  });
}
```

弹窗打开时、组件卸载时、关闭时调用取消；IP、地址、Legacy Topic、订阅增删、Topic 和 QoS 变化前调用 `resetMqttConnectionTest()`。适配器和 payload 预览变化不触发重置。

- [ ] **Step 4: 渲染状态和按钮**

用测试状态替换弹窗顶部原本无帮助的编辑态运行状态：

```tsx
<p
  aria-live="polite"
  className={`mqtt-connection-test-status mqtt-connection-test-status-${mqttConnectionTestState.state}`}
  role="status"
>
  当前连接状态：{mqttConnectionTestState.message}
</p>
```

在 Legacy Topic 后增加：

```tsx
<div className="mqtt-connection-test-actions">
  <button
    aria-label="测试 MQTT 连接"
    disabled={mqttConnectionTestState.state === 'testing'}
    onClick={handleTestMqttConnection}
    type="button"
  >
    {mqttConnectionTestState.state === 'testing' ? '测试中…' : '测试连接'}
  </button>
</div>
```

Esc、遮罩点击、取消按钮和保存成功都通过本地关闭函数先取消测试，再调用 `props.onCloseMqttConfig()`。

- [ ] **Step 5: 添加状态样式**

```css
.mqtt-connection-test-actions {
  display: flex;
  justify-content: flex-end;
}

.mqtt-connection-test-status {
  margin: 0;
  padding: 7px 9px;
  border: 1px solid #555;
  border-radius: 3px;
  font-size: 12px;
  background: #202020;
}

.mqtt-connection-test-status-idle,
.mqtt-connection-test-status-testing {
  border-color: #42545a;
  color: #b8e8ee;
  background: #1d3034;
}

.mqtt-connection-test-status-success {
  border-color: #3f6f52;
  color: #b8f2c9;
  background: #20352a;
}

.mqtt-connection-test-status-error {
  border-color: #754545;
  color: #ffb0b0;
  background: #3b2323;
}
```

为测试按钮沿用 Toolbar 弹窗按钮尺寸和 hover/disabled 规则，不新增图片或依赖。

- [ ] **Step 6: 运行 UI 契约和类型检查并提交**

Run:

```powershell
npm run test:telemetry
npm run typecheck
```

Expected: PASS。

Commit:

```powershell
git add src/editor/ui/Toolbar.tsx src/styles/global.css tests/telemetry/mqttConnectionTestUiContract.test.ts
git commit -m "feat: add MQTT connection test controls"
```

### Task 5: 用户文档和最终验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新用户可见功能说明**

在 README 的 MQTT 更新记录附近增加：

```md
- 2026-08-12：MQTT 配置弹窗新增“测试连接”；测试直接使用未保存草稿建立隔离的临时连接，只有 Broker 会话和全部订阅 Topic SUBACK 成功后才显示成功。测试完成、失败、超时、配置变化或关闭弹窗时会清理临时连接，不保存配置、不启动运行预览，也不写入遥测状态。
```

- [ ] **Step 2: 执行针对性测试**

Run:

```powershell
npm run test:telemetry
node --test scripts/electron-mqtt-test.mjs
```

Expected: 全部测试 PASS，0 failures。

- [ ] **Step 3: 执行静态检查和构建**

Run:

```powershell
npm run typecheck
npm run build
```

Expected: 两条命令 exit 0，无 TypeScript 或 Vite/Electron 构建错误。

- [ ] **Step 4: 检查差异和安全边界**

Run:

```powershell
git diff --check
git status --short
git diff --stat HEAD~4..HEAD
git diff HEAD~4..HEAD -- src/runtime/mqtt/MqttConnectionTest.ts electron/ipc/mqttIpc.ts src/editor/ui/Toolbar.tsx
```

确认：

- 测试代码不调用 `mqttRuntimeStatusStore.update`；
- 测试代码不引用 `deviceTelemetryStore`；
- Electron 测试任务不写 `clientsByWebContentsId`；
- 所有成功、失败、取消和超时路径都调用清理；
- 未包含凭据、Token、调试日志或临时文件；
- 未覆盖任务开始前的用户改动。

- [ ] **Step 5: 代码审查后提交文档**

按 `code-reviewer` 检查修改文件；若无 HIGH/CRITICAL 问题，再提交 README：

```powershell
git add README.md
git commit -m "docs: document MQTT connection testing"
```

- [ ] **Step 6: 最终新鲜验证**

在最终回复前重新运行：

```powershell
npm run test:telemetry
node --test scripts/electron-mqtt-test.mjs
npm run typecheck
npm run build:electron
```

只有四条命令均 exit 0 时才声明完成；如果无法运行某项，明确列出未验证内容和风险。
