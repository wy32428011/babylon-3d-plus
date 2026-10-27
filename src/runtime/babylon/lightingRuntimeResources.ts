import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import type { Scene } from '@babylonjs/core';
import type { LightingBakeAsset, LightingBakeGeometry, LightingProbeData, SceneLightingBakeSnapshot } from '../../../electron/shared/sceneLightingBakeContract.ts';
import { fetchRuntimeAsset } from '../assets/runtimeAssetFetch.ts';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl';
import { LightingProbeSampler } from './lightingProbes.ts';
import { LightingResourceError } from './lightingRuntimeDiagnostic.ts';
import { decodeLightingGeometryResource } from '../../../electron/shared/sceneLightingBakeGeometryBinary.ts';
import { getLightingAtlasDimensions, validateLightingPng } from '../../../electron/shared/sceneLightingBakeArtifacts.ts';
import { getLightingLightmapBaseEncoding } from '../../../electron/shared/sceneLightingTextureCodec.ts';
import { isLightingLightmapMipEncoding, validateLightingLightmapMipAsset } from '../../../electron/shared/sceneLightingLightmapMips.ts';
import { validateSceneLightingBakeSnapshot } from '../../../electron/shared/sceneLightingBakeData.ts';
import type { createLightingLightmapMipTexture } from './lightingLightmapMipTexture.ts';
import { assertLightingRendererHeadroom, assertLightingWorkingBytes, lightingBakeResourceBudget } from '../../../electron/shared/sceneLightingBakeResources.ts';
export { validateLightingGeometry } from '../../../electron/shared/sceneLightingBakeArtifacts.ts';

export type LoadedLightingResources = {
  geometries: Map<string, LightingBakeGeometry>;
  textures: Map<string, Texture>;
  probes: LightingProbeSampler;
  dispose(): void;
};

async function readAsset(asset: LightingBakeAsset, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  const response = await fetchRuntimeAsset(resolveRuntimeAssetUrl(asset.url), { signal }, undefined, asset.byteLength);
  if (!response.ok) throw new Error(`无法读取光照资源 ${asset.id}（HTTP ${response.status}）。`);
  const bytes = await response.arrayBuffer();
  signal?.throwIfAborted();
  if (bytes.byteLength !== asset.byteLength) throw new Error(`光照资源 ${asset.id} 长度与清单不一致。`);
  if (asset.sha256 && globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (actual !== asset.sha256) throw new Error(`光照资源 ${asset.id} 校验失败。`);
  }
  signal?.throwIfAborted();
  return bytes;
}

async function loadTexture(scene: Scene, bytes: ArrayBuffer, signal: AbortSignal, decoder: LightingResourceLoadOptions['textureDecoder']): Promise<Texture> {
  signal.throwIfAborted();
  // 显式禁止预乘和色彩转换，RGBM 的 RGB 与 alpha 都是线性编码数据。
  const bitmap = decoder !== 'image' && typeof createImageBitmap === 'function'
    ? await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
      imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    }) : undefined;
  let bitmapOwnedByTexture = false;
  let objectUrl: string | undefined;
  try {
    signal.throwIfAborted();
    const textureUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    objectUrl = textureUrl;
    const texture = await new Promise<Texture>((resolve, reject) => {
      let settled = false;
      // 构造器的失败回调可同步触发，容器在创建前已存在，保留原undefined读取语义。
      const pending: { texture?: Texture } = {};
      let disposed = false;
      const dispose = () => { if (pending.texture && !disposed) { disposed = true; pending.texture.dispose(); } };
      const abort = () => finish(signal?.reason ?? new Error('光照资源加载已取消。'));
      signal?.addEventListener('abort', abort, { once: true });
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', abort);
        if (error !== undefined || !pending.texture) { dispose(); reject(error ?? new Error('光照贴图初始化失败。')); }
        else resolve(pending.texture);
      };
      // Blender lightmap UV 使用左下原点，上传 PNG 时翻转行；RGBM 的 alpha 是编码分量。
      // 图集预算按基础 RGBA 像素计；双线性采样不需要额外的 mip 链。
      pending.texture = new Texture(textureUrl, scene, true, !bitmap, Texture.BILINEAR_SAMPLINGMODE,
        () => queueMicrotask(() => finish()), message => finish(new Error(`光照贴图解码失败：${message ?? ''}`)), bitmap);
      // 同步失败或取消发生在赋值之前时，构造返回后补做释放，避免候选留在Scene纹理列表。
      if (settled) { dispose(); return; }
      pending.texture.gammaSpace = false;
      pending.texture.hasAlpha = false;
      pending.texture.wrapU = pending.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      if (signal?.aborted) abort();
    });
    if (bitmap) {
      // Babylon 在 WebGL context restore 时重用 buffer；成功上传后保留，随 Texture 一起释放。
      texture.onDisposeObservable.addOnce(() => bitmap.close());
      bitmapOwnedByTexture = true;
    }
    return texture;
  } finally { if (objectUrl) URL.revokeObjectURL(objectUrl); if (!bitmapOwnedByTexture) bitmap?.close(); }
}

