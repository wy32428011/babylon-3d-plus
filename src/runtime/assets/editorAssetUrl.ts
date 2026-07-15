const LOCAL_EDITOR_ASSET_PREFIX = 'editor-asset://local/';
const DEV_LOCAL_ASSET_PREFIX = '/__editor_asset__/';

/** 判断资源是否来自编辑器授权的本地资产协议。 */
export function isLocalEditorAssetUrl(sourceUrl: string): boolean {
  return sourceUrl.startsWith(LOCAL_EDITOR_ASSET_PREFIX);
}

/** 解析规范 editor-asset URL，查询参数仅用于版本控制，不参与本地路径解码。 */
function parseLocalEditorAssetUrl(sourceUrl: string): URL | null {
  if (!isLocalEditorAssetUrl(sourceUrl)) return null;

  try {
    const parsed = new URL(sourceUrl);
    return parsed.protocol === 'editor-asset:' && parsed.hostname === 'local' ? parsed : null;
  } catch {
    return null;
  }
}

/** 解码 editor-asset 本地资源路径，失败时返回 null 交给调用方降级处理。 */
export function decodeLocalEditorAssetPath(sourceUrl: string): string | null {
  const parsed = parseLocalEditorAssetUrl(sourceUrl);
  if (!parsed) return null;

  try {
    return decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
}

/** 读取本地资产 URL 的版本查询参数，浏览器开发模式映射路径时继续保留缓存隔离语义。 */
function getLocalEditorAssetSearch(sourceUrl: string): string {
  return parseLocalEditorAssetUrl(sourceUrl)?.search ?? '';
}

/** 将本地文件路径重新编码成 SceneDocument 允许保存的 editor-asset URL。 */
export function createLocalEditorAssetUrl(filePath: string): string {
  return `${LOCAL_EDITOR_ASSET_PREFIX}${encodeURIComponent(filePath)}`;
}

/** 在普通浏览器开发模式下，把 editor-asset URL 映射到 Vite 的 /@fs/ 静态读取入口。 */
export function resolveRuntimeAssetUrl(sourceUrl: string): string {
  const filePath = decodeLocalEditorAssetPath(sourceUrl);
  if (!filePath) return sourceUrl;

  if (typeof window !== 'undefined' && window.editorApi) {
    return sourceUrl;
  }

  if (!import.meta.env.DEV) {
    return sourceUrl;
  }

  return `${DEV_LOCAL_ASSET_PREFIX}${encodeURIComponent(filePath)}${getLocalEditorAssetSearch(sourceUrl)}`;
}

/** 解析模型包内的相对资源，仍保持 editor-asset 安全协议作为规范来源。 */
export function resolveRelativeEditorAssetUrl(
  sourceUrl: string,
  relativePath: string,
  allowedExtensionPattern: RegExp,
): string | null {
  if (!relativePath || relativePath.includes('..') || /^(?:[a-z]+:|\/|\\)/i.test(relativePath)) return null;
  if (!allowedExtensionPattern.test(relativePath)) return null;

  const sourcePath = decodeLocalEditorAssetPath(sourceUrl);
  if (!sourcePath) return null;

  const separatorIndex = Math.max(sourcePath.lastIndexOf('\\'), sourcePath.lastIndexOf('/'));
  if (separatorIndex < 0) return null;

  const directory = sourcePath.slice(0, separatorIndex + 1);
  const separator = directory.includes('\\') ? '\\' : '/';
  const normalizedRelativePath = relativePath.replace(/[\\/]+/g, separator);
  return createLocalEditorAssetUrl(directory + normalizedRelativePath);
}
