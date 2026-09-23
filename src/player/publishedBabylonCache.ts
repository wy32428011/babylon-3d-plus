import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import type { Scene } from '@babylonjs/core/scene';
import type { IOfflineProvider } from '@babylonjs/core/Offline/IOfflineProvider';
import { DracoDecoder } from '@babylonjs/core/Meshes/Compression/dracoDecoder';
import type { MeshData } from '@babylonjs/core/Meshes/Compression/dracoDecoder.types';
import { MeshoptCompression } from '@babylonjs/core/Meshes/Compression/meshoptCompression';
import { KTX2Decoder } from '@babylonjs/ktx2decoder';
import type { IDecodedData } from '@babylonjs/core/Materials/Textures/ktx2decoderTypes';
import { PublishedAssetCache } from '../runtime/assets/publishedAssetCache';
import { installPublishedAssetCache } from '../runtime/assets/runtimeAssetFetch';
import type { PlayerRuntimeConfig } from './runtimeConfig';
import { loadPublishedCacheVersion, verifyPublishedCacheVersion } from './publishedCacheVersion';

function isMeshData(value: unknown): value is MeshData {
  if (!value || typeof value !== 'object') return false;
  const mesh = value as MeshData;
  return Number.isSafeInteger(mesh.totalVertices) && mesh.totalVertices >= 0
    && (mesh.indices === null || mesh.indices instanceof Uint16Array || mesh.indices instanceof Uint32Array)
    && Array.isArray(mesh.attributes) && mesh.attributes.length > 0 && mesh.attributes.every(attribute =>
      typeof attribute.kind === 'string' && ArrayBuffer.isView(attribute.data)
      && Number.isInteger(attribute.size) && attribute.size > 0 && attribute.size <= 4
      && Number.isInteger(attribute.byteOffset) && attribute.byteOffset >= 0
      && Number.isInteger(attribute.byteStride) && attribute.byteStride >= 0 && typeof attribute.normalized === 'boolean');
}

function isTextureData(value: unknown): value is IDecodedData {
  if (!value || typeof value !== 'object') return false;
  const texture = value as IDecodedData;
  return !texture.errors && Number.isInteger(texture.width) && texture.width > 0
    && Number.isInteger(texture.height) && texture.height > 0 && Number.isInteger(texture.transcodedFormat)
    && typeof texture.isInGammaSpace === 'boolean' && typeof texture.hasAlpha === 'boolean'
    && Array.isArray(texture.mipmaps) && texture.mipmaps.length > 0 && texture.mipmaps.every(mipmap =>
      mipmap.data instanceof Uint8Array && mipmap.data.byteLength > 0
      && Number.isInteger(mipmap.width) && mipmap.width > 0 && Number.isInteger(mipmap.height) && mipmap.height > 0);
}

/** 使用 Babylon 的离线资源接口覆盖 GLB/glTF 外链、贴图及普通纹理，不改全局 fetch/XHR。 */
class PublishedOfflineProvider implements IOfflineProvider {
  enableSceneOffline = true;
  enableTexturesOffline = true;
  private readonly objectUrls = new Set<string>();
  private disposed = false;
  constructor(private readonly cache: PublishedAssetCache) {}
  open(success: () => void): void { success(); }
  loadFile(url: string, loaded: (data: string | ArrayBuffer) => void,
    progress?: (event: ProgressEvent) => void, error?: (failure?: { status: number; message: string }) => void, useArrayBuffer?: boolean): void {
    if (!this.cache.accepts(url)) { error?.(); return; }
    void this.cache.fetch(url, {}, (received, total) => progress?.(new ProgressEvent('progress', {
      loaded: received, total: total ?? 0, lengthComputable: total !== null,
    }))).then(async response => {
      if (!response.ok) throw new Error(`发布资源加载失败：HTTP ${response.status}。`);
      const data = useArrayBuffer ? await response.arrayBuffer() : await response.text();
      if (!this.disposed) loaded(data);
    }).catch(cause => {
      if (this.disposed) return;
      console.warn('[Viewer cache] Babylon 资源读取失败，交由加载器报告。', cause);
      // Babylon 离线接口收到 HTTP 错误对象会走正常失败路径，避免版本冲突后回退下载新版同名文件。
      error?.({ status: 409, message: cause instanceof Error ? cause.message : String(cause) });
    });
  }
  loadImage(url: string, image: HTMLImageElement): void {
    if (!this.cache.accepts(url)) { image.src = url; return; }
    void this.cache.fetch(url).then(async response => {
      if (!response.ok) throw new Error(`发布图片加载失败：HTTP ${response.status}。`);
      const blob = await response.blob();
      if (this.disposed) return;
      const objectUrl = URL.createObjectURL(blob);
      this.objectUrls.add(objectUrl);
      const release = () => {
        URL.revokeObjectURL(objectUrl); this.objectUrls.delete(objectUrl);
        image.removeEventListener('load', release); image.removeEventListener('error', release);
      };
      image.addEventListener('load', release, { once: true }); image.addEventListener('error', release, { once: true });
      image.src = objectUrl;
    }).catch(cause => {
      if (this.disposed) return;
      console.warn('[Viewer cache] 发布图片读取失败，交由加载器报告。', cause);
      image.dispatchEvent(new Event('error'));
    });
  }
  dispose(): void {
    this.disposed = true;
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }
}

