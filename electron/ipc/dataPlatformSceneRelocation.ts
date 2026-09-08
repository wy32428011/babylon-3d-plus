import path from 'node:path';
import { captureSceneShadowBakeRelocation } from '../shared/sceneShadowBakeContract.js';
import { encodeAssetUrl } from './assetRegistry.js';
const LOCAL_ASSET_URL_PREFIX = 'editor-asset://local/';
const SCENE_URL_KEYS = new Set(['sourceUrl', 'thumbnailUrl', 'activeVariantUrl']);
const SCENE_PATH_KEYS = new Set(['sourcePath', 'packagePath', 'metadataPath', 'thumbnailPath', 'path']);
const SCENE_PATH_ARRAY_KEYS = new Set(['scriptPaths']);
const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** SOURCE 场景仅迁移本地资源位置，其余编辑内容完整透传。 */
export function relocateDataPlatformScene(parsed: unknown, editorRoot: string): unknown {
  const restoreBake = captureSceneShadowBakeRelocation(isPlainObject(parsed) ? parsed.scene : null);
  const rewritten = rewriteSceneValue(parsed, null, editorRoot);
  if (isPlainObject(rewritten) && restoreBake && !restoreBake(rewritten.scene)) {
    throw new Error('源工程资源迁移后与已烘焙阴影不一致，已停止打开以避免丢失原场景效果。');
  }
  return rewritten;
}

function rewriteSceneValue(value: unknown, key: string | null, editorRoot: string): unknown {
  if (typeof value === 'string') {
    if (value.startsWith(LOCAL_ASSET_URL_PREFIX) || (key && SCENE_URL_KEYS.has(key))) return rewriteSceneAssetUrl(value, editorRoot);
    if (key && SCENE_PATH_KEYS.has(key)) return rewriteSceneAssetPath(value, editorRoot) ?? value;
    return value;
  }
  if (Array.isArray(value)) {
    if (key && SCENE_PATH_ARRAY_KEYS.has(key)) {
      return value.map((item) => typeof item === 'string' ? rewriteSceneAssetPath(item, editorRoot) ?? item : item);
    }
    return value.map((item) => rewriteSceneValue(item, key, editorRoot));
  }
  if (!isPlainObject(value)) return value;

  const rewritten: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    rewritten[childKey] = rewriteSceneValue(childValue, childKey, editorRoot);
  }
  return rewritten;
}

function rewriteSceneAssetUrl(value: string, editorRoot: string): string {
  if (!value.startsWith(LOCAL_ASSET_URL_PREFIX)) return value;
  try {
    const url = new URL(value);
    const decoded = decodeURIComponent(url.pathname.slice(1));
    const rewrittenPath = rewriteSceneAssetPath(decoded, editorRoot);
    return rewrittenPath ? `${encodeAssetUrl(rewrittenPath)}${url.search}${url.hash}` : value;
  } catch {
    return value;
  }
}

function rewriteSceneAssetPath(value: string, editorRoot: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)(Assets\/(?:Models|Environments|Skyboxes|Cad|Images)(?:\/.*|$))/i);
  if (!match) return null;
  const relativeAssetPath = path.posix.normalize(match[1]);
  if (!/^Assets\/(?:Models|Environments|Skyboxes|Cad|Images)(?:\/|$)/i.test(relativeAssetPath)) return null;
  const targetPath = path.resolve(editorRoot, ...relativeAssetPath.split('/'));
  return isPathInside(editorRoot, targetPath) ? targetPath : null;
}
