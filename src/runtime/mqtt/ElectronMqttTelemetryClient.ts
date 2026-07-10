import {
  deviceTelemetryStore,
  parseDeviceTelemetryMessage,
  type DeviceTelemetryStore,
  type MqttSubscriptionConfig,
  type TelemetryConnectionState,
} from './deviceTelemetry';
import type { MqttTelemetryClientConfig, MqttTelemetryLog } from './MqttTelemetryClient';
import { mqttRuntimeStatusStore } from './mqttRuntimeStatus';

type ElectronMqttAdapterConfig =
  | { kind: 'epv'; sourceId?: string; deviceType?: string }
  | {
      kind: 'json-path';
      sourceId?: string;
      deviceTypePath?: string;
      assetCodePath?: string;
      timestampPath?: string;
      sequencePath?: string;
      fields: Record<string, string>;
    };

type ElectronMqttSubscriptionConfig = {
  topic: string;
  qos: 0 | 1 | 2;
  adapter?: ElectronMqttAdapterConfig;
};

type ElectronMqttConfigureRequest = {
  enabled: boolean;
  address: string;
  subscriptions: ElectronMqttSubscriptionConfig[];
};

type ElectronMqttStatus = {
  state: 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error';
  address?: string;
  subscriptions: ElectronMqttSubscriptionConfig[];
  lastError?: string;
};

type ElectronMqttEvent =
  | { type: 'status'; status: ElectronMqttStatus }
  | { type: 'log'; message: string; receivedAt: number }
  | {
      type: 'message';
      sourceId: string;
      subscription: ElectronMqttSubscriptionConfig;
      topic: string;
      payloadText: string;
      receivedAt: number;
    };

type ElectronMqttApi = {
  mqttConfigure: (request: ElectronMqttConfigureRequest) => Promise<ElectronMqttStatus>;
  mqttDisconnect: () => Promise<ElectronMqttStatus>;
  mqttGetStatus: () => Promise<ElectronMqttStatus>;
  onMqttEvent: (handler: (event: ElectronMqttEvent) => void) => () => void;
};

/** 判断当前 renderer 是否拥有 Electron preload 暴露的 MQTT 窄 API。 */
export function hasElectronMqttApi(): boolean {
  return Boolean(getElectronMqttApi());
}

/** 通过 Electron 主进程 mqtt.js 连接 broker，并把受控 IPC 消息写入遥测仓库。 */
export class ElectronMqttTelemetryClient {
  private configSignature = '';
  private generation = 0;
  private requestId = 0;
  private activeRequest: ElectronMqttRequestContext | null = null;
  private unsubscribe: (() => void) | null = null;
  private state: TelemetryConnectionState = 'disabled';
  private lastParseErrorAt = 0;
  private readonly activeSourceIds = new Set<string>();

  constructor(
    private readonly pushLog: MqttTelemetryLog,
    private readonly store: DeviceTelemetryStore = deviceTelemetryStore,
    private readonly api: ElectronMqttApi = getElectronMqttApiOrThrow(),
  ) {
    this.unsubscribe = this.api.onMqttEvent((event) => this.handleEvent(event));
  }

  /** 返回当前 Electron MQTT 连接状态，保持与浏览器客户端一致的读取方式。 */
  getConnectionState(): TelemetryConnectionState {
    return this.state;
  }

  /** 根据配置通过主进程连接、重连或断开 MQTT。 */
  updateConfig(config: MqttTelemetryClientConfig): void {
    const normalizedSubscriptions = normalizeSubscriptions(config.subscriptions, config.sourceId);
    const signature = JSON.stringify({
      enabled: config.enabled,
      address: config.address,
      subscriptions: normalizedSubscriptions,
    });
    if (signature === this.configSignature) return;

    const requestContext = this.createRequestContext(config.enabled, config.address, normalizedSubscriptions, signature);
    this.configSignature = signature;
    this.activeRequest = requestContext;
    this.clearActiveSources();
    this.replaceActiveSourceIds(normalizedSubscriptions);

    if (!config.enabled) {
      this.state = 'disabled';
      mqttRuntimeStatusStore.update('disabled');
      void this.api
        .mqttConfigure({ enabled: false, address: '', subscriptions: [] })
        .then((status) => {
          if (!this.isCurrentRequest(requestContext) || !this.isStatusForCurrentConfig(status)) return;
          this.state = mapIpcState(status.state);
          mqttRuntimeStatusStore.update(this.state, status.lastError ?? null);
        })
        .catch((error: unknown) => {
          if (!this.isCurrentRequest(requestContext)) return;
          this.state = 'error';
          const message = getErrorMessage(error);
          mqttRuntimeStatusStore.update('error', message);
          this.pushLog('Electron MQTT 配置失败：' + message);
        });
      return;
    }

    this.state = 'connecting';
    mqttRuntimeStatusStore.update('connecting');

    void this.api
      .mqttConfigure({ enabled: config.enabled, address: config.address, subscriptions: normalizedSubscriptions })
      .then((status) => {
        if (!this.isCurrentRequest(requestContext) || !this.isStatusForCurrentConfig(status)) return;
        this.state = mapIpcState(status.state);
        mqttRuntimeStatusStore.update(this.state, status.lastError ?? null);
      })
      .catch((error: unknown) => {
        if (!this.isCurrentRequest(requestContext)) return;
        this.state = 'error';
        const message = getErrorMessage(error);
        mqttRuntimeStatusStore.update('error', message);
        this.pushLog('Electron MQTT 配置失败：' + message);
      });
  }

