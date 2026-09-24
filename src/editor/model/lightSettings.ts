import type { LightComponent, LightKind } from './components';

export const LIGHT_KINDS: readonly LightKind[] = ['directional', 'spot', 'point', 'hemispheric', 'rectArea'];

export const DEFAULT_SPOT_ANGLE = Math.PI / 3;
export const DEFAULT_SPOT_EXPONENT = 2;
export const DEFAULT_AREA_LIGHT_SIZE = 2;

export const LIGHT_LABELS: Record<LightKind, string> = {
  directional: '方向光 Directional', spot: '聚光灯 Spot', point: '点光源 Point',
  hemispheric: '半球光 Hemispheric', rectArea: '矩形面光 RectArea',
};

export const LIGHT_DESCRIPTIONS: Record<LightKind, string> = {
  directional: '模拟太阳光，平行光线沿统一方向照射。适合室外与大型场景；支持主投影，普通模型间投影需高质量实时阴影。',
  spot: '从一点向锥形范围发光。适合局部与重点照明；开启实时阴影后支持投影。',
  point: '从一点向四周发光。适合灯泡等局部光源；开启实时阴影后支持多方向投影，开销高于聚光灯。',
  hemispheric: '模拟天空与地面的漫反射补光，提供基础照明，不产生投射阴影。',
  rectArea: '从矩形面发出柔和光线，适合室内面板照明；当前实现不投射阴影。',
};

export const WARM_WORK_LIGHT_SETTINGS = {
  lightKind: 'point',
  intensity: 1.5,
  color: '#ffd6a3',
  range: 20,
  nightBehavior: 'keep',
} as const satisfies LightComponent;

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : undefined;
}

/** 清洗灯光数据时保留可选字段的缺省语义，避免旧场景被自动套用新外观。 */
export function normalizeLightSettings(input: unknown): LightComponent {
  const value = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const color = normalizeColor(value.color);
  const groundColor = normalizeColor(value.groundColor);
  const range = typeof value.range === 'number' && Number.isFinite(value.range) && value.range > 0
    ? value.range
    : undefined;
  const angle = typeof value.angle === 'number' && Number.isFinite(value.angle) && value.angle > 0 && value.angle < Math.PI ? value.angle : undefined;
  const exponent = typeof value.exponent === 'number' && Number.isFinite(value.exponent) && value.exponent >= 0 ? value.exponent : undefined;
  const width = typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0 ? value.width : undefined;
  const height = typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0 ? value.height : undefined;
  const nightBehavior = value.nightBehavior === 'dim' || value.nightBehavior === 'keep' ? value.nightBehavior : undefined;
  return {
    lightKind: LIGHT_KINDS.includes(value.lightKind as LightKind) ? value.lightKind as LightKind : 'hemispheric',
    intensity: typeof value.intensity === 'number' && Number.isFinite(value.intensity) && value.intensity >= 0 ? value.intensity : 1,
    ...(color !== undefined ? { color } : {}),
    ...(groundColor !== undefined ? { groundColor } : {}),
    ...(range !== undefined ? { range } : {}),
    ...(angle !== undefined ? { angle } : {}),
    ...(exponent !== undefined ? { exponent } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(nightBehavior !== undefined ? { nightBehavior } : {}),
  };
}
