import { IndexedDbPublishedCacheStore } from '../runtime/assets/publishedCacheStore.ts';
import { PublishedRawStore } from '../runtime/assets/publishedRawStore.ts';
import { hashSkyboxContent } from '../runtime/babylon/skyboxContentHash.ts';

const CATALOG_DATABASE = 'zending-published-release-catalog-v1';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CHUNK_BYTES = 16 * 1024 * 1024;

export type PublishedReleaseStorageIdentity = {
  baseUrl: string; cacheRevision: string; projectKey: string; databaseName: string; responseCacheName: string;
};
type ReleaseRecord = PublishedReleaseStorageIdentity & { totalBytes: number; lastUsed: number; complete: boolean; state?: unknown };
type StorageManifest = {
  cacheRevision: string; totalBytes: number;
  files?: ReadonlyArray<{ path: string; size: number; storage: 'asset' | 'response' }>;
};
export type PublishedReleaseStorage = {
  rawStore: PublishedRawStore; databaseName: string; admitted: boolean; reason?: string;
  markComplete(state: unknown): Promise<void>; dispose(): void;
};

export async function createPublishedReleaseStorageIdentity(baseUrl: string, cacheRevision: string): Promise<PublishedReleaseStorageIdentity> {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) throw new Error('发布缓存根地址无效。');
  if (!cacheRevision) throw new Error('发布缓存版本无效。');
  const hash = await hashSkyboxContent(new TextEncoder().encode(JSON.stringify([base.href, cacheRevision])));
  // 仅对明确的中台 release 地址归并项目；其他部署地址按完整根地址隔离。
  const projectPath = base.pathname.replace(/(\/digital-twin\/releases\/[0-9]+)\/[0-9]+\/$/, '$1/');
  return {
    baseUrl: base.href, cacheRevision, projectKey: `${base.origin}${projectPath}`,
    databaseName: `zending-published-release-v1-${hash}`,
    responseCacheName: `zending-published-response:v1:${encodeURIComponent(base.href)}:${encodeURIComponent(cacheRevision)}`,
  };
}

export function assessPublishedReleaseCapacity(totalBytes: number, reusableBytes: number, estimate?: StorageEstimate): { admitted: boolean; reason?: string } {
  const remaining = Math.max(0, totalBytes - Math.max(0, reusableBytes));
  if (remaining === 0) return { admitted: true };
  if (!Number.isFinite(estimate?.quota) || !Number.isFinite(estimate?.usage)) return { admitted: false, reason: '浏览器未提供可用缓存容量，暂不完整预缓存。' };
  // 为分块头、索引与响应元信息留余量；同版本已保存的文件不重复申请空间。
  const required = Math.ceil(remaining * 1.1);
  return (estimate!.quota! - estimate!.usage!) >= required
    ? { admitted: true }
    : { admitted: false, reason: '浏览器剩余空间不足以完整缓存当前发布版本。' };
}

export function isPublishedReleaseComplete(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;
  const progress = state as { phase?: string; completedFiles?: number; totalFiles?: number };
  return progress.phase === 'ready' && Number.isSafeInteger(progress.totalFiles) && progress.totalFiles! > 0
    && progress.completedFiles === progress.totalFiles;
}

export function isPublishedReleaseCleanupCandidate(value: unknown, current: PublishedReleaseStorageIdentity, now: number, hasLocks: boolean): value is ReleaseRecord {
  if (!hasLocks || !value || typeof value !== 'object') return false;
  const record = value as Partial<ReleaseRecord>;
  return record.projectKey === current.projectKey && record.databaseName !== current.databaseName
    && typeof record.databaseName === 'string' && /^zending-published-release-v1-[a-f0-9]{64}$/.test(record.databaseName)
    && typeof record.baseUrl === 'string' && typeof record.cacheRevision === 'string'
    && Number.isFinite(record.lastUsed) && now - record.lastUsed! > RETENTION_MS;
}

async function acquireReleaseLease(locks: LockManager, identity: PublishedReleaseStorageIdentity): Promise<() => void> {
  let release!: () => void;
  const lifetime = new Promise<void>(resolve => { release = resolve; });
  // 只等获得租约，不等待持有租约的整个页面生命周期；清理在途时立即回退联网。
  await new Promise<void>((resolve, reject) => {
    void locks.request(identity.databaseName, { mode: 'shared', ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error('当前发布缓存正在清理，暂时使用网络加载。')); return; }
      resolve();
      await lifetime;
    }).catch(reject);
  });
  return release;
}

async function countReusableRawBytes(store: IndexedDbPublishedCacheStore, signal?: AbortSignal): Promise<number> {
  const keys = await store.keys();
  const known = new Set(keys);
  let bytes = 0;
  for (const key of keys) {
    signal?.throwIfAborted();
    if (key.includes(':chunk:')) continue;
    const head = await store.get(key) as { format?: string; size?: number; chunks?: unknown[] } | undefined;
    if (head?.format !== 'release-blob-v1' || !Number.isSafeInteger(head.size) || head.size! < 0 || !Array.isArray(head.chunks)) continue;
    if (head.chunks.every(chunk => typeof chunk === 'string' && chunk.startsWith(`${key}:chunk:`) && known.has(chunk))) bytes += head.size!;
  }
  return bytes;
}

