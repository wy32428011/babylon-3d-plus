const LOCAL_EDITOR_ASSET_PREFIX = 'editor-asset://local/';
const DEV_LOCAL_ASSET_PREFIX = '/__editor_asset__/';

/** 判断资源是否来自编辑器授权的本地资产协议。 */
export function isLocalEditorAssetUrl(sourceUrl: string): boolean {
  return sourceUrl.startsWith(LOCAL_EDITOR_ASSET_PREFIX);
}

/** 解码 editor-asset 本地资源路径，失败时返回 null 交给调用方降级处理。 */
export function decodeLocalEditorAssetPath(sourceUrl: string): string | null {
  if (!isLocalEditorAssetUrl(sourceUrl)) return null;

  try {
    return decodeURIComponent(sourceUrl.slice(LOCAL_EDITOR_ASSET_PREFIX.length));
  } catch {
    return null;
  }
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

  return `${DEV_LOCAL_ASSET_PREFIX}${encodeURIComponent(filePath)}`;
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
