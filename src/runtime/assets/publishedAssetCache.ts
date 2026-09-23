import { hashPublishedBlob } from './publishedBlobHash.ts';
import { hashSkyboxContent } from '../babylon/skyboxContentHash.ts';
import { IndexedDbPublishedCacheStore, PUBLISHED_CACHE_MAX_ENTRY_BYTES } from './publishedCacheStore.ts';

export interface PublishedCacheStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown, bytes: number): Promise<void>;
  close?(): void;
}
export type PublishedResourceIdentity = { sha256: string; size: number };
type CacheOptions = { baseUrl: string; revision: string; assetBase: string; documentUrls: string[]; store?: PublishedCacheStore; rawStore?: PublishedCacheStore;
  verifyRevision?: () => Promise<void>; resources?: ReadonlyMap<string, PublishedResourceIdentity> };
export type AssetReadProgress = (loaded: number, total: number | null) => void;
type CachedResponse = { blob: Blob; type: string; sha256?: string };
type SharedResponse = { blob: Blob; status: number; statusText: string; headers: [string, string][] };

/** 只在 Viewer 读取到本次发布标识后启用；不缓存入口、实时配置、接口或其他来源。 */
export class PublishedAssetCache {
  readonly metrics = { resourceHits: 0, downloads: 0, decodeHits: 0, decodes: 0, storageFailures: 0 };
  private readonly namespace: string;
  private readonly base: URL;
  private readonly assetBase: URL;
  private readonly documents: Set<string>;
  private readonly store: PublishedCacheStore;
  private readonly rawStore?: PublishedCacheStore;
  private rawAvailable = true;
  private readonly inFlight = new Map<string, Promise<SharedResponse>>();
  private readonly verifyRevision?: () => Promise<void>;
  private readonly resources?: ReadonlyMap<string, PublishedResourceIdentity>;
  private readonly controller = new AbortController();
  private storageAvailable = true;

  constructor(options: CacheOptions) {
    this.base = new URL(options.baseUrl);
    this.assetBase = new URL(options.assetBase, this.base);
    this.namespace = JSON.stringify([this.base.href, options.revision]);
    this.documents = new Set(options.documentUrls.map(url => new URL(url, this.base).href));
    this.store = options.store ?? new IndexedDbPublishedCacheStore();
    this.rawStore = options.rawStore;
    this.verifyRevision = options.verifyRevision;
    this.resources = options.resources;
  }

