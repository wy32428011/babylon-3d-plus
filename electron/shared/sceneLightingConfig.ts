import { DEFAULT_LIGHTING_BAKE_SETTINGS, normalizeSceneLightingBakeSettings, validateSceneLightingBakeSnapshot,
  type SceneLightingBakeSettings, type SceneLightingBakeSnapshot } from './sceneLightingBakeData.ts';
import { LIGHTING_POLICY_FIELDS, normalizeSceneLightingPolicy, type SceneLightingPolicy } from './sceneLightingPolicy.ts';
import { assertLightingLightmapVersion } from './sceneLightingTextureCodec.ts';

export type SceneLightingConfig = {
  version: 2 | 3;
  main: { source: 'managed' | 'scene'; enabled: boolean; color: string; azimuthDegrees: number; elevationDegrees: number; intensity: number };
  fill: { intensity: number; color: string; groundColor: string };
  environmentIntensity: number;
  /** 缺省沿用场景天空盒，仅显式选择或新场景启用内置预览环境。 */
  environment?: { source: 'scene' | 'sandbox'; rotationDegrees: number };
  disabledLightIds: string[];
  allowDayNightCycle: boolean;
  shadows: { enabled: boolean; quality: 'performance' | 'balanced' | 'quality'; darkness: number; distanceMeters: number; bias: number; normalBias: number;
    /** 缺省沿用已有规则和例外；自动模式不改写原有策略。 */
    managementMode?: 'automatic' | 'rules' };
  bake: SceneLightingBakeSettings;
  policy?: SceneLightingPolicy;
  result?: SceneLightingBakeSnapshot | null;
};
export type SceneAppearanceConfig = {
  version: 1;
  backgroundColor: string;
  skyboxVisible: boolean;
  exposure: number;
  contrast: number;
  toneMappingEnabled: boolean;
  glowIntensity: number;
  bloomEnabled: boolean;
  bloomWeight: number;
  /** 显式启用Bloom离屏管线MSAA；旧场景缺字段时保持原单采样+FXAA。 */
  bloomMsaaEnabled?: boolean;
  fogEnabled: boolean;
  fogColor: string;
  fogStart: number;
  fogEnd: number;
};
export const DEFAULT_SCENE_LIGHTING_CONFIG: SceneLightingConfig = {
  version: 2,
  main: { source: 'managed', enabled: true, color: '#fff4e5', azimuthDegrees: 56, elevationDegrees: 63, intensity: 1.05 },
  fill: { intensity: .8, color: '#ffffff', groundColor: '#000000' },
  environmentIntensity: 1, disabledLightIds: [], allowDayNightCycle: true,
  shadows: { enabled: true, quality: 'balanced', darkness: .32, distanceMeters: 0, bias: .002, normalBias: .03 },
  bake: { ...DEFAULT_LIGHTING_BAKE_SETTINGS }, result: null,
};
export const DEFAULT_SCENE_APPEARANCE_CONFIG: SceneAppearanceConfig = {
  version: 1, backgroundColor: '#141417', skyboxVisible: true,
  exposure: 1, contrast: 1, toneMappingEnabled: false, glowIntensity: 1,
  bloomEnabled: false, bloomWeight: .15, fogEnabled: false, fogColor: '#141417', fogStart: 100, fogEnd: 1000,
};

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const finite = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const boolean = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback;
const color = (value: unknown, fallback: string) => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value.toLowerCase() : fallback;
function requireVersion(value: Obj, expected: number, label: string): void {
  if (value.version !== undefined && value.version !== expected) throw new Error(`${label}版本不受支持：${String(value.version)}`);
}
function without(value: Obj, keys: readonly string[]): Obj {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
}
/** 已知字段归一化，扩展数据留在原所属对象；迁移不能删掉其它功能的规则元数据。 */
function policyWithExtensions(value: unknown): SceneLightingPolicy | undefined {
  requireVersion(object(value), 1, '光照分类规则');
  const normalized = normalizeSceneLightingPolicy(value);
  if (!normalized) return undefined;
  const raw = object(value), rules = Array.isArray(raw.rules) ? raw.rules : [];
  const byId = new Map<string, Obj>();
  for (const item of rules) { const value = object(item), id = typeof value.id === 'string' ? value.id.trim() : ''; if (!byId.has(id)) byId.set(id, value); }
  return { ...raw, ...normalized, defaults: { ...without(object(raw.defaults), LIGHTING_POLICY_FIELDS), ...normalized.defaults }, rules: normalized.rules.map(rule => {
    const original = byId.get(rule.id) ?? {};
    const target = { ...object(original.target), ...rule.target };
    if (rule.target.kind === 'resource') Object.assign(target, { model: {
      ...without(object(object(original.target).model), ['sourcePath', 'sourceUrl', 'identity', 'dataPlatformModel']), ...rule.target.model,
    } });
    const nodes = Array.isArray(original.nodeRules) ? original.nodeRules : [];
    const nodesById = new Map<string, Obj>();
    for (const item of nodes) { const value = object(item), id = typeof value.id === 'string' ? value.id.trim() : ''; if (!nodesById.has(id)) nodesById.set(id, value); }
    return { ...without(original, ['nodeRules']), ...rule, values: { ...without(object(original.values), LIGHTING_POLICY_FIELDS), ...rule.values }, target, ...(rule.nodeRules ? { nodeRules: rule.nodeRules.map(node => {
      const source = nodesById.get(node.id) ?? {};
      return { ...source, ...node, values: { ...without(object(source.values), LIGHTING_POLICY_FIELDS), ...node.values }, target: { ...object(source.target), ...node.target } };
    }) } : {}) };
  }) };
}
function resultWithExtensions(value: unknown, version: 2 | 3): SceneLightingBakeSnapshot | null {
  const normalized = validateSceneLightingBakeSnapshot(value);
  if (!normalized) {
    if (version === 3 && value !== null && value !== undefined) throw new Error('场景光照配置中的烘焙结果格式或贴图编码无效。');
    return null;
  }
  assertLightingLightmapVersion(version, undefined, normalized.assets.filter(asset => asset.kind === 'lightmap').map(asset => asset.encoding));
  const raw = object(value), assets = Array.isArray(raw.assets) ? raw.assets : [], surfaces = Array.isArray(raw.surfaces) ? raw.surfaces : [];
  const assetById = new Map(assets.map(item => { const value = object(item); return [value.id, value] as const; }));
  const surfaceByKey = new Map(surfaces.map(item => { const value = object(item); return [value.key, value] as const; }));
  return { ...without(raw, ['version', 'signature', 'geometrySignature', 'createdAt', 'engineVersion', 'assets', 'surfaces', 'probeAssetId', 'statistics']), ...normalized,
    assets: normalized.assets.map(asset => ({ ...without(assetById.get(asset.id) ?? {}, ['id', 'kind', 'url', 'byteLength', 'sha256', 'rgbmRange']), ...asset })),
    surfaces: normalized.surfaces.map(surface => ({ ...surfaceByKey.get(surface.key), ...surface })),
  };
}

