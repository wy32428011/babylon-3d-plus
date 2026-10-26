import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { optimizeEnvironment, parseOptions } from '../../scripts/optimize-environment-glb.mjs';
import { encodeModelGlb, readModelGlb } from '../../scripts/lib/phase2AssetSemantics.mjs';
import { optimizePhase2MeshoptLossless } from '../../scripts/lib/phase2MeshoptLossless.mjs';
import { assertPhase2MeshoptLossless, decodePhase2MeshoptGlb } from '../../scripts/lib/phase2MeshoptOracle.mjs';
import { loadPhase2MeshoptToolchain } from '../../scripts/lib/phase2MeshoptToolchain.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const positions = Buffer.alloc(320 * 16, 0xa5);
  for (let index = 0; index < 320; index++) {
    positions.writeFloatLE(index % 3 === 0 ? -0 : index % 16, index * 16);
    positions.writeFloatLE(Math.floor(index / 16), index * 16 + 4);
    positions.writeFloatLE(index % 2, index * 16 + 8);
  }
  const indices = Buffer.alloc(315 * 2);
  for (let index = 0; index < 315; index += 3) {
    indices.writeUInt16LE(index + 2, index * 2); indices.writeUInt16LE(index, index * 2 + 2); indices.writeUInt16LE(index + 1, index * 2 + 4);
  }
  const sparseIndices = Buffer.from([0, 2]);
  const sparseValues = Buffer.alloc(24); sparseValues.writeFloatLE(-0, 0); sparseValues.writeFloatLE(23, 16);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X8R8AAAAASUVORK5CYII=', 'base64');
  const segments = [positions, indices, sparseIndices, sparseValues, image]; let size = 0;
  const bufferViews = segments.map(bytes => { const view = { buffer: 0, byteOffset: size, byteLength: bytes.length }; size = Math.ceil((size + bytes.length) / 4) * 4; return view; });
  bufferViews[0].byteStride = 16; bufferViews[0].extensions = {};
  const binary = Buffer.alloc(size, 0xcc); segments.forEach((bytes, index) => bytes.copy(binary, bufferViews[index].byteOffset));
  const json = { asset: { version: '2.0', generator: 'phase2 independent byte oracle fixture' },
    scene: 0, scenes: [{ nodes: [0], name: '原结构' }], nodes: [{ mesh: 0, translation: [0, -0, 0], name: '原节点' }],
    buffers: [{ byteLength: binary.length, name: '原buffer元数据' }], bufferViews,
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 320, name: 'position', min: [-0, 0, 0], max: [15, 19, 1] },
      { bufferView: 1, componentType: 5123, type: 'SCALAR', count: 315 },
      { componentType: 5126, type: 'VEC3', count: 320, sparse: { count: 2, indices: { bufferView: 2, componentType: 5121 }, values: { bufferView: 3 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, targets: [{ POSITION: 2 }] }], weights: [0] }],
    images: [{ bufferView: 4, mimeType: 'image/png', name: '原image字节' }], extensionsUsed: [], extensionsRequired: [] };
  return { bytes: encodeModelGlb(json, binary), positions, indices };
}

function mutateCandidate(bytes, mutate) {
  const length = bytes.readUInt32LE(12), json = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8'));
  // 修改JSON结构时保持负零；重新读取原候选中的-0由JSON.parse保留，encodeModelGlb负责严格序列化。
  const binary = bytes.subarray(28 + length); mutate(json, binary);
  return encodeModelGlb(json, binary);
}

