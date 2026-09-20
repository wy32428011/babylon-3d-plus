import { hashSkyboxContent } from '../babylon/skyboxContentHash.ts';
import { IndexedDbPublishedCacheStore, PUBLISHED_CACHE_MAX_ENTRY_BYTES } from './publishedCacheStore.ts';

export interface PublishedCacheStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown, bytes: number): Promise<void>;
  close?(): void;
}
type CacheOptions = { baseUrl: string; revision: string; assetBase: string; documentUrls: string[]; store?: PublishedCacheStore;
  verifyRevision?: () => Promise<void> };
export type AssetReadProgress = (loaded: number, total: number | null) => void;
type CachedResponse = { blob: Blob; type: string };

/** 只在 Viewer 读取到本次发布标识后启用；不缓存入口、实时配置、接口或其他来源。 */
export class PublishedAssetCache {
  readonly metrics = { resourceHits: 0, downloads: 0, decodeHits: 0, decodes: 0, storageFailures: 0 };
  private readonly namespace: string;
  private readonly base: URL;
  private readonly assetBase: URL;
  private readonly documents: Set<string>;
  private readonly store: PublishedCacheStore;
  private readonly verifyRevision?: () => Promise<void>;
  private readonly controller = new AbortController();
  private storageAvailable = true;

  constructor(options: CacheOptions) {
    this.base = new URL(options.baseUrl);
    this.assetBase = new URL(options.assetBase, this.base);
    this.namespace = JSON.stringify([this.base.href, options.revision]);
    this.documents = new Set(options.documentUrls.map(url => new URL(url, this.base).href));
    this.store = options.store ?? new IndexedDbPublishedCacheStore();
    this.verifyRevision = options.verifyRevision;
  }

  accepts(source: string): boolean {
    try {
      const url = new URL(source, this.base);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== this.base.origin || url.username || url.password) return false;
      url.hash = '';
      return this.documents.has(url.href) || (url.origin === this.assetBase.origin
        && this.assetBase.pathname !== this.base.pathname && this.assetBase.pathname.startsWith(this.base.pathname)
        && url.pathname.startsWith(this.assetBase.pathname));
    } catch { return false; }
  }

  async fetch(source: string, init: RequestInit = {}, onProgress?: AssetReadProgress, maxBytes?: number): Promise<Response> {
    if (!this.accepts(source) || (init.method && init.method !== 'GET') || init.headers || init.body) return fetch(source, init);
    const signal = init.signal ? AbortSignal.any([init.signal, this.controller.signal]) : this.controller.signal;
    signal.throwIfAborted();
    const url = new URL(source, this.base); url.hash = '';
    const key = `${this.namespace}:resource:${url.href}`;
    const cached = await this.read(key) as CachedResponse | undefined;
    signal.throwIfAborted();
    if (cached?.blob instanceof Blob && typeof cached.type === 'string') {
      if (maxBytes !== undefined && cached.blob.size > maxBytes) throw new Error(`资源超过读取上限（${maxBytes} 字节）。`);
      this.metrics.resourceHits++;
      onProgress?.(cached.blob.size, cached.blob.size);
      return this.response(cached);
    }
    this.metrics.downloads++;
    // 新发布即使复用文件名，也不能读到上一版 HTTP 缓存。
    const response = await fetch(url.href, { ...init, cache: 'no-store', signal });
    if (response.status !== 200) return response;
    const lengthHeader = response.headers.get('content-length');
    const length = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
    if (maxBytes !== undefined && length !== null && length > maxBytes) {
      await response.body?.cancel();
      throw new Error(`资源超过读取上限（${maxBytes} 字节）。`);
    }
    if (length !== null && length > PUBLISHED_CACHE_MAX_ENTRY_BYTES) return response;
    let loaded = 0;
    onProgress?.(0, length);
    const stream = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      loaded += chunk.byteLength;
      if (maxBytes !== undefined && loaded > maxBytes) throw new Error(`资源超过读取上限（${maxBytes} 字节）。`);
      onProgress?.(loaded, length); controller.enqueue(chunk);
    } }), { signal });
    const blob = await (stream ? new Response(stream).blob() : response.blob());
    if (maxBytes !== undefined && blob.size > maxBytes) throw new Error(`资源超过读取上限（${maxBytes} 字节）。`);
    signal.throwIfAborted();
    // 稳定发布地址可能在下载途中被新版本替换，校验后才允许写入旧版本的缓存空间。
    await this.verifyRevision?.();
    signal.throwIfAborted();
    const record: CachedResponse = { blob, type: response.headers.get('content-type') ?? 'application/octet-stream' };
    await this.write(key, record, blob.size);
    signal.throwIfAborted();
    return this.response(record);
  }

  async decode<T>(signature: string, source: ArrayBuffer | ArrayBufferView, decode: () => Promise<T>,
    validate: (value: unknown) => value is T, byteLength: (value: T) => number): Promise<T> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    const key = `${this.namespace}:decoded:${signature}:${await hashSkyboxContent(bytes)}`;
    const cached = await this.read(key);
    signal.throwIfAborted();
    if (validate(cached)) { this.metrics.decodeHits++; return cached; }
    this.metrics.decodes++;
    const result = await decode();
    signal.throwIfAborted();
    if (validate(result)) await this.write(key, result, byteLength(result));
    return result;
  }

  private response(record: CachedResponse): Response {
    return new Response(record.blob, { headers: { 'Content-Type': record.type, 'Content-Length': String(record.blob.size) } });
  }

  private async read(key: string): Promise<unknown> {
    if (!this.storageAvailable) return undefined;
    try { return await this.store.get(key); }
    catch (error) { this.storageFailure(error); return undefined; }
  }

  private async write(key: string, value: unknown, bytes: number): Promise<void> {
    if (!this.storageAvailable || bytes > PUBLISHED_CACHE_MAX_ENTRY_BYTES) return;
    try { await this.store.put(key, value, bytes); }
    catch (error) { this.storageFailure(error); }
  }

  private storageFailure(error: unknown): void {
    this.storageAvailable = false;
    this.metrics.storageFailures++;
    console.warn('[Viewer cache] 持久缓存不可用，本次继续正常加载。', error);
  }

  dispose(): void { this.controller.abort(); this.store.close?.(); }
}
