import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import mqtt, { type IClientSubscribeOptions, type MqttClient } from 'mqtt';
import type { MqttIpcConfigureRequest, MqttIpcEvent, MqttIpcStatus, MqttIpcSubscriptionConfig } from '../types.js';

type MqttRendererClient = {
  webContents: WebContents;
  generation: number;
  client: MqttClient | null;
  status: MqttIpcStatus;
  subscriptions: MqttIpcSubscriptionConfig[];
};

type MqttDisconnectResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

const clientsByWebContentsId = new Map<number, MqttRendererClient>();
let registered = false;

/** 注册受控 MQTT IPC 通道；多次调用只会注册一次，避免热重载或测试重复绑定。 */
export function registerMqttIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('mqtt:configure', handleConfigure);
  ipcMain.handle('mqtt:disconnect', handleDisconnect);
  ipcMain.handle('mqtt:getStatus', handleGetStatus);
}

/** 清理所有 renderer 对应的 MQTT 客户端，供 app will-quit 生命周期调用。 */
export function disposeAllMqttIpcClients(): void {
  void Promise.allSettled(
    Array.from(clientsByWebContentsId.values(), (rendererClient) =>
      disconnectRendererClient(rendererClient, '应用退出，MQTT 连接已关闭。'),
    ),
  );
  clientsByWebContentsId.clear();
}

/** 处理 renderer 配置请求，仅接受地址和订阅等非敏感字段。 */
async function handleConfigure(event: IpcMainInvokeEvent, request: MqttIpcConfigureRequest): Promise<MqttIpcStatus> {
  const rendererClient = getRendererClient(event.sender);
  const generation = rendererClient.generation + 1;
  const previousStatus = rendererClient.status;
  const previousSubscriptions = rendererClient.subscriptions;
  rendererClient.generation = generation;
  const disconnectResult = await disconnectRendererClient(rendererClient, 'MQTT 配置已切换，旧连接已关闭。');
  if (rendererClient.generation !== generation) return rendererClient.status;

  if (!disconnectResult.ok) {
    setStatus(rendererClient, {
      state: 'error',
      address: previousStatus.address,
      subscriptions: previousSubscriptions,
      lastError: disconnectResult.errorMessage,
    });
  }

  const normalizedConfig = normalizeConfigureRequest(request);
  rendererClient.subscriptions = normalizedConfig.subscriptions;

  if (!normalizedConfig.enabled) {
    return setStatus(rendererClient, { state: 'disabled', subscriptions: normalizedConfig.subscriptions });
  }

  if (!normalizedConfig.address || normalizedConfig.subscriptions.length === 0) {
    sendLog(rendererClient, 'MQTT 未连接：地址或 Topic 为空。');
    return setStatus(rendererClient, { state: 'disconnected', address: normalizedConfig.address, subscriptions: normalizedConfig.subscriptions });
  }

  if (!isSafeMqttAddress(normalizedConfig.address)) {
    sendLog(rendererClient, 'MQTT 未连接：地址仅支持 ws:// 或 wss://，且不能包含账号、密码或敏感 query。');
    return setStatus(rendererClient, {
      state: 'error',
      address: normalizedConfig.address,
      subscriptions: normalizedConfig.subscriptions,
      lastError: 'MQTT 地址仅支持 ws:// 或 wss://，且不能包含账号、密码或敏感 query。',
    });
  }

  connectRendererClient(rendererClient, generation, normalizedConfig.address, normalizedConfig.subscriptions);
  return rendererClient.status;
}

/** 处理 renderer 显式断开请求。 */
async function handleDisconnect(event: IpcMainInvokeEvent): Promise<MqttIpcStatus> {
  const rendererClient = getRendererClient(event.sender);
  const generation = rendererClient.generation + 1;
  const previousStatus = rendererClient.status;
  const previousSubscriptions = rendererClient.subscriptions;
  rendererClient.generation = generation;
  const disconnectResult = await disconnectRendererClient(rendererClient, 'MQTT 已由 renderer 断开。');
  if (rendererClient.generation !== generation) return rendererClient.status;
  if (!disconnectResult.ok) {
    return setStatus(rendererClient, {
      state: 'error',
      address: previousStatus.address,
      subscriptions: previousSubscriptions,
      lastError: disconnectResult.errorMessage,
    });
  }
  rendererClient.subscriptions = [];
  return setStatus(rendererClient, { state: 'disabled', subscriptions: [] });
}

/** 返回当前 renderer 拥有的 MQTT 状态。 */
async function handleGetStatus(event: IpcMainInvokeEvent): Promise<MqttIpcStatus> {
  return getRendererClient(event.sender).status;
}

