import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import unzipper from 'unzipper';
import { deploymentGlbFixture } from '../helpers/deploymentGlbFixture.mjs';

const host = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-loose-host-'));
after(async () => { assert.equal(path.dirname(host), path.resolve(os.tmpdir())); await fs.rm(host, { recursive: true, force: true }); });
const electronStub = 'data:text/javascript,' + encodeURIComponent('export const app={isPackaged:false,getPath:()=>'+JSON.stringify(host)+',getAppPath:()=>process.cwd()};export const dialog={},ipcMain={},net={},shell={},BrowserWindow={},protocol={},session={};');
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'electron') return next(electronStub, context);
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/electron/')) { const target = new URL(specifier, context.parentURL), source = new URL(target.href.slice(0, -3) + '.ts');
    if (!existsSync(target) && existsSync(source)) return next(source.href, context); }
  return next(specifier, context);
} });
// Source内部仍有require桥接共享依赖；Node22对同一图并发import/require会出现状态0竞态。
const { buildDigitalTwinSourcePackage } = await import('../../electron/ipc/digitalTwinSourcePackage.ts');
const { prepareDeploymentExport } = await import('../../electron/ipc/deploymentExportScene.ts');
const { bindSourceResourceIntegrity } = await import('../../electron/ipc/digitalTwinSourceResourcePlan.ts');
const registry = await import('../../electron/ipc/assetRegistry.ts'), assets = await import('../../electron/ipc/projectAssetStore.ts');
const { validateGlbModelFile } = await import('../../electron/ipc/modelPackageScanner.ts');
// 仅手动历史对照使用已冻结构建；默认fresh源码测试不读取dist。
const historical = process.env.PHASE2_LOOSE_OLD_DIST === '1' ? {
  deployment: await import('../../dist-electron/ipc/deploymentExportScene.js'), registry: await import('../../dist-electron/ipc/assetRegistry.js'), assets: await import('../../dist-electron/ipc/projectAssetStore.js'),
} : null;
hooks.deregister();
const url = file => 'editor-asset://local/' + encodeURIComponent(file);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { packaged = false, indexed = false, externalImage = false, externalBuffer = false, dataImage = false, dataBuffer = false, imageUri = 'textures/external.png', missingImage = false, format = 'glb' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-loose-plan-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const projectRoot = path.join(root, 'project'), models = path.join(projectRoot, 'Assets', 'Models'), directory = packaged ? path.join(models, 'Dedicated') : models;
  await fs.mkdir(directory, { recursive: true }); const model = path.join(directory, 'fixture.' + format); let glb = deploymentGlbFixture(), imageFile, bufferFile;
  if (externalImage || externalBuffer || format === 'gltf') {
    const jsonLength = glb.readUInt32LE(12), document = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5i8AAAAASUVORK5CYII=', 'base64');
    if (externalImage) { document.images = [{ uri: dataImage ? 'data:image/png;base64,' + png.toString('base64') : imageUri, mimeType: 'image/png' }]; document.textures = [{ source: 0 }];
      document.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }]; document.meshes[0].primitives[0].material = 0;
      imageFile = path.join(directory, 'textures', 'external.png'); await fs.mkdir(path.dirname(imageFile)); if (!missingImage) await fs.writeFile(imageFile, png); }
    if (externalBuffer || format === 'gltf') { document.buffers[0].uri = dataBuffer ? 'data:application/octet-stream;base64,' + glb.subarray(28 + jsonLength).toString('base64') : 'buffers/geometry.bin'; bufferFile = path.join(directory, 'buffers', 'geometry.bin');
      await fs.mkdir(path.dirname(bufferFile)); await fs.writeFile(bufferFile, glb.subarray(28 + jsonLength)); }
    const json = Buffer.from(JSON.stringify(document)), padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
    const header = Buffer.from(glb.subarray(0, 20)), binaryChunk = externalBuffer ? Buffer.alloc(0) : glb.subarray(20 + jsonLength);
    header.writeUInt32LE(20 + padded.length + binaryChunk.length, 8); header.writeUInt32LE(padded.length, 12);
    glb = format === 'gltf' ? Buffer.from(JSON.stringify(document)) : Buffer.concat([header, padded, binaryChunk]);
  }
  await fs.writeFile(model, glb);
  const sibling = path.join(models, 'UnrelatedSibling', 'meta.json'); await fs.mkdir(path.dirname(sibling)); await fs.writeFile(sibling, '{"unrelated":true}');
  if (packaged) { await fs.writeFile(path.join(directory, 'meta.json'), '{"lengthUnit":"meter"}'); await fs.writeFile(path.join(directory, 'variant.glb'), deploymentGlbFixture('variant')); }
  const script = path.join(projectRoot, 'Assets', 'Scripts', 'explicit.ts'); await fs.mkdir(path.dirname(script), { recursive: true }); await fs.writeFile(script, 'export const explicit = 17;');
  const otherScript = path.join(path.dirname(script), 'not-referenced.ts'); await fs.writeFile(otherScript, 'export const unused = true;');
  registry.authorizeAssetRoot(projectRoot); await assets.activateProjectRoot(projectRoot);
  if (historical) { historical.registry.authorizeAssetRoot(projectRoot); await historical.assets.activateProjectRoot(projectRoot); }
  if (indexed) await assets.writeProjectAssetIndex(projectRoot, { version: 2, assets: [{ kind: 'model', libraryKind: 'model', name: 'indexed-fixture', path: model, packagePath: directory }] });
  const sceneFile = path.join(projectRoot, 'Scenes', 'main.scene.json'); await fs.mkdir(path.dirname(sceneFile));
  const scene = { version: 6, scene: { id: 'loose-fixture', entityIds: ['model'], entities: { model: { id: 'model', parentId: null, childrenIds: [], components: {
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, modelAsset: {
      sourcePath: model, sourceUrl: url(model), parameterValues: { unchanged: 27 }, scriptAssets: [{ path: script, sourceUrl: url(script), name: 'explicit.ts' }],
    },
  } } }, sceneSettings: { lighting: { version: 2, bake: { enabled: false } } }, mqttConfig: { enabled: false } } };
  await fs.writeFile(sceneFile, JSON.stringify(scene));
  const signal = new AbortController().signal;
  const source = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath: sceneFile, outputRoot: path.join(root, 'source-output'), signal,
    manifest: { projectId: '42', projectName: 'loose model resource contract', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    isPlatformImageReference: () => false, findSyncedImageForReference: async () => null, skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
  const deployment = await (historical?.deployment.prepareDeploymentExport ?? prepareDeploymentExport)(source.entrySceneContent, 'loose fixture', [], signal, () => {});
  return { projectRoot, model, sibling, script, otherScript, scene, source, deployment, directory, imageFile, bufferFile };
}

