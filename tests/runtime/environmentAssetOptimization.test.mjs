import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile, mkdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  assertSemanticsUnchanged, conversionArguments, createKtxEncodingPlan, optimizeEnvironment, parseOptions,
  resolveToolchain, semanticSnapshot, validateDocumentJson, validatePaths,
} from '../../scripts/optimize-environment-glb.mjs';

test('默认仅去重纹理；显式 KTX2 不过滤任何材质纹理槽', () => {
  const parsed = parseOptions(['before.glb', 'after.glb']);
  assert.equal(parsed.mode, 'dedup');
  assert.deepEqual(conversionArguments('dedup', 'before.glb', 'after.glb'), [
    'dedup', 'before.glb', 'after.glb', '--accessors', 'false', '--materials', 'false',
    '--meshes', 'false', '--skins', 'false', '--textures', 'true',
  ]);
  assert.equal(parseOptions(['before.glb', 'after.glb', '--mode=ktx2']).mode, 'ktx2');
  assert.equal(conversionArguments('ktx2', 'a', 'b').includes('--slots'), false);
  assert.deepEqual(conversionArguments('ktx2', 'a', 'b').slice(-2), ['--jobs', '2']);
  assert.deepEqual(conversionArguments('ktx2', 'a', 'b'), ['uastc', 'a', 'b', '--level', '2', '--zstd', '5', '--jobs', '2']);
  for (const args of [[], ['same.glb', 'same.glb'], ['a.glb', 'b.glb', '--mode', 'unknown'], ['a.glb', 'b.glb', '--force']]) {
    assert.throws(() => parseOptions(args));
  }
});

test('KTX2 精确筛选可编码图片，保留不合规尺寸，并为缺失或重复名称建立临时别名', () => {
  const texture = (name, size) => ({ getName: () => name, getSize: () => size, getMimeType: () => 'image/png', getImage: () => new Uint8Array([1, 2]) });
  const plan = createKtxEncodingPlan([texture('good.png', [2048, 2048]), texture('keep.png', [850, 644])]);
  assert.equal(plan.pattern, 'good.png');
  assert.equal(plan.selected.length, 1);
  assert.equal(plan.skipped[0].reason, 'dimensions-not-multiple-of-four');
  const ambiguous = createKtxEncodingPlan([texture('', [2048, 2048]), texture('', [1417, 945])]);
  assert.equal(ambiguous.needsAliases, true);
  assert.equal(ambiguous.pattern, '__ktx_texture_0__');
  assert.equal(createKtxEncodingPlan([texture('a.png', [2048, 2048]), texture('prefix-a.png', [850, 644])]).needsAliases, true);
  assert.equal(createKtxEncodingPlan([texture('A.png', [2048, 2048]), texture('a.png', [850, 644])]).needsAliases, true);
});

