export const DEFAULT_TELEMETRY_EXPECTED_INTERVAL_MS = 500;
export const DEFAULT_TELEMETRY_INTERPOLATION_MS = 200;
export const TELEMETRY_CONFIG_MAX_DEPTH = 8;
export const TELEMETRY_COLLECTION_MAX_ITEMS = 128;

export type TelemetryChannelMode = 'absolute' | 'velocity' | 'state';
export type TelemetryTargetKind = 'root' | 'node' | 'bone' | 'animation';
export type TelemetryTransformProperty = 'position' | 'rotation' | 'scaling';
export type TelemetryAxis = 'x' | 'y' | 'z';
export type TelemetrySpace = 'local' | 'world';
export type TelemetryChannelTarget = { kind: TelemetryTargetKind; selector?: string; selectors?: string[]; fallbackPattern?: string };
export type TelemetrySmoothingConfig = { kind: 'step' } | { kind: 'linear'; durationMs?: number } | { kind: 'ema'; alpha?: number };
export type TelemetryAnimationConfig = { action?: string; loop?: boolean; speed?: number; blend?: number };

export type TelemetryMotionChannel = {
  channel: string;
  fields: string[];
  mode: TelemetryChannelMode;
  target: TelemetryChannelTarget;
  property?: TelemetryTransformProperty;
  axis?: TelemetryAxis;
  space?: TelemetrySpace;
  scale: number;
  offset: number;
  invert: boolean;
  min?: number;
  max?: number;
  actionMap?: Record<string, string | number>;
  smoothing?: TelemetrySmoothingConfig;
  animation?: TelemetryAnimationConfig;
  legacyKind?: 'translate' | 'rotate';
  valueMode?: string;
  speed?: number;
};

export type ModelDataDrivenConfig = {
  device: { device?: string; devType?: string; defaultAssetCode?: string; interpolationMs: number };
  motion: Record<string, TelemetryMotionChannel>;
  fixedNodes: string[];
};

export type TelemetryBindingComponent = {
  enabled: boolean;
  sourceId: string;
  deviceType: string;
  assetCode?: string;
  expectedIntervalMs: number;
  staleAfterMs: number;
  channelOverrides: Record<string, TelemetryMotionChannel>;
  /** 货箱模板来源：场景内模型生成器实体 ID；缺省回退内置立方体。 */
  cargoGeneratorId?: string;
  /** 前置设备资产编号；缺省表示入口设备，货物从系统外进入。 */
  upstreamAssetCode?: string;
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

/** 清理遥测通道目标，selector 作为文本选择器暂存给后续运行时消费。 */
function normalizeTarget(value: unknown, nodes?: unknown, fallbackPattern?: unknown): TelemetryChannelTarget {
  const source = isPlainObject(value) ? value : {};
  const kind = source.kind === 'node' || source.kind === 'bone' || source.kind === 'animation' ? source.kind : Array.isArray(nodes) ? 'node' : 'root';
  const selector = normalizeOptionalString(source.selector, 256);
  const selectors = normalizeStringArray(source.selectors).concat(normalizeStringArray(nodes));
  const normalizedFallbackPattern = normalizeOptionalString(source.fallbackPattern ?? fallbackPattern, 256);
  return { kind, ...(selector ? { selector } : {}), ...(selectors.length ? { selectors } : {}), ...(normalizedFallbackPattern ? { fallbackPattern: normalizedFallbackPattern } : {}) };
}

/** 清理平滑配置，保证 step/linear/ema 三类运行时可直接分支消费。 */
function normalizeSmoothing(value: unknown): TelemetrySmoothingConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.kind === 'step') return { kind: 'step' };
  if (value.kind === 'linear') return { kind: 'linear', durationMs: normalizePositiveInteger(value.durationMs, DEFAULT_TELEMETRY_INTERPOLATION_MS, 1, 60000) };
  if (value.kind === 'ema') return { kind: 'ema', alpha: normalizeFiniteNumber(value.alpha, 0.35, 0, 1) };
  return undefined;
}

/** 清理动画通道配置，保留动作、循环、速度和混合权重。 */
function normalizeAnimation(value: unknown): TelemetryAnimationConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const action = normalizeOptionalString(value.action, 128);
  const loop = typeof value.loop === 'boolean' ? value.loop : undefined;
  const speed = value.speed === undefined ? undefined : normalizeFiniteNumber(value.speed, 1, 0, 10);
  const blend = value.blend === undefined ? undefined : normalizeFiniteNumber(value.blend, 0.2, 0, 1);
  const animation: TelemetryAnimationConfig = {};
  if (action) animation.action = action;
  if (loop !== undefined) animation.loop = loop;
  if (speed !== undefined) animation.speed = speed;
  if (blend !== undefined) animation.blend = blend;
  return Object.keys(animation).length ? animation : undefined;
}

