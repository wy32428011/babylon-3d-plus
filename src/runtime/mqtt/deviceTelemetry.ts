export const TELEMETRY_TOPIC_PREFIX = 'dt/factory/logistics';
export const DEFAULT_TELEMETRY_SOURCE_ID = 'default';

export type DeviceTelemetryFields = Record<string, unknown>;

export type ParsedDeviceTelemetryTopic = {
  deviceType: string;
  assetCode: string;
};

export type TelemetryAdapterConfig = EpvTelemetryAdapterConfig | JsonPathTelemetryAdapterConfig;

export type EpvTelemetryAdapterConfig = {
  kind?: 'epv';
  sourceId?: string;
};

export type JsonPathTelemetryAdapterConfig = {
  kind: 'json-path';
  sourceId?: string;
  deviceTypePath?: string;
  assetCodePath?: string;
  timestampPath?: string;
  sequencePath?: string;
  fields: Record<string, string>;
};

export type MqttSubscriptionConfig = {
  topic: string;
  qos?: 0 | 1 | 2;
  adapter?: TelemetryAdapterConfig;
};

export type TelemetryConnectionState =
  | 'disabled'
  | 'simulating'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export type DeviceTelemetrySnapshot = {
  sourceId: string;
  topic: string;
  deviceType: string;
  assetCode: string;
  payloadDeviceCode: string | null;
  sourceTimestamp: number | null;
  sequence: number | null;
  receivedAt: number;
  fields: DeviceTelemetryFields;
  currentLocationKey: string | null;
  targetLocationKey: string | null;
  hasTargetLocation: boolean;
  faulted: boolean;
  message: string;
};

export type DeviceTelemetrySnapshotHistory = {
  previous: DeviceTelemetrySnapshot | null;
  current: DeviceTelemetrySnapshot | null;
};

export type StackerTelemetrySnapshot = DeviceTelemetrySnapshot;

type DeviceTelemetryListener = () => void;

type DevicePayloadItem = {
  e?: unknown;
  p?: unknown;
  v?: unknown;
};

type DeviceTelemetryPayload = {
  data?: unknown;
  ts?: unknown;
  seq?: unknown;
  sequence?: unknown;
};

const DEVICE_TOPIC_PATTERN = /^dt\/factory\/logistics\/([^/]+)\/([^/]+)\/twindatadriven\/joint$/;
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z_$][\w$]*(?:\[\d+\])*$/;

/** 从 MQTT topic 中解析设备类型和资产编号。 */
export function parseDeviceTelemetryTopic(topic: string): ParsedDeviceTelemetryTopic | null {
  const match = topic.trim().match(DEVICE_TOPIC_PATTERN);
  if (!match) return null;

  return {
    deviceType: match[1].trim().toLowerCase(),
    assetCode: match[2].trim(),
  };
}

/** 按适配器配置解析设备遥测消息，默认使用兼容 twindatadriven/joint 的 EPV 协议。 */
export function parseDeviceTelemetryMessage(
  topic: string,
  payloadText: string,
  adapter: TelemetryAdapterConfig = { kind: 'epv' },
): DeviceTelemetrySnapshot | null {
  const payload = JSON.parse(payloadText) as DeviceTelemetryPayload;
  if (adapter.kind === 'json-path') {
    return parseJsonPathTelemetryMessage(topic, payload, adapter);
  }

  return parseEpvTelemetryMessage(topic, payload, { kind: 'epv', sourceId: adapter.sourceId });
}

/** 兼容旧 Stacker 调用方，只接受 stacker 设备类型。 */
export function parseStackerTelemetryMessage(topic: string, payloadText: string): StackerTelemetrySnapshot | null {
  const snapshot = parseDeviceTelemetryMessage(topic, payloadText);
  return snapshot?.deviceType === 'stacker' ? snapshot : null;
}

