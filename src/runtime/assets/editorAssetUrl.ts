const LOCAL_EDITOR_ASSET_PREFIX = 'editor-asset://local/';
const DEV_LOCAL_ASSET_PREFIX = '/__editor_asset__/';

/** Viewer 部署资源映射；键为虚拟 editor-asset URL，值为浏览器可读取的部署 URL。 */
export type DeploymentAssetManifestMap = Readonly<Record<string, string>> | ReadonlyMap<string, string>;

let deploymentAssetManifest: ReadonlyMap<string, string> | null = null;

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

/** 生成不含查询参数和片段的部署清单键，确保同一资产的不同版本查询仍命中同一文件。 */
function createDeploymentManifestKey(parsedUrl: URL): string {
  return `${LOCAL_EDITOR_ASSET_PREFIX}${parsedUrl.pathname.slice(1)}`;
}

/** 将清单值枚举为统一键值对，兼容普通对象和只读 Map。 */
function readDeploymentManifestEntries(manifest: DeploymentAssetManifestMap): Iterable<readonly [string, string]> {
  return manifest instanceof Map ? manifest.entries() : Object.entries(manifest);
}

/** 在映射后的部署 URL 上保留虚拟资源携带的查询参数和片段。 */
function appendVirtualAssetSuffix(targetUrl: string, parsedSourceUrl: URL): string {
  const hashIndex = targetUrl.indexOf('#');
  const targetWithoutHash = hashIndex >= 0 ? targetUrl.slice(0, hashIndex) : targetUrl;
  const targetHash = hashIndex >= 0 ? targetUrl.slice(hashIndex) : '';
  const search = parsedSourceUrl.search;
  const mergedSearch = search
    ? `${targetWithoutHash}${targetWithoutHash.includes('?') ? '&' : '?'}${search.slice(1)}`
    : targetWithoutHash;
  return `${mergedSearch}${targetHash || parsedSourceUrl.hash}`;
}

/** 安装 Viewer 部署清单映射；非法键、空目标或冲突映射会立即阻断启动。 */
export function installDeploymentAssetManifest(manifest: DeploymentAssetManifestMap): void {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('部署资源清单映射必须是对象或 Map。');
  }

  const nextManifest = new Map<string, string>();
  for (const [sourceUrl, targetUrl] of readDeploymentManifestEntries(manifest)) {
    const parsedSourceUrl = parseLocalEditorAssetUrl(sourceUrl);
    const normalizedTargetUrl = typeof targetUrl === 'string' ? targetUrl.trim() : '';
    if (!parsedSourceUrl) {
      throw new Error(`部署资源清单包含非法 editor-asset URL：${sourceUrl}`);
    }
    if (!normalizedTargetUrl) {
      throw new Error(`部署资源清单包含空目标 URL：${sourceUrl}`);
    }

    const manifestKey = createDeploymentManifestKey(parsedSourceUrl);
    const existingTargetUrl = nextManifest.get(manifestKey);
    if (existingTargetUrl && existingTargetUrl !== normalizedTargetUrl) {
      throw new Error(`部署资源清单包含冲突映射：${sourceUrl}`);
    }
    nextManifest.set(manifestKey, normalizedTargetUrl);
  }

  deploymentAssetManifest = nextManifest;
}

/** 清理 Viewer 部署清单映射，避免页面卸载或热更新后污染后续运行实例。 */
export function clearDeploymentAssetManifest(): void {
  deploymentAssetManifest = null;
}

/** 优先从已安装清单解析虚拟资源；未安装或未命中时返回 null 交给既有逻辑。 */
function resolveDeploymentAssetUrl(sourceUrl: string): string | null {
  if (!deploymentAssetManifest) return null;

  const parsedSourceUrl = parseLocalEditorAssetUrl(sourceUrl);
  if (!parsedSourceUrl) return null;

  const targetUrl = deploymentAssetManifest.get(createDeploymentManifestKey(parsedSourceUrl));
  return targetUrl ? appendVirtualAssetSuffix(targetUrl, parsedSourceUrl) : null;
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

/** 优先使用部署清单；未安装时保持原 Electron 与浏览器开发模式解析行为。 */
export function resolveRuntimeAssetUrl(sourceUrl: string): string {
  const deploymentAssetUrl = resolveDeploymentAssetUrl(sourceUrl);
  if (deploymentAssetUrl) return deploymentAssetUrl;

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
