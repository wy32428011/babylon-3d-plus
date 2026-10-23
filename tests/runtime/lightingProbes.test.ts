import assert from 'node:assert/strict';
import test from 'node:test';
import { LightingProbeSampler } from '../../src/runtime/babylon/lightingProbes.ts';

test('间接光探针按距离插值，阻挡的楼层探针不参与', () => {
  const sampler = new LightingProbeSampler({
    version: 1, encoding: 'ambient-cube', spacing: 4,
    probes: [
      { position: [0, 0, 0], irradiance: Array(18).fill(1) },
      { position: [4, 0, 0], irradiance: Array(18).fill(3) },
      { position: [2, 4, 0], irradiance: Array(18).fill(99) },
    ],
  });
  const result = sampler.sample([2, 0, 0], p => p[1] === 0);
  assert.ok(result);
  assert.ok(result.every(value => Math.abs(value - 2) < 1e-6));
  assert.equal(sampler.sample([200, 0, 0]), null, '覆盖范围外不能跨工厂读取最近的任意探针');
});

test('不接受损坏、非有限或方向数不足的探针资源', () => {
  assert.throws(() => new LightingProbeSampler({
    version: 1, encoding: 'ambient-cube', spacing: 4,
    probes: [{ position: [0, 0, 0], irradiance: [1, 2, NaN] }],
  }), /探针/);
});
