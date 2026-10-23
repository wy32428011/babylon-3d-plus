import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectLightingBakeInput, assertLightingBakePreflight } from '../../electron/shared/sceneLightingBakePreflight.ts';
import { validateLightingGeometry, validateLightingProbes, validateLightingPng } from '../../electron/shared/sceneLightingBakeArtifacts.ts';
import type { LightingBakeInput } from '../../electron/shared/sceneLightingBakeContract.ts';
const input = (): LightingBakeInput => ({ version: 1, jobId: 'preflight', signature: 's', sceneName: '预检',
  settings: { enabled: true, quality: 'preview', atlasSize: 1024, texelsPerMeter: 8, probeSpacing: 4, maxTextureMiB: 16, cacheStaticShadows: true, dynamicShadows: true },
  meshes: [{ key: 'g', entityId: 'g', nodeKey: 'root', name: '地面', positions: [0,0,0, 2,0,0, 0,0,2], normals: [0,1,0, 0,1,0, 0,1,0], indices: [0,1,2], worldMatrix: [2,0,0,0, 0,1,0,0, 0,0,3,0, 10,0,20,1], material: { baseColor: [1,1,1], alpha: 1, metallic: 0, roughness: 1, emissive: [0,0,0], doubleSided: true } }],
  lights: [], environment: { color: [1,1,1], intensity: 1 } });
test('预检使用世界面积和全部几何范围，保留输入配置', () => {
  const scene = input(), before = structuredClone(scene), report = inspectLightingBakeInput(scene);
  assert.equal(report.receiverArea, 12); assert.equal(report.vertexCount, 3); assert.equal(report.triangleCount, 1);
  assert.equal(report.probeCount, 2); assert.equal(report.minAtlasCount, 1); assert.equal(report.minTextureBytes, 4194304);
  assert.ok(report.geometryBytes > 0); assert.ok(report.estimatedInputBytes > report.geometryBytes); assert.deepEqual(scene, before);
  assert.doesNotThrow(() => assertLightingBakePreflight(report));
});
test('过大探针网格在启动引擎前拒绝并给出满足上限的间距', () => {
  const scene = input(); scene.meshes[0].positions = [0,0,0, 100,100,100, 0,100,0]; scene.settings.probeSpacing = 0.5;
  const report = inspectLightingBakeInput(scene); assert.ok(report.probeCount > 4096); assert.throws(() => assertLightingBakePreflight(report), /探针/);
  scene.settings.probeSpacing = report.suggestedProbeSpacing!; assert.ok(inspectLightingBakeInput(scene).probeCount <= 4096);
});
test('面积下界超预算明确拒绝，几何规模警告不等同纹理预算', () => {
  const scene = input(); scene.settings.texelsPerMeter = 4096;
  const report = inspectLightingBakeInput(scene); assert.ok(report.issues.some(issue => issue.code === 'texture-budget' && issue.severity === 'error'));
  assert.throws(() => assertLightingBakePreflight(report), /纹理预算/);
});
const geometry = () => ({ version: 1, positions: [0,0,0,1,0,0,0,0,1], normals: [0,1,0,0,1,0,0,1,0], indices: [0,1,2], uvs: [0,0,1,0,0,1], bakeUvs: [0,0,1,0,0,1] });
test('共享产物验证拒绝越界、缺失属性和无效探针', () => {
  assert.equal(validateLightingGeometry(geometry()).indices.length, 3);
  assert.throws(() => validateLightingGeometry({ ...geometry(), indices: [0,1,3] }), /索引/);
  assert.throws(() => validateLightingGeometry({ ...geometry(), indices: Array(3) }), /索引/);
  assert.throws(() => validateLightingGeometry({ ...geometry(), tangents: [1] }), /tangents/);
  assert.throws(() => validateLightingGeometry({ ...geometry(), bakeUvs: [0,0,2,0,0,1] }), /UV/);
  const probes = { version: 1, encoding: 'ambient-cube', spacing: 4, probes: [{ position: [0,0,0], irradiance: Array(18).fill(1) }] };
  assert.equal(validateLightingProbes(probes).probes.length, 1);
  assert.throws(() => validateLightingProbes({ ...probes, spacing: 0 }), /探针/);
  assert.throws(() => validateLightingProbes({ ...probes, probes: [{ position: [0,0,0], irradiance: Array(18).fill(-1) }] }), /探针/);
});
test('PNG 实际尺寸必须等于图集元数据而非只满足像素上限', () => {
  const bytes = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.write('IHDR',12); bytes.writeUInt32BE(16,16); bytes.writeUInt32BE(16,20);
  assert.deepEqual(validateLightingPng(bytes, 1024, { width: 16, height: 16 }), { width: 16, height: 16 });
  assert.throws(() => validateLightingPng(bytes, 1024, { width: 32, height: 32 }), /尺寸/);
});

test('单三角派生数值量包含固定输出通道，缺省原UV仍按补零输出估算', () => {
  const scene=input(), before=structuredClone(scene);
  assert.equal(inspectLightingBakeInput(scene).estimatedDerivedNumericBytes,264);
  assert.deepEqual(scene,before);
  scene.meshes[0].uvs=[0,0,1,0,0,1];
  assert.equal(inspectLightingBakeInput(scene).estimatedDerivedNumericBytes,264,'原UV属于固定输出通道，不能重复计数');
});

test('多通道索引网格按三角角点展开估算UV2、颜色和切线', () => {
  const scene=input(), mesh=scene.meshes[0];
  mesh.uvs2=Array(6).fill(0.2);mesh.colors=Array(12).fill(0.4);mesh.tangents=Array(12).fill(0.7);
  assert.equal(inspectLightingBakeInput(scene).estimatedDerivedNumericBytes,504);
  mesh.indices=[0,1,2,2,1,0];
  assert.equal(inspectLightingBakeInput(scene).estimatedDerivedNumericBytes,1008,'共享3个源顶点仍需展开为6个三角角点');
});

test('只遮挡不接收的例外仍保留输入规模，但不计入派生输出数值量', () => {
  const scene=input();
  scene.meshes.push({...structuredClone(scene.meshes[0]),key:'caster-only',receiver:false,indices:[0,1,2,2,1,0],uvs2:Array(6).fill(0.2),colors:Array(12).fill(0.4),tangents:Array(12).fill(0.7)});
  const report=inspectLightingBakeInput(scene);
  assert.equal(report.meshCount,2);assert.equal(report.triangleCount,3);assert.equal(report.receiverCount,1);
  assert.equal(report.estimatedDerivedNumericBytes,264);
  scene.meshes[0].receiver=false;
  assert.equal(inspectLightingBakeInput(scene).estimatedDerivedNumericBytes,0);
});
