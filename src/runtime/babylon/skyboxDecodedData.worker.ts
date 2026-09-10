import { hashSkyboxContent } from './skyboxContentHash.ts';
import babylonPackage from '@babylonjs/core/package.json' with { type: 'json' };
import { ReadExrDataAsync } from '@babylonjs/core/Materials/Textures/Loaders/exrTextureLoader';
import { GetExrHeader } from '@babylonjs/core/Materials/Textures/Loaders/EXR/exrLoader.header';
import { GetCubeMapTextureData, RGBE_ReadHeader } from '@babylonjs/core/Misc/HighDynamicRange/hdr';
import { PanoramaToCubeMapTools, type CubeMapInfo } from '@babylonjs/core/Misc/HighDynamicRange/panoramaToCubemap';
import { getSkyboxCubeBytes, openSkyboxDecodedCache, readSkyboxDecodedCache, SKYBOX_CUBE_FACES, writeSkyboxDecodedCache } from './skyboxDecodedCache.ts';
import type { SkyboxDecodeMetrics, SkyboxDecodeRequest, SkyboxDecodeResponse, SkyboxDecodeStage } from './skyboxDecodedData.ts';
import { validateSkyboxDecodeInput, validateSkyboxSourceDimensions } from './skyboxDecodedValidation.ts';

const decoderVersion = `babylon-${babylonPackage.version}-panorama-v1`;
const send = (message: SkyboxDecodeResponse, transfer: Transferable[] = []) => self.postMessage(message, { transfer });

self.onmessage = async (event: MessageEvent<SkyboxDecodeRequest>) => {
  const start = performance.now();
  const { blob, format, size } = event.data;
  const metrics: SkyboxDecodeMetrics = { cache: 'miss', stages: {}, sourceBytes: blob.size, outputBytes: 0,
    workerMs: 0, decoderVersion, warnings: [] };
  let database: IDBDatabase | null = null;
  const measure = async <T>(stage: SkyboxDecodeStage, work: () => T | Promise<T>): Promise<T> => {
    send({ kind: 'stage', stage });
    const begin = performance.now();
    try { return await work(); } finally { metrics.stages[stage] = (metrics.stages[stage] ?? 0) + performance.now() - begin; }
  };
  const complete = (cube: CubeMapInfo | null) => {
    metrics.workerMs = performance.now() - start;
    metrics.outputBytes = cube ? getSkyboxCubeBytes(cube) : 0;
    const transfer = cube ? SKYBOX_CUBE_FACES.map(face => cube[face]!.buffer as ArrayBuffer) : [];
    send({ kind: 'result', cube, metrics }, transfer);
  };
  try {
    validateSkyboxDecodeInput(blob.size, size);
    const buffer = await measure('read', () => blob.arrayBuffer());
    if (format === 'exr') {
      const header = GetExrHeader(new DataView(buffer), { value: 0 });
      validateSkyboxSourceDimensions(header.dataWindow?.xMax - header.dataWindow?.xMin + 1,
        header.dataWindow?.yMax - header.dataWindow?.yMin + 1);
      if (![0, 1, 4].includes(header.compression)) {
        // ZIP/ZIPS/PXR24 的 Babylon 路径会动态加载 fflate。此 Worker 保持离线且不新增依赖。
        metrics.cache = 'unsupported'; complete(null); return;
      }
    } else {
      const header = RGBE_ReadHeader(new Uint8Array(buffer));
      validateSkyboxSourceDimensions(header.width, header.height);
    }
    const key = await measure('hash', async () =>
      `${decoderVersion}:${format}:${size}:${await hashSkyboxContent(new Uint8Array(buffer))}`);
    try {
      database = await measure('cache-read', () => openSkyboxDecodedCache());
      const opened = database;
      const cached = await measure('cache-read', () => readSkyboxDecodedCache(opened, key, size));
      if (cached) { metrics.cache = 'hit'; complete(cached); return; }
    } catch (error) {
      metrics.cache = 'unavailable'; metrics.warnings.push(error instanceof Error ? error.message : String(error));
    }
    let cube: CubeMapInfo;
    if (format === 'exr') {
      const decoded = await measure('decode', () => ReadExrDataAsync(buffer));
      if (!decoded.data) throw new Error('EXR 数据无法解码。');
      cube = await measure('convert', () => PanoramaToCubeMapTools.ConvertPanoramaToCubemap(decoded.data!, decoded.width, decoded.height, size, false, false));
    } else {
      cube = await measure('decode', () => GetCubeMapTextureData(buffer, size, false));
    }
    if (database) {
      try { await measure('cache-write', () => writeSkyboxDecodedCache(database!, key, cube)); }
      catch (error) { metrics.warnings.push(error instanceof Error ? error.message : String(error)); }
    }
    complete(cube);
  } catch (error) {
    send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally { database?.close(); }
};