async function countReusableResponseBytes(identity: PublishedReleaseStorageIdentity, manifest: StorageManifest, signal?: AbortSignal): Promise<number> {
  if (!manifest.files || typeof caches === 'undefined' || !await caches.has(identity.responseCacheName)) return 0;
  const cache = await caches.open(identity.responseCacheName);
  let bytes = 0;
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    if (file.storage === 'response' && await cache.match(new URL(file.path, identity.baseUrl).href)) bytes += file.size;
  }
  return bytes;
}

async function cleanupExpiredReleases(catalog: IndexedDbPublishedCacheStore, identity: PublishedReleaseStorageIdentity, locks: LockManager | undefined, signal?: AbortSignal): Promise<void> {
  if (!locks) return; // 没有跨页面互斥能力时，宁可保留旧版本，也不冒险清理其他页正在用的内容。
  for (const key of await catalog.keys()) {
    signal?.throwIfAborted();
    const record = await catalog.get(key);
    if (!isPublishedReleaseCleanupCandidate(record, identity, Date.now(), true)) continue;
    const expected = await createPublishedReleaseStorageIdentity(record.baseUrl, record.cacheRevision);
    if (key !== expected.databaseName || expected.databaseName !== record.databaseName || expected.projectKey !== identity.projectKey || expected.responseCacheName !== record.responseCacheName) continue;
    await locks.request(record.databaseName, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) return;
      signal?.throwIfAborted();
      const latest = await catalog.get(key);
      if (!isPublishedReleaseCleanupCandidate(latest, identity, Date.now(), true)) return;
      const old = new IndexedDbPublishedCacheStore({ databaseName: record.databaseName, evict: false });
      try {
        // deleteDatabase 无取消能力，blocked 后可能迟到删除；清空两个表释放整版本，保留空库壳。
        await old.clear();
        if (typeof caches !== 'undefined') await caches.delete(record.responseCacheName);
        await catalog.delete(key);
      } finally { old.close(); }
    });
  }
}

async function reclaimDecodedEntries(signal?: AbortSignal): Promise<void> {
  const decoded = new IndexedDbPublishedCacheStore();
  try {
    // 解码结果可重算；保留同库中的旧版原始资源，只顺序删除明确的 decoded 命名空间。
    for (const key of await decoded.keys()) {
      signal?.throwIfAborted();
      if (key.includes(':decoded:')) await decoded.delete(key);
    }
  } finally { decoded.close(); }
}

/** 一个页面持有一个发布版本；容量不足仍可读已有缓存，由调用方停止预热并正常按需加载。 */
export async function openPublishedReleaseStorage(baseUrl: string, manifest: StorageManifest, signal?: AbortSignal): Promise<PublishedReleaseStorage> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) throw new Error('发布缓存总大小无效。');
  const identity = await createPublishedReleaseStorageIdentity(baseUrl, manifest.cacheRevision);
  const chunkStore = new IndexedDbPublishedCacheStore({ databaseName: identity.databaseName, evict: false, maxEntryBytes: CHUNK_BYTES });
  const rawStore = new PublishedRawStore(identity.databaseName, chunkStore);
  const catalog = new IndexedDbPublishedCacheStore({ databaseName: CATALOG_DATABASE, evict: false, maxEntryBytes: 1024 * 1024 });
  let releaseLease = () => {};
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    rawStore.close(); catalog.close(); releaseLease();
  };
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    const locks = globalThis.navigator?.locks;
    if (locks) releaseLease = await acquireReleaseLease(locks, identity);
    if (signal?.aborted || disposed) { releaseLease(); signal?.throwIfAborted(); throw new DOMException('发布缓存已关闭。', 'AbortError'); }
    const existing = await catalog.get(identity.databaseName) as Partial<ReleaseRecord> | undefined;
    const compatible = existing?.totalBytes === manifest.totalBytes;
    const record: ReleaseRecord = {
      ...identity, totalBytes: manifest.totalBytes, lastUsed: Date.now(),
      complete: compatible && existing?.complete === true, state: compatible ? existing?.state : undefined,
    };
    await catalog.put(identity.databaseName, record, JSON.stringify(record).length * 2);
    await cleanupExpiredReleases(catalog, identity, locks, signal);
    const reusable = await countReusableRawBytes(chunkStore, signal) + await countReusableResponseBytes(identity, manifest, signal);
    let estimate = await globalThis.navigator?.storage?.estimate?.();
    let capacity = assessPublishedReleaseCapacity(manifest.totalBytes, reusable, estimate);
    if (!capacity.admitted && Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage)) {
      await reclaimDecodedEntries(signal);
      estimate = await globalThis.navigator?.storage?.estimate?.();
      capacity = assessPublishedReleaseCapacity(manifest.totalBytes, reusable, estimate);
    }
    signal?.throwIfAborted();
    return {
      rawStore, databaseName: identity.databaseName, ...capacity,
      async markComplete(state: unknown) {
        if (disposed) throw new DOMException('发布缓存已关闭。', 'AbortError');
        const complete: ReleaseRecord = { ...record, lastUsed: Date.now(), complete: isPublishedReleaseComplete(state), state };
        await catalog.put(identity.databaseName, complete, JSON.stringify(complete).length * 2);
      },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}
