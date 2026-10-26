import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertModelSemanticsUnchanged, encodeModelGlb, modelLosslessSnapshot, optimizeModelBufferViews,
  readModelGlb } from '../../scripts/lib/phase2AssetSemantics.mjs';
import { optimizeEnvironment, parseOptions } from '../../scripts/optimize-environment-glb.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const floats = values => Buffer.from(new Float32Array(values).buffer);
const uint16 = values => Buffer.from(new Uint16Array(values).buffer);
function fixture() {
  const positions = floats([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const matrix = Buffer.from([1, 2, 3, 99, 4, 5, 6, 99, 7, 8, 9, 99, 11, 12, 13, 99, 14, 15, 16, 99, 17, 18, 19, 99]);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
  const parts = [positions, uint16([0, 1, 2]), positions, floats([0, 1]), floats([0, 0, 0, 1, 0, 0]),
    floats([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), matrix, Buffer.from([1]), floats([5, 6, 7]), png, png];
  const binary = Buffer.alloc(1024, 0xdd); let offset = 64;
  const bufferViews = parts.map(bytes => {
    const result = { buffer: 0, byteOffset: offset, byteLength: bytes.length };
    bytes.copy(binary, offset); offset = Math.ceil((offset + bytes.length) / 4) * 4; return result;
  });
  const json = { asset: { version: '2.0', generator: 'independent-model-lossless-fixture' }, scene: 0,
    scenes: [{ name: '原场景', nodes: [0] }],
    nodes: [{ name: '原模型宿主', children: [1], mesh: 0, skin: 0, translation: [1, 2, 3] }, { name: '原骨骼', translation: [0, 0, 0] }],
    meshes: [{ name: '原几何', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 },
      { attributes: { POSITION: 2 }, indices: 1, material: 1 }] }],
    skins: [{ name: '原skin', inverseBindMatrices: 5, skeleton: 1, joints: [1] }],
    animations: [{ name: '原动画', samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }],
    materials: [{ name: '原材质A', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, roughnessFactor: 0.42 }, extensions: { KHR_materials_unlit: {} } },
      { name: '原材质B', pbrMetallicRoughness: { baseColorTexture: { index: 1 } }, doubleSided: true }],
    samplers: [{ wrapS: 33071 }, { wrapS: 10497 }], textures: [{ source: 0, sampler: 0 }, { source: 1, sampler: 1 }],
    images: [{ name: '原图A', bufferView: 9, mimeType: 'image/png' }, { name: '原图B', bufferView: 10, mimeType: 'image/png' }],
    accessors: [
      { name: 'positions-a', bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { name: 'indices', bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      { name: 'positions-b', bufferView: 2, componentType: 5126, count: 3, type: 'VEC3' },
      { name: 'times', bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR' },
      { name: 'translations', bufferView: 4, componentType: 5126, count: 2, type: 'VEC3' },
      { name: 'inverseBindMatrices', bufferView: 5, componentType: 5126, count: 1, type: 'MAT4' },
      { name: 'matrix-padding', bufferView: 6, componentType: 5121, count: 2, type: 'MAT3' },
      { name: 'sparse', componentType: 5126, count: 3, type: 'VEC3', sparse: { count: 1,
        indices: { bufferView: 7, componentType: 5121 }, values: { bufferView: 8 } } },
    ], bufferViews, buffers: [{ byteLength: binary.length }], extensionsUsed: ['KHR_materials_unlit'] };
  return { bytes: encodeModelGlb(json, binary), json, binary, positions, png };
}

test('严格模式共享重复图片/accessor存储并清除孤立BIN，全部逻辑索引与独立解码SHA保持', () => {
  const f = fixture(), optimized = optimizeModelBufferViews(f.bytes), output = readModelGlb(optimized.bytes);
  assert.equal(optimized.improved, true); assert.equal(optimized.sharedViews, 2);
  assert.ok(optimized.bytes.length < f.bytes.length);
  assert.equal(output.json.bufferViews.length, 11); assert.equal(output.json.accessors.length, 8);
  assert.equal(output.json.images.length, 2); assert.equal(output.json.textures.length, 2);
  assert.equal(output.json.bufferViews[0].byteOffset, output.json.bufferViews[2].byteOffset);
  assert.equal(output.json.bufferViews[9].byteOffset, output.json.bufferViews[10].byteOffset);
  assert.deepEqual(output.json.meshes, f.json.meshes); assert.deepEqual(output.json.nodes, f.json.nodes);
  assert.deepEqual(output.json.skins, f.json.skins); assert.deepEqual(output.json.animations, f.json.animations);
  assert.deepEqual(output.json.materials, f.json.materials); assert.deepEqual(output.json.textures, f.json.textures);
  assertModelSemanticsUnchanged(f.bytes, optimized.bytes);
  const snapshot = modelLosslessSnapshot(optimized.bytes);
  assert.equal(snapshot.accessors[0].sha256, sha(f.positions));
  assert.equal(snapshot.accessors[2].sha256, sha(f.positions));
  assert.equal(snapshot.images[0], sha(f.png)); assert.equal(snapshot.images[1], sha(f.png));
  assert.equal(snapshot.accessors[6].sha256, sha(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19])));
  assert.equal(snapshot.accessors[7].sha256, sha(floats([0, 0, 0, 5, 6, 7, 0, 0, 0])));
});

test('结构/动画/skin/材质/sampler/元数据/扩展与真实数据任一改变均被独立oracle拒绝', () => {
  const f = fixture(), good = optimizeModelBufferViews(f.bytes).bytes;
  const mutations = [json => { json.nodes[0].name = '改名'; }, json => { json.nodes[0].children = []; },
    json => { json.skins[0].joints = [0]; }, json => { json.animations[0].channels[0].target.node = 1; },
    json => { json.meshes[0].primitives[0].attributes.POSITION = 2; },
    json => { json.materials[0].pbrMetallicRoughness.roughnessFactor = 0.5; },
    json => { json.samplers[0].wrapS = 10497; }, json => { json.nodes[0].extras = { author: 'changed' }; },
    json => { json.materials[0].extensions.KHR_materials_unlit = { changed: true }; },
  ];
  for (const mutate of mutations) {
    const { json, binary } = readModelGlb(good); mutate(json);
    assert.throws(() => assertModelSemanticsUnchanged(f.bytes, encodeModelGlb(json, binary)), /严格模型转换/);
  }
  const { json, binary } = readModelGlb(good); binary[json.bufferViews[0].byteOffset] ^= 1;
  assert.throws(() => assertModelSemanticsUnchanged(f.bytes, encodeModelGlb(json, binary)), /严格模型转换/);
});

test('未知扩展/opaque extras/外部资源/不明字段保守拒绝，未擅自删除逻辑定义', () => {
  const f = fixture();
  for (const mutate of [json => { json.extensionsUsed.push('UNKNOWN_extension'); },
    json => { json.extensions = { UNKNOWN_extension: { offset: 64 } }; },
    json => { json.nodes[0].extras = { opaqueOffset: 64 }; },
    json => { json.vendorOffsets = [64]; }, json => { json.nodes[0].vendorOffset = 64; },
    json => { json.images[0].uri = 'https://external.test/private.png'; },
    json => { json.extensionsUsed.push('EXT_meshopt_compression'); },
    json => { json.extensionsUsed.push('KHR_draco_mesh_compression'); },
  ]) {
    const json = structuredClone(f.json); mutate(json);
    assert.throws(() => optimizeModelBufferViews(encodeModelGlb(json, f.binary)), /保留原资产|内嵌/);
  }
});

test('严格元数据序列化保持负零，普通JSON重写的错误候选会被拒绝', () => {
  const f = fixture(); f.json.nodes[0].rotation = [0, -0, -0, 1];
  const before = encodeModelGlb(f.json, f.binary), after = optimizeModelBufferViews(before).bytes;
  const output = readModelGlb(after);
  assert.equal(Object.is(output.json.nodes[0].rotation[1], -0), true);
  assert.equal(Object.is(output.json.nodes[0].rotation[2], -0), true);
  assertModelSemanticsUnchanged(before, after);
  const changed = JSON.parse(JSON.stringify(output.json));
  assert.throws(() => assertModelSemanticsUnchanged(before, encodeModelGlb(changed, output.binary)), /严格模型转换/);
});

test('截断/越界/非法stride/sparse/matrix与超预算accessor不生成伪校验', () => {
  const f = fixture();
  assert.throws(() => optimizeModelBufferViews(f.bytes.subarray(0, -4)), /长度/);
  for (const mutate of [json => { json.bufferViews[0].byteOffset = 5000; },
    json => { json.accessors[0].count = 10000; }, json => { json.bufferViews[0].byteStride = 1; },
    json => { json.accessors[7].sparse.count = 4; }, json => { json.accessors[6].componentType = 999; },
    json => { json.accessors[7].count = 100_000_000; },
  ]) {
    const json = structuredClone(f.json); mutate(json);
    assert.throws(() => optimizeModelBufferViews(encodeModelGlb(json, f.binary)), /越界|stride|componentType|预算/);
  }
});

test('独立oracle正确读取交错stride与非零accessor偏移，连padding也由view SHA保护', () => {
  const binary = Buffer.alloc(32, 0xee); floats([1, 2, 3]).copy(binary, 4); floats([4, 5, 6]).copy(binary, 20);
  const json = { asset: { version: '2.0' }, buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteLength: binary.length, byteStride: 16 }],
    accessors: [{ bufferView: 0, byteOffset: 4, componentType: 5126, count: 2, type: 'VEC3' }] };
  const bytes = encodeModelGlb(json, binary), snapshot = modelLosslessSnapshot(bytes);
  assert.equal(snapshot.accessors[0].sha256, sha(floats([1, 2, 3, 4, 5, 6])));
  const changed = Buffer.from(binary); changed[0] ^= 1;
  assert.equal(modelLosslessSnapshot(encodeModelGlb(json, changed)).accessors[0].sha256, snapshot.accessors[0].sha256);
  assert.throws(() => assertModelSemanticsUnchanged(bytes, encodeModelGlb(json, changed)), /严格模型转换/);
  // 最后一列后无进一步数据时，仅访问实际分量；不把未读取的末尾对齐字节当必需载荷。
  const matrix = Buffer.from([1, 2, 3, 99, 4, 5, 6, 99, 7, 8, 9]);
  const matrixJson = { asset: { version: '2.0' }, buffers: [{ byteLength: matrix.length }],
    bufferViews: [{ buffer: 0, byteLength: matrix.length }],
    accessors: [{ bufferView: 0, componentType: 5121, count: 1, type: 'MAT3' }] };
  assert.equal(modelLosslessSnapshot(encodeModelGlb(matrixJson, matrix)).accessors[0].sha256,
    sha(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9])));
});

