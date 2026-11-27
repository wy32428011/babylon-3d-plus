import {
  normalizeSceneAppearanceConfig,
  normalizeSceneLightingConfig,
  type SceneAppearanceConfig,
  type SceneLightingConfig,
} from './sceneLightingConfig.ts';

export type WarehouseLightingPresetId = 'warehouse-bright' | 'warehouse-dark-screen' | 'warehouse-outdoor';
export type WarehouseQualityTier = 'performance' | 'standard' | 'high';

export type WarehouseLightingPresetDefinition = {
  readonly id: WarehouseLightingPresetId;
  readonly name: string;
  readonly subtitle: string;
};

export type WarehouseQualityTierDefinition = {
  readonly id: WarehouseQualityTier;
  readonly name: string;
  readonly subtitle: string;
};

export const WAREHOUSE_LIGHTING_PRESETS: readonly WarehouseLightingPresetDefinition[] = Object.freeze([
  Object.freeze({ id: 'warehouse-bright', name: '明亮洁净仓', subtitle: '中性白光 · 清晰地坪 · 默认推荐' }),
  Object.freeze({ id: 'warehouse-dark-screen', name: '科技暗黑大屏', subtitle: '深蓝底色 · 突出告警与轨迹' }),
  Object.freeze({ id: 'warehouse-outdoor', name: '室外物流园区', subtitle: '日光主投 · 远距级联阴影' }),
]);

export const WAREHOUSE_QUALITY_TIERS: readonly WarehouseQualityTierDefinition[] = Object.freeze([
  Object.freeze({ id: 'performance', name: '流畅', subtitle: '仅地面阴影 + 底盘软影，适合超大库/核显' }),
  Object.freeze({ id: 'standard', name: '标准', subtitle: '过滤小货物 + 半分辨率 SSAO2，均衡推荐' }),
  Object.freeze({ id: 'high', name: '高清', subtitle: '2048 级联阴影 + 高精度 SSAO2，适合独显大屏' }),
]);

/** 应用智慧仓储零 Blender 实时预设，保留既有规则、已保存烘焙结果和禁用灯清单。 */
export function applyWarehouseLightingPreset(
  currentLighting: SceneLightingConfig | undefined,
  currentAppearance: SceneAppearanceConfig | undefined,
  presetId: WarehouseLightingPresetId,
): { lighting: SceneLightingConfig; appearance: SceneAppearanceConfig } {
  const lighting = normalizeSceneLightingConfig(currentLighting);
  const appearance = normalizeSceneAppearanceConfig(currentAppearance);
  const commonShadows: SceneLightingConfig['shadows'] = {
    ...lighting.shadows,
    enabled: true,
    managementMode: 'automatic',
    respectEntityShadowOverrides: true,
    skipGeneratedCargoCasters: true,
    skipSmallCastersMeters: 0.8,
  };
  delete commonShadows.receiverScope;
  delete commonShadows.mobileBlobShadows;

  if (presetId === 'warehouse-bright') {
    return {
      lighting: normalizeSceneLightingConfig({
        ...lighting,
        main: { ...lighting.main, source: 'managed', enabled: true, color: '#ffffff', azimuthDegrees: 42, elevationDegrees: 62, intensity: 1.15 },
        fill: { ...lighting.fill, intensity: 0.55, color: '#f0f5fa', groundColor: '#7a838e' },
        environmentIntensity: 0.9,
        environment: { ...lighting.environment, source: 'sandbox', preset: 'warehouse-bright', rotationDegrees: 0 },
        shadows: { ...commonShadows, quality: 'balanced', darkness: 0.42, distanceMeters: 100 },
        bake: { ...lighting.bake, enabled: false },
      }),
      appearance: normalizeSceneAppearanceConfig({
        ...appearance,
        backgroundColor: '#e3eaf1',
        skyboxVisible: false,
        exposure: 1.0,
        contrast: 1.05,
        toneMappingEnabled: true,
        glowIntensity: 0.4,
        bloomEnabled: false,
        ssaoMode: 'balanced',
        fogEnabled: false,
      }),
    };
  }

  if (presetId === 'warehouse-dark-screen') {
    return {
      lighting: normalizeSceneLightingConfig({
        ...lighting,
        main: { ...lighting.main, source: 'managed', enabled: true, color: '#c8defa', azimuthDegrees: 315, elevationDegrees: 52, intensity: 0.8 },
        fill: { ...lighting.fill, intensity: 0.45, color: '#7d9ac4', groundColor: '#243247' },
        environmentIntensity: 0.55,
        environment: { ...lighting.environment, source: 'sandbox', preset: 'warehouse-dark', rotationDegrees: 0 },
        shadows: { ...commonShadows, quality: 'balanced', darkness: 0.52, distanceMeters: 100 },
        bake: { ...lighting.bake, enabled: false },
      }),
      appearance: normalizeSceneAppearanceConfig({
        ...appearance,
        backgroundColor: '#0c1624',
        skyboxVisible: false,
        exposure: 1.05,
        contrast: 1.1,
        toneMappingEnabled: true,
        glowIntensity: 0.65,
        bloomEnabled: false,
        ssaoMode: 'balanced',
        fogEnabled: true,
        fogColor: '#102136',
        fogStart: 180,
        fogEnd: 750,
      }),
    };
  }

  return {
    lighting: normalizeSceneLightingConfig({
      ...lighting,
      main: { ...lighting.main, source: 'managed', enabled: true, color: '#fff6e8', azimuthDegrees: 52, elevationDegrees: 56, intensity: 1.35 },
      fill: { ...lighting.fill, intensity: 0.5, color: '#d8e9ff', groundColor: '#6f7378' },
      environmentIntensity: 1.0,
      environment: { ...lighting.environment, source: 'sandbox', preset: 'warehouse-bright', rotationDegrees: 25 },
      shadows: { ...commonShadows, quality: 'quality', darkness: 0.35, distanceMeters: 160 },
      bake: { ...lighting.bake, enabled: false },
    }),
    appearance: normalizeSceneAppearanceConfig({
      ...appearance,
      backgroundColor: '#d9e6f2',
      skyboxVisible: true,
      exposure: 1.0,
      contrast: 1.05,
      toneMappingEnabled: true,
      glowIntensity: 0.35,
      bloomEnabled: false,
      ssaoMode: 'balanced',
      fogEnabled: false,
    }),
  };
}

