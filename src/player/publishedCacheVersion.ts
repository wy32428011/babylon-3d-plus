import { hashSkyboxContent } from '../runtime/babylon/skyboxContentHash.ts';
import type { PublishedResourceIdentity } from '../runtime/assets/publishedAssetCache.ts';
import { readUtf8ResponseText } from '../shared/text/strictUtf8.ts';

type CacheConfig = { cacheRevision?: string; paths: { scene: string; assetManifest: string; assetBase: string } };
export type PublishedCacheVersion = {
  revision: string;
  assetManifest?: unknown;
  resources?: ReadonlyMap<string, PublishedResourceIdentity>;
};

/** 场景和清单是独立 HTTP 请求，启动前复核，避免热缓存掩盖下载期间的发布切换。 */
export async function verifyPublishedCacheVersion(config: CacheConfig, baseUrl: string,
  version: PublishedCacheVersion, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const response = await fetch(new URL('./runtime-config.json', baseUrl), { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`核对发布版本失败：HTTP ${response.status}。`);
  const latest = await response.json() as Partial<CacheConfig>;
  const changed = () => new Error('加载期间发布版本已变更，请重新加载场景。');
  if (!latest || latest.cacheRevision !== config.cacheRevision) throw changed();
  if (version.resources) {
    if (!latest.paths || latest.paths.assetBase !== config.paths.assetBase
      || latest.paths.assetManifest !== config.paths.assetManifest || latest.paths.scene !== config.paths.scene) throw changed();
    const checked = await loadPublishedCacheVersion(config, baseUrl, signal);
    if (checked?.revision !== version.revision) throw changed();
  }
  signal.throwIfAborted();
}

/** 旧格式没有发布号时，仅以完整内容哈希清单缓存资产；场景和清单仍实时读取。 */
export async function loadPublishedCacheVersion(config: CacheConfig, baseUrl: string, signal: AbortSignal): Promise<PublishedCacheVersion | null> {
  signal.throwIfAborted();
  if (config.cacheRevision) return { revision: config.cacheRevision };
  const base = new URL(baseUrl);
  const assetBase = new URL(config.paths.assetBase, base);
  const manifestUrl = new URL(config.paths.assetManifest, base);
  if (assetBase.origin !== base.origin || !assetBase.pathname.startsWith(base.pathname)
    || assetBase.pathname === base.pathname || !assetBase.pathname.endsWith('/') || assetBase.search || assetBase.hash
    || manifestUrl.origin !== base.origin || !manifestUrl.pathname.startsWith(base.pathname)) return null;
  const response = await fetch(manifestUrl.href, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`读取资源清单失败：HTTP ${response.status}。`);
  const manifest = JSON.parse(await readUtf8ResponseText(response, '发布资源清单')) as unknown;
  signal.throwIfAborted();
  if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || manifest.version !== 1
    || !('assets' in manifest) || !Array.isArray(manifest.assets) || !manifest.assets.length) return null;
  const resources = new Map<string, PublishedResourceIdentity>();
  for (const entry of manifest.assets) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string'
      || typeof entry.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(entry.sha256)
      || !Number.isSafeInteger(entry.size) || entry.size < 0) return null;
    let url: URL;
    try { url = new URL(entry.path, assetBase); } catch { return null; }
    if (url.origin !== base.origin || !url.pathname.startsWith(assetBase.pathname)
      || url.search || url.hash || url.username || url.password || resources.has(url.href)) return null;
    resources.set(url.href, { sha256: entry.sha256.toLowerCase(), size: entry.size });
  }
  // 清单排序不改变内容身份；资源根也参与指纹，避免配置迁移后误用解码缓存。
  const fingerprint = JSON.stringify([assetBase.href, [...resources].sort(([a], [b]) => a.localeCompare(b))]);
  const revision = `manifest-${await hashSkyboxContent(new TextEncoder().encode(fingerprint))}`;
  signal.throwIfAborted();
  return { revision, assetManifest: manifest, resources };
}
