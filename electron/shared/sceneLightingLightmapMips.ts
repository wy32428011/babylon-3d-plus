/** 有限 RGBM mip 容器。行 0 对应 Blender pixels 的底行，也就是纹理 v=0。 */
export type LightingLightmapMipEncoding = 'rgbm-linear-mips-v1' | 'rgbm-gamma-mips-v1';
export type LightingLightmapMipBaseEncoding = 'rgbm' | 'rgbm-gamma';
export type LightingLightmapMipLevel = { width: number; height: number; rgba: Uint8Array };
export type LightingLightmapMipMetadata = {
  containerEncoding: LightingLightmapMipEncoding;
  baseEncoding: LightingLightmapMipBaseEncoding;
  rgbmRange: number;
  width: number;
  height: number;
  levelCount: number;
  totalTextureBytes: number;
};
export type DecodedLightingLightmapMips = LightingLightmapMipMetadata & {
  /** 只读使用；视图引用输入容器，避免解码再分配整条链。 */
  levels: readonly LightingLightmapMipLevel[];
};
export type LightingLightmapMipLimits = {
  /** 必须由调用方给出剩余 RGBA GPU 预算；不能用压缩文件长度代替。 */
  maxTextureBytes: number;
  expectedEncoding?: LightingLightmapMipEncoding;
  expectedRange?: number;
  expectedWidth?: number;
  expectedHeight?: number;
  expectedLevelCount?: number;
};

const MAGIC = [66, 76, 77, 73, 80, 48, 48, 49]; // BLMIP001
const FIXED_HEADER_BYTES = 64;
const LEVEL_BYTES = 16;
const MAX_DIMENSION = 8192;

