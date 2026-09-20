import type { PublishedCacheStore } from './publishedAssetCache.ts';

export const PUBLISHED_CACHE_DATABASE = 'zending-published-assets-v1';
export const PUBLISHED_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
export const PUBLISHED_CACHE_MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const STORAGE_TIMEOUT_MS = 3000;
type Metadata = { key: string; bytes: number; usedAt: number };

/** 数据与 LRU 元信息分表，淘汰时不读取全部模型/解码数组。事务同时提交，避免半条缓存。 */
export class IndexedDbPublishedCacheStore implements PublishedCacheStore {
  private database: Promise<IDBDatabase> | null = null;
  private closed = false;

  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('发布缓存已关闭。'));
    this.database ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('浏览器不支持 IndexedDB。')); return; }
      let finished = false;
      const fail = (error: unknown) => { if (!finished) { finished = true; clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => fail(new Error('打开发布缓存超时。')), STORAGE_TIMEOUT_MS);
      const request = indexedDB.open(PUBLISHED_CACHE_DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('values');
        request.result.createObjectStore('metadata', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        if (finished || this.closed) { request.result.close(); fail(new Error('发布缓存已关闭。')); return; }
        finished = true; clearTimeout(timer);
        request.result.onversionchange = () => { request.result.close(); this.database = null; };
        resolve(request.result);
      };
      request.onerror = () => fail(request.error ?? new Error('打开发布缓存失败。'));
      request.onblocked = () => fail(new Error('发布缓存被其他页面阻塞。'));
    });
    return this.database;
  }

  async get(key: string): Promise<unknown> {
    const database = await this.open();
    return this.transaction(database, (transaction, setResult) => {
      const request = transaction.objectStore('values').get(key);
      request.onsuccess = () => setResult(request.result);
      const metadata = transaction.objectStore('metadata');
      const entry = metadata.get(key);
      entry.onsuccess = () => { if (entry.result) metadata.put({ ...entry.result, usedAt: Date.now() }); };
    });
  }

  async put(key: string, value: unknown, bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > PUBLISHED_CACHE_MAX_ENTRY_BYTES) return;
    const database = await this.open();
    await this.transaction(database, transaction => {
      const metadata = transaction.objectStore('metadata');
      const values = transaction.objectStore('values');
      const request = metadata.getAll();
      request.onsuccess = () => {
        const entries = (request.result as Metadata[]).filter(entry => entry.key !== key).sort((a, b) => a.usedAt - b.usedAt);
        let total = bytes + entries.reduce((sum, entry) => sum + entry.bytes, 0);
        let count = entries.length + 1;
        for (const entry of entries) {
          if (total <= PUBLISHED_CACHE_MAX_BYTES && count <= MAX_ENTRIES) break;
          values.delete(entry.key); metadata.delete(entry.key);
          total -= entry.bytes; count--;
        }
        values.put(value, key);
        metadata.put({ key, bytes, usedAt: Date.now() } satisfies Metadata);
      };
    });
  }

  private transaction(database: IDBDatabase,
    start: (transaction: IDBTransaction, setResult: (value: unknown) => void) => void): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['values', 'metadata'], 'readwrite');
      let result: unknown;
      const timer = setTimeout(() => { transaction.abort(); reject(new Error('发布缓存读写超时。')); }, STORAGE_TIMEOUT_MS);
      transaction.oncomplete = () => { clearTimeout(timer); resolve(result); };
      transaction.onabort = transaction.onerror = () => { clearTimeout(timer); reject(transaction.error ?? new Error('发布缓存读写失败。')); };
      try { start(transaction, value => { result = value; }); }
      catch (error) { clearTimeout(timer); transaction.abort(); reject(error); }
    });
  }

  close(): void {
    this.closed = true;
    void this.database?.then(database => database.close(), () => undefined);
  }
}
