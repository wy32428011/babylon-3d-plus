import mqtt, { type IClientOptions } from 'mqtt';

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
  on(event: 'connect', handler: () => void): unknown;
  on(event: 'error', handler: (error: Error) => void): unknown;
  on(event: 'close', handler: () => void): unknown;
  subscribe(
    topic: string,
    options: { qos: 0 | 1 | 2 },
    callback: (error?: Error | null) => void,
  ): void;
  endAsync(force?: boolean): Promise<void>;
};

export type ElectronMqttConnectionTestApi = {
  mqttTestConnection: (request: MqttConnectionTestRequest) => Promise<MqttConnectionTestResult>;
  mqttCancelConnectionTest: (request: { requestId: string }) => Promise<boolean>;
};

export type MqttConnectionTestTimeoutId = ReturnType<typeof globalThis.setTimeout>;

export type MqttConnectionTestDependencies = {
  connect: (address: string, options: IClientOptions) => MqttConnectionTestClient;
  now: () => number;
  randomUUID: () => string;
  setTimeout: (handler: () => void, timeoutMs: number) => MqttConnectionTestTimeoutId;
  clearTimeout: (timeoutId: MqttConnectionTestTimeoutId) => void;
  electronApi?: ElectronMqttConnectionTestApi | null;
};

export type MqttConnectionTestHandle = {
  requestId: string;
  result: Promise<MqttConnectionTestResult>;
  cancel: () => Promise<void>;
};

type NormalizedMqttConnectionTestRequest = {
  requestId: string;
  address: string;
  subscriptions: MqttConnectionTestSubscription[];
  timeoutMs: number;
};

/** 使用 Electron 窄 IPC 或浏览器临时客户端执行一次隔离的 MQTT 连接测试。 */
export function startMqttConnectionTest(
  request: MqttConnectionTestRequest,
  dependencies: MqttConnectionTestDependencies = createDefaultDependencies(),
): MqttConnectionTestHandle {
  const normalized = normalizeRequest(request);
  if ('error' in normalized) {
    return createImmediateErrorHandle(request.requestId, normalized.error, dependencies.now);
  }
  if (dependencies.electronApi) {
    return startElectronConnectionTest(normalized, dependencies.electronApi, dependencies.now);
  }
  return startBrowserConnectionTest(normalized, dependencies);
}

/** 归一化地址与订阅；测试连接只接受项目真实运行通道支持的安全 WebSocket 地址。 */
function normalizeRequest(
  request: MqttConnectionTestRequest,
): NormalizedMqttConnectionTestRequest | { error: string } {
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

  const sensitiveQueryKeys = new Set(['token', 'access_token', 'password', 'username']);
  for (const key of url.searchParams.keys()) {
    if (sensitiveQueryKeys.has(key.toLowerCase())) {
      return { error: 'MQTT 测试地址不能包含敏感查询参数。' };
    }
  }

  const subscriptions = request.subscriptions
    .map((subscription) => ({
      topic: subscription.topic.trim(),
      qos: subscription.qos === 1 || subscription.qos === 2 ? subscription.qos : 0,
    } satisfies MqttConnectionTestSubscription))
    .filter((subscription) => subscription.topic.length > 0);
  if (subscriptions.length === 0) return { error: '至少需要一个有效订阅 Topic。' };

  return {
    requestId: request.requestId,
    address,
    subscriptions,
    timeoutMs: Math.max(1, request.timeoutMs ?? 8000),
  };
}