/** 新配置是唯一写合同；缺省值补齐，明确未知版本拒绝，避免未来版本被静默降级。 */
export function normalizeSceneLightingConfig(value: unknown): SceneLightingConfig {
  const raw = object(value), d = DEFAULT_SCENE_LIGHTING_CONFIG;
  if (raw.version !== undefined && raw.version !== 2 && raw.version !== 3) throw new Error(`场景光照配置版本不受支持：${String(raw.version)}`);
  const version = raw.version === 3 ? 3 : 2;
  const bake = { ...object(raw.bake), ...normalizeSceneLightingBakeSettings(raw.bake) };
  assertLightingLightmapVersion(version, bake.lightmapEncoding, [], bake.lightmapMipLevels);
  const main = object(raw.main), fill = object(raw.fill), shadows = object(raw.shadows), policy = policyWithExtensions(raw.policy);
  const disabledLightIds = [...new Set((Array.isArray(raw.disabledLightIds) ? raw.disabledLightIds : [])
    .filter((id): id is string => typeof id === 'string').map(id => id.trim()).filter(Boolean))];
  return { ...without(raw, ['policy', 'result']), version,
    main: { ...main, source: main.source === 'scene' ? 'scene' : 'managed', enabled: boolean(main.enabled, d.main.enabled),
      color: color(main.color, d.main.color), azimuthDegrees: finite(main.azimuthDegrees, d.main.azimuthDegrees, 0, 360),
      elevationDegrees: finite(main.elevationDegrees, d.main.elevationDegrees, -90, 90), intensity: finite(main.intensity, d.main.intensity, 0, 20) },
    fill: { ...fill, intensity: finite(fill.intensity, d.fill.intensity, 0, 4), color: color(fill.color, d.fill.color), groundColor: color(fill.groundColor, d.fill.groundColor) },
    environmentIntensity: finite(raw.environmentIntensity, d.environmentIntensity, 0, 5), disabledLightIds,
    ...(raw.environment !== undefined ? { environment: { ...object(raw.environment),
      source: object(raw.environment).source === 'sandbox' ? 'sandbox' as const : 'scene' as const,
      rotationDegrees: finite(object(raw.environment).rotationDegrees, object(raw.environment).source === 'sandbox' ? 5.54 * 180 / Math.PI : 0, 0, 360),
    } } : {}),
    allowDayNightCycle: boolean(raw.allowDayNightCycle, true),
    shadows: { ...without(shadows, ['managementMode']), enabled: boolean(shadows.enabled, d.shadows.enabled),
      ...(shadows.managementMode === 'automatic' || shadows.managementMode === 'rules' ? { managementMode: shadows.managementMode } : {}),
      quality: shadows.quality === 'performance' || shadows.quality === 'quality' ? shadows.quality : 'balanced',
      darkness: finite(shadows.darkness, d.shadows.darkness, 0, .85), distanceMeters: finite(shadows.distanceMeters, d.shadows.distanceMeters, 0, 800),
      bias: finite(shadows.bias, d.shadows.bias, 0, .02), normalBias: finite(shadows.normalBias, d.shadows.normalBias, 0, .2) },
    bake,
    ...(policy ? { policy } : {}), result: resultWithExtensions(raw.result, version),
  };
}