/** 从标准快照中读取数值字段，调用方可传入多个兼容字段名。 */
export function readNumberField(fields: DeviceTelemetryFields, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = fields[key];
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return null;
}

/** 从标准快照中读取整数字段，非法值返回 null。 */
export function readIntegerField(fields: DeviceTelemetryFields, key: string): number | null {
  const value = readNumberField(fields, key);
  if (value === null) return null;
  return Number.isInteger(value) ? value : Math.trunc(value);
}

/** 从标准快照中读取字符串字段，空字符串仍按真实值保留。 */
export function readStringField(fields: DeviceTelemetryFields, key: string): string | null {
  const value = fields[key];
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return null;
  return String(value);
}

/** 从标准快照中读取布尔字段，兼容字符串和 0/1 数值。 */
export function readBooleanField(fields: DeviceTelemetryFields, key: string): boolean | null {
  const value = fields[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase();
    if (['true', '1', 'yes', '正常'].includes(normalizedValue)) return true;
    if (['false', '0', 'no', '故障'].includes(normalizedValue)) return false;
  }
  return null;
}

/** 保存最新设备遥测快照和上一帧历史，供 Babylon 运行时逐帧读取。 */
export class DeviceTelemetryStore {
  private readonly histories = new Map<string, DeviceTelemetrySnapshotHistory>();
  private readonly effectiveSnapshotsByKey = new Map<string, DeviceTelemetrySnapshot>();
  private readonly listeners = new Set<DeviceTelemetryListener>();

  /** 写入某个设备实例的最新遥测快照；乱序或重复数据返回 false。 */
  upsert(snapshot: DeviceTelemetrySnapshot): boolean {
    const key = this.createSnapshotKey(snapshot.sourceId, snapshot.deviceType, snapshot.assetCode);
    const history = this.histories.get(key) ?? { previous: null, current: null };
    if (history.current && isDuplicateSnapshot(snapshot, history.current)) {
      this.refreshUntimedHeartbeatLastSeen(key, history.current, snapshot);
      return false;
    }
    const currentForOrdering = history.current
      ? this.effectiveSnapshotsByKey.get(key) ?? history.current
      : null;
    if (currentForOrdering && !isNewerSnapshot(snapshot, currentForOrdering)) return false;

    this.histories.set(key, {
      previous: history.current,
      current: snapshot,
    });
    this.effectiveSnapshotsByKey.set(key, snapshot);
    this.emitChange();
    return true;
  }

  /** 刷新无序号无源时间的相同内容心跳在线时间，不推进 previous/current 两帧运动历史。 */
  private refreshUntimedHeartbeatLastSeen(
    key: string,
    current: DeviceTelemetrySnapshot,
    snapshot: DeviceTelemetrySnapshot,
  ): void {
    if (!isUntimedSnapshot(snapshot) || !isUntimedSnapshot(current)) return;
    const effectiveSnapshot = this.effectiveSnapshotsByKey.get(key) ?? current;
    if (snapshot.receivedAt <= effectiveSnapshot.receivedAt) return;

    this.effectiveSnapshotsByKey.set(key, {
      ...current,
      receivedAt: snapshot.receivedAt,
    });
    this.emitChange();
  }

  /** 按资产编号、设备类型和可选数据源读取最新快照，默认兼容旧 sourceId。 */
  getSnapshot(assetCode: string, deviceType?: string, sourceId = DEFAULT_TELEMETRY_SOURCE_ID): DeviceTelemetrySnapshot | null {
    if (deviceType) {
      const key = this.createSnapshotKey(sourceId, deviceType, assetCode);
      const current = this.histories.get(key)?.current ?? null;
      return current ? this.effectiveSnapshotsByKey.get(key) ?? current : null;
    }

    return this.getSnapshots().find((snapshot) => snapshot.sourceId === sourceId && snapshot.assetCode === assetCode) ?? null;
  }

