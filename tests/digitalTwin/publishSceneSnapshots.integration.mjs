import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { build } from 'vite';
import { deflateSync } from 'node:zlib';

const { app, BrowserWindow, protocol } = electron;
const pngChunk = (type, data) => {
  const tagged = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of tagged) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, tagged, checksum]);
};
const pngHeader = Buffer.alloc(13); pngHeader.writeUInt32BE(2, 0); pngHeader.writeUInt32BE(2, 4); pngHeader[8] = 8; pngHeader[9] = 6;
const parameterPng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', pngHeader),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255]))), pngChunk('IEND', Buffer.alloc(0))]);

// 独立临时 Vite 与 Electron 窗口，不占用编辑器端口、构建目录或当前场景。
const root = process.env.PUBLISH_SNAPSHOT_TEST_ROOT ?? await mkdtemp(path.join(tmpdir(), 'publish-scene-snapshots-'));
if (process.versions.electron) {
  app.setPath('userData', path.join(root, 'user-data'));
  protocol.registerSchemesAsPrivileged([{ scheme: 'editor-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
}
const positions = Buffer.from(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]).buffer);
const gltf = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  materials: [{ name: 'device-material' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], buffers: [{ byteLength: positions.length, uri: `data:application/octet-stream;base64,${positions.toString('base64')}` }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 2, 0] }] });
const floorPositions = Buffer.from(new Float32Array([-10, 0, -10, 10, 0, 10, 10, 0, -10, -10, 0, -10, -10, 0, 10, 10, 0, 10]).buffer);
const floorUvs = Buffer.from(new Float32Array([0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1]).buffer);
const floorIndices = Buffer.from(new Uint16Array([0, 1, 2, 3, 4, 5]).buffer);
const floorBuffer = Buffer.concat([floorPositions, floorUvs, floorIndices]);
const floorModel = JSON.parse(gltf);
floorModel.buffers = [{ byteLength: floorBuffer.length, uri: 'data:application/octet-stream;base64,' + floorBuffer.toString('base64') }];
floorModel.bufferViews[0].byteLength = floorPositions.length;
floorModel.bufferViews.push({ buffer: 0, byteOffset: floorPositions.length, byteLength: floorUvs.length },
  { buffer: 0, byteOffset: floorPositions.length + floorUvs.length, byteLength: floorIndices.length });
