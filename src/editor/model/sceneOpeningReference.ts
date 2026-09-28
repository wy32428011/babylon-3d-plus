import {
  REFERENCE_WORLD_ORIGIN, REFERENCE_CHINA_ORIGIN,
  REFERENCE_WORLD_DESTINATIONS, REFERENCE_CHINA_DESTINATIONS,
} from './sceneOpeningReferenceData.ts';

export type SceneOpeningVisualPoint = { x: number; y: number };
export type SceneOpeningVisualDestination = SceneOpeningVisualPoint & { name: string };
export type SceneOpeningStageDurations = [number, number, number, number, number, number, number, number, number];
export type SceneOpeningReferenceSettings = {
  version: 1;
  brandName: string;
  companyName: string;
  heroTitle: string;
  heroSubtitle: string;
  finaleTitle: string;
  quality: 'high' | 'low';
  showUI: boolean;
  stageDurations: SceneOpeningStageDurations;
  worldOrigin: SceneOpeningVisualPoint;
  chinaOrigin: SceneOpeningVisualPoint;
  worldDestinations: SceneOpeningVisualDestination[];
  chinaDestinations: SceneOpeningVisualDestination[];
  /** 仅记录无法按名称匹配的旧点位；原经纬度仍保留在顶层历史字段中。 */
  legacyUnmappedNames?: string[];
};

export const REFERENCE_OPENING_STAGE_LABELS = ['旋转地球', '地球展开', '全球业务', '中国全景', '江苏高亮', '国内业务', '江苏全景', '无锡全景', '抵达惠山'] as const;
export const REFERENCE_OPENING_MAX_DESTINATIONS = 128;
export const REFERENCE_OPENING_MAX_STAGE_SECONDS = 300;

export function createDefaultReferenceOpening(): SceneOpeningReferenceSettings {
  const locations = (rows: ReadonlyArray<readonly [string, number, number]>): SceneOpeningVisualDestination[] => rows.map(([name, x, y]) => ({ name, x, y }));
  return {
    version: 1,
    brandName: '中鼎智能',
    companyName: '中鼎智能(无锡)科技股份有限公司',
    heroTitle: '从全球\n抵达智能现场',
    heroSubtitle: '跨越山海的连接，始于每一次智能协同。',
    finaleTitle: '抵达惠山\n走进智能仓储',
    quality: 'high',
    showUI: true,
    stageDurations: [9, 7, 8, 6, 4, 8, 6, 6, 8],
    worldOrigin: { x: REFERENCE_WORLD_ORIGIN[0], y: REFERENCE_WORLD_ORIGIN[1] },
    chinaOrigin: { x: REFERENCE_CHINA_ORIGIN[0], y: REFERENCE_CHINA_ORIGIN[1] },
    worldDestinations: locations(REFERENCE_WORLD_DESTINATIONS),
    chinaDestinations: locations(REFERENCE_CHINA_DESTINATIONS),
  };
}

export function getReferenceOpeningDuration(value: SceneOpeningReferenceSettings | { reference: SceneOpeningReferenceSettings }): number {
  const reference = 'reference' in value ? value.reference : value;
  return reference.stageDurations.reduce((total, duration) => total + duration, 0);
}

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const own = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const text = (value: unknown, fallback: string, limit: number) => typeof value === 'string' ? value.slice(0, limit) : fallback;
const number = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

function point(value: unknown): SceneOpeningVisualPoint | null {
  const item = record(value);
  if (!item || typeof item.x !== 'number' || !Number.isFinite(item.x) || item.x < 0 || item.x > 1
    || typeof item.y !== 'number' || !Number.isFinite(item.y) || item.y < 0 || item.y > 1) return null;
  return { x: item.x, y: item.y };
}

function destinations(value: unknown, fallback: SceneOpeningVisualDestination[]): SceneOpeningVisualDestination[] {
  if (!Array.isArray(value)) return fallback;
  return value.slice(0, REFERENCE_OPENING_MAX_DESTINATIONS).flatMap(entry => {
    const item = record(entry), coordinate = point(entry);
    if (!item || !coordinate || typeof item.name !== 'string' || !item.name.trim()) return [];
    return [{ name: item.name.trim().slice(0, 80), ...coordinate }];
  });
}