  /** 取消 IPC 事件监听并断开主进程 MQTT 连接。 */
  dispose(): void {
    const disposeGeneration = this.advanceGeneration();
    this.configSignature = '';
    this.activeRequest = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    void this.api
      .mqttDisconnect()
      .then((status) => {
        if (this.generation !== disposeGeneration || this.activeRequest !== null || !isDisabledStatus(status)) return;
        this.state = 'disabled';
        mqttRuntimeStatusStore.update('disabled', status.lastError ?? null);
      })
      .catch((error: unknown) => {
        if (this.generation !== disposeGeneration || this.activeRequest !== null) return;
        this.pushLog('Electron MQTT 断开失败：' + getErrorMessage(error));
      });
    this.clearActiveSources();
    this.activeSourceIds.clear();
    this.state = 'disabled';
    mqttRuntimeStatusStore.update('disabled');
  }

  /** 处理主进程推送的受控 MQTT 事件。 */
  private handleEvent(event: ElectronMqttEvent): void {
    if (event.type === 'status') {
      if (!this.isStatusForCurrentConfig(event.status)) return;
      this.state = mapIpcState(event.status.state);
      mqttRuntimeStatusStore.update(this.state, event.status.lastError ?? null);
      if (event.status.lastError) this.pushLog('Electron MQTT 状态错误：' + event.status.lastError);
      return;
    }

    if (event.type === 'log') {
      this.pushLog(event.message);
      return;
    }

    if (!this.isMessageForCurrentConfig(event)) return;

    try {
      const snapshot = parseDeviceTelemetryMessage(
        event.topic,
        event.payloadText,
        event.subscription.adapter ?? { kind: 'epv', sourceId: event.sourceId },
      );
      if (!snapshot) return;
      this.store.upsert({ ...snapshot, receivedAt: event.receivedAt });
    } catch (error) {
      this.reportParseError(error);
    }
  }

  /** 用新订阅替换当前客户端拥有的数据源集合。 */
  private replaceActiveSourceIds(subscriptions: ElectronMqttSubscriptionConfig[]): void {
    this.activeSourceIds.clear();
    for (const subscription of subscriptions) {
      this.activeSourceIds.add(normalizeSourceId(subscription.adapter?.sourceId));
    }
  }

  /** 仅清理当前 Electron 客户端拥有的数据源，避免影响其它遥测来源。 */
  private clearActiveSources(): void {
    if (this.activeSourceIds.size === 0) return;
    for (const sourceId of this.activeSourceIds) {
      this.store.clearSource(sourceId);
    }
  }

  /** 解析错误做节流记录，避免异常消息刷爆日志。 */
  private reportParseError(error: unknown): void {
    const now = Date.now();
    if (now - this.lastParseErrorAt < 3000) return;
    this.lastParseErrorAt = now;
    const message = getErrorMessage(error);
    mqttRuntimeStatusStore.update('error', message);
    this.pushLog('Electron MQTT 设备遥测解析失败：' + message);
  }

  /** 为每次配置变更建立 renderer 本地代际，避免旧 Promise 回写新配置状态。 */
  private createRequestContext(
    enabled: boolean,
    address: string,
    subscriptions: ElectronMqttSubscriptionConfig[],
    signature: string,
  ): ElectronMqttRequestContext {
    return {
      generation: this.advanceGeneration(),
      requestId: this.requestId,
      enabled,
      address,
      signature,
      subscriptionsSignature: createSubscriptionsSignature(subscriptions),
      subscriptionSignatures: new Set(subscriptions.map(createSubscriptionSignature)),
    };
  }

  /** 同步递增 generation/requestId；主进程 generation 与 preload API 不参与本地判定。 */
  private advanceGeneration(): number {
    this.generation += 1;
    this.requestId += 1;
    return this.generation;
  }

