import type { SceneShadowSettings } from './SceneDocument';

export const SCENE_THEME_PRESET_ID = 'tech-blue-night' as const;
export const SCENE_THEME_DRAG_MIME_TYPE = 'application/x-zending-scene-theme';

/** 场景保存实际参数；预设以后升级不会改变已保存的画面。 */
export type SceneThemeSettings = {
  presetId: typeof SCENE_THEME_PRESET_ID;
  version: 1;
  environmentLighting: 'original' | 'scene';
  backgroundColor: string;
  fillColor: string;
  groundColor: string;
  mainColor: string;
  environmentIntensity: number;
  skyboxVisible: boolean;
  exposure: number;
  contrast: number;
  glowIntensity: number;
  bloomEnabled: boolean;
  bloomWeight: number;
  fogEnabled: boolean;
  fogColor: string;
  fogStart: number;
  fogEnd: number;
};

/** 主光方向、强度和阴影沿用已有设置，保持烘焙签名与渲染一致。 */
export const TECH_BLUE_NIGHT_SHADOWS = Object.freeze({
  sunAzimuthDegrees: 315, sunElevationDegrees: 42, sunIntensity: 0.65,
  fillIntensity: 0.42, iblIntensityMax: 0.35, darkness: 0.45,
});

export function createTechBlueNightTheme(): SceneThemeSettings {
  return {
    presetId: SCENE_THEME_PRESET_ID, version: 1, environmentLighting: 'scene',
    backgroundColor: '#091525', fillColor: '#829ec7', groundColor: '#293b55',
    mainColor: '#b5d4ff', environmentIntensity: 0.3, skyboxVisible: false,
    exposure: 1.05, contrast: 1.1, glowIntensity: 0.55,
    bloomEnabled: false, bloomWeight: 0.12,
    fogEnabled: true, fogColor: '#12263c', fogStart: 180, fogEnd: 700,
  };
}

const numberRanges = {
  environmentIntensity: [0, 4], exposure: [0.1, 4], contrast: [0.1, 3],
  glowIntensity: [0, 3], bloomWeight: [0, 1], fogStart: [0, 100000], fogEnd: [1, 200000],
} as const;
const colorKeys = ['backgroundColor','fillColor','groundColor','mainColor','fogColor'] as const;
const booleanKeys = ['skyboxVisible','bloomEnabled','fogEnabled'] as const;

/** 拒绝坏配置，避免保存成功后发布出现另一幅画面。缺失主题保留历史行为。 */
export function normalizeSceneTheme(value: unknown): SceneThemeSettings | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('场景主题配置无效。');
  const input = value as Record<string, unknown>;
  if (input.presetId !== SCENE_THEME_PRESET_ID || input.version !== 1) throw new Error('场景主题类型或版本不受支持。');
  const result = createTechBlueNightTheme();
  if (input.environmentLighting !== 'original' && input.environmentLighting !== 'scene') throw new Error('场景主题环境受光模式无效。');
  result.environmentLighting = input.environmentLighting;
  for (const key of colorKeys) {
    if (typeof input[key] !== 'string' || !/^#[a-f\d]{6}$/i.test(input[key])) throw new Error(`场景主题 ${key} 必须是 #RRGGBB 颜色。`);
    result[key] = input[key].toLowerCase();
  }
  for (const key of booleanKeys) {
    if (typeof input[key] !== 'boolean') throw new Error(`场景主题 ${key} 必须是布尔值。`);
    result[key] = input[key];
  }
  for (const key of Object.keys(numberRanges) as (keyof typeof numberRanges)[]) {
    const number = input[key]; const [min,max] = numberRanges[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) throw new Error(`场景主题 ${key} 必须在 ${min}–${max} 之间。`);
    result[key] = number;
  }
  if (result.fogEnd <= result.fogStart) throw new Error('场景主题雾结束距离必须大于起雾距离。');
  return result;
}

export function isTechBlueNightThemeAdjusted(theme: SceneThemeSettings | null | undefined, shadows: Partial<SceneShadowSettings>): boolean {
  if (!theme) return false;
  const defaults = createTechBlueNightTheme();
  return (Object.keys(defaults) as (keyof SceneThemeSettings)[]).some(key => theme[key] !== defaults[key])
    || (Object.keys(TECH_BLUE_NIGHT_SHADOWS) as (keyof typeof TECH_BLUE_NIGHT_SHADOWS)[]).some(key => shadows[key] !== TECH_BLUE_NIGHT_SHADOWS[key]);
}
