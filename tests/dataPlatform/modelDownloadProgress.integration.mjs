import assert from 'node:assert/strict';
import { app } from 'electron';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDataPlatformModelSync, getLatestDataPlatformModelSyncProgress,
  disposeDataPlatformModelSync } from '../../dist-electron/ipc/dataPlatformModelIncrementalSync.js';
import { cancelDataPlatformProjectLoading } from '../../dist-electron/ipc/dataPlatformProjectService.js';

async function main() {
const root = process.env.ZENDING_DOWNLOAD_PROGRESS_TEST_ROOT;
assert.ok(root && path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('model-byte-integration-'),
  '请使用 node scripts/test-model-download-progress.mjs 运行并清理此测试');
const userDataRoot = path.join(root, 'userdata');
mkdirSync(userDataRoot);
app.setPath('userData', userDataRoot);
const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 16384 }],
  bufferViews: [{ buffer: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126,
    count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 }));
const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
json.copy(padded);
const glb = Buffer.alloc(12 + 8 + padded.length + 8 + 16384);
glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20);
glb.writeUInt32LE(16384, 20 + padded.length); glb.writeUInt32LE(0x004e4942, 24 + padded.length);
Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).copy(glb, 28 + padded.length);
const server = createServer((request, response) => {
  request.resume();
  response.setHeader('Connection', 'close');
  if (request.url === '/model.glb') {
    response.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': glb.length });
    let offset = 0;
    const timer = setInterval(() => {
      response.write(glb.subarray(offset, offset + 1024)); offset += 1024;
      if (offset >= glb.length) { clearInterval(timer); response.end(); }
    }, 50);
    response.on('close', () => clearInterval(timer));
    return;
  }
  const records = request.url === '/api/v1/models/query'
    ? [{ id: '9007199254740993', modelName: '下载进度三角形', fileName: 'triangle.glb', fileUrl: '/model.glb' }] : [];
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ success: true, data: { records, total: records.length, pageNum: 1, pageSize: 100 } }));
});
try {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  assert.equal(startDataPlatformModelSync(`http://127.0.0.1:${address.port}`, root), true);
  const deadline = Date.now() + 20000;
  const observed = [];
  while (Date.now() < deadline) {
    const progress = getLatestDataPlatformModelSyncProgress();
    if (progress?.download && (!observed.length || observed.at(-1).downloadedBytes !== progress.download.downloadedBytes)) observed.push(progress.download);
    if (progress?.phase === 'failed') assert.fail(progress.error);
    if (progress?.phase === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getLatestDataPlatformModelSyncProgress()?.phase, 'completed');
  assert.ok(observed.some((item) => item.downloadedBytes > 0 && item.downloadedBytes < glb.length && item.totalBytes === glb.length));
  assert.ok(observed.every((item) => item.downloadedBytes <= glb.length), '绝对进度不能重复累加');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(startDataPlatformModelSync(`http://127.0.0.1:${address.port}`, root), true);
  await waitUntil(() => (getLatestDataPlatformModelSyncProgress()?.download?.downloadedBytes ?? 0) > 0);
  assert.equal(cancelDataPlatformProjectLoading(), true, '工程取消必须接入实际增量同步入口');
  await waitUntil(() => getLatestDataPlatformModelSyncProgress()?.phase === 'failed');
  assert.match(getLatestDataPlatformModelSyncProgress()?.error ?? '', /取消/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(startDataPlatformModelSync(`http://127.0.0.1:${address.port}`, root), true);
  await waitUntil(() => getLatestDataPlatformModelSyncProgress()?.phase === 'completed');
  console.log(JSON.stringify({ status: 'PASS', bytes: glb.length, intermediateSnapshots: observed.length,
    cancellationAndReopen: true, localHttpOnly: true }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await disposeDataPlatformModelSync();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  app.exit(process.exitCode ?? 0);
}
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, '同步阶段等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

void main().catch((error) => { console.error(error); app.exit(1); });
