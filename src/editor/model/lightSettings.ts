import type { LightComponent, LightKind } from './components';

const LIGHT_KINDS: readonly LightKind[] = ['hemispheric', 'directional', 'point'];

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
  const nightBehavior = value.nightBehavior === 'dim' || value.nightBehavior === 'keep' ? value.nightBehavior : undefined;
  return {
    lightKind: LIGHT_KINDS.includes(value.lightKind as LightKind) ? value.lightKind as LightKind : 'hemispheric',
    intensity: typeof value.intensity === 'number' && Number.isFinite(value.intensity) && value.intensity >= 0 ? value.intensity : 1,
    ...(color !== undefined ? { color } : {}),
    ...(groundColor !== undefined ? { groundColor } : {}),
    ...(range !== undefined ? { range } : {}),
    ...(nightBehavior !== undefined ? { nightBehavior } : {}),
  };
}