/** 应用仓储性能/画质三档配置（流畅 / 标准 / 高清），保持光源风格与方向不变。 */
export function applyWarehouseQualityTier(
  currentLighting: SceneLightingConfig | undefined,
  currentAppearance: SceneAppearanceConfig | undefined,
  tier: WarehouseQualityTier,
): { lighting: SceneLightingConfig; appearance: SceneAppearanceConfig } {
  const lighting = normalizeSceneLightingConfig(currentLighting);
  const appearance = normalizeSceneAppearanceConfig(currentAppearance);
  const nextShadows: SceneLightingConfig['shadows'] = {
    ...lighting.shadows,
    enabled: true,
    managementMode: 'automatic',
    respectEntityShadowOverrides: true,
    skipGeneratedCargoCasters: true,
  };
  const nextAppearance: SceneAppearanceConfig = { ...appearance };

  if (tier === 'performance') {
    nextShadows.quality = 'performance';
    nextShadows.receiverScope = 'ground-only';
    nextShadows.skipSmallCastersMeters = 0.8;
    nextShadows.mobileBlobShadows = true;
    delete nextAppearance.ssaoMode;
    nextAppearance.bloomEnabled = false;
  } else if (tier === 'standard') {
    nextShadows.quality = 'balanced';
    delete nextShadows.receiverScope;
    nextShadows.distanceMeters = 100;
    nextShadows.skipSmallCastersMeters = 0.8;
    delete nextShadows.mobileBlobShadows;
    nextAppearance.ssaoMode = 'balanced';
  } else {
    nextShadows.quality = 'quality';
    delete nextShadows.receiverScope;
    nextShadows.distanceMeters = 120;
    nextShadows.skipSmallCastersMeters = 0.5;
    delete nextShadows.mobileBlobShadows;
    nextAppearance.ssaoMode = 'high';
  }

  return {
    lighting: normalizeSceneLightingConfig({ ...lighting, shadows: nextShadows }),
    appearance: normalizeSceneAppearanceConfig(nextAppearance),
  };
}

/** 判断当前配置是否匹配任一仓储画质档，否则返回 custom。 */
export function detectWarehouseQualityTier(
  lighting: SceneLightingConfig,
  appearance: SceneAppearanceConfig,
): WarehouseQualityTier | 'custom' {
  const { shadows } = lighting;
  if (!shadows.enabled || shadows.managementMode !== 'automatic' || !shadows.respectEntityShadowOverrides || !shadows.skipGeneratedCargoCasters) {
    return 'custom';
  }
  if (
    shadows.quality === 'performance'
    && shadows.receiverScope === 'ground-only'
    && shadows.skipSmallCastersMeters === 0.8
    && shadows.mobileBlobShadows === true
    && !appearance.ssaoMode
    && !appearance.bloomEnabled
  ) {
    return 'performance';
  }
  if (
    shadows.quality === 'balanced'
    && !shadows.receiverScope
    && shadows.distanceMeters === 100
    && shadows.skipSmallCastersMeters === 0.8
    && !shadows.mobileBlobShadows
    && appearance.ssaoMode === 'balanced'
  ) {
    return 'standard';
  }
  if (
    shadows.quality === 'quality'
    && !shadows.receiverScope
    && shadows.distanceMeters === 120
    && shadows.skipSmallCastersMeters === 0.5
    && !shadows.mobileBlobShadows
    && appearance.ssaoMode === 'high'
  ) {
    return 'high';
  }
  return 'custom';
}
