import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';

const root = process.env.ZENDING_LOCAL_SCENE_RESOURCES_TEST_ROOT;
assert.ok(root && path.dirname(path.resolve(root)) === path.resolve(os.tmpdir())
  && path.basename(root).startsWith('local-scene-resources-'), '请通过 localSceneResources.runner.mjs 运行此测试。');
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));
app.disableHardwareAcceleration();

function createGlb(marker) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }], extras: { marker } }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 }));
  const jsonSize = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonSize + 36);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonSize, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + jsonSize); json.copy(bytes, 20);
  bytes.writeUInt32LE(36, 20 + jsonSize); bytes.writeUInt32LE(0x004e4942, 24 + jsonSize);
  Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).copy(bytes, 28 + jsonSize);
  return bytes;
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function run() {
  const service = await import('../../dist-electron/ipc/dataPlatformProjectService.js');
  const environments = await import('../../dist-electron/ipc/dataPlatformEnvironmentSync.js');
  const environmentIndex = await import('../../dist-electron/ipc/dataPlatformEnvironmentIndex.js');
  const models = await import('../../dist-electron/ipc/dataPlatformModelIncrementalSync.js');
  const assets = await import('../../dist-electron/ipc/projectAssetStore.js');
  const bindings = await import('../../dist-electron/ipc/dataPlatformBindingStore.js');
  assert.equal(typeof service.prepareLocalSceneResources, 'function', '请先编译最新主进程实现。');
  const modelBytes = createGlb(10);
  const comboBytes = createGlb(20);
  let mode = 'stable';
  let slowDownloadStarted = false;
  const requests = [];
  const downloads = [];
  const servedFiles = new Map();
  const makeEnvironment = (id, displayName, revision) => {
    const bytes = createGlb(Number(revision));
    const downloadUrl = `/api/v1/env-models/${id}/file?fileRevision=${revision}`;
    servedFiles.set(downloadUrl, bytes);
    return { id, modelName: displayName, fileStatus: 'GLB_READY', fileName: 'model.glb',
      fileSizeBytes: String(bytes.length), fileSha256: hash(bytes), fileRevision: revision, runtimeRevision: revision,
      lengthUnit: 'meter', downloadUrl, updatedAt: '2026-09-08T00:00:00.000Z' };
  };
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader('Connection', 'close');
    const requestUrl = request.url ?? '';
    requests.push(requestUrl);
    const json = data => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, data }));
    };
    if (requestUrl.includes('sync-manifest')) {
      let records;
      if (requestUrl.startsWith('/old/')) records = [makeEnvironment('101', '旧来源园区', '1')];
      else if (mode === 'stable') records = [makeEnvironment('101', 'Campus', '2'), makeEnvironment('202', '无需下载环境', '2')];
      else if (mode === 'ambiguous') records = [makeEnvironment('901', 'Campus', '3'), makeEnvironment('902', ' campus.glb ', '3')];
      else records = [makeEnvironment('901', 'Campus', mode === 'corrupt' ? '4' : mode === 'slow' ? '5' : '3'),
        makeEnvironment('202', '无需下载环境', '2')];
      json({ protocolVersion: '1', manifestRevision: '1', nextCursorId: null, hasMore: false, records });
      return;
    }
    if (requestUrl.endsWith('/api/v1/models/query') || requestUrl.endsWith('/api/v1/combo-models/query')) {
      const records = requestUrl.includes('combo-models')
        ? [{ id: '301', comboModelName: '当前组合模型', fileName: 'combo.glb', fileUrl: '/files/combo.glb', revision: '1' }]
        : [{ id: '301', modelName: '当前普通模型', fileName: 'model.glb', fileUrl: '/files/model.glb',
          metaFileUrl: '/files/model.meta.json', revision: '1' }];
      json({ records, total: records.length, pageNum: 1, pageSize: 100 });
      return;
    }
    let bytes = servedFiles.get(requestUrl);
    if (requestUrl === '/files/model.glb') bytes = modelBytes;
    if (requestUrl === '/files/combo.glb') bytes = comboBytes;
    if (requestUrl === '/files/model.meta.json') bytes = Buffer.from('{"lengthUnit":"meter"}');
    if (!bytes) { response.writeHead(404); response.end(); return; }
    downloads.push({ mode, url: requestUrl });
    const isEnvironment = requestUrl.startsWith('/api/v1/env-models/');
    if (isEnvironment && mode === 'corrupt') {
      bytes = Buffer.from(bytes);
      bytes[bytes.length - 1] ^= 0xff;
    }
    response.writeHead(200, { 'Content-Type': requestUrl.endsWith('.json') ? 'application/json' : 'model/gltf-binary',
      'Content-Length': String(bytes.length), ETag: '"fixture"' });
    if (isEnvironment && mode === 'slow') {
      slowDownloadStarted = true;
      response.write(bytes.subarray(0, 24));
      return;
    }
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const baseUrl = `${origin}/current`;
  const oldBaseUrl = `${origin}/old`;
  const sourceKey = environments.createDataPlatformSourceKey(baseUrl);
  const oldSourceKey = environments.createDataPlatformSourceKey(oldBaseUrl);
  const workspaceRoot = path.join(root, 'workspace');
  const sharedRoot = path.join(workspaceRoot, 'SharedResources');
  const projectRoot = path.join(workspaceRoot, 'Projects', '11');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(sharedRoot, { recursive: true });
  const checks = [];

  try {
    await environments.executeDataPlatformEnvironmentSync({ baseUrl: oldBaseUrl, editorRoot: sharedRoot,
      contextKey: 'fixture:old-source', requiredResourceIds: ['101'] });
    assert.equal((await environmentIndex.readDataPlatformEnvironmentIndex(sharedRoot)).sourceKey, oldSourceKey);
    bindings.setCurrentDataPlatformBinding(projectRoot, bindings.createDataPlatformBinding({
      baseUrl: oldBaseUrl, webBaseUrl: oldBaseUrl, workspaceRoot, projectId: '11', projectName: '本地场景测试',
      editorProjectId: null, latestVersionId: null, latestVersionNumber: null, resourceRevision: '1',
      entryScenePath: null, syncedAt: '2026-09-08T00:00:00.000Z',
    }));
    const unrelatedPackage = path.join(sharedRoot, 'Assets', 'Models', 'UserImported');
    const unrelatedPath = path.join(unrelatedPackage, 'local.glb');
    await mkdir(unrelatedPackage, { recursive: true });
    await writeFile(unrelatedPath, createGlb(30));
    await assets.writeProjectAssetIndex(sharedRoot, { version: 2, assets: [{ id: unrelatedPath, name: '仅本地模型',
      kind: 'model', libraryKind: 'model', path: unrelatedPath, packagePath: unrelatedPackage,
      sourceUrl: `editor-asset://local/${encodeURIComponent(unrelatedPath)}` }] });

    const oldReference = { resourceId: '101', displayName: '旧来源园区' };
    const first = await service.prepareLocalSceneResources(baseUrl, workspaceRoot, { environment: oldReference });
    assert.equal(first.configured, true);
    assert.equal(first.sourceKey, sourceKey);
    assert.equal(first.environmentAssets.length, 1);
    assert.equal(first.environmentAssets[0].dataPlatformResourceId, '101');
    assert.equal(first.environmentAssets[0].dataPlatformSourceKey, sourceKey);
    assert.equal(first.environmentAssets[0].dataPlatformFileRevision, '2');
    assert.deepEqual(await readFile(first.environmentAssets[0].path), createGlb(2));
    assert.deepEqual(first.modelAssets.map(asset => path.basename(asset.packagePath).split('-').slice(0, 2).join('-')).sort(), ['Combo-301', 'Model-301']);
    assert.ok(first.modelAssets.every(asset => asset.path !== unrelatedPath && asset.assetRevision));
    for (const asset of first.modelAssets) {
      assert.deepEqual(await readFile(asset.path), path.basename(asset.packagePath).startsWith('Combo-') ? comboBytes : modelBytes);
    }
    assert.ok((await assets.readProjectAssetIndex(sharedRoot)).assets.some(asset => asset.path === unrelatedPath), '仅本地资产保留但不进入权威候选');
    assert.equal(bindings.getCurrentDataPlatformBinding().metadata.baseUrl, oldBaseUrl, '本地同步不改写发布绑定');
    assert.ok(!downloads.some(item => item.url.includes('/202/')), '只下载当前场景匹配的环境');
    checks.push('current-source-and-latest-revision', 'normal-and-combo-authority', 'unmatched-local-preserved', 'targeted-environment-download');

    const downloadCount = downloads.length;
    const cached = await service.prepareLocalSceneResources(baseUrl, workspaceRoot, { environment: oldReference });
    assert.equal(downloads.length, downloadCount, '缓存复用时不应重复下载');
    assert.deepEqual(cached.modelAssets.map(asset => asset.path), first.modelAssets.map(asset => asset.path));
    assert.deepEqual(cached.environmentAssets.map(asset => asset.path), first.environmentAssets.map(asset => asset.path));
    assert.equal(models.getLatestDataPlatformModelSyncProgress().libraryChanged, false);
    assert.equal(cached.modelAssets.length, 2, '无库变更也必须返回全部权威候选');
    checks.push('cache-reuse-still-returns-all-candidates');

    mode = 'migrated';
    const migrated = await service.prepareLocalSceneResources(baseUrl, workspaceRoot, { environment: { resourceId: '101', displayName: ' CAMPUS.glb ' } });
    assert.equal(migrated.environmentAssets.length, 1,
      `迁移后的权威环境候选必须仅含901：${JSON.stringify(migrated.environmentAssets.map(asset => ({ id: asset.dataPlatformResourceId, revision: asset.dataPlatformFileRevision })))}`);
    assert.equal(migrated.environmentAssets[0].dataPlatformResourceId, '901');
    assert.equal(migrated.environmentAssets[0].dataPlatformFileRevision, '3');
    assert.deepEqual(await readFile(migrated.environmentAssets[0].path), createGlb(3));
    assert.ok(!downloads.some(item => item.url.includes('/202/')));
    checks.push('different-id-unique-name');

    mode = 'ambiguous';
    const beforeAmbiguous = downloads.length;
    await assert.rejects(service.prepareLocalSceneResources(baseUrl, workspaceRoot, { environment: { displayName: 'Campus' } }), /环境模型.*名称.*歧义/);
    assert.equal(downloads.length, beforeAmbiguous, '名称歧义不能下载任意候选');
    checks.push('ambiguous-name-rejected');

    mode = 'corrupt';
    await assert.rejects(service.prepareLocalSceneResources(baseUrl, workspaceRoot, { environment: { resourceId: '901' } }), /环境模型.*(?:SHA|摘要|校验|哈希)/i);
    assert.deepEqual(await readFile(migrated.environmentAssets[0].path), createGlb(3), '新下载失败不能破坏旧缓存');
    checks.push('invalid-download-rejected-old-cache-preserved');

    mode = 'slow';
    const preparing = service.prepareLocalSceneResources(baseUrl, workspaceRoot, { environment: { resourceId: '901' } });
    const rejected = assert.rejects(preparing, /abort|取消/i);
    const deadline = Date.now() + 10000;
    while (!slowDownloadStarted) {
      assert.ok(Date.now() < deadline, '等待环境下载开始超时');
      await delay(10);
    }
    assert.equal(service.cancelDataPlatformProjectLoading(), true);
    await rejected;
    checks.push('cancel-preparation-rejects');

    mode = 'migrated';
    bindings.clearCurrentDataPlatformBinding();
    const unboundWorkspace = path.join(root, 'unbound-workspace');
    const unbound = await service.prepareLocalSceneResources(baseUrl, unboundWorkspace, { environment: { resourceId: '901' } });
    const canonicalShared = path.join(unboundWorkspace, 'SharedResources') + path.sep;
    assert.equal(unbound.modelAssets.length, 2);
    assert.equal(unbound.environmentAssets.length, 1);
    for (const asset of [...unbound.modelAssets, ...unbound.environmentAssets]) {
      assert.ok(asset.path.startsWith(canonicalShared), '未绑定场景的模型和环境必须同步到发布认可的 SharedResources');
    }
    assert.equal(assets.getCurrentProjectRoot(), unboundWorkspace, '共享缓存和本地项目根目录分离');
    checks.push('unbound-scene-uses-publishable-shared-cache');
    await service.syncDataPlatformImagesForWorkspace(baseUrl, unboundWorkspace);
    const afterImages = await assets.listProjectAssets();
    for (const model of unbound.modelAssets) assert.ok(afterImages.assets.some(asset => asset.path === model.path),
      '同步图片不能卸载已同步的共享模型库');
    checks.push('image-sync-preserves-shared-model-mount');
    console.log(JSON.stringify({ status: 'PASS', checks, requests: requests.length, downloads: downloads.length, localHttpOnly: true }));
  } finally {
    service.cancelDataPlatformProjectLoading();
    server.closeAllConnections();
    await service.disposeDataPlatformProjectTasks();
    bindings.clearCurrentDataPlatformBinding();
    await new Promise(resolve => server.close(resolve));
  }
}

app.whenReady().then(run).then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
