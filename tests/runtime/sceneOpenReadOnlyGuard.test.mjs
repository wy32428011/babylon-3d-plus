import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { classifySceneOpenReadOnlyRequest, matchSceneOpenExclusion, installSceneOpenNetGuard, sceneOpenQueryCanonicalJson } from '../../scripts/lib/sceneOpenReadOnlyGuard.mjs';

const baseUrl = 'http://172.16.3.27:38087', projectId = '2071816469849280514', modelId = '90071992547409931';
const request = (endpoint, body, method = 'POST', extra = {}) => classifySceneOpenReadOnlyRequest({ baseUrl, projectId, method, url: baseUrl + '/' + endpoint,
  body: body === undefined ? undefined : JSON.stringify(body), ...extra });
const sha = value => createHash('sha256').update(value).digest('hex');

test('仅已核实POST表/参数与字符串ID可用，未知invoke/发布/数值ID拒绝', () => {
  for (const [endpoint, body] of [['api/v1/projects/query', { pageNum: 1, pageSize: 12, projectName: '' }],
    ['api/v1/projects/detail', { id: projectId }], ['api/v1/digital-twin/projects/status', { projectId }],
    ['api/v1/models/detail', { id: modelId }], ['api/v1/models/query', { pageNum: 1, pageSize: 100, modelName: '', excludeIds: [] }],
    ['api/v1/combo-models/query', { pageNum: 1, pageSize: 100, comboModelName: '', excludeIds: [] }],
    ['api/v1/env-models/sync-manifest/query', { cursorId: null, pageSize: 200, manifestRevision: '90071992547409939' }],
    ['api/v1/skyboxes/query', { pageNum: 1, pageSize: 100, skyboxName: '' }],
    ['api/v1/bigscreen-icons/query', { pageNum: 1, pageSize: 200, iconSource: 'CUSTOM' }],
    [`api/v1/projects/${projectId}/config/screens/query`, { pageNum: 1, pageSize: 100, keyword: '' }]]) assert.equal(request(endpoint, body).allowed, true, endpoint);
  assert.equal(request('api/v1/projects/detail', { id: 42 }).allowed, false);
  assert.equal(request('api/v1/projects/detail', { id: projectId, force: true }).allowed, false);
  assert.equal(request('api/v1/digital-twin/publish-tasks/query', { projectId }).allowed, false);
  assert.equal(request('api/v1/dataflow/open/apis/all/invoke', {}).allowed, false);
  assert.equal(request('api/v1/models/query', { pageNum: 1, pageSize: 99, modelName: '', excludeIds: [] }).allowed, false);
});

test('不猜GET前缀，仅manifest精确URL；页面hash必须有正确iframe源证明', () => {
  const url = baseUrl + '/api/v1/files/exact.glb', exclusions = [{ kind: 'authorized-unavailable-screen', field: 'screenUrl', url: 'http://old/', originalUrl: 'http://old/#/preview/2100824337532211202' },
    { kind: 'authorized-unavailable-screen', field: 'thumbnailUrl', url: 'http://old/exact.png' }];
  assert.equal(request('api/v1/files/exact.glb', undefined, 'GET').allowed, false);
  assert.equal(request('api/v1/files/exact.glb', undefined, 'GET', { downloads: [{ url, role: 'model' }] }).allowed, true);
  assert.equal(matchSceneOpenExclusion(exclusions, { url: 'http://old/' }), null);
  assert.ok(matchSceneOpenExclusion(exclusions, { url: 'http://old/', frameSourceUrl: 'http://old/#/preview/2100824337532211202' }));
  assert.equal(matchSceneOpenExclusion(exclusions, { url: 'http://old/', frameSourceUrl: 'http://old/#/preview/999' }), null);
  assert.ok(matchSceneOpenExclusion(exclusions, { url: 'http://old/exact.png' }));
});

test('native guard只消费同一流并保留完整字节；未知GET在网络前拒绝', async () => {
  const bytes = new Uint8Array([0, 1, 2, 255]), url = baseUrl + '/exact.bin'; let calls = 0;
  const original = async () => { calls++; return new Response(bytes, { status: 200 }); }, net = { fetch: original };
  const guard = installSceneOpenNetGuard(net, { baseUrl, projectId, downloads: [{ url, role: 'source', declaredSha256: sha(bytes) }] });
  const response = await net.fetch(url, { method: 'GET', redirect: 'error' });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes); assert.equal(calls, 1);
  assert.equal(guard.state.receipts[0].actualSha256, sha(bytes)); assert.equal(guard.state.receipts[0].complete, true); assert.equal(guard.state.activeBodies, 0);
  await assert.rejects(net.fetch(baseUrl + '/unseen.bin', { redirect: 'error' }), /GET_NOT_IN_TRUSTED_MANIFEST/); assert.equal(calls, 1);
  await assert.rejects(net.fetch('http://secret:password@172.16.3.27:38087/unseen.bin?token=secret', { redirect: 'error' }), /INVALID_QUERY_OR_ID/);
  assert.equal(guard.state.receipts.at(-1).url, baseUrl + '/unseen.bin'); assert.equal(calls, 1);
  guard.restore(); assert.equal(net.fetch, original);
});

test('已声明SHA错误/查询声明漂移/重定向未知都失败，不学习新值', async () => {
  const url = baseUrl + '/exact.bin', net = { fetch: async () => new Response('different') };
  const guarded = installSceneOpenNetGuard(net, { baseUrl, projectId, downloads: [{ url, role: 'model', declaredSha256: 'a'.repeat(64) }] });
  const response = await net.fetch(url, { redirect: 'error' }); await assert.rejects(response.arrayBuffer(), /E3_DECLARED_DOWNLOAD_SHA_MISMATCH/);
  await assert.rejects(net.fetch(url), /REDIRECT_POLICY_UNCONFIRMED/); guarded.restore();
  const body = JSON.stringify({ id: projectId }), expected = { success: true, data: { id: projectId, revision: '1' } };
  const queryNet = { fetch: async () => new Response(JSON.stringify({ success: true, data: { id: projectId, revision: '2' } })) };
  const queryGuard = installSceneOpenNetGuard(queryNet, { baseUrl, projectId, downloads: [], queryEvidence: [{ endpoint: 'api/v1/projects/detail',
    bodySha256: sha(sceneOpenQueryCanonicalJson({ id: projectId })), responseSha256: sha(sceneOpenQueryCanonicalJson(expected)) }] });
  const result = await queryNet.fetch(baseUrl + '/api/v1/projects/detail', { method: 'POST', body, redirect: 'error' });
  await assert.rejects(result.text(), /E3_QUERY_DECLARATION_DRIFT_OR_UNCONFIRMED/); assert.equal(queryGuard.state.denied.length, 1); queryGuard.restore();
});

test('取消body不伪造完整SHA或留下active计数', async () => {
  const url = baseUrl + '/exact.bin', net = { fetch: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([1])); } })) };
  const guard = installSceneOpenNetGuard(net, { baseUrl, projectId, downloads: [{ url, role: 'model' }] });
  const response = await net.fetch(url, { redirect: 'error' }); const reader = response.body.getReader(); await reader.read(); await reader.cancel();
  assert.equal(guard.state.activeBodies, 0); assert.equal(guard.state.receipts[0].complete, false); assert.equal(guard.state.receipts[0].actualSha256, null); guard.restore();
});