  /** 校验 Promise 回调仍属于当前 renderer 请求，过期返回静默丢弃。 */
  private isCurrentRequest(context: ElectronMqttRequestContext): boolean {
    return (
      this.generation === context.generation &&
      this.requestId === context.requestId &&
      this.configSignature === context.signature &&
      this.activeRequest === context
    );
  }

  /** 校验状态事件/返回值是否匹配当前配置，避免旧连接状态污染 UI。 */
  private isStatusForCurrentConfig(status: ElectronMqttStatus): boolean {
    const request = this.activeRequest;
    if (!request) return isDisabledStatus(status);
    if (request.enabled) {
      if (status.address !== undefined && status.address !== request.address) return false;
      return createSubscriptionsSignature(status.subscriptions) === request.subscriptionsSignature;
    }
    return isDisabledStatus(status);
  }

  /** 校验消息仍来自当前订阅快照，避免旧 topic/source 的异步事件写入遥测仓库。 */
  private isMessageForCurrentConfig(event: Extract<ElectronMqttEvent, { type: 'message' }>): boolean {
    const request = this.activeRequest;
    if (!request?.enabled) return false;
    if (!this.activeSourceIds.has(normalizeSourceId(event.sourceId))) return false;
    if (!mqttTopicMatches(event.subscription.topic, event.topic)) return false;
    const eventSignature = createSubscriptionSignature(event.subscription);
    return request.subscriptionSignatures.has(eventSignature);
  }
}

type ElectronMqttRequestContext = {
  generation: number;
  requestId: number;
  enabled: boolean;
  address: string;
  signature: string;
  subscriptionsSignature: string;
  subscriptionSignatures: Set<string>;
};

/** 获取 Electron MQTT API；浏览器环境返回 null 以触发 WebSocket fallback。 */
function getElectronMqttApi(): ElectronMqttApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as Window & { editorApi?: Partial<ElectronMqttApi> }).editorApi;
  if (!api?.mqttConfigure || !api.mqttDisconnect || !api.mqttGetStatus || !api.onMqttEvent) return null;
  return {
    mqttConfigure: api.mqttConfigure,
    mqttDisconnect: api.mqttDisconnect,
    mqttGetStatus: api.mqttGetStatus,
    onMqttEvent: api.onMqttEvent,
  };
}

/** 在确认 Electron API 存在后返回 API，否则抛出明确错误。 */
function getElectronMqttApiOrThrow(): ElectronMqttApi {
  const api = getElectronMqttApi();
  if (!api) throw new Error('Electron MQTT API 不可用。');
  return api;
}

/** 归一化订阅配置，补齐默认 qos 和 sourceId。 */
function normalizeSubscriptions(subscriptions: MqttSubscriptionConfig[], sourceId?: string): ElectronMqttSubscriptionConfig[] {
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

/** 将 IPC 状态映射到 renderer 遥测状态枚举。 */
function mapIpcState(state: ElectronMqttStatus['state']): TelemetryConnectionState {
  if (state === 'connecting' || state === 'connected' || state === 'disconnected' || state === 'error') return state;
  return 'disabled';
}

/** 判断主进程上报的实际 Topic 是否命中当前 MQTT 订阅表达式。 */
function mqttTopicMatches(filter: string, topic: string): boolean {
  const filterLevels = filter.trim().split('/');
  const topicLevels = topic.trim().split('/');
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
/** 生成订阅数组稳定签名，用于判断 IPC 状态是否仍对应当前 renderer 配置。 */
function createSubscriptionsSignature(subscriptions: ElectronMqttSubscriptionConfig[]): string {
  return JSON.stringify(subscriptions.map(createSubscriptionSignature));
}

/** 生成单条订阅稳定签名，消息事件必须命中当前订阅快照才允许写入。 */
function createSubscriptionSignature(subscription: ElectronMqttSubscriptionConfig): string {
  return JSON.stringify({
    topic: subscription.topic.trim(),
    qos: subscription.qos,
    adapter: subscription.adapter ?? null,
  });
}

/** 判断主进程返回是否为当前禁用态，防止 dispose 后旧连接状态回写。 */
function isDisabledStatus(status: ElectronMqttStatus): boolean {
  return status.state === 'disabled' && createSubscriptionsSignature(status.subscriptions) === createSubscriptionsSignature([]);
}

/** 将 sourceId 归一为非空字符串，兼容旧单客户端默认数据源。 */
function normalizeSourceId(sourceId: string | undefined): string {
  const normalizedSourceId = sourceId?.trim();
  return normalizedSourceId || 'default';
}

/** 将未知异常转换成可展示的简短消息。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
