export type PublishedReleaseFile = {
  path: string;
  url: string;
  size: number;
  sha256: string;
  contentType: string;
  storage: 'asset' | 'response';
};
export type PublishedReleaseManifest = {
  version: 1;
  cacheRevision: string;
  totalBytes: number;
  files: PublishedReleaseFile[];
};

const CONTROL_FILES = new Set(['runtime-config.json', 'release-cache-manifest.json', 'published-cache-worker.js', 'README.md']);

/** 完整缓存清单独立于资源逻辑地址映射；绝不以目录前缀代替逐文件授权。 */
export function parsePublishedReleaseManifest(value: unknown, baseUrl: string, revision: string): PublishedReleaseManifest {
  if (!value || typeof value !== 'object') throw new Error('发布缓存清单无效。');
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || source.cacheRevision !== revision) throw new Error('发布缓存清单版本与当前发布不一致。');
  if (!Array.isArray(source.files) || !source.files.length) throw new Error('发布缓存清单没有静态文件。');
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || !base.pathname.endsWith('/') || base.search || base.hash) throw new Error('发布缓存根地址无效。');
  const seen = new Set<string>();
  let total = 0;
  const files = source.files.map((item: unknown): PublishedReleaseFile => {
    if (!item || typeof item !== 'object') throw new Error('发布缓存条目无效。');
    const entry = item as Record<string, unknown>;
    if (typeof entry.path !== 'string' || !entry.path || /[\\?#\u0000-\u001f]/.test(entry.path)) throw new Error('发布缓存文件路径无效。');
    const parts = entry.path.split('/');
    const decoded = parts.map(part => decodeURIComponent(part));
    if (decoded.some(part => !part || part === '.' || part === '..' || /[\\/:\u0000-\u001f]/.test(part))) throw new Error('发布缓存文件路径越界。');
    const relative = decoded.join('/');
    if (CONTROL_FILES.has(relative)) throw new Error('实时配置和缓存控制文件不可进入发布缓存。');
    const url = new URL(entry.path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash || url.username || url.password) throw new Error('发布缓存文件路径越界。');
    if (seen.has(url.href)) throw new Error('发布缓存清单包含重复文件。');
    seen.add(url.href);
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0 || typeof entry.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(entry.sha256)
      || typeof entry.contentType !== 'string' || !entry.contentType || /[\r\n]/.test(entry.contentType)) throw new Error('发布缓存文件大小、类型或校验值无效。');
    const storage = relative === 'project/scene.json' || relative === 'project/asset-manifest.json' || relative.startsWith('project/assets/') ? 'asset' : 'response';
    if (entry.storage !== storage) throw new Error('发布缓存文件的存储归属无效。');
    total += entry.size as number;
    if (!Number.isSafeInteger(total)) throw new Error('发布缓存清单总大小无效。');
    return { path: entry.path, url: url.href, size: entry.size as number, sha256: entry.sha256.toLowerCase(), contentType: entry.contentType, storage };
  });
  if (total !== source.totalBytes) throw new Error('发布缓存清单总大小不一致。');
  return { version: 1, cacheRevision: revision, totalBytes: total, files };
}
