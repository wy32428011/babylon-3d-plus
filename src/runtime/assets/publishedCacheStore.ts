import type { PublishedCacheStore } from './publishedAssetCache.ts';

export const PUBLISHED_CACHE_DATABASE = 'zending-published-assets-v1';
export const PUBLISHED_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
export const PUBLISHED_CACHE_MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const OPEN_TIMEOUT_MS = 10_000;
const TRANSACTION_IDLE_TIMEOUT_MS = 30_000;
const TOUCH_BATCH_DELAY_MS = 100;
type Metadata = { key: string; bytes: number; usedAt: number };
type WatchRequest = <T>(request: IDBRequest<T>, onSuccess?: (result: T) => void) => void;
type StoreOptions = { databaseName?: string; evict?: boolean; maxEntryBytes?: number };

/** 数据与 LRU 元信息分表；大数据只读不持有写锁，访问时间单独合并更新。 */
export class IndexedDbPublishedCacheStore implements PublishedCacheStore {
  private readonly options: StoreOptions;
  private database: Promise<IDBDatabase> | null = null;
  private closed = false;
  private readonly activeOperations = new Set<(error: Error) => void>();
  private readonly pendingTouches = new Map<string, number>();
  private touchTimer: ReturnType<typeof setTimeout> | null = null;
  private touchWarningReported = false;

