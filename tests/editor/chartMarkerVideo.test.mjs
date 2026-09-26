import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine, RawTexture, Scene } from '@babylonjs/core';
import { createServer } from 'vite';

test('视频立标配置、历史与运行内容路由', async t => {
  const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] } });
  t.after(() => server.close());
  const previousWindow = globalThis.window;
  globalThis.window = { location: { protocol: 'http:', href: 'http://localhost/' }, addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.window = previousWindow; });
  await server.ssrLoadModule('/src/editor/model/chartMarker.ts');
  await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
  const { useEditorStore: store } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  const { normalizeChartMarker, resolveChartMarker } = await server.ssrLoadModule('/src/editor/model/chartMarker.ts');
  const { serializeScene, deserializeScene } = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
  const { SceneRuntime } = await server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
  const video = { contentType: 'video', videoUrl: 'https://media.example.test/watch?id=42',
    videoLoop: false, videoControls: false, videoFit: 'cover' };

  await t.test('规范化视频配置且拒绝不可发布的地址', () => {
    assert.deepEqual(normalizeChartMarker(video), video);
    assert.equal(normalizeChartMarker({ videoUrl: '  https://media.example.test/a.mp4  ' }).videoUrl, 'https://media.example.test/a.mp4');
    assert.equal(normalizeChartMarker({ videoUrl: 'https:media.example.test/a.mp4' }).videoUrl, 'https://media.example.test/a.mp4');
    for (const videoUrl of ['javascript:alert(1)', 'file:///C:/a.mp4', 'blob:https://a/id', 'rtsp://camera/live',
      'https://user:password@example.test/a.mp4', '/a.mp4', 'https://example.test/' + 'x'.repeat(4096)]) {
      assert.throws(() => normalizeChartMarker({ videoUrl }), /视频/);
    }
    assert.equal(normalizeChartMarker({ videoUrl: '' }).videoUrl, '');
    assert.throws(() => normalizeChartMarker({ videoFit: 'stretch' }));
    assert.equal(resolveChartMarker({}).contentType, 'screen');
    assert.equal(resolveChartMarker({}).videoLoop, true);
  });

  await t.test('保留大屏绑定、撤销重做与序列化', () => {
    store.getState().newScene();
    store.getState().createChartMarker();
    const id = store.getState().scene.selectedEntityId;
    store.getState().bindChartMarkerScreen(id, { id: 's', chartType: 'SCREEN', projectId: '1', screenId: '2', name: '大屏', screenUrl: 'https://screen.example.test/s' });
    store.getState().updateChartMarker(id, video);
    const read = () => store.getState().scene.entities[id].components;
    assert.equal(read().chartMarker.contentType, 'video');
    store.getState().undo();
    assert.equal(read().chartMarker.contentType, 'screen');
    store.getState().redo();
    const restored = deserializeScene(serializeScene(store.getState().scene));
    assert.deepEqual(restored.entities[id].components.chartMarker, read().chartMarker);
    assert.equal(restored.entities[id].components.dataPlatformScreen.screenUrl, 'https://screen.example.test/s');
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const runtime = new SceneRuntime(scene);
    try {
      const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
      restored.entities[id].components.dataPlatformScreen.thumbnailUrl = 'https://screen.example.test/thumbnail.png';
      runtime.dataPlatformScreenTextures.set(id, { url: restored.entities[id].components.dataPlatformScreen.thumbnailUrl, texture });
      runtime.sync(restored);
      const [item] = runtime.getDataPlatformScreenOverlayItems();
      assert.equal(item.screenUrl, video.videoUrl);
      assert.equal(item.screenId, undefined);
      assert.equal(item.projectId, undefined);
      assert.equal(item.name, restored.entities[id].name);
      assert.equal(runtime.dataPlatformScreenTextures.has(id), false, '视频不保留旧大屏缩略图资源');
      assert.equal(scene.textures.includes(texture), false);
      store.getState().updateChartMarker(id, { contentType: 'screen' });
      runtime.sync(store.getState().scene);
      assert.equal(runtime.getDataPlatformScreenOverlayItems()[0].screenUrl, 'https://screen.example.test/s');
      assert.equal(read().chartMarker.videoUrl, video.videoUrl);
      store.getState().selectEntity(id);
      store.getState().copySelectedEntities();
      store.getState().pasteEntityClipboard();
      const copiedId = store.getState().scene.selectedEntityId;
      assert.notEqual(copiedId, id);
      assert.equal(store.getState().scene.entities[copiedId].components.chartMarker.videoUrl, video.videoUrl);
      store.getState().updateChartMarker(copiedId, { videoUrl: '' });
      assert.equal(read().chartMarker.videoUrl, video.videoUrl);
    } finally { runtime.dispose(); scene.dispose(); engine.dispose(); }
  });
});
