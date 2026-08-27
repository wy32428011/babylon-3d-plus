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
const { parseDigitalTwinAllowedParentOrigins, parsePlayerRuntimeConfig } = await viteServer.ssrLoadModule(
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

test('Origin 白名单拒绝凭据、路径、查询、片段和非 HTTP 协议', () => {
  for (const origin of [
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

test('Origin 白名单支持独立通配符 * 表示任意来源', () => {
  assert.deepEqual(
    parseDigitalTwinAllowedParentOrigins({ integration: { allowedParentOrigins: ['*', 'https://screen.example.com/'] } }),
    ['*', 'https://screen.example.com'],
  );
  assert.deepEqual(
    parseDigitalTwinAllowedParentOrigins({ integration: { allowedParentOrigins: [' * '] } }),
    ['*'],
  );
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

test('Viewer 标题支持数据中台项目名称的 256 字符上限', () => {
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { baseURI: 'https://viewer.example.test/' },
  });
  const title = '项'.repeat(256);
  const createRuntimeConfig = (pageTitle: string) => ({
    version: 1,
    page: { title: pageTitle, loadingText: '场景加载中...', backgroundColor: '#141414' },
    paths: {
      scene: './project/scene.json',
      assetManifest: './project/asset-manifest.json',
      assetBase: './project/assets/',
    },
    viewer: { showGrid: false, allowCameraControl: true, showStatusOverlay: true },
    mqtt: {
      enabled: false,
      ip: '',
      address: '',
      topic: '',
      subscriptions: [],
      simulatorEnabled: false,
      simulatorAssetCode: '',
      simulatorScenario: 'cycle',
      simulatorIntervalMs: 500,
    },
  });

  try {
    assert.equal(parsePlayerRuntimeConfig(createRuntimeConfig(title)).page.title, title);
    assert.throws(
      () => parsePlayerRuntimeConfig(createRuntimeConfig(`${title}目`)),
      /runtime-config\.page\.title/,
    );
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    } else {
      delete (globalThis as typeof globalThis & { document?: Document }).document;
    }
  }
});
