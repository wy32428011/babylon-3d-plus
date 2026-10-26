import type { LightingBakeGeometry, LightingProbeData, SceneLightingBakeSnapshot } from './sceneLightingBakeContract.ts';
import { isLightingLightmapMipEncoding } from './sceneLightingLightmapMips.ts';
import { getLightingLightmapTextureBytes } from './sceneLightingTextureCodec.ts';
function finiteNumbers(values: Iterable<unknown>): boolean { for (const value of values) if (typeof value !== 'number' || !Number.isFinite(value)) return false; return true; }
/** 只接受完整有限的三角网格；错误结果不得覆盖当前可用的原几何。 */
export function validateLightingGeometry(value: unknown): LightingBakeGeometry {
  if (!value || typeof value !== 'object') throw new Error('光照派生几何格式错误。');
  const geometry = value as LightingBakeGeometry;
  if ((geometry.version !== 1 && geometry.version !== 2) || !(Array.isArray(geometry.positions) || geometry.positions instanceof Float32Array) || !geometry.positions.length || geometry.positions.length % 3) throw new Error('光照派生几何顶点无效。');
  const count = geometry.positions.length / 3;
  for (const [key, length] of [['normals', count * 3], ['uvs', count * 2], ['bakeUvs', count * 2], ['uvs2', count * 2], ['colors', count * 4], ['tangents', count * 4]] as const) {
    const data = geometry[key];
    if ((key === 'uvs2' || key === 'colors' || key === 'tangents') && data === undefined) continue;
    if (!(Array.isArray(data) || data instanceof Float32Array) || data.length !== length || !finiteNumbers(data)) throw new Error(`光照派生几何的 ${key} 无效。`);
  }
  if (!finiteNumbers(geometry.positions) || !(Array.isArray(geometry.indices) || geometry.indices instanceof Uint32Array) || !geometry.indices.length || geometry.indices.length % 3 || !finiteNumbers(geometry.indices)
    || geometry.indices.some(index => !Number.isInteger(index) || index < 0 || index >= count)) throw new Error('光照派生几何索引越界。');
  if (geometry.bakeUvs.some(value => value < -1e-5 || value > 1.00001)) throw new Error('光照 UV 超出图集范围。');
  return geometry;
}

/** 后台提交、编辑器和 Viewer 共用，禁止无效数据进入正式结果。 */
export function validateLightingProbes(value: unknown): LightingProbeData {
  const data = value as LightingProbeData | null;
  if (!data || data.version !== 1 || data.encoding !== 'ambient-cube' || !Number.isFinite(data.spacing) || data.spacing <= 0 || !Array.isArray(data.probes) || !data.probes.length || data.probes.length > 4096) throw new Error('间接光探针数据不完整或超过安全预算。');
  for (const probe of data.probes) {
    if (!probe || !Array.isArray(probe.position) || probe.position.length !== 3 || !finiteNumbers(probe.position)
      || !Array.isArray(probe.irradiance) || probe.irradiance.length !== 18 || !finiteNumbers(probe.irradiance) || probe.irradiance.some(value => value < 0)) throw new Error('间接光探针数据不完整或超过安全预算。');
  }
  return data;
}
/** 检查 PNG 头部和真实尺寸；解码器继续负责验证完整图像。 */
export function validateLightingPng(bytes: Uint8Array, maxPixels: number, expected?: { width: number; height: number }): { width: number; height: number } {
  const signature = [137,80,78,71,13,10,26,10];
  if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value) || String.fromCharCode(...bytes.subarray(12,16)) !== 'IHDR') throw new Error('烘焙 PNG 纹理无效。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width * height > maxPixels) throw new Error('烘焙 PNG 纹理无效或超过纹理内存预算。');
  if (expected && (width !== expected.width || height !== expected.height)) throw new Error('光照图集 PNG 实际尺寸与元数据不一致。');
  return { width, height };
}

/** 生产图集是同尺寸RGBA方图；从v1统计推导尺寸，不增加场景字段或限制小型fixture。 */
export function getLightingAtlasDimensions(snapshot: Pick<SceneLightingBakeSnapshot, 'assets' | 'statistics'>): { width: number; height: number } {
  const count = snapshot.assets.filter(asset => asset.kind === 'lightmap').length;
  const { atlasCount, textureBytes } = snapshot.statistics;
  if (count === 0 || !Number.isSafeInteger(atlasCount) || atlasCount !== count || !Number.isSafeInteger(textureBytes) || textureBytes <= 0) {
    throw new Error('光照图集数量或纹理字节统计与实际资源不一致。');
  }
  const maps = snapshot.assets.filter(asset => asset.kind === 'lightmap'), mips = maps.filter(asset => isLightingLightmapMipEncoding(asset.encoding));
  if (mips.length) {
    let mipBytes = 0; let dimensions: { width: number; height: number } | undefined;
    for (const asset of mips) {
      if (!Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || !Number.isSafeInteger(asset.levelCount)
        || asset.width! < 2 || asset.height! < 2 || asset.levelCount! < 2 || asset.levelCount! > 5
        || asset.textureBytes !== getLightingLightmapTextureBytes(asset.width!, asset.height!, asset.levelCount! - 1)) throw new Error('光照mip图集元数据与RGBA统计不一致。');
      if (dimensions && (dimensions.width !== asset.width || dimensions.height !== asset.height)) throw new Error('光照图集必须使用一致的基础尺寸。');
      dimensions = { width: asset.width!, height: asset.height! }; mipBytes += asset.textureBytes!;
    }
    const pngCount = count - mips.length, pngBytes = textureBytes - mipBytes;
    if (pngCount) {
      const size = Math.sqrt(pngBytes / (pngCount * 4));
      if (!Number.isSafeInteger(size) || size <= 0 || size !== dimensions!.width || size !== dimensions!.height) throw new Error('混合光照PNG与mip图集尺寸/统计不一致。');
    } else if (pngBytes !== 0) throw new Error('光照mip全部RGBA级总量与统计不一致。');
    return dimensions!;
  }
  const pixels = textureBytes / (count * 4), size = Math.sqrt(pixels);
  if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(size) || size <= 0 || size * size * count * 4 !== textureBytes) {
    throw new Error('光照图集统计不能描述同尺寸RGBA方图。');
  }
  return { width: size, height: size };
}