test('独立固定meshopt编码与产品0.20双解码完整字节oracle', { skip: !process.env.PHASE2_MESHOPT_TOOLCHAIN
  && '须显式提供隔离 PHASE2_MESHOPT_TOOLCHAIN，不自动安装或回退依赖' }, async t => {
  const toolchain = await loadPhase2MeshoptToolchain(process.env.PHASE2_MESHOPT_TOOLCHAIN,
    path.resolve('public/babylon-decoders/meshopt/meshopt_decoder.js'));
  const source = fixture(), beforeHash = sha(source.bytes), result = optimizePhase2MeshoptLossless(source.bytes, toolchain);
  await t.test('完整stride/padding/负零/index顺序/sparse/image/元数据通过两套实际decoder', () => {
    assert.equal(result.improved, true); assert.ok(result.bytes.length < source.bytes.length);
    assert.equal(result.proofs.length, 2); assert.ok(result.compressedViews >= 2);
    assert.equal(result.rows[1].mode, 'INDICES', '奇数16-bit索引数不能靠ATTRIBUTES4布局绕过精确sequence路径');
    for (const row of result.rows) assert.equal(row.filter, 'NONE');
    for (const { decoder } of toolchain.decoders) {
      const decoded = decodePhase2MeshoptGlb(result.bytes, decoder, readModelGlb(source.bytes).json);
      const document = readModelGlb(decoded.bytes), view = document.json.bufferViews[0];
      assert.equal(document.binary.readUInt32LE(view.byteOffset), 0x80000000, '负零浮点bit必须保留');
      assert.deepEqual(document.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength), source.positions);
      const indexView = document.json.bufferViews[1];
      assert.deepEqual(document.binary.subarray(indexView.byteOffset, indexView.byteOffset + indexView.byteLength), source.indices);
      assert.ok(Object.is(document.json.nodes[0].translation[1], -0));
      assert.deepEqual(document.json.extensionsUsed, []); assert.deepEqual(document.json.extensionsRequired, []);
      assert.deepEqual(document.json.bufferViews[0].extensions, {});
    }
    assert.equal(sha(source.bytes), beforeHash, 'encoder不可修改输入');
  });
  await t.test('TRIANGLES/量化filter/未知字段/错误stride与越界在解码前拒绝', () => {
    for (const mutate of [extension => { extension.mode = 'TRIANGLES'; }, extension => { extension.filter = 'EXPONENTIAL'; },
      extension => { extension.vendorField = true; }, extension => { extension.byteStride = 8; }, extension => { extension.byteOffset = 2 ** 30; }]) {
      const changed = mutateCandidate(result.bytes, json => mutate(json.bufferViews[0].extensions.EXT_meshopt_compression));
      assert.throws(() => assertPhase2MeshoptLossless(source.bytes, changed, toolchain.decoders));
    }
  });
  await t.test('原逻辑index/材质/负零元数据不可通过容器重写掩盖', () => {
    for (const mutate of [json => { json.nodes[0].name = 'changed'; }, json => { json.accessors[1].componentType = 5125; },
      json => { json.nodes[0].translation[1] = 0; }, json => { json.meshes[0].primitives[0].indices = 0; }]) {
      const changed = mutateCandidate(result.bytes, mutate);
      assert.throws(() => assertPhase2MeshoptLossless(source.bytes, changed, toolchain.decoders));
    }
  });
  await t.test('独立错误decoder改变padding也必须失败，不能仅比较逻辑浮点', () => {
    const wrong = { supported: true, decodeGltfBuffer(...args) { toolchain.decoders[0].decoder.decodeGltfBuffer(...args); args[0][15] ^= 1; } };
    assert.throws(() => assertPhase2MeshoptLossless(source.bytes, result.bytes,
      [{ name: 'corrupt-padding', decoder: wrong }, toolchain.decoders[1]]), /严格模型转换/);
  });
  await t.test('未知扩展/自定义地址保守拒绝；无合法或无收益view直接保留原字节', () => {
    const document = readModelGlb(source.bytes);
    for (const mutate of [json => { json.extensionsUsed = ['VENDOR_unknown']; }, json => { json.nodes[0].extras = { vendorOffset: 1 }; }]) {
      const json = structuredClone(document.json); mutate(json);
      assert.throws(() => optimizePhase2MeshoptLossless(encodeModelGlb(json, document.binary), toolchain), /保留原资产/);
    }
    const minimal = encodeModelGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 3 }], bufferViews: [{ buffer: 0, byteLength: 3 }] }, Buffer.from([1, 2, 3]));
    const unchanged = optimizePhase2MeshoptLossless(minimal, toolchain);
    assert.equal(unchanged.improved, false); assert.deepEqual(unchanged.bytes, minimal);
  });
  await t.test('显式CLI隔离路径/排他输出/磁盘回读；旧默认和model-lossless不加载meshopt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'phase2-meshopt-cli-'));
    t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('phase2-meshopt-cli-')); await rm(root, { recursive: true, force: true }); });
    const input = path.join(root, 'before.glb'), output = path.join(root, 'after.glb'); await writeFile(input, source.bytes);
    assert.equal(parseOptions([input, output]).mode, 'dedup');
    const options = parseOptions([input, output, '--mode=model-meshopt-lossless']);
    for (const invalid of [{}, { ZENDING_MESHOPT_TOOLCHAIN: './relative' }]) {
      await assert.rejects(optimizeEnvironment(options, invalid), /绝对路径 ZENDING_MESHOPT_TOOLCHAIN/);
      assert.deepEqual(await readdir(root), ['before.glb']);
    }
    const report = await optimizeEnvironment(options, { ZENDING_MESHOPT_TOOLCHAIN: process.env.PHASE2_MESHOPT_TOOLCHAIN, ZENDING_GLTF_TRANSFORM_CLI: 'never-loaded' });
    assert.equal(report.status, 'PASS'); assert.equal(report.tool, 'meshoptimizer@0.23.0'); assert.equal(report.decoderProofs.length, 2);
    assert.deepEqual(await readFile(input), source.bytes); assert.deepEqual(await readFile(output), result.bytes);
    await assert.rejects(optimizeEnvironment(options, { ZENDING_MESHOPT_TOOLCHAIN: process.env.PHASE2_MESHOPT_TOOLCHAIN }), /拒绝覆盖/);
    const old = await optimizeEnvironment(parseOptions([input, path.join(root, 'old.glb'), '--mode=model-lossless']),
      { ZENDING_MESHOPT_TOOLCHAIN: 'must-not-be-loaded', ZENDING_GLTF_TRANSFORM_CLI: 'must-not-be-loaded' });
    assert.equal(old.tool, 'builtin-glb-view-packer@1');
    assert.ok((await readdir(root)).every(name => !name.startsWith('.environment-optimize-')));
  });
});