/** 清理 actionMap，状态值和动作名都必须是短字符串。 */
function normalizeActionMap(value: unknown): Record<string, string | number> | undefined {
  if (!isPlainObject(value)) return undefined;
  const entries: Array<readonly [string, string | number]> = [];
  for (const [key, item] of Object.entries(value).slice(0, TELEMETRY_COLLECTION_MAX_ITEMS)) {
    const normalizedKey = normalizeOptionalString(key);
    if (!normalizedKey) continue;
    if (typeof item === 'number' && Number.isFinite(item)) {
      entries.push([normalizedKey, item]);
      continue;
    }
    const normalizedValue = normalizeOptionalString(item);
    if (normalizedValue) entries.push([normalizedKey, normalizedValue]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** 清理单个运动通道，非法字段回落到安全默认值而不是抛出到 UI。 */
export function normalizeTelemetryMotionChannel(value: unknown, fallbackChannel = 'channel'): TelemetryMotionChannel | null {
  if (!isSafeTelemetryShape(value) || !isPlainObject(value)) return null;
  const channel = normalizeString(value.channel, fallbackChannel);
  const fields = normalizeStringArray(value.fields ?? (value.field === undefined ? undefined : [value.field]));
  if (fields.length === 0) return null;
  const mode: TelemetryChannelMode = value.mode === 'velocity' || value.mode === 'state' ? value.mode : value.valueMode === 'action' ? 'state' : 'absolute';
  const target = normalizeTarget(value.target, value.nodes, value.fallbackPattern);
  const property = value.property === 'rotation' || value.property === 'scaling' || value.property === 'position' ? value.property : value.kind === 'rotate' ? 'rotation' : value.kind === 'translate' ? 'position' : undefined;
  const axis = value.axis === 'x' || value.axis === 'y' || value.axis === 'z' ? value.axis : undefined;
  const space = value.space === 'world' || value.space === 'local' ? value.space : undefined;
  const smoothing = normalizeSmoothing(value.smoothing);
  const animation = normalizeAnimation(value.animation);
  const actionMap = normalizeActionMap(value.actionMap);
  const limits = isPlainObject(value.limits) ? value.limits : {};
  const min = value.min === undefined && limits.min === undefined ? undefined : normalizeFiniteNumber(value.min ?? limits.min, 0);
  const max = value.max === undefined && limits.max === undefined ? undefined : normalizeFiniteNumber(value.max ?? limits.max, 0);
  const speed = value.speed === undefined ? undefined : normalizeFiniteNumber(value.speed, 1, 0, 1000000);
  const legacyKind = value.kind === 'translate' || value.kind === 'rotate' ? value.kind : undefined;
  const valueMode = normalizeOptionalString(value.valueMode);

  return {
    channel,
    fields,
    mode,
    target,
    ...(property ? { property } : {}),
    ...(axis ? { axis } : {}),
    ...(space ? { space } : {}),
    scale: normalizeFiniteNumber(value.scale, speed ?? 1),
    offset: normalizeFiniteNumber(value.offset, 0),
    invert: typeof value.invert === 'boolean' ? value.invert : false,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(actionMap ? { actionMap } : {}),
    ...(smoothing ? { smoothing } : {}),
    ...(animation ? { animation } : {}),
    ...(legacyKind ? { legacyKind } : {}),
    ...(valueMode ? { valueMode } : {}),
    ...(speed !== undefined ? { speed } : {}),
  };
}

/** 清理 motion 映射，支持 transform/joint/animation 共用通道结构。 */
function normalizeMotionRecord(value: unknown): Record<string, TelemetryMotionChannel> {
  if (!isPlainObject(value)) return {};
  const motion: Record<string, TelemetryMotionChannel> = {};
  for (const [key, item] of Object.entries(value).slice(0, TELEMETRY_COLLECTION_MAX_ITEMS)) {
    const channelKey = normalizeOptionalString(key);
    if (!channelKey) continue;
    const channel = normalizeTelemetryMotionChannel(item, channelKey);
    if (channel) motion[channelKey] = channel;
  }
  return motion;
}

/** 归一化模型包 dataDriven 配置，输出纯 JSON 供场景和运行时共享。 */
export function normalizeModelDataDrivenConfig(value: unknown): ModelDataDrivenConfig | null {
  if (!isSafeTelemetryShape(value) || !isPlainObject(value)) return null;
  const device = isPlainObject(value.device) ? value.device : {};
  const deviceName = normalizeOptionalString(device.device);
  const devType = normalizeTelemetryDeviceType(device.devType);
  const defaultAssetCode = normalizeOptionalString(device.defaultAssetCode);
  const interpolationMs = normalizePositiveInteger(device.interpolationMs, DEFAULT_TELEMETRY_INTERPOLATION_MS, 1, 60000);
  const motion = normalizeMotionRecord(value.motion);
  const fixedNodes = normalizeStringArray(value.fixedNodes);
  if (!deviceName && !devType && !defaultAssetCode && Object.keys(motion).length === 0 && fixedNodes.length === 0) return null;
  return {
    device: {
      ...(deviceName ? { device: deviceName } : {}),
      ...(devType ? { devType } : {}),
      ...(defaultAssetCode ? { defaultAssetCode } : {}),
      interpolationMs,
    },
    motion,
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
    channelOverrides: {},
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
  const upstreamAssetCode = normalizeOptionalString(value.upstreamAssetCode);
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    sourceId: normalizeString(value.sourceId, 'default'),
    deviceType,
    ...(assetCode ? { assetCode } : {}),
    expectedIntervalMs,
    staleAfterMs: Math.max(createTelemetryStaleAfterMs(expectedIntervalMs), staleAfterMs),
    channelOverrides: normalizeMotionRecord(value.channelOverrides),
    ...(cargoGeneratorId ? { cargoGeneratorId } : {}),
    ...(upstreamAssetCode ? { upstreamAssetCode } : {}),
  };
}
