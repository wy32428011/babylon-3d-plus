import assert from 'node:assert/strict';
import test from 'node:test';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';

const entries = {
  scene: '/src/editor/model/SceneDocument.ts',
  serializer: '/src/editor/project/SceneSerializer.ts',
  assets: '/src/editor/assets/AssetDatabase.ts',
  store: '/src/editor/store/editorStore.ts',
  streaming: '/src/editor/cad/cadReferenceStreamingDxf.ts',
  commands: '/src/editor/commands/entityCommands.ts',
  cad: '/src/editor/cad/cadReferenceCore.ts',
  cadStatus: '/src/editor/cad/cadReferenceLoadStatus.ts',
};
const modules = await createP4SsrTestModules(Object.values(entries));
test.after(() => modules.close());
const { createAgvSpawnerEntity, createEmptySceneDocument } = await modules.ssrLoadModule(entries.scene);
const { deserializeScene, serializeScene } = await modules.ssrLoadModule(entries.serializer);
const { decodeBuiltInAssetDragPayload, encodeBuiltInAssetDragPayload } = await modules.ssrLoadModule(entries.assets);
const { parseCadReferenceDxfStream } = await modules.ssrLoadModule(entries.streaming);
const { importAgvCadMapCommand } = await modules.ssrLoadModule(entries.commands);
const { createCadReferenceComponentMetadata } = await modules.ssrLoadModule(entries.cad);

test('AGV产生器 POI 拖拽载荷通过内置资源白名单解码', () => {
  const encoded = encodeBuiltInAssetDragPayload({ kind: 'agv-spawner' });
  assert.deepEqual(decodeBuiltInAssetDragPayload(encoded), { kind: 'agv-spawner' });
});

test('AGV产生器复用设备生成组件并随场景保存地图和原点', () => {
  const entity = createAgvSpawnerEntity({ x: 4, y: 2, z: -3 });
  entity.components.deviceSpawner.spawnerCode = 'AGV-SPAWN';
  entity.components.deviceSpawner.templateEntityId = 'template-agv';
  entity.components.agvMap = {
    mapId: 'demo-loop-dispatch',
    showTrajectories: false,
    xAxis: '-z',
    yAxis: 'x',
    scale: 2.5,
  };
  const scene = createEmptySceneDocument('AGV');
  scene.entityIds = [entity.id];
  scene.entities = { [entity.id]: entity };

  const restored = deserializeScene(serializeScene(scene));
  const restoredEntity = restored.entities[entity.id];
  assert.equal(restoredEntity.name, 'AGV产生器');
  assert.deepEqual(restoredEntity.components.transform.position, { x: 4, y: 2, z: -3 });
  assert.deepEqual(restoredEntity.components.agvMap, entity.components.agvMap);
  assert.equal(restoredEntity.components.deviceSpawner.spawnerCode, 'AGV-SPAWN');
  assert.ok(restoredEntity.components.clickEventBinding);
});

test('Store 创建、地图编辑、撤销重做和复制保持完整 AGV 配置', async () => {
  const { useEditorStore } = await modules.ssrLoadModule(entries.store);
  const before = useEditorStore.getState();
  try {
    useEditorStore.setState({
      scene: createEmptySceneDocument('AGV编辑'),
      runtimeMode: 'edit',
      history: { undoStack: [], redoStack: [] },
      hierarchySelectionIds: [],
      entityClipboard: null,
    });
    useEditorStore.getState().createAgvSpawner({ x: 1, y: 0, z: 2 });
    const id = useEditorStore.getState().scene.selectedEntityId;
    assert.ok(id);
    const current = useEditorStore.getState().scene.entities[id].components.agvMap;
    useEditorStore.getState().updateSelectedAgvMap({
      ...current,
      mapId: 'demo-production-line',
      xAxis: '-z',
      yAxis: 'x',
      scale: 3,
    });
    assert.equal(useEditorStore.getState().scene.entities[id].components.agvMap.scale, 3);
    useEditorStore.getState().undo();
    assert.equal(useEditorStore.getState().scene.entities[id].components.agvMap.mapId, null);
    useEditorStore.getState().redo();
    assert.equal(useEditorStore.getState().scene.entities[id].components.agvMap.mapId, 'demo-production-line');

    useEditorStore.getState().copySelectedEntities();
    useEditorStore.getState().pasteEntityClipboard();
    const pastedId = useEditorStore.getState().scene.selectedEntityId;
    assert.notEqual(pastedId, id);
    assert.deepEqual(
      useEditorStore.getState().scene.entities[pastedId].components.agvMap,
      useEditorStore.getState().scene.entities[id].components.agvMap,
    );
  } finally {
    useEditorStore.setState(before, true);
  }
});

