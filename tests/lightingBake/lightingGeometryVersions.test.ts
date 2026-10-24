import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLightingGeometry } from '../../electron/shared/sceneLightingBakeArtifacts.ts';
import { validateSceneLightingBakeSnapshot } from '../../electron/shared/sceneLightingBakeData.ts';
import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';

const geometry = (version: number) => ({ version,
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3], uvs: [0, 0, 1, 0, 1, 1, 0, 1], bakeUvs: [0, 0, 1, 0, 1, 1, 0, 1],
  uvs2: [0, 0, 1, 0, 1, 1, 0, 1], colors: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1] });
const snapshot = (geometryVersion?: unknown, kind = 'geometry') => ({ version: 1, signature: 'unchanged-source',
  createdAt: '2026-10-24T00:00:00Z', engineVersion: 'fixture',
  assets: [{ id: 'g', kind, url: './Assets/LightingBakes/job/g.json', byteLength: 42,
    ...(geometryVersion === undefined ? {} : { geometryVersion }) },
  { id: 'l', kind: 'lightmap', url: './Assets/LightingBakes/job/l.png', byteLength: 33, rgbmRange: 2 },
  { id: 'p', kind: 'probes', url: './Assets/LightingBakes/job/p.json', byteLength: 42 }],
  surfaces: [{ key: 'a/root', entityId: 'a', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
  statistics: { meshCount: 1, triangleCount: 2, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 1 } });

test('v1/v2 有索引几何沿用完整属性、索引和UV校验，保留输入对象', () => {
  for (const version of [1, 2]) {
    const value = geometry(version);
    assert.equal(validateLightingGeometry(value), value);
    for (const invalid of [0, 3, '2', undefined]) assert.throws(() => validateLightingGeometry({ ...value, version: invalid }), /顶点|格式/);
    for (const field of ['normals', 'uvs', 'uvs2', 'colors', 'tangents', 'bakeUvs']) {
      assert.throws(() => validateLightingGeometry({ ...value, [field]: [0] }), /无效/);
    }
    assert.throws(() => validateLightingGeometry({ ...value, indices: [0, 1, 4] }), /索引/);
    assert.throws(() => validateLightingGeometry({ ...value, positions: [NaN, ...value.positions.slice(1)] }), /索引|顶点/);
    assert.throws(() => validateLightingGeometry({ ...value, bakeUvs: [1.1, ...value.bakeUvs.slice(1)] }), /图集/);
  }
});

test('geometryVersion 在结果校验与照明配置规范化后保留，旧清单不补字段', () => {
  const old = validateSceneLightingBakeSnapshot(snapshot());
  assert.ok(old);
  assert.equal(Object.hasOwn(old.assets[0], 'geometryVersion'), false);
  for (const version of [1, 2]) {
    const value = validateSceneLightingBakeSnapshot(snapshot(version));
    assert.ok(value);
    assert.equal(value.assets[0].geometryVersion, version);
    assert.equal(normalizeSceneLightingConfig({ version: 2, result: value }).result?.assets[0].geometryVersion, version);
  }
  for (const invalid of [0, 3, '2', null]) assert.equal(validateSceneLightingBakeSnapshot(snapshot(invalid)), null);
  const wrongKind = snapshot();
  Object.assign(wrongKind.assets[1], { geometryVersion: 2 });
  assert.equal(validateSceneLightingBakeSnapshot(wrongKind), null);
});
