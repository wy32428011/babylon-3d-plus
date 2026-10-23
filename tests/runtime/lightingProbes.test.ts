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

test('最近八个可见探针确定后停止遮挡查询，跳过墙体楼层且保持稳定插值', () => {
  const probes = Array.from({ length: 30 }, (_, i) => ({ position: [0.1 + i * 0.1, 0, 0] as [number, number, number], irradiance: Array(18).fill(i + 1) }));
  const sampler = new LightingProbeSampler({ version: 1, encoding: 'ambient-cube', spacing: 8, probes });
  const examined: number[] = [];
  const actual = sampler.sample([0, 0, 0], point => { examined.push(point[0]); return point[0] > 0.3; });
  const selected = probes.filter(probe => probe.position[0] > 0.3).slice(0, 8);
  const total = selected.reduce((sum, probe) => sum + 1 / probe.position[0] ** 2, 0);
  const expected = selected.reduce((sum, probe) => sum + probe.irradiance[0] / probe.position[0] ** 2, 0) / total;
  assert.ok(actual?.every(value => Math.abs(value - expected) < 1e-12));
  assert.equal(examined.length, selected.length + probes.filter(probe => probe.position[0] <= 0.3).length, '不再为不会参与插值的远端探针做遮挡射线');
});

test('探针等距时保留空间桶稳定顺序，全部阻挡时完整查询并返回空', () => {
  const probes = Array.from({ length: 12 }, (_, i) => ({ position: [1, 0, 0] as [number, number, number], irradiance: Array(18).fill(i) }));
  const sampler = new LightingProbeSampler({ version: 1, encoding: 'ambient-cube', spacing: 4, probes });
  assert.deepEqual(sampler.sample([0, 0, 0]), Array(18).fill(3.5));
  let called = 0;
  assert.equal(sampler.sample([0, 0, 0], () => { called++; return false; }), null);
  assert.equal(called, 12);
});
