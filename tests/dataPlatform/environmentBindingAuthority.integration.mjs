import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';

const externalRoot = process.env.ZENDING_ENV_AUTHORITY_TEST_ROOT;
const root = externalRoot ?? await mkdtemp(path.join(os.tmpdir(), 'environment-binding-authority-'));
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));
app.disableHardwareAcceleration();

function glb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }], meshes: [{ primitives: [{}] }] }));
  const jsonSize = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(32 + jsonSize);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonSize, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + jsonSize); json.copy(bytes, 20);
  bytes.writeUInt32LE(4, 20 + jsonSize); bytes.writeUInt32LE(0x004e4942, 24 + jsonSize);
  return bytes;
}

async function run() {
  const sync = await import('../../dist-electron/ipc/dataPlatformEnvironmentSync.js');
  const service = await import('../../dist-electron/ipc/dataPlatformProjectService.js');
  const bindings = await import('../../dist-electron/ipc/dataPlatformBindingStore.js');
  const index = await import('../../dist-electron/ipc/dataPlatformEnvironmentIndex.js');
  const bytes = glb();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const resourceId = '2071816469849280514';
  let fileDownloads = 0;
  let manifestRequests = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url?.includes('sync-manifest')) {
      manifestRequests += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, data: { protocolVersion: '1', manifestRevision: '1', nextCursorId: null, hasMore: false,
        records: [{ id: resourceId, modelName: '当前中台权威环境', fileStatus: 'GLB_READY', fileName: 'model.glb',
          fileSizeBytes: String(bytes.length), fileSha256: sha256, fileRevision: '1', runtimeRevision: '1',
          lengthUnit: 'meter', downloadUrl: `/api/v1/env-models/${resourceId}/file?fileRevision=1`, updatedAt: '2026-09-07T00:00:00.000Z' }],
      } }));
    } else if (req.url?.startsWith(`/api/v1/env-models/${resourceId}/file`)) {
      fileDownloads += 1;
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.length), ETag: '"current-v1"' });
      res.end(bytes);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sourceKey = sync.createDataPlatformSourceKey(baseUrl);
  const oldSourceKey = sync.createDataPlatformSourceKey('https://old-platform.invalid');
  const workspaceRoot = path.join(root, 'workspace');
  const sharedRoot = path.join(workspaceRoot, 'SharedResources');
  const projectRoot = path.join(workspaceRoot, 'Projects', '11');
  await mkdir(projectRoot, { recursive: true });

  async function startAndWait(expectedPhase) {
    const previousRun = sync.getLatestDataPlatformEnvironmentSyncProgress()?.runId;
    assert.equal(await service.syncDataPlatformEnvironmentsForWorkspace(baseUrl, workspaceRoot, oldSourceKey, [resourceId]), true);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const progress = sync.getLatestDataPlatformEnvironmentSyncProgress();
      if (progress?.runId !== previousRun && (progress?.phase === 'completed' || progress?.phase === 'failed')) {
        assert.equal(progress.phase, expectedPhase, progress.error ?? progress.message);
        // 等待start调度器finally释放active，避免下一次启动仅被合并到上一轮。
        await delay(20);
        return progress;
      }
      await delay(10);
    }
    throw new Error('等待环境权威来源同步超时。');
  }

  try {
    bindings.setCurrentDataPlatformBinding(projectRoot, bindings.createDataPlatformBinding({
      baseUrl, webBaseUrl: baseUrl, workspaceRoot, projectId: '11', projectName: '当前中台绑定项目',
      editorProjectId: null, latestVersionId: null, latestVersionNumber: null, resourceRevision: '1',
      entryScenePath: null, syncedAt: '2026-09-07T00:00:00.000Z',
    }));
    await startAndWait('completed');
    let cached = await index.readDataPlatformEnvironmentIndex(sharedRoot);
    assert.equal(cached.sourceKey, sourceKey);
    assert.equal(cached.entries[0].fileSha256, sha256);
    assert.equal(cached.entries[0].sourceKey, sourceKey);
    const modelPath = index.resolveEnvironmentIndexEntryPath(sharedRoot, cached.entries[0].relativePath);
    assert.deepEqual(await readFile(modelPath), bytes);
    assert.equal(fileDownloads, 1);

    await sync.executeDataPlatformEnvironmentSync({ baseUrl, editorRoot: sharedRoot, contextKey: 'authority:force-same-revision', requiredResourceIds: [resourceId], forceRefresh: true });
    assert.equal(fileDownloads, 2, '同revision且缓存有效时forceRefresh也必须重新下载');
    const corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1] ^= 0xff;
    await writeFile(modelPath, corrupted);
    await sync.executeDataPlatformEnvironmentSync({ baseUrl, editorRoot: sharedRoot, contextKey: 'authority:force-overwrite', requiredResourceIds: [resourceId], forceRefresh: true });
    assert.equal(fileDownloads, 3);
    assert.deepEqual(await readFile(modelPath), bytes);
    cached = await index.readDataPlatformEnvironmentIndex(sharedRoot);
    assert.equal(cached.entries[0].fileRevision, '1');
    assert.equal(cached.entries[0].fileSha256, sha256);

    async function waitForForcedDownload(expectedDownloads) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const progress = sync.getLatestDataPlatformEnvironmentSyncProgress();
        if (progress?.phase === 'completed' && fileDownloads === expectedDownloads) {
          await delay(20);
          return;
        }
        await delay(10);
      }
      assert.fail(`同scope强制同步未执行：downloads=${fileDownloads}; progress=${JSON.stringify(sync.getLatestDataPlatformEnvironmentSyncProgress())}`);
    }
    // 三个调用在同一tick内发生，模拟普通刷新尚未退出时，用户打开和UI自动同步连续到达。
    const contextKey = service.createDataPlatformEnvironmentSyncContextKey(baseUrl, sharedRoot);
    assert.equal(sync.startDataPlatformEnvironmentSync(baseUrl, sharedRoot, contextKey, undefined, [resourceId], false), true);
    assert.equal(sync.startDataPlatformEnvironmentSync(baseUrl, sharedRoot, contextKey, undefined, [resourceId], true), true);
    assert.equal(sync.startDataPlatformEnvironmentSync(baseUrl, sharedRoot, contextKey, undefined, [resourceId], false), true);
    await waitForForcedDownload(4);
    assert.equal(sync.retryDataPlatformEnvironmentSync(), true);
    await waitForForcedDownload(5);

    bindings.clearCurrentDataPlatformBinding();
    const requestsBeforeUnbound = manifestRequests;
    const rejected = await startAndWait('failed');
    assert.match(rejected.error, /来源不一致/);
    assert.equal(manifestRequests, requestsBeforeUnbound, '普通未绑定场景来源不一致时必须在HTTP之前拒绝');
    assert.equal(fileDownloads, 5);
    console.log(JSON.stringify({ status: 'PASS', sourceKey, fileDownloads, checks: ['bound-old-source-overridden', 'force-refresh-same-revision', 'force-replace-corrupt-cache', 'same-scope-queued-force-not-downgraded', 'retry-retains-force', 'unbound-old-source-rejected'] }));
  } finally {
    bindings.clearCurrentDataPlatformBinding();
    await service.disposeDataPlatformProjectTasks();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

app.whenReady().then(run).then(async () => {
  // userData有Electron持有的文件句柄，父进程须在应用退出后回收测试根目录。
  if (!externalRoot) console.log(`测试临时目录（请在进程退出后清理）：${root}`);
  app.exit(0);
}, async (error) => {
  console.error(error);
  if (!externalRoot) console.log(`测试临时目录（请在进程退出后清理）：${root}`);
  app.exit(1);
});