  constructor(options: StoreOptions = {}) { this.options = options; }

  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('发布缓存已关闭。'));
    this.database ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('浏览器不支持 IndexedDB。')); return; }
      let finished = false;
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true; clearTimeout(timer); this.activeOperations.delete(fail); reject(error);
      };
      const timer = setTimeout(() => fail(new Error('打开发布缓存超时。')), OPEN_TIMEOUT_MS);
      this.activeOperations.add(fail);
      let request: IDBOpenDBRequest;
      try { request = indexedDB.open(this.options.databaseName ?? PUBLISHED_CACHE_DATABASE, 1); }
      catch (error) { fail(error); return; }
      request.onupgradeneeded = () => {
        request.result.createObjectStore('values');
        request.result.createObjectStore('metadata', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        if (finished || this.closed) { request.result.close(); fail(new Error('发布缓存已关闭。')); return; }
        finished = true; clearTimeout(timer); this.activeOperations.delete(fail);
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
    const value = await this.transaction(database, ['values'], 'readonly', (transaction, setResult, watch) => {
      watch(transaction.objectStore('values').get(key), setResult);
    });
    if (value !== undefined && !this.closed) this.recordTouch(database, key);
    return value;
  }

  async put(key: string, value: unknown, bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > (this.options.maxEntryBytes ?? PUBLISHED_CACHE_MAX_ENTRY_BYTES)) {
      if (this.options.evict === false) throw new Error('发布缓存数据块大小无效。');
      return;
    }
    const database = await this.open();
    // 淘汰前提交本页已命中的时间，避免刚读过的条目因批处理窗口被误删。
    await this.flushTouches(database);
    await this.transaction(database, ['values', 'metadata'], 'readwrite', (transaction, _setResult, watch) => {
      const metadata = transaction.objectStore('metadata');
      const values = transaction.objectStore('values');
      // 完整发布的原始文件分块保存且按整个版本清理，不能被解码缓存的 LRU 拆散。
      if (this.options.evict === false) {
        watch(values.put(value, key));
        watch(metadata.put({ key, bytes, usedAt: Date.now() } satisfies Metadata));
        return;
      }
      watch(metadata.getAll(), (records: Metadata[]) => {
        const entries = records.filter(entry => entry.key !== key).sort((a, b) => a.usedAt - b.usedAt);
        let total = bytes + entries.reduce((sum, entry) => sum + entry.bytes, 0);
        let count = entries.length + 1;
        for (const entry of entries) {
          if (total <= PUBLISHED_CACHE_MAX_BYTES && count <= MAX_ENTRIES) break;
          watch(values.delete(entry.key)); watch(metadata.delete(entry.key));
          total -= entry.bytes; count--;
        }
        watch(values.put(value, key));
        watch(metadata.put({ key, bytes, usedAt: Date.now() } satisfies Metadata));
      });
    });
  }

  async delete(key: string): Promise<void> {
    this.pendingTouches.delete(key);
    const database = await this.open();
    await this.transaction(database, ['values', 'metadata'], 'readwrite', (transaction, _setResult, watch) => {
      watch(transaction.objectStore('values').delete(key));
      watch(transaction.objectStore('metadata').delete(key));
    });
  }

  async keys(): Promise<string[]> {
    const database = await this.open();
    return await this.transaction(database, ['metadata'], 'readonly', (transaction, setResult, watch) => {
      watch(transaction.objectStore('metadata').getAllKeys(), setResult);
    }) as string[];
  }

  /** 整个发布版本在持有排他租约时清理，避免 deleteDatabase 的不可取消 blocked 请求。 */
  async clear(): Promise<void> {
    this.pendingTouches.clear();
    if (this.touchTimer !== null) { clearTimeout(this.touchTimer); this.touchTimer = null; }
    const database = await this.open();
    await this.transaction(database, ['values', 'metadata'], 'readwrite', (transaction, _setResult, watch) => {
      watch(transaction.objectStore('values').clear());
      watch(transaction.objectStore('metadata').clear());
    });
  }

  private recordTouch(database: IDBDatabase, key: string): void {
    if (this.pendingTouches.size < MAX_ENTRIES || this.pendingTouches.has(key)) this.pendingTouches.set(key, Date.now());
    if (this.touchTimer !== null) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      void this.flushTouches(database).catch(error => {
        if (this.closed || this.touchWarningReported) return;
        this.touchWarningReported = true;
        console.warn('[Viewer cache] 更新缓存访问时间失败，已读取的资源仍可使用。', error);
      });
    }, TOUCH_BATCH_DELAY_MS);
  }

  private async flushTouches(database: IDBDatabase): Promise<void> {
    if (this.touchTimer !== null) { clearTimeout(this.touchTimer); this.touchTimer = null; }
    const touches = Array.from(this.pendingTouches);
    this.pendingTouches.clear();
    if (!touches.length || this.closed) return;
    await this.transaction(database, ['metadata'], 'readwrite', (transaction, _setResult, watch) => {
      const metadata = transaction.objectStore('metadata');
      for (const [key, usedAt] of touches) {
        watch(metadata.get(key), (entry: Metadata | undefined) => {
          // 其他页面可能已经淘汰该资源；访问时间更新不能重建孤立元信息。
          if (entry && entry.usedAt < usedAt) watch(metadata.put({ ...entry, usedAt }));
        });
      }
    });
  }

  private transaction(database: IDBDatabase, stores: string[], mode: IDBTransactionMode,
    start: (transaction: IDBTransaction, setResult: (value: unknown) => void, watch: WatchRequest) => void): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('发布缓存已关闭。'));
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(stores, mode);
      let result: unknown;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let abortReason: unknown;
      const finish = (failure?: { error: unknown }) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        this.activeOperations.delete(cancel);
        if (failure) reject(failure.error); else resolve(result);
      };
      const stop = (error: unknown, waitForFinishedEvent = false) => {
        if (settled) return;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        abortReason = error;
        try { transaction.abort(); }
        catch (abortError) {
          // 原生事务可能已提交，但 complete/abort 事件还排在渲染任务后；由终态事件结算，不误报超时。
          if (waitForFinishedEvent && abortError instanceof DOMException && abortError.name === 'InvalidStateError') {
            abortReason = undefined;
            return;
          }
          if (!(abortError instanceof DOMException && abortError.name === 'InvalidStateError')) {
            finish({ error: abortError }); return;
          }
        }
        finish({ error });
      };
      const cancel = (error: Error) => stop(error);
      const refreshDeadline = () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => stop(new Error('发布缓存读写超时。'), true), TRANSACTION_IDLE_TIMEOUT_MS);
      };
      const watch: WatchRequest = (request, onSuccess) => {
        request.onsuccess = () => {
          if (settled) return;
          refreshDeadline();
          try { onSuccess?.(request.result); }
          catch (error) { stop(error); }
        };
      };
      transaction.oncomplete = () => finish();
      transaction.onabort = () => finish({ error: abortReason ?? transaction.error ?? new Error('发布缓存事务已中止。') });
      transaction.onerror = () => {
        // 请求错误的默认行为会中止整个事务，保留原始原因交给 abort 事件统一收尾。
        abortReason ??= transaction.error ?? new Error('发布缓存读写失败。');
      };
      this.activeOperations.add(cancel);
      refreshDeadline();
      try { start(transaction, value => { result = value; }, watch); }
      catch (error) { stop(error); }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.touchTimer !== null) { clearTimeout(this.touchTimer); this.touchTimer = null; }
    this.pendingTouches.clear();
    for (const cancel of this.activeOperations) cancel(new DOMException('发布缓存已关闭。', 'AbortError'));
    void this.database?.then(database => database.close(), () => undefined);
  }
}
