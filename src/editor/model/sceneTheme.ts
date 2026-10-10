import type { SceneShadowSettings } from './SceneDocument';

export const SCENE_THEME_PRESET_ID = 'tech-blue-night' as const;
export const SCENE_THEME_DRAG_MIME_TYPE = 'application/x-zending-scene-theme';
export const SCENE_THEME_PRESET_IDS = [
  SCENE_THEME_PRESET_ID, 'industrial-daylight', 'graphite-neutral', 'teal-night', 'warm-gold-dusk',
] as const;
export type SceneThemePresetId = typeof SCENE_THEME_PRESET_IDS[number];

/** 场景保存实际参数；预设以后升级不会改变已保存的画面。 */
export type SceneThemeSettings = {
  presetId: SceneThemePresetId;
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

export type SceneThemeShadowPreset = Pick<SceneShadowSettings,
  'sunAzimuthDegrees' | 'sunElevationDegrees' | 'sunIntensity' | 'fillIntensity' | 'iblIntensityMax' | 'darkness'>;
export type SceneThemePreset = {
  readonly id: SceneThemePresetId;
  readonly name: string;
  readonly subtitle: string;
  readonly settings: Readonly<SceneThemeSettings>;
  readonly shadows: Readonly<SceneThemeShadowPreset>;
};

const presets: SceneThemePreset[] = [
  {
    id: SCENE_THEME_PRESET_ID, name: '科技蓝夜景', subtitle: '冷蓝底光 · 清晰夜景',
    settings: {
      presetId: SCENE_THEME_PRESET_ID, version: 1, environmentLighting: 'scene',
      backgroundColor: '#091525', fillColor: '#829ec7', groundColor: '#293b55',
      mainColor: '#b5d4ff', environmentIntensity: 0.3, skyboxVisible: false,
      exposure: 1.05, contrast: 1.1, glowIntensity: 0.55,
      bloomEnabled: false, bloomWeight: 0.12,
      fogEnabled: true, fogColor: '#12263c', fogStart: 180, fogEnd: 700,
    },
    shadows: TECH_BLUE_NIGHT_SHADOWS,
  },
  {
    id: 'industrial-daylight', name: '工业日光', subtitle: '自然白光 · 原色清晰',
    settings: {
      presetId: 'industrial-daylight', version: 1, environmentLighting: 'scene',
      backgroundColor: '#e6eef5', fillColor: '#dce8f4', groundColor: '#9ca6ad',
      mainColor: '#ffffff', environmentIntensity: 0.6, skyboxVisible: false,
      exposure: 1, contrast: 1.05, glowIntensity: 0.35,
      bloomEnabled: false, bloomWeight: 0.12,
      fogEnabled: false, fogColor: '#e6eef5', fogStart: 180, fogEnd: 700,
    },
    shadows: { sunAzimuthDegrees: 315, sunElevationDegrees: 55, sunIntensity: 1.1,
      fillIntensity: 0.6, iblIntensityMax: 0.8, darkness: 0.3 },
  },
  {
    id: 'graphite-neutral', name: '石墨中性', subtitle: '石墨背景 · 银灰照明',
    settings: {
      presetId: 'graphite-neutral', version: 1, environmentLighting: 'scene',
      backgroundColor: '#20262e', fillColor: '#bbc4d0', groundColor: '#454b55',
      mainColor: '#e5ebf2', environmentIntensity: 0.4, skyboxVisible: false,
      exposure: 1.05, contrast: 1.05, glowIntensity: 0.4,
      bloomEnabled: false, bloomWeight: 0.12,
      fogEnabled: false, fogColor: '#20262e', fogStart: 180, fogEnd: 700,
    },
    shadows: { sunAzimuthDegrees: 315, sunElevationDegrees: 45, sunIntensity: 0.95,
      fillIntensity: 0.52, iblIntensityMax: 0.55, darkness: 0.35 },
  },
  {
    id: 'teal-night', name: '青绿夜景', subtitle: '青绿冷光 · 轻雾层次',
    settings: {
      presetId: 'teal-night', version: 1, environmentLighting: 'scene',
      backgroundColor: '#071d22', fillColor: '#83b9bc', groundColor: '#25464b',
      mainColor: '#b7ebe0', environmentIntensity: 0.35, skyboxVisible: false,
      exposure: 1.1, contrast: 1.08, glowIntensity: 0.45,
      bloomEnabled: false, bloomWeight: 0.12,
      fogEnabled: true, fogColor: '#12343b', fogStart: 180, fogEnd: 750,
    },
    shadows: { sunAzimuthDegrees: 315, sunElevationDegrees: 42, sunIntensity: 0.8,
      fillIntensity: 0.52, iblIntensityMax: 0.45, darkness: 0.4 },
  },
  {
    id: 'warm-gold-dusk', name: '暖金黄昏', subtitle: '低角度暖光 · 冷暖层次',
    settings: {
      presetId: 'warm-gold-dusk', version: 1, environmentLighting: 'scene',
      backgroundColor: '#30272a', fillColor: '#b8c9e0', groundColor: '#584842',
      mainColor: '#ffd6a0', environmentIntensity: 0.4, skyboxVisible: false,
      exposure: 1.05, contrast: 1.05, glowIntensity: 0.35,
      bloomEnabled: false, bloomWeight: 0.12,
      fogEnabled: true, fogColor: '#544248', fogStart: 220, fogEnd: 900,
    },
    shadows: { sunAzimuthDegrees: 270, sunElevationDegrees: 18, sunIntensity: 1,
      fillIntensity: 0.6, iblIntensityMax: 0.6, darkness: 0.35 },
  },
];

/** 目录和参数只读，应用时创建副本，防止微调污染其它场景的默认值。 */
export const SCENE_THEME_PRESETS: readonly SceneThemePreset[] = Object.freeze(presets.map(preset => Object.freeze({
  ...preset, settings: Object.freeze(preset.settings), shadows: Object.freeze(preset.shadows),
})));

export function isSceneThemePresetId(value: unknown): value is SceneThemePresetId {
  return typeof value === 'string' && SCENE_THEME_PRESET_IDS.some(id => id === value);
}

export function getSceneThemePreset(id: SceneThemePresetId): SceneThemePreset {
  const preset = SCENE_THEME_PRESETS.find(candidate => candidate.id === id);
  if (!preset) throw new Error('场景主题类型不受支持。');
  return preset;
}

export function createSceneTheme(id: SceneThemePresetId = SCENE_THEME_PRESET_ID): SceneThemeSettings {
  return { ...getSceneThemePreset(id).settings };
}

export function createTechBlueNightTheme(): SceneThemeSettings {
  return createSceneTheme(SCENE_THEME_PRESET_ID);
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
  if (!isSceneThemePresetId(input.presetId) || input.version !== 1) throw new Error('场景主题类型或版本不受支持。');
  const result = createSceneTheme(input.presetId);
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

export function isSceneThemeAdjusted(theme: SceneThemeSettings | null | undefined, shadows: Partial<SceneShadowSettings>): boolean {
  if (!theme) return false;
  const preset = getSceneThemePreset(theme.presetId);
  const defaults = preset.settings;
  return (Object.keys(defaults) as (keyof SceneThemeSettings)[]).some(key => theme[key] !== defaults[key])
    || (Object.keys(preset.shadows) as (keyof SceneThemeShadowPreset)[]).some(key => shadows[key] !== preset.shadows[key]);
}

export function isTechBlueNightThemeAdjusted(theme: SceneThemeSettings | null | undefined, shadows: Partial<SceneShadowSettings>): boolean {
  return isSceneThemeAdjusted(theme, shadows);
}
