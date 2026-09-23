import { normalizeConveyorSurfaceArrowsConfig, type ConveyorSurfaceArrowStyle } from './conveyorSurfaceArrows.ts';

export const STACKER_MOTION_ARROW_CHANNELS = ['travel', 'lift', 'frontFork', 'backFork'] as const;
export type StackerMotionArrowChannel = typeof STACKER_MOTION_ARROW_CHANNELS[number];

/** 尺寸为模型局部米；行走长度/纵向中心由固定轨道决定，其他通道长宽为 0 时自动适配。 */
export type StackerMotionArrowChannelConfig = {
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

/** 共用输送线箭头外观；运行方向始终由堆垛机已执行的运动提供。 */
export type StackerMotionArrowsConfig = {
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
  channels: Record<StackerMotionArrowChannel, StackerMotionArrowChannelConfig>;
};

function createChannelDefaults(channel: StackerMotionArrowChannel): StackerMotionArrowChannelConfig {
  return { enabled: true, surfaceNode: '', surfaceOffset: 0.015, offsetAlong: 0, offsetAcross: 0,
    length: 0, width: 0, reverse: false, face: channel === 'lift' ? 'side' : 'top' };
}

export function createDefaultStackerMotionArrowsConfig(): StackerMotionArrowsConfig {
  return {
    enabled: false, style: 'moving-double-arrow', color: '#39d8ff', intensity: 1, opacity: 0.9, speed: 0.7,
    arrowLength: 0.45, arrowWidth: 0.38, spacing: 0.9,
    breathingEnabled: false, breathingPeriod: 1.8, breathingStrength: 0.7,
    channels: { travel: createChannelDefaults('travel'), lift: createChannelDefaults('lift'),
      frontFork: createChannelDefaults('frontFork'), backFork: createChannelDefaults('backFork') },
  };
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown> : undefined;
}

/** 缺失保持缺失，旧场景不会因新功能自动出现箭头；只保存四路配置，不保存实时状态。 */
export function normalizeStackerMotionArrowsConfig(value: unknown): StackerMotionArrowsConfig | undefined {
  const raw = plainObject(value);
  if (!raw) return undefined;
  const defaults = createDefaultStackerMotionArrowsConfig();
  const appearance = normalizeConveyorSurfaceArrowsConfig(raw)!;
  const rawChannels = plainObject(raw.channels) ?? {};
  const channels = {} as StackerMotionArrowsConfig['channels'];
  for (const channel of STACKER_MOTION_ARROW_CHANNELS) {
    const item = plainObject(rawChannels[channel]) ?? {};
    const normalized = normalizeConveyorSurfaceArrowsConfig(item)!;
    channels[channel] = {
      enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
      surfaceNode: normalized.surfaceNode, surfaceOffset: normalized.surfaceOffset,
      offsetAlong: normalized.offsetAlong, offsetAcross: normalized.offsetAcross,
      length: normalized.length, width: normalized.width,
      reverse: typeof item.reverse === 'boolean' ? item.reverse : false,
      // 升降沿 Y 轴，只能绘制竖直箭头面，避免非法配置让箭头落回水平面。
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
