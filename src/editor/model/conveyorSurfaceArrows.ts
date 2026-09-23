import { CONVEYOR_ARROW_EFFECT_KINDS, isConveyorArrowEffectKind } from './conveyorArrowEffect.ts';

/** 仅接受特效库内置箭头类型，不允许模型、外部文件或其它 EFF 进入表面渲染。 */
export const CONVEYOR_SURFACE_ARROW_STYLES = ['conveyor-direction', 'moving-double-arrow', 'pipeline-flow-arrows', 'flow-arrows', ...CONVEYOR_ARROW_EFFECT_KINDS] as const;
export type ConveyorSurfaceArrowStyle = typeof CONVEYOR_SURFACE_ARROW_STYLES[number];
export type ConveyorSurfaceArrowDirectionBinding = {
  mode: 'model' | 'point';
  field: string;
  forwardValue: string;
  reverseValue: string;
  stopValue: string;
};

export function isConveyorSurfaceArrowStyle(value: unknown): value is ConveyorSurfaceArrowStyle {
  return typeof value === 'string' && (CONVEYOR_SURFACE_ARROW_STYLES as readonly string[]).includes(value);
}

/** 输送线实例上的表面箭头配置；尺寸单位为模型局部米，0 长宽表示自动适配输送面。 */
export type ConveyorSurfaceArrowsConfig = {
  enabled: boolean;
  style: ConveyorSurfaceArrowStyle;
  breathingEnabled: boolean;
  breathingPeriod: number;
  breathingStrength: number;
  directionBinding: ConveyorSurfaceArrowDirectionBinding;
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
    enabled: true,
    style: 'moving-double-arrow',
    breathingEnabled: false,
    breathingPeriod: 1.8,
    breathingStrength: 0.7,
    directionBinding: { mode: 'model', field: 'movement_x', forwardValue: '1', reverseValue: '2', stopValue: '0' },
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

function scalarSetting(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === 'string') return value.trim().slice(0, 128);
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value);
  return '';
}

/** 自定义映射采用完整点位名及标量文本精确匹配，配置冲突时停止显示而不猜测方向。 */
export function getConveyorSurfaceArrowDirectionError(binding: ConveyorSurfaceArrowDirectionBinding): string | null {
  if (binding.mode !== 'point') return null;
  if (!binding.field.trim()) return '请填写 MQTT 点位名称。';
  const values = [binding.forwardValue, binding.reverseValue, binding.stopValue].map(value => value.trim());
  if (values.some(value => !value)) return '正向、反向和停止值均不能为空。';
  if (new Set(values).size !== values.length) return '正向、反向和停止值必须互不相同。';
  return null;
}

/** 缺失保持缺失，由输送线绑定边界补默认开启；显式 enabled=false 始终保留。 */
export function normalizeConveyorSurfaceArrowsConfig(value: unknown): ConveyorSurfaceArrowsConfig | undefined {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const raw = value as Record<string, unknown>;
  const defaults = createDefaultConveyorSurfaceArrowsConfig();
  const arrowLength = finiteNumber(raw.arrowLength, defaults.arrowLength, 0.02, 100);
  const style = isConveyorSurfaceArrowStyle(raw.style) ? raw.style : defaults.style;
  const direction = raw.directionBinding && typeof raw.directionBinding === 'object' && Object.getPrototypeOf(raw.directionBinding) === Object.prototype
    ? raw.directionBinding as Record<string, unknown> : {};
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    style,
    breathingEnabled: typeof raw.breathingEnabled === 'boolean' ? raw.breathingEnabled : defaults.breathingEnabled,
    breathingPeriod: finiteNumber(raw.breathingPeriod, defaults.breathingPeriod, 0.25, 30),
    breathingStrength: finiteNumber(raw.breathingStrength, defaults.breathingStrength, 0, 1),
    directionBinding: {
      mode: direction.mode === 'point' ? 'point' : 'model',
      field: typeof direction.field === 'string' ? direction.field.trim().slice(0, 512) : defaults.directionBinding.field,
      forwardValue: scalarSetting(direction.forwardValue, defaults.directionBinding.forwardValue),
      reverseValue: scalarSetting(direction.reverseValue, defaults.directionBinding.reverseValue),
      stopValue: scalarSetting(direction.stopValue, defaults.directionBinding.stopValue),
    },
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
    spacing: Math.max(isConveyorArrowEffectKind(style) ? 0.04 : arrowLength + 0.02, finiteNumber(raw.spacing, defaults.spacing, 0.04, 10000)),
    speed: finiteNumber(raw.speed, defaults.speed, 0, 100),
  };
}

// 只读运行时缺省值复用同一份对象，避免大量未保存过新字段的设备逐帧创建配置。
const implicitDefaults: ConveyorSurfaceArrowsConfig = createDefaultConveyorSurfaceArrowsConfig();
Object.freeze(implicitDefaults.directionBinding);
Object.freeze(implicitDefaults);

export function resolveConveyorSurfaceArrowsConfig(value: ConveyorSurfaceArrowsConfig | undefined, isConveyor: boolean): ConveyorSurfaceArrowsConfig | undefined {
  return isConveyor ? value ?? implicitDefaults : undefined;
}
