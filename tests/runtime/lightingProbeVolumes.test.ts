import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeLightingBakeTransport } from '../../electron/shared/sceneLightingBakeBinary.ts';
import { inspectLightingBakeInput } from '../../electron/shared/sceneLightingBakePreflight.ts';
import { DEFAULT_LIGHTING_BAKE_SETTINGS, type LightingBakeInput } from '../../electron/shared/sceneLightingBakeContract.ts';
import { normalizeLightingProbeVolumes, planLightingProbeVolumes } from '../../electron/shared/sceneLightingProbeVolumes.ts';

const fallback = { min: [0, 0, 0] as [number, number, number], max: [8, 0, 8] as [number, number, number] };
const volume = (id: string, min: [number, number, number], max: [number, number, number]) => ({ id, name: id, enabled: true, min, max });

test('缺省和全禁用区域保留现有全场探针位置，零厚度兼容不变', () => {
  assert.equal(normalizeLightingProbeVolumes(undefined), undefined);
  const planned = planLightingProbeVolumes(undefined, 4, fallback);
  assert.deepEqual(planned.positions, [[2, 0.05, 2], [2, 0.05, 6], [6, 0.05, 2], [6, 0.05, 6]]);
  assert.equal(planned.count, 4); assert.equal(planned.countExact, true);
  assert.deepEqual(planLightingProbeVolumes([{ ...volume('disabled', [0, 0, 0], [1, 1, 1]), enabled: false }], 4, fallback), planned);
});

test('区域只限定探针采样位置，稀疏楼层各自覆盖且重叠位置按微米精度稳定去重', () => {
  const first = volume('floor-1', [0, 0, 0], [4, 2, 4]);
  const second = volume('floor-2', [0, 10, 0], [4, 12, 4]);
  const planned = planLightingProbeVolumes([first, second, { ...first, id: 'duplicate' }], 4, fallback);
  assert.deepEqual(planned.positions, [[2, 1, 2], [2, 11, 2]]); assert.equal(planned.count, 2);
  assert.deepEqual(planned.bounds, { min: [0, 0, 0], max: [4, 12, 4] });
  const thin = planLightingProbeVolumes([volume('thin', [-1, 0, 0], [-0.99, 0.01, 0.01])], 4, fallback);
  assert.deepEqual(thin.positions, [[-0.995, 0.005, 0.005]], '薄区域探针必须位于区域内部');
  assert.equal(planLightingProbeVolumes([volume('a', [-1, 0, 0], [1, 2, 2]), volume('b', [-1 + 1e-8, 0, 0], [1 + 1e-8, 2, 2])], 4, fallback).count, 1);
});

test('非法、重复区域拒绝而不静默丢弃，归一化不改调用方数据', () => {
  const input = [volume('a', [0, 0, 0], [4, 2, 4])];
  const normalized = normalizeLightingProbeVolumes(input)!;
  normalized[0].min[0] = 99; assert.equal(input[0].min[0], 0);
  assert.throws(() => normalizeLightingProbeVolumes([input[0], input[0]]), /重复/);
  assert.throws(() => normalizeLightingProbeVolumes([volume('bad', [0, 0, 0], [0, 1, 1])]), /区域/);
  assert.throws(() => normalizeLightingProbeVolumes([volume('bad', [NaN, 0, 0], [1, 1, 1])]), /区域/);
  assert.throws(() => planLightingProbeVolumes(input, 0, fallback), /间距/);
});

test('超限区域和全场在生成巨型位置数组之前停止，重叠区域不能误判超限', () => {
  const huge = { min: [0, 0, 0] as [number, number, number], max: [100000, 100000, 100000] as [number, number, number] };
  const defaultPlan = planLightingProbeVolumes(undefined, 1, huge);
  assert.equal(defaultPlan.count, 1e15); assert.equal(defaultPlan.positions.length, 0); assert.equal(defaultPlan.countExact, true);
  const regional = planLightingProbeVolumes([volume('huge', huge.min, huge.max)], 1, fallback);
  assert.equal(regional.count, 4097); assert.equal(regional.countExact, false); assert.equal(regional.positions.length, 4097);
  const repeated = Array.from({ length: 100 }, (_, i) => volume(String(i), [0, 0, 0], [16, 16, 16]));
  assert.equal(planLightingProbeVolumes(repeated, 4, fallback).count, 64);
});

test('区域预检沿用完整静态输入面积和遮挡，不因稀疏楼层裁掉几何', () => {
  const input = { version: 1, signature: 'test', meshes: [{ positions: [0, 0, 0, 1000, 0, 0, 0, 0, 1000], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 1, 2],
    worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], material: {} }], environment: {}, lights: [],
    settings: { ...DEFAULT_LIGHTING_BAKE_SETTINGS, probeSpacing: 1 } } as unknown as LightingBakeInput;
  assert.ok(inspectLightingBakeInput(input).probeCount > 4096);
  input.settings.probeVolumes = [volume('first', [0, 0, 0], [2, 2, 2]), volume('second', [998, 10, 998], [1000, 12, 1000])];
  const before = JSON.stringify(input), report = inspectLightingBakeInput(input);
  assert.equal(report.probeCount, 16); assert.equal(report.probeCountExact, true);
  assert.equal(report.triangleCount, 1); assert.equal(report.receiverArea, 500000);
  assert.equal(report.issues.some(issue => issue.code === 'probe-limit'), false);
  assert.equal(JSON.stringify(input), before, '预检不修改配置、几何或旧烘焙结果');
});

test('输入规模按当前Float64和Uint32对齐二进制附件计算，JSON只估算小型元数据', () => {
  const input = { version: 1, signature: 's', meshes: [{ key: 'mesh', positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1],
    worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], material: {} }], environment: {}, lights: [], settings: DEFAULT_LIGHTING_BAKE_SETTINGS } as unknown as LightingBakeInput;
  const report = inspectLightingBakeInput(input), transport = encodeLightingBakeTransport(input);
  assert.equal(report.binaryGeometryBytes, transport.geometry.reduce((sum, geometry) => sum + geometry.bytes.byteLength, 0));
  assert.equal(report.inputEstimate, true);
  assert.ok(report.estimatedInputBytes >= report.binaryGeometryBytes);
});
