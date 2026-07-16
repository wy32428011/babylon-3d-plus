import type { PoiEffectComponent, PoiEffectKind } from './components';

/** POI 库支持的内置 EFF 类型，稳定值会写入场景文件。 */
export const POI_EFFECT_KINDS = [
  'alarm-pulse',
  'warning-beacon',
  'locator-beam',
  'radar-scan',
  'fire',
  'smoke',
  'sparks',
  'steam-leak',
  'gas-leak',
  'water-jet',
  'pipeline-flow-particles',
  'pipeline-flow-arrows',
  'moving-double-arrow',
  'cargo-target-frame',
  'conveyor-direction',
  'evacuation-route',
] as const satisfies readonly PoiEffectKind[];

export const POI_EFFECT_INTENSITY_MIN = 0.1;
export const POI_EFFECT_INTENSITY_MAX = 3;
export const POI_EFFECT_SPEED_MIN = 0.1;
export const POI_EFFECT_SPEED_MAX = 5;
export const POI_EFFECT_DENSITY_MIN = 0.1;
export const POI_EFFECT_DENSITY_MAX = 2;

/** 单个内置 EFF 的资源库展示信息与实例默认参数。 */
export type PoiEffectDefinition = {
  kind: PoiEffectKind;
  name: string;
  subtitle: string;
  icon: string;
  defaults: Omit<PoiEffectComponent, 'effectKind'>;
};

/** 16 个工业数字孪生 EFF 的唯一预设登记表。 */
export const POI_EFFECT_DEFINITIONS: readonly PoiEffectDefinition[] = [
  createDefinition('alarm-pulse', '报警脉冲光圈', '告警定位', 'ring', '#ff3b30', '#ffb3ad', 1.3, 1.2, 1),
  createDefinition('warning-beacon', '旋转警示灯', '设备告警', 'marker', '#ff3b30', '#ffb000', 1.4, 1.2, 1),
  createDefinition('locator-beam', '定位光柱', '远距定位', 'marker', '#17d4ff', '#8ef4ff', 1.2, 0.8, 0.8),
  createDefinition('radar-scan', '雷达扫描圈', '范围扫描', 'ring', '#33ff99', '#9affc5', 1.1, 1, 1),
  createDefinition('fire', '火焰', '消防事故', 'marker', '#ff6a00', '#ffd34d', 1.5, 1.2, 1.2),
  createDefinition('smoke', '烟雾', '过热排烟', 'cube', '#6f7680', '#c7ccd2', 0.8, 0.7, 1.2),
  createDefinition('sparks', '火花飞溅', '电气机械', 'marker', '#ffd34d', '#ff6a00', 1.6, 1.6, 1),
  createDefinition('steam-leak', '蒸汽泄漏', '管道阀门', 'marker', '#f4fbff', '#9de2ff', 0.9, 1.3, 1.2),
  createDefinition('gas-leak', '气体泄漏', '气体扩散', 'cube', '#7cff9a', '#d5ffe0', 0.7, 0.8, 1.2),
  createDefinition('water-jet', '水流喷射', '漏水消防', 'marker', '#22a7ff', '#b9efff', 1, 1.4, 1.1),
  createDefinition('pipeline-flow-particles', '管线流动粒子', '介质流向', 'ring', '#2ed6ff', '#a9f6ff', 1.2, 1, 1),
  createDefinition('pipeline-flow-arrows', '管线流动箭头', '方向标识', 'panel', '#2ed6ff', '#4f8cff', 1.2, 1, 1),
  createDefinition('moving-double-arrow', '移动双箭头', '动态方向', 'panel', '#29e6ff', '#9ff8ff', 1.3, 1.2, 1),
  createDefinition('cargo-target-frame', '货物目标定位框', '仓储定位', 'cube', '#ffc928', '#fff2a1', 1.2, 0.8, 0.8),
  createDefinition('conveyor-direction', '输送方向箭头', '输送流向', 'panel', '#39d8ff', '#bdf7ff', 1.1, 1, 1),
  createDefinition('evacuation-route', '疏散路线', '安全引导', 'person', '#36e36d', '#d4ffdf', 1.2, 1, 1),
];

const POI_EFFECT_DEFINITION_BY_KIND = new Map(
  POI_EFFECT_DEFINITIONS.map((definition) => [definition.kind, definition] as const),
);

/** 创建单条 EFF 预设定义，确保默认字段结构保持一致。 */
function createDefinition(
  kind: PoiEffectKind,
  name: string,
  subtitle: string,
  icon: string,
  primaryColor: string,
  secondaryColor: string,
  intensity: number,
  speed: number,
  density: number,
): PoiEffectDefinition {
  return {
    kind,
    name,
    subtitle,
    icon,
    defaults: {
      enabled: true,
      primaryColor,
      secondaryColor,
      intensity,
      speed,
      density,
    },
  };
}

/** 判断外部值是否是受支持的内置 EFF 类型。 */
export function isPoiEffectKind(value: unknown): value is PoiEffectKind {
  return typeof value === 'string' && POI_EFFECT_DEFINITION_BY_KIND.has(value as PoiEffectKind);
}

/** 按稳定类型读取 EFF 预设；类型已经过联合类型约束，因此始终存在。 */
export function getPoiEffectDefinition(kind: PoiEffectKind): PoiEffectDefinition {
  return POI_EFFECT_DEFINITION_BY_KIND.get(kind) ?? POI_EFFECT_DEFINITIONS[0];
}

/** 创建指定 EFF 类型的新实例配置，返回独立对象避免多个实体共享默认值。 */
export function createDefaultPoiEffectComponent(kind: PoiEffectKind): PoiEffectComponent {
  const definition = getPoiEffectDefinition(kind);
  return {
    effectKind: definition.kind,
    ...definition.defaults,
  };
}

/** 将 Inspector 或复制流程产生的 EFF 配置约束到安全范围。 */
export function sanitizePoiEffectComponent(component: PoiEffectComponent): PoiEffectComponent {
  const definition = getPoiEffectDefinition(isPoiEffectKind(component.effectKind) ? component.effectKind : POI_EFFECT_DEFINITIONS[0].kind);
  return {
    effectKind: definition.kind,
    enabled: component.enabled !== false,
    primaryColor: sanitizeHexColor(component.primaryColor, definition.defaults.primaryColor),
    secondaryColor: sanitizeHexColor(component.secondaryColor, definition.defaults.secondaryColor),
    intensity: clampFinite(component.intensity, POI_EFFECT_INTENSITY_MIN, POI_EFFECT_INTENSITY_MAX, definition.defaults.intensity),
    speed: clampFinite(component.speed, POI_EFFECT_SPEED_MIN, POI_EFFECT_SPEED_MAX, definition.defaults.speed),
    density: clampFinite(component.density, POI_EFFECT_DENSITY_MIN, POI_EFFECT_DENSITY_MAX, definition.defaults.density),
  };
}

/** 判断颜色是否是可直接交给 Babylon 和浏览器颜色控件的六位十六进制值。 */
export function isPoiEffectHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

/** 清理 EFF 颜色；非法输入回退到当前类型的预设颜色。 */
function sanitizeHexColor(value: string, fallback: string): string {
  return isPoiEffectHexColor(value) ? value.toLowerCase() : fallback;
}

/** 将 EFF 数值限制在闭区间内，非有限数值回退到预设值。 */
function clampFinite(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
