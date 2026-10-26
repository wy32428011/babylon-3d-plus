import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createBusinessGiViewerServer } from '../helpers/phase2GiViewer.mjs';

test('GI本地Viewer仅允许精确只读运行配置POST，拒绝上传/多余字段/错项目且不写目录', async t => {
  const root = await fs.mkdtemp(path.resolve('output', '.phase2-gi-query-test-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve('output')); assert.ok(path.basename(root).startsWith('.phase2-gi-query-test-')); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, 'index.html'), '<p>local fixture</p>');
  const requests = [], hosted = await createBusinessGiViewerServer(root, '7', requests);
  t.after(async () => { await new Promise(resolve => hosted.server.close(resolve)); });
  const endpoint = hosted.origin + '/api/v1/digital-twin/runtime-config/detail';
  const post = (body, contentType = 'application/json; charset=utf-8') => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  const ready = await post(JSON.stringify({ projectId: '7' }));
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { success: true, data: { projectId: '7', runtimeEnabled: true, mqttBrokerUrl: null, apiBaseUrl: null, configJson: '{}' } });
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await post(JSON.stringify({ projectId: '8' }))).status, 403);
  assert.equal((await post(JSON.stringify({ projectId: '7', upload: true }))).status, 403);
  assert.equal((await post('{broken')).status, 400);
  assert.equal((await post(JSON.stringify({ projectId: '7' }), 'text/plain')).status, 415);
  assert.equal((await fetch(hosted.origin + '/upload', { method: 'POST', body: 'not allowed' })).status, 405);
  assert.deepEqual(await fs.readdir(root), ['index.html']);
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), '<p>local fixture</p>');
  assert.equal(requests.filter(row => row.readOnlyRuntimeQuery).length, 1);
});
