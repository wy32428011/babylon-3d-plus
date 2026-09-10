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
  let failLibraryQuery = false;
  let slowDownloadStarted = false;
  let activeParallelDownloads = 0;
  let maxParallelDownloads = 0;
  let holdParallelDownloads = true;
  const pendingParallelDownloads = [];
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
    if ((request.url ?? '').endsWith('/api/v1/models/detail')) {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const id = JSON.parse(body).id;
        const parallelModel = mode === 'parallel' && /^41[0-4]$/.test(id);
        if (id !== '301' && !parallelModel) { response.writeHead(404); response.end('model not found'); return; }
        response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        response.end(JSON.stringify({ success: true, data: { id, modelName: '当前普通模型', fileName: 'model.glb',
          fileUrl: parallelModel ? `/files/model-${id}.glb` : '/files/model.glb',
          ...(parallelModel ? {} : { metaFileUrl: '/files/model.meta.json' }), revision: '1' } }));
      });
      return;
    }
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
      else records = [makeEnvironment('901', 'Campus', mode === 'corrupt' ? '4' : mode === 'slow' ? '5' : mode === 'parallel' ? '6' : '3'),
        makeEnvironment('202', '无需下载环境', '2')];
      json({ protocolVersion: '1', manifestRevision: '1', nextCursorId: null, hasMore: false, records });
      return;
    }
    if (requestUrl.endsWith('/api/v1/models/query') || requestUrl.endsWith('/api/v1/combo-models/query')) {
      if (failLibraryQuery) { response.writeHead(500); response.end('fixture library query failure'); return; }
      const records = requestUrl.includes('combo-models')
        ? [{ id: '301', comboModelName: '当前组合模型', fileName: 'combo.glb', fileUrl: '/files/combo.glb', revision: '1' }]
        : [{ id: '301', modelName: '当前普通模型', fileName: 'model.glb', fileUrl: '/files/model.glb',
          metaFileUrl: '/files/model.meta.json', revision: '1' }];
      json({ records, total: records.length, pageNum: 1, pageSize: 100 });
      return;
    }
    let bytes = servedFiles.get(requestUrl);
    if (requestUrl === '/files/model.glb') bytes = modelBytes;
    if (/^\/files\/model-41[0-4]\.glb$/.test(requestUrl)) bytes = modelBytes;
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
    if (mode === 'parallel' && holdParallelDownloads && /^\/files\/model-41[0-3]\.glb$/.test(requestUrl)) {
      activeParallelDownloads += 1;
      maxParallelDownloads = Math.max(maxParallelDownloads, activeParallelDownloads);
      pendingParallelDownloads.push(() => { activeParallelDownloads -= 1; response.end(bytes); });
      response.flushHeaders();
      return;
    }
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

    const localLatest = await service.prepareLocalSceneResources(baseUrl, workspaceRoot, { mode: 'local-latest',
      sceneContent: JSON.stringify({ version: 5, scene: { entities: {}, sceneSettings: { environment: {
        source: 'data-platform', dataPlatformResourceId: '101', dataPlatformSourceKey: first.sourceKey,
        dataPlatformRevision: '0',
      } } } }) });
    assert.equal(localLatest.environmentAssets.length, 1, '本地打开也应同步当前中台环境');
    assert.equal(localLatest.environmentAssets[0].dataPlatformResourceId, '101');
    assert.equal(localLatest.environmentAssets[0].dataPlatformRevision, first.environmentAssets[0].dataPlatformRevision);
    checks.push('local-latest-environment-authority');

    const savedBinding = bindings.getCurrentDataPlatformBinding();
    bindings.clearCurrentDataPlatformBinding();
    await assets.activateProjectRoot(projectRoot);
    const explicitScene = { version: 5, scene: { entities: [], sceneSettings: {} } };
    const explicit = await service.prepareLocalSceneResources(baseUrl, workspaceRoot,
      { mode: 'scene-latest', syncLibrary: true, sceneContent: JSON.stringify(explicitScene) });
    assert.equal(assets.getCurrentProjectRoot(), projectRoot, '未绑定场景主动同步不能切换工程目录');
    assert.equal(bindings.getCurrentDataPlatformBinding(), null, '主动同步不能创建发布绑定');
    assert.deepEqual(explicit.modelReplacements, []);
    assert.deepEqual(explicit.issues, []);
    assert.ok(downloads.some(item => item.url.includes('/202/')), '主动全库同步必须等待未引用环境下载完成');
    bindings.setCurrentDataPlatformBinding(savedBinding.projectRoot, savedBinding.metadata);
    checks.push('explicit-unbound-library-sync-preserves-project');

    mode = 'migrated';
    const beforeMigratedDownloads = downloads.length;
    const migrated = await service.prepareLocalSceneResources(baseUrl, workspaceRoot, { environment: { resourceId: '101', displayName: ' CAMPUS.glb ' } });
    assert.equal(migrated.environmentAssets.length, 1,
      `迁移后的权威环境候选必须仅含901：${JSON.stringify(migrated.environmentAssets.map(asset => ({ id: asset.dataPlatformResourceId, revision: asset.dataPlatformFileRevision })))}`);
    assert.equal(migrated.environmentAssets[0].dataPlatformResourceId, '901');
    assert.equal(migrated.environmentAssets[0].dataPlatformFileRevision, '3');
    assert.deepEqual(await readFile(migrated.environmentAssets[0].path), createGlb(3));
    assert.ok(!downloads.slice(beforeMigratedDownloads).some(item => item.url.includes('/202/')));
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

    mode = 'stable';
    bindings.setCurrentDataPlatformBinding(projectRoot, bindings.createDataPlatformBinding({
      baseUrl, webBaseUrl: baseUrl, workspaceRoot, projectId: '11', projectName: '远端场景重新关联',
      editorProjectId: '22', latestVersionId: '33', latestVersionNumber: 1, resourceRevision: '1',
      entryScenePath: null, syncedAt: '2026-09-09T00:00:00.000Z',
    }));
    const managedModel = id => ({ sourceUrl: `editor-asset://local/${encodeURIComponent(`C:/old/Model-${id}-设备/model.glb`)}`,
      sourcePath: 'old', parameterValues: { width: 0, enabled: false },
      dataPlatformModel: { sourceKey: oldSourceKey, kind: 'model', resourceId: id, modelPath: 'model.glb' } });
    const latestScene = { version: 5, scene: { entities: {
      good: { components: { modelAsset: managedModel('301') } },
      missing: { components: { modelAsset: managedModel('999') } },
    }, sceneSettings: { environment: { source: 'data-platform', dataPlatformSourceKey: oldSourceKey,
      dataPlatformResourceId: '101', opacity: 0.4, visible: true } } } };
    const latestRequest = () => ({ mode: 'data-platform-latest', sceneContent: JSON.stringify(latestScene) });
    const remoteBaseline = JSON.stringify(latestScene);
    const rebound = await service.prepareLocalSceneResources(oldBaseUrl, workspaceRoot, latestRequest());
    assert.equal(rebound.sourceKey, sourceKey, 'latest 必须以当前绑定为准，而非调用者传入的旧地址');
    assert.equal(rebound.modelReplacements.length, 1);
    assert.equal(rebound.modelReplacements[0].asset.dataPlatformResourceId, '301');
    assert.equal(rebound.modelReplacements[0].asset.dataPlatformSourceKey, sourceKey);
    assert.equal(rebound.environmentAssets[0].dataPlatformSourceKey, sourceKey);
    assert.deepEqual(rebound.issues.map(issue => [issue.resourceKind, issue.resourceId]), [['model', '999']]);
    assert.equal(JSON.stringify(latestScene), remoteBaseline, '准备资源不得篡改中台场景参数');
    checks.push('latest-rebinds-to-current-project', 'latest-partial-model-failure-preserves-success');
    const explicitRebound = await service.prepareLocalSceneResources(baseUrl, workspaceRoot,
      { mode: 'scene-latest', sceneContent: JSON.stringify(latestScene) });
    assert.equal(explicitRebound.modelReplacements.length, 1, '手动同步与项目打开遵循相同的当前绑定来源');
    assert.equal(explicitRebound.environmentAssets.length, 1);
    assert.deepEqual(explicitRebound.issues.map(issue => [issue.resourceKind, issue.resourceId]), [['model', '999']]);
    checks.push('explicit-source-policy-matches-project-open');
    const compatibleScene = structuredClone(latestScene);
    delete compatibleScene.scene.entities.missing;
    compatibleScene.scene.entities.good.components.modelAsset.dataPlatformModel.sourceKey = sourceKey;
    compatibleScene.scene.sceneSettings.environment.dataPlatformSourceKey = sourceKey;
    const beforePinned = downloads.length;
    const pinned = await service.prepareLocalSceneResources(baseUrl, workspaceRoot,
      { mode: 'scene-latest', syncLibrary: true, sceneContent: JSON.stringify(compatibleScene) });
    assert.equal(pinned.modelReplacements.length, 1);
    assert.equal(pinned.modelReplacements[0].asset.dataPlatformSourceKey, sourceKey);
    assert.equal(pinned.modelReplacements[0].asset.dataPlatformResourceId, '301');
    assert.ok(pinned.modelReplacements[0].asset.path.includes('scene-model-versions'));
    assert.deepEqual(pinned.issues, []);
    assert.deepEqual(pinned.libraryErrors, []);
    assert.equal(downloads.length, beforePinned, '共享包固定版本复用不得重复下载');
    checks.push('explicit-pins-validated-library-without-download');
    failLibraryQuery = true;
    const libraryFailure = await service.prepareLocalSceneResources(baseUrl, workspaceRoot,
      { mode: 'scene-latest', syncLibrary: true, sceneContent: JSON.stringify(compatibleScene) });
    failLibraryQuery = false;
    assert.equal(libraryFailure.modelReplacements.length, 1, '库查询失败后仍可定向准备当前场景模型');
    assert.equal(libraryFailure.libraryErrors.length, 1);
    assert.deepEqual(libraryFailure.issues, [], '无关库失败不能污染场景发布问题');
    const explicitBinding = bindings.getCurrentDataPlatformBinding();
    bindings.clearCurrentDataPlatformBinding();
    const unboundLegacyScene = structuredClone(compatibleScene);
    delete unboundLegacyScene.scene.entities.good.components.modelAsset.dataPlatformModel;
    const legacyUnbound = await service.prepareLocalSceneResources(baseUrl, workspaceRoot,
      { mode: 'scene-latest', sceneContent: JSON.stringify(unboundLegacyScene) });
    assert.equal(legacyUnbound.modelReplacements.length, 0);
    assert.ok(legacyUnbound.issues.some(issue => issue.resourceId === '301' && /来源身份/.test(issue.message)));
    const identifiedUnbound = await service.prepareLocalSceneResources(baseUrl, workspaceRoot,
      { mode: 'scene-latest', sceneContent: JSON.stringify(compatibleScene) });
    assert.equal(identifiedUnbound.modelReplacements.length, 1);
    checks.push('explicit-unbound-requires-source-identity');
    const unboundPreparing = service.prepareLocalSceneResources(baseUrl, workspaceRoot,
      { mode: 'scene-latest', sceneContent: JSON.stringify(compatibleScene) });
    const unboundRejected = assert.rejects(unboundPreparing, /会话.*变化/);
    await assets.activateProjectRoot(sharedRoot);
    await unboundRejected;
    await assets.activateProjectRoot(projectRoot);
    bindings.setCurrentDataPlatformBinding(explicitBinding.projectRoot, explicitBinding.metadata);
    checks.push('explicit-library-errors-isolated', 'explicit-unbound-project-switch-cancels');



    mode = 'parallel';
    const parallelScene = { version: 5, scene: { entities: Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`parallel-${index}`, { components: { modelAsset: managedModel(String(410 + index)) } }]),
    ), sceneSettings: { environment: { source: 'data-platform', dataPlatformSourceKey: sourceKey, dataPlatformResourceId: '901' } } } };
    const parallelPreparing = service.prepareLocalSceneResources(baseUrl, workspaceRoot,
      { mode: 'data-platform-latest', sceneContent: JSON.stringify(parallelScene) });
    const parallelSettled = Promise.allSettled([parallelPreparing]);
    try {
      const parallelDeadline = Date.now() + 5000;
      while ((maxParallelDownloads < 4 || !downloads.some(item => item.mode === 'parallel' && item.url.includes('/901/')))
        && Date.now() < parallelDeadline) await delay(10);
      assert.equal(maxParallelDownloads, 4, '前四个独立模型必须同时下载，无需等待前一个模型完成');
      assert.equal(downloads.some(item => item.mode === 'parallel' && item.url.includes('model-414.glb')), false,
        '同时准备的模型资源不得超过四个');
      assert.ok(downloads.some(item => item.mode === 'parallel' && item.url.includes('/901/')),
        '大型环境必须在前四个设备仍在下载时启动');
    } finally {
      holdParallelDownloads = false;
      for (const finish of pendingParallelDownloads.splice(0)) finish();
      await parallelSettled;
    }
    const parallel = await parallelPreparing;
    assert.deepEqual(parallel.modelReplacements.map(item => item.asset.dataPlatformResourceId), ['410', '411', '412', '413', '414']);
    assert.deepEqual(parallel.issues.map(issue => issue.resourceId), ['415'], '单个 ID 失败不影响其余并发资源');
    assert.equal(parallel.environmentAssets.length, 1);
    checks.push('latest-four-models-in-parallel', 'latest-environment-starts-before-models-finish', 'latest-parallel-failure-isolated');
    mode = 'stable';

    latestScene.scene.sceneSettings.environment.dataPlatformResourceId = '404';
    const missingEnvironment = await service.prepareLocalSceneResources(baseUrl, workspaceRoot, latestRequest());
    assert.equal(missingEnvironment.modelReplacements.length, 1);
    assert.equal(missingEnvironment.environmentAssets.length, 0);
    assert.ok(missingEnvironment.issues.some(issue => issue.resourceKind === 'environment' && issue.resourceId === '404'));
    delete latestScene.scene.sceneSettings.environment.dataPlatformResourceId;
    const missingIdentity = await service.prepareLocalSceneResources(baseUrl, workspaceRoot, latestRequest());
    assert.equal(missingIdentity.modelReplacements.length, 1);
    assert.ok(missingIdentity.issues.some(issue => issue.resourceKind === 'environment' && /身份/.test(issue.message)));
    checks.push('latest-environment-failure-and-missing-identity-are-local-issues');

    mode = 'slow';
    slowDownloadStarted = false;
    latestScene.scene.sceneSettings.environment.dataPlatformResourceId = '901';
    const latestPreparing = service.prepareLocalSceneResources(baseUrl, workspaceRoot, latestRequest());
    const latestRejected = assert.rejects(latestPreparing, /abort|取消|会话/i);
    const latestDeadline = Date.now() + 10000;
    while (!slowDownloadStarted) {
      assert.ok(Date.now() < latestDeadline, '等待 latest 环境下载开始超时');
      await delay(10);
    }
    assert.equal(service.cancelDataPlatformProjectLoading(), true);
    await latestRejected;
    checks.push('latest-cancellation-never-degrades-to-warning');

    const previousBinding = bindings.getCurrentDataPlatformBinding();
    const stalePreparing = service.prepareLocalSceneResources(baseUrl, workspaceRoot, latestRequest());
    const staleRejected = assert.rejects(stalePreparing, /会话.*变化/);
    bindings.setCurrentDataPlatformBinding(projectRoot, { ...previousBinding.metadata, projectId: '12' });
    await staleRejected;
    bindings.setCurrentDataPlatformBinding(projectRoot, previousBinding.metadata);
    checks.push('latest-project-switch-never-degrades-to-warning');

    mode = 'stable';
    const fullLibraryModelStarted = await service.syncDataPlatformModelsForWorkspace(baseUrl, workspaceRoot);
    const fullLibraryEnvironmentStarted = await service.syncDataPlatformEnvironmentsForWorkspace(baseUrl, workspaceRoot);
    assert.equal(fullLibraryModelStarted, true);
    assert.equal(fullLibraryEnvironmentStarted, true);
    const libraryDeadline = Date.now() + 10000;
    while (models.getLatestDataPlatformModelSyncProgress()?.phase !== 'completed'
      || environments.getLatestDataPlatformEnvironmentSyncProgress()?.phase !== 'completed') {
      assert.ok(Date.now() < libraryDeadline, '后台全库同步完成超时');
      assert.notEqual(models.getLatestDataPlatformModelSyncProgress()?.phase, 'failed');
      assert.notEqual(environments.getLatestDataPlatformEnvironmentSyncProgress()?.phase, 'failed');
      await delay(10);
    }
    assert.ok((await assets.readProjectAssetIndex(sharedRoot)).assets.some(asset => path.basename(asset.packagePath ?? '').startsWith('Combo-301')),
      '未被当前场景引用的组合模型也进入模型库');
    assert.ok(downloads.some(item => item.url.includes('/202/')), '全库同步下载未绑定的环境模型');
    for (const replacement of parallel.modelReplacements) assert.ok(await readFile(replacement.asset.path),
      '全库刷新不得删除或覆盖场景固定版本');
    checks.push('full-library-includes-unreferenced-model-and-environment', 'full-library-preserves-scene-snapshots');

    const staleModelLibrary = service.syncDataPlatformModelsForWorkspace(baseUrl, workspaceRoot);
    const staleEnvironmentLibrary = service.syncDataPlatformEnvironmentsForWorkspace(baseUrl, workspaceRoot);
    service.cancelDataPlatformProjectLoading();
    assert.deepEqual(await Promise.all([staleModelLibrary, staleEnvironmentLibrary]), [false, false],
      '取消项目后迟到的全库文件系统准备不能重新启动同步');
    checks.push('full-library-session-cancellation-guard');

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