test('model-lossless无需CLI并独占写入新副本/报告，输入保持不变，第二次优化无收益保留原字节', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'phase2-model-lossless-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const input = path.join(root, 'before.glb'), output = path.join(root, 'after.glb'), f = fixture();
  await writeFile(input, f.bytes);
  const report = await optimizeEnvironment(parseOptions([input, output, '--mode=model-lossless']), { ZENDING_GLTF_TRANSFORM_CLI: 'must-not-be-loaded' });
  assert.equal(report.status, 'PASS'); assert.equal(report.tool, 'builtin-glb-view-packer@1');
  assert.equal(report.storage.retainedLogicalIndices, true); assert.equal(report.storage.sharedBufferViews, 2);
  assert.deepEqual(await readFile(input), f.bytes);
  await assert.rejects(optimizeEnvironment(parseOptions([input, output, '--mode=model-lossless'])), /拒绝覆盖/);
  const second = path.join(root, 'second.glb');
  const noChange = await optimizeEnvironment(parseOptions([output, second, '--mode=model-lossless']));
  assert.equal(noChange.status, 'NO_CHANGE'); assert.deepEqual(await readFile(second), await readFile(output));
  assert.ok((await readdir(root)).every(name => !name.startsWith('.environment-optimize-')));
});

test('策略拒绝时不创建输出、不触碰源文件或已有用户文件', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'phase2-model-lossless-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const input = path.join(root, 'before.glb'), output = path.join(root, 'after.glb'), f = fixture();
  f.json.nodes[0].extras = { unknownAddress: 1 }; const original = encodeModelGlb(f.json, f.binary);
  await writeFile(input, original); await writeFile(path.join(root, 'user.txt'), 'preserve');
  await assert.rejects(optimizeEnvironment(parseOptions([input, output, '--mode=model-lossless'])), /保留原资产/);
  assert.deepEqual((await readdir(root)).sort(), ['before.glb', 'user.txt']); assert.deepEqual(await readFile(input), original);
});

