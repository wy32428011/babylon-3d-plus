import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ appType: 'custom', configFile: false, root: process.cwd(),
  server: { middlewareMode: true, hmr: false, watch: null, ws: false }, optimizeDeps: { noDiscovery: true } });
after(async () => { await server.close(); });
const { parsePlayerRuntimeConfig } = await server.ssrLoadModule('/src/player/runtimeConfig.ts') as typeof import('../../src/player/runtimeConfig.ts');

function fixture(viewer: Record<string, unknown> = {}, version: 1 | 2 = 1) {
  return { version, page: { title: 'R3', loadingText: '加载中', backgroundColor: '#141414' },
    paths: { scene: './project/scene.json', assetManifest: './project/asset-manifest.json', assetBase: './project/assets/' },
    viewer: { showGrid: false, allowCameraControl: true, showStatusOverlay: false, ...viewer },
    mqtt: { enabled: false, ip: '', address: '', topic: '', subscriptions: [], simulatorEnabled: false,
      simulatorAssetCode: '', simulatorScenario: 'cycle', simulatorIntervalMs: 500 },
    ...(version === 2 ? { digitalTwin: { projectId: '7', runtimeConfigEndpoint: './api/runtime' } } : {}) };
}

function withDocument(run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'https://viewer.example.test/' } });
  try { run(); } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

test('R3旧三字段Viewer配置保持原结构，未声明opaqueCanvas时不暗加新默认', () => withDocument(() => {
  for (const version of [1, 2] as const) {
    const parsed = parsePlayerRuntimeConfig(fixture({}, version));
    assert.deepEqual(parsed.viewer, { showGrid: false, allowCameraControl: true, showStatusOverlay: false });
    assert.equal(Object.hasOwn(parsed.viewer, 'opaqueCanvas'), false);
  }
}));

test('R3仅明确布尔值可启用或关闭opaqueCanvas，v1/v2均保留原其它Viewer参数', () => withDocument(() => {
  for (const version of [1, 2] as const) for (const opaqueCanvas of [true, false]) {
    assert.deepEqual(parsePlayerRuntimeConfig(fixture({ opaqueCanvas }, version)).viewer,
      { showGrid: false, allowCameraControl: true, showStatusOverlay: false, opaqueCanvas });
  }
}));

test('R3拒绝opaqueCanvas的非布尔值、拼写错误、未知字段和缺少旧必填字段', () => withDocument(() => {
  for (const opaqueCanvas of [undefined, null, 0, 1, 'true', {}, []]) {
    assert.throws(() => parsePlayerRuntimeConfig(fixture({ opaqueCanvas })), /viewer\.opaqueCanvas.*布尔/);
  }
  for (const fields of [{ opaqueCanvass: true }, { opaqueCanvas: true, unknown: false }]) {
    assert.throws(() => parsePlayerRuntimeConfig(fixture(fields)), /viewer.*字段必须严格/);
  }
  const missing = fixture({ opaqueCanvas: true }); Reflect.deleteProperty(missing.viewer, 'showGrid');
  assert.throws(() => parsePlayerRuntimeConfig(missing), /viewer.*字段必须严格/);
}));

test('R8运动分辨率必须显式布尔启用，旧Viewer格式保持兼容且可与opaqueCanvas组合', () => withDocument(() => {
  for (const version of [1, 2] as const) for (const adaptiveResolution of [false, true]) {
    const parsed = parsePlayerRuntimeConfig(fixture({ adaptiveResolution, opaqueCanvas: true }, version));
    assert.equal(parsed.viewer.adaptiveResolution, adaptiveResolution);
    assert.equal(parsed.viewer.opaqueCanvas, true);
  }
  for (const adaptiveResolution of [undefined, null, 1, 'true', {}]) {
    assert.throws(() => parsePlayerRuntimeConfig(fixture({ adaptiveResolution })), /viewer.adaptiveResolution.*布尔/);
  }
}));