Object.assign(floorModel.accessors[0], { count: 6, min: [-10, 0, -10], max: [10, 0, 10] });
floorModel.accessors.push({ bufferView: 1, componentType: 5126, count: 6, type: 'VEC2' },
  { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' });
floorModel.meshes[0].primitives[0].attributes.TEXCOORD_0 = 1;
floorModel.meshes[0].primitives[0].indices = 2;
const source = `
import { EngineStore, Engine, Scene, FreeCamera, Vector3, MeshBuilder, StandardMaterial, Texture, TransformNode } from '@babylonjs/core';
import { SceneRuntime } from '/src/runtime/babylon/SceneRuntime.ts';
import { preparePublishSceneSnapshot } from '/src/editor/deployment/preparePublishSceneSnapshots.ts';
import { createEmptySceneDocument, createModelEntity } from '/src/editor/model/SceneDocument.ts';
import { serializeScene, deserializeScene } from '/src/editor/project/SceneSerializer.ts';
import { createEnvironmentFromAsset } from '/src/editor/assets/environmentAssets.ts';
import { getSceneShadowBakeError } from '/src/editor/model/sceneShadowBake.ts';
async function verifyTextureAssignments() {
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
  const engine = new Engine(canvas); const scene = new Scene(engine);
  new FreeCamera('camera', new Vector3(0, 0, -5), scene);
  const messages = []; const runtime = new SceneRuntime(scene, message => messages.push(message));
  const root = new TransformNode('root', scene); const mesh = MeshBuilder.CreateBox('device', {}, scene); mesh.parent = root;
  const material = new StandardMaterial('device-material', scene); mesh.material = material;
  const entry = { root, meshes: [mesh], parameterBaseline: new Map(), textureCache: new Map() };
  const asset = { assetCode: 'TEXTURE-CHAIN', sourcePath: 'C:/Model-123-device/model.gltf',
    sourceUrl: 'editor-asset://local/' + encodeURIComponent('C:/Model-123-device/model.gltf'), parameterValues: { preserved: 'unchanged' } };
  const wait = async predicate => { const started = performance.now(); while (!predicate()) { if (performance.now() - started > 10000) throw Error('texture regression timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const assign = value => runtime.applyModelParameterValueToTarget(material, 'baseTexture', value, asset, entry);
  engine.runRenderLoop(() => scene.render());
  try {
    material.diffuseTexture = Texture.CreateFromBase64String('data:image/png;base64,${parameterPng.toString('base64')}', 'original', scene);
    assign('success-A.png'); const a = material.diffuseTexture; await wait(() => a.isReady());
    assign('delayed-missing-B.png'); await wait(() => messages.length === 1);
    const recoveredA = material.diffuseTexture === a;
    assign('delayed-missing-B2.png'); assign('success-C.png'); const c = material.diffuseTexture;
    await wait(() => c.isReady()); await wait(() => messages.length === 2);
    const keptC = material.diffuseTexture === c;
    c.dispose(); assign('delayed-missing-B3.png'); await wait(() => messages.length === 3);
    const skippedDisposedAndFailed = material.diffuseTexture === a;
    return { recoveredA, keptC, skippedDisposedAndFailed, valuesPreserved: asset.parameterValues.preserved === 'unchanged' };
  } finally {
    engine.stopRenderLoop(); for (const texture of entry.textureCache.values()) texture.dispose();
    runtime.dispose(); scene.dispose(); engine.dispose(); canvas.remove();
  }
}
window.fixtureResult = (async () => {
  const url = version => 'editor-asset://local/' + encodeURIComponent('C:/' + version + '/Model-123-device/model.gltf');
  const original = createEmptySceneDocument('非入口场景');
  const model = createModelEntity('C:/old/Model-123-device/model.gltf', url('old'), '实例');
  model.components.modelAsset.assetCode = 'DEVICE-042';
  model.components.transform.position.x = 7;
  original.entityIds.push(model.id); original.entities[model.id] = model;
  const content = serializeScene(original);
  const asset = { id: 'new', kind: 'model', libraryKind: 'model', name: '新版', path: 'C:/new/Model-123-device/model.gltf',
    sourceUrl: url('new'), lengthUnit: 'meter', packagePath: 'C:/new/Model-123-device', assetRevision: 'new' };
  let canceled = false;
  window.editorApi = { prepareLocalSceneResources: async () => ({ configured: true, sourceKey: 'a'.repeat(64),
    modelReplacements: [{ sourceUrls: [url('old')], asset }], modelAssets: [asset], environmentAssets: [], issues: [] }) };
  const baseline = EngineStore.Instances.length;
  let frames = 0;
  const render = Scene.prototype.render;
  Scene.prototype.render = function(...args) { frames++; return render.apply(this, args); };
  const logs = [];
  try {
    const result = deserializeScene(await preparePublishSceneSnapshot(content, () => { if (canceled) throw Error('fixture canceled'); }, message => logs.push(message)));
    const after = result.entities[model.id];
    const leaked = EngineStore.Instances.length !== baseline;
    const textureConfig = { schema: 'babylon-editor.model-parameters', version: 1,
      parameters: [{ key: 'surface', label: '纹理', type: 'texture', defaultValue: 'default.png' }],
      bindings: [{ target: { kind: 'material', name: 'device-material' }, property: 'baseTexture', value: { param: 'surface' } }] };
    const textureScene = structuredClone(original);
    textureScene.entities[model.id].components.modelAsset.parameterConfig = textureConfig;
    textureScene.entities[model.id].components.modelAsset.parameterValues = { surface: 'missing.png' };
    asset.parameterConfig = textureConfig;
    const textureResult = deserializeScene(await preparePublishSceneSnapshot(serializeScene(textureScene), () => {}, message => logs.push(message)));
    const retainedMissingTexture = textureResult.entities[model.id].components.modelAsset.parameterValues.surface;
    delete asset.parameterConfig;
    const environmentAsset = { ...asset, libraryKind: 'environment', name: '环境', source: 'data-platform', dataPlatformResourceType: 'ENV_MODEL',
      dataPlatformSourceKey: 'a'.repeat(64), dataPlatformResourceId: '555', dataPlatformRevision: '2',
      sourceUrl: 'editor-asset://local/' + encodeURIComponent('C:/Env-555/floor.gltf'), path: 'C:/Env-555/floor.gltf', packagePath: 'C:/Env-555' };
    const bakeScene = structuredClone(original);
    bakeScene.sceneSettings.environment = createEnvironmentFromAsset(environmentAsset, []);
    if (!bakeScene.sceneSettings.environment) throw Error('fixture environment must be valid');
    bakeScene.sceneSettings.shadows.mode = 'baked';
    bakeScene.sceneSettings.shadows.enabled = true;
    window.editorApi.prepareLocalSceneResources = async () => ({ configured: true, sourceKey: 'a'.repeat(64),
      modelReplacements: [{ sourceUrls: [url('old'), url('new')], asset }], modelAssets: [asset], environmentAssets: [environmentAsset], issues: [] });
    const baked = deserializeScene(await preparePublishSceneSnapshot(serializeScene(bakeScene), () => {}, message => logs.push(message)));
    const firstBakeSignature = baked.sceneSettings.shadows.bake?.signature;
    asset.assetRevision = 'newer';
    const rebaked = deserializeScene(await preparePublishSceneSnapshot(serializeScene(baked), () => {}, message => logs.push(message)));
    const bakeError = getSceneShadowBakeError(rebaked);
    const rebakedSignature = rebaked.sceneSettings.shadows.bake?.signature;
    const bakeSurfaces = rebaked.sceneSettings.shadows.bake?.surfaces.length ?? 0;
    const firstFrames = frames;
    let renderCancellation = '';
    try { await preparePublishSceneSnapshot(content, () => { if (frames > firstFrames) throw Error('cancel during rendering'); }, () => {}); }
    catch (error) { renderCancellation = error.message; }
    window.editorApi.prepareLocalSceneResources = async () => { canceled = true; return { configured: true, sourceKey: 'a'.repeat(64), modelReplacements: [], modelAssets: [], environmentAssets: [] }; };
    let cancellation = '';
    try { await preparePublishSceneSnapshot(content, () => { if (canceled) throw Error('fixture canceled'); }, () => {}); }
    catch (error) { cancellation = error.message; }
    const textureAssignments = await verifyTextureAssignments();
    return { frames, leaked, remainingEngines: EngineStore.Instances.length - baseline, textureAssignments,
      sourceUrl: after.components.modelAsset.sourceUrl, expectedUrl: url('new'), assetCode: after.components.modelAsset.assetCode,
      x: after.components.transform.position.x, unchanged: serializeScene(original) === content, cancellation, renderCancellation,
      bakeError, firstBakeSignature, rebakedSignature, bakeSurfaces, retainedMissingTexture, logs };
  } finally { Scene.prototype.render = render; }
})();
`;
if (!process.versions.electron) {
  const { spawn } = await import('node:child_process');
  let code = 1;
  try {
    const bundle = path.join(root, 'bundle');
    const fixturePath = path.join(root, 'fixture.ts');
    await writeFile(fixturePath, source.replaceAll("'/src/", "'" + process.cwd().replaceAll('\\', '/') + '/src/'));
    await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: 'warn',
      resolve: { alias: { '@babylonjs/core': path.resolve('node_modules/@babylonjs/core') } },
      build: { outDir: bundle, emptyOutDir: true, minify: false, lib: { entry: fixturePath, formats: ['es'], fileName: () => 'fixture.js' } },
    });
    await writeFile(path.join(bundle, 'index.html'), '<!doctype html><html><body><script type="module" src="./fixture.js"></script></body></html>');
    code = await new Promise((resolve, reject) => {
      const child = spawn(electron, [path.resolve(import.meta.filename)], { cwd: process.cwd(), windowsHide: true,
        stdio: 'inherit', env: { ...process.env, PUBLISH_SNAPSHOT_TEST_ROOT: root } });
      child.once('error', reject); child.once('exit', value => resolve(value ?? 1));
    });
  } finally {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('publish-scene-snapshots-')) throw Error('invalid temporary directory');
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  process.exit(code);
}

