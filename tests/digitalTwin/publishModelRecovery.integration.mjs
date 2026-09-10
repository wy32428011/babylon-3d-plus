import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { build } from 'vite';
import unzipper from 'unzipper';

const root = process.env.MODEL_RECOVERY_TEST_ROOT;
if (!root || path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('zending-model-recovery-')) throw new Error('请通过 run-publish-model-recovery-integration.mjs 启动测试');
const moduleRoot = await mkdtemp(path.resolve('node_modules/.recovery-integration-'));
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));
app.getAppPath = () => path.resolve();
let server;
let bridgeWindow;

async function run() {
  const { recoverPublishSceneModels } = await import('../../dist-electron/ipc/digitalTwinModelRecovery.js');
  const { recoverPublishSceneResources } = await import('../../dist-electron/ipc/digitalTwinPublishResourceRecovery.js');
  const { publishDigitalTwin } = await import('../../dist-electron/ipc/digitalTwinPublishService.js');
  const { setCurrentProjectRoot } = await import('../../dist-electron/ipc/projectAssetStore.js');
  const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
  const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
  const { encodeAssetUrl, authorizeAssetFile } = await import('../../dist-electron/ipc/assetRegistry.js');
  await build({ configFile: false, publicDir: false, logLevel: 'warn', build: {
    ssr: true, outDir: moduleRoot, rollupOptions: {
      input: { repair: 'src/editor/deployment/repairPublishSceneModels.ts', document: 'src/editor/model/SceneDocument.ts',
        skyboxRepair: 'src/editor/deployment/repairPublishSceneSkyboxes.ts',
        serializer: 'src/editor/project/SceneSerializer.ts', click: 'src/player/viewerModelClick.ts' },
      output: { entryFileNames: '[name].mjs' },
    },
  } });
  const [{ repairPublishSceneModels }, document, serializer, { createViewerModelClickHandler }] = await Promise.all(
    ['repair', 'document', 'serializer', 'click'].map(name => import(pathToFileURL(path.join(moduleRoot, name + '.mjs')).href)),
  );
  const { repairPublishSceneSkyboxes } = await import(pathToFileURL(path.join(moduleRoot, 'skyboxRepair.mjs')).href);
  const modelBytes = await readFile(path.resolve('public/manual-roam/EQ_People.glb'));
  const requests = [];
  server = createServer(async (request, response) => {
    requests.push(request.url);
    if (request.url === '/model.glb') {
      response.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': modelBytes.length });
      response.end(modelBytes);
    } else if (request.url === '/api/v1/models/detail') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      assert.equal(JSON.parse(raw).id, '12');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: { id: '12', modelName: '双立柱堆垛机', fileName: 'model.glb', fileUrl: '/model.glb', revision: '1' } }));
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const projectRoot = path.join(root, 'project'), sharedResourcesRoot = path.join(root, 'SharedResources');
  await mkdir(path.join(projectRoot, 'Scenes'), { recursive: true });
  await mkdir(sharedResourcesRoot);
  setCurrentProjectRoot(projectRoot);
  const scene = document.createEmptySceneDocument('缺失模型恢复');
  const externalSkybox = path.join(root, 'previous-project', 'sky.hdr');
  await mkdir(path.dirname(externalSkybox), { recursive: true });
  const hdr = Buffer.concat([Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n'),
    Buffer.from([2, 2, 0, 8]), ...[128, 100, 80, 129].flatMap(value => [Buffer.from([8]), Buffer.alloc(8, value)])]);
  await writeFile(externalSkybox, hdr); authorizeAssetFile(externalSkybox);
  scene.sceneSettings.skybox = { packagePath: path.dirname(externalSkybox), sourcePath: externalSkybox,
    sourceUrl: encodeAssetUrl(externalSkybox), format: 'hdr', intensity: 0.75, rotationDegrees: 0.5, resolution: 512 };
  const binding = document.createClickEventBindingEntity();
  const stalePath = path.join(root, 'missing', 'Model-12-双立柱堆垛机', 'model.glb');
  binding.components.clickEventBinding.deviceSlots = [{ id: 'slot', deviceType: {
    id: 'type', assetId: 'old', displayName: '双立柱堆垛机', sourcePath: stalePath, sourceUrl: encodeAssetUrl(stalePath),
  } }];
  binding.components.clickEventBinding.events = ['click', 'click-cell'].map(eventType => ({
    id: eventType, eventType, effects: ['highlight', 'focus', 'show-chart'],
    chart: { id: 'chart-1', name: '设备大屏', projectId: 'project-1', screenId: 'screen-1' },
  }));
  scene.entities[binding.id] = binding; scene.entityIds.push(binding.id);
  const signal = new AbortController().signal;
  await assert.rejects(publishDigitalTwin({ requestId: 'recovery-guard-1', projectId: '1', publishName: '恢复回归',
    remark: '', sceneContent: serializer.serializeScene(scene), overwriteExisting: false, forceOverwrite: false,
    confirmResourceBindings: false, allowedParentOrigins: [],
  }, signal, () => {}), /请先完成发布前模型恢复/);
  assert.deepEqual(requests, [], '直接发布入口必须在写入中台或上传前阻止缺失模型');
  // 实际主窗口加载 preload.cjs；通过真正的 sandbox/contextBridge 跑完整恢复，防止只测服务函数而漏接桌面入口。
  ipcMain.handle('digital-twin-publish:recoverModels', (event, request) => recoverPublishSceneResources(
    request.sceneContent, { baseUrl, projectRoot, sharedResourcesRoot }, signal,
    detail => event.sender.send('digital-twin-publish:progress', { requestId: request.requestId, phase: 'saving', detail }),
  ));
  bridgeWindow = new BrowserWindow({ show: false, webPreferences: {
    preload: path.resolve('dist-electron/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  await bridgeWindow.loadURL('data:text/html,<html><body>preload recovery integration</body></html>');
  assert.deepEqual(await bridgeWindow.webContents.executeJavaScript(
    `['recoverDigitalTwinModels','publishDigitalTwin','cancelDigitalTwinPublish','onDigitalTwinPublishProgress'].map(key => typeof window.editorApi?.[key])`,
  ), ['function', 'function', 'function', 'function']);
  const bridgeRequest = { requestId: 'preload-recovery-1', projectId: '1', sceneContent: serializer.serializeScene(scene) };
  const bridgeResult = await bridgeWindow.webContents.executeJavaScript(`(async () => {
    const progress = [];
    const unsubscribe = window.editorApi.onDigitalTwinPublishProgress(value => progress.push(value));
    try {
      const recovery = await window.editorApi.recoverDigitalTwinModels(${JSON.stringify(bridgeRequest)});
      return { recovery, progress };
    } finally { unsubscribe(); }
  })()`);
  const recovery = bridgeResult.recovery;
  assert.ok(bridgeResult.progress.some(progress => progress.requestId === bridgeRequest.requestId), '真实窗口必须收到恢复进度');
  console.log('PASS: 实际 preload.cjs 在 sandbox 窗口暴露恢复/发布/取消/进度接口，并完成模型恢复 IPC 往返。');
  assert.equal(recovery.replacements.length, 1);
  assert.equal(requests.filter(url => url === '/model.glb').length, 1, '只实际下载一次，身份查询不能造成重复下载');
  assert.ok(requests.filter(url => url === '/api/v1/models/detail').length >= 1, '必须执行中台身份详情校验');
  assert.equal(requests.some(url => !['/api/v1/models/detail', '/model.glb'].includes(url)), false, '定向恢复不得意外查询或下载其他资源');
  const repaired = repairPublishSceneModels(scene, recovery);
  assert.equal(recovery.skyboxReplacements.length, 1, '统一恢复IPC必须同时返回外部天空盒的受管引用');
  repaired.scene = repairPublishSceneSkyboxes(repaired.scene, recovery).scene;
  assert.equal(repaired.scene.sceneSettings.skybox.intensity, 0.75);
  assert.equal(repaired.scene.sceneSettings.skybox.rotationDegrees, 0.5);
  assert.deepEqual(await readFile(repaired.scene.sceneSettings.skybox.sourcePath), hdr);
  assert.equal(repaired.addedCount, 1);
  const model = Object.values(repaired.scene.entities).find(entity => entity.components.modelAsset);
  model.components.modelAsset.assetCode = 'DDJ2';
  model.components.modelAsset.builtInSlotBindingConfig = { enabledParam: 'enabled', dimensionMapping: { columns: 'columns', layers: 'layers' } };
  const locator = document.createLocatorEntity();
  locator.components.locator.builtInBinding = { hostEntityId: model.id, originOffset: { x: 0, y: 0, z: 0 } };
  repaired.scene.entities[locator.id] = locator; repaired.scene.entityIds.push(locator.id);
  const content = serializer.serializeScene(repaired.scene);
  const requestCount = requests.length;
  const repeat = await recoverPublishSceneModels(content, async () => ({ baseUrl, projectRoot, sharedResourcesRoot }), signal, () => {});
  assert.deepEqual(repeat.replacements, []);
  assert.equal(requests.length, requestCount, '健康模型只读检查不得重复下载');
  assert.equal(repairPublishSceneModels(repaired.scene, repeat).scene, repaired.scene);
  const missing = document.createModelEntity(stalePath, encodeAssetUrl(stalePath), '另一个缺失引用');
  const mixed = structuredClone(repaired.scene);
  mixed.entities[missing.id] = missing; mixed.entityIds.push(missing.id);
  const snapshotPath = path.join(projectRoot, 'Assets', 'Models', 'Model-12-双立柱堆垛机', 'model.glb');
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await copyFile(model.components.modelAsset.sourcePath, snapshotPath); authorizeAssetFile(snapshotPath);
  const snapshot = document.createModelEntity(snapshotPath, encodeAssetUrl(snapshotPath), '独立工程快照');
  mixed.entities[snapshot.id] = snapshot; mixed.entityIds.push(snapshot.id);
  const refreshed = await recoverPublishSceneModels(serializer.serializeScene(mixed), async () => ({ baseUrl, projectRoot, sharedResourcesRoot }), signal, () => {});
  assert.ok(refreshed.replacements[0].sourceUrls.includes(model.components.modelAsset.sourceUrl), '被覆盖共享包的健康引用也必须刷新');
  assert.equal(refreshed.replacements[0].sourceUrls.includes(snapshot.components.modelAsset.sourceUrl), false, '独立工程快照不得刷新');
  const mixedResult = repairPublishSceneModels(mixed, refreshed);
  assert.equal(mixedResult.restoredCount, 2);
  assert.deepEqual(mixedResult.scene.entities[snapshot.id], snapshot);
  const entrySceneFilePath = path.join(projectRoot, 'Scenes', 'recovery.scene.json');
  await writeFile(entrySceneFilePath, serializer.serializeScene(mixedResult.scene));
  const source = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot, entrySceneFilePath,
    outputRoot: path.join(root, 'output'), signal,
    manifest: { projectId: '1', projectName: '恢复回归', editorProjectId: null, baseVersionId: null, resourceRevision: '0' },
    isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
  });
  assert.deepEqual(source.omittedResources, []);
  const sourceZip = await unzipper.Open.file(source.filePath);
  const sourceScene = JSON.parse((await sourceZip.files.find(file => file.path === source.entryScenePath).buffer()).toString());
  assert.ok(sourceScene.scene.entities[model.id].components.modelAsset);
  assert.ok(sourceZip.files.some(file => file.path.endsWith('/model.glb')), 'SOURCE 必须包含实际下载模型');
  assert.ok(sourceZip.files.some(file => file.path.endsWith('/skybox.hdr')), 'SOURCE 必须包含外部天空盒的完整受管副本');
  const dist = await buildDigitalTwinDistPackage({ projectId: '1', publishName: '恢复回归', sceneContent: source.entrySceneContent,
    sourceResourceFiles: source.resourceFiles, outputRoot: path.join(root, 'output'), signal,
  });
  const distZip = await unzipper.Open.file(dist.filePath);
  const published = serializer.deserializeScene((await distZip.files.find(file => file.path === 'project/scene.json').buffer()).toString());
  const publishedSkybox = published.sceneSettings.skybox ?? Object.values(published.entities).find(entity => entity.components.skybox)?.components.skybox;
  assert.equal(publishedSkybox?.intensity, 0.75);
  assert.ok(distZip.files.some(file => file.path.endsWith('.hdr')), 'Viewer 包必须包含恢复后的天空盒');
  const emitted = [], screens = [], focused = [], selected = [];
  const handler = createViewerModelClickHandler(published, {
    updateSelection: ids => selected.push(ids), setSlotHighlight: () => {}, focusTarget: id => focused.push(id),
    triggerManualEvents: () => {}, emitAssetClicked: payload => emitted.push(payload), showScreen: screen => screens.push(screen),
  });
  handler(model.id);
  const cell = { row: 1, column: 2, layer: 3 };
  handler(locator.id, { locatorEntityId: locator.id, ...cell });
  assert.deepEqual(emitted, [{ assetCode: 'DDJ2', chartId: 'chart-1' }, { assetCode: 'DDJ2', chartId: 'chart-1', slot: cell }]);
  assert.equal(screens.length, 2); assert.equal(focused.length, 2); assert.ok(selected.length > 0);
  assert.equal(dist.warnings.some(warning => warning.includes('清空该槽位')), false);
  console.log('PASS: 定向 HTTP 下载 → 编辑场景补入模型 → SOURCE/DIST ZIP → Viewer 重载后模型/货格点击、高亮、聚焦、资产编号和大屏事件。');
}

async function finish(code) {
  if (bridgeWindow && !bridgeWindow.isDestroyed()) bridgeWindow.destroy();
  ipcMain.removeHandler('digital-twin-publish:recoverModels');
  if (server) await new Promise(resolve => server.close(resolve));
  if (path.dirname(moduleRoot) !== path.resolve('node_modules') || !path.basename(moduleRoot).startsWith('.recovery-integration-')) throw new Error('模块目录范围无效');
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('zending-model-recovery-')) throw new Error('临时目录范围无效');
  await rm(moduleRoot, { recursive: true, force: true });
  app.exit(code);
}
app.whenReady().then(run).then(() => finish(0), async error => { console.error(error); await finish(1); });
