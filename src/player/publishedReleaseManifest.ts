import { containsAsciiControlCharactersOr } from '../../electron/shared/asciiControlCharacters.ts';
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
const BUILTIN_ROAM_ASSETS = new Set([
  'manual-roam/EQ_People.glb',
  'manual-roam/EQ_People_rigged_v1.glb',
  'manual-roam/locomotion-v1.glb',
  'manual-roam/locomotion-v1.manifest.json',
  'manual-roam/EQ_People_rigged_v2.glb',
  'manual-roam/locomotion-v2.glb',
  'manual-roam/locomotion-v2.manifest.json',
]);

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
    if (typeof entry.path !== 'string' || !entry.path || containsAsciiControlCharactersOr(entry.path, "\\?#")) throw new Error('发布缓存文件路径无效。');
    const parts = entry.path.split('/');
    const decoded = parts.map(part => decodeURIComponent(part));
    if (decoded.some(part => !part || part === '.' || part === '..' || containsAsciiControlCharactersOr(part, "\\/:"))) throw new Error('发布缓存文件路径越界。');
    const relative = decoded.join('/');
    if (CONTROL_FILES.has(relative)) throw new Error('实时配置和缓存控制文件不可进入发布缓存。');
    const url = new URL(entry.path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash || url.username || url.password) throw new Error('发布缓存文件路径越界。');
    // 内置资源也拒绝 %45Q 与 EQ 等编码等价项，避免同一文件被重复计数和缓存。
    const identity = BUILTIN_ROAM_ASSETS.has(relative) ? new URL(relative, base).href : url.href;
    if (seen.has(identity)) throw new Error('发布缓存清单包含重复文件。');
    seen.add(identity);
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0 || typeof entry.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(entry.sha256)
      || typeof entry.contentType !== 'string' || !entry.contentType || /[\r\n]/.test(entry.contentType)) throw new Error('发布缓存文件大小、类型或校验值无效。');
    // 精确列出的内置资源允许原始缓存；旧发布清单的 response 保持兼容。
    const storage = relative === 'project/scene.json' || relative === 'project/asset-manifest.json' || relative.startsWith('project/assets/')
      || (BUILTIN_ROAM_ASSETS.has(relative) && entry.storage === 'asset') ? 'asset' : 'response';
    if (entry.storage !== storage) throw new Error('发布缓存文件的存储归属无效。');
    total += entry.size as number;
    if (!Number.isSafeInteger(total)) throw new Error('发布缓存清单总大小无效。');
    return { path: entry.path, url: url.href, size: entry.size as number, sha256: entry.sha256.toLowerCase(), contentType: entry.contentType, storage };
  });
  if (total !== source.totalBytes) throw new Error('发布缓存清单总大小不一致。');
  return { version: 1, cacheRevision: revision, totalBytes: total, files };
}
