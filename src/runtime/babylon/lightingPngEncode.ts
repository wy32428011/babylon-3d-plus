export class LightingPixelDataError extends Error {}

const pngCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngChunk(type: string, bytes: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(bytes.length + 12), view = new DataView(chunk.buffer);
  view.setUint32(0, bytes.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(bytes, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length + 8; i++) crc = pngCrcTable[(crc ^ chunk[i]) & 255] ^ (crc >>> 8);
  view.setUint32(bytes.length + 8, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

/** Canvas 会预乘透明像素并丢失其 RGB；直接编码 RGBA，保留 opaque 忽略 alpha 时仍需使用的原色。 */
async function encodeLightingRgbaPng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number,
  signal?: AbortSignal): Promise<Uint8Array> {
  const stride = width * 4, scanlines = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) scanlines.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  if (typeof CompressionStream === 'undefined') throw new Error('当前运行环境不支持保留透明像素原色的 PNG 编码。');
  const compressed = new Uint8Array(await new Response(
    new Blob([scanlines]).stream().pipeThrough(new CompressionStream('deflate')),
  ).arrayBuffer());
  signal?.throwIfAborted();
  const header = new Uint8Array(13), headerView = new DataView(header.buffer);
  headerView.setUint32(0, width); headerView.setUint32(4, height); header[8] = 8; header[9] = 6;
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array())];
  const png = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { png.set(chunk, offset); offset += chunk.length; }
  return png;
}

export async function encodeLightingPixels(pixels: ArrayBufferView, width: number, height: number, name: string, signal?: AbortSignal): Promise<Uint8Array> {
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (pixels instanceof Float32Array || pixels instanceof Float64Array) {
    if (pixels.length !== rgba.length) throw new LightingPixelDataError(`纹理「${name}」像素通道长度不正确。`);
    for (let i = 0; i < rgba.length; i++) {
      const value = pixels[i];
      if (!Number.isFinite(value)) throw new LightingPixelDataError(`纹理「${name}」包含非有限像素，无法烘焙。`);
      if (value < 0 || value > 1) {
        throw new LightingPixelDataError(`纹理「${name}」包含超出 [0,1] 范围的 HDR 材质像素，当前 PNG 捕获不支持保真导出；请改用 LDR 贴图配合材质强度，或取消该表面烘焙。`);
      }
      rgba[i] = Math.round(value * 255);
    }
  } else {
    const source = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    if (source.length !== rgba.length) throw new LightingPixelDataError(`纹理「${name}」像素格式不支持无损导出。`);
    rgba.set(source);
  }
  return encodeLightingRgbaPng(rgba, width, height, signal);
}
