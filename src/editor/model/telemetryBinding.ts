export const DEFAULT_TELEMETRY_EXPECTED_INTERVAL_MS = 500;
export const TELEMETRY_CONFIG_MAX_DEPTH = 8;
export const TELEMETRY_COLLECTION_MAX_ITEMS = 128;

export type ModelDataDrivenConfig = {
  device: {
    device?: string;
    devType?: string;
    defaultAssetCode?: string;
    calibrationRate?: number;
    rpmToMetersPerSecond?: number;
  };
  /** meta.json 的 dataDriven 是否声明自有 motion 键；只记录键存在语义，值仍按既有规则归一化。 */
  motion?: true;
  /** specialized 模型的 motion 原文透传，仅作 Inspector 只读摘要数据源。 */
  specializedMotion?: Record<string, unknown>;
  /** specialized 模型的 cargo 原文透传（conveyor 走行参数 / rgv 载货台面节点），仅作 Inspector 只读摘要数据源。 */
  cargo?: Record<string, unknown>;
  fixedNodes: string[];
};

/** 专用驱动接管的设备类型；新增专用驱动时需同步登记。 */
export const SPECIALIZED_TELEMETRY_DEVICE_TYPES: readonly string[] = ['stacker', 'conveyor', 'rgv'];

/** 判断归一化后的 devType 是否由 specialized 驱动接管。 */
export function isSpecializedTelemetryDeviceType(devType: string | undefined): boolean {
  return devType !== undefined && SPECIALIZED_TELEMETRY_DEVICE_TYPES.includes(devType);
}

export type TelemetryBindingComponent = {
  enabled: boolean;
  sourceId: string;
  deviceType: string;
  assetCode?: string;
  expectedIntervalMs: number;
  staleAfterMs: number;
  /** 货箱模板来源：场景内模型生成器实体 ID；缺省回退内置立方体。 */
  cargoGeneratorId?: string;
  /** RGV 专用：协议列号(十进制正整数字符串) → 场景实体 ID；仅 deviceType === 'rgv' 时有意义。 */
  columnBindings?: Record<string, string>;
  /** 输送线专用：货物运行轨迹方向（仅编辑态可视化, 非运行时遥测）。 */
  trajectoryDirection?: 'x' | '-x' | 'z' | '-z';
  /** 输送线专用：停线且光电无货时自动销毁货物；未勾选时货物滞留，等下游订阅推送取走或新 task 复用。缺省关闭。 */
  cargoAutoDispose?: boolean;
  /** 输送线专用：起点设备——探测点未触及上游设备时允许自行创建货箱；缺省关闭。 */
  cargoOriginDevice?: boolean;
};

type PlainObject = Record<string, unknown>;

/** 判断输入是否为普通 JSON 对象，避免原型污染对象进入场景状态。 */
function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** 检查 JSON 深度和集合规模，防止超深模型配置拖垮序列化与 Inspector。 */
export function isSafeTelemetryJson(value: unknown, depth = 0): boolean {
  if (depth > TELEMETRY_CONFIG_MAX_DEPTH) return false;
  if (value === null) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length <= TELEMETRY_COLLECTION_MAX_ITEMS && value.every((item) => isSafeTelemetryJson(item, depth + 1));
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= TELEMETRY_COLLECTION_MAX_ITEMS && entries.every(([key, item]) => key.length <= 128 && isSafeTelemetryJson(item, depth + 1));
}


/** 仅检查结构深度和集合规模，数值有限性由字段级 normalizer 处理。 */
function isSafeTelemetryShape(value: unknown, depth = 0): boolean {
  if (depth > TELEMETRY_CONFIG_MAX_DEPTH) return false;
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length <= TELEMETRY_COLLECTION_MAX_ITEMS && value.every((item) => isSafeTelemetryShape(item, depth + 1));
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= TELEMETRY_COLLECTION_MAX_ITEMS && entries.every(([key, item]) => key.length <= 128 && isSafeTelemetryShape(item, depth + 1));
}

/** 清理普通字符串字段，空字符串按 undefined 处理。 */
function normalizeOptionalString(value: unknown, maxLength = 128): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().slice(0, maxLength);
  return normalized || undefined;
}

/** 清理必填字符串字段，非法时使用兜底值。 */
function normalizeString(value: unknown, fallback: string, maxLength = 128): string {
  return normalizeOptionalString(value, maxLength) ?? fallback;
}

/** 清理设备类型标识，统一去除首尾空格并转成小写，避免 Stacker/stacker 被视为不同设备。 */
export function normalizeTelemetryDeviceType(value: unknown, fallback?: string): string | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized) return normalized;
  return fallback ? normalizeOptionalString(fallback)?.toLowerCase() : undefined;
}

/** 清理有限数值字段，非法时使用兜底值并限制范围。 */
function normalizeFiniteNumber(value: unknown, fallback: number, min = -1000000, max = 1000000): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 清理正整数毫秒配置，非法值回退到指定默认值。 */
function normalizePositiveInteger(value: unknown, fallback: number, min = 1, max = 60000): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** 清理字符串数组，只保留非空且不重复的安全字段名。 */
function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const normalized = normalizeOptionalString(item);
    if (normalized && !result.includes(normalized)) result.push(normalized);
    if (result.length >= TELEMETRY_COLLECTION_MAX_ITEMS) break;
  }
  return result;
}

const TELEMETRY_TRAJECTORY_DIRECTIONS = ['x', '-x', 'z', '-z'] as const;

function normalizeTrajectoryDirection(value: unknown): string | undefined {
  return typeof value === 'string' && (TELEMETRY_TRAJECTORY_DIRECTIONS as readonly string[]).includes(value)
    ? value
    : undefined;
}

