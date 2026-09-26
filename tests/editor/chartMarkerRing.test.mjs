import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('环形图表立标的兼容、校验与持久化', async (t) => {
  const server = await createServer({
    configFile: false, root: process.cwd(), logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  t.after(() => server.close());
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.window = previousWindow; });
  const { CHART_MARKER_DEFAULTS, normalizeChartMarker, resolveChartMarker } = await server.ssrLoadModule('/src/editor/model/chartMarker.ts');
  const { serializeScene, deserializeScene } = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
  const { useEditorStore: store } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  const createMarker = () => {
    store.getState().newScene();
    store.getState().createChartMarker({ x: 3, y: 0, z: 4 });
    return store.getState().scene.selectedEntityId;
  };

  await t.test('环形内容平铺次数有限且只能为整数', () => {
    assert.equal(resolveChartMarker({}).ringRepeat, 4);
    for (const ringRepeat of [1, 4, 32]) assert.equal(normalizeChartMarker({ ringRepeat }).ringRepeat, ringRepeat);
    for (const ringRepeat of [0, 33, 1.5, NaN, Infinity, '4']) assert.throws(() => normalizeChartMarker({ ringRepeat }));
  });

  await t.test('新建与旧缺省均为矩形，解析及保存不向旧组件写回形状和半径', () => {
    const id = createMarker();
    assert.equal(CHART_MARKER_DEFAULTS.panelShape, 'plane');
    assert.equal(CHART_MARKER_DEFAULTS.ringRadius, 3);
    assert.equal(store.getState().scene.entities[id].components.chartMarker.panelShape, 'plane');
    for (const component of [{}, { screenName: '旧大屏', contentType: 'screen', faceCamera: false }]) {
      const snapshot = structuredClone(component);
      assert.equal(resolveChartMarker(component).panelShape, 'plane');
      assert.equal(resolveChartMarker(component).ringRadius, 3);
      assert.deepEqual(component, snapshot);
      assert.deepEqual(normalizeChartMarker(component), snapshot);
      const scene = structuredClone(store.getState().scene);
      scene.entities[id].components.chartMarker = component;
      const restored = deserializeScene(serializeScene(scene)).entities[id].components.chartMarker;
      assert.equal(Object.hasOwn(restored, 'panelShape'), false);
      assert.equal(Object.hasOwn(restored, 'ringRadius'), false);
      assert.equal(resolveChartMarker(restored).contentType, 'screen');
    }
  });

  await t.test('形状与半径支持合法边界且拒绝错误类型、非有限值和访问器', () => {
    const id = createMarker();
    for (const panelShape of ['plane', 'ring']) {
      for (const ringRadius of [0.1, 3, 10000]) {
        assert.deepEqual(normalizeChartMarker({ panelShape, ringRadius }), { panelShape, ringRadius });
      }
    }
    const invalid = [
      ...['cylinder', '', null, true, 1, {}, []].map((panelShape) => ({ panelShape })),
      ...[0, 0.099, 10000.1, -1, NaN, Infinity, -Infinity, '3', null, true, {}].map((ringRadius) => ({ ringRadius })),
    ];
    const scene = store.getState().scene;
    const history = store.getState().history;
    for (const patch of invalid) {
      assert.throws(() => normalizeChartMarker(patch), /图表立标/);
      store.getState().updateChartMarker(id, patch);
      assert.equal(store.getState().scene, scene);
      assert.equal(store.getState().history, history);
    }
    let accessed = false;
    for (const key of ['panelShape', 'ringRadius']) {
      const input = {};
      Object.defineProperty(input, key, { get() { accessed = true; return 3; } });
      assert.throws(() => normalizeChartMarker(input), /访问器/);
      assert.equal(accessed, false);
    }
    for (const patch of [{ panelShape: 'invalid' }, { ringRadius: 0 }]) {
      const saved = JSON.parse(serializeScene(scene));
      Object.assign(saved.scene.entities[id].components.chartMarker, patch);
      assert.throws(() => deserializeScene(JSON.stringify(saved)), /场景/);
    }
  });

  await t.test('环形与矩形切换保留面向相机设置、内容和变换，可撤销重做、保存重开及独立复制', () => {
    const id = createMarker();
    const read = () => store.getState().scene.entities[id];
    store.getState().bindChartMarkerScreen(id, {
      id: 'screen-ring', chartType: 'SCREEN', projectId: 'project', screenId: 'screen',
      name: '环形设备看板', screenUrl: 'https://screen.example.test/ring',
    });
    store.getState().updateChartMarker(id, { width: 1280, height: 240, faceCamera: true });
    const before = structuredClone(read());
    store.getState().updateChartMarker(id, { panelShape: 'ring', ringRadius: 4.5 });
    const ring = structuredClone(read());
    assert.equal(ring.components.chartMarker.panelShape, 'ring');
    assert.equal(ring.components.chartMarker.ringRadius, 4.5);
    assert.equal(ring.components.chartMarker.faceCamera, true);
    assert.equal(ring.components.chartMarker.contentType, 'screen');
    assert.deepEqual(ring.components.dataPlatformScreen, before.components.dataPlatformScreen);
    assert.deepEqual(ring.components.transform, before.components.transform);
    store.getState().undo();
    assert.deepEqual(read(), before);
    store.getState().redo();
    assert.deepEqual(read(), ring);
    let restored = deserializeScene(serializeScene(store.getState().scene));
    for (let count = 0; count < 3; count += 1) restored = deserializeScene(serializeScene(restored));
    assert.deepEqual(restored.entities[id].components, ring.components);
    assert.equal(restored.entities[id].id, ring.id);

    store.getState().updateChartMarker(id, { panelShape: 'plane' });
    assert.equal(read().components.chartMarker.faceCamera, true);
    assert.equal(read().components.chartMarker.ringRadius, 4.5);
    store.getState().undo();
    assert.deepEqual(read(), ring);
    const history = store.getState().history;
    store.getState().updateChartMarker(id, { panelShape: 'ring', ringRadius: 4.5 });
    assert.equal(store.getState().history, history, '相同设置不会新增撤销历史');

    store.getState().selectEntity(id);
    store.getState().copySelectedEntities();
    store.getState().pasteEntityClipboard();
    const copyId = store.getState().scene.selectedEntityId;
    const copy = store.getState().scene.entities[copyId];
    assert.notEqual(copyId, id);
    assert.deepEqual(copy.components.chartMarker, ring.components.chartMarker);
    assert.notEqual(copy.components.chartMarker, read().components.chartMarker);
    assert.deepEqual(copy.components.dataPlatformScreen, ring.components.dataPlatformScreen);
    store.getState().updateChartMarker(copyId, { ringRadius: 7, panelShape: 'plane' });
    assert.deepEqual(read(), ring);
  });
});
