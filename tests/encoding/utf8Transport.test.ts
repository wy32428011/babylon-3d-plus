import assert from 'node:assert/strict';
import test from 'node:test';
import { requestDataPlatformJson } from '../../electron/ipc/dataPlatformTransfer.ts';
import { decodeUtf8Text } from '../../src/shared/text/strictUtf8.ts';

function createOptions(fetchImpl: typeof fetch) {
  return {
    baseUrl: 'http://127.0.0.1:8080',
    endpointPath: '/api/v1/projects/query',
    body: { projectName: '数字孪生🚀' },
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    context: '读取项目列表',
    fetchImpl,
  };
}

test('数据中台 JSON 请求明确声明 UTF-8 并原样传输 Unicode', async () => {
  let capturedHeaders: Headers | null = null;
  let capturedBody = '';
  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedHeaders = new Headers(init?.headers);
    capturedBody = String(init?.body ?? '');
    return new Response('{"success":true}', {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  };

  await requestDataPlatformJson(createOptions(fetchImpl));

  assert.equal(capturedHeaders?.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(capturedBody), { projectName: '数字孪生🚀' });
});

test('数据中台响应支持 UTF-8 BOM 且保留中文与 emoji', async () => {
  const payload = '\uFEFF{"name":"数字孪生🚀"}';
  const fetchImpl: typeof fetch = async () => new Response(new TextEncoder().encode(payload), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

  const result = await requestDataPlatformJson(createOptions(fetchImpl));

  assert.deepEqual(result, { name: '数字孪生🚀' });
});

test('数据中台响应包含非法 UTF-8 时明确报错而不是把替换字符显示到页面', async () => {
  const invalidUtf8 = Uint8Array.from([0x7b, 0x22, 0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  const fetchImpl: typeof fetch = async () => new Response(invalidUtf8, {
    status: 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

  await assert.rejects(
    requestDataPlatformJson(createOptions(fetchImpl)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /UTF-8/u);
      assert.doesNotMatch(error.message, /\uFFFD/u);
      return true;
    },
  );
});

test('浏览器文本边界严格解码 UTF-8 并兼容 BOM', () => {
  const encoded = new TextEncoder().encode('\uFEFF中文🚀');
  assert.equal(decodeUtf8Text(encoded, '场景文件'), '中文🚀');
  assert.throws(
    () => decodeUtf8Text(Uint8Array.from([0xc3, 0x28]), '场景文件'),
    /场景文件不是有效的 UTF-8 文本/u,
  );
});
