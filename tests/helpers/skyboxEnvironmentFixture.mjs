import { deflateSync } from 'node:zlib';

const MAGIC = Buffer.from([0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36]);
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}
function png(size) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const index = y * (size * 4 + 1) + 1 + x * 4;
    pixels[index] = 128; pixels[index + 1] = 64; pixels[index + 2] = 32; pixels[index + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
/** 完整可解码的常色六面 PNG 夹具，仅用于格式/存储测试，不作为 HDR 画质对照。 */
export function skyboxEnvironmentFixture(size = 256) {
  const images = [], mipmaps = []; let position = 0;
  for (let width = size; width >= 1; width /= 2) {
    const image = png(width);
    for (let face = 0; face < 6; face++) { mipmaps.push({ position, length: image.length }); images.push(image); position += image.length; }
  }
  const irradiance = Object.fromEntries(['x', 'y', 'z', 'xx', 'yy', 'zz', 'xy', 'yz', 'zx'].map(key => [key, [1, 1, 1]]));
  const header = { version: 2, width: size, imageType: 'image/png', irradiance, specular: { mipmaps, lodGenerationScale: .8 } };
  return Buffer.concat([MAGIC, Buffer.from(JSON.stringify(header)), Buffer.from([0]), ...images]);
}
export function changeSkyboxEnvironmentHeader(bytes, change) {
  const end = bytes.indexOf(0, 8), header = JSON.parse(bytes.subarray(8, end).toString('utf8'));
  change(header);
  return Buffer.concat([MAGIC, Buffer.from(JSON.stringify(header)), Buffer.from([0]), bytes.subarray(end + 1)]);
}
export function skyboxHdrFixture(value = 160) {
  const rows = Array.from({ length: 4 }, () => Buffer.from([2, 2, 0, 8, 136, value, 136, 100, 136, 80, 136, 128]));
  return Buffer.concat([Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4 +X 8\n'), ...rows]);
}