  /** 按资产编号、设备类型和可选数据源读取当前/上一帧历史。 */
  getSnapshotHistory(
    assetCode: string,
    deviceType: string,
    sourceId = DEFAULT_TELEMETRY_SOURCE_ID,
  ): DeviceTelemetrySnapshotHistory {
    return this.histories.get(this.createSnapshotKey(sourceId, deviceType, assetCode)) ?? {
      previous: null,
      current: null,
    };
  }

  /** 读取全部设备最新快照，调用方按设备类型自行筛选。 */
  getSnapshots(): DeviceTelemetrySnapshot[] {
    return [...this.histories.entries()].flatMap(([key, history]) => (
      history.current ? [this.effectiveSnapshotsByKey.get(key) ?? history.current] : []
    ));
  }

  /** 读取指定设备类型的快照，可传入 sourceId 精确筛选。 */
  getSnapshotsByDeviceType(deviceType: string, sourceId?: string): DeviceTelemetrySnapshot[] {
    const normalizedDeviceType = deviceType.toLowerCase();
    return this.getSnapshots().filter(
      (snapshot) =>
        snapshot.deviceType === normalizedDeviceType && (sourceId === undefined || snapshot.sourceId === normalizeSourceId(sourceId)),
    );
  }

  /** 读取当前所有 stacker 快照，用于旧调用方兼容。 */
  getStackerSnapshots(): StackerTelemetrySnapshot[] {
    return this.getSnapshotsByDeviceType('stacker');
  }

  /** 清空运行时快照；传入 sourceId 时兼容转发到 clearSource。 */
  clear(sourceId?: string): void {
    if (sourceId !== undefined) {
      this.clearSource(sourceId);
      return;
    }

    if (this.histories.size === 0) return;
    this.histories.clear();
    this.effectiveSnapshotsByKey.clear();
    this.emitChange();
  }

  /** 清理指定数据源的运行时快照，避免多个 MQTT 客户端互相清空。 */
  clearSource(sourceId: string): void {
    const normalizedSourceId = normalizeSourceId(sourceId);
    let changed = false;
    for (const [key, history] of this.histories.entries()) {
      if (history.current?.sourceId === normalizedSourceId) {
        this.histories.delete(key);
        this.effectiveSnapshotsByKey.delete(key);
        changed = true;
      }
    }
    if (changed) this.emitChange();
  }