test('拒绝覆盖源文件、已有输出及已有报告，不改变其字节', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'environment-optimize-test-'));
  try {
    const input = path.join(directory, 'input.glb');
    const output = path.join(directory, 'output.glb');
    const reportPath = `${output}.report.json`;
    await writeFile(input, 'source sentinel');
    await writeFile(output, 'output sentinel');
    await assert.rejects(validatePaths({ input, output, reportPath }), /拒绝覆盖/);
    assert.equal(await readFile(output, 'utf8'), 'output sentinel');
    await rm(output);
    await writeFile(reportPath, 'report sentinel');
    await assert.rejects(validatePaths({ input, output, reportPath }), /拒绝覆盖/);
    assert.equal(await readFile(input, 'utf8'), 'source sentinel');
    assert.equal(await readFile(reportPath, 'utf8'), 'report sentinel');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('拒绝外部资源和未知扩展，拒绝几何或材质参数改变', () => {
  assert.throws(() => validateDocumentJson({ images: [{ uri: 'https://example.com/image.png' }] }, new Set()), /内嵌/);
  assert.throws(() => validateDocumentJson({ extensionsUsed: ['UNKNOWN'] }, new Set()), /不支持的扩展/);
  const before = { nodes: [{ name: '设备' }], accessors: [{ sha256: 'original' }], materials: [{ roughnessFactor: 1 }] };
  assertSemanticsUnchanged(before, structuredClone(before));
  assert.throws(() => assertSemanticsUnchanged(before, { ...before, accessors: [{ sha256: 'changed' }] }), /改变了/);
  assert.throws(() => assertSemanticsUnchanged(before, { ...before, materials: [{ roughnessFactor: 0 }] }), /改变了/);
});

test('拒绝通过显式路径加载不同版本的 CLI', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'environment-optimize-test-'));
  try {
    await mkdir(path.join(directory, 'bin'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@gltf-transform/cli', version: '0.0.0' }));
    await writeFile(path.join(directory, 'bin', 'cli.js'), '');
    await assert.rejects(resolveToolchain({ ZENDING_GLTF_TRANSFORM_CLI: directory }), /必须使用.*4\.4\.2/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('真实 CLI 小型 GLB 去重保持两种 sampler、材质、几何和源文件', async (context) => {
  let toolchain;
  try { toolchain = await resolveToolchain(); }
  catch (error) { context.skip(`本机没有固定版本 CLI：${error.message}`); return; }
  const toolRequire = createRequire(path.join(toolchain.packageRoot, 'package.json'));
  const { Document, NodeIO } = await import(pathToFileURL(toolRequire.resolve('@gltf-transform/core')).href);
  const directory = await mkdtemp(path.join(tmpdir(), 'environment-optimize-test-'));
  try {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const positions = doc.createAccessor('positions').setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
    const indices = doc.createAccessor('indices').setType('SCALAR').setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
    const textureA = doc.createTexture('duplicate-a').setImage(png).setMimeType('image/png');
    const textureB = doc.createTexture('duplicate-b').setImage(png).setMimeType('image/png');
    const first = doc.createMaterial('first').setBaseColorTexture(textureA).setMetallicFactor(0.25).setRoughnessFactor(0.5);
    const second = doc.createMaterial('second').setBaseColorTexture(textureB).setDoubleSided(true);
    first.getBaseColorTextureInfo().setWrapS(33071);
    second.getBaseColorTextureInfo().setWrapS(10497);
    const mesh = doc.createMesh('mesh').addPrimitive(doc.createPrimitive().setAttribute('POSITION', positions).setIndices(indices).setMaterial(first))
      .addPrimitive(doc.createPrimitive().setAttribute('POSITION', positions).setIndices(indices).setMaterial(second));
    const node = doc.createNode('node').setTranslation([1, 2, 3]).setMesh(mesh);
    doc.createScene('scene').addChild(node);
    const times = doc.createAccessor('time').setType('SCALAR').setArray(new Float32Array([0, 1])).setBuffer(buffer);
    const translations = doc.createAccessor('translations').setType('VEC3').setArray(new Float32Array([1, 2, 3, 2, 2, 3])).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(times).setOutput(translations);
    doc.createAnimation('motion').addSampler(sampler).addChannel(doc.createAnimationChannel().setSampler(sampler).setTargetNode(node).setTargetPath('translation'));
    const io = new NodeIO();
    const input = path.join(directory, 'input with spaces.glb');
    const output = path.join(directory, 'deduplicated & safe.glb');
    await io.write(input, doc);
    const original = await readFile(input);
    const report = await optimizeEnvironment(parseOptions([input, output]), { ...process.env, ZENDING_GLTF_TRANSFORM_CLI: toolchain.cliPath });
    assert.equal(report.before.imageCount, 2);
    assert.equal(report.after.imageCount, 1);
    assert.equal(report.after.totalPixels, 1);
    assert.deepEqual(await readFile(input), original);
    assert.ok((await lstat(`${output}.report.json`)).size > 0);
    const optimized = await io.read(output);
    const materials = optimized.getRoot().listMaterials();
    assert.equal(materials.length, 2);
    assert.equal(materials[0].getBaseColorTextureInfo().getWrapS(), 33071);
    assert.equal(materials[1].getBaseColorTextureInfo().getWrapS(), 10497);
    assert.equal(optimized.getRoot().listNodes()[0].getName(), 'node');
    assert.equal(optimized.getRoot().listAnimations().length, 1);
    assertSemanticsUnchanged(await semanticSnapshot(io, await io.read(input), 'dedup'), await semanticSnapshot(io, optimized, 'dedup'));
    const correctSnapshot = await semanticSnapshot(io, optimized, 'dedup');
    const originalPositions = optimized.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION');
    const replacement = optimized.createAccessor('other-position').setType('VEC3').setArray(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0])).setBuffer(optimized.getRoot().listBuffers()[0]);
    optimized.getRoot().listMeshes()[0].listPrimitives()[0].setAttribute('POSITION', replacement);
    const changedSnapshot = await semanticSnapshot(io, optimized, 'dedup');
    // 即使Accessor集合被刻意设置成一致，引用绑定的数据变化也必须被发现。
    changedSnapshot.accessors = correctSnapshot.accessors;
    assert.throws(() => assertSemanticsUnchanged(correctSnapshot, changedSnapshot), /改变了/);
    optimized.getRoot().listMeshes()[0].listPrimitives()[0].setAttribute('POSITION', originalPositions);
    await assert.rejects(optimizeEnvironment(parseOptions([input, output])), /拒绝覆盖/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
