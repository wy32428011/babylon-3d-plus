type ParameterDefinition = { key: string; type: string; unit?: string };
export type SceneParameterConfig = { parameters: ParameterDefinition[]; bindings: unknown[]; rules?: unknown[] };

export function referencesSceneParameter(value: unknown, key?: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if ('param' in value && typeof value.param === 'string' && (key === undefined || value.param === key)) return true;
  return Object.values(value).some(item => referencesSceneParameter(item, key));
}

/** 参数定义、绑定和规则全量采用新版，旧配置不再覆盖或拼接到新脚本。 */
export function createInstanceParameterConfig<T extends SceneParameterConfig>(_previous: T, next: T, _context: string): T {
  return structuredClone(next);
}

/** 只保留新版 key：旧显式值优先，新增或未保存的值取新版默认；不转换类型或截断范围。 */
export function reconcileSceneParameterValues<T>(parameters: readonly { key: string; defaultValue: T }[], values: unknown): Record<string, T> {
  const saved = values !== null && typeof values === 'object' && !Array.isArray(values)
    ? values as Record<string, unknown> : {};
  return Object.fromEntries(parameters.map(definition => [definition.key,
    structuredClone(Object.hasOwn(saved, definition.key) ? saved[definition.key] : definition.defaultValue),
  ])) as Record<string, T>;
}

export function isSceneParameterConfig(value: unknown): value is SceneParameterConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as SceneParameterConfig;
  return Array.isArray(config.parameters) && config.parameters.every(definition => definition
    && typeof definition.key === 'string' && typeof definition.type === 'string')
    && Array.isArray(config.bindings) && (config.rules === undefined || Array.isArray(config.rules));
}
