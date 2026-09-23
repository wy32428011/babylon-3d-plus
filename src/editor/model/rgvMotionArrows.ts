import { normalizeConveyorSurfaceArrowsConfig, type ConveyorSurfaceArrowStyle } from './conveyorSurfaceArrows.ts';

export const RGV_MOTION_ARROW_CHANNELS = ['travel', 'front', 'back'] as const;
export type RgvMotionArrowChannel = typeof RGV_MOTION_ARROW_CHANNELS[number];

/** 尺寸为模型局部米；行走长度/纵向中心由固定轨道决定，其他通道长宽为 0 时自动适配。 */
export type RgvMotionArrowChannelConfig = {
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

/** 共用输送线箭头外观；运行方向始终由 RGV 已执行的运动提供。 */
export type RgvMotionArrowsConfig = {
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
  channels: Record<RgvMotionArrowChannel, RgvMotionArrowChannelConfig>;
};

function createChannelDefaults(): RgvMotionArrowChannelConfig {
  return { enabled: true, surfaceNode: '', surfaceOffset: 0.015, offsetAlong: 0, offsetAcross: 0,
    length: 0, width: 0, reverse: false, face: 'top' };
}

export function createDefaultRgvMotionArrowsConfig(): RgvMotionArrowsConfig {
  return {
    enabled: false, style: 'moving-double-arrow', color: '#39d8ff', intensity: 1, opacity: 0.9, speed: 0.7,
    arrowLength: 0.45, arrowWidth: 0.38, spacing: 0.9,
    breathingEnabled: false, breathingPeriod: 1.8, breathingStrength: 0.7,
    channels: { travel: createChannelDefaults(), front: createChannelDefaults(), back: createChannelDefaults() },
  };
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown> : undefined;
}

/** 缺失保持缺失，旧场景不会因新功能自动出现箭头；只保存三路配置，不保存实时状态。 */
export function normalizeRgvMotionArrowsConfig(value: unknown): RgvMotionArrowsConfig | undefined {
  const raw = plainObject(value);
  if (!raw) return undefined;
  const defaults = createDefaultRgvMotionArrowsConfig();
  const appearance = normalizeConveyorSurfaceArrowsConfig(raw)!;
  const rawChannels = plainObject(raw.channels) ?? {};
  const channels = {} as RgvMotionArrowsConfig['channels'];
  for (const channel of RGV_MOTION_ARROW_CHANNELS) {
    const item = plainObject(rawChannels[channel]) ?? {};
    const normalized = normalizeConveyorSurfaceArrowsConfig(item)!;
    channels[channel] = {
      enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
      surfaceNode: normalized.surfaceNode, surfaceOffset: normalized.surfaceOffset,
      offsetAlong: channel === 'travel' ? 0 : normalized.offsetAlong,
      offsetAcross: channel === 'travel' ? 0 : normalized.offsetAcross,
      length: channel === 'travel' ? 0 : normalized.length, width: normalized.width,
      reverse: typeof item.reverse === 'boolean' ? item.reverse : false,
      // 行走固定铺在轨道正上方且沿中心线覆盖全长，不能通过旧配置或导入数据移到侧边。
      face: channel !== 'travel' && item.face === 'side' ? 'side' : 'top',
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