test('真实SOURCE/DIST plan：库根loose有效GLB仅显式模型与脚本，不收无关sibling且完整性门仍成立', async t => {
  const f = await fixture(t), files = f.deployment.assetFiles;
  assert.ok(files.some(file => path.resolve(file.sourcePath) === path.resolve(f.model)));
  assert.ok(files.some(file => path.resolve(file.sourcePath) === path.resolve(f.script)), '显式跨目录脚本不可丢');
  assert.ok(!files.some(file => path.resolve(file.sourcePath) === path.resolve(f.sibling)), 'Models库根不是单模型完整包');
  assert.ok(!files.some(file => path.resolve(file.sourcePath) === path.resolve(f.otherScript)));
  const bound = bindSourceResourceIntegrity(files, f.source.resourceFiles); assert.equal(bound.length, files.length);
  const archive = await unzipper.Open.file(f.source.filePath); assert.ok(archive.files.some(file => file.path === 'Assets/Models/fixture.glb'));
  for (const file of bound) { const bytes = await fs.readFile(file.sourcePath); assert.equal(bytes.length, file.expectedSize); assert.equal(hash(bytes), file.expectedSha256); }
  assert.deepEqual(JSON.parse(f.deployment.sceneContent).scene.entities.model.components.modelAsset.parameterValues, { unchanged: 27 });
  assert.throws(() => bindSourceResourceIntegrity([{ ...files[0], sourcePath: f.sibling }], f.source.resourceFiles), /未包含/);
});