test('真实 Babylon loader 读取转换前后的小模型，节点/几何/实例名与顶点索引保持', async () => {
  const f = fixture(), json = structuredClone(f.json);
  delete json.images; delete json.textures; delete json.samplers; delete json.materials;
  delete json.skins; delete json.animations; delete json.nodes[0].skin;
  for (const primitive of json.meshes[0].primitives) delete primitive.material;
  const before = encodeModelGlb(json, f.binary), after = optimizeModelBufferViews(before).bytes;
  const { NullEngine, Scene, ImportMeshAsync, VertexBuffer } = await import('@babylonjs/core');
  await import('@babylonjs/loaders/glTF/index.js');
  const engine = new NullEngine();
  const results = [];
  try {
    for (const bytes of [before, after]) {
      const scene = new Scene(engine);
      try {
        const loaded = await ImportMeshAsync(new Uint8Array(bytes), scene, { pluginExtension: '.glb' });
        const meshes = loaded.meshes.filter(mesh => mesh.getTotalVertices() > 0);
        assert.equal(meshes.length, 2);
        results.push(meshes.map(mesh => ({ name: mesh.name,
          positions: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)), indices: Array.from(mesh.getIndices()) })));
        for (const mesh of meshes) {
          assert.deepEqual(Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
          assert.deepEqual(Array.from(mesh.getIndices()), [0, 1, 2]);
        }
      } finally { scene.dispose(); }
    }
    assert.deepEqual(results[1], results[0]);
  } finally { engine.dispose(); }
});
