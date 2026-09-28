import { fetchRuntimeAsset } from '../assets/runtimeAssetFetch.ts';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl.ts';
import { hashSkyboxContent } from '../babylon/skyboxContentHash.ts';

export type OpeningRuntimeAsset = {
  id: string; path: string; type?: string; sha256?: string; size?: number; assetUrl?: string;
};
type AssetLoaderOptions = {
  fetch?: typeof fetch;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  maxAssetBytes?: number;
};

/** 包引用始终相对自身 manifest，禁止跳出目录或隐式请求外部网络。 */
export function resolveOpeningAssetUrl(manifestUrl: string, path: string, baseUrl = globalThis.document?.baseURI): string {
  if (!path || /^[a-z][a-z\d+.-]*:/i.test(path) || /[\\?#\x00-\x1f]/.test(path) || path.startsWith('/')) {
    throw new Error(`开场素材路径不合法：${path}`);
  }
  const segments = path.split('/');
  if (segments.some(segment => {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return true; }
    return !decoded || decoded === '.' || decoded === '..' || /[\\/\x00-\x1f]/.test(decoded);
  })) throw new Error(`开场素材路径不得离开包目录：${path}`);
  const manifest = new URL(manifestUrl, baseUrl);
  if (!['http:', 'https:', 'editor-asset:', 'file:'].includes(manifest.protocol)) throw new Error('开场素材路径协议不受支持。');
  assertOpeningAssetOrigin(manifest, baseUrl);
  if (manifest.protocol === 'editor-asset:') {
    if (manifest.hostname !== 'local') throw new Error('开场素材路径不是本地授权资源。');
    const decoded = decodeURIComponent(manifest.pathname.slice(1));
    const slash = Math.max(decoded.lastIndexOf('/'), decoded.lastIndexOf('\\'));
    if (slash < 0) throw new Error('开场素材路径缺少包目录。');
    const separator = decoded.includes('\\') ? '\\' : '/';
    return `editor-asset://local/${encodeURIComponent(decoded.slice(0, slash + 1) + path.split('/').join(separator))}`;
  }
  return new URL(path, manifest).href;
}

function assertOpeningAssetOrigin(url: URL, baseUrl = globalThis.document?.baseURI): void {
  if (!['http:', 'https:'].includes(url.protocol) || !baseUrl) return;
  const host = new URL(baseUrl);
  if (url.origin !== host.origin) throw new Error('开场素材必须来自当前 Viewer 同源地址。');
}

/** 每次播放拥有独立的取消信号和 URL；包资源经发布缓存入口读取。 */
export class OpeningPackageAssets {
  private readonly manifestUrl: string;
  private readonly assets: Map<string, OpeningRuntimeAsset>;
  private readonly options: AssetLoaderOptions;
  private readonly abort = new AbortController();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly urls = new Set<string>();
  private disposed = false;

  constructor(manifestUrl: string, assets: readonly OpeningRuntimeAsset[], options: AssetLoaderOptions = {}) {
    this.manifestUrl = manifestUrl;
    this.assets = new Map(assets.map(asset => [asset.id, asset]));
    this.options = options;
  }

  async url(id: string): Promise<string> {
    if (this.disposed) throw new Error('开场素材会话已释放。');
    const existing = this.pending.get(id);
    if (existing) return existing;
    const asset = this.assets.get(id);
    if (!asset) throw new Error(`开场包未声明素材：${id}`);
    const pending = this.load(asset);
    this.pending.set(id, pending);
    return pending;
  }

  private async load(asset: OpeningRuntimeAsset): Promise<string> {
    const url = asset.assetUrl ? this.overrideUrl(asset.assetUrl) : resolveOpeningAssetUrl(this.manifestUrl, asset.path);
    // SOURCE/DIST 保存的是虚拟 editor-asset 键；必须与模型一样先应用 Viewer 部署清单。
    const runtimeUrl = typeof window === 'undefined' ? url : resolveRuntimeAssetUrl(url);
    assertOpeningAssetOrigin(new URL(runtimeUrl, globalThis.document?.baseURI ?? this.manifestUrl));
    const limit = this.options.maxAssetBytes ?? 64 * 1024 * 1024;
    const response = this.options.fetch
      ? await this.options.fetch(runtimeUrl, { signal: this.abort.signal })
      : await fetchRuntimeAsset(runtimeUrl, { signal: this.abort.signal }, undefined, limit);
    this.assertLive();
    if (!response.ok) throw new Error(`开场素材 ${asset.id} 读取失败（HTTP ${response.status}）。`);
    const advertised = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertised) && advertised > limit) throw new Error(`开场素材 ${asset.id} 超过允许大小。`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const result = await reader.read();
          this.assertLive();
          if (result.done) break;
          size += result.value.byteLength;
          if (size > limit) throw new Error(`开场素材 ${asset.id} 超过允许大小。`);
          chunks.push(new Uint8Array(result.value));
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
    }
    const mimePath = asset.assetUrl ? decodeURIComponent(new URL(url).pathname) : asset.path;
    const blob = reader ? new Blob(chunks, { type: this.mime(mimePath) }) : new Blob([await response.blob()], { type: this.mime(mimePath) });
    this.assertLive();
    if (blob.size > limit) throw new Error(`开场素材 ${asset.id} 超过允许大小。`);
    if (asset.size !== undefined && asset.size !== blob.size) throw new Error(`开场素材 ${asset.id} 完整性校验失败：文件大小不符。`);
    if (asset.sha256 && await hashSkyboxContent(new Uint8Array(await blob.arrayBuffer())) !== asset.sha256.toLowerCase()) {
      throw new Error(`开场素材 ${asset.id} 完整性校验失败：SHA-256 不符。`);
    }
    this.assertLive();
    const objectUrl = (this.options.createObjectURL ?? URL.createObjectURL)(blob);
    this.urls.add(objectUrl);
    return objectUrl;
  }

  private mime(path: string): string {
    const ext = path.toLowerCase().split('.').pop();
    return ({ svg: 'image/svg+xml', webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
  }
  private overrideUrl(value: string): string {
    const url = new URL(value, globalThis.document?.baseURI ?? this.manifestUrl);
    if (!['http:', 'https:', 'editor-asset:', 'file:'].includes(url.protocol)) throw new Error('开场替换素材路径协议不受支持。');
    assertOpeningAssetOrigin(url);
    if (url.protocol === 'editor-asset:' && url.hostname !== 'local') throw new Error('开场替换素材必须是本地授权资源。');
    return url.href;
  }
  private assertLive(): void { if (this.disposed || this.abort.signal.aborted) throw new Error('开场素材会话已释放。'); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    for (const url of this.urls) (this.options.revokeObjectURL ?? URL.revokeObjectURL)(url);
    this.urls.clear(); this.pending.clear();
  }
}