for (const indexed of [false, true]) test('专属完整模型包与索引旧路径保持：' + JSON.stringify({ indexed }), async t => {
  const f = await fixture(t, { packaged: true, indexed }), files = f.deployment.assetFiles;
  for (const file of ['fixture.glb', 'variant.glb', 'meta.json']) assert.ok(files.some(row => path.resolve(row.sourcePath) === path.resolve(f.directory, file)), file + '必须保持完整专属包');
  assert.ok(!files.some(file => path.resolve(file.sourcePath) === path.resolve(f.sibling)));
  assert.equal(bindSourceResourceIntegrity(files, f.source.resourceFiles).length, files.length);
});

// 独立于SOURCE完整性门：普通模型导入允许GLB外置image，单独DIST也不能静默丢图。
test('有效库根GLB外置image：主导入允许且独立DIST必须保留真实URI依赖', async t => {
  const f = await fixture(t, { externalImage: true }); assert.equal(await validateGlbModelFile(f.model), true);
  assert.ok(f.deployment.assetFiles.some(file => path.resolve(file.sourcePath) === path.resolve(f.imageFile)), 'GLB JSON的实际image URI不得因explicit-only而丢失');
  if (historical) { t.diagnostic(JSON.stringify({ status: 'HISTORICAL_STANDALONE_BASELINE_ONLY', externalImageIncluded: true, unrelatedSiblingIncluded: f.deployment.assetFiles.some(file => path.resolve(file.sourcePath) === path.resolve(f.sibling)) })); return; }
  assert.ok(!f.deployment.assetFiles.some(file => path.resolve(file.sourcePath) === path.resolve(f.sibling)));
});

test('GLB外置image的SOURCE/DIST必须同一闭包，不能靠放宽完整性门或扫描整个库补齐', async t => {
  const f = await fixture(t, { externalImage: true });
  assert.ok(f.source.resourceFiles.some(file => path.resolve(file.sourcePath) === path.resolve(f.imageFile)), 'SOURCE必须收集同一GLB URI依赖');
  assert.equal(bindSourceResourceIntegrity(f.deployment.assetFiles, f.source.resourceFiles).length, f.deployment.assetFiles.length);
});

for (const format of ['glb', 'gltf']) test('明确相对buffer/image依赖在SOURCE与DIST保持同一相对布局及SHA：' + format, async t => {
  const f = await fixture(t, { format, externalBuffer: true, externalImage: true });
  for (const required of [f.model, f.imageFile, f.bufferFile, f.script]) {
    assert.ok(f.source.resourceFiles.some(file => path.resolve(file.sourcePath) === path.resolve(required)));
    assert.ok(f.deployment.assetFiles.some(file => path.resolve(file.sourcePath) === path.resolve(required)));
  }
  const archive = await unzipper.Open.file(f.source.filePath);
  for (const relative of ['textures/external.png', 'buffers/geometry.bin']) assert.ok(archive.files.some(file => file.path === 'Assets/Models/' + relative));
  bindSourceResourceIntegrity(f.deployment.assetFiles, f.source.resourceFiles);
});

test('GLB data URI不造外部文件；仍不能收同目录无关PNG/模型', async t => {
  const f = await fixture(t, { externalImage: true, dataImage: true, externalBuffer: true, dataBuffer: true });
  assert.ok(!f.source.resourceFiles.some(file => path.resolve(file.sourcePath) === path.resolve(f.imageFile)));
  assert.ok(!f.deployment.assetFiles.some(file => path.resolve(file.sourcePath) === path.resolve(f.imageFile)));
  assert.ok(!f.source.resourceFiles.some(file => path.resolve(file.sourcePath) === path.resolve(f.bufferFile)));
  assert.ok(!f.deployment.assetFiles.some(file => path.resolve(file.sourcePath) === path.resolve(f.bufferFile)));
  bindSourceResourceIntegrity(f.deployment.assetFiles, f.source.resourceFiles);
});

for (const [name, options, error] of [
  ['remote', { externalImage: true, imageUri: 'https://example.invalid/image.png' }, /远程资源 URI/],
  ['escape', { externalImage: true, imageUri: '../outside.png' }, /逃逸模型包根目录/],
  ['missing', { externalImage: true, missingImage: true }, /依赖文件不存在/],
  ['invalid-encoding', { externalImage: true, imageUri: 'textures/%ZZ.png' }, /URI 编码不正确/],
]) test('GLB明确依赖错误不能吞掉继续导出：' + name, async t => { await assert.rejects(fixture(t, options), error); });
