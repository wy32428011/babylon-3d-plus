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
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.window = previousWindow; });
  const { useEditorStore: store } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  const { serializeScene, deserializeScene } = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
  const { CHART_MARKER_DEFAULTS, CHART_MARKER_MAX_IMAGE_LENGTH, CHART_MARKER_MAX_CLICK_EVENTS, CHART_MARKER_MAX_CLICK_ACTIONS, normalizeChartMarker, resolveChartMarker, getChartMarkerClickEvents } = await server.ssrLoadModule('/src/editor/model/chartMarker.ts');
  const asset = {
    id: 'data-platform-screen:1:2', chartType: 'SCREEN',
    projectId: '1', screenId: '2', name: '设备总览', screenName: '设备总览',
    screenUrl: 'https://screen.example.com/#/bigscreen/preview/2',
  };
  const themeScreen = {
    projectId: 'theme-project', screenId: 'theme-screen', name: '工站信息',
    screenUrl: 'https://screen.example.com/#/bigscreen/preview/theme-screen',
    thumbnailUrl: 'https://screen.example.com/theme-screen.png',
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
  assert.deepEqual(marker().components.chartMarker, CHART_MARKER_DEFAULTS);
  assert.deepEqual(deserializeScene(serializeScene(store.getState().scene)).entities[id].components.chartMarker, CHART_MARKER_DEFAULTS);

  await t.test('旧版空槽和大屏引用保持原渲染缺省，不写入新建默认', () => {
    for (const component of [{}, { screenName: '旧大屏' }]) {
      const scene = structuredClone(store.getState().scene);
      scene.entities[id].components.chartMarker = component;
      const restored = deserializeScene(serializeScene(scene)).entities[id].components.chartMarker;
      assert.deepEqual(restored, component);
      assert.equal(resolveChartMarker(restored).contentType, 'screen');
      assert.equal(resolveChartMarker(restored).floatHeight, 0);
      assert.equal(resolveChartMarker(restored).faceCamera, false);
      assert.equal(resolveChartMarker(restored).appearance, 'none');
    }
  });

  await t.test('图表面板的全部属性可编辑、撤销重做、持久化，重复更新不新增历史', () => {
    const properties = {
      contentType: 'builtin', text: '一次注液', fontSize: 42, marquee: true,
      backgroundImage: 'data:image/png;base64,aGVsbG8=', backgroundColor: '#023456',
      appearance: 'column', indicatorSize: 2, appearanceColor: '#abcdef',
      width: 480, height: 270, floatHeight: 3.5, faceCamera: false,
      driveMode: 'data', dataSourceEntityId: 'device-1', dataField: 'data.temperature', clickAction: 'focus',
    };
    store.getState().updateChartMarker(id, properties);
    assert.deepEqual(marker().components.chartMarker, { ...CHART_MARKER_DEFAULTS, ...properties });
    assert.deepEqual(marker().components.transform, transform);
    const history = store.getState().history;
    store.getState().updateChartMarker(id, { width: 480 });
    assert.equal(store.getState().history, history);
    store.getState().undo();
    assert.deepEqual(marker().components.chartMarker, CHART_MARKER_DEFAULTS);
    store.getState().redo();
    assert.equal(marker().components.chartMarker.text, '一次注液');
    const restored = deserializeScene(serializeScene(store.getState().scene)).entities[id];
    assert.deepEqual(restored.components.chartMarker, marker().components.chartMarker);
    assert.notEqual(restored.components.chartMarker, marker().components.chartMarker);
  });

  await t.test('字段验证拒绝无效数值、枚举、危险图片和访问器，并限制图片大小', () => {
    const scene = store.getState().scene;
    const history = store.getState().history;
    const invalidValues = [
      { fontSize: 0 }, { width: NaN }, { width: Infinity }, { width: 4097 }, { height: -1 },
      { floatHeight: -1 }, { indicatorSize: 0 }, { marquee: 'true' }, { faceCamera: 1 },
      { contentType: 'html' }, { appearance: 'unknown' }, { driveMode: 'script' }, { clickAction: 'javascript' },
      { backgroundColor: 'red' }, { appearanceColor: '#xyzxyz' }, { text: 'a'.repeat(4097) },
      ...['javascript:alert(1)', 'https://example.com/a.png', 'file:///C:/a.png',
        'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,!', 'data:image/png;base64,',
        'data:image/png;base64,AAA'].map((backgroundImage) => ({ backgroundImage })),
      { backgroundImage: 'data:image/png;base64,' + 'A'.repeat(CHART_MARKER_MAX_IMAGE_LENGTH) },
    ];
    for (const patch of invalidValues) {
      assert.throws(() => normalizeChartMarker(patch), /图表立标/);
      store.getState().updateChartMarker(id, patch);
      assert.equal(store.getState().scene, scene);
      assert.equal(store.getState().history, history);
    }
    for (const input of [null, [], new Date()]) assert.throws(() => normalizeChartMarker(input), /图表立标/);
    let accessed = false;
    assert.throws(() => normalizeChartMarker({ get text() { accessed = true; return 'bad'; } }), /访问器/);
    assert.equal(accessed, false);
    const image = 'data:image/webp;base64,' + 'A'.repeat(1024 * 1024);
    assert.equal(normalizeChartMarker({ backgroundImage: image }).backgroundImage, image);
    const source = { text: 'safe', unknown: '<script>' };
    assert.deepEqual(normalizeChartMarker(source), { text: 'safe' });
    assert.notEqual(normalizeChartMarker(source), source);
    const saved = JSON.parse(serializeScene(scene));
    saved.scene.entities[id].components.chartMarker.width = -1;
    assert.throws(() => deserializeScene(JSON.stringify(saved)), /场景/);
  });

  await t.test('绑定和替换保留实体及 Transform，撤销重做和清空可恢复', () => {
    assert.equal(store.getState().bindChartMarkerScreen(id, asset), true);
    assert.deepEqual(marker().components.transform, transform);
    assert.equal(marker().components.dataPlatformScreen.renderMode, 'iframe');
    assert.equal(marker().components.chartMarker.screenName, '设备总览');
    assert.equal(marker().components.chartMarker.contentType, 'screen');
    assert.equal(marker().components.chartMarker.text, '一次注液');
    assert.equal(marker().components.chartMarker.width, 480);
    const saved = deserializeScene(serializeScene(store.getState().scene)).entities[id];
    assert.deepEqual(saved.components, marker().components);
    assert.equal(store.getState().bindChartMarkerScreen(id, { ...asset, screenId: '3', name: '产线监控' }), true);
    store.getState().undo();
    assert.equal(marker().components.dataPlatformScreen.screenId, '2');
    store.getState().redo();
    assert.equal(marker().components.dataPlatformScreen.screenId, '3');
    assert.equal(store.getState().bindChartMarkerScreen(id, null), true);
    assert.equal(marker().components.dataPlatformScreen, undefined);
    assert.equal(marker().components.chartMarker.screenName, undefined);
    assert.equal(marker().components.chartMarker.contentType, 'screen');
    assert.equal(marker().components.chartMarker.width, 480);
    assert.equal(marker().components.chartMarker.text, '一次注液');
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

  await t.test('多动作事件可撤销重做并持久化，旧版动作兼容且新列表优先', () => {
    const before = structuredClone(marker().components.chartMarker);
    const events = [{ type: 'left-click', actions: [
      { type: 'focus', targetEntityId: id }, { type: 'select', targetEntityId: 'external-object' }, { type: 'refresh' },
    ] }, { type: 'left-click', actions: [] }];
    store.getState().updateChartMarker(id, { clickEvents: events, clickAction: 'none' });
    assert.deepEqual(marker().components.chartMarker.clickEvents, events);
    assert.notEqual(marker().components.chartMarker.clickEvents, events);
    events[0].actions[0].targetEntityId = 'mutated-input';
    assert.equal(marker().components.chartMarker.clickEvents[0].actions[0].targetEntityId, id);
    const expected = structuredClone(marker().components.chartMarker);
    store.getState().undo();
    assert.deepEqual(marker().components.chartMarker, before);
    store.getState().redo();
    assert.deepEqual(marker().components.chartMarker, expected);
    const restored = deserializeScene(serializeScene(store.getState().scene));
    assert.deepEqual(restored.entities[id].components.chartMarker, expected);
    assert.notEqual(restored.entities[id].components.chartMarker.clickEvents[0].actions[0], marker().components.chartMarker.clickEvents[0].actions[0]);
    assert.deepEqual(getChartMarkerClickEvents({ clickAction: 'focus' }, id), [{ type: 'left-click', actions: [{ type: 'focus', targetEntityId: id }] }]);
    assert.deepEqual(getChartMarkerClickEvents({ clickAction: 'refresh', clickEvents: [] }, id), [{ type: 'left-click', actions: [{ type: 'refresh' }] }]);
    assert.deepEqual(getChartMarkerClickEvents({ clickAction: 'none', clickEvents: [] }, id), []);
    assert.deepEqual(getChartMarkerClickEvents({ clickAction: 'focus', clickEvents: expected.clickEvents }, id), expected.clickEvents);
    assert.deepEqual(normalizeChartMarker({}), {});
  });

  await t.test('事件结构拒绝未知动作、超量、访问器和稀疏数组，失效引用保持可编辑', () => {
    const event = (actions) => ({ type: 'left-click', actions });
    const invalid = [
      null, {}, [null], [{ type: 'right-click', actions: [] }], [event(null)], [event([{}])],
      [event([{ type: 'focus' }])], [event([{ type: 'select', targetEntityId: 'x'.repeat(129) }])],
      [event([{ type: 'execute', script: 'bad' }])], [event([{ type: 'refresh', targetEntityId: 'bad' }])],
      [{ type: 'left-click', actions: [], extra: true }],
      Array.from({ length: CHART_MARKER_MAX_CLICK_EVENTS + 1 }, () => event([])),
      [event(Array.from({ length: CHART_MARKER_MAX_CLICK_ACTIONS + 1 }, () => ({ type: 'refresh' })))],
      new Array(1), [event(new Array(1))], [new Date()],
    ];
    const scene = store.getState().scene;
    for (const clickEvents of invalid) {
      assert.throws(() => normalizeChartMarker({ clickEvents }), /图表立标/);
      store.getState().updateChartMarker(id, { clickEvents });
      assert.equal(store.getState().scene, scene);
    }
    let accessed = false;
    const accessorAction = { type: 'focus', get targetEntityId() { accessed = true; return id; } };
    const accessorEvent = { get type() { accessed = true; return 'left-click'; }, actions: [] };
    const accessorArray = [];
    Object.defineProperty(accessorArray, '0', { get() { accessed = true; return event([]); } });
    for (const clickEvents of [[event([accessorAction])], [accessorEvent], accessorArray]) {
      assert.throws(() => normalizeChartMarker({ clickEvents }), /访问器/);
      assert.equal(accessed, false);
    }
    const valid = [event([{ type: 'focus', targetEntityId: '' }, { type: 'select', targetEntityId: 'deleted-object' }])];
    assert.deepEqual(normalizeChartMarker({ clickEvents: valid }).clickEvents, valid);
    const boundary = Array.from({ length: CHART_MARKER_MAX_CLICK_EVENTS }, () => event(
      Array.from({ length: CHART_MARKER_MAX_CLICK_ACTIONS }, () => ({ type: 'refresh' })),
    ));
    assert.deepEqual(normalizeChartMarker({ clickEvents: boundary }).clickEvents, boundary);
    const saved = JSON.parse(serializeScene(scene));
    saved.scene.entities[id].components.chartMarker.clickEvents = [event([{ type: 'focus', targetEntityId: false }])];
    assert.throws(() => deserializeScene(JSON.stringify(saved)), /场景/);
  });

  await t.test('主题大屏绑定、替换和清空可保存及撤销，输入对象和恢复副本独立', () => {
    const before = structuredClone(marker().components.chartMarker);
    const source = structuredClone(themeScreen);
    const clickEvents = [{ type: 'left-click', actions: [{ type: 'theme', screen: source }, { type: 'theme' }] }];
    store.getState().updateChartMarker(id, { clickAction: 'none', clickEvents });
    const expected = structuredClone(marker().components.chartMarker);
    assert.deepEqual(expected.clickEvents, clickEvents);
    assert.notEqual(marker().components.chartMarker.clickEvents[0].actions[0].screen, source);
    source.name = '输入对象已变化';
    assert.equal(marker().components.chartMarker.clickEvents[0].actions[0].screen.name, '工站信息');
    store.getState().undo();
    assert.deepEqual(marker().components.chartMarker, before);
    store.getState().redo();
    assert.deepEqual(marker().components.chartMarker, expected);
    const restored = deserializeScene(serializeScene(store.getState().scene)).entities[id].components.chartMarker;
    assert.deepEqual(restored, expected);
    assert.notEqual(restored.clickEvents[0].actions[0].screen, marker().components.chartMarker.clickEvents[0].actions[0].screen);
    const replacement = [{ type: 'left-click', actions: [{ type: 'theme', screen: { ...themeScreen, screenId: 'other-screen', name: '设备信息' } }] }];
    store.getState().updateChartMarker(id, { clickEvents: replacement });
    assert.equal(marker().components.chartMarker.clickEvents[0].actions[0].screen.screenId, 'other-screen');
    store.getState().updateChartMarker(id, { clickEvents: [{ type: 'left-click', actions: [{ type: 'theme' }] }] });
    assert.deepEqual(marker().components.chartMarker.clickEvents[0].actions[0], { type: 'theme' });
    assert.deepEqual(deserializeScene(serializeScene(store.getState().scene)).entities[id].components.chartMarker.clickEvents[0].actions[0], { type: 'theme' });
    store.getState().undo();
    assert.deepEqual(marker().components.chartMarker.clickEvents, replacement);
  });

  await t.test('主题大屏拒绝危险或缺失地址、超长字段和访问器，未绑定动作可持久化', () => {
    const wrap = (action) => ({ clickEvents: [{ type: 'left-click', actions: [action] }] });
    const invalidScreens = [null, [], new Date(), undefined, {},
      { ...themeScreen, screenUrl: undefined }, { ...themeScreen, name: '' }, { ...themeScreen, screenId: ' ' },
      { ...themeScreen, projectId: false }, { ...themeScreen, projectId: 'x'.repeat(129) },
      { ...themeScreen, name: 'x'.repeat(129) }, { ...themeScreen, screenId: 'x'.repeat(129) },
      { ...themeScreen, screenUrl: 'https://example.com/' + 'x'.repeat(2048) },
      { ...themeScreen, thumbnailUrl: 'https://example.com/' + 'x'.repeat(2048) },
      { ...themeScreen, extra: true }, { ...themeScreen, thumbnailUrl: 3 },
      ...['javascript:alert(1)', 'file:///C:/screen.html', 'data:text/html,<h1>screen</h1>', '/relative', '', 'https://'].flatMap((url) => [
        { ...themeScreen, screenUrl: url }, { ...themeScreen, thumbnailUrl: url },
      ]),
    ];
    const scene = store.getState().scene;
    const history = store.getState().history;
    for (const screen of invalidScreens) {
      const patch = wrap({ type: 'theme', screen });
      assert.throws(() => normalizeChartMarker(patch), /图表立标/);
      store.getState().updateChartMarker(id, patch);
      assert.equal(store.getState().scene, scene);
      assert.equal(store.getState().history, history);
    }
    for (const action of [
      { type: 'theme', targetEntityId: id }, { type: 'theme', screen: themeScreen, targetEntityId: id },
      { type: 'focus', targetEntityId: id, screen: themeScreen }, { type: 'refresh', screen: themeScreen },
    ]) assert.throws(() => normalizeChartMarker(wrap(action)), /图表立标/);
    let accessed = false;
    for (const key of ['screenUrl', 'thumbnailUrl', 'name', 'unexpected']) {
      const screen = { ...themeScreen };
      Object.defineProperty(screen, key, { get() { accessed = true; return 'bad'; } });
      assert.throws(() => normalizeChartMarker(wrap({ type: 'theme', screen })), /访问器/);
      assert.equal(accessed, false);
    }
    const symbolScreen = { ...themeScreen, [Symbol('unexpected')]: true };
    assert.throws(() => normalizeChartMarker(wrap({ type: 'theme', screen: symbolScreen })), /未知字段/);
    const noThumbnail = { ...themeScreen }; delete noThumbnail.thumbnailUrl;
    assert.deepEqual(normalizeChartMarker(wrap({ type: 'theme', screen: noThumbnail })), wrap({ type: 'theme', screen: noThumbnail }));
    assert.deepEqual(normalizeChartMarker(wrap({ type: 'theme' })), wrap({ type: 'theme' }));
    const saved = JSON.parse(serializeScene(scene));
    saved.scene.entities[id].components.chartMarker = wrap({ type: 'theme', screen: { ...themeScreen, screenUrl: 'javascript:alert(1)' } });
    assert.throws(() => deserializeScene(JSON.stringify(saved)), /场景/);
  });

  await t.test('批量复制重映射自身和同批目标，保留外部目标且剪贴板和各次副本相互独立', () => {
    store.getState().createMesh('cube');
    const targetId = store.getState().scene.selectedEntityId;
    store.getState().createMesh('sphere');
    const externalId = store.getState().scene.selectedEntityId;
    const events = [{ type: 'left-click', actions: [
      { type: 'focus', targetEntityId: id },
      { type: 'select', targetEntityId: targetId },
      { type: 'select', targetEntityId: externalId },
      { type: 'theme', screen: themeScreen },
    ] }];
    store.getState().updateChartMarker(id, { clickEvents: events, clickAction: 'none' });
    store.getState().selectHierarchyEntities([id, targetId], id);
    store.getState().copySelectedEntities();
    const snapshot = structuredClone(store.getState().entityClipboard);
    const sourceEvents = marker().components.chartMarker.clickEvents;
    const clipboardEvents = store.getState().entityClipboard.entries.flatMap((entry) => entry.entities).find((entity) => entity.id === id).components.chartMarker.clickEvents;
    assert.notEqual(clipboardEvents[0].actions[0], sourceEvents[0].actions[0]);
    store.getState().pasteEntityClipboard();
    const copyIds = store.getState().hierarchySelectionIds;
    const copy = copyIds.map((copyId) => store.getState().scene.entities[copyId]).find((entity) => entity.components.chartMarker);
    const copiedTarget = copyIds.find((copyId) => copyId !== copy.id);
    const actions = copy.components.chartMarker.clickEvents[0].actions;
    assert.equal(actions[0].targetEntityId, copy.id);
    assert.equal(actions[1].targetEntityId, copiedTarget);
    assert.equal(actions[2].targetEntityId, externalId);
    assert.deepEqual(actions[3], { type: 'theme', screen: themeScreen });
    assert.notEqual(actions[3].screen, sourceEvents[0].actions[3].screen);
    assert.notEqual(actions[3].screen, clipboardEvents[0].actions[3].screen);
    assert.notEqual(actions[0], clipboardEvents[0].actions[0]);
    assert.notEqual(actions[0], sourceEvents[0].actions[0]);
    assert.deepEqual(store.getState().entityClipboard, snapshot);
    store.getState().pasteEntityClipboard();
    const secondCopy = store.getState().hierarchySelectionIds.map((copyId) => store.getState().scene.entities[copyId]).find((entity) => entity.components.chartMarker);
    assert.notEqual(secondCopy.id, copy.id);
    assert.equal(secondCopy.components.chartMarker.clickEvents[0].actions[0].targetEntityId, secondCopy.id);
    store.getState().updateChartMarker(copy.id, { clickEvents: [] });
    assert.deepEqual(marker().components.chartMarker.clickEvents, events);
    assert.equal(secondCopy.components.chartMarker.clickEvents[0].actions.length, 4);
    assert.deepEqual(secondCopy.components.chartMarker.clickEvents[0].actions[3].screen, themeScreen);
    assert.notEqual(secondCopy.components.chartMarker.clickEvents[0].actions[3].screen, actions[3].screen);
    assert.deepEqual(store.getState().entityClipboard, snapshot);
  });

  await t.test('普通立标阵列的自身目标跟随副本，保留外部目标并支持撤销重做', () => {
    const externalId = Object.values(store.getState().scene.entities).find((entity) => entity.components.meshRenderer && !entity.components.chartMarker).id;
    const events = [{ type: 'left-click', actions: [
      { type: 'focus', targetEntityId: id }, { type: 'select', targetEntityId: id },
      { type: 'select', targetEntityId: externalId }, { type: 'refresh' }, { type: 'theme', screen: themeScreen },
    ] }];
    store.getState().updateChartMarker(id, { clickEvents: events, clickAction: 'none' });
    const result = store.getState().commitResolvedEntityArray({
      sourceIds: [id], copyCount: 2, directionVector: { x: 1, y: 0, z: 0 },
      selectionSpanMeters: 4, spacingMeters: 2, assetNumberRule: '',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.createdCount, 2);
    for (const copyId of result.duplicatedIds) {
      const actions = store.getState().scene.entities[copyId].components.chartMarker.clickEvents[0].actions;
      assert.deepEqual(actions, [
        { type: 'focus', targetEntityId: copyId }, { type: 'select', targetEntityId: copyId },
        { type: 'select', targetEntityId: externalId }, { type: 'refresh' }, { type: 'theme', screen: themeScreen },
      ]);
      assert.notEqual(actions[0], marker().components.chartMarker.clickEvents[0].actions[0]);
      assert.notEqual(actions[4].screen, marker().components.chartMarker.clickEvents[0].actions[4].screen);
    }
    assert.deepEqual(marker().components.chartMarker.clickEvents, events);
    store.getState().undo();
    for (const copyId of result.duplicatedIds) assert.equal(store.getState().scene.entities[copyId], undefined);
    store.getState().redo();
    for (const copyId of result.duplicatedIds) assert.equal(store.getState().scene.entities[copyId].components.chartMarker.clickEvents[0].actions[0].targetEntityId, copyId);
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
    const lockedScene = store.getState().scene;
    store.getState().updateChartMarker(id, { text: '不得修改' });
    assert.equal(store.getState().scene, lockedScene);
    store.setState((state) => ({ runtimeMode: 'preview', scene: { ...state.scene, entities: { ...state.scene.entities, [id]: { ...marker(), locked: false } } } }));
    const runtimeScene = store.getState().scene;
    const runtimeHistory = store.getState().history;
    store.getState().updateChartMarker(id, { text: '运行时不得修改' });
    assert.equal(store.getState().bindChartMarkerScreen(id, asset), false);
    assert.equal(store.getState().scene, runtimeScene);
    assert.equal(store.getState().history, runtimeHistory);
    store.setState({ runtimeMode: 'edit' });
  });
});