function fail(message: string): never { throw new Error(`光照 mip 容器无效：${message}`); }
function shared(bytes: Uint8Array): boolean {
  // 普通 Electron/Viewer 页面不一定启用 crossOriginIsolated，不能直接读取缺失的全局。
  return typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer;
}
function integer(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${field} 超出范围。`);
  return value;
}
function validRange(value: number): number {
  if (!Number.isFinite(value) || value < 1) fail('RGBM 范围必须是有限且至少为 1。');
  return value;
}
function dimensions(width: number, height: number, count: number): number {
  integer(width, 2, MAX_DIMENSION, 'width'); integer(height, 2, MAX_DIMENSION, 'height');
  if ((width & (width - 1)) || (height & (height - 1))) fail('尺寸必须是 2 的幂。');
  integer(count, 2, 5, 'levelCount');
  // 本合同只允许额外 LOD 1..4，且不能在已经到达 1x1 后重复定义伪层级。
  if (count > Math.floor(Math.log2(Math.max(width, height))) + 1) fail('层级超过完整 mip 链。');
  let total = 0;
  for (let level = 0; level < count; level++) total += Math.max(1, width >> level) * Math.max(1, height >> level) * 4;
  return total;
}
function budget(total: number, maximum: number): void {
  integer(maximum, 1, 0xffffffff, 'maxTextureBytes');
  if (total > maximum) fail(`RGBA 总量 ${total} 超过预算 ${maximum}。`);
}

export function isLightingLightmapMipEncoding(value: unknown): value is LightingLightmapMipEncoding {
  return value === 'rgbm-linear-mips-v1' || value === 'rgbm-gamma-mips-v1';
}

/** 编码只复制已量化的各级数据；过滤、量化和 chart 安全证明由离线生产端负责。 */
export function encodeLightingLightmapMips(input: {
  baseEncoding: LightingLightmapMipBaseEncoding; rgbmRange: number;
  levels: readonly LightingLightmapMipLevel[]; maxTextureBytes: number;
}): Uint8Array {
  if (input.baseEncoding !== 'rgbm' && input.baseEncoding !== 'rgbm-gamma') fail('未知 texel 编码。');
  validRange(input.rgbmRange);
  const first = input.levels[0];
  if (!first) fail('缺少基础级。');
  const total = dimensions(first.width, first.height, input.levels.length);
  budget(total, input.maxTextureBytes);
  const headerBytes = FIXED_HEADER_BYTES + LEVEL_BYTES * input.levels.length;
  const bytes = new Uint8Array(headerBytes + total), view = new DataView(bytes.buffer);
  bytes.set(MAGIC);
  view.setUint16(8, 1, true); // 容器版本
  view.setUint8(10, 1); // little-endian
  view.setUint8(11, input.baseEncoding === 'rgbm' ? 0 : 1);
  view.setUint32(12, headerBytes, true);
  view.setUint32(16, first.width, true); view.setUint32(20, first.height, true);
  view.setUint32(24, input.levels.length, true); view.setUint32(28, 1, true); // bottom-row-first
  view.setFloat64(32, input.rgbmRange, true);
  view.setUint32(40, total, true); view.setUint32(44, bytes.byteLength, true);
  let offset = headerBytes;
  input.levels.forEach((level, index) => {
    const width = Math.max(1, first.width >> index), height = Math.max(1, first.height >> index);
    const length = width * height * 4;
    if (level.width !== width || level.height !== height || !(level.rgba instanceof Uint8Array)
      || shared(level.rgba) || level.rgba.byteLength !== length) fail(`第 ${index} 级尺寸/数据不一致。`);
    const table = FIXED_HEADER_BYTES + index * LEVEL_BYTES;
    view.setUint32(table, width, true); view.setUint32(table + 4, height, true);
    view.setUint32(table + 8, offset, true); view.setUint32(table + 12, length, true);
    bytes.set(level.rgba, offset); offset += length;
  });
  return bytes;
}

/** 严格解析后返回零拷贝视图；未知 marker、保留字段或尾随数据均不回退成旧 PNG。 */
export function decodeLightingLightmapMips(bytes: Uint8Array, limits: LightingLightmapMipLimits): DecodedLightingLightmapMips {
  if (!(bytes instanceof Uint8Array) || shared(bytes) || bytes.byteLength < FIXED_HEADER_BYTES) fail('头部截断或共享缓冲。');
  if (!MAGIC.every((value, index) => bytes[index] === value)) fail('magic 不匹配。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(8, true) !== 1 || view.getUint8(10) !== 1) fail('版本/字节序不受支持。');
  const codec = view.getUint8(11);
  if (codec !== 0 && codec !== 1) fail('未知 texel 编码。');
  if (view.getUint32(28, true) !== 1 || bytes.subarray(48, 64).some(value => value !== 0)) fail('行向或保留字段不受支持。');
  const width = view.getUint32(16, true), height = view.getUint32(20, true), levelCount = view.getUint32(24, true);
  const totalTextureBytes = dimensions(width, height, levelCount);
  budget(totalTextureBytes, limits.maxTextureBytes);
  const rgbmRange = validRange(view.getFloat64(32, true));
  const headerBytes = FIXED_HEADER_BYTES + LEVEL_BYTES * levelCount;
  if (view.getUint32(12, true) !== headerBytes || view.getUint32(40, true) !== totalTextureBytes
    || view.getUint32(44, true) !== bytes.byteLength || bytes.byteLength !== headerBytes + totalTextureBytes) fail('头长/总长度不一致。');
  const baseEncoding = codec === 0 ? 'rgbm' : 'rgbm-gamma';
  const containerEncoding = codec === 0 ? 'rgbm-linear-mips-v1' : 'rgbm-gamma-mips-v1';
  const expected: readonly [unknown, unknown, string][] = [
    [limits.expectedEncoding, containerEncoding, 'encoding'], [limits.expectedRange, rgbmRange, 'rgbmRange'],
    [limits.expectedWidth, width, 'width'], [limits.expectedHeight, height, 'height'], [limits.expectedLevelCount, levelCount, 'levelCount'],
  ];
  for (const [requested, actual, field] of expected) if (requested !== undefined && requested !== actual) fail(`清单 ${field} 与头部不一致。`);
  let offset = headerBytes;
  const levels: LightingLightmapMipLevel[] = [];
  for (let level = 0; level < levelCount; level++) {
    const w = Math.max(1, width >> level), h = Math.max(1, height >> level), length = w * h * 4;
    const table = FIXED_HEADER_BYTES + level * LEVEL_BYTES;
    if (view.getUint32(table, true) !== w || view.getUint32(table + 4, true) !== h
      || view.getUint32(table + 8, true) !== offset || view.getUint32(table + 12, true) !== length) fail(`第 ${level} 级偏移/长度/尺寸不一致。`);
    levels.push({ width: w, height: h, rgba: bytes.subarray(offset, offset + length) }); offset += length;
  }
  return { containerEncoding, baseEncoding, rgbmRange, width, height, levelCount, totalTextureBytes, levels };
}

/**
 * 接收端与归档器共用的严格结构门。调用方仍须在本函数前核对 SHA 和授权路径；
 * 只有该白名单中的、实读验证通过的 asset.url 才能加入 ZIP STORE 集合，不能泛化到全部 .bin。
 */
export function validateLightingLightmapMipAsset(asset: {
  kind: unknown; encoding?: unknown; url: string; byteLength: number; rgbmRange?: number;
  width?: number; height?: number; levelCount?: number; textureBytes?: number;
}, bytes: Uint8Array, maxTextureBytes: number): DecodedLightingLightmapMips {
  if (asset.kind !== 'lightmap' || !isLightingLightmapMipEncoding(asset.encoding)) fail('资产类型/编码不受支持。');
  if (typeof asset.url !== 'string' || !/\.bin$/i.test(asset.url) || /[?#\0]/.test(asset.url)) fail('资产必须是明确的 .bin 路径。');
  if (!Number.isSafeInteger(asset.byteLength) || asset.byteLength !== bytes.byteLength) fail('资产文件长度不一致。');
  if (asset.rgbmRange === undefined || asset.width === undefined || asset.height === undefined
    || asset.levelCount === undefined || asset.textureBytes === undefined) fail('资产缺少 mip 元数据。');
  const decoded = decodeLightingLightmapMips(bytes, { maxTextureBytes, expectedEncoding: asset.encoding,
    expectedRange: asset.rgbmRange, expectedWidth: asset.width, expectedHeight: asset.height, expectedLevelCount: asset.levelCount });
  if (asset.textureBytes !== decoded.totalTextureBytes) fail('资产 RGBA 统计不一致。');
  return decoded;
}
