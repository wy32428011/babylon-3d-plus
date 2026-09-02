import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('图表立标创建、绑定与持久化', async (t) => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  t.after(() => server.close());
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const { useEditorStore: store } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  const { serializeScene, deserializeScene } = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
  const asset = {
    id: 'data-platform-screen:1:2', chartType: 'SCREEN',
    projectId: '1', screenId: '2', name: '设备总览', screenName: '设备总览',
    screenUrl: 'https://screen.example.com/#/bigscreen/preview/2',
  };
  store.getState().newScene();
  assert.equal(typeof store.getState().createChartMarker, 'function', '图表立标必须有真实创建入口');
  store.getState().createChartMarker({ x: 3, y: 0, z: 4 });
  const id = store.getState().scene.selectedEntityId;
  const marker = () => store.getState().scene.entities[id];
  const transform = structuredClone(marker().components.transform);
  assert.deepEqual(transform.position, { x: 3, y: 1.125, z: 4 }, '标牌底部落地');
  assert.equal(transform.rotation.x, Math.PI / 2);
  assert.equal(marker().components.meshRenderer.meshKind, 'plane');
  assert.deepEqual(deserializeScene(serializeScene(store.getState().scene)).entities[id].components.chartMarker, {});

  await t.test('绑定和替换保留实体及 Transform，撤销重做和清空可恢复', () => {
    assert.equal(store.getState().bindChartMarkerScreen(id, asset), true);
    assert.deepEqual(marker().components.transform, transform);
    assert.equal(marker().components.dataPlatformScreen.renderMode, 'iframe');
    assert.equal(marker().components.chartMarker.screenName, '设备总览');
    const saved = deserializeScene(serializeScene(store.getState().scene)).entities[id];
    assert.deepEqual(saved.components, marker().components);
    assert.equal(store.getState().bindChartMarkerScreen(id, { ...asset, screenId: '3', name: '产线监控' }), true);
    store.getState().undo();
    assert.equal(marker().components.dataPlatformScreen.screenId, '2');
    store.getState().redo();
    assert.equal(marker().components.dataPlatformScreen.screenId, '3');
    assert.equal(store.getState().bindChartMarkerScreen(id, null), true);
    assert.equal(marker().components.dataPlatformScreen, undefined);
    assert.deepEqual(marker().components.chartMarker, {});
    store.getState().undo();
    assert.equal(marker().components.dataPlatformScreen.screenId, '3');
  });

  await t.test('复制立标保留独立绑定，清空副本不影响原立标', () => {
    store.getState().selectEntity(id);
    store.getState().copySelectedEntities();
    store.getState().pasteEntityClipboard();
    const copyId = store.getState().scene.selectedEntityId;
    assert.notEqual(copyId, id);
    const copy = store.getState().scene.entities[copyId];
    assert.deepEqual(copy.components.chartMarker, marker().components.chartMarker);
    assert.deepEqual(copy.components.dataPlatformScreen, marker().components.dataPlatformScreen);
    assert.notEqual(copy.components.chartMarker, marker().components.chartMarker);
    assert.equal(store.getState().bindChartMarkerScreen(copyId, null), true);
    assert.equal(marker().components.dataPlatformScreen.screenId, '3');
  });

  await t.test('非法地址、非大屏、普通实体和锁定目标不能绑定', () => {
    const before = store.getState().scene;
    for (const patch of [{ screenUrl: 'javascript:alert(1)' }, { chartType: 'BAR' }, { projectId: '' }, { screenUrl: undefined }]) {
      assert.equal(store.getState().bindChartMarkerScreen(id, { ...asset, ...patch }), false);
      assert.equal(store.getState().scene, before);
    }
    store.getState().createMesh('cube');
    assert.equal(store.getState().bindChartMarkerScreen(store.getState().scene.selectedEntityId, asset), false);
    store.setState((state) => ({ scene: { ...state.scene, entities: { ...state.scene.entities, [id]: { ...marker(), locked: true } } } }));
    assert.equal(store.getState().bindChartMarkerScreen(id, asset), false);
  });
});
