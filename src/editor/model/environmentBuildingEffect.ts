/** 环境不是普通场景实体，保留稳定绑定 ID，替换环境资源后仍绑定当前环境。 */
export const ENVIRONMENT_EFFECT_TARGET_ID = '__scene_environment_model__';

/** 环境外观只允许可作用于现有建筑几何的八类效果。 */
export const ENVIRONMENT_BUILDING_EFFECT_KINDS = [
  'model-outline', 'model-edges', 'model-emissive', 'model-scan',
  'height-gradient', 'hologram', 'xray', 'dissolve',
] as const;
export type EnvironmentBuildingEffectKind = (typeof ENVIRONMENT_BUILDING_EFFECT_KINDS)[number];

export function isEnvironmentBuildingEffectKind(kind: unknown): kind is EnvironmentBuildingEffectKind {
  return typeof kind === 'string' && (ENVIRONMENT_BUILDING_EFFECT_KINDS as readonly string[]).includes(kind);
}