/** 清理 RGV 列绑定表：列号必须为正整数，实体 ID 必须为非空字符串；非法条目丢弃。 */
function normalizeColumnBindings(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const column = Number(key);
    if (!Number.isInteger(column) || column <= 0) continue;
    const entityId = normalizeOptionalString(item);
    if (!entityId) continue;
    result[String(column)] = entityId;
    if (Object.keys(result).length >= TELEMETRY_COLLECTION_MAX_ITEMS) break;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 归一化模型包 dataDriven 配置，输出纯 JSON 供场景和运行时共享。 */
export function normalizeModelDataDrivenConfig(value: unknown): ModelDataDrivenConfig | null {
  if (!isSafeTelemetryShape(value) || !isPlainObject(value)) return null;
  const device = isPlainObject(value.device) ? value.device : {};
  const deviceName = normalizeOptionalString(device.device);
  const devType = normalizeTelemetryDeviceType(device.devType);
  const defaultAssetCode = normalizeOptionalString(device.defaultAssetCode);
  const calibrationRate = device.calibrationRate === undefined ? undefined : normalizeFiniteNumber(device.calibrationRate, 4, 0.01, 10000);
  const rpmToMetersPerSecond = device.rpmToMetersPerSecond === undefined ? undefined : normalizeFiniteNumber(device.rpmToMetersPerSecond, 0.01, 0, 1000);
  // specializedMotion 是旧场景中的归一化字段；将它视为 motion 来源可保持再次打开时的键存在语义和配置幂等。
  const hasMotionKey = Object.prototype.hasOwnProperty.call(value, 'motion')
    || Object.prototype.hasOwnProperty.call(value, 'specializedMotion');
  const motionValue = isPlainObject(value.specializedMotion) ? value.specializedMotion : value.motion;
  const specializedMotion = isSpecializedTelemetryDeviceType(devType) && isPlainObject(motionValue)
    ? JSON.parse(JSON.stringify(motionValue)) as Record<string, unknown>
    : undefined;
  const cargo = isSpecializedTelemetryDeviceType(devType) && isPlainObject(value.cargo)
    ? JSON.parse(JSON.stringify(value.cargo)) as Record<string, unknown>
    : undefined;
  const fixedNodes = normalizeStringArray(value.fixedNodes);
  if (!deviceName && !devType && !defaultAssetCode && !hasMotionKey && !specializedMotion && !cargo && fixedNodes.length === 0) return null;
  return {
    device: {
      ...(deviceName ? { device: deviceName } : {}),
      ...(devType ? { devType } : {}),
      ...(defaultAssetCode ? { defaultAssetCode } : {}),
      ...(calibrationRate !== undefined ? { calibrationRate } : {}),
      ...(rpmToMetersPerSecond !== undefined ? { rpmToMetersPerSecond } : {}),
    },
    ...(hasMotionKey ? { motion: true } : {}),
    ...(specializedMotion ? { specializedMotion } : {}),
    ...(cargo ? { cargo } : {}),
    fixedNodes,
  };
}

/** 根据 expectedIntervalMs 计算保守 stale 阈值，最低 2000ms。 */
export function createTelemetryStaleAfterMs(expectedIntervalMs: number): number {
  return Math.max(2000, expectedIntervalMs * 3);
}

/** 为带 devType 的模型创建默认遥测绑定。 */
export function createDefaultTelemetryBinding(deviceType: string): TelemetryBindingComponent {
  const expectedIntervalMs = DEFAULT_TELEMETRY_EXPECTED_INTERVAL_MS;
  return {
    enabled: true,
    sourceId: 'default',
    deviceType: normalizeTelemetryDeviceType(deviceType, 'device') ?? 'device',
    expectedIntervalMs,
    staleAfterMs: createTelemetryStaleAfterMs(expectedIntervalMs),
  };
}

/** 清理实体上的遥测绑定组件，保证 undo/redo 与序列化只存安全 JSON。 */
export function normalizeTelemetryBindingComponent(value: unknown): TelemetryBindingComponent | null {
  if (!isSafeTelemetryJson(value) || !isPlainObject(value)) return null;
  const expectedIntervalMs = normalizePositiveInteger(value.expectedIntervalMs, DEFAULT_TELEMETRY_EXPECTED_INTERVAL_MS, 1, 60000);
  const staleAfterMs = normalizePositiveInteger(value.staleAfterMs, createTelemetryStaleAfterMs(expectedIntervalMs), 1, 300000);
  const deviceType = normalizeTelemetryDeviceType(value.deviceType);
  if (!deviceType) return null;
  const assetCode = normalizeOptionalString(value.assetCode);
  const cargoGeneratorId = normalizeOptionalString(value.cargoGeneratorId);
  const columnBindings = normalizeColumnBindings(value.columnBindings);
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    sourceId: normalizeString(value.sourceId, 'default'),
    deviceType,
    ...(assetCode ? { assetCode } : {}),
    expectedIntervalMs,
    staleAfterMs: Math.max(createTelemetryStaleAfterMs(expectedIntervalMs), staleAfterMs),
    ...(cargoGeneratorId ? { cargoGeneratorId } : {}),
    ...(columnBindings ? { columnBindings } : {}),
    ...(normalizeTrajectoryDirection(value.trajectoryDirection) ? { trajectoryDirection: value.trajectoryDirection as TelemetryBindingComponent['trajectoryDirection'] } : {}),
    ...(typeof value.cargoAutoDispose === 'boolean' ? { cargoAutoDispose: value.cargoAutoDispose } : {}),
    ...(typeof value.cargoOriginDevice === 'boolean' ? { cargoOriginDevice: value.cargoOriginDevice } : {}),
  };
}
