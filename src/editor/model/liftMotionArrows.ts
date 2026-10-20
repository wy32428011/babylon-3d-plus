import { normalizeConveyorSurfaceArrowsConfig, type ConveyorSurfaceArrowStyle } from './conveyorSurfaceArrows.ts';

export const LIFT_MOTION_ARROW_CHANNELS = ['lift', 'front', 'back'] as const;
export type LiftMotionArrowChannel = typeof LIFT_MOTION_ARROW_CHANNELS[number];

/** 尺寸为模型局部米；升降长度和中心由立柱决定，其他通道长宽为 0 时自动适配。 */
export type LiftMotionArrowChannelConfig = {
  enabled: boolean;
  surfaceNode: string;
  surfaceOffset: number;
  offsetAlong: number;
  offsetAcross: number;
  length: number;
  width: number;
  reverse: boolean;
  face: 'top' | 'side';
};

/** 共用输送线箭头外观；运行方向始终由提升机已执行的运动提供。 */
export type LiftMotionArrowsConfig = {
  enabled: boolean;
  style: ConveyorSurfaceArrowStyle;
  color: string;
  intensity: number;
  opacity: number;
  speed: number;
  arrowLength: number;
  arrowWidth: number;
  spacing: number;
  breathingEnabled: boolean;
  breathingPeriod: number;
  breathingStrength: number;
  channels: Record<LiftMotionArrowChannel, LiftMotionArrowChannelConfig>;
};

function createChannelDefaults(): LiftMotionArrowChannelConfig {
  return { enabled: true, surfaceNode: '', surfaceOffset: 0.015, offsetAlong: 0, offsetAcross: 0,
    length: 0, width: 0, reverse: false, face: 'top' };
}

export function createDefaultLiftMotionArrowsConfig(): LiftMotionArrowsConfig {
  return {
    enabled: false, style: 'moving-double-arrow', color: '#39d8ff', intensity: 1, opacity: 0.9, speed: 0.7,
    arrowLength: 0.45, arrowWidth: 0.38, spacing: 0.9,
    breathingEnabled: false, breathingPeriod: 1.8, breathingStrength: 0.7,
    channels: { lift: { ...createChannelDefaults(), face: 'side' }, front: createChannelDefaults(), back: createChannelDefaults() },
  };
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown> : undefined;
}

/** 缺失保持缺失，旧场景不会因新功能自动出现箭头；只保存三路配置，不保存实时状态。 */
export function normalizeLiftMotionArrowsConfig(value: unknown): LiftMotionArrowsConfig | undefined {
  const raw = plainObject(value);
  if (!raw) return undefined;
  const defaults = createDefaultLiftMotionArrowsConfig();
  const appearance = normalizeConveyorSurfaceArrowsConfig(raw)!;
  const rawChannels = plainObject(raw.channels) ?? {};
  const channels = {} as LiftMotionArrowsConfig['channels'];
  for (const channel of LIFT_MOTION_ARROW_CHANNELS) {
    const item = plainObject(rawChannels[channel]) ?? {};
    const normalized = normalizeConveyorSurfaceArrowsConfig(item)!;
    channels[channel] = {
      enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
      surfaceNode: normalized.surfaceNode, surfaceOffset: normalized.surfaceOffset,
      offsetAlong: channel === 'lift' ? 0 : normalized.offsetAlong,
      offsetAcross: channel === 'lift' ? 0 : normalized.offsetAcross,
      length: channel === 'lift' ? 0 : normalized.length, width: normalized.width,
      reverse: typeof item.reverse === 'boolean' ? item.reverse : false,
      // 升降固定在立柱侧面覆盖全高度，避免载货台遮挡；不能通过导入配置移到台面。
      face: channel === 'lift' || item.face === 'side' ? 'side' : 'top',
    };
  }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    style: appearance.style, color: appearance.color, opacity: appearance.opacity, speed: appearance.speed,
    intensity: typeof raw.intensity === 'number' && Number.isFinite(raw.intensity)
      ? Math.min(10, Math.max(0, raw.intensity)) : defaults.intensity,
    arrowLength: appearance.arrowLength, arrowWidth: appearance.arrowWidth, spacing: appearance.spacing,
    breathingEnabled: appearance.breathingEnabled, breathingPeriod: appearance.breathingPeriod,
    breathingStrength: appearance.breathingStrength, channels,
  };
}

