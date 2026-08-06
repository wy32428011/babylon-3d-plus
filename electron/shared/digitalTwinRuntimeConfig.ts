const MAX_ALLOWED_PARENT_ORIGINS = 64;
const MAX_ORIGIN_LENGTH = 2048;

export type DigitalTwinRuntimeConfigLike = {
  projectId: string;
  mqttBrokerUrl: string | null;
  apiBaseUrl: string | null;
  runtimeEnabled: boolean;
  configJson: string | null;
  updatedAt?: string | null;
};

export type DigitalTwinRuntimeConfigSavePayload = {
  projectId: string;
  mqttBrokerUrl: string | null;
  apiBaseUrl: string | null;
  runtimeEnabled: boolean;
  configJson: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRuntimeConfigJson(configJson?: string | null): Record<string, unknown> {
  if (!configJson?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson) as unknown;
  } catch {
    throw new Error('数字孪生运行配置 configJson 必须是合法 JSON 对象。');
  }
  if (!isRecord(parsed)) throw new Error('数字孪生运行配置 configJson 必须是合法 JSON 对象。');
  return parsed;
}

/** 校验并规范化允许嵌入 Viewer 的父页面 Origin。 */
export function normalizeDigitalTwinAllowedParentOrigins(values: readonly unknown[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_ALLOWED_PARENT_ORIGINS) {
    throw new Error(`父页面 Origin 最多允许 ${MAX_ALLOWED_PARENT_ORIGINS} 项。`);
  }

  const origins: string[] = [];
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`父页面 Origin 第 ${index + 1} 项不能为空。`);
    }
    const source = value.trim();
    if (source.length > MAX_ORIGIN_LENGTH) throw new Error(`父页面 Origin 第 ${index + 1} 项过长。`);
    if (source === '*') throw new Error('父页面 Origin 禁止使用通配符 *。');

    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new Error(`父页面 Origin 第 ${index + 1} 项格式无效。`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`父页面 Origin 第 ${index + 1} 项仅支持 HTTP/HTTPS。`);
    }
    if (url.username || url.password) {
      throw new Error(`父页面 Origin 第 ${index + 1} 项不能包含用户名或密码。`);
    }
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
      throw new Error(`父页面 Origin 第 ${index + 1} 项不能包含路径、Query 或 Fragment。`);
    }

    const origin = url.origin;
    if (seen.has(origin)) throw new Error(`父页面 Origin 重复：${origin}`);
    seen.add(origin);
    origins.push(origin);
  });
  return origins;
}

/** 从现有扩展配置读取父页面 Origin，并拒绝会导致字段丢失的非法 integration 结构。 */
export function readDigitalTwinAllowedParentOrigins(configJson?: string | null): string[] {
  const config = parseRuntimeConfigJson(configJson);
  if (!Object.hasOwn(config, 'integration')) return [];
  if (!isRecord(config.integration)) throw new Error('数字孪生运行配置 integration 必须是 JSON 对象。');
  if (!Object.hasOwn(config.integration, 'allowedParentOrigins')) return [];
  if (!Array.isArray(config.integration.allowedParentOrigins)) {
    throw new Error('数字孪生运行配置 integration.allowedParentOrigins 必须是数组。');
  }
  return normalizeDigitalTwinAllowedParentOrigins(config.integration.allowedParentOrigins);
}

/** 使用数据中台服务地址推导大屏父页面 Origin；服务地址允许包含部署路径。 */
export function resolveDataPlatformParentOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error('数据中台地址无效，无法自动配置父页面 Origin。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('数据中台地址必须是不含凭据的 HTTP/HTTPS URL。');
  }
  return url.origin;
}

/** 发布弹窗默认保留已有白名单，并自动补入当前数据中台 Origin。 */
export function createDefaultDigitalTwinAllowedParentOrigins(
  baseUrl: string,
  configJson?: string | null,
): string[] {
  const origins = readDigitalTwinAllowedParentOrigins(configJson);
  const dataPlatformOrigin = resolveDataPlatformParentOrigin(baseUrl);
  return origins.includes(dataPlatformOrigin) ? origins : [...origins, dataPlatformOrigin];
}

/** 仅覆盖 integration.allowedParentOrigins，保留所有未知顶层和 integration 子字段。 */
export function mergeDigitalTwinAllowedParentOrigins(
  configJson: string | null | undefined,
  allowedParentOrigins: readonly unknown[],
): string {
  const config = parseRuntimeConfigJson(configJson);
  const integration = Object.hasOwn(config, 'integration') ? config.integration : {};
  if (!isRecord(integration)) throw new Error('数字孪生运行配置 integration 必须是 JSON 对象。');

  return JSON.stringify({
    ...config,
    integration: {
      ...integration,
      allowedParentOrigins: normalizeDigitalTwinAllowedParentOrigins(allowedParentOrigins),
    },
  });
}

/** 构造保存请求时保留既有连接参数，只合并父页面 Origin。 */
export function buildDigitalTwinRuntimeConfigSavePayload(
  runtimeConfig: DigitalTwinRuntimeConfigLike,
  allowedParentOrigins: readonly unknown[],
): DigitalTwinRuntimeConfigSavePayload {
  return {
    projectId: runtimeConfig.projectId,
    mqttBrokerUrl: runtimeConfig.mqttBrokerUrl,
    apiBaseUrl: runtimeConfig.apiBaseUrl,
    runtimeEnabled: runtimeConfig.runtimeEnabled,
    configJson: mergeDigitalTwinAllowedParentOrigins(runtimeConfig.configJson, allowedParentOrigins),
  };
}
