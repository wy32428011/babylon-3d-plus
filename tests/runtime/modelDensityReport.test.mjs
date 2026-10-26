import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeGltfJson, parseGlbJson, reportModelDensity } from '../../scripts/report-model-density.mjs';

/** 只构造 JSON 块；报告不读取 BIN 数据，accessor 的 count/min/max 已足够。 */
function glb(json) {
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, padded]);
}

function model({ triangles, size, scale = [1, 1, 1], instances = 1, extensionsUsed = [] }) {
  const half = size / 2;
  return {
    asset: { version: '2.0' }, extensionsUsed,
    accessors: [
      { count: triangles * 3, type: 'SCALAR', componentType: 5125 },
      { count: triangles, type: 'VEC3', componentType: 5126, min: [-half, -half, -half], max: [half, half, half] },
    ],
    meshes: [{ name: 'prop', primitives: [{ indices: 0, attributes: { POSITION: 1 } }] }],
    nodes: Array.from({ length: instances }, () => ({ mesh: 0, scale })),
    scenes: [{ nodes: Array.from({ length: instances }, (_, index) => index) }], scene: 0,
  };
}

test('小尺寸高面数网格被标记，记录世界尺寸与密度', () => {
  const result = analyzeGltfJson(model({ triangles: 178_227, size: 0.2 }));
  assert.equal(result.triangles, 178_227);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0].reasons, ['small-high-poly', 'dense']);
  assert.deepEqual(result.findings[0].sizeMeters, [0.2, 0.2, 0.2]);
});

test('父级/节点缩放参与尺寸计算：同一几何放大后不再算小物体', () => {
  const small = analyzeGltfJson(model({ triangles: 30_000, size: 0.4 }));
  const scaled = analyzeGltfJson(model({ triangles: 30_000, size: 0.4, scale: [10, 10, 10] }));
  assert.ok(small.findings.some(finding => finding.reasons.includes('small-high-poly')));
  assert.equal(scaled.findings.length, 0);
});

test('普通尺寸与面数的模型不产生提示，实例数计入总面数', () => {
  const result = analyzeGltfJson(model({ triangles: 5_000, size: 2, instances: 3 }));
  assert.equal(result.findings.length, 0);
  assert.equal(result.instanceCount, 3);
  assert.equal(result.uniqueTriangles, 5_000);
  assert.equal(result.triangles, 15_000);
});

test('压缩扩展仅从 extensionsUsed 识别，不需要解码顶点', () => {
  const result = analyzeGltfJson(model({ triangles: 10, size: 1, extensionsUsed: ['KHR_draco_mesh_compression', 'KHR_texture_basisu'] }));
  assert.deepEqual(result.compression, { draco: true, meshopt: false, ktx2: true });
});

test('非 GLB 输入明确报错；目录扫描记录失败文件而不中断', async () => {
  assert.throws(() => parseGlbJson(Buffer.from('not a glb file at all!')), /不是 GLB/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'model-density-'));
  try {
    await writeFile(path.join(root, 'good.glb'), glb(model({ triangles: 50_000, size: 0.1 })));
    await writeFile(path.join(root, 'broken.glb'), Buffer.from('broken'));
    await writeFile(path.join(root, 'ignored.txt'), 'x');
    const report = await reportModelDensity([root]);
    assert.equal(report.scannedFiles, 2);
    assert.equal(report.failedFiles, 1);
    assert.equal(report.filesWithFindings, 1);
    assert.equal(report.totalTriangles, 50_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