/** 内部对照入口：生产默认四项并发，设为 1 可重复串行基线。 */
export type LightingResourceLoadOptions = { concurrency?: 1 | 4; textureDecoder?: 'bitmap' | 'image';
  maxTextureBytes?: number; onRestoreError?: (error: Error) => void;
  /** 包含仍存活的上一套GI；估算包含CPU恢复数据和GPU副本，不代表驱动实测显存。 */
  previousSnapshot?: SceneLightingBakeSnapshot; maxWorkingBytes?: number; maxResidentBytes?: number;
  /** 内部事务单元注入；生产使用真实WebGL2适配，不能据mock宣称GPU上传已通过。 */
  mipTextureFactory?: typeof createLightingLightmapMipTexture };

export function estimateLightingResourceBytes(snapshot: SceneLightingBakeSnapshot): { resident: number; weights: number[] } {
  const dimensions = getLightingAtlasDimensions(snapshot);
  let resident = 0;
  const weights = snapshot.assets.map(asset => {
    if (!Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0) throw new Error('光照资源长度无效。');
    if (asset.kind === 'lightmap') {
      const rgba = asset.textureBytes ?? dimensions.width * dimensions.height * 4;
      if (!Number.isSafeInteger(rgba) || rgba <= 0) throw new Error('光照贴图驻留估计无效。');
      resident += rgba * 2;
      return asset.byteLength + rgba * 3;
    }
    const bytes = asset.byteLength * (asset.kind === 'geometry' && asset.encoding === 'binary-v1' ? 3 : 8);
    resident += bytes; return bytes;
  });
  if (!Number.isSafeInteger(resident)) throw new Error('光照资源总量超出有效范围。');
  return { resident, weights };
}

