export const SCENE_MODEL_ENTRANCE_EFFECTS = ['fade', 'scan', 'dissolve', 'hologram', 'particles', 'assembly', 'radial', 'stagger'] as const;
export type SceneModelEntranceEffect = (typeof SCENE_MODEL_ENTRANCE_EFFECTS)[number];

export type SceneModelEntranceSettings = {
  enabled: boolean;
  effect: SceneModelEntranceEffect;
  durationSeconds: number;
  delaySeconds: number;
  color: string;
  intensity: number;
  axis: 'x' | 'y' | 'z';
  reverse: boolean;
  staggerSeconds: number;
  particleCount: number;
  particleSize: number;
  spreadMeters: number;
  assemblyDistanceMeters: number;
  loop: boolean;
  loopIntervalSeconds: number;
  scope: 'all' | 'selected';
  targetEntityIds: string[];
};

export const DEFAULT_SCENE_MODEL_ENTRANCE_SETTINGS: SceneModelEntranceSettings = {
  enabled: false, effect: 'scan', durationSeconds: 2.5, delaySeconds: 0,
  color: '#00ccff', intensity: 1, axis: 'y', reverse: false, staggerSeconds: 0.15,
  particleCount: 600, particleSize: 3, spreadMeters: 3, assemblyDistanceMeters: 1.5,
  loop: false, loopIntervalSeconds: 1, scope: 'all', targetEntityIds: [],
};

/** 旧场景保持停用；零值和隐藏的效果参数原样保留，异常输入回退或钳制。 */
export function normalizeSceneModelEntranceSettings(value: unknown): SceneModelEntranceSettings {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const defaults = DEFAULT_SCENE_MODEL_ENTRANCE_SETTINGS;
  const number = (key: keyof SceneModelEntranceSettings, min: number, max: number) => {
    const input = source[key];
    return typeof input === 'number' && Number.isFinite(input)
      ? Math.min(max, Math.max(min, input)) : defaults[key] as number;
  };
  return {
    enabled: source.enabled === true,
    effect: SCENE_MODEL_ENTRANCE_EFFECTS.includes(source.effect as SceneModelEntranceEffect)
      ? source.effect as SceneModelEntranceEffect : defaults.effect,
    durationSeconds: number('durationSeconds', 0.2, 30), delaySeconds: number('delaySeconds', 0, 30),
    color: typeof source.color === 'string' && /^#[\da-f]{6}$/i.test(source.color) ? source.color : defaults.color,
    intensity: number('intensity', 0, 5),
    axis: source.axis === 'x' || source.axis === 'z' ? source.axis : 'y',
    reverse: source.reverse === true, staggerSeconds: number('staggerSeconds', 0, 5),
    particleCount: Math.round(number('particleCount', 50, 5000)), particleSize: number('particleSize', 1, 12),
    spreadMeters: number('spreadMeters', 0, 30), assemblyDistanceMeters: number('assemblyDistanceMeters', 0, 30),
    loop: source.loop === true, loopIntervalSeconds: number('loopIntervalSeconds', 0, 30),
    scope: source.scope === 'selected' ? 'selected' : 'all',
    targetEntityIds: Array.isArray(source.targetEntityIds)
      ? [...new Set(source.targetEntityIds.filter((id): id is string => typeof id === 'string').map(id => id.trim()).filter(Boolean))]
      : [],
  };
}
