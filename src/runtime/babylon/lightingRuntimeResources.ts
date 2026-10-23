import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import type { Scene } from '@babylonjs/core';
import type { LightingBakeAsset, LightingBakeGeometry, LightingProbeData, SceneLightingBakeSnapshot } from '../../../electron/shared/sceneLightingBakeContract.ts';
import { fetchRuntimeAsset } from '../assets/runtimeAssetFetch.ts';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl';
import { LightingProbeSampler } from './lightingProbes.ts';
import { LightingResourceError } from './lightingRuntimeDiagnostic.ts';
import { getLightingAtlasDimensions, validateLightingGeometry, validateLightingPng } from '../../../electron/shared/sceneLightingBakeArtifacts.ts';
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
  return bytes;
}

async function loadTexture(scene: Scene, bytes: ArrayBuffer, signal?: AbortSignal): Promise<Texture> {
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  try {
    return await new Promise<Texture>((resolve, reject) => {
      let settled = false;
      // 构造器的失败回调可同步触发，容器在创建前已存在，保留原undefined读取语义。
      const pending: { texture?: Texture } = {};
      const abort = () => { if (!settled) { settled = true; pending.texture?.dispose(); reject(signal?.reason ?? new Error('光照资源加载已取消。')); } };
      signal?.addEventListener('abort', abort, { once: true });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', abort);
        if (error || !pending.texture) { pending.texture?.dispose(); reject(error ?? new Error('光照贴图初始化失败。')); }
        else resolve(pending.texture);
      };
      // Blender lightmap UV 使用左下原点，上传 PNG 时翻转行；RGBM 的 alpha 是编码分量。
      // 图集预算按基础 RGBA 像素计；双线性采样不需要额外的 mip 链。
      pending.texture = new Texture(objectUrl, scene, true, true, Texture.BILINEAR_SAMPLINGMODE,
        () => queueMicrotask(() => finish()), message => finish(new Error(`光照贴图解码失败：${message ?? ''}`)));
      // 同步失败或取消发生在赋值之前时，构造返回后补做释放，避免候选留在Scene纹理列表。
      if (settled) { pending.texture.dispose(); return; }
      pending.texture.gammaSpace = false;
      pending.texture.hasAlpha = false;
      pending.texture.wrapU = pending.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      if (signal?.aborted) abort();
    });
  } finally { URL.revokeObjectURL(objectUrl); }
}

/** 全部资源验证、解码完成后才返回候选集合，调用方在一次同步事务内切换可见几何。 */
export async function loadLightingResources(snapshot: SceneLightingBakeSnapshot, scene: Scene, signal?: AbortSignal): Promise<LoadedLightingResources> {
  const geometries = new Map<string, LightingBakeGeometry>(), textures = new Map<string, Texture>();
  let probes: LightingProbeSampler | null = null;
  try {
    const atlasDimensions = getLightingAtlasDimensions(snapshot);
    for (const asset of snapshot.assets) {
      try {
        const bytes = await readAsset(asset, signal);
        if (asset.kind === 'lightmap') {
          validateLightingPng(new Uint8Array(bytes), atlasDimensions.width * atlasDimensions.height, atlasDimensions);
          textures.set(asset.id, await loadTexture(scene, bytes, signal));
        } else {
          const content = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
          if (asset.kind === 'geometry') geometries.set(asset.id, validateLightingGeometry(content));
          else if (asset.id === snapshot.probeAssetId) probes = new LightingProbeSampler(content as LightingProbeData);
        }
      } catch (error) {
        // 取消沿用原始reason，只有资源读取/验证失败才追加清单身份。
        if (signal?.aborted) throw error;
        const surface = snapshot.surfaces.find(value => value.geometryAssetId === asset.id || value.lightmapAssetId === asset.id);
        throw new LightingResourceError(error, asset, surface);
      }
    }
    if (!probes) throw new Error('光照资源缺少动态间接光探针。');
    return { geometries, textures, probes, dispose() { for (const texture of textures.values()) texture.dispose(); textures.clear(); geometries.clear(); } };
  } catch (error) { for (const texture of textures.values()) texture.dispose(); throw error; }
}