/** 获取或创建 webContents 级客户端，并绑定销毁清理。 */
function getRendererClient(webContents: WebContents): MqttRendererClient {
  const existingClient = clientsByWebContentsId.get(webContents.id);
  if (existingClient) return existingClient;

  const rendererClient: MqttRendererClient = {
    webContents,
    generation: 0,
    client: null,
    status: { state: 'disabled', subscriptions: [] },
    subscriptions: [],
  };
  clientsByWebContentsId.set(webContents.id, rendererClient);
  webContents.once('destroyed', () => {
    void disconnectRendererClient(rendererClient, 'renderer 已销毁，MQTT 连接已清理。');
    clientsByWebContentsId.delete(webContents.id);
  });
  return rendererClient;
}

/** 建立主进程 mqtt.js 连接，只订阅白名单配置中的 topic 并发送受控事件。 */
function connectRendererClient(
  rendererClient: MqttRendererClient,
  generation: number,
  address: string,
  subscriptionSnapshot: MqttIpcSubscriptionConfig[],
): void {
  setStatus(rendererClient, { state: 'connecting', address, subscriptions: subscriptionSnapshot });
  const client = mqtt.connect(address, {
    clean: true,
    clientId: 'babylon-editor-electron-' + crypto.randomUUID(),
    connectTimeout: 8000,
    reconnectPeriod: 3000,
  });
  rendererClient.client = client;
  let subscriptionCycle = 0;

  client.on('connect', () => {
    if (!isCurrentClient(rendererClient, generation, client)) return;
    const currentCycle = ++subscriptionCycle;
    setStatus(rendererClient, { state: 'connecting', address, subscriptions: subscriptionSnapshot });
    if (subscriptionSnapshot.length === 0) {
      setStatus(rendererClient, { state: 'connected', address, subscriptions: subscriptionSnapshot });
      return;
    }

    let completedCount = 0;
    const subscriptionErrors: string[] = [];
    const completeSubscription = (subscription: MqttIpcSubscriptionConfig, error: unknown): void => {
      if (!isCurrentClient(rendererClient, generation, client) || currentCycle !== subscriptionCycle) return;
      completedCount += 1;
      if (error) {
        const errorDetail = subscription.topic + '：' + getErrorMessage(error);
        subscriptionErrors.push(errorDetail);
        sendLog(rendererClient, 'MQTT 订阅失败：' + errorDetail);
      } else {
        sendLog(rendererClient, 'MQTT 已连接并订阅：' + subscription.topic);
      }
      if (completedCount < subscriptionSnapshot.length) return;

      if (subscriptionErrors.length > 0) {
        setStatus(rendererClient, {
          state: 'error',
          address,
          subscriptions: subscriptionSnapshot,
          lastError: 'MQTT 订阅失败：' + subscriptionErrors.join('；'),
        });
        return;
      }
      setStatus(rendererClient, { state: 'connected', address, subscriptions: subscriptionSnapshot });
    };

    for (const subscription of subscriptionSnapshot) {
      const options: IClientSubscribeOptions = { qos: subscription.qos };
      let completed = false;
      const completeOnce = (error: unknown): void => {
        if (completed) return;
        completed = true;
        completeSubscription(subscription, error);
      };
      try {
        client.subscribe(subscription.topic, options, (error) => completeOnce(error));
      } catch (error) {
        completeOnce(error);
      }
    }
  });

  client.on('message', (topic, payload) => {
    if (!isCurrentClient(rendererClient, generation, client)) return;
    const subscription = resolveSubscriptionForTopic(topic, subscriptionSnapshot);
    if (!subscription) return;
    sendEvent(rendererClient, {
      type: 'message',
      sourceId: normalizeSourceId(subscription.adapter?.sourceId),
      subscription,
      topic,
      payloadText: payload.toString('utf8'),
      receivedAt: Date.now(),
    });
  });

  client.on('error', (error) => {
    if (!isCurrentClient(rendererClient, generation, client)) return;
    subscriptionCycle += 1;
    setStatus(rendererClient, { state: 'error', address, subscriptions: subscriptionSnapshot, lastError: error.message });
    sendLog(rendererClient, 'MQTT 连接错误：' + error.message);
  });

  client.on('close', () => {
    if (!isCurrentClient(rendererClient, generation, client)) return;
    subscriptionCycle += 1;
    setStatus(rendererClient, { state: 'disconnected', address, subscriptions: subscriptionSnapshot });
    sendLog(rendererClient, 'MQTT 连接已关闭。');
  });
}

