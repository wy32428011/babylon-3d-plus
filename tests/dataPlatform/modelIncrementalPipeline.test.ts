import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ executeDataPlatformModelSync, getLatestDataPlatformModelSyncProgress, syncSceneDataPlatformModelAssets }, transfer] =
  await importIsolatedTypeScriptModules<[typeof import('../../electron/ipc/dataPlatformModelIncrementalSync'),
    typeof import('../../electron/ipc/dataPlatformTransfer')]>(
    ['electron/ipc/dataPlatformModelIncrementalSync.ts', 'electron/ipc/dataPlatformTransfer.ts']);
const baseUrl = 'https://example.com/platform';
const modelBytes = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{}] }] }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function withRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-pipeline-'));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function readAssetIndex(editorRoot: string): Promise<import('../../electron/types').ProjectAssetIndex> {
  try { return JSON.parse(await fs.readFile(path.join(editorRoot, '.babylon-editor/asset-index.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, assets: [] };
    throw error;
  }
}
function dependencies(options: { count?: number; revision?: string; blockSecond?: Promise<void>; invalidSecond?: boolean;
  afterDownloadRevision?: () => string } = {}) {
  const records = Array.from({ length: options.count ?? 2 }, (_, index) => ({ id: String(index + 1),
    modelName: '设备' + (index + 1), fileName: 'model.gltf', fileUrl: `/files/${index + 1}.gltf`,
    revision: options.revision ?? '1' }));
  return {
    requestJson: async (request: { endpointPath: string; body?: unknown }) => {
      if (request.endpointPath.includes('combo-models')) return { success: true, data: { records: [], total: 0, pageNum: 1, pageSize: 100 } };
      if (request.endpointPath.endsWith('/detail')) {
        const record = records.find(record => record.id === (request.body as { id: string }).id)!;
        return { success: true, data: { ...record, revision: options.afterDownloadRevision?.() ?? record.revision } };
      }
      return { success: true, data: { records, total: records.length, pageNum: 1, pageSize: 100 } };
    },
    downloadFile: async (request: import('../../electron/ipc/dataPlatformTransfer').DownloadRemoteFileOptions) => {
      if (request.remoteUrl === '/files/2.gltf') await options.blockSecond;
      const bytes = options.invalidSecond && request.remoteUrl === '/files/2.gltf' ? Buffer.from('invalid') : modelBytes;
      await fs.mkdir(path.dirname(request.destinationPath), { recursive: true });
      await fs.writeFile(request.destinationPath, bytes);
      request.onBytes?.(bytes.length);
      return { bytes: bytes.length, contentType: 'application/json', finalUrl: request.remoteUrl, etag: null, resumedBytes: 0 };
    },
    readAssetIndex,
  };
}
async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), '等待流水线状态超时');
}

test('模拟中台下载期间已完成包开始真实扫描校验，完整索引仍等全部成功后提交', async () => {
  await withRoot(async root => {
    const blocked = deferred(), runId = 'pipeline-overlap';
    const pending = executeDataPlatformModelSync({ baseUrl, editorRoot: root, runId,
      dependencies: dependencies({ blockSecond: blocked.promise }) });
    void pending.catch(() => undefined);
    try {
      await waitUntil(() => getLatestDataPlatformModelSyncProgress()?.message.includes('已校验 1/2') === true);
      assert.equal(getLatestDataPlatformModelSyncProgress()?.phase, 'downloading');
      assert.equal((await readAssetIndex(root)).assets.length, 0, '未完成包不能进入公开资产索引');
      const staged = path.join(root, '.babylon-editor', `data-platform-model-sync-${runId}`, 'packages/Assets/Models/Model-1-设备1/meta.json');
      assert.ok(JSON.parse(await fs.readFile(staged, 'utf8')), '实际元数据规范化和包扫描已执行');
      blocked.resolve();
      assert.equal((await pending).downloadedPackageCount, 2);
      assert.equal((await readAssetIndex(root)).assets.length, 2);
      assert.equal(getLatestDataPlatformModelSyncProgress()?.phase, 'completed');
      assert.equal((await fs.readdir(path.join(root, '.babylon-editor'))).some(name => name.startsWith('data-platform-model-sync-')), false);
    } finally { blocked.resolve(); await pending; }
  });
});

