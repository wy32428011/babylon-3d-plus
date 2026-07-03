export const STACKER_TOPIC_PREFIX = 'dt/factory/logistics';

export type StackerTelemetryFields = Record<string, unknown>;

export type ParsedStackerTopic = {
  deviceType: string;
  assetCode: string;
};

export type StackerTelemetrySnapshot = {
  topic: string;
  deviceType: string;
  assetCode: string;
  payloadDeviceCode: string | null;
  sourceTimestamp: string | null;
  receivedAt: number;
  fields: StackerTelemetryFields;
  currentLocationKey: string | null;
  targetLocationKey: string | null;
  hasTargetLocation: boolean;
  faulted: boolean;
  message: string;
};

type StackerTelemetryListener = () => void;

type StackerPayloadItem = {
  e?: unknown;
  p?: unknown;
  v?: unknown;
};

type StackerPayload = {
  data?: unknown;
  ts?: unknown;
};

const STACKER_TOPIC_PATTERN = /^dt\/factory\/logistics\/([^/]+)\/([^/]+)\/twindatadriven\/joint$/;

/** 从 MQTT topic 中解析设备类型和资产编号。 */
export function parseStackerTopic(topic: string): ParsedStackerTopic | null {
  const match = topic.match(STACKER_TOPIC_PATTERN);
  if (!match) return null;

  return {
    deviceType: match[1],
    assetCode: match[2],
  };
}

/** 解析 twindatadriven/joint 消息，并把 data[].p/v 展平成运行时快照。 */
export function parseStackerTelemetryMessage(topic: string, payloadText: string): StackerTelemetrySnapshot | null {
  const topicInfo = parseStackerTopic(topic);
  if (!topicInfo || topicInfo.deviceType !== 'stacker') return null;

  const payload = JSON.parse(payloadText) as StackerPayload;
  const fields = parseTelemetryFields(payload.data);
  const frontDistanceZ = readNumberField(fields, 'front_distance_z', 'ront_distance_z');
  if (frontDistanceZ !== null && fields.front_distance_z === undefined) {
    fields.front_distance_z = frontDistanceZ;
  }

  const currentLocationKey = createLocationKey(
    readIntegerField(fields, 'front_x'),
    readIntegerField(fields, 'front_y'),
    readIntegerField(fields, 'front_z'),
    true,
  );
  const targetLocationKey = createLocationKey(
    readIntegerField(fields, 'to_x'),
    readIntegerField(fields, 'to_y'),
    readIntegerField(fields, 'to_z'),
    false,
  );
  const normal = readBooleanField(fields, 'normal');
  const errorCode = readIntegerField(fields, 'errorCode') ?? 0;
  const frontCommand = readIntegerField(fields, 'front_command');
  const backCommand = readIntegerField(fields, 'back_command');
  const message = readStringField(fields, 'message') ?? '';

  return {
    topic,
    deviceType: topicInfo.deviceType,
    assetCode: topicInfo.assetCode,
    payloadDeviceCode: readPayloadDeviceCode(payload.data),
    sourceTimestamp: typeof payload.ts === 'string' ? payload.ts : null,
    receivedAt: Date.now(),
    fields,
    currentLocationKey,
    targetLocationKey,
    hasTargetLocation: targetLocationKey !== null,
    faulted: normal === false || errorCode !== 0 || frontCommand === 8 || backCommand === 8,
    message,
  };
}

/** 从标准快照中读取数值字段，调用方可传入多个兼容字段名。 */
export function readNumberField(fields: StackerTelemetryFields, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = fields[key];
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return null;
}

/** 从标准快照中读取整数字段，非法值返回 null。 */
export function readIntegerField(fields: StackerTelemetryFields, key: string): number | null {
  const value = readNumberField(fields, key);
  if (value === null) return null;
  return Number.isInteger(value) ? value : Math.trunc(value);
}

/** 从标准快照中读取字符串字段，空字符串仍按真实值保留。 */
export function readStringField(fields: StackerTelemetryFields, key: string): string | null {
  const value = fields[key];
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return null;
  return String(value);
}

/** 从标准快照中读取布尔字段，兼容字符串和 0/1 数值。 */
export function readBooleanField(fields: StackerTelemetryFields, key: string): boolean | null {
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

/** 保存最新 stacker 遥测快照，供 Babylon 运行时逐帧读取。 */
export class StackerTelemetryStore {
  private readonly snapshots = new Map<string, StackerTelemetrySnapshot>();
  private readonly listeners = new Set<StackerTelemetryListener>();

  /** 写入某个资产编号的最新遥测快照。 */
  upsert(snapshot: StackerTelemetrySnapshot): void {
    this.snapshots.set(snapshot.assetCode, snapshot);
    this.emitChange();
  }

  /** 按资产编号读取最新快照。 */
  getSnapshot(assetCode: string): StackerTelemetrySnapshot | null {
    return this.snapshots.get(assetCode) ?? null;
  }

  /** 读取当前所有 stacker 快照，用于唯一设备兜底匹配。 */
  getStackerSnapshots(): StackerTelemetrySnapshot[] {
    return [...this.snapshots.values()].filter((snapshot) => snapshot.deviceType === 'stacker');
  }

  /** 清空运行时快照，通常用于 MQTT 断开或配置关闭。 */
  clear(): void {
    if (this.snapshots.size === 0) return;
    this.snapshots.clear();
    this.emitChange();
  }

  /** 订阅快照变化，返回取消订阅函数。 */
  subscribe(listener: StackerTelemetryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 通知所有监听者已有新遥测。 */
  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const stackerTelemetryStore = new StackerTelemetryStore();

/** 把 payload.data 数组转换成字段表，忽略无字段名的异常项。 */
function parseTelemetryFields(data: unknown): StackerTelemetryFields {
  if (!Array.isArray(data)) return {};

  return data.reduce<StackerTelemetryFields>((fields, item: StackerPayloadItem) => {
    if (!item || typeof item !== 'object' || typeof item.p !== 'string') return fields;
    fields[item.p] = item.v;
    return fields;
  }, {});
}

/** 读取 payload 内部的 e 字段，仅作为辅助元数据，不覆盖 topic 资产编号。 */
function readPayloadDeviceCode(data: unknown): string | null {
  if (!Array.isArray(data)) return null;

  for (const item of data as StackerPayloadItem[]) {
    if (item && typeof item === 'object' && typeof item.e === 'string' && item.e.trim()) {
      return item.e.trim();
    }
  }

  return null;
}

/** 按 x-y-z 规则生成 Locator 资产编号，目标全 0 时返回 null。 */
function createLocationKey(x: number | null, y: number | null, z: number | null, keepZeroTarget: boolean): string | null {
  if (x === null || y === null || z === null) return null;
  if (!keepZeroTarget && x === 0 && y === 0 && z === 0) return null;
  return `${x}-${y}-${z}`;
}
