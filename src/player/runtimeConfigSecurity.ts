const SENSITIVE_RUNTIME_CONFIG_KEYS = new Set([
  'token', 'accesstoken', 'password', 'username', 'secret', 'apikey', 'authorization', 'cookie',
  'clientsecret', 'credential', 'credentials',
]);

function normalizeSensitiveKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 判断运行配置字段名是否可能承载密码、令牌、API Key 或凭据。 */
export function isSensitiveRuntimeConfigKey(value: string): boolean {
  const normalized = normalizeSensitiveKey(value);
  return SENSITIVE_RUNTIME_CONFIG_KEYS.has(normalized)
    || normalized.endsWith('token')
    || normalized.endsWith('password')
    || normalized.endsWith('secret')
    || normalized.endsWith('apikey')
    || normalized.endsWith('apikeys')
    || normalized.endsWith('credential')
    || normalized.endsWith('credentials');
}

/** 递归拒绝会经公开 Viewer 接口下发的敏感扩展配置字段。 */
export function assertNoSensitiveRuntimeConfig(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveRuntimeConfig(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveRuntimeConfigKey(key)) throw new Error(`${path}.${key} 不能包含密码、令牌、API Key 或凭据。`);
    assertNoSensitiveRuntimeConfig(child, `${path}.${key}`);
  }
}