  /** 订阅快照变化，返回取消订阅函数。 */
  subscribe(listener: DeviceTelemetryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 创建设备数据源、类型和资产编号组合键，避免不同数据源互相覆盖。 */
  private createSnapshotKey(sourceId: string, deviceType: string, assetCode: string): string {
    return normalizeSourceId(sourceId) + ':' + deviceType.toLowerCase() + ':' + assetCode;
  }

  /** 通知所有监听者已有新遥测。 */
  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const deviceTelemetryStore = new DeviceTelemetryStore();
export const stackerTelemetryStore = deviceTelemetryStore;

/** 使用 EPV 协议解析 twindatadriven/joint 消息。 */
function parseEpvTelemetryMessage(
  topic: string,
  payload: DeviceTelemetryPayload,
  adapter: EpvTelemetryAdapterConfig,
): DeviceTelemetrySnapshot | null {
  const topicInfo = parseDeviceTelemetryTopic(topic);
  if (!topicInfo) return null;

  const fields = parseTelemetryFields(payload.data, topicInfo.assetCode);
  return createSnapshot({
    sourceId: normalizeSourceId(adapter.sourceId),
    topic,
    deviceType: topicInfo.deviceType,
    assetCode: topicInfo.assetCode,
    payloadDeviceCode: readPayloadDeviceCode(payload.data),
    sourceTimestamp: readTimestamp(payload.ts),
    sequence: readSequence(payload.seq ?? payload.sequence),
    fields,
  });
}

/** 使用安全 JSON Path 配置解析任意结构遥测消息。 */
function parseJsonPathTelemetryMessage(
  topic: string,
  payload: unknown,
  adapter: JsonPathTelemetryAdapterConfig,
): DeviceTelemetrySnapshot | null {
  if (!adapter.deviceTypePath || !adapter.assetCodePath) return null;
  const deviceType = readPathString(payload, adapter.deviceTypePath)?.toLowerCase() ?? null;
  const assetCode = readPathString(payload, adapter.assetCodePath);
  if (!deviceType || !assetCode) return null;

  const fields: DeviceTelemetryFields = {};
  for (const [fieldName, fieldPath] of Object.entries(adapter.fields)) {
    const value = readSafeJsonPath(payload, fieldPath);
    if (value === undefined || isInvalidTelemetryFieldValue(value)) continue;
    fields[fieldName] = value;
  }

  return createSnapshot({
    sourceId: normalizeSourceId(adapter.sourceId),
    topic,
    deviceType,
    assetCode,
    payloadDeviceCode: assetCode,
    sourceTimestamp: adapter.timestampPath ? readTimestamp(readSafeJsonPath(payload, adapter.timestampPath)) : null,
    sequence: adapter.sequencePath ? readSequence(readSafeJsonPath(payload, adapter.sequencePath)) : null,
    fields,
  });
}

/** 创建统一快照，并补齐 Stacker 位置和故障兼容语义。 */
function createSnapshot(input: Omit<DeviceTelemetrySnapshot, 'receivedAt' | 'currentLocationKey' | 'targetLocationKey' | 'hasTargetLocation' | 'faulted' | 'message'>): DeviceTelemetrySnapshot {
  normalizeStackerCompatibleFields(input.deviceType, input.fields);
  const stackerLocation = createStackerLocationState(input.deviceType, input.fields);
  const normal = readBooleanField(input.fields, 'normal');
  const errorCode = readIntegerField(input.fields, 'errorCode') ?? 0;
  const message = readStringField(input.fields, 'message') ?? '';

  return {
    ...input,
    receivedAt: Date.now(),
    currentLocationKey: stackerLocation.currentLocationKey,
    targetLocationKey: stackerLocation.targetLocationKey,
    hasTargetLocation: stackerLocation.targetLocationKey !== null,
    faulted: resolveFaulted(input.deviceType, input.fields, normal, errorCode),
    message,
  };
}

/** 将 Stacker 历史拼写和正式字段做兼容归一。 */
function normalizeStackerCompatibleFields(deviceType: string, fields: DeviceTelemetryFields): void {
  if (deviceType !== 'stacker') return;

  const frontDistanceZ = readNumberField(fields, 'front_distance_z', 'ront_distance_z');
  if (frontDistanceZ !== null && fields.front_distance_z === undefined) {
    fields.front_distance_z = frontDistanceZ;
  }
}

/** 生成 Stacker 当前位和目标位状态；非 Stacker 设备没有 locator 语义。 */
function createStackerLocationState(
  deviceType: string,
  fields: DeviceTelemetryFields,
): Pick<DeviceTelemetrySnapshot, 'currentLocationKey' | 'targetLocationKey'> {
  if (deviceType !== 'stacker') {
    return {
      currentLocationKey: null,
      targetLocationKey: null,
    };
  }

  return {
    currentLocationKey: createLocationKey(
      readIntegerField(fields, 'front_x'),
      readIntegerField(fields, 'front_y'),
      readIntegerField(fields, 'front_z'),
      true,
    ),
    targetLocationKey: createLocationKey(
      readIntegerField(fields, 'to_x'),
      readIntegerField(fields, 'to_y'),
      readIntegerField(fields, 'to_z'),
      false,
    ),
  };
}

/** 统一判断故障态，Stacker 额外兼容前后叉急停命令。 */
function resolveFaulted(
  deviceType: string,
  fields: DeviceTelemetryFields,
  normal: boolean | null,
  errorCode: number,
): boolean {
  if (normal === false || errorCode !== 0) return true;
  if (deviceType !== 'stacker') return false;

  return readIntegerField(fields, 'front_command') === 8 || readIntegerField(fields, 'back_command') === 8;
}

/** 将 payload.data 数组转换成字段表，只接收 e 缺失或与 topic 资产编号一致的有限点位。 */
function parseTelemetryFields(data: unknown, assetCode: string): DeviceTelemetryFields {
  if (!Array.isArray(data)) return {};

  return data.reduce<DeviceTelemetryFields>((fields, item: DevicePayloadItem) => {
    if (!item || typeof item !== 'object' || typeof item.p !== 'string' || item.p.trim() === '') return fields;
    const pointDeviceCode = readPayloadItemDeviceCode(item);
    if (pointDeviceCode && pointDeviceCode !== assetCode) return fields;
    if (isInvalidTelemetryFieldValue(item.v)) return fields;
    fields[item.p] = item.v;
    return fields;
  }, {});
}

/** 读取 payload 内部 e 字段，仅作为辅助元数据，不覆盖 topic 资产编号。 */
function readPayloadDeviceCode(data: unknown): string | null {
  if (!Array.isArray(data)) return null;

  for (const item of data as DevicePayloadItem[]) {
    const deviceCode = readPayloadItemDeviceCode(item);
    if (deviceCode) return deviceCode;
  }

  return null;
}

/** 读取单个点位的设备编号，兼容 PLC 把 e 发成数字的情况。 */
function readPayloadItemDeviceCode(item: DevicePayloadItem | null | undefined): string | null {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.e === 'string') {
    const trimmedValue = item.e.trim();
    return trimmedValue || null;
  }
  if (typeof item.e === 'number' && Number.isFinite(item.e)) {
    return String(item.e);
  }
  return null;
}

/** 按 x-y-z 规则生成 Locator 资产编号，目标全 0 时返回 null。 */
function createLocationKey(x: number | null, y: number | null, z: number | null, keepZeroTarget: boolean): string | null {
  if (x === null || y === null || z === null) return null;
  if (!keepZeroTarget && x === 0 && y === 0 && z === 0) return null;
  return String(x) + '-' + String(y) + '-' + String(z);
}

/** 将 sourceId 归一为非空字符串，兼容旧调用方默认数据源。 */
function normalizeSourceId(sourceId: string | undefined): string {
  const normalizedSourceId = sourceId?.trim();
  return normalizedSourceId || DEFAULT_TELEMETRY_SOURCE_ID;
}

/** 读取毫秒时间戳，兼容数字、数字字符串和 ISO 时间字符串。 */
function readTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) return numericValue;
  const parsedDate = Date.parse(value);
  return Number.isFinite(parsedDate) ? parsedDate : null;
}

