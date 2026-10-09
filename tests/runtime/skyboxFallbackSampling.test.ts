import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { BilinearHDRCubeTexture, BilinearEXRCubeTexture } from '../../src/runtime/babylon/BilinearSkyboxTexture.ts';

function gradientHdr(): ArrayBuffer {
  const parts = [Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 8 +X 16\n')];
  for (let y = 0; y < 8; y++) {
    parts.push(Buffer.from([2, 2, 0, 16]));
    for (const channel of [Array.from({ length: 16 }, (_, x) => x * 16), Array(16).fill(y * 16), Array(16).fill(128), Array(16).fill(132)]) {
      parts.push(Buffer.from([16, ...channel]));
    }
  }
  const bytes = Buffer.concat(parts);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('备用 HDR 加载同样平滑升采样，保留高动态值与 clone 类型', async () => {
  const engine = new NullEngine();
  const texture = new BilinearHDRCubeTexture('', engine, 32, false, true, false);
  try {
    const cube = await (texture as any)._getCubeMapTextureDataAsync(gradientHdr(), 32, false);
    const samples = [15, 16, 17, 18].map(x => cube.front[(16 * 32 + x) * 3]);
    for (let i = 1; i < samples.length; i++) assert.ok(samples[i] > samples[i - 1], `备用加载仍出现最近邻平台：${samples}`);
    assert.equal(cube.front[(16 * 32 + 16) * 3 + 2], 8);
    texture.gammaSpace = true;
    const clone = (texture as any)._instantiateClone();
    assert.equal(clone.constructor, texture.constructor);
    assert.equal(clone.gammaSpace, true);
    assert.equal(clone.getClassName(), 'HDRCubeTexture');
    clone.dispose();
  } finally { texture.dispose(); engine.dispose(); }
});

test('EXR 备用反射克隆保留平滑类和原格式，损坏数据明确失败', async () => {
  const engine = new NullEngine();
  const texture = new BilinearEXRCubeTexture('', engine, 16);
  try {
    const clone = (texture as any)._instantiateClone();
    assert.ok(clone instanceof BilinearEXRCubeTexture);
    assert.equal(clone.getClassName(), 'EXRCubeTexture');
    await assert.rejects((texture as any)._getCubeMapTextureDataAsync(new ArrayBuffer(8), 16));
    clone.dispose();
  } finally { texture.dispose(); engine.dispose(); }
});
