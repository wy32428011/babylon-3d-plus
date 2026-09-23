import { IndexedDbPublishedCacheStore } from './publishedCacheStore.ts';
import type { PublishedCacheStore } from './publishedAssetCache.ts';
import { createSkyboxCacheGeneration } from '../babylon/skyboxContentHash.ts';

const CHUNK_BYTES = 16 * 1024 * 1024;
type ChunkStore = PublishedCacheStore & { delete(key: string): Promise<void> };
type BlobRecord = { blob: Blob; type: string; sha256?: string };
type BlobHead = { format: 'release-blob-v1'; chunks: string[]; size: number; type: string; sha256?: string };

/** 发布原始文件按版本独立保留；小块事务避免单个超大 Blob 长时间占有写锁。 */
export class PublishedRawStore implements PublishedCacheStore {
  private readonly store: ChunkStore;
  private readonly chunkBytes: number;
  private readonly databaseName: string;
  private readonly controller = new AbortController();
  private closed = false;

  constructor(databaseName: string, store?: ChunkStore, chunkBytes = CHUNK_BYTES) {
    this.databaseName = databaseName;
    this.store = store ?? new IndexedDbPublishedCacheStore({ databaseName, evict: false, maxEntryBytes: CHUNK_BYTES });
    this.chunkBytes = chunkBytes;
  }

  async get(key: string): Promise<unknown> {
    this.checkOpen();
    const head = await this.store.get(key) as Partial<BlobHead> | undefined;
    if (head?.format !== 'release-blob-v1' || !Array.isArray(head.chunks) || !Number.isSafeInteger(head.size) || typeof head.type !== 'string') return undefined;
    const parts: Blob[] = [];
    let size = 0;
    for (const chunk of head.chunks) {
      this.checkOpen();
      if (typeof chunk !== 'string' || !chunk.startsWith(`${key}:chunk:`)) return undefined;
      const part = await this.store.get(chunk);
      if (!(part instanceof Blob)) return undefined;
      parts.push(part); size += part.size;
    }
    if (size !== head.size) return undefined;
    return { blob: new Blob(parts, { type: head.type }), type: head.type, sha256: head.sha256 };
  }

  async put(key: string, value: unknown, bytes: number): Promise<void> {
    this.checkOpen();
    const locks = globalThis.navigator?.locks;
    if (locks) {
      // 页面级共享租约保护整个版本，此处单独串行同一文件的代际提交，避免跨页遗留孤儿大块。
      await locks.request(`${this.databaseName}:write:${key}`, { mode: 'exclusive', signal: this.controller.signal }, () => this.putRecord(key, value, bytes));
    } else {
      await this.putRecord(key, value, bytes);
    }
  }

  private async putRecord(key: string, value: unknown, bytes: number): Promise<void> {
    this.checkOpen();
    const record = value as BlobRecord;
    if (!(record?.blob instanceof Blob) || record.blob.size !== bytes || typeof record.type !== 'string') throw new Error('发布原始文件记录无效。');
    const previous = await this.store.get(key) as Partial<BlobHead> | undefined;
    const generation = createSkyboxCacheGeneration();
    const chunks: string[] = [];
    try {
      for (let offset = 0; offset < bytes; offset += this.chunkBytes) {
        this.checkOpen();
        const chunk = `${key}:chunk:${generation}:${chunks.length}`;
        const blob = record.blob.slice(offset, Math.min(bytes, offset + this.chunkBytes));
        chunks.push(chunk);
        await this.store.put(chunk, blob, blob.size);
      }
      this.checkOpen();
      const head: BlobHead = { format: 'release-blob-v1', chunks, size: bytes, type: record.type, sha256: record.sha256 };
      // 完成标记最后单独提交；崩溃或配额不足时，部分数据绝不成为可用文件。
      await this.store.put(key, head, JSON.stringify(head).length * 2);
    } catch (error) {
      await Promise.allSettled(chunks.map(chunk => this.store.delete(chunk)));
      throw error;
    }
    if (previous?.format === 'release-blob-v1' && Array.isArray(previous.chunks)) {
      for (const chunk of previous.chunks) {
        if (typeof chunk === 'string' && chunk.startsWith(`${key}:chunk:`)) await this.store.delete(chunk);
      }
    }
  }

  private checkOpen(): void { if (this.closed) throw new DOMException('发布缓存已关闭。', 'AbortError'); }
  close(): void { this.closed = true; this.controller.abort(); this.store.close?.(); }
}