/** 读取遥测序号，仅保留有限整数。 */
function readSequence(value: unknown): number | null {
  const sequence = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(sequence)) return null;
  return Number.isInteger(sequence) ? sequence : Math.trunc(sequence);
}

/** 判断字段值是否不可写入遥测快照。 */
function isInvalidTelemetryFieldValue(value: unknown): boolean {
  return typeof value === 'number' && !Number.isFinite(value);
}

/** 从安全 JSON Path 读取字符串字段，空字符串视为缺失。 */
function readPathString(payload: unknown, path: string): string | null {
  const value = readSafeJsonPath(payload, path);
  if (typeof value === 'string') {
    const trimmedValue = value.trim();
    return trimmedValue || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** 使用仅支持点号和数组索引的安全路径读取对象值，不执行任何脚本表达式。 */
function readSafeJsonPath(payload: unknown, path: string): unknown {
  const segments = parseSafeJsonPath(path);
  if (!segments) return undefined;

  let current: unknown = payload;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }

    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return undefined;
    current = record[segment];
  }
  return current;
}

/** 解析安全 JSON Path，拒绝括号脚本、原型链和空段。 */
function parseSafeJsonPath(path: string): Array<string | number> | null {
  const trimmedPath = path.trim();
  const pathWithoutRoot = normalizeJsonPathRoot(trimmedPath);
  if (pathWithoutRoot === null || pathWithoutRoot.includes('..')) return null;

  const segments: Array<string | number> = [];
  for (const rawSegment of pathWithoutRoot.split('.')) {
    if (!SAFE_PATH_SEGMENT_PATTERN.test(rawSegment)) return null;
    const propertyName = rawSegment.replace(/\[\d+\]/g, '');
    if (propertyName === '__proto__' || propertyName === 'prototype' || propertyName === 'constructor') return null;
    segments.push(propertyName);

    for (const indexMatch of rawSegment.matchAll(/\[(\d+)\]/g)) {
      segments.push(Number(indexMatch[1]));
    }
  }
  return segments;
}