/** 浏览器环境创建一次性 mqtt.js 客户端，所有结算路径都确保只清理一次。 */
function startBrowserConnectionTest(
  request: NormalizedMqttConnectionTestRequest,
  dependencies: MqttConnectionTestDependencies,
): MqttConnectionTestHandle {
  const startedAt = dependencies.now();
  let client: MqttConnectionTestClient;
  try {
    client = dependencies.connect(request.address, {
      clean: true,
      clientId: 'babylon-editor-connection-test-' + dependencies.randomUUID(),
      connectTimeout: request.timeoutMs,
      reconnectPeriod: 0,
    });
  } catch (error) {
    return createImmediateErrorHandle(
      request.requestId,
      'MQTT 连接失败：' + getErrorMessage(error),
      dependencies.now,
    );
  }
  let settled = false;
  let subscribing = false;
  let finishPromise: Promise<void> | null = null;
  let resolveResult!: (result: MqttConnectionTestResult) => void;
  const result = new Promise<MqttConnectionTestResult>((resolve) => {
    resolveResult = resolve;
  });

  /** 先失效全部延迟事件，再清理物理连接；重复取消会等待同一次物理清理。 */
  const finish = (
    status: MqttConnectionTestResult['status'],
    message: string,
  ): Promise<void> => {
    if (finishPromise) return finishPromise;
    settled = true;
    dependencies.clearTimeout(timeoutId);

    let resolveFinish!: () => void;
    finishPromise = new Promise<void>((resolve) => {
      resolveFinish = resolve;
    });

    void (async () => {
      let finalStatus = status;
      let finalMessage = message;
      try {
        await client.endAsync(true);
      } catch (error) {
        const cleanupMessage = '清理临时连接失败：' + getErrorMessage(error);
        finalStatus = status === 'canceled' ? 'canceled' : 'error';
        finalMessage = status === 'canceled' ? message : `${message}；${cleanupMessage}`;
      }

      resolveResult({
        requestId: request.requestId,
        status: finalStatus,
        message: finalMessage,
        durationMs: Math.max(0, dependencies.now() - startedAt),
      });
      resolveFinish();
    })();
    return finishPromise;
  };

  const timeoutId = dependencies.setTimeout(() => {
    void finish('error', `连接测试超时（${formatTimeout(request.timeoutMs)}）。`);
  }, request.timeoutMs);

  client.on('connect', () => {
    if (settled || subscribing) return;
    subscribing = true;
    let completedCount = 0;

    for (const subscription of request.subscriptions) {
      let subscriptionSettled = false;
      const completeSubscription = (error?: Error | null): void => {
        if (settled || subscriptionSettled) return;
        subscriptionSettled = true;
        if (error) {
          void finish('error', `订阅 ${subscription.topic} 失败：${getErrorMessage(error)}`);
          return;
        }

        completedCount += 1;
        if (completedCount === request.subscriptions.length) {
          void finish('success', `连接成功，已确认 ${request.subscriptions.length} 个 Topic。`);
        }
      };

      try {
        client.subscribe(subscription.topic, { qos: subscription.qos }, completeSubscription);
      } catch (error) {
        completeSubscription(error instanceof Error ? error : new Error(String(error)));
      }
      if (settled) break;
    }
  });

  client.on('error', (error) => {
    void finish('error', 'MQTT 连接失败：' + getErrorMessage(error));
  });

  client.on('close', () => {
    void finish('error', 'MQTT 连接在测试完成前已关闭。');
  });

  return {
    requestId: request.requestId,
    result,
    cancel: () => finish('canceled', '连接测试已取消。'),
  };
}

/** Electron 环境调用主进程独立测试通道；本地取消立即结算并忽略晚到 IPC 结果。 */
function startElectronConnectionTest(
  request: NormalizedMqttConnectionTestRequest,
  api: ElectronMqttConnectionTestApi,
  now: () => number,
): MqttConnectionTestHandle {
  const startedAt = now();
  let settled = false;
  let cancelPromise: Promise<void> | null = null;
  let resolveResult!: (result: MqttConnectionTestResult) => void;
  const result = new Promise<MqttConnectionTestResult>((resolve) => {
    resolveResult = resolve;
  });

  void api.mqttTestConnection(request).then(
    (testResult) => {
      if (settled) return;
      settled = true;
      resolveResult(testResult);
    },
    (error: unknown) => {
      if (settled) return;
      settled = true;
      resolveResult({
        requestId: request.requestId,
        status: 'error',
        message: 'Electron MQTT 测试失败：' + getErrorMessage(error),
        durationMs: Math.max(0, now() - startedAt),
      });
    },
  );

  return {
    requestId: request.requestId,
    result,
    cancel: () => {
      if (cancelPromise) return cancelPromise;
      if (settled) return Promise.resolve();
      settled = true;
      resolveResult({
        requestId: request.requestId,
        status: 'canceled',
        message: '连接测试已取消。',
        durationMs: Math.max(0, now() - startedAt),
      });
      cancelPromise = api.mqttCancelConnectionTest({ requestId: request.requestId }).then(
        () => undefined,
        () => undefined,
      );
      return cancelPromise;
    },
  };
}

/** 为输入校验失败创建无需建立网络连接的立即结果。 */
function createImmediateErrorHandle(
  requestId: string,
  message: string,
  now: () => number,
): MqttConnectionTestHandle {
  const startedAt = now();
  return {
    requestId,
    result: Promise.resolve({
      requestId,
      status: 'error',
      message,
      durationMs: Math.max(0, now() - startedAt),
    }),
    cancel: () => Promise.resolve(),
  };
}

/** 创建默认依赖，同时避免 Node 单元测试访问不存在的 window。 */
function createDefaultDependencies(): MqttConnectionTestDependencies {
  return {
    connect: (address, options) => mqtt.connect(address, options),
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
    clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId),
    electronApi: readElectronConnectionTestApi(),
  };
}

/** 以结构化窄接口读取 preload 能力，不让本模块依赖全局声明更新顺序。 */
function readElectronConnectionTestApi(): ElectronMqttConnectionTestApi | null {
  if (typeof window === 'undefined') return null;
  const editorApi = (window as unknown as { editorApi?: Partial<ElectronMqttConnectionTestApi> }).editorApi;
  if (!editorApi?.mqttTestConnection || !editorApi.mqttCancelConnectionTest) return null;
  return {
    mqttTestConnection: editorApi.mqttTestConnection.bind(editorApi),
    mqttCancelConnectionTest: editorApi.mqttCancelConnectionTest.bind(editorApi),
  };
}

/** 把默认 8 秒等整秒超时转为更易读的状态消息。 */
function formatTimeout(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} 秒` : `${timeoutMs} 毫秒`;
}

/** 将未知异常转换为可展示的简短消息。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