/** 外观不创建灯、不更改环境辐照度，因而不参与 GI 输入签名。 */
export function normalizeSceneAppearanceConfig(value: unknown): SceneAppearanceConfig {
  const raw = object(value), d = DEFAULT_SCENE_APPEARANCE_CONFIG;
  requireVersion(raw, 1, '场景外观配置');
  const fogStart = finite(raw.fogStart, d.fogStart, 0, 100000);
  const normalized: SceneAppearanceConfig = { ...raw, version: 1,
    backgroundColor: color(raw.backgroundColor, d.backgroundColor), skyboxVisible: boolean(raw.skyboxVisible, d.skyboxVisible),
    exposure: finite(raw.exposure, d.exposure, .1, 4), contrast: finite(raw.contrast, d.contrast, .1, 3),
    toneMappingEnabled: boolean(raw.toneMappingEnabled, false), glowIntensity: finite(raw.glowIntensity, d.glowIntensity, 0, 3),
    bloomEnabled: boolean(raw.bloomEnabled, false), bloomWeight: finite(raw.bloomWeight, d.bloomWeight, 0, 1),
    fogEnabled: boolean(raw.fogEnabled, false), fogColor: color(raw.fogColor, d.fogColor), fogStart,
    fogEnd: Math.max(fogStart + 1, finite(raw.fogEnd, d.fogEnd, 1, 200000)),
  };
  // 可选字段缺失时不补键，避免旧场景序列化和既有签名产生无关漂移。
  if (typeof raw.bloomMsaaEnabled === 'boolean') normalized.bloomMsaaEnabled = raw.bloomMsaaEnabled;
  else delete normalized.bloomMsaaEnabled;
  return normalized;
}

