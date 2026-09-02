export type DataPlatformDeepLink = {
  baseUrl: string;
  webBaseUrl?: string;
  projectId: string;
};

const DIGITAL_TWIN_PROTOCOL = 'zending3d:';
const DIGITAL_TWIN_OPEN_HOST = 'open-project';
const PROJECT_ID_PATTERN = /^[1-9]\d{0,63}$/;

/** 解析数据中台生成的项目深链；非法协议、凭据或项目 ID 直接忽略。 */
export function parseDataPlatformDeepLink(value: string): DataPlatformDeepLink | null {
  if (typeof value !== 'string' || !value.trim()) return null;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== DIGITAL_TWIN_PROTOCOL || url.hostname !== DIGITAL_TWIN_OPEN_HOST) return null;
    const projectId = url.searchParams.get('projectId')?.trim() ?? '';
    const baseUrlValue = url.searchParams.get('baseUrl')?.trim() ?? '';
    if (!PROJECT_ID_PATTERN.test(projectId) || !baseUrlValue) return null;

    const normalizedBaseUrl = normalizeDeepLinkHttpRoot(baseUrlValue);
    if (!normalizedBaseUrl) return null;
    const webBaseUrlValue = url.searchParams.get('webBaseUrl')?.trim() ?? '';
    const normalizedWebBaseUrl = webBaseUrlValue ? normalizeDeepLinkHttpRoot(webBaseUrlValue) : null;
    if (webBaseUrlValue && !normalizedWebBaseUrl) return null;
    return {
      baseUrl: normalizedBaseUrl,
      ...(normalizedWebBaseUrl ? { webBaseUrl: normalizedWebBaseUrl } : {}),
      projectId,
    };
  } catch {
    return null;
  }
}

function normalizeDeepLinkHttpRoot(value: string): string | null {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      return null;
    }
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** 从 Electron 启动参数中提取第一个合法的数字孪生项目深链。 */
export function findDataPlatformDeepLink(argv: readonly string[]): DataPlatformDeepLink | null {
  for (const argument of argv) {
    const parsed = parseDataPlatformDeepLink(argument);
    if (parsed) return parsed;
  }
  return null;
}