const LEGACY_NAME_ALIASES: Record<string, string> = {
  四川: '成都', 安徽: '合肥', 东京: '日本', 纽约: '美国东部', 伦敦: '英国', 悉尼: '澳大利亚',
};

function migrateLegacyReference(legacy: Record<string, unknown>, fallback: SceneOpeningReferenceSettings): SceneOpeningReferenceSettings {
  const migrated = fallback;
  const hasLegacyTiming = legacy.template === 'globe-huishan' || own(legacy, 'durationSeconds') || own(legacy, 'chinaHoldSeconds');
  if (hasLegacyTiming) {
    const duration = number(legacy.durationSeconds, 18, 6, 90);
    const hold = number(legacy.chinaHoldSeconds, 6, 0, 300);
    // 参考轴除国内业务外共 54 秒；旧基础时长只按比例分配这八段，独立保留旧停留。
    migrated.stageDurations = migrated.stageDurations.map((value, index) => index === 5 ? hold : value * duration / 54) as SceneOpeningStageDurations;
  }
  migrated.heroTitle = text(legacy.title, migrated.heroTitle, 160);
  migrated.heroSubtitle = text(legacy.subtitle, migrated.heroSubtitle, 240);
  const unmatched: string[] = [];
  for (const [oldKey, newKey, label] of [
    ['destinations', 'worldDestinations', '全球'], ['chinaDestinations', 'chinaDestinations', '国内'],
  ] as const) {
    const source = legacy[oldKey];
    if (!Array.isArray(source)) continue;
    const presets = migrated[newKey];
    migrated[newKey] = source.slice(0, REFERENCE_OPENING_MAX_DESTINATIONS).flatMap(entry => {
      const item = record(entry);
      const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 80) : '';
      if (!name) return [];
      const preset = presets.find(candidate => candidate.name === name || candidate.name === LEGACY_NAME_ALIASES[name]);
      if (!preset) { unmatched.push(`${label}：${name}`); return []; }
      return [{ name, x: preset.x, y: preset.y }];
    });
  }
  if (unmatched.length) migrated.legacyUnmappedNames = unmatched;
  return migrated;
}

export function normalizeReferenceOpening(value: unknown, legacy?: Record<string, unknown>): SceneOpeningReferenceSettings {
  const defaults = createDefaultReferenceOpening();
  const config = record(value);
  if (!config) return legacy ? migrateLegacyReference(legacy, defaults) : defaults;
  if (config.version !== undefined && config.version !== 1) return defaults;
  const durations = Array.isArray(config.stageDurations) && config.stageDurations.length === 9 ? config.stageDurations : defaults.stageDurations;
  const notices = Array.isArray(config.legacyUnmappedNames)
    ? config.legacyUnmappedNames.filter((name): name is string => typeof name === 'string').slice(0, REFERENCE_OPENING_MAX_DESTINATIONS * 2).map(name => name.slice(0, 100)) : [];
  return {
    version: 1,
    brandName: text(config.brandName, defaults.brandName, 80),
    companyName: text(config.companyName, defaults.companyName, 160),
    heroTitle: text(config.heroTitle, defaults.heroTitle, 160),
    heroSubtitle: text(config.heroSubtitle, defaults.heroSubtitle, 240),
    finaleTitle: text(config.finaleTitle, defaults.finaleTitle, 160),
    quality: config.quality === 'low' ? 'low' : 'high',
    showUI: typeof config.showUI === 'boolean' ? config.showUI : defaults.showUI,
    stageDurations: durations.map((value, index) => number(value, defaults.stageDurations[index], index === 2 || index === 5 ? 0 : .1, REFERENCE_OPENING_MAX_STAGE_SECONDS)) as SceneOpeningStageDurations,
    worldOrigin: point(config.worldOrigin) ?? defaults.worldOrigin,
    chinaOrigin: point(config.chinaOrigin) ?? defaults.chinaOrigin,
    worldDestinations: destinations(config.worldDestinations, defaults.worldDestinations),
    chinaDestinations: destinations(config.chinaDestinations, defaults.chinaDestinations),
    ...(notices.length ? { legacyUnmappedNames: notices } : {}),
  };
}