function visible(entity: Obj, entities: Obj): boolean {
  const visited = new Set<Obj>();
  for (let current = entity; !visited.has(current);) {
    if (current.visible === false) return false;
    visited.add(current);
    if (typeof current.parentId !== 'string' || !entities[current.parentId]) break;
    current = object(entities[current.parentId]);
  }
  return true;
}
function legacyLighting(scene: Obj, settings: Obj): SceneLightingConfig {
  const rawTheme = settings.theme, theme = object(rawTheme), hasTheme = rawTheme !== null && rawTheme !== undefined && Object.keys(theme).length > 0;
  if (hasTheme) requireVersion(theme, 1, '旧场景主题');
  const shadows = object(settings.shadows), entities = object(scene.entities), skybox = object(settings.skybox);
  const shadowEnabled = boolean(shadows.enabled, true), mode = shadows.mode;
  const hasDirectional = Object.values(entities).some(value => {
    const entity = object(value), light = object(object(entity.components).light);
    return light.lightKind === 'directional' && finite(light.intensity, 1, 0, Number.MAX_VALUE) > 0 && visible(entity, entities);
  });
  const disabledLightIds = hasTheme ? Object.entries(entities).flatMap(([id, value]) => {
    const light = object(object(object(value).components).light);
    return Object.keys(light).length && (light.lightKind === 'directional' || light.lightKind === 'hemispheric' || light.lightKind === undefined) ? [id] : [];
  }) : [];
  const realtimeLimited = !hasTheme && shadowEnabled && mode === 'realtime';
  const environmentIntensity = hasTheme ? Math.min(finite(theme.environmentIntensity, 1, 0, 5), finite(shadows.iblIntensityMax, .45, 0, 5))
    : realtimeLimited ? Math.min(finite(skybox.intensity, 1, 0, 5), finite(shadows.iblIntensityMax, .45, 0, 5)) : finite(skybox.intensity, 1, 0, 5);
  return normalizeSceneLightingConfig({ version: 2,
    main: { source: !hasTheme && hasDirectional ? 'scene' : 'managed',
      enabled: hasTheme || hasDirectional || (shadowEnabled && (mode === 'hybrid' || mode === 'realtime')),
      color: hasTheme ? theme.mainColor : undefined, azimuthDegrees: shadows.sunAzimuthDegrees,
      elevationDegrees: shadows.sunElevationDegrees, intensity: shadows.sunIntensity },
    fill: { intensity: hasTheme || realtimeLimited ? finite(shadows.fillIntensity, .2, 0, 4) : .8,
      color: hasTheme ? theme.fillColor : undefined, groundColor: hasTheme ? theme.groundColor : undefined },
    environmentIntensity, disabledLightIds, allowDayNightCycle: !hasTheme,
    shadows: { ...without(shadows, ['mode', 'bake', 'catcherEnabled', 'sunAzimuthDegrees', 'sunElevationDegrees', 'sunIntensity', 'fillIntensity', 'iblIntensityMax']), enabled: shadowEnabled },
    bake: settings.lightingBake, policy: settings.lightingPolicy, result: settings.lightingBakeResult,
  });
}

/** 只读取当前唯一配置；旧文档按有效运行规则派生，绝不把旧字段覆盖到已存在的新配置上。 */
export function getSceneLightingConfig(value: unknown): SceneLightingConfig {
  const scene = object(value), settings = object(scene.sceneSettings);
  return Object.hasOwn(settings, 'lighting') ? normalizeSceneLightingConfig(settings.lighting) : legacyLighting(scene, settings);
}
export function getSceneAppearanceConfig(value: unknown): SceneAppearanceConfig {
  const settings = object(object(value).sceneSettings);
  if (Object.hasOwn(settings, 'appearance')) return normalizeSceneAppearanceConfig(settings.appearance);
  const theme = object(settings.theme);
  if (!Object.keys(theme).length) return normalizeSceneAppearanceConfig(undefined);
  requireVersion(theme, 1, '旧场景主题');
  return normalizeSceneAppearanceConfig({ ...without(theme, ['presetId', 'environmentLighting', 'fillColor', 'groundColor', 'mainColor', 'environmentIntensity']),
    version: 1, toneMappingEnabled: true });
}

/** 不写盘、不烘焙、不修改实体；旧 v1 GI 保留原签名，只有新的严格输入签名才可能证明有效。 */
export function migrateSceneLightingDocument<T extends { sceneSettings?: unknown }>(scene: T): T & {
  sceneSettings: Record<string, unknown> & { lighting: SceneLightingConfig; appearance: SceneAppearanceConfig };
} {
  const settings = object(scene.sceneSettings);
  const next = { ...without(settings, ['theme', 'shadows', 'lightingBake', 'lightingPolicy', 'lightingBakeResult']),
    lighting: getSceneLightingConfig(scene), appearance: getSceneAppearanceConfig(scene) };
  if (JSON.stringify(next) === JSON.stringify(settings)) return scene as T & { sceneSettings: typeof next };
  return { ...scene, sceneSettings: next };
}
