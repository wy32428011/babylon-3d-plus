import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [sync] = await importIsolatedTypeScriptModules<[typeof import('../../electron/ipc/dataPlatformEnvironmentSync')]>(['electron/ipc/dataPlatformEnvironmentSync.ts'], { deferCleanup: (cleanup) => after(cleanup) });
const [transfer] = await importIsolatedTypeScriptModules<[typeof import('../../electron/ipc/dataPlatformTransfer')]>(['electron/ipc/dataPlatformTransfer.ts']);
const [index] = await importIsolatedTypeScriptModules<[typeof import('../../electron/ipc/dataPlatformEnvironmentIndex')]>(['electron/ipc/dataPlatformEnvironmentIndex.ts'], { deferCleanup: (cleanup) => after(cleanup) });
function glb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 262144 }], meshes: [{ primitives: [{}] }] }));
  const jsonSize = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonSize + 262144);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonSize, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + jsonSize); json.copy(bytes, 20);
  bytes.writeUInt32LE(262144, 20 + jsonSize); bytes.writeUInt32LE(0x004e4942, 24 + jsonSize);
  return bytes;
}

test('异机空缓存通过真实 HTTP 下载校验，断线重试续传，缓存重开不下载', async () => {
  const editorRoot = await mkdtemp(path.join(os.tmpdir(), 'remote-env-empty-'));
  const bytes = glb();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const requests: Array<{ range?: string; ifRange?: string }> = [];
  let disconnectOnce = true;
  let unrelatedDownloads = 0;
  const server = createServer((req, res) => {
    if (req.url?.includes('sync-manifest')) {
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, data: {
        protocolVersion: '1', manifestRevision: '1', nextCursorId: null, hasMore: false,
        records: [{ id: '2071816469849280514', modelName: '异机环境', fileStatus: 'GLB_READY',
          fileName: 'remote.glb', fileSizeBytes: String(bytes.length), fileSha256: sha256,
          fileRevision: '1', runtimeRevision: '1', lengthUnit: 'meter',
          downloadUrl: '/api/v1/env-models/2071816469849280514/file?fileRevision=1',
          updatedAt: '2026-09-07T00:00:00.000Z' },
          { id: '2071816469849280515', modelName: '不被当前场景引用的大环境', fileStatus: 'GLB_READY',
            fileName: 'unrelated.glb', fileSizeBytes: String(768 * 1024 * 1024), fileSha256: 'a'.repeat(64),
            fileRevision: '1', runtimeRevision: '1', lengthUnit: 'meter',
            downloadUrl: '/unrelated-large.glb', updatedAt: '2026-09-07T00:00:00.000Z' }],
      } }));
      return;
    }
    if (req.url === '/unrelated-large.glb') {
      unrelatedDownloads += 1;
      res.writeHead(503); res.end('Unused environment must never be requested');
      return;
    }
    requests.push({ range: req.headers.range, ifRange: req.headers['if-range'] as string | undefined });
    const offset = req.headers.range ? Number(req.headers.range.match(/^bytes=(\d+)-$/)?.[1]) : 0;
    assert.ok(Number.isSafeInteger(offset));
    res.writeHead(offset ? 206 : 200, {
      'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.length - offset),
      ETag: '"remote-environment-v1"', 'Accept-Ranges': 'bytes',
      ...(offset ? { 'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}),
    });
    if (disconnectOnce) {
      disconnectOnce = false;
      res.write(bytes.subarray(0, 65536));
      setTimeout(() => res.destroy(), 80);
    } else res.end(bytes.subarray(offset));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const dependencies = {
    requestJson: (options: Parameters<typeof transfer.requestDataPlatformJson>[0]) => transfer.requestDataPlatformJson({ ...options, fetchImpl: fetch }),
    downloadFile: (options: Parameters<typeof transfer.downloadRemoteFile>[0]) => transfer.downloadRemoteFile({ ...options, fetchImpl: fetch }),
  };
  const run = () => sync.executeDataPlatformEnvironmentSync({ baseUrl, editorRoot, contextKey: 'remote-http:empty', requiredResourceIds: ['2071816469849280514'], dependencies });
  try {
    // 当前场景必需环境失败必须显式拒绝，不能报全局completed后让异机蒙版一直等待。
    await assert.rejects(run(), /当前场景环境同步失败/);
    const failedIndex = await index.readDataPlatformEnvironmentIndex(editorRoot);
    assert.equal(failedIndex?.entries.filter((entry) => entry.status === 'active').length, 0);
    await run();
    const cached = await index.readDataPlatformEnvironmentIndex(editorRoot);
    assert.equal(cached?.entries.length, 1);
    const entry = cached!.entries[0];
    assert.equal(entry.status, 'active');
    assert.equal(entry.resourceId, '2071816469849280514');
    const localBytes = await readFile(index.resolveEnvironmentIndexEntryPath(editorRoot, entry.relativePath));
    assert.equal(createHash('sha256').update(localBytes).digest('hex'), sha256);
    assert.equal(requests.length, 2);
    assert.match(requests[1].range ?? '', /^bytes=[1-9]\d*-$/);
    assert.equal(requests[1].ifRange, '"remote-environment-v1"');
    await run();
    assert.equal(requests.length, 2, '热缓存不应再次请求环境 GLB');
    assert.equal(unrelatedDownloads, 0, '无关大环境不得阻塞当前场景打开');
    await assert.rejects(sync.executeDataPlatformEnvironmentSync({
      baseUrl, editorRoot, contextKey: 'remote-http:wrong-source', expectedSourceKey: 'f'.repeat(24), dependencies,
    }), /来源不一致/);
    assert.equal(requests.length, 2);
    // 同样长度的本地文件损坏也必须触发下载修复，不能只比较清单版本和文件存在性。
    const corrupted = Buffer.from(localBytes);
    corrupted[corrupted.length - 1] ^= 0xff;
    await writeFile(index.resolveEnvironmentIndexEntryPath(editorRoot, entry.relativePath), corrupted);
    await run();
    assert.equal(requests.length, 3);
    assert.deepEqual(await readFile(index.resolveEnvironmentIndexEntryPath(editorRoot, entry.relativePath)), localBytes);
    await assert.rejects(sync.executeDataPlatformEnvironmentSync({
      baseUrl, editorRoot, contextKey: 'remote-http:missing-required', requiredResourceIds: ['9999'], dependencies,
    }), /当前场景引用的环境 9999 在远端不可用/);
    assert.equal(requests.length, 3);
    await sync.executeDataPlatformEnvironmentSync({
      baseUrl, editorRoot, contextKey: 'remote-http:empty-required', requiredResourceIds: [], dependencies,
    });
    assert.equal(requests.length, 3);
    assert.equal((await index.readDataPlatformEnvironmentIndex(editorRoot))?.entries[0].status, 'active', '空必需集合保留其他已验证缓存');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(editorRoot, { recursive: true, force: true });
  }
});
