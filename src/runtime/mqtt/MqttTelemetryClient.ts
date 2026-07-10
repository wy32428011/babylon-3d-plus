import mqtt, { type IClientSubscribeOptions, type MqttClient } from 'mqtt';
import {
  deviceTelemetryStore,
  parseDeviceTelemetryMessage,
  type DeviceTelemetryStore,
  type MqttSubscriptionConfig,
  type TelemetryConnectionState,
} from './deviceTelemetry';
import { mqttRuntimeStatusStore } from './mqttRuntimeStatus';

export type MqttTelemetryLog = (message: string) => void;

export type MqttTelemetryClientConfig = {
  enabled: boolean;
  address: string;
  subscriptions: MqttSubscriptionConfig[];
  sourceId?: string;
};

/** 管理通用 MQTT 遥测连接，并把订阅消息写入设备快照仓库。 */
export class MqttTelemetryClient {
  private client: MqttClient | null = null;
  private configSignature = '';
  private lastParseErrorAt = 0;
  private state: TelemetryConnectionState = 'disabled';
  private activeSubscriptions: MqttSubscriptionConfig[] = [];
  private readonly activeSourceIds = new Set<string>();
  private connectionGeneration = 0;

  constructor(
    private readonly pushLog: MqttTelemetryLog,
    private readonly store: DeviceTelemetryStore = deviceTelemetryStore,
  ) {}

  /** 返回当前 MQTT 遥测连接状态，供 UI 或调试面板读取。 */
  getConnectionState(): TelemetryConnectionState {
    return this.state;
  }

  /** 根据最新配置连接、重连或断开通用 MQTT 遥测。 */
  updateConfig(config: MqttTelemetryClientConfig): void {
    const normalizedSubscriptions = normalizeSubscriptions(config.subscriptions, config.sourceId);
    const signature = JSON.stringify({
      enabled: config.enabled,
      address: config.address,
      subscriptions: normalizedSubscriptions,
    });
    if (signature === this.configSignature) return;

    this.configSignature = signature;
    this.disconnect(true);
    this.activeSubscriptions = normalizedSubscriptions;
    this.replaceActiveSourceIds(normalizedSubscriptions);

    if (!config.enabled) {
      this.state = 'disabled';
      mqttRuntimeStatusStore.update('disabled');
      return;
    }

    if (!config.address || normalizedSubscriptions.length === 0) {
      this.state = 'disconnected';
      mqttRuntimeStatusStore.update('disconnected', '地址或 Topic 为空。');
      this.pushLog('MQTT 未连接：地址或 Topic 为空。');
      this.clearActiveSources();
      return;
    }

    if (!/^wss?:\/\//i.test(config.address)) {
      this.state = 'error';
      mqttRuntimeStatusStore.update('error', '浏览器运行时仅支持 ws:// 或 wss:// 地址。');
      this.pushLog('MQTT 未连接：浏览器运行时仅支持 ws:// 或 wss:// 地址。');
      this.clearActiveSources();
      return;
    }

    this.connect(config.address, normalizedSubscriptions);
  }

  /** 关闭当前 MQTT 连接并清理运行时快照。 */
  dispose(): void {
    this.configSignature = '';
    this.disconnect(true);
    this.activeSubscriptions = [];
    this.activeSourceIds.clear();
    this.state = 'disabled';
    mqttRuntimeStatusStore.update('disabled');
  }