/** 全部资源验证、解码完成后才返回候选集合，调用方在一次同步事务内切换可见几何。 */
export async function loadLightingResources(snapshot: SceneLightingBakeSnapshot, scene: Scene, signal?: AbortSignal,
  options: LightingResourceLoadOptions = {}): Promise<LoadedLightingResources> {
  const geometries = new Map<string, LightingBakeGeometry>(), textures = new Map<string, Texture>();
  let probes: LightingProbeSampler | null = null;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    controller.signal.throwIfAborted();
    const atlasDimensions = getLightingAtlasDimensions(snapshot);
    const systemBudget = typeof window !== 'undefined' && window.editorApi?.lightingBakeResourceBudget
      ? await window.editorApi.lightingBakeResourceBudget() : lightingBakeResourceBudget(null);
    controller.signal.throwIfAborted();
    const estimate = estimateLightingResourceBytes(snapshot);
    const previous = options.previousSnapshot ? estimateLightingResourceBytes(options.previousSnapshot).resident : 0;
    const workingLimit = options.maxWorkingBytes ?? systemBudget.workingBytes;
    const residentLimit = options.maxResidentBytes ?? systemBudget.backendBytes;
    // 独立Viewer没有OS余量接口，不能用虚构可用值拒绝既有资源；显式限额与桌面实测仍严格执行。
    if (options.maxResidentBytes !== undefined || systemBudget.availableBytes !== null) assertLightingWorkingBytes(estimate.resident + previous, residentLimit, '新旧GI共同驻留');
    assertLightingRendererHeadroom(estimate.resident);
    for (let index = 0; index < estimate.weights.length; index++) assertLightingWorkingBytes(estimate.weights[index], workingLimit, `资源「${snapshot.assets[index].id}」解码`);
    const hasMips = snapshot.assets.some(asset => asset.kind === 'lightmap' && isLightingLightmapMipEncoding(asset.encoding));
    if (hasMips && !validateSceneLightingBakeSnapshot(snapshot)) throw new Error('光照mip资源清单或recipe无效。');
    const textureBudget = options.maxTextureBytes ?? snapshot.statistics.textureBytes;
    if (hasMips && (!Number.isSafeInteger(textureBudget) || textureBudget <= 0 || snapshot.statistics.textureBytes > textureBudget)) throw new Error('光照mip全部RGBA级超过当前纹理预算。');
    const loadAsset = async (asset: LightingBakeAsset) => {
      try {
        const bytes = await readAsset(asset, controller.signal);
        if (asset.kind === 'lightmap') {
          const encoding = getLightingLightmapBaseEncoding(asset.encoding);
          if (encoding === 'rgbm-gamma' && (typeof asset.rgbmRange !== 'number' || asset.rgbmRange < 1 || !Number.isFinite(asset.rgbmRange))) throw new Error('Gamma RGBM 范围无效。');
          if (isLightingLightmapMipEncoding(asset.encoding)) {
            const decoded = validateLightingLightmapMipAsset(asset, new Uint8Array(bytes), Math.min(asset.textureBytes!, textureBudget, 0xffffffff));
            const create = options.mipTextureFactory ?? (await import('./lightingLightmapMipTexture.ts')).createLightingLightmapMipTexture;
            textures.set(asset.id, create(scene, decoded, { maxTextureBytes: decoded.totalTextureBytes, signal: controller.signal, onRestoreError: options.onRestoreError }));
          } else {
            validateLightingPng(new Uint8Array(bytes), atlasDimensions.width * atlasDimensions.height, atlasDimensions);
            textures.set(asset.id, await loadTexture(scene, bytes, controller.signal, options.textureDecoder));
          }
        } else {
          if (asset.kind === 'geometry') {
            if (asset.encoding !== undefined && asset.encoding !== 'json' && asset.encoding !== 'binary-v1') throw new Error('光照几何编码无效。');
            const geometry = decodeLightingGeometryResource(new Uint8Array(bytes), asset.encoding);
            if (asset.geometryVersion !== undefined && asset.geometryVersion !== geometry.version) throw new Error('光照几何与结果清单版本不一致。');
            geometries.set(asset.id, geometry);
          }
          else {
            if (asset.encoding !== undefined) throw new Error('光照探针不能声明资源编码。');
            if (asset.id === snapshot.probeAssetId) probes = new LightingProbeSampler(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as LightingProbeData);
          }
        }
      } catch (error) {
        // 取消沿用原始 reason；首个资源失败在中止同批任务前记录清单身份。
        if (controller.signal.aborted) throw error;
        const surface = snapshot.surfaces.find(value => value.geometryAssetId === asset.id || value.lightmapAssetId === asset.id);
        throw new LightingResourceError(error, asset, surface);
      }
    };
    let nextAsset = 0, activeBytes = 0;
    const available = new Set<() => void>();
    const wake = () => { for (const notify of available) notify(); available.clear(); };
    controller.signal.addEventListener('abort', wake);
    const worker = async () => {
      while (!controller.signal.aborted && nextAsset < snapshot.assets.length) {
        const index = nextAsset, weight = estimate.weights[index];
        if (activeBytes + weight > workingLimit) { await new Promise<void>(resolve => available.add(resolve)); continue; }
        const asset = snapshot.assets[nextAsset++]; activeBytes += weight;
        try { assertLightingRendererHeadroom(weight); await loadAsset(asset); }
        catch (error) { if (!controller.signal.aborted) controller.abort(error); }
        finally { activeBytes -= weight; wake(); }
      }
    };
    // 单项失败立即停止派发并取消同批任务；等待所有 worker 收束后才释放候选或返回。
    // 即使底层读取忽略 AbortSignal，也不能在仍可能写入候选集合时提前抛错。
    await Promise.all(Array.from({ length: Math.min(options.concurrency === 1 ? 1 : 4, snapshot.assets.length) }, worker));
    controller.signal.removeEventListener('abort', wake);
    controller.signal.throwIfAborted();
    if (!probes) throw new Error('光照资源缺少动态间接光探针。');
    // 保持原串行实现的清单迭代顺序，避免把异步完成顺序泄漏给调用方。
    for (const asset of snapshot.assets) {
      const texture = textures.get(asset.id), geometry = geometries.get(asset.id);
      if (texture) { textures.delete(asset.id); textures.set(asset.id, texture); }
      if (geometry) { geometries.delete(asset.id); geometries.set(asset.id, geometry); }
    }
    return { geometries, textures, probes, dispose() { for (const texture of textures.values()) texture.dispose(); textures.clear(); geometries.clear(); } };
  } catch (error) { for (const texture of textures.values()) texture.dispose(); textures.clear(); geometries.clear(); throw error; }
  finally { signal?.removeEventListener('abort', abort); }
}