async function run() {
let window;
let exitCode = 0;
const watchdog = setTimeout(() => { console.error('发布离屏集成测试超时'); app.exit(1); }, 240_000);
try {
  await app.whenReady();
  protocol.handle('editor-asset', async request => decodeURIComponent(request.url).includes('delayed-missing-')
    ? await new Promise(resolve => setTimeout(() => resolve(new Response('missing delayed parameter texture', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } })), 200))
    : decodeURIComponent(request.url).includes('success-')
    ? new Response(parameterPng, { headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' } })
    : decodeURIComponent(request.url).includes('missing.png')
    ? new Response('missing parameter texture', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } })
    : new Response(decodeURIComponent(request.url).includes('Env-555') ? JSON.stringify(floorModel) : gltf,
      { headers: { 'Content-Type': 'model/gltf+json', 'Access-Control-Allow-Origin': '*' } }));
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(message); });
  await window.loadFile(path.join(root, 'bundle', 'index.html'));
  const result = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(window.fixtureResult){clearInterval(timer);window.fixtureResult.then(resolve,reject);}else if(Date.now()-started>180000){clearInterval(timer);reject(Error('fixture initialization timed out'));}},100);})`);
  assert.ok(result.frames >= 2, '必须产生真实 WebGL 就绪帧');
  assert.equal(result.leaked, false, '成功后销毁临时引擎');
  assert.equal(result.remainingEngines, 0, '取消后不能遗留引擎');
  assert.equal(result.sourceUrl, result.expectedUrl);
  assert.equal(result.assetCode, 'DEVICE-042');
  assert.equal(result.x, 7);
  assert.equal(result.unchanged, true, '原场景不能被修改');
  assert.match(result.cancellation, /fixture canceled/);
  assert.match(result.renderCancellation, /cancel during rendering/);
  assert.equal(result.bakeError, null, '自动烘焙后发布契约必须有效');
  assert.ok(result.bakeSurfaces > 0, '必须实际产生环境阴影纹理');
  assert.notEqual(result.firstBakeSignature, result.rebakedSignature, '模型修订变化必须重新烘焙而非保留旧签名');
  assert.equal(result.retainedMissingTexture, 'missing.png', '缺失参数纹理值必须保留');
  assert.ok(result.logs.some(message => message.includes('参数纹理无法读取')), '缺失参数纹理效果须隔离记录并允许首帧继续');
  assert.deepEqual(result.textureAssignments, { recoveredA: true, keptC: true, skippedDisposedAndFailed: true, valuesPreserved: true });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  window?.destroy();
  clearTimeout(watchdog);
  app.exit(exitCode);
}
}
void run();