  /** 建立 MQTT over WebSocket 连接并按订阅配置注册 topic。 */
  private connect(address: string, subscriptions: MqttSubscriptionConfig[]): void {
    this.connectionGeneration += 1;
    this.state = 'connecting';
    mqttRuntimeStatusStore.update('connecting');
    const client = mqtt.connect(address, {
      clean: true,
      clientId: 'babylon-editor-' + crypto.randomUUID(),
      connectTimeout: 8000,
      reconnectPeriod: 3000,
    });
    this.client = client;

    client.on('connect', () => {
      if (this.client !== client) return;
      const connectionGeneration = this.createConnectionGeneration();
      let pendingSubackCount = subscriptions.length;
      let hasSubscriptionError = false;
      this.state = 'connecting';
      mqttRuntimeStatusStore.update('connecting');

      const completeSubscription = (subscription: MqttSubscriptionConfig, error?: Error | null) => {
        if (!this.isCurrentConnectionGeneration(client, connectionGeneration) || hasSubscriptionError) return;
        if (error) {
          hasSubscriptionError = true;
          this.state = 'error';
          mqttRuntimeStatusStore.update('error', error.message);
          this.pushLog('MQTT 订阅失败：' + error.message);
          return;
        }

        pendingSubackCount -= 1;
        this.pushLog('MQTT 已连接并订阅：' + subscription.topic);
        if (pendingSubackCount > 0) return;

        this.state = 'connected';
        mqttRuntimeStatusStore.update('connected');
      };

      for (const subscription of subscriptions) {
        const options: IClientSubscribeOptions = { qos: subscription.qos ?? 0 };
        client.subscribe(subscription.topic, options, (error) => completeSubscription(subscription, error));
      }
    });

    client.on('message', (topic, payload) => {
      if (this.client !== client) return;
      const subscription = resolveSubscriptionForTopic(topic, subscriptions);
      if (!subscription) return;

      try {
        const snapshot = parseDeviceTelemetryMessage(topic, payload.toString('utf8'), subscription.adapter ?? { kind: 'epv' });
        if (!snapshot) return;
        this.store.upsert(snapshot);
      } catch (error) {
        this.reportParseError(error);
      }
    });

    client.on('error', (error) => {
      if (this.client !== client) return;
      // 连接错误后当前 connect 内发出的订阅回调已不可信，失效该周期避免延迟 SUBACK 覆盖 error 状态。
      this.connectionGeneration += 1;
      this.state = 'error';
      mqttRuntimeStatusStore.update('error', error.message);
      this.pushLog('MQTT 连接错误：' + error.message);
    });

    client.on('close', () => {
      if (this.client !== client) return;
      this.connectionGeneration += 1;
      if (this.state !== 'disabled') this.state = 'disconnected';
      if (this.state !== 'disabled') mqttRuntimeStatusStore.update('disconnected');
      this.pushLog('MQTT 连接已关闭。');
    });
  }

  /** 断开旧连接，避免配置切换后残留订阅继续写入遥测。 */
  private disconnect(clearStore: boolean): void {
    this.connectionGeneration += 1;
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    if (clearStore) {
      this.clearActiveSources();
    }
  }

  /** 用新订阅替换当前客户端拥有的数据源集合。 */
  private replaceActiveSourceIds(subscriptions: MqttSubscriptionConfig[]): void {
    this.activeSourceIds.clear();
    for (const subscription of subscriptions) {
      this.activeSourceIds.add(normalizeSourceId(subscription.adapter?.sourceId));
    }
  }

  /** 仅清理当前客户端拥有的数据源，避免影响其它遥测客户端。 */
  private clearActiveSources(): void {
    if (this.activeSourceIds.size === 0) return;
    for (const sourceId of this.activeSourceIds) {
      this.store.clearSource(sourceId);
    }
  }

  /** 解析错误做节流记录，避免异常消息刷爆 Console。 */
  private reportParseError(error: unknown): void {
    const now = Date.now();
    if (now - this.lastParseErrorAt < 3000) return;
    this.lastParseErrorAt = now;
    const message = error instanceof Error ? error.message : String(error);
    mqttRuntimeStatusStore.update('error', message);
    this.pushLog('MQTT 设备遥测解析失败：' + message);
  }

  /** 创建新的连接周期编号，确保旧 SUBACK 回调不能覆盖当前状态。 */
  private createConnectionGeneration(): number {
    this.connectionGeneration += 1;
    return this.connectionGeneration;
  }

  /** 校验 MQTT 客户端和连接周期都仍然有效，避免自动重连期间状态串线。 */
  private isCurrentConnectionGeneration(client: MqttClient, connectionGeneration: number): boolean {
    return this.client === client && this.connectionGeneration === connectionGeneration;
  }
}

/** 归一化订阅配置，补齐默认 qos 和 sourceId。 */
function normalizeSubscriptions(subscriptions: MqttSubscriptionConfig[], sourceId?: string): MqttSubscriptionConfig[] {
  return subscriptions
    .map((subscription) => ({
      ...subscription,
      topic: subscription.topic.trim(),
      qos: subscription.qos ?? 0,
      adapter: {
        kind: 'epv' as const,
        ...subscription.adapter,
        sourceId: subscription.adapter?.sourceId ?? sourceId,
      },
    }))
    .filter((subscription) => subscription.topic.length > 0);
}

/** 按实际消息 topic 匹配订阅配置，支持 MQTT + 和 # 通配符。 */
function resolveSubscriptionForTopic(topic: string, subscriptions: MqttSubscriptionConfig[]): MqttSubscriptionConfig | null {
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
