import { isLightingLightmapMipEncoding, type LightingLightmapMipEncoding } from './sceneLightingLightmapMips.ts';
/** 纹理的数值编码与容器分别演进；缺省始终表示既有线性 RGBM。 */
export type LightingLightmapBaseEncoding = 'rgbm' | 'rgbm-gamma';
/** 旧 PNG 省略此标记；只在真实新产物上写入 gamma。 */
export type LightingLightmapAssetEncoding = 'rgbm-gamma' | LightingLightmapMipEncoding;
export type LightingLightmapMipLevels = 1 | 2 | 3 | 4;
/** 新产物显式冻结生产算法；不能只靠相同物理GI摘要重用另一种padding/量化结果。 */
export const LIGHTING_LIGHTMAP_MIP_RECIPE = 'BLMIP001-chart-padding-v1-guard1-box-linear-v1-rgba8-f32-half-v1-packing-v2';
export const LIGHTING_LIGHTMAP_MIP_WORKING_BYTES_LIMIT = 2 * 1024 ** 3;

export function normalizeLightingLightmapMipLevels(value: unknown): LightingLightmapMipLevels | undefined {
  if (value === undefined || value === 1 || value === 2 || value === 3 || value === 4) return value;
  throw new Error(`光照贴图mip层级不受支持：${String(value)}`);
}
export function getRequestedLightingLightmapMipLevels(value: unknown): number { return normalizeLightingLightmapMipLevels(value) ?? 0; }
export function getLightingLightmapTextureBytes(width: number, height: number, additionalLevels: number): number {
  if (![width, height, additionalLevels].every(Number.isSafeInteger) || width <= 0 || height <= 0 || width > 8192 || height > 8192 || additionalLevels < 0 || additionalLevels > 4) throw new Error('光照贴图尺寸或mip层级无效。');
  let total = 0;
  for (let level = 0; level <= additionalLevels; level++) total += Math.max(1, width >> level) * Math.max(1, height >> level) * 4;
  return total;
}

export function normalizeLightingLightmapEncoding(value: unknown): LightingLightmapBaseEncoding | undefined {
  if (value === undefined || value === 'rgbm' || value === 'rgbm-gamma') return value;
  throw new Error(`光照贴图编码不受支持：${String(value)}`);
}

export function getRequestedLightingLightmapEncoding(value: unknown): LightingLightmapBaseEncoding {
  return normalizeLightingLightmapEncoding(value) ?? 'rgbm';
}

/** 这是 asset.encoding 的合同，不能把未知容器或拼错的编码默认为线性。 */
export function getLightingLightmapBaseEncoding(value: unknown): LightingLightmapBaseEncoding {
  if (value === undefined) return 'rgbm';
  if (value === 'rgbm-gamma') return value;
  if (value === 'rgbm-linear-mips-v1') return 'rgbm';
  if (value === 'rgbm-gamma-mips-v1') return 'rgbm-gamma';
  throw new Error(`光照贴图资产编码不受支持：${String(value)}`);
}

export function assertLightingLightmapVersion(version: 2 | 3, requested: unknown, encodings: readonly unknown[] = [], mipLevels?: unknown): void {
  const actual = encodings.map(getLightingLightmapBaseEncoding);
  const gamma = getRequestedLightingLightmapEncoding(requested) === 'rgbm-gamma'
    || actual.includes('rgbm-gamma');
  if (version === 2 && gamma) throw new Error('Gamma RGBM 光照贴图需要场景光照配置版本 3。');
  if (version === 2 && (getRequestedLightingLightmapMipLevels(mipLevels) > 0 || encodings.some(isLightingLightmapMipEncoding))) throw new Error('有限mip光照贴图需要场景光照配置版本 3。');
}

/** 物理 GI 摘要不含输出编码；单独核对所有图集，避免换开关后仍沿用同摘要的旧结果。 */
export function isLightingLightmapRecipeCompatible(requested: unknown,
  assets: readonly { kind: string; encoding?: unknown; levelCount?: number; mipRecipe?: string }[], mipLevels?: unknown): boolean {
  const expected = getRequestedLightingLightmapEncoding(requested);
  const levels = getRequestedLightingLightmapMipLevels(mipLevels);
  const actual = assets.filter(asset => asset.kind === 'lightmap').map(asset => ({ encoding: getLightingLightmapBaseEncoding(asset.encoding),
    levels: isLightingLightmapMipEncoding(asset.encoding) ? asset.levelCount : 1,
    recipe: isLightingLightmapMipEncoding(asset.encoding) ? asset.mipRecipe : undefined }));
  return actual.every(asset => asset.encoding === expected && asset.levels === levels + 1 && (levels === 0 || asset.recipe === LIGHTING_LIGHTMAP_MIP_RECIPE));
}
