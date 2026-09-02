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
after(() => viteServer.close());

const { createEmptySceneDocument } = await viteServer.ssrLoadModule('/src/editor/model/SceneDocument.ts') as typeof import('../../src/editor/model/SceneDocument');
const {
  createDataPlatformViewportScreen,
  normalizeDataPlatformViewportScreen,
} = await viteServer.ssrLoadModule('/src/editor/model/dataPlatformScreen.ts') as typeof import('../../src/editor/model/dataPlatformScreen');
const { deserializeScene, serializeScene } = await viteServer.ssrLoadModule('/src/editor/project/SceneSerializer.ts') as typeof import('../../src/editor/project/SceneSerializer');
const {
  createViewportScreenClipPath,
  createViewportScreenMask,
} = await viteServer.ssrLoadModule('/src/runtime/babylon/DataPlatformViewportScreenOverlay.tsx') as typeof import('../../src/runtime/babylon/DataPlatformViewportScreenOverlay');
const {
  createDataPlatformScreenEmbedUrl,
  isDataPlatformScreenEmbedReady,
} = await viteServer.ssrLoadModule('/src/runtime/babylon/dataPlatformScreenBridge.ts') as typeof import('../../src/runtime/babylon/dataPlatformScreenBridge');

test('视窗大屏只保存公开地址和嵌入引用', () => {
  assert.deepEqual(createDataPlatformViewportScreen({
    projectId: 'project-1',
    screenId: 'screen-1',
    screenUrl: 'https://data.example.com/embed/screen-1',
    thumbnailUrl: 'https://data.example.com/screen-1.png',
  }), {
    projectId: 'project-1',
    screenId: 'screen-1',
    screenUrl: 'https://data.example.com/embed/screen-1',
    thumbnailUrl: 'https://data.example.com/screen-1.png',
    renderMode: 'iframe',
    sceneWindow: { x: 0.22, y: 0.1, width: 0.56, height: 0.8 },
  });
});

test('完整大屏以 v5 场景配置序列化，并兼容旧 v4 文件', () => {
  const scene = createEmptySceneDocument('视窗大屏');
  scene.sceneSettings.viewportScreen = createDataPlatformViewportScreen({
    projectId: 'project-1',
    screenId: 'screen-1',
    screenUrl: 'https://data.example.com/embed/screen-1',
  });

  const serialized = JSON.parse(serializeScene(scene)) as { version: number; scene: typeof scene };
  assert.equal(serialized.version, 5);
  assert.deepEqual(serialized.scene.sceneSettings.viewportScreen, scene.sceneSettings.viewportScreen);
  assert.deepEqual(deserializeScene(JSON.stringify(serialized)).sceneSettings.viewportScreen, scene.sceneSettings.viewportScreen);

  const legacy = { ...serialized, version: 4 };
  delete legacy.scene.sceneSettings.viewportScreen;
  assert.equal(deserializeScene(JSON.stringify(legacy)).sceneSettings.viewportScreen, null);
});

test('视窗大屏拒绝危险地址和完全不可渲染的资源', () => {
  assert.equal(normalizeDataPlatformViewportScreen({
    projectId: 'project-1',
    screenId: 'screen-1',
    screenUrl: 'javascript:alert(1)',
  }), null);
  assert.equal(normalizeDataPlatformViewportScreen({
    projectId: 'project-1',
    screenId: 'screen-1',
  }), null);
});

test('视窗大屏 Overlay 为中间 3D 场景窗口生成透明挖空 mask', () => {
  const mask = createViewportScreenMask({ x: 0.2, y: 0.1, width: 0.6, height: 0.8 });
  assert.equal(mask.maskSize, '100% 100%, 60% 80%');
  assert.equal(mask.maskPosition, '0 0, 20% 10%');
  assert.equal(mask.maskComposite, 'exclude');
  assert.equal(createViewportScreenClipPath({ x: 0.2, y: 0.1, width: 0.6, height: 0.8 }), 'M0 0H1V1H0Z M0.2 0.1H0.8V0.9H0.2Z');
});

test('iframe 使用原生嵌入协议，避免宿主 mask/clipPath 将文字栅格化', () => {
  assert.equal(
    createDataPlatformScreenEmbedUrl('https://data.example.com/#/bigscreen-designer/published/1', {
      x: 0.22,
      y: 0.1,
      width: 0.56,
      height: 0.8,
    }),
    'https://data.example.com/?zending3dEmbed=1&zending3dSceneWindow=0.220000%2C0.100000%2C0.560000%2C0.800000#/bigscreen-designer/published/1',
  );
  assert.equal(isDataPlatformScreenEmbedReady({
    channel: 'zending.data-platform-screen.embed',
    version: 1,
    type: 'embed.ready',
  }), true);
  assert.equal(isDataPlatformScreenEmbedReady({
    channel: 'zending.data-platform-screen.embed',
    version: 2,
    type: 'embed.ready',
  }), false);
});
