/** 输送线实例上的表面箭头配置；尺寸单位为模型局部米，0 长宽表示自动适配输送面。 */
export type ConveyorSurfaceArrowsConfig = {
  enabled: boolean;
  surfaceNode: string;
  surfaceOffset: number;
  offsetAlong: number;
  offsetAcross: number;
  length: number;
  width: number;
  endMargin: number;
  color: string;
  opacity: number;
  arrowLength: number;
  arrowWidth: number;
  /** 相邻箭头的中心间距，必须给箭头本身留出视觉空隙。 */
  spacing: number;
  speed: number;
};

export function createDefaultConveyorSurfaceArrowsConfig(): ConveyorSurfaceArrowsConfig {
  return {
    enabled: false,
    surfaceNode: '',
    surfaceOffset: 0.015,
    offsetAlong: 0,
    offsetAcross: 0,
    length: 0,
    width: 0,
    endMargin: 0.12,
    color: '#39d8ff',
    opacity: 0.9,
    arrowLength: 0.45,
    arrowWidth: 0.38,
    spacing: 0.9,
    speed: 0.7,
  };
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** 缺失配置保持缺失，确保旧场景不会隐式打开特效；只保留可序列化的已知字段。 */
export function normalizeConveyorSurfaceArrowsConfig(value: unknown): ConveyorSurfaceArrowsConfig | undefined {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const raw = value as Record<string, unknown>;
  const defaults = createDefaultConveyorSurfaceArrowsConfig();
  const arrowLength = finiteNumber(raw.arrowLength, defaults.arrowLength, 0.02, 100);
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    surfaceNode: typeof raw.surfaceNode === 'string' ? raw.surfaceNode.trim().slice(0, 512) : defaults.surfaceNode,
    surfaceOffset: finiteNumber(raw.surfaceOffset, defaults.surfaceOffset, 0, 10),
    offsetAlong: finiteNumber(raw.offsetAlong, defaults.offsetAlong, -10000, 10000),
    offsetAcross: finiteNumber(raw.offsetAcross, defaults.offsetAcross, -10000, 10000),
    length: finiteNumber(raw.length, defaults.length, 0, 10000),
    width: finiteNumber(raw.width, defaults.width, 0, 10000),
    endMargin: finiteNumber(raw.endMargin, defaults.endMargin, 0, 10000),
    color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color.toLowerCase() : defaults.color,
    opacity: finiteNumber(raw.opacity, defaults.opacity, 0, 1),
    arrowLength,
    arrowWidth: finiteNumber(raw.arrowWidth, defaults.arrowWidth, 0.02, 100),
    spacing: Math.max(arrowLength + 0.02, finiteNumber(raw.spacing, defaults.spacing, 0.04, 10000)),
    speed: finiteNumber(raw.speed, defaults.speed, 0, 100),
  };
}
