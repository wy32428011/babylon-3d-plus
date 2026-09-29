import { createDefaultReferenceOpening, normalizeReferenceOpening, type SceneOpeningReferenceSettings } from './sceneOpeningReference.ts';
import { getOpeningPackageProblem, type OpeningPackageBinding } from '../../shared/opening/openingPackage.ts';

export type SceneOpeningDestination = { name: string; longitude: number; latitude: number };

export type SceneOpeningAnimationSettings = {
  enabled: boolean;
  template: 'reference-huishan' | 'package';
  /** 包快照与场景参数独立保存；不兼容的数据保留给修复/升级，不静默替换模板。 */
  package?: OpeningPackageBinding;
  reference: SceneOpeningReferenceSettings;
  /** 下列地理时长和点位字段保留历史档案；参考模板的实际配置以 reference 为准。 */
  durationSeconds: number;
  allowSkip: boolean;
  title: string;
  subtitle: string;
  destination: SceneOpeningDestination;
  /** 示意飞线城市，不代表真实航班或模型的 GIS 定位。 */
  destinations: SceneOpeningDestination[];
  /** 中国镜头到位后的额外停留，独立于基础动画时长，零秒表示不停留。 */
  chinaHoldSeconds: number;
  chinaDestinations: SceneOpeningDestination[];
  breathingEnabled: boolean;
  breathingIntensity: number;
  breathingPeriodSeconds: number;
  motionPreference: 'normal' | 'reduced' | 'system';
  afterOpening: 'stay' | 'auto-patrol';
};

/** 场景只保存实际存在的配置；完整默认值仅供受控渲染器适配使用。 */
export type SceneOpeningConfig = Partial<SceneOpeningAnimationSettings> & { unavailableReason?: string };

export function normalizeSceneOpeningConfig(value: unknown): SceneOpeningConfig | undefined {
  const settings = asRecord(value);
  if (!settings || settings.template === 'none') return undefined;
  if (settings.template !== 'package') return structuredClone(settings) as SceneOpeningConfig;
  return {
    template: 'package', enabled: settings.enabled === true,
    allowSkip: typeof settings.allowSkip === 'boolean' ? settings.allowSkip : true,
    motionPreference: settings.motionPreference === 'reduced' || settings.motionPreference === 'system' ? settings.motionPreference : 'normal',
    ...(settings.package !== undefined ? { package: structuredClone(settings.package) as OpeningPackageBinding } : {}),
    ...(typeof settings.unavailableReason === 'string' ? { unavailableReason: settings.unavailableReason } : {}),
    // 兼容已保存的旧包播放参数；新包将这三项放入自己的 schema/config.values。
    ...(typeof settings.breathingEnabled === 'boolean' ? { breathingEnabled: settings.breathingEnabled } : {}),
    ...(typeof settings.breathingIntensity === 'number' ? { breathingIntensity: settings.breathingIntensity } : {}),
    ...(typeof settings.breathingPeriodSeconds === 'number' ? { breathingPeriodSeconds: settings.breathingPeriodSeconds } : {}),
  };
}

/** 场景运行只接受显式绑定的有效包；旧内置配置保留给迁移，不隐式启动。 */
export function resolvePackageOpeningSettings(value: unknown): SceneOpeningAnimationSettings {
  const settings = normalizeSceneOpeningAnimation(value);
  return { ...settings, enabled: settings.template === 'package' && settings.enabled && !getOpeningPackageProblem(settings.package) };
}

export const SCENE_OPENING_MIN_DURATION_SECONDS = 6;
export const SCENE_OPENING_MAX_DURATION_SECONDS = 90;
export const SCENE_OPENING_MAX_DESTINATIONS = 32;
export const SCENE_OPENING_MAX_CHINA_HOLD_SECONDS = 300;
export const SCENE_OPENING_MIN_BREATHING_PERIOD_SECONDS = 2;
export const SCENE_OPENING_MAX_BREATHING_PERIOD_SECONDS = 10;

/** 省级地区使用省会作示意落点；用户可以独立修改显示名和经纬度。 */
export function createDefaultSceneOpeningChinaDestinations(): SceneOpeningDestination[] {
  return [
    { name: '四川', longitude: 104.0665, latitude: 30.5723 },
    { name: '上海', longitude: 121.4737, latitude: 31.2304 },
    { name: '杭州', longitude: 120.1551, latitude: 30.2741 },
    { name: '深圳', longitude: 114.0579, latitude: 22.5431 },
    { name: '安徽', longitude: 117.2272, latitude: 31.8206 },
  ];
}

