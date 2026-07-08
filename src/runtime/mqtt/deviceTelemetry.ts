export const TELEMETRY_TOPIC_PREFIX = 'dt/factory/logistics';

export type DeviceTelemetryFields = Record<string, unknown>;

export type ParsedDeviceTelemetryTopic = {
  deviceType: string;
  assetCode: string;
};

export type DeviceTelemetrySnapshot = {
  topic: string;
  deviceType: string;
  assetCode: string;
  payloadDeviceCode: string | null;
  sourceTimestamp: string | null;
  receivedAt: number;
  fields: DeviceTelemetryFields;
  currentLocationKey: string | null;
  targetLocationKey: string | null;
  hasTargetLocation: boolean;
  faulted: boolean;
  message: string;
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
};

const DEVICE_TOPIC_PATTERN = /^dt\/factory\/logistics\/([^/]+)\/([^/]+)\/twindatadriven\/joint$/;

/** 从 MQTT topic 中解析设备类型和资产编号。 */
export function parseDeviceTelemetryTopic(topic: string): ParsedDeviceTelemetryTopic | null {
  const match = topic.trim().match(DEVICE_TOPIC_PATTERN);
  if (!match) return null;

  return {
    deviceType: match[1].trim().toLowerCase(),
    assetCode: match[2].trim(),
  };
}

/** 解析 twindatadriven/joint 消息，并把 data[].p/v 展平成通用运行时快照。 */
export function parseDeviceTelemetryMessage(topic: string, payloadText: string): DeviceTelemetrySnapshot | null {
  const topicInfo = parseDeviceTelemetryTopic(topic);
  if (!topicInfo) return null;

  const payload = JSON.parse(payloadText) as DeviceTelemetryPayload;
  const fields = parseTelemetryFields(payload.data, topicInfo.assetCode);
  normalizeStackerCompatibleFields(topicInfo.deviceType, fields);

  const stackerLocation = createStackerLocationState(topicInfo.deviceType, fields);
  const normal = readBooleanField(fields, 'normal');
  const errorCode = readIntegerField(fields, 'errorCode') ?? 0;
  const message = readStringField(fields, 'message') ?? '';

  return {
    topic,
    deviceType: topicInfo.deviceType,
    assetCode: topicInfo.assetCode,
    payloadDeviceCode: readPayloadDeviceCode(payload.data),
    sourceTimestamp: typeof payload.ts === 'string' ? payload.ts : null,
    receivedAt: Date.now(),
    fields,
    currentLocationKey: stackerLocation.currentLocationKey,
    targetLocationKey: stackerLocation.targetLocationKey,
    hasTargetLocation: stackerLocation.targetLocationKey !== null,
    faulted: resolveFaulted(topicInfo.deviceType, fields, normal, errorCode),
    message,
  };
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

/** 保存最新设备遥测快照，供 Babylon 运行时逐帧读取。 */
export class DeviceTelemetryStore {
  private readonly snapshots = new Map<string, DeviceTelemetrySnapshot>();
  private readonly listeners = new Set<DeviceTelemetryListener>();

  /** 写入某个设备实例的最新遥测快照。 */
  upsert(snapshot: DeviceTelemetrySnapshot): void {
    this.snapshots.set(this.createSnapshotKey(snapshot.deviceType, snapshot.assetCode), snapshot);
    this.emitChange();
  }

  /** 按资产编号和可选设备类型读取最新快照。 */
  getSnapshot(assetCode: string, deviceType?: string): DeviceTelemetrySnapshot | null {
    if (deviceType) {
      return this.snapshots.get(this.createSnapshotKey(deviceType, assetCode)) ?? null;
    }

    return this.getSnapshots().find((snapshot) => snapshot.assetCode === assetCode) ?? null;
  }

  /** 读取全部设备快照，调用方按设备类型自行筛选。 */
  getSnapshots(): DeviceTelemetrySnapshot[] {
    return [...this.snapshots.values()];
  }

  /** 读取指定设备类型的快照。 */
  getSnapshotsByDeviceType(deviceType: string): DeviceTelemetrySnapshot[] {
    const normalizedDeviceType = deviceType.toLowerCase();
    return this.getSnapshots().filter((snapshot) => snapshot.deviceType === normalizedDeviceType);
  }

  /** 读取当前所有 stacker 快照，用于旧调用方兼容。 */
  getStackerSnapshots(): StackerTelemetrySnapshot[] {
    return this.getSnapshotsByDeviceType('stacker');
  }

  /** 清空运行时快照，通常用于 MQTT 断开或配置关闭。 */
  clear(): void {
    if (this.snapshots.size === 0) return;
    this.snapshots.clear();
    this.emitChange();
  }

  /** 订阅快照变化，返回取消订阅函数。 */
  subscribe(listener: DeviceTelemetryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 创建设备类型和资产编号组合键，避免不同设备类型编号相同互相覆盖。 */
  private createSnapshotKey(deviceType: string, assetCode: string): string {
    return `${deviceType.toLowerCase()}:${assetCode}`;
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

/** 对 Stacker 历史拼写和正式字段做兼容归一。 */
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

/** 把 payload.data 数组转换成字段表，只接收 e 缺失或与 topic 资产编号一致的点位。 */
function parseTelemetryFields(data: unknown, assetCode: string): DeviceTelemetryFields {
  if (!Array.isArray(data)) return {};

  return data.reduce<DeviceTelemetryFields>((fields, item: DevicePayloadItem) => {
    if (!item || typeof item !== 'object' || typeof item.p !== 'string') return fields;
    const pointDeviceCode = readPayloadItemDeviceCode(item);
    if (pointDeviceCode && pointDeviceCode !== assetCode) return fields;
    fields[item.p] = item.v;
    return fields;
  }, {});
}

/** 读取 payload 内部的 e 字段，仅作为辅助元数据，不覆盖 topic 资产编号。 */
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
  return `${x}-${y}-${z}`;
}
