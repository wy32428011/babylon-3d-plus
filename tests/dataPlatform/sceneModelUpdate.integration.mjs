import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { build } from 'vite';
import unzipper from 'unzipper';

const root = process.env.SCENE_MODEL_UPDATE_TEST_ROOT;
assert.ok(root && path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('scene-model-update-'));
const moduleRoot = await mkdtemp(path.resolve('node_modules/.scene-update-integration-'));
const artifactRoot = path.resolve('artifacts', 'scene-model-update-' + Date.now());
await mkdir(path.join(root, 'user-data'));
await mkdir(artifactRoot, { recursive: true });
app.setPath('userData', path.join(root, 'user-data'));
app.on('window-all-closed', () => {});
app.getAppPath = () => path.resolve();
let server, bridge, viewer, service;
protocol.registerSchemesAsPrivileged([{ scheme: 'editor-asset', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true } }]);

function glb(version) {
  const positions = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]);
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 2, 0] }],
    materials: [{ name: 'paint', doubleSided: true, emissiveFactor: version === 1 ? [1, 0, 0] : [0, 1, 0],
      pbrMetallicRoughness: { baseColorFactor: version === 1 ? [1, 0, 0, 1] : [0, 1, 0, 1], metallicFactor: 0 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ name: 'Body', mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 }));
  const n = Math.ceil(json.length / 4) * 4, out = Buffer.alloc(28 + n + positions.byteLength);
  out.write('glTF'); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(n, 12); out.writeUInt32LE(0x4e4f534a, 16); out.fill(32, 20, 20 + n); json.copy(out, 20);
  out.writeUInt32LE(positions.byteLength, 20 + n); out.writeUInt32LE(0x004e4942, 24 + n);
  Buffer.from(positions.buffer).copy(out, 28 + n); return out;
}
const config = version => ({ schema: 'babylon-editor.model-parameters', version: 1,
  parameters: [{ key: 'width', label: '宽度', type: 'number', defaultValue: version === 1 ? 1 : 9, min: 0, max: 10 },
    { key: 'enabled', label: '开关', type: 'boolean', defaultValue: true },
    { key: 'label', label: '文字', type: 'string', defaultValue: '新版默认' },
    ...(version > 1 ? [{ key: 'speed', label: '速度', type: 'number', defaultValue: 5 }] : [])],
  bindings: [{ target: { kind: 'node', name: 'Body' }, property: 'scaling', value: { vector3: [{ param: 'width' }, 1, 1] } }] });

