import type { AssetReadProgress, PublishedAssetCache } from './publishedAssetCache.ts';

let activeCache: PublishedAssetCache | null = null;

export function getPublishedAssetCache(): PublishedAssetCache | null { return activeCache; }

/** 编辑器沿用原读取；发布 Viewer 在完整生命周期内安装并释放自己的缓存。 */
export function installPublishedAssetCache(cache: PublishedAssetCache): () => void {
  activeCache = cache;
  return () => { if (activeCache === cache) activeCache = null; };
}

export function fetchRuntimeAsset(url: string, init?: RequestInit, onProgress?: AssetReadProgress, maxBytes?: number): Promise<Response> {
  return activeCache ? activeCache.fetch(url, init, onProgress, maxBytes) : fetch(url, init);
}
