import { normalizeSceneLightingConfig, normalizeSceneAppearanceConfig,
  type SceneLightingConfig, type SceneAppearanceConfig } from './sceneLightingConfig.ts';

export const GLB_STANDARD_PREVIEW_PRESET_ID = 'glb-standard-preview';
/** 对应内置环境资源的稳定修订；资源替换时同步更新，避免复用旧 GI。 */
export const GLB_STANDARD_ENVIRONMENT_ID = 'sandbox-default-v1';
export const GLB_STANDARD_ENVIRONMENT_ROTATION_DEGREES = 5.54 * 180 / Math.PI;

/** 新建工作场景只补齐 IBL；保留已配置主光和补光，确保 StandardMaterial 基础对象正常受光。 */
export function createDefaultEditorLightingConfig(): SceneLightingConfig {
  return { ...normalizeSceneLightingConfig(undefined),
    environment: { source: 'sandbox', rotationDegrees: GLB_STANDARD_ENVIRONMENT_ROTATION_DEGREES } };
}

/** 显式应用预览基线，保留规则、烘焙资源与不相关扩展；真实输入改变后旧结果自然过期。 */
export function createGlbStandardPreviewLightingConfig(
  current?: SceneLightingConfig,
  sceneLightIds: string[] = [],
): SceneLightingConfig {
  const lighting = normalizeSceneLightingConfig(current);
  return normalizeSceneLightingConfig({ ...lighting,
    main: { ...lighting.main, source: 'managed', enabled: false },
    fill: { ...lighting.fill, intensity: 0 },
    environmentIntensity: 1,
    environment: { ...lighting.environment, source: 'sandbox', rotationDegrees: GLB_STANDARD_ENVIRONMENT_ROTATION_DEGREES },
    disabledLightIds: [...lighting.disabledLightIds, ...sceneLightIds],
    allowDayNightCycle: false,
    shadows: { ...lighting.shadows, enabled: false },
    bake: { ...lighting.bake, enabled: false },
  });
}

/** Sandbox 普通模式不默认使用色调映射；背景隐藏不关闭环境照明。 */
export function createGlbStandardPreviewAppearanceConfig(current?: SceneAppearanceConfig): SceneAppearanceConfig {
  const appearance = normalizeSceneAppearanceConfig(current);
  return normalizeSceneAppearanceConfig({ ...appearance, skyboxVisible: false, exposure: 1, contrast: 1,
    toneMappingEnabled: false, bloomEnabled: false, fogEnabled: false });
}
