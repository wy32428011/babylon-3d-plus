import { CubeTexture } from '@babylonjs/core/Materials/Textures/cubeTexture.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { inspectSkyboxEnvironmentBytes, normalizeSkyboxEnvironmentResource, type SkyboxEnvironmentResource } from '../../../electron/shared/sceneSkyboxContract.ts';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl.ts';
import { hashSkyboxContent } from './skyboxContentHash.ts';
import { loadSkyboxTexture } from './skyboxTextureLoad.ts';

export type SkyboxEnvironmentLoadStage = 'env-read' | 'env-upload';

/** 运行路径只接受已经预过滤的 ENV；不包含原图解码、全景转换或 HDRFiltering 依赖。 */
export function loadSkyboxEnvironment(engine: AbstractEngine, value: SkyboxEnvironmentResource, signal: AbortSignal,
  onProgress: (received: number, total: number | null) => void,
  onStage: (stage: SkyboxEnvironmentLoadStage, duration: number | null) => void): Promise<CubeTexture> {
  const resource = normalizeSkyboxEnvironmentResource(value);
  const url = new URL(resolveRuntimeAssetUrl(resource.sourceUrl), globalThis.document?.baseURI);
  url.searchParams.set('assetRevision', resource.sha256);
  return loadSkyboxTexture(url.href, signal, {
    onProgress,
    onStage: (stage, duration) => {
      if (stage === 'reading') onStage('env-read', duration);
      if (stage === 'decoding') onStage('env-upload', duration);
    },
    transformBlob: async blob => {
      if (blob.size !== resource.byteLength) throw new Error('天空 ENV 大小与资源描述不一致。');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      signal.throwIfAborted();
      if (await hashSkyboxContent(bytes) !== resource.sha256) throw new Error('天空 ENV SHA-256 校验失败，请重新准备资源。');
      inspectSkyboxEnvironmentBytes(bytes, resource.faceSize);
      return blob;
    },
    create: (blobUrl, onLoad, onError) => {
      const texture = new CubeTexture(blobUrl, engine, { prefiltered: true, forcedExtension: '.env', createPolynomials: true, onLoad, onError });
      texture.name = `SkyboxEnvironment:${resource.sha256}`;
      return texture;
    },
  });
}