test('本地 HTTP 模拟服务的流式下载与包校验重叠，传输字节进度持续有效', async () => {
  await withRoot(async root => {
    const blocked = deferred(), secondStarted = deferred();
    const records = [1, 2].map(id => ({ id: String(id), modelName: '设备' + id,
      fileName: 'model.gltf', fileUrl: `/files/${id}.gltf`, revision: '1' }));
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      if (request.url?.startsWith('/api/')) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ success: true, data: {
          records: request.url.includes('combo-models') ? [] : records,
          total: request.url.includes('combo-models') ? 0 : 2, pageNum: 1, pageSize: 100,
        } }));
        return;
      }
      response.setHeader('content-type', 'model/gltf+json');
      response.setHeader('content-length', String(modelBytes.length));
      if (request.url === '/files/2.gltf') {
        const split = Math.floor(modelBytes.length / 2);
        response.write(modelBytes.subarray(0, split));
        secondStarted.resolve();
        void blocked.promise.then(() => response.end(modelBytes.subarray(split)));
      } else response.end(modelBytes);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const pending = executeDataPlatformModelSync({ baseUrl: `http://127.0.0.1:${address.port}`, editorRoot: root,
      runId: 'http-pipeline-overlap', dependencies: {
        requestJson: request => transfer.requestDataPlatformJson({ ...request, fetchImpl: fetch }),
        downloadFile: request => transfer.downloadRemoteFile({ ...request, fetchImpl: fetch }), readAssetIndex,
      } });
    void pending.catch(() => undefined);
    try {
      await secondStarted.promise;
      await waitUntil(() => getLatestDataPlatformModelSyncProgress()?.message.includes('已校验 1/2') === true);
      assert.equal(getLatestDataPlatformModelSyncProgress()?.download?.activeFiles, 1);
      assert.ok((getLatestDataPlatformModelSyncProgress()?.download?.downloadedBytes ?? 0) > modelBytes.length);
      assert.equal((await readAssetIndex(root)).assets.length, 0);
      blocked.resolve(); await pending;
      assert.equal((await readAssetIndex(root)).assets.length, 2);
      assert.deepEqual(requests.filter(url => url.startsWith('/files/')).sort(), ['/files/1.gltf', '/files/2.gltf']);
    } finally {
      blocked.resolve();
      await Promise.allSettled([pending]);
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  });
});

test('模拟中台后续包校验失败时保留原包和两个完整索引，排空后清理暂存目录', async () => {
  await withRoot(async root => {
    await executeDataPlatformModelSync({ baseUrl, editorRoot: root, dependencies: dependencies() });
    const assetIndexPath = path.join(root, '.babylon-editor/asset-index.json');
    const modelIndexPath = path.join(root, '.babylon-editor/data-platform-model-index.json');
    const before = await Promise.all([fs.readFile(assetIndexPath), fs.readFile(modelIndexPath)]);
    const assetPaths = (await readAssetIndex(root)).assets.map(asset => asset.path);
    const packagesBefore = await Promise.all(assetPaths.map(file => fs.readFile(file)));
    const blocked = deferred();
    const pending = executeDataPlatformModelSync({ baseUrl, editorRoot: root, runId: 'pipeline-failed',
      dependencies: dependencies({ revision: '2', blockSecond: blocked.promise, invalidSecond: true }) });
    const outcome = pending.then(() => null, error => error);
    try {
      await waitUntil(() => getLatestDataPlatformModelSyncProgress()?.message.includes('已校验 1/2') === true);
      assert.deepEqual(await fs.readFile(assetIndexPath), before[0]);
      blocked.resolve();
      assert.ok(await outcome instanceof Error);
      assert.deepEqual(await Promise.all([fs.readFile(assetIndexPath), fs.readFile(modelIndexPath)]), before);
      assert.deepEqual(await Promise.all(assetPaths.map(file => fs.readFile(file))), packagesBefore);
      assert.equal((await fs.readdir(path.join(root, '.babylon-editor'))).some(name => name.startsWith('data-platform-model-sync-')), false);
      assert.equal(getLatestDataPlatformModelSyncProgress()?.phase, 'failed');
    } finally { blocked.resolve(); await outcome; }
  });
});

test('流水线保持可信快照原始 SHA 校验和下载后二次元数据确认', async () => {
  await withRoot(async root => {
    const resource = { kind: 'model' as const, resourceId: '1' };
    const expected = { ...resource, role: 'model', fileUrl: '/files/1.gltf', size: String(modelBytes.length),
      sha256: createHash('sha256').update(modelBytes).digest('hex') };
    await assert.rejects(syncSceneDataPlatformModelAssets({ baseUrl, sharedResourcesRoot: root, resources: [resource],
      expectedFiles: [{ ...expected, sha256: '0'.repeat(64) }], dependencies: dependencies({ count: 1 }) }), /摘要不一致/);
    assert.equal((await readAssetIndex(root)).assets.length, 0);
    let queries = 0;
    await assert.rejects(syncSceneDataPlatformModelAssets({ baseUrl, sharedResourcesRoot: root, resources: [resource],
      expectedFiles: [expected], dependencies: dependencies({ count: 1, afterDownloadRevision: () => ++queries === 1 ? '1' : '2' }) }), /资源描述发生变化/);
    assert.equal(queries, 2);
    const versions = path.join(root, '.babylon-editor/scene-model-versions');
    await assert.rejects(fs.stat(versions), (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      '二次确认失败不能固定或授权场景版本');
  });
});
