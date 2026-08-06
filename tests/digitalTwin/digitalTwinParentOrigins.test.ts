import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
const { parseDigitalTwinAllowedParentOrigins } = await viteServer.ssrLoadModule(
  '/src/player/runtimeConfig.ts',
) as typeof import('../../src/player/runtimeConfig.ts');
after(async () => {
  await viteServer.close();
});

test('缺省 integration 配置返回空白名单', () => {
  assert.deepEqual(parseDigitalTwinAllowedParentOrigins({ telemetryInterval: 1000 }), []);
});

test('显式 Origin 被规范化、去重且保留端口', () => {
  assert.deepEqual(parseDigitalTwinAllowedParentOrigins({
    integration: {
      allowedParentOrigins: [
        'https://screen.example.com/',
        'https://screen.example.com',
        'http://127.0.0.1:8000',
      ],
      futureField: true,
    },
  }), ['https://screen.example.com', 'http://127.0.0.1:8000']);
});

test('Origin 白名单拒绝通配符、凭据、路径、查询、片段和非 HTTP 协议', () => {
  for (const origin of [
    '*',
    'https://user:pass@screen.example.com',
    'https://screen.example.com/path',
    'https://screen.example.com?x=1',
    'https://screen.example.com#hash',
    'file:///C:/screen.html',
  ]) {
    assert.throws(
      () => parseDigitalTwinAllowedParentOrigins({ integration: { allowedParentOrigins: [origin] } }),
      /allowedParentOrigins/,
      origin,
    );
  }
});

test('Origin 白名单拒绝非数组和超量配置', () => {
  assert.throws(
    () => parseDigitalTwinAllowedParentOrigins({ integration: { allowedParentOrigins: 'https://screen.example.com' } }),
    /allowedParentOrigins/,
  );
  assert.throws(
    () => parseDigitalTwinAllowedParentOrigins({
      integration: { allowedParentOrigins: Array.from({ length: 65 }, (_, index) => `https://screen-${index}.example.com`) },
    }),
    /allowedParentOrigins/,
  );
});
