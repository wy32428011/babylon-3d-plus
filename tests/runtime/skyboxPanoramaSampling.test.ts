import assert from 'node:assert/strict';
import test from 'node:test';
import { convertSkyboxPanoramaToCubemap } from '../../src/runtime/babylon/skyboxPanoramaSampling.ts';

const gradient = (width: number, height: number) => Float32Array.from({ length: width * height * 3 }, (_, i) =>
  i % 3 === 0 ? Math.floor(i / 3) % width : i % 3 === 1 ? Math.floor(i / 3 / width) : 8);

test('连续天空渐变升采样到立方体时相邻四像素没有最近邻平台', () => {
  const cube = convertSkyboxPanoramaToCubemap(gradient(16, 8), 16, 8, 32, false);
  const face = cube.front as Float32Array;
  const samples = [15, 16, 17, 18].map(x => face[(16 * 32 + x) * 3]);
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i] > samples[i - 1], `渐变应连续递增，实际 ${samples}`);
});
const near = (actual: number, expected: number, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) < tolerance,
  `expected ${expected}, received ${actual}`);
const pixel = (face: ArrayBufferView | null, size: number, x: number, y: number) =>
  Array.from((face as Float32Array).subarray((y * size + x) * 3, (y * size + x) * 3 + 3));

test('六个面维持 Babylon 的方向与 HDR/EXR 上下语义，RGB 保持线性高动态值', () => {
  const centers = { front: [8, 4], back: [0, 4], left: [4, 4], right: [12, 4], up: [8, 7], down: [8, 0] } as const;
  for (const invertY of [false, true]) {
    const cube = convertSkyboxPanoramaToCubemap(gradient(16, 8), 16, 8, 4, invertY);
    for (const face of Object.keys(centers) as (keyof typeof centers)[]) {
      const result = pixel(cube[face], 4, 2, 2);
      const [sourceX, sourceY] = centers[face];
      near(result[0], sourceX);
      near(result[1], invertY ? 7 - sourceY : sourceY);
      assert.equal(result[2], 8);
    }
    assert.deepEqual([cube.type, cube.format, cube.gammaSpace], [1, 4, false]);
  }
});

test('非中心像素的经纬度精确插值，没有改变面内旋转', () => {
  const cube = convertSkyboxPanoramaToCubemap(gradient(16, 8), 16, 8, 4, false);
  const directions = { front: [1, -.5, -.5], back: [-1, -.5, .5], left: [-.5, -.5, -1],
    right: [.5, -.5, 1], up: [-.5, -1, -.5], down: [.5, 1, -.5] };
  for (const face of Object.keys(directions) as (keyof typeof directions)[]) {
    const [x, y, z] = directions[face];
    const result = pixel(cube[face], 4, 1, 1);
    near(result[0], (Math.atan2(z, x) / (2 * Math.PI) + .5) * 16);
    near(result[1], Math.min(7, Math.acos(y / Math.hypot(x, y, z)) / Math.PI * 8));
  }
});

test('360 度接缝在末列与首列之间插值，纬度两极钳制到端行', () => {
  const source = gradient(16, 8);
  const cube = convertSkyboxPanoramaToCubemap(source, 16, 8, 32, false);
  // back 面中心左侧：源经度 15.x，应与首列混合而非钳制末列。
  const point = pixel(cube.back, 32, 15, 16);
  const longitude = (Math.atan2(1 / 16, -1) / (2 * Math.PI) + .5) * 16;
  near(point[0], 15 * (16 - longitude));
  near(pixel(cube.back, 32, 16, 16)[0], 0);
  near(pixel(cube.up, 32, 16, 16)[1], 7);
  near(pixel(cube.down, 32, 16, 16)[1], 0);
});

test('RGBA 与 RGB 得到相同线性三通道输出，alpha 不影响采样', () => {
  const rgb = gradient(16, 8);
  const rgba = Float32Array.from({ length: 16 * 8 * 4 }, (_, index) => index % 4 === 3 ? 1000 : rgb[Math.floor(index / 4) * 3 + index % 4]);
  for (const invertY of [false, true]) {
    const first = convertSkyboxPanoramaToCubemap(rgb, 16, 8, 16, invertY);
    const second = convertSkyboxPanoramaToCubemap(rgba, 16, 8, 16, invertY);
    for (const face of ['front', 'back', 'left', 'right', 'up', 'down'] as const) assert.deepEqual(first[face], second[face]);
  }
});

test('转换拒绝错误 stride、非法宽高和越界面尺寸，单像素仍可常量采样', () => {
  for (const size of [0, -1, .5, 1025, Number.NaN]) assert.throws(() => convertSkyboxPanoramaToCubemap(gradient(16, 8), 16, 8, size, false), /1 到 1024/);
  assert.throws(() => convertSkyboxPanoramaToCubemap(new Float32Array(7), 1, 2, 1, false), /RGB/);
  assert.throws(() => convertSkyboxPanoramaToCubemap(new Float32Array(3), 0, 1, 1, false), /正整数/);
  const cube = convertSkyboxPanoramaToCubemap(new Float32Array([2, 4, 8]), 1, 1, 1, true);
  for (const face of ['front', 'back', 'left', 'right', 'up', 'down'] as const) assert.deepEqual(pixel(cube[face], 1, 0, 0), [2, 4, 8]);
});
