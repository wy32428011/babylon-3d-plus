import assert from 'node:assert/strict';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';
const [transfer] = await importIsolatedTypeScriptModules<[typeof import('../../electron/ipc/dataPlatformTransfer')]>(['electron/ipc/dataPlatformTransfer.ts']);
const request = (response: Response, signal = new AbortController().signal) => transfer.requestDataPlatformJson({
  baseUrl: 'http://example.invalid', endpointPath: 'api/v1/models/detail', body: { id: '11' }, signal,
  timeoutMs: 1000, context: '查询模型', fetchImpl: async () => response,
});

test('HTTP业务错误保留原message并提供HTTP状态和机器可读业务code', async () => {
  await assert.rejects(request(new Response(JSON.stringify({ code: 'MODEL_NOT_FOUND', message: '模型不存在' }), { status: 400 })), (error: any) => {
    assert.equal(error.message, '查询模型返回 HTTP 400：模型不存在');
    assert.equal(error.httpStatus, 400); assert.equal(error.businessCode, 'MODEL_NOT_FOUND'); return true;
  });
});

test('普通文本HTTP错误也保留原message，成功JSON响应不改变', async () => {
  await assert.rejects(request(new Response('upstream unavailable', { status: 503 })), (error: any) => {
    assert.equal(error.message, '查询模型返回 HTTP 503：upstream unavailable');
    assert.equal(error.httpStatus, 503); assert.equal(error.businessCode, null); return true;
  });
  assert.deepEqual(await request(new Response('{"success":true,"data":{"id":"11"}}')), { success: true, data: { id: '11' } });
});

test('取消仍返回取消错误，不冒充HTTP资源不存在', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(request(new Response('{}'), controller.signal), /取消/);
});
