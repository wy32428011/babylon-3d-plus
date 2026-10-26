import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { analyzeGltfJson } from '../../electron/shared/modelDensityAnalysis.js';
import { encodeModelGlb } from '../../scripts/lib/phase2AssetSemantics.mjs';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/electron/')) {
    const target = new URL(specifier, context.parentURL), source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (!existsSync(target) && existsSync(source)) return { url: source.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { scanModelPackage, inspectSourceModelDensity } = await import('../../electron/ipc/modelPackageScanner.ts');
after(() => hooks.deregister());

function model(triangles = 20_001, size = 0.2) {
  const positions = new Float32Array([-size / 2, -size / 2, -size / 2, size / 2, -size / 2, size / 2, size / 2, size / 2, -size / 2]);
  const indices = new Uint16Array(triangles * 3);
  for (let index = 0; index < indices.length; index++) indices[index] = index % 3;
  const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const json = { asset: { version: '2.0' }, nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
    meshes: [{ name: '源高模', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: indices.byteLength }],
    accessors: [{ componentType: 5126, type: 'VEC3', count: 3, bufferView: 0, min: [-size / 2, -size / 2, -size / 2], max: [size / 2, size / 2, size / 2] },
      { componentType: 5123, type: 'SCALAR', count: indices.length, bufferView: 1 }] };
  return { json, binary, bytes: () => encodeModelGlb(json, binary) };
}
async function directory(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'phase2-model-density-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('phase2-model-density-')); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test('共享分析沿用CLI阈值并按源单位换算，未知面数与尺寸保持null', () => {
  const f = model(20_001, 20);
  assert.equal(analyzeGltfJson(f.json).findings.length, 0);
  const centimeters = analyzeGltfJson(f.json, undefined, { unitScaleToMeters: 0.01 });
  assert.deepEqual(centimeters.findings[0].sizeMeters, [0.2, 0.2, 0.2]);
  assert.ok(centimeters.findings[0].reasons.includes('small-high-poly'));
  delete f.json.accessors[0].min;
  assert.equal(analyzeGltfJson(f.json).findings.length, 0);
  assert.match(analyzeGltfJson(f.json).unknownReasons.join('\n'), /尺寸未知/);
  delete f.json.accessors[1].count;
  const unknown = analyzeGltfJson(f.json);
  assert.equal(unknown.triangles, null); assert.equal(unknown.uniqueTriangles, null);
  assert.match(unknown.unknownReasons.join('\n'), /面数未知/);
});

test('形变/GPU实例/未知扩展不猜尺寸，压缩计数仅作JSON估计', () => {
  const f = model();
  f.json.meshes[0].primitives[0].targets = [{ POSITION: 0 }];
  const dynamic = analyzeGltfJson(f.json);
  assert.equal(dynamic.findings.length, 0); assert.match(dynamic.unknownReasons.join('\n'), /形变/);
  delete f.json.meshes[0].primitives[0].targets;
  f.json.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 0 } } };
  const instances = analyzeGltfJson(f.json);
  assert.equal(instances.instanceCount, 3); assert.equal(instances.triangles, 20_001 * 3);
  assert.equal(instances.findings.length, 0); assert.match(instances.unknownReasons.join('\n'), /逐实例变换/);
  delete f.json.nodes[0].extensions;
  f.json.extensionsUsed = ['UNKNOWN_density_extension'];
  assert.equal(analyzeGltfJson(f.json).findings.length, 0);
  f.json.extensionsUsed = ['KHR_draco_mesh_compression'];
  const compressed = analyzeGltfJson(f.json);
  assert.equal(compressed.triangles, 20_001); assert.equal(compressed.compression.draco, true);
  assert.match(compressed.unknownReasons.join('\n'), /未解码验证/);
});

test('scanner数据源为真实GLB及meta单位，脚本最终几何未知，未知扩展不阻断导入', async t => {
  const root = await directory(t), file = path.join(root, 'main.glb'), f = model(20_001, 20);
  await fs.writeFile(file, f.bytes()); await fs.writeFile(path.join(root, 'meta.json'), JSON.stringify({ lengthUnit: 'centimeter' }));
  const result = await scanModelPackage(root);
  assert.ok(result.asset); assert.equal(result.asset.sourceModelDensity.unitScaleToMeters, 0.01);
  assert.equal(result.asset.sourceModelDensity.findings.length, 1);
  const scripted = await inspectSourceModelDensity(file, 0.01, true);
  assert.equal(scripted.status, 'partial'); assert.match(scripted.unknownReasons.join('\n'), /最终几何未知/);
  f.json.extensionsUsed = ['UNKNOWN_density_extension']; await fs.writeFile(file, f.bytes());
  const unknown = await scanModelPackage(root);
  assert.ok(unknown.asset); assert.equal(unknown.asset.sourceModelDensity.status, 'partial');
  assert.equal(unknown.asset.sourceModelDensity.findings.length, 0);
});

test('诊断仅读取JSON/块头，文件/单位/跨包失效正确，缓存摘要不向调用者共享可变引用', async t => {
  const root = await directory(t), file = path.join(root, 'main.glb'), f = model(20_001, 20);
  await fs.writeFile(file, f.bytes());
  const originalOpen = fs.open; let opens = 0, requestedBytes = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args); opens++;
    const read = handle.read.bind(handle);
    handle.read = async (...params) => { requestedBytes += params[2]; return read(...params); };
    return handle;
  });
  const meter = await inspectSourceModelDensity(file, 1); assert.equal(meter.findings.length, 0);
  assert.ok(requestedBytes < 4096, '120KB BIN 没有进入诊断内存');
  const initialOpens = opens;
  await inspectSourceModelDensity(file, 1); assert.equal(opens, initialOpens);
  const cm = await inspectSourceModelDensity(file, 0.01); assert.equal(cm.findings.length, 1); assert.ok(opens > initialOpens);
  cm.findings.length = 0; assert.equal((await inspectSourceModelDensity(file, 0.01)).findings.length, 1);
  await fs.writeFile(file, model(1, 20).bytes());
  assert.equal((await inspectSourceModelDensity(file, 0.01)).triangles, 1);
  const other = path.join(root, 'other'); await fs.mkdir(other); const otherFile = path.join(other, 'main.glb');
  await fs.writeFile(otherFile, f.bytes()); assert.equal((await inspectSourceModelDensity(otherFile, 0.01)).triangles, 20_001);
});

test('合法模型的诊断IO失败只显示未计算，不作为原导入失败', async t => {
  const root = await directory(t), file = path.join(root, 'main.glb'); await fs.writeFile(file, model().bytes());
  t.mock.method(fs, 'open', async () => { throw Object.assign(new Error('fixture transient lock'), { code: 'EBUSY' }); });
  const scanned = await scanModelPackage(root);
  assert.ok(scanned.asset); assert.equal(scanned.asset.sourceModelDensity.status, 'unavailable');
  assert.equal(scanned.asset.sourceModelDensity.triangles, null);
  assert.match(scanned.asset.sourceModelDensity.unknownReasons.join('\n'), /未计算/);
});