export async function installPublishedViewerCache(config: PlayerRuntimeConfig, baseUrl: string, signal: AbortSignal = new AbortController().signal): Promise<{
  cache: PublishedAssetCache; assetManifest?: unknown; verifyDocuments(): Promise<void>; attach(scene: Scene): void; dispose(): void;
} | null> {
  const version = await loadPublishedCacheVersion(config, baseUrl, signal);
  if (!version) return null;
  signal.throwIfAborted();
  const revisionController = new AbortController();
  let verifying: Promise<void> | null = null;
  const verifyRevision = () => {
    verifying ??= verifyPublishedCacheVersion(config, baseUrl, version, revisionController.signal)
      .finally(() => { verifying = null; });
    return verifying;
  };
  const cache = new PublishedAssetCache({ baseUrl, revision: version.revision, resources: version.resources, assetBase: new URL(config.paths.assetBase, baseUrl).href,
    documentUrls: version.resources ? [] : [config.paths.scene, config.paths.assetManifest].map(url => new URL(url, baseUrl).href),
    verifyRevision: version.resources ? undefined : verifyRevision });
  const restoreFetch = installPublishedAssetCache(cache);
  const provider = new PublishedOfflineProvider(cache);
  const previousFactory = AbstractEngine.OfflineProviderFactory;
  const factory: typeof previousFactory = (_url, checked) => { queueMicrotask(() => checked(true)); return provider; };
  AbstractEngine.OfflineProviderFactory = factory;

  // 持久化纯 CPU 数组；场景、Geometry、材质、动画和 GPU 资源仍归当前页面独立所有。
  const originalDraco = DracoDecoder.prototype.decodeMeshToMeshDataAsync;
  const draco: typeof originalDraco = function(this: DracoDecoder, data, attributes, normalized) {
    return cache.decode(JSON.stringify(['draco-v1', AbstractEngine.Version, attributes, normalized]), data,
      () => originalDraco.call(this, data, attributes, normalized), isMeshData,
      mesh => (mesh.indices?.byteLength ?? 0) + mesh.attributes.reduce((sum, attribute) => sum + attribute.data.byteLength, 0));
  };
  DracoDecoder.prototype.decodeMeshToMeshDataAsync = draco;
  const originalMeshopt = MeshoptCompression.prototype.decodeGltfBufferAsync;
  const meshopt: typeof originalMeshopt = function(this: MeshoptCompression, source, count, stride, mode, filter) {
    return cache.decode(JSON.stringify(['meshopt-v1', AbstractEngine.Version, count, stride, mode, filter]), source,
      () => originalMeshopt.call(this, source, count, stride, mode, filter),
      (value): value is Uint8Array => value instanceof Uint8Array && value.byteLength === count * stride, value => value.byteLength);
  };
  MeshoptCompression.prototype.decodeGltfBufferAsync = meshopt;
  const originalKtx = KTX2Decoder.prototype.decode;
  const ktx: typeof originalKtx = function(this: KTX2Decoder, source, capabilities, options) {
    // 转码输出依赖 GPU 支持的格式和解码选项，切换显卡/浏览器后不能误用旧数组。
    return cache.decode(JSON.stringify(['ktx2-v1', AbstractEngine.Version, capabilities, options, KTX2Decoder.DefaultDecoderOptions]), source,
      () => originalKtx.call(this, source, capabilities, options), isTextureData,
      texture => texture.mipmaps.reduce((sum, mipmap) => sum + (mipmap.data?.byteLength ?? 0), 0));
  };
  KTX2Decoder.prototype.decode = ktx;
  return {
    cache, assetManifest: version.assetManifest, verifyDocuments: verifyRevision,
    attach(scene) { scene.getEngine().enableOfflineSupport = true; scene.offlineProvider = provider; },
    dispose() {
      revisionController.abort();
      if (AbstractEngine.OfflineProviderFactory === factory) AbstractEngine.OfflineProviderFactory = previousFactory;
      if (DracoDecoder.prototype.decodeMeshToMeshDataAsync === draco) DracoDecoder.prototype.decodeMeshToMeshDataAsync = originalDraco;
      if (MeshoptCompression.prototype.decodeGltfBufferAsync === meshopt) MeshoptCompression.prototype.decodeGltfBufferAsync = originalMeshopt;
      if (KTX2Decoder.prototype.decode === ktx) KTX2Decoder.prototype.decode = originalKtx;
      restoreFetch(); provider.dispose(); cache.dispose();
    },
  };
}