/** 每次返回独立数据，避免编辑一个场景时污染其它场景默认值。 */
export function createDefaultSceneOpeningAnimation(): SceneOpeningAnimationSettings {
  return {
    enabled: false,
    template: 'reference-huishan',
    reference: createDefaultReferenceOpening(),
    durationSeconds: 18,
    allowSkip: true,
    title: '无锡 · 惠山',
    subtitle: '数字孪生 · 智慧联接',
    destination: { name: '惠山区', longitude: 120.3, latitude: 31.68 },
    destinations: [
      { name: '北京', longitude: 116.4, latitude: 39.9 },
      { name: '东京', longitude: 139.69, latitude: 35.68 },
      { name: '新加坡', longitude: 103.82, latitude: 1.35 },
      { name: '悉尼', longitude: 151.21, latitude: -33.87 },
      { name: '伦敦', longitude: -0.13, latitude: 51.51 },
      { name: '纽约', longitude: -74.01, latitude: 40.71 },
    ],
    chinaHoldSeconds: 6,
    chinaDestinations: createDefaultSceneOpeningChinaDestinations(),
    breathingEnabled: true,
    breathingIntensity: 0.65,
    breathingPeriodSeconds: 4,
    motionPreference: 'normal',
    afterOpening: 'stay',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function normalizeDestination(value: unknown): SceneOpeningDestination | null {
  const location = asRecord(value);
  if (!location || typeof location.name !== 'string' || !location.name.trim()
    || typeof location.longitude !== 'number' || !Number.isFinite(location.longitude)
    || location.longitude < -180 || location.longitude > 180
    || typeof location.latitude !== 'number' || !Number.isFinite(location.latitude)
    || location.latitude < -90 || location.latitude > 90) return null;
  return { name: location.name.trim().slice(0, 80), longitude: location.longitude, latitude: location.latitude };
}

/** 历史场景默认停用；坏的可选开场配置不阻断业务场景加载。 */
export function normalizeSceneOpeningAnimation(value: unknown): SceneOpeningAnimationSettings {
  const defaults = createDefaultSceneOpeningAnimation();
  const settings = asRecord(value);
  if (!settings) return defaults;
  const supportedTemplate = settings.template === undefined || settings.template === defaults.template || settings.template === 'globe-huishan' || settings.template === 'package';
  const duration = typeof settings.durationSeconds === 'number' && Number.isFinite(settings.durationSeconds)
    ? settings.durationSeconds : defaults.durationSeconds;
  const chinaHold = typeof settings.chinaHoldSeconds === 'number' && Number.isFinite(settings.chinaHoldSeconds)
    ? settings.chinaHoldSeconds : defaults.chinaHoldSeconds;
  const breathingIntensity = typeof settings.breathingIntensity === 'number' && Number.isFinite(settings.breathingIntensity)
    ? settings.breathingIntensity : defaults.breathingIntensity;
  const breathingPeriod = typeof settings.breathingPeriodSeconds === 'number' && Number.isFinite(settings.breathingPeriodSeconds)
    ? settings.breathingPeriodSeconds : defaults.breathingPeriodSeconds;
  return {
    enabled: supportedTemplate && settings.enabled === true,
    template: settings.template === 'package' ? 'package' : defaults.template,
    ...(settings.package !== undefined ? { package: structuredClone(settings.package) as OpeningPackageBinding } : {}),
    reference: normalizeReferenceOpening(settings.reference, settings),
    durationSeconds: Math.max(SCENE_OPENING_MIN_DURATION_SECONDS, Math.min(SCENE_OPENING_MAX_DURATION_SECONDS, duration)),
    allowSkip: typeof settings.allowSkip === 'boolean' ? settings.allowSkip : defaults.allowSkip,
    title: typeof settings.title === 'string' ? settings.title.slice(0, 120) : defaults.title,
    subtitle: typeof settings.subtitle === 'string' ? settings.subtitle.slice(0, 200) : defaults.subtitle,
    destination: normalizeDestination(settings.destination) ?? defaults.destination,
    // 飞线有独立绘制成本；丢弃坏坐标并限制展示数量，保留显式空列表。
    destinations: Array.isArray(settings.destinations)
      ? settings.destinations.slice(0, SCENE_OPENING_MAX_DESTINATIONS).map(normalizeDestination)
        .filter((destination): destination is SceneOpeningDestination => destination !== null)
      : defaults.destinations,
    chinaHoldSeconds: Math.max(0, Math.min(SCENE_OPENING_MAX_CHINA_HOLD_SECONDS, chinaHold)),
    chinaDestinations: Array.isArray(settings.chinaDestinations)
      ? settings.chinaDestinations.slice(0, SCENE_OPENING_MAX_DESTINATIONS).map(normalizeDestination)
        .filter((destination): destination is SceneOpeningDestination => destination !== null)
      : defaults.chinaDestinations,
    breathingEnabled: typeof settings.breathingEnabled === 'boolean' ? settings.breathingEnabled : defaults.breathingEnabled,
    breathingIntensity: Math.max(0, Math.min(1, breathingIntensity)),
    breathingPeriodSeconds: Math.max(SCENE_OPENING_MIN_BREATHING_PERIOD_SECONDS,
      Math.min(SCENE_OPENING_MAX_BREATHING_PERIOD_SECONDS, breathingPeriod)),
    motionPreference: settings.motionPreference === 'reduced' || settings.motionPreference === 'system'
      ? settings.motionPreference : 'normal',
    afterOpening: settings.afterOpening === 'auto-patrol' ? 'auto-patrol' : 'stay',
  };
}
