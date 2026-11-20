import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rename, writeFile, rm } from 'node:fs/promises';
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

function glb() {
  const positions = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]);
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 2, 0] }],
    materials: [{ name: 'paint', doubleSided: true, emissiveFactor: [1, 0, 0],
      pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0 } }],
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
    ...(version === 1 ? [{ key: 'obsolete', label: '旧参数', type: 'number', defaultValue: 13 }] : []),
    ...(version > 1 ? [{ key: 'speed', label: '速度', type: 'number', defaultValue: 5 }] : [])],
  bindings: [{ target: { kind: 'node', name: 'Body' }, property: 'scaling', value: { vector3: [{ param: 'width' }, 1, 1] } }] });

async function run() {
  service = await import('../../dist-electron/ipc/dataPlatformProjectService.js');
  const bindings = await import('../../dist-electron/ipc/dataPlatformBindingStore.js');
  const assets = await import('../../dist-electron/ipc/projectAssetStore.js');
  const { encodeAssetUrl, authorizeAssetFile, isAuthorizedAssetFile, decodeAssetUrl } = await import('../../dist-electron/ipc/assetRegistry.js');
  const { resolveEditorAssetImageContentType } = await import('../../dist-electron/ipc/editorAssetCacheHeaders.js');
  protocol.handle('editor-asset', async request => {
    const filePath = decodeAssetUrl(request.url);
    if (!isAuthorizedAssetFile(filePath)) return new Response('Forbidden', { status: 403 });
    const contentType = resolveEditorAssetImageContentType(filePath);
    return new Response(await readFile(filePath), {
      headers: { 'Access-Control-Allow-Origin': '*', ...(contentType ? { 'Content-Type': contentType } : {}) },
    });
  });
  const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
  const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
  await build({ configFile: false, publicDir: false, logLevel: 'warn', build: { ssr: true, outDir: moduleRoot,
    rollupOptions: { input: { apply: 'src/editor/assets/applySceneModelUpdates.ts', document: 'src/editor/model/SceneDocument.ts',
      serializer: 'src/editor/project/SceneSerializer.ts', click: 'src/player/viewerModelClick.ts',
      transaction: 'src/editor/assets/sceneModelSyncTransaction.ts' }, output: { entryFileNames: '[name].mjs' } } } });
  const [{ applySceneModelUpdates }, document, serializer, { createViewerModelClickHandler }, { runSceneModelSyncTransaction }] = await Promise.all(
    ['apply', 'document', 'serializer', 'click', 'transaction'].map(name => import(pathToFileURL(path.join(moduleRoot, name + '.mjs')).href)));
  let metadataVersion = 1, scriptVersion = 1, downloads = 0;
  let extraCatalogRecords = [], detailName, includeCombo = false;
  const requests = [], detailIds = [], distFiles = new Map();
  const geometry = glb();
  const thumbnail = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const thumbnailRoute = '/api/v1/files/model-cover';
  const environmentRecord = {
    id: '125', modelName: '环境模型', fileStatus: 'GLB_READY', fileName: 'environment.glb',
    fileSizeBytes: String(geometry.length), fileSha256: createHash('sha256').update(geometry).digest('hex'),
    fileRevision: '1', runtimeRevision: '1', lengthUnit: 'meter', downloadUrl: '/files/model.glb',
    updatedAt: '2026-11-19T12:00:00',
  };
  const script = version => `export default class RuntimeComponent {
    constructor(private node: import('@babylonjs/core').TransformNode) {}
    onStart() {
      for (const mesh of this.node.getChildMeshes()) {
        const material = mesh.material;
        material?.emissiveColor?.set(${version === 1 ? '1, 0, 0' : '0, 1, 0'});
        material?.albedoColor?.set(${version === 1 ? '1, 0, 0' : '0, 1, 0'});
      }
    }
  }`;
  const modelRecord = () => ({ id: '123', modelName: 'fixture', fileName: 'model.glb', fileUrl: '/files/model.glb',
    thumbnailUrl: thumbnailRoute, updatedAt: '2026-11-19T12:00:00',
    metaFileUrl: `/files/v${metadataVersion}.json`, currentVersionId: `90071992547409${metadataVersion}${scriptVersion}`,
    scriptFiles: [{ fileName: 'z-fixture.ts', fileUrl: `/files/v${scriptVersion}.ts` },
      { fileName: 'a-hook.model.ts', fileUrl: '/files/hook.ts' }] });
  server = createServer(async (request, response) => {
    const route = new URL(request.url, 'http://test').pathname;
    requests.push(route);
    response.setHeader('Connection', 'close');
    if (route === '/editor') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>同步桥接验证</title>');
      return;
    }
    if (route === '/api/v1/digital-twin/runtime-config/detail') {
      request.resume(); response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, data: { projectId: '11', runtimeEnabled: true, configJson: '{}' } })); return;
    }
    if (route === '/api/v1/env-models/sync-manifest/query') {
      request.resume(); response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, data: { protocolVersion: '1', manifestRevision: '1',
        nextCursorId: null, hasMore: false, records: [environmentRecord] } }));
      return;
    }
    if (route === '/api/v1/models/detail') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const { id } = JSON.parse(raw);
      response.setHeader('Content-Type', 'application/json');
      detailIds.push(id);
      const current = modelRecord();
      const older = { versionId: '1', versionNumber: 1, fileName: 'old.glb', fileUrl: '/history/old.glb',
        metaFileUrl: '/history/old.json', scriptFiles: [{ fileName: 'old.ts', fileUrl: '/history/old.ts' }] };
      const latest = { versionId: current.currentVersionId, versionNumber: 10 * metadataVersion + scriptVersion,
        fileName: current.fileName, fileUrl: current.fileUrl, metaFileUrl: current.metaFileUrl,
        scriptFiles: current.scriptFiles };
      // 模型主记录可能仍指向旧文件，目录和 currentVersionId 指向同一份最新版快照。
      const data = { ...current, fileUrl: older.fileUrl, metaFileUrl: older.metaFileUrl, scriptFiles: older.scriptFiles,
        modelName: detailName ?? 'fixture', versions: [latest, older] };
      response.end(JSON.stringify(id === '123' ? { success: true, data }
        : { success: false, code: 'MODEL_NOT_FOUND', message: '模型不存在' }));
      return;
    }
    if (route.endsWith('/query')) {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const { pageNum, pageSize } = JSON.parse(raw);
      const records = route === '/api/v1/models/query' ? [modelRecord(), ...extraCatalogRecords]
        : route === '/api/v1/env-models/query' ? [{ ...environmentRecord, thumbnailUrl: thumbnailRoute }]
        : route === '/api/v1/combo-models/query' && includeCombo ? [{ id: '124', comboModelName: '组合模型',
          fileName: 'model.glb', fileUrl: '/files/model.glb', thumbnailUrl: thumbnailRoute,
          updatedAt: '2026-11-19T12:00:00' }] : [];
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, data: { records, pageNum, pageSize, total: records.length } }));
      return;
    }
    if (route === thumbnailRoute) {
      downloads++;
      response.setHeader('Content-Type', 'image/gif');
      response.end(thumbnail);
      return;
    }
    if (route === '/files/model.glb' || route === '/files/hook.ts' || /^\/files\/v\d\.(json|ts)$/.test(route)) {
      downloads++;
      const version = Number(/v(\d)/.exec(route)?.[1]);
      if (route.endsWith('.glb')) {
        response.setHeader('Content-Type', 'model/gltf-binary');
        response.end(geometry);
      } else if (route.endsWith('.ts')) {
        response.setHeader('Content-Type', 'text/plain');
        response.end(route.endsWith('/hook.ts') ? 'export class FixtureHelper {}' : script(version));
      } else {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ lengthUnit: 'meter', modelParameters: config(version) }));
      }
      return;
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
  const { executeDataPlatformModelSync } = await import('../../dist-electron/ipc/dataPlatformModelIncrementalSync.js');
  const { getPinnedModelScriptOrderPath } = await import('../../dist-electron/ipc/dataPlatformModelIndex.js');
  await executeDataPlatformModelSync({ baseUrl, editorRoot: sharedResourcesRoot });
  requests.length = 0;
  const oldPath = path.join(projectRoot, 'Assets', 'Models', 'Model-123-fixture', 'model.glb');
  await mkdir(path.dirname(oldPath), { recursive: true }); await writeFile(oldPath, geometry); authorizeAssetFile(oldPath);
  const scene = document.createEmptySceneDocument('最新模型参数保留');
  scene.sceneSettings.lighting.bake.enabled = false;
  scene.sceneSettings.camera.savedPose = { alpha: -Math.PI / 2, beta: Math.PI / 2, radius: 15,
    target: { x: 2.5, y: 1, z: 0 } };
  const models = [1, 2].map((width, index) => {
    const model = document.createModelEntity(oldPath, encodeAssetUrl(oldPath), '设备 ' + index);
    Object.assign(model.components.modelAsset, { assetCode: 'DEVICE-' + index, parameterConfig: config(1),
      parameterValues: { width, enabled: false, label: '', obsolete: 77 } });
    model.components.transform.position.x = index * 5;
    scene.entityIds.push(model.id); scene.entities[model.id] = model; return model;
  });
  const click = document.createClickEventBindingEntity();
  click.components.clickEventBinding.deviceSlots = [{ id: 'slot', deviceType: { id: 'type', assetId: 'old', displayName: 'fixture', sourcePath: oldPath, sourceUrl: encodeAssetUrl(oldPath) } }];
  click.components.clickEventBinding.events = [{ id: 'click', eventType: 'click', effects: ['highlight', 'focus', 'show-chart'],
    chart: { id: 'chart-1', name: '设备大屏', projectId: '11', screenId: 'screen-1' } }];
  scene.entityIds.push(click.id); scene.entities[click.id] = click;
  ipcMain.handle('data-platform:prepareLocalSceneResources', (_event, request) => service.prepareLocalSceneResources(baseUrl, workspaceRoot, request));
  ipcMain.handle('project:listAssets', () => assets.listProjectAssets());
  const editorUrl = baseUrl + '/editor';
  bridge = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve('dist-electron/preload.cjs'),
    contextIsolation: true, sandbox: true, additionalArguments: [`--editor-entry-url=${encodeURIComponent(editorUrl)}`] } });
  await bridge.loadURL(editorUrl);
  assert.equal(await bridge.webContents.executeJavaScript('typeof window.editorApi?.prepareLocalSceneResources'), 'function');
  const prepare = async (document, mode = 'data-platform-latest', options = {}) => bridge.webContents.executeJavaScript(`window.editorApi.prepareLocalSceneResources(${JSON.stringify({ ...options, mode, sceneContent: serializer.serializeScene(document) })})`);
  const first = await prepare(scene);
  assert.deepEqual(first.issues, [], '中台最新版模型、meta、TS 和当前缩略图均可用');
  const firstScene = applySceneModelUpdates(scene, first.modelReplacements, first.sourceKey).scene;
  const firstPath = first.modelAssets[0].path;
  const listLibrary = () => bridge.webContents.executeJavaScript('window.editorApi.listProjectAssets()');
  const [firstCard] = (await listLibrary()).assets;
  assert.equal(firstCard.assetRevision, first.modelAssets[0].assetRevision);
  async function verifyThumbnail(asset) {
    assert.equal(path.extname(asset.thumbnailPath), '.gif');
    assert.deepEqual(await readFile(asset.thumbnailPath), thumbnail);
    assert.match(asset.thumbnailRevision, /^[a-f0-9]{64}$/);
    const thumbnailUrl = new URL(asset.thumbnailUrl);
    thumbnailUrl.searchParams.set('v', asset.thumbnailRevision);
    const width = await bridge.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(thumbnailUrl.href)};
      await image.decode();
      return image.naturalWidth;
    })()`);
    assert.equal(width, 1, '编辑器应能从本地资产协议解码缩略图');
  }
  await verifyThumbnail(firstCard);
  metadataVersion = 2;
  let currentScene = firstScene;
  let result;
  const sync = () => runSceneModelSyncTransaction({ sceneSessionId: 'integration', syncLibrary: false,
    getSnapshot: () => ({ sceneSessionId: 'integration', scene: currentScene }),
    prepare: async document => { result = await prepare(document, 'scene-latest'); return result; },
    apply: async (document, resources) => ({ ...applySceneModelUpdates(document, resources.modelReplacements, resources.sourceKey), issues: [] }),
    commit: (before, after) => { assert.equal(before, currentScene); currentScene = after; return true; },
  });
  const transaction = await sync();
  assert.ok(transaction.updatedCount >= models.length);
  assert.ok(transaction.warnings.some(warning => /删除 1 项/.test(warning)), '删除参数只记录日志，不阻断模型替换');
  const metadataAsset = result.modelAssets[0];
  assert.notEqual(metadataAsset.assetRevision, first.modelAssets[0].assetRevision, '仅 meta 变化也必须生成新版本');
  assert.deepEqual(await readFile(metadataAsset.path), geometry);
  const [metadataCard] = (await listLibrary()).assets;
  assert.equal(metadataCard.assetRevision, metadataAsset.assetRevision, '定向下载完成即刷新同一模型卡片的修订');
  assert.deepEqual(metadataCard.parameterConfig, config(2));
  scriptVersion = 2;
  await sync();
  assert.equal(result.modelAssets.length, 1);
  const scriptAsset = result.modelAssets[0];
  assert.notEqual(scriptAsset.assetRevision, metadataAsset.assetRevision, '仅 TS 变化也必须生成新版本');
  assert.deepEqual(await readFile(scriptAsset.metadataPath), await readFile(metadataAsset.metadataPath));
  assert.deepEqual(await readFile(scriptAsset.path), geometry);
  assert.deepEqual(await readFile(firstPath), geometry, '同步新版仍保留上一版本的固定包');
  assert.equal(await readFile(first.modelAssets[0].scriptAssets[0].path, 'utf8'), script(1));
  const fetchedBytes = await bridge.webContents.executeJavaScript(`fetch(${JSON.stringify(scriptAsset.sourceUrl)}).then(async response => { if (!response.ok) throw new Error('模型协议读取失败 ' + response.status); return (await response.arrayBuffer()).byteLength; })`);
  assert.equal(fetchedBytes, geometry.length, '实际 editor-asset 协议必须允许读取固定模型文件');
  assert.equal((await listLibrary()).assets[0].assetRevision, scriptAsset.assetRevision);
  const updated = currentScene;
  for (let i = 0; i < models.length; i++) {
    const current = updated.entities[models[i].id];
    assert.deepEqual(current.components.modelAsset.parameterValues, { width: i + 1, enabled: false, label: '', speed: 5 });
    assert.deepEqual(current.components.transform, models[i].components.transform);
    assert.equal(current.components.modelAsset.assetCode, 'DEVICE-' + i);
    assert.deepEqual(JSON.parse(JSON.stringify(current.components.modelAsset.parameterConfig)), config(2),
      '参数定义和默认值采用新版，实例已保存值仍独立保留');
    assert.equal(Object.hasOwn(current.components.modelAsset.parameterValues, 'obsolete'), false);
  }
  const beforeRepeat = downloads;
  const localLatest = await prepare(firstScene, 'local-latest');
  const localUpdated = applySceneModelUpdates(firstScene, localLatest.modelReplacements, localLatest.sourceKey).scene;
  assert.equal(localUpdated.entities[models[0].id].components.modelAsset.sourceUrl, result.modelAssets[0].sourceUrl,
    '打开本地旧场景也必须应用中台当前模型');
  assert.deepEqual(localUpdated.entities[models[1].id].components.modelAsset.parameterValues, { width: 2, enabled: false, label: '', speed: 5 });
  const recovered = await prepare(localUpdated, 'local-recovery');
  assert.deepEqual(recovered.issues, [], '本地恢复必须校验中台声明顺序的全部 TS 脚本');
  const recoveredAsset = serializer.deserializeScene(recovered.recoveredSceneContent).entities[models[0].id].components.modelAsset;
  assert.deepEqual(recoveredAsset.scriptAssets.map(script => script.name), ['z-fixture.ts', 'a-hook.model.ts']);
  assert.equal(recoveredAsset.sourceUrl, scriptAsset.sourceUrl);
  const slotOnly = { ...updated, entityIds: [click.id], entities: { [click.id]: updated.entities[click.id] } };
  assert.deepEqual((await prepare(slotOnly, 'local-recovery')).issues, [], '轻量槽位无脚本列表时也能恢复固定版本');
  const orderFile = getPinnedModelScriptOrderPath(scriptAsset.packagePath);
  await rename(orderFile, orderFile + '.bak');
  try {
    assert.deepEqual((await prepare(updated, 'local-recovery')).issues, [], '旧固定包用场景保存的脚本顺序复算摘要');
  } finally {
    await rename(orderFile + '.bak', orderFile);
  }
  assert.deepEqual((await prepare(firstScene, 'local-recovery')).issues, [], '撤回到升级前的快照仍可恢复');
  const repeat = await prepare(updated);
  assert.equal(downloads, beforeRepeat, '相同资源版本再次打开无需下载');
  assert.equal(applySceneModelUpdates(updated, repeat.modelReplacements, repeat.sourceKey).scene, updated);
  assert.ok(!requests.some(route => route.endsWith('/query')), '稳定资源 ID 不需要查询全库目录');
  assert.ok(!requests.some(route => route.startsWith('/history/')), '同一模型只下载当前版的文件');

  const missingPath = path.join(projectRoot, 'Assets', 'Models', 'Model-123-fixture', 'unavailable.glb');
  const missing = document.createModelEntity(missingPath, encodeAssetUrl(missingPath), '待处理的旧引用');
  missing.components.modelAsset.assetRevision = 'f'.repeat(64);
  const unresolved = { ...scene, entityIds: [missing.id], entities: { [missing.id]: missing } };
  const requestsBeforeRecovery = requests.length;
  const dependencies = await prepare(unresolved, 'local-recovery', { skipModelDownloads: true });
  assert.ok(dependencies.issues.some(issue => issue.resourceKind === 'model' && issue.resourceId === '123'));
  assert.equal(requests.length, requestsBeforeRecovery, '依赖检查报告缺失的模型，不重新下载当前版或历史版');

  const historicalPackage = path.basename(path.dirname(firstPath)).replace('Model-123-', 'Model-999-');
  const historicalPath = path.join(projectRoot, 'Assets', 'Models', historicalPackage, 'model.glb');
  const historicalReference = { sourcePath: historicalPath, sourceUrl: encodeAssetUrl(historicalPath) };
  const historical = structuredClone(scene);
  for (const model of models) Object.assign(historical.entities[model.id].components.modelAsset, historicalReference);
  const historicalDevice = historical.entities[click.id].components.clickEventBinding.deviceSlots[0].deviceType;
  Object.assign(historicalDevice, historicalReference);
  const beforeMigration = detailIds.length;
  const migrated = await prepare(historical);
  assert.deepEqual(migrated.issues, []);
  assert.deepEqual(detailIds.slice(beforeMigration), ['999', '123', '123']);
  assert.equal(migrated.modelReplacements[0].asset.path, scriptAsset.path);
  const migratedScene = applySceneModelUpdates(historical, migrated.modelReplacements, migrated.sourceKey).scene;
  assert.equal(migratedScene.entities[models[0].id].components.modelAsset.dataPlatformModel.resourceId, '123');
  assert.equal(migratedScene.entities[click.id].components.clickEventBinding.deviceSlots[0].deviceType.sourceUrl, scriptAsset.sourceUrl);

  detailName = '详情名称已改';
  const inconsistent = await prepare(historical);
  assert.equal(inconsistent.modelReplacements.length, 0);
  assert.match(inconsistent.issues[0].message, /匹配到 0 个候选/);
  detailName = undefined;
  extraCatalogRecords = [{ ...modelRecord(), id: '124' }];
  const ambiguous = await prepare(historical);
  assert.equal(ambiguous.modelReplacements.length, 0);
  assert.match(ambiguous.issues[0].message, /匹配到 2 个候选/);
  extraCatalogRecords = [];
  const entrySceneFilePath = path.join(projectRoot, 'Scenes', 'updated.scene.json');
  await writeFile(entrySceneFilePath, serializer.serializeScene(updated));
  const saved = serializer.deserializeScene(await readFile(entrySceneFilePath, 'utf8'));
  assert.deepEqual(saved.entities[models[1].id].components.modelAsset.parameterValues, { width: 2, enabled: false, label: '', speed: 5 });
  assert.deepEqual(JSON.parse(JSON.stringify(saved.entities[models[1].id].components.modelAsset.parameterConfig)),
    JSON.parse(JSON.stringify(updated.entities[models[1].id].components.modelAsset.parameterConfig)), '保存重开保留完整可持久化配置');
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
  assert.deepEqual(published.entities[models[1].id].components.modelAsset.parameterConfig, saved.entities[models[1].id].components.modelAsset.parameterConfig);
  const events = [], screens = [];
  const handler = createViewerModelClickHandler(published, { updateSelection() {}, setSlotHighlight() {}, setHighlightExcludeTrack() {}, focusTarget() {}, triggerManualEvents() {},
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
  // 两实例同深度正面观察，实际渲染宽度应保持参数 1:2，不能只验证序列化值。
  const bitmap = screenshot.toBitmap(), { width, height } = screenshot.getSize();
  const spans = [];
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      if (bitmap[i + 1] > 100 && bitmap[i + 1] > bitmap[i] * 1.5 && bitmap[i + 1] > bitmap[i + 2] * 1.5) count++;
    }
    if (count < 6) continue;
    const span = spans.at(-1);
    if (span && x === span.end + 1) span.end = x;
    else spans.push({ start: x, end: x });
  }
  const modelWidths = spans.map(span => span.end - span.start + 1).filter(width => width > 15).sort((a, b) => a - b);
  assert.equal(modelWidths.length, 2, `应实际显示两个独立模型，像素宽度 ${modelWidths}`);
  const widthRatio = modelWidths[1] / modelWidths[0];
  assert.ok(widthRatio > 1.8 && widthRatio < 2.2, `原参数应作用于实际模型几何，宽度比例 ${widthRatio}`);
  assert.deepEqual(browserErrors, []);

  bindings.clearCurrentDataPlatformBinding();
  assets.clearProjectAssetStoreSession();
  assert.deepEqual((await listLibrary()).assets, [], '关闭会话后卸载定向模型库');
  await prepare(scene, 'local-latest');
  const rootlessLibrary = await listLibrary();
  assert.equal(rootlessLibrary.projectRoot, null);
  assert.deepEqual(rootlessLibrary.assets.map(asset => asset.assetRevision), [scriptAsset.assetRevision]);
  assets.setSharedProjectAssetRoot(sharedResourcesRoot, 'a'.repeat(64));
  assert.equal((await listLibrary()).assets[0].assetRevision, first.modelAssets[0].assetRevision,
    '同一共享目录切换中台后，不显示旧来源的定向版本');
  await prepare(scene, 'local-latest');
  includeCombo = true;
  await executeDataPlatformModelSync({ baseUrl, editorRoot: sharedResourcesRoot });
  const { executeDataPlatformEnvironmentSync } = await import('../../dist-electron/ipc/dataPlatformEnvironmentSync.js');
  await executeDataPlatformEnvironmentSync({ baseUrl, editorRoot: sharedResourcesRoot,
    contextKey: service.createDataPlatformEnvironmentSyncContextKey(baseUrl, sharedResourcesRoot) });
  const { assets: libraryAssets } = await listLibrary();
  const libraryAsset = libraryAssets.find(asset => asset.displayName === 'fixture');
  const comboAsset = libraryAssets.find(asset => asset.displayName === '组合模型');
  assert.equal(libraryAsset.assetRevision, scriptAsset.assetRevision);
  assert.equal(libraryAsset.path, path.join(sharedResourcesRoot, 'Assets', 'Models', 'Model-123-fixture', 'model.glb'),
    '全库成功后使用已提交的共享索引');
  await verifyThumbnail(libraryAsset);
  await verifyThumbnail(comboAsset);
  await verifyThumbnail(libraryAssets.find(asset => asset.displayName === '环境模型'));
  await writeFile(path.join(artifactRoot, 'result.json'), JSON.stringify({ passed: true, models: models.length, greenPixels,
    parameterValues: models.map(model => saved.entities[model.id].components.modelAsset.parameterValues),
    parameterDefaults: Object.fromEntries(saved.entities[models[0].id].components.modelAsset.parameterConfig.parameters.map(parameter => [parameter.key, parameter.defaultValue])),
    downloads, modelWidths, widthRatio, sourceFiles: source.resourceFiles.length, checks: ['actual-preload', 'explicit-scene-transaction', 'targeted-http', 'immutable-old-version', 'zero-download-repeat',
      'library-revisions', 'rootless-library', 'script-only-update', 'fixed-package-recovery', 'legacy-source-id', 'local-thumbnail-decode',
      'instance-parameters', 'latest-parameter-config', 'removed-parameter-pruned', 'new-parameter-default', 'save-reopen', 'source-dist', 'viewer-click', 'real-viewer-webgl', 'rendered-parameter-width-ratio'] }, null, 2));
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