async function run() {
  service = await import('../../dist-electron/ipc/dataPlatformProjectService.js');
  const bindings = await import('../../dist-electron/ipc/dataPlatformBindingStore.js');
  const assets = await import('../../dist-electron/ipc/projectAssetStore.js');
  const { encodeAssetUrl, authorizeAssetFile, isAuthorizedAssetFile, decodeAssetUrl } = await import('../../dist-electron/ipc/assetRegistry.js');
  protocol.handle('editor-asset', async request => {
    const filePath = decodeAssetUrl(request.url);
    if (!isAuthorizedAssetFile(filePath)) return new Response('Forbidden', { status: 403 });
    return new Response(await readFile(filePath), { headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
  const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
  await build({ configFile: false, publicDir: false, logLevel: 'warn', build: { ssr: true, outDir: moduleRoot,
    rollupOptions: { input: { apply: 'src/editor/assets/applySceneModelUpdates.ts', document: 'src/editor/model/SceneDocument.ts',
      serializer: 'src/editor/project/SceneSerializer.ts', click: 'src/player/viewerModelClick.ts' }, output: { entryFileNames: '[name].mjs' } } } });
  const [{ applySceneModelUpdates }, document, serializer, { createViewerModelClickHandler }] = await Promise.all(
    ['apply', 'document', 'serializer', 'click'].map(name => import(pathToFileURL(path.join(moduleRoot, name + '.mjs')).href)));
  let revision = 1, downloads = 0;
  const requests = [], distFiles = new Map();
  server = createServer(async (request, response) => {
    const route = new URL(request.url, 'http://test').pathname;
    requests.push(route);
    response.setHeader('Connection', 'close');
    if (route === '/api/v1/digital-twin/runtime-config/detail') {
      request.resume(); response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, data: { projectId: '11', runtimeEnabled: true, configJson: '{}' } })); return;
    }
    if (route === '/api/v1/models/detail') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      assert.equal(JSON.parse(raw).id, '123');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, data: { id: '123', modelName: 'fixture', fileName: 'model.glb',
        fileUrl: `/files/v${revision}.glb`, metaFileUrl: `/files/v${revision}.json`, revision: String(revision) } })); return;
    }
    const version = /\/files\/v(\d)\.(glb|json)$/.exec(route);
    if (version) {
      downloads++;
      const content = version[2] === 'glb' ? glb(Number(version[1]))
        : Buffer.from(JSON.stringify({ lengthUnit: 'meter', modelParameters: config(Number(version[1])) }));
      response.setHeader('Content-Type', version[2] === 'glb' ? 'model/gltf-binary' : 'application/json');
      response.end(content); return;
    }
    const file = distFiles.get(route.replace(/^\/viewer\//, ''));
    if (file) {
      const ext = path.extname(route);
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.glb': 'model/gltf-binary' })[ext] ?? 'application/octet-stream');
      response.end(await file.buffer()); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const workspaceRoot = path.join(root, 'workspace'), projectRoot = path.join(workspaceRoot, 'Projects', '11');
  const sharedResourcesRoot = path.join(workspaceRoot, 'SharedResources');
  await mkdir(path.join(projectRoot, 'Scenes'), { recursive: true }); await mkdir(sharedResourcesRoot, { recursive: true });
  bindings.setCurrentDataPlatformBinding(projectRoot, bindings.createDataPlatformBinding({
    baseUrl, webBaseUrl: baseUrl, workspaceRoot, projectId: '11', projectName: '模型同步集成验证', editorProjectId: null,
    latestVersionId: null, latestVersionNumber: null, resourceRevision: '1', entryScenePath: null, syncedAt: new Date().toISOString() }));
  await assets.activateProjectRoot(projectRoot);
  const oldPath = path.join(projectRoot, 'Assets', 'Models', 'Model-123-fixture', 'model.glb');
  await mkdir(path.dirname(oldPath), { recursive: true }); await writeFile(oldPath, glb(1)); authorizeAssetFile(oldPath);
  const scene = document.createEmptySceneDocument('最新模型参数保留');
  const models = [1, 2].map((width, index) => {
    const model = document.createModelEntity(oldPath, encodeAssetUrl(oldPath), '设备 ' + index);
    Object.assign(model.components.modelAsset, { assetCode: 'DEVICE-' + index, parameterConfig: config(1),
      parameterValues: { width, enabled: false, label: '' } });
    model.components.transform.position.x = index * 5;
    scene.entityIds.push(model.id); scene.entities[model.id] = model; return model;
  });
  const click = document.createClickEventBindingEntity();
  click.components.clickEventBinding.deviceSlots = [{ id: 'slot', deviceType: { id: 'type', assetId: 'old', displayName: 'fixture', sourcePath: oldPath, sourceUrl: encodeAssetUrl(oldPath) } }];
  click.components.clickEventBinding.events = [{ id: 'click', eventType: 'click', effects: ['highlight', 'focus', 'show-chart'],
    chart: { id: 'chart-1', name: '设备大屏', projectId: '11', screenId: 'screen-1' } }];
  scene.entityIds.push(click.id); scene.entities[click.id] = click;
  ipcMain.handle('data-platform:prepareLocalSceneResources', (_event, request) => service.prepareLocalSceneResources(baseUrl, workspaceRoot, request));
  bridge = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve('dist-electron/preload.cjs'), contextIsolation: true, sandbox: true } });
  await bridge.loadURL('data:text/html,<title>同步桥接验证</title>');
  const prepare = async document => bridge.webContents.executeJavaScript(`window.editorApi.prepareLocalSceneResources(${JSON.stringify({ mode: 'data-platform-latest', sceneContent: serializer.serializeScene(document) })})`);
  const first = await prepare(scene);
  const firstScene = applySceneModelUpdates(scene, first.modelReplacements, first.sourceKey).scene;
  const firstPath = first.modelAssets[0].path;
  revision = 2;
  const result = await prepare(firstScene);
  const fetchedBytes = await bridge.webContents.executeJavaScript(`fetch(${JSON.stringify(result.modelAssets[0].sourceUrl)}).then(async response => { if (!response.ok) throw new Error('模型协议读取失败 ' + response.status); return (await response.arrayBuffer()).byteLength; })`);
  assert.equal(fetchedBytes, glb(2).length, '实际 editor-asset 协议必须允许读取固定模型文件');
  assert.equal(result.modelAssets.length, 1); assert.notEqual(result.modelAssets[0].path, firstPath);
  assert.deepEqual(await readFile(firstPath), glb(1), '同步新版不能覆盖上一版本文件');
  const updated = applySceneModelUpdates(firstScene, result.modelReplacements, result.sourceKey).scene;
  for (let i = 0; i < models.length; i++) {
    const current = updated.entities[models[i].id];
    assert.deepEqual(current.components.modelAsset.parameterValues, { width: i + 1, enabled: false, label: '', speed: 5 });
    assert.deepEqual(current.components.transform, models[i].components.transform);
    assert.equal(current.components.modelAsset.assetCode, 'DEVICE-' + i);
  }
  const beforeRepeat = downloads;
  const repeat = await prepare(updated);
  assert.equal(downloads, beforeRepeat, '相同资源版本再次打开无需下载');
  assert.equal(applySceneModelUpdates(updated, repeat.modelReplacements, repeat.sourceKey).scene, updated);
  assert.ok(!requests.some(route => route.endsWith('/query')), '不能启动全库查询');
  const entrySceneFilePath = path.join(projectRoot, 'Scenes', 'updated.scene.json');
  await writeFile(entrySceneFilePath, serializer.serializeScene(updated));
  const saved = serializer.deserializeScene(await readFile(entrySceneFilePath, 'utf8'));
  assert.deepEqual(saved.entities[models[1].id].components.modelAsset.parameterValues, { width: 2, enabled: false, label: '', speed: 5 });
  const signal = new AbortController().signal;
  const source = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot, entrySceneFilePath, outputRoot: path.join(root, 'output'), signal,
    manifest: { projectId: '11', projectName: '同步回归', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    isPlatformImageReference: () => false, findSyncedImageForReference: async () => null });
  assert.deepEqual(source.omittedResources, []);
  const dist = await buildDigitalTwinDistPackage({ projectId: '11', publishName: '同步回归', sceneContent: source.entrySceneContent,
    sourceResourceFiles: source.resourceFiles, outputRoot: path.join(root, 'output'), signal });
  const zip = await unzipper.Open.file(dist.filePath);
  for (const file of zip.files) if (file.type === 'File') distFiles.set(file.path, file);
  const published = serializer.deserializeScene((await distFiles.get('project/scene.json').buffer()).toString());
  assert.deepEqual(published.entities[models[1].id].components.modelAsset.parameterValues, { width: 2, enabled: false, label: '', speed: 5 });
  const events = [], screens = [];
  const handler = createViewerModelClickHandler(published, { updateSelection() {}, setSlotHighlight() {}, focusTarget() {}, triggerManualEvents() {},
    emitAssetClicked: event => events.push(event), showScreen: screen => screens.push(screen) });
  handler(models[1].id);
  assert.equal(events[0].assetCode, 'DEVICE-1'); assert.equal(screens.length, 1);
  const browserErrors = [];
  viewer = new BrowserWindow({ show: false, width: 1100, height: 780, webPreferences: { contextIsolation: true, sandbox: true } });
  viewer.webContents.on('console-message', event => { if (event.level === 'error') browserErrors.push(event.message); });
  await viewer.loadURL(baseUrl + '/viewer/index.html');
  const deadline = Date.now() + 60000;
  let screenshot, greenPixels = 0;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    screenshot = await viewer.webContents.capturePage();
    const bytes = screenshot.toBitmap(); greenPixels = 0;
    for (let i = 0; i < bytes.length; i += 4) if (bytes[i + 1] > 100 && bytes[i + 1] > bytes[i] * 1.5 && bytes[i + 1] > bytes[i + 2] * 1.5) greenPixels++;
    if (greenPixels > 150) break;
  }
  await writeFile(path.join(artifactRoot, 'viewer-latest.png'), screenshot.toPNG());
  assert.ok(greenPixels > 150, `新版绿色模型必须实际渲染，绿色像素 ${greenPixels}；浏览器错误 ${browserErrors.join('; ')}`);
  assert.deepEqual(browserErrors, []);
  await writeFile(path.join(artifactRoot, 'result.json'), JSON.stringify({ passed: true, models: models.length, greenPixels,
    downloads, sourceFiles: source.resourceFiles.length, checks: ['actual-preload', 'targeted-http', 'immutable-old-version', 'zero-download-repeat',
      'instance-parameters', 'save-reopen', 'source-dist', 'viewer-click', 'real-viewer-webgl'] }, null, 2));
  console.log('PASS: 实际 preload → 定向 HTTP 最新模型 → 多实例参数保留 → 保存重开 → SOURCE/DIST → Viewer 点击与真实绿色模型渲染。');
  console.log('ARTIFACTS=' + artifactRoot);
}

async function finish(code) {
  if (bridge && !bridge.isDestroyed()) bridge.destroy(); if (viewer && !viewer.isDestroyed()) viewer.destroy();
  ipcMain.removeHandler('data-platform:prepareLocalSceneResources');
  if (service) await service.disposeDataPlatformProjectTasks();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.equal(path.dirname(moduleRoot), path.resolve('node_modules')); assert.ok(path.basename(moduleRoot).startsWith('.scene-update-integration-'));
  await rm(moduleRoot, { recursive: true, force: true }); app.exit(code);
}
app.whenReady().then(run).then(() => finish(0), async error => { console.error(error); await finish(1); });
