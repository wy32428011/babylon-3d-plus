import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { app, ipcMain } from 'electron';

const root = process.env.ZENDING_CURRENT_PROJECT_METADATA_ROOT;
if (!root) throw new Error('请通过 currentProjectMetadata.test.ts 运行隔离测试。');
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));
process.env.ZENDING_EDITOR_STORAGE_ROOT = path.join(root, 'workspace');
process.env.ZENDING_ALLOW_STORAGE_ROOT_OVERRIDE = '1';
app.disableHardwareAcceleration();

async function run() {
  const handlers = new Map();
  ipcMain.handle = (name, callback) => { handlers.set(name, callback); };
  const ipc = await import('../../dist-electron/ipc/dataPlatformIpc.js');
  ipc.registerDataPlatformIpc();
  const call = (name, request) => handlers.get(`data-platform:${name}`)({}, request);
  let latestVersionId = '200';
  let latestVersionNumber = 2;
  let listPackage = 'files/legacy.zip';
  let listVersionId = '100';
  let statusError = false;
  let deferredStatus = null;
  let statusStarted;
  let pageTwo = false;
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    requests.push({ url: request.url, body });
    const json = (data) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    const project = { id: '1', projectName: '当前远端工程', latestEditorProjectPackageUrl: listPackage,
      latestEditorProjectVersionId: listVersionId, latestEditorProjectId: listVersionId ? '10' : null,
      latestEditorProjectVersionNumber: listVersionId ? 1 : null };
    if (request.url === '/api/v1/projects/detail') return json({ success: true, data: { id: body.id, projectName: '详情未聚合' } });
    if (request.url === '/api/v1/projects/query') {
      const records = pageTwo && body.pageNum === 1 ? [{ id: '2', projectName: '其他项目' }] : [project];
      return json({ success: true, data: { records, total: pageTwo ? 2 : 1, pageNum: body.pageNum, pageSize: 1 } });
    }
    if (request.url === '/api/v1/digital-twin/projects/status') {
      const send = () => json(statusError ? { success: false, message: '远端查询失败' } : { success: true, data: {
        projectId: body.projectId, editorProjectId: latestVersionId ? '10' : null,
        latestVersionId, latestVersionNumber: latestVersionId ? latestVersionNumber : null, status: latestVersionId ? 'ONLINE' : 'UNBOUND',
        runtimeConfig: { projectId: body.projectId, runtimeEnabled: true },
      } });
      if (deferredStatus) { deferredStatus(send); statusStarted(); return; }
      return send();
    }
    response.writeHead(503); response.end('test download failure');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await call('saveConfig', { baseUrl });
    const current = await call('getProject', { projectId: '1' });
    assert.equal(current.latestEditorProjectVersionId, '200', '详情聚合为空时仍必须使用远端最新版本');
    assert.equal(current.latestEditorProjectPackageUrl, 'api/v1/editor/projects/10/versions/200/package/export');
    await call('listProjects');
    latestVersionId = '300';
    latestVersionNumber = 3;
    await assert.rejects(call('openProject', { projectId: '1' }));
    assert.ok(requests.some((request) => request.url === '/api/v1/editor/projects/10/versions/300/package/export'), '打开时重新获取版本，不能使用列表的100版');
    assert.ok(!requests.some((request) => request.url === '/files/legacy.zip'));
    assert.equal((await call('getProject', { projectId: '1' })).latestEditorProjectVersionNumber, 3);
    const requestsBeforeRollback = requests.length;
    latestVersionId = '200';
    latestVersionNumber = 2;
    await assert.rejects(call('openProject', { projectId: '1' }), /503/);
    assert.deepEqual(requests.slice(requestsBeforeRollback)
      .filter((request) => request.url.includes('/package/export')).map((request) => request.url),
    ['/api/v1/editor/projects/10/versions/200/package/export'], '发布中心回滚后必须下载旧版 SOURCE，不能复用缓存的300版');
    const rolledBack = await call('getProject', { projectId: '1' });
    assert.equal(rolledBack.latestEditorProjectVersionId, '200');
    assert.equal(rolledBack.latestEditorProjectVersionNumber, 2);
    statusError = true;
    await assert.rejects(call('openProject', { projectId: '1' }), /远端查询失败/);
    statusError = false;
    latestVersionId = null;
    pageTwo = true;
    const legacy = await call('getProject', { projectId: '1' });
    assert.equal(legacy.latestEditorProjectVersionId, '100', '未绑定的普通导入工程应实时查官方列表聚合');
    assert.ok(requests.some((request) => request.url === '/api/v1/projects/query' && request.body.pageNum === 2));
    listPackage = null;
    await assert.rejects(call('getProject', { projectId: '1' }), /缺少 SOURCE 地址/);
    listVersionId = null;
    assert.equal((await call('getProject', { projectId: '1' })).latestEditorProjectPackageUrl, null, '远端移除工程时不得复活缓存版本');
    let releaseCancelled;
    const cancellationStarted = new Promise((resolve) => { statusStarted = resolve; });
    deferredStatus = (send) => { releaseCancelled = send; };
    const downloadsBeforeCancel = requests.filter((request) => request.url.includes('/package/export')).length;
    const cancelledOpen = assert.rejects(call('openProject', { projectId: '1' }));
    await cancellationStarted;
    assert.equal(await call('cancelProjectLoading'), true, '元数据查询期间也必须能够取消');
    releaseCancelled();
    await cancelledOpen;
    assert.equal(requests.filter((request) => request.url.includes('/package/export')).length, downloadsBeforeCancel);
    let release;
    const started = new Promise((resolve) => { statusStarted = resolve; });
    deferredStatus = (send) => { release = send; };
    const pending = call('getProject', { projectId: '1' });
    await started;
    await call('saveConfig', { baseUrl: `${baseUrl}/changed` });
    release();
    await assert.rejects(pending, /地址或工作区已变化/);
    await assert.rejects(call('openProject', { projectId: '1' }), /最近一次数据中台列表/);
    console.log('current-project-metadata: 当前版本、回滚版本、重新获取、远端失败、普通导入、移除、取消及配置竞争通过');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

app.whenReady().then(run).then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
});