  accepts(source: string): boolean {
    try {
      const url = new URL(source, this.base);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== this.base.origin || url.username || url.password) return false;
      url.hash = '';
      if (this.resources) return this.resources.has(this.resourceUrl(url));
      return this.documents.has(url.href) || (url.origin === this.assetBase.origin
        && this.assetBase.pathname !== this.base.pathname && this.assetBase.pathname.startsWith(this.base.pathname)
        && url.pathname.startsWith(this.assetBase.pathname));
    } catch { return false; }
  }

  async fetch(source: string, init: RequestInit = {}, onProgress?: AssetReadProgress, maxBytes?: number): Promise<Response> {
    init.signal?.throwIfAborted();
    if (!this.rawStore || maxBytes !== undefined || !this.accepts(source) || init.headers || init.body || (init.method && init.method !== 'GET')) {
      return this.fetchResource(source, init, onProgress, maxBytes);
    }
    const url = this.resourceUrl(new URL(source, this.base));
    let pending = this.inFlight.get(url);
    if (!pending) {
      pending = this.fetchResource(url, { ...init, signal: undefined }, onProgress).then(async response => ({
        blob: await response.blob(), status: response.status, statusText: response.statusText, headers: [...response.headers.entries()],
      })).finally(() => this.inFlight.delete(url));
      this.inFlight.set(url, pending);
    }
    // 一个读取者取消不能中断其它读取者，页面销毁仍由共享 controller 终止。
    const response = await new Promise<SharedResponse>((resolve, reject) => {
      const cleanup = () => init.signal?.removeEventListener('abort', abort);
      const abort = () => { cleanup(); reject(init.signal?.reason); };
      init.signal?.addEventListener('abort', abort, { once: true });
      pending!.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
    onProgress?.(response.blob.size, response.blob.size);
    // 共用不可变 Blob，每个读取者独立创建流，避免 Response.clone 未消费分支缓冲整个大模型。
    return new Response([204, 205, 304].includes(response.status) ? null : response.blob,
      { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  private async fetchResource(source: string, init: RequestInit = {}, onProgress?: AssetReadProgress, maxBytes?: number): Promise<Response> {
    if (!this.accepts(source) || (init.method && init.method !== 'GET') || init.headers || init.body) return fetch(source, init);
    const signal = init.signal ? AbortSignal.any([init.signal, this.controller.signal]) : this.controller.signal;
    signal.throwIfAborted();
    const url = new URL(source, this.base); url.hash = '';
    const key = this.resourceKey(url);
    const cached = await this.readRaw(key) as CachedResponse | undefined;
    const identity = this.resources?.get(this.resourceUrl(url));
    signal.throwIfAborted();
    if (cached?.blob instanceof Blob && typeof cached.type === 'string'
      && (!this.rawStore || !identity || (cached.blob.size === identity.size && await hashPublishedBlob(cached.blob, signal) === identity.sha256))) {
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
    if (!this.rawStore && length !== null && length > PUBLISHED_CACHE_MAX_ENTRY_BYTES) return response;
    let loaded = 0;
    onProgress?.(0, length);
    const stream = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      loaded += chunk.byteLength;
      if (identity && loaded > identity.size) throw new Error('发布资源与清单不一致：文件大小超出清单。');
      if (maxBytes !== undefined && loaded > maxBytes) throw new Error(`资源超过读取上限（${maxBytes} 字节）。`);
      onProgress?.(loaded, length); controller.enqueue(chunk);
    } }), { signal });
    const blob = await (stream ? new Response(stream).blob() : response.blob());
    if (maxBytes !== undefined && blob.size > maxBytes) throw new Error(`资源超过读取上限（${maxBytes} 字节）。`);
    signal.throwIfAborted();
    if (identity && (blob.size !== identity.size
      || await hashPublishedBlob(blob, signal) !== identity.sha256)) {
      throw new Error('发布资源与清单不一致，可能已重新发布，请重新加载场景。');
    }
    // 稳定发布地址可能在下载途中被新版本替换，校验后才允许写入旧版本的缓存空间。
    await this.verifyRevision?.();
    signal.throwIfAborted();
    const record: CachedResponse = { blob, type: response.headers.get('content-type') ?? 'application/octet-stream', sha256: identity?.sha256 };
    await this.writeRaw(key, record, blob.size);
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

  private resourceKey(url: URL): string {
    return `${this.namespace}:resource:${this.rawStore ? this.resourceUrl(url) : url.href}`;
  }

  async hasResource(source: string): Promise<boolean> {
    const url = new URL(source, this.base);
    const identity = this.resources?.get(this.resourceUrl(url));
    const record = await this.readRaw(this.resourceKey(url)) as CachedResponse | undefined;
    return record?.blob instanceof Blob && (!identity || (record.blob.size === identity.size && record.sha256 === identity.sha256));
  }

  private async readRaw(key: string): Promise<unknown> {
    if (!this.rawStore) return this.read(key);
    if (!this.rawAvailable) return undefined;
    try { return await this.rawStore.get(key); }
    catch (error) { this.rawFailure(error); return undefined; }
  }

  private async writeRaw(key: string, record: CachedResponse, bytes: number): Promise<void> {
    if (!this.rawStore) return this.write(key, record, bytes);
    if (!this.rawAvailable) return;
    try { await this.rawStore.put(key, record, bytes); }
    catch (error) { this.rawFailure(error); }
  }

  private rawFailure(error: unknown): void {
    if (!this.rawAvailable || this.controller.signal.aborted) return;
    this.rawAvailable = false; this.metrics.storageFailures++;
    this.rawStore?.close?.();
    console.warn('[Viewer cache] 发布文件缓存不可用，本次继续正常加载。', error);
  }

  private resourceUrl(url: URL): string {
    const resource = new URL(url); resource.search = ''; resource.hash = '';
    return resource.href;
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
    if (!this.storageAvailable || this.controller.signal.aborted) return;
    this.storageAvailable = false;
    this.metrics.storageFailures++;
    this.store.close?.();
    console.warn('[Viewer cache] 持久缓存不可用，本次继续正常加载。', error);
  }

  dispose(): void { this.controller.abort(); this.store.close?.(); this.rawStore?.close?.(); this.inFlight.clear(); }
}