// 导出的中心线、箭头和编号分布在不同图层，折线首尾引用精确的点位圆心。
const dxf = (pairs) => [...pairs.flat(), ''].join('\r\n');
const circle = (x, y) => [[0, 'CIRCLE'], [8, 'Ndc8_Point'], [10, x], [20, y], [40, 100]];
const text = (layer, value, x) => [[0, 'TEXT'], [8, layer], [10, x], [20, 50], [40, 190], [1, value]];
const polyline = (points) => [
  [0, 'POLYLINE'], [8, 'Ndc8_TestPath'], [66, 1],
  ...points.flatMap(([x, y]) => [[0, 'VERTEX'], [10, x], [20, y]]),
  [0, 'SEQEND'],
];
function parseRouteFixture(includeArrow = true) {
  const content = dxf([
    [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    ...circle(0, 0), ...circle(1000, 0), ...circle(2000, 0),
    ...polyline([[0, 0], [500, 250], [1000, 0]]),
    ...(includeArrow ? polyline([[0, 0], [0, 0]]) : []),
    ...text('Ndc8_PointID', '1', -100), ...text('Ndc8_PointID', '2', 900), ...text('Ndc8_PointID', '3', 1900),
    ...text('Ndc8_TestPathID', '88', 450),
    [0, 'MTEXT'], [8, 'Labels'], [10, 500], [20, 250], [40, 190],
    [3, ' 转弯处  '], [1, '编号 '],
    [0, 'ENDSEC'], [0, 'EOF'],
  ]);
  return parseCadReferenceDxfStream(async () => new Response(content), { agvMap: { id: 'cad-test', name: '测试地图' } });
}

test('NDC8 的点位、折线、编号及底图使用同一米制原点，跟随场景保存和撤销', async () => {
  const parsed = await parseRouteFixture();
  assert.deepEqual(parsed.agvMap.nodes.map(({ id, x, y }) => [id, x, y]), [['1', 0, 0], ['2', 1, 0], ['3', 2, 0]]);
  assert.deepEqual(parsed.agvMap.tracks, [{
    id: '88', name: 'Ndc8_TestPath', fromNodeId: '1', toNodeId: '2', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.25 }, { x: 1, y: 0 }],
  }]);
  assert.equal(parsed.annotations.length, 5);
  assert.equal(parsed.annotations.find((label) => label.layerName === 'Labels').text, ' 转弯处  编号 ');
  assert.equal(parsed.agvMapOrigin.x, 1);
  const entity = createAgvSpawnerEntity();
  const scene = createEmptySceneDocument('AGV 地图');
  scene.entityIds = [entity.id];
  scene.entities = { [entity.id]: entity };
  const agvMap = entity.components.agvMap;
  const cadReference = {
    ...createCadReferenceComponentMetadata(parsed),
    sourcePath: 'C:/example/map.dxf',
    sourceUrl: 'editor-asset://local/map.dxf',
  };
  const command = importAgvCadMapCommand(entity.id, { agvMap }, {
    agvMap: { ...agvMap, mapId: parsed.agvMap.id, importedMap: parsed.agvMap }, cadReference,
  });
  const imported = command.execute(scene);
  const restored = deserializeScene(serializeScene(imported));
  assert.deepEqual(restored.entities[entity.id].components.agvMap.importedMap, parsed.agvMap);
  assert.deepEqual(restored.entities[entity.id].components.cadReference.agvMapOrigin, parsed.agvMapOrigin);
  assert.deepEqual(command.undo(imported).entities[entity.id], entity);
});

test('中心线与箭头配对不完整时阻止导入，避免遗漏路段', async () => {
  await assert.rejects(parseRouteFixture(false), /路线、箭头与编号数量不一致/);
});

test('重复上传只等待同一产生器的新 CAD 渲染结果', async (t) => {
  const { forgetCadReferenceLoadStatus, publishCadReferenceLoadStatus, waitForCadReferenceReady } =
    await modules.ssrLoadModule(entries.cadStatus);
  const entityId = 'agv-reimport';
  const before = 'editor-asset://local/old.dxf';
  const after = 'editor-asset://local/new.dxf';
  t.after(() => forgetCadReferenceLoadStatus(entityId));
  publishCadReferenceLoadStatus({ entityId, sourceUrl: before, state: 'ready', percent: 100, detail: '旧图' });
  const progress = [];
  const pending = waitForCadReferenceReady(entityId, after, { onProgress: (status) => progress.push(status.state) });
  forgetCadReferenceLoadStatus(entityId);
  publishCadReferenceLoadStatus({ entityId, sourceUrl: after, state: 'loading', percent: 1, detail: '新图' });
  publishCadReferenceLoadStatus({ entityId, sourceUrl: after, state: 'ready', percent: 100, detail: '新图' });
  await pending;
  assert.deepEqual(progress, ['loading', 'ready']);
});
