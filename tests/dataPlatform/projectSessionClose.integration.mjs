import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { createServer } from 'node:http';

const root = process.env.ZENDING_PROJECT_SESSION_TEST_ROOT;
if (!root) throw new Error('请通过 projectSessionClose.test.ts 运行隔离测试。');
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));
app.disableHardwareAcceleration();

async function run() {
  const handlers = new Map();
  ipcMain.handle = (name, callback) => { handlers.set(name, callback); };
  const ipc = await import('../../dist-electron/ipc/dataPlatformIpc.js');
  const assets = await import('../../dist-electron/ipc/projectAssetStore.js');
  const bindings = await import('../../dist-electron/ipc/dataPlatformBindingStore.js');
  const publish = await import('../../dist-electron/ipc/digitalTwinPublishService.js');
  ipc.registerDataPlatformIpc();
  const projectRoot = path.join(root, 'Projects', '1');
  const shared = path.join(root, 'SharedResources');
  await mkdir(projectRoot, { recursive: true });
  await assets.activateProjectRoot(projectRoot);
  const metadata = bindings.createDataPlatformBinding({
    baseUrl: 'http://127.0.0.1:1', workspaceRoot: root, projectId: '1', projectName: '项目 A',
    editorProjectId: '10', latestVersionId: '20', latestVersionNumber: 2,
    resourceRevision: '3', entryScenePath: null, syncedAt: new Date().toISOString(),
  });
  await bindings.writeDataPlatformBinding(projectRoot, metadata);
  bindings.setCurrentDataPlatformBinding(projectRoot, metadata);
  assets.setSharedProjectAssetRoot(shared);
  assets.setSharedProjectEnvironmentRoot(shared);
  assets.setSharedProjectSkyboxRoot(shared);
  const marker = path.join(projectRoot, 'saved-scene.json');
  await writeFile(marker, 'saved project content');
  const recentBefore = await assets.getRecentWorkspaces();

  // 旧版返回仅切换页面；无关闭 IPC 时继续检查实际残留的发布上下文。
  await handlers.get('data-platform:closeProject')?.({});
  assert.equal(publish.getLocalDigitalTwinPublishContext(false).projectId, null,
    '返回后发布上下文不得仍绑定项目 A');
  assert.equal(bindings.getCurrentDataPlatformBinding(), null);
  assert.deepEqual(assets.getProjectAssetStoreStateSnapshot(), {
    currentProjectRoot: null, sharedProjectAssetRoot: null,
    sharedProjectSkyboxRoot: null, sharedProjectEnvironmentRoot: null,
  });
  assert.equal((await assets.listProjectAssets()).projectRoot, null, '资源库查询不得自动恢复旧项目');
  assert.equal((await publish.getDigitalTwinPublishContext()).projectId, null);
  assert.deepEqual(await assets.getRecentWorkspaces(), recentBefore, '保留最近记录');
  assert.deepEqual(await bindings.readDataPlatformBinding(projectRoot), metadata, '保留磁盘绑定');
  assert.equal(await readFile(marker, 'utf8'), 'saved project content');
  await handlers.get('data-platform:closeProject')({});

  const localRoot = path.join(root, 'local-B');
  await mkdir(localRoot);
  await assets.activateProjectRoot(localRoot);
  assert.equal((await publish.getDigitalTwinPublishContext()).projectId, null, '普通项目 B 不继承 A');
  await assets.activateProjectRoot(projectRoot);
  bindings.clearCurrentDataPlatformBinding();
  const pendingContext = publish.getDigitalTwinPublishContext();
  assets.clearProjectAssetStoreSession();
  assert.equal((await pendingContext).projectId, null, '关闭期间完成的绑定读取不能复活旧项目');
  assert.equal(bindings.getCurrentDataPlatformBinding(), null);
  assert.equal(assets.getSharedProjectAssetRoot(), null);
  await assets.activateProjectRoot(projectRoot);
  // 本地上下文恢复由发布预检完成，避免向真实中台发请求。
  bindings.setCurrentDataPlatformBinding(projectRoot, await bindings.readDataPlatformBinding(projectRoot));
  assert.equal(publish.getLocalDigitalTwinPublishContext(false).projectId, '1');
  await verifySyncCleanup(handlers, bindings, root);
  console.log('PASS: close clears publish binding, roots and auto-restore; preserves files and recent history; reopen works');
}

async function verifySyncCleanup(handlers, bindings, root) {
  const model = await import('../../dist-electron/ipc/dataPlatformModelIncrementalSync.js');
  const environment = await import('../../dist-electron/ipc/dataPlatformEnvironmentSync.js');
  const image = await import('../../dist-electron/ipc/dataPlatformImageSync.js');
  const skybox = await import('../../dist-electron/ipc/dataPlatformSkyboxSync.js');
  const chart = await import('../../dist-electron/ipc/dataPlatformChartSync.js');
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const urls = new Set();
  const server = createServer((request) => {
    request.resume();
    urls.add(request.url);
    if (urls.size >= 5) ready();
    // 请求保持在途，只有项目清理取消它后连接才结束。
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const shared = path.join(root, 'sync-fixture');
  const binding = bindings.getCurrentDataPlatformBinding();
  bindings.setCurrentDataPlatformBinding(binding.projectRoot, { ...binding.metadata, baseUrl });
  const deadline = setTimeout(() => ready(), 5000);
  try {
    assert.equal(model.startDataPlatformModelSync(baseUrl, shared), true);
    assert.equal(environment.startDataPlatformEnvironmentSync(baseUrl, shared, 'session-close'), true);
    assert.equal(image.startDataPlatformImageSync(baseUrl, shared), true);
    assert.equal(skybox.startDataPlatformSkyboxSync(baseUrl, shared, 'session-close'), true);
    assert.equal(await chart.startDataPlatformChartSync(), true);
    await started;
    assert.equal(urls.size, 5, `五类同步请求应处于在途状态：${[...urls]}`);
    const closing = handlers.get('data-platform:closeProject')({});
    await assert.rejects(handlers.get('data-platform:syncModels')({}), /正在关闭当前项目/);
    await closing;
    assert.equal(model.getLatestDataPlatformModelSyncProgress(), null);
    assert.equal(environment.getLatestDataPlatformEnvironmentSyncProgress(), null);
    assert.equal(image.getLatestDataPlatformImageSyncProgress(), null);
    assert.equal(skybox.getLatestDataPlatformSkyboxSyncProgress(), null);
    assert.equal(chart.getCurrentDataPlatformChartSyncProgress(), null);
    assert.equal(model.retryDataPlatformModelSync(), false);
    assert.equal(environment.retryDataPlatformEnvironmentSync(), false);
    assert.equal(image.retryDataPlatformImageSync(), false);
    assert.equal(skybox.retryDataPlatformSkyboxSync(), false);
    assert.equal(await chart.retryDataPlatformChartSync(), false);
    assert.equal(model.startDataPlatformModelSync(baseUrl, shared), true, '关闭不是永久 shutdown');
    assert.equal(environment.startDataPlatformEnvironmentSync(baseUrl, shared, 'next-session'), true);
    assert.equal(image.startDataPlatformImageSync(baseUrl, shared), true);
    assert.equal(skybox.startDataPlatformSkyboxSync(baseUrl, shared, 'next-session'), true);
    await handlers.get('data-platform:closeProject')({});
    console.log('PASS: five in-flight syncs cancelled; progress/retry state cleared; next session can restart');
  } finally {
    clearTimeout(deadline);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

app.whenReady().then(run).then(() => app.exit(0)).catch((error) => {
  console.error(error);
  app.exit(1);
});