/** 判断事件是否属于当前连接代际，避免旧 client 污染新状态。 */
function isCurrentClient(rendererClient: MqttRendererClient, generation: number, client: MqttClient): boolean {
  return rendererClient.generation === generation && rendererClient.client === client;
}

/** 断开当前 client；失败时返回结构化结果，避免 IPC Promise 裸抛。 */
async function disconnectRendererClient(rendererClient: MqttRendererClient, logMessage: string): Promise<MqttDisconnectResult> {
  if (!rendererClient.client) return { ok: true };
  const client = rendererClient.client;
  rendererClient.client = null;
  try {
    await client.endAsync(true);
    sendLog(rendererClient, logMessage);
    return { ok: true };
  } catch (error) {
    const errorMessage = 'MQTT 断开失败：' + getErrorMessage(error);
    sendLog(rendererClient, errorMessage);
    return { ok: false, errorMessage };
  }
}

/** 更新状态并向 renderer 广播 status 事件。 */
function setStatus(rendererClient: MqttRendererClient, status: MqttIpcStatus): MqttIpcStatus {
  rendererClient.status = status;
  sendEvent(rendererClient, { type: 'status', status });
  return status;
}

/** 向 renderer 发送日志事件。 */
function sendLog(rendererClient: MqttRendererClient, message: string): void {
  sendEvent(rendererClient, { type: 'log', message, receivedAt: Date.now() });
}

/** 只通过固定 mqtt:event 通道发送受控事件，不暴露任意脚本执行能力。 */
function sendEvent(rendererClient: MqttRendererClient, event: MqttIpcEvent): void {
  if (rendererClient.webContents.isDestroyed()) return;
  rendererClient.webContents.send('mqtt:event', event);
}

/** 归一化 renderer 配置，丢弃空 topic 并收窄 qos。 */
function normalizeConfigureRequest(request: MqttIpcConfigureRequest): MqttIpcConfigureRequest {
  return {
    enabled: Boolean(request.enabled),
    address: typeof request.address === 'string' ? request.address.trim() : '',
    subscriptions: Array.isArray(request.subscriptions)
      ? request.subscriptions.map(normalizeSubscription).filter((subscription): subscription is MqttIpcSubscriptionConfig => Boolean(subscription))
      : [],
  };
}

/** 清理单条订阅，保证主进程只处理 topic、qos 和 adapter。 */
function normalizeSubscription(subscription: MqttIpcSubscriptionConfig): MqttIpcSubscriptionConfig | null {
  if (!subscription || typeof subscription.topic !== 'string') return null;
  const topic = subscription.topic.trim();
  if (!topic) return null;
  return {
    topic,
    qos: subscription.qos === 1 || subscription.qos === 2 ? subscription.qos : 0,
    ...(subscription.adapter ? { adapter: subscription.adapter } : {}),
  };
}

/** 只允许浏览器可控 MQTT WebSocket 地址，并拒绝账号密码和常见敏感 query。 */
function isSafeMqttAddress(address: string): boolean {
  try {
    const url = new URL(address);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return false;
    if (url.username || url.password) return false;
    const sensitiveQueryKeys = new Set(['token', 'access_token', 'password', 'username']);
    for (const key of url.searchParams.keys()) {
      if (sensitiveQueryKeys.has(key.toLowerCase())) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 按实际消息 topic 匹配订阅配置，支持 MQTT + 和 # 通配符。 */
function resolveSubscriptionForTopic(topic: string, subscriptions: MqttIpcSubscriptionConfig[]): MqttIpcSubscriptionConfig | null {
  return subscriptions.find((subscription) => mqttTopicMatches(subscription.topic, topic)) ?? null;
}

/** 判断实际 topic 是否命中 MQTT 订阅表达式。 */
function mqttTopicMatches(filter: string, topic: string): boolean {
  const filterLevels = filter.split('/');
  const topicLevels = topic.split('/');

  for (let index = 0; index < filterLevels.length; index += 1) {
    const filterLevel = filterLevels[index];
    if (filterLevel === '#') return index === filterLevels.length - 1;
    if (filterLevel === '+') {
      if (topicLevels[index] === undefined) return false;
      continue;
    }
    if (filterLevel !== topicLevels[index]) return false;
  }

  return filterLevels.length === topicLevels.length;
}

/** 将 sourceId 归一为非空字符串，兼容旧单客户端默认数据源。 */
function normalizeSourceId(sourceId: string | undefined): string {
  const normalizedSourceId = sourceId?.trim();
  return normalizedSourceId || 'default';
}


/** 将未知异常转换为适合诊断展示的简短消息。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