/** 规范化 JSON Path 根节点，兼容文档式根前缀并拒绝空路径。 */
function normalizeJsonPathRoot(trimmedPath: string): string | null {
  if (!trimmedPath) return null;
  const jsonPathRoot = String.fromCharCode(36);
  if (trimmedPath === jsonPathRoot) return '';
  return trimmedPath.startsWith(jsonPathRoot + '.') ? trimmedPath.slice(2) : trimmedPath;
}

/** 生成不包含 receivedAt 的稳定快照内容签名，用于无序号遥测去重。 */
function createSnapshotContentSignature(snapshot: DeviceTelemetrySnapshot): string {
  return stableStringify({
    sourceId: snapshot.sourceId,
    topic: snapshot.topic,
    deviceType: snapshot.deviceType,
    assetCode: snapshot.assetCode,
    payloadDeviceCode: snapshot.payloadDeviceCode,
    fields: snapshot.fields,
    currentLocationKey: snapshot.currentLocationKey,
    targetLocationKey: snapshot.targetLocationKey,
    hasTargetLocation: snapshot.hasTargetLocation,
    faulted: snapshot.faulted,
    message: snapshot.message,
  });
}

/** 稳定序列化普通 JSON 值，保证对象键顺序不会影响内容签名。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + stableStringify(record[key]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

/** 判断两条快照是否是同一时序点的重复内容；新序号/新源时间仍需刷新在线时间。 */
function isDuplicateSnapshot(next: DeviceTelemetrySnapshot, current: DeviceTelemetrySnapshot): boolean {
  if (createSnapshotContentSignature(next) !== createSnapshotContentSignature(current)) return false;
  if (next.sequence !== null && current.sequence !== null) return next.sequence === current.sequence;
  if (next.sourceTimestamp !== null && current.sourceTimestamp !== null) return next.sourceTimestamp === current.sourceTimestamp;
  return next.sequence === null
    && current.sequence === null
    && next.sourceTimestamp === null
    && current.sourceTimestamp === null;
}

/** 判断快照是否缺少业务时序字段，只能依赖 receivedAt 维护在线状态。 */
function isUntimedSnapshot(snapshot: DeviceTelemetrySnapshot): boolean {
  return snapshot.sequence === null && snapshot.sourceTimestamp === null;
}

/** 判断新快照是否严格晚于当前快照，同毫秒无时序快照允许按内容推进两帧。 */
function isNewerSnapshot(next: DeviceTelemetrySnapshot, current: DeviceTelemetrySnapshot): boolean {
  if (next.sequence !== null && current.sequence !== null) return next.sequence > current.sequence;
  if (next.sourceTimestamp !== null && current.sourceTimestamp !== null) return next.sourceTimestamp > current.sourceTimestamp;
  if (next.sequence === null && current.sequence === null && next.sourceTimestamp === null && current.sourceTimestamp === null) {
    return next.receivedAt >= current.receivedAt;
  }
  return next.receivedAt > current.receivedAt;
}
