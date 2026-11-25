import assert from 'node:assert/strict';
import test from 'node:test';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';

const entries = {
  scene: '/src/editor/model/SceneDocument.ts',
  serializer: '/src/editor/project/SceneSerializer.ts',
  assets: '/src/editor/assets/AssetDatabase.ts',
  store: '/src/editor/store/editorStore.ts',
  agvMap: '/src/editor/model/agvMap.ts',
  streaming: '/src/editor/cad/cadReferenceStreamingDxf.ts',
  commands: '/src/editor/commands/entityCommands.ts',
  cad: '/src/editor/cad/cadReferenceCore.ts',
  cadStatus: '/src/editor/cad/cadReferenceLoadStatus.ts',
  spawner: '/src/editor/model/deviceSpawner.ts',
  hierarchy: '/src/editor/store/slices/sceneHierarchyOperations.ts',
  labelTitle: '/src/shared/ui/truncatedLabelTitle.ts',
};
const modules = await createP4SsrTestModules(Object.values(entries));
test.after(() => modules.close());
const { createAgvSpawnerEntity, createEmptySceneDocument } = await modules.ssrLoadModule(entries.scene);
const { deserializeScene, serializeScene } = await modules.ssrLoadModule(entries.serializer);
const { decodeBuiltInAssetDragPayload, encodeBuiltInAssetDragPayload } = await modules.ssrLoadModule(entries.assets);
const { resolveAgvMapNodeId, sanitizeAgvMapDefinition } = await modules.ssrLoadModule(entries.agvMap);
const { parseCadReferenceDxfStream } = await modules.ssrLoadModule(entries.streaming);
const { importAgvCadMapCommand } = await modules.ssrLoadModule(entries.commands);
const { createCadReferenceComponentMetadata } = await modules.ssrLoadModule(entries.cad);
const {
  isAgvSpawnerTemplateEntity,
  sanitizeDeviceSpawnerComponent,
} = await modules.ssrLoadModule(entries.spawner);
const { deleteEntitiesInScene } = await modules.ssrLoadModule(entries.hierarchy);
const { getTruncatedLabelText } = await modules.ssrLoadModule(entries.labelTitle);

test('右侧栏配置标签只在文字截断时提供完整悬停文本', () => {
  assert.equal(getTruncatedLabelText({ textContent: '路径不透明度 (%)', scrollWidth: 120, clientWidth: 52 }), '路径不透明度 (%)');
  assert.equal(getTruncatedLabelText({ textContent: '名称', scrollWidth: 24, clientWidth: 52 }), null);
  assert.equal(getTruncatedLabelText({ textContent: '  ', scrollWidth: 120, clientWidth: 52 }), null);
});

test('AGV产生器 POI 拖拽载荷通过内置资源白名单解码', () => {
  const encoded = encodeBuiltInAssetDragPayload({ kind: 'agv-spawner' });
  assert.deepEqual(decodeBuiltInAssetDragPayload(encoded), { kind: 'agv-spawner' });
});

test('AGV产生器复用设备生成组件并随场景保存地图和原点', () => {
  const entity = createAgvSpawnerEntity({ x: 4, y: 2, z: -3 });
  entity.components.deviceSpawner.spawnerCode = 'AGV-SPAWN';
  entity.components.deviceSpawner.templateEntityId = 'template-agv';
  entity.components.deviceSpawner.templateRules = [{
    id: 'heavy-agv',
    attributeName: 'vehicle_type',
    attributeValue: 'heavy',
    templateEntityId: 'template-heavy-agv',
  }];
  entity.components.agvMap = {
    mapId: 'demo-loop-dispatch',
    showTrajectories: false,
    showBaseMap: false,
    nodeRadius: 1.5,
    routeHighlight: {
      enabled: true,
      style: 'flow-arrows',
      remainingColor: '#20d9ff',
      width: 0.3,
      opacity: 0.8,
      speed: 1.2,
      amount: 8,
    },
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
  assert.deepEqual(restoredEntity.components.deviceSpawner.templateRules, entity.components.deviceSpawner.templateRules);
  assert.ok(restoredEntity.components.clickEventBinding);
});

test('AGV 模板只接受 agv 前缀，旧场景补空规则且删除模板会清理规则引用', () => {
  const legacy = sanitizeDeviceSpawnerComponent({
    spawnerCode: 'AGV-SPAWN',
    templateEntityId: 'template-agv',
    timeoutSeconds: 30,
  });
  assert.deepEqual(legacy.templateRules, []);

  const createTemplate = (id, deviceType) => ({
    id,
    name: id,
    parentId: null,
    childrenIds: [],
    components: { modelAsset: { deviceType } },
  });
  const defaultTemplate = createTemplate('template-agv', 'agv');
  const heavyTemplate = createTemplate('template-heavy', 'AGV_FORKLIFT');
  const otherTemplate = createTemplate('template-other', 'conveyor');
  assert.equal(isAgvSpawnerTemplateEntity(defaultTemplate), true);
  assert.equal(isAgvSpawnerTemplateEntity(heavyTemplate), true);
  assert.equal(isAgvSpawnerTemplateEntity(otherTemplate), false);

  const spawner = createAgvSpawnerEntity();
  spawner.components.deviceSpawner.templateEntityId = defaultTemplate.id;
  spawner.components.deviceSpawner.templateRules = [{
    id: 'heavy',
    attributeName: 'vehicle_type',
    attributeValue: 'heavy',
    templateEntityId: heavyTemplate.id,
  }];
  const scene = createEmptySceneDocument('AGV模板');
  scene.entityIds = [spawner.id, defaultTemplate.id, heavyTemplate.id, otherTemplate.id];
  scene.entities = Object.fromEntries([
    spawner, defaultTemplate, heavyTemplate, otherTemplate,
  ].map((entity) => [entity.id, entity]));

  const withoutHeavy = deleteEntitiesInScene(scene, [heavyTemplate.id]);
  assert.equal(
    withoutHeavy.entities[spawner.id].components.deviceSpawner.templateRules[0].templateEntityId,
    null,
    '规则模板删除后保留规则并回退默认模板',
  );
  assert.equal(withoutHeavy.entities[spawner.id].components.deviceSpawner.templateEntityId, defaultTemplate.id);
  const withoutDefault = deleteEntitiesInScene(scene, [defaultTemplate.id]);
  assert.equal(withoutDefault.entities[spawner.id].components.deviceSpawner.templateEntityId, null);
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

    const spawner = useEditorStore.getState().scene.entities[id].components.deviceSpawner;
    useEditorStore.getState().updateSelectedDeviceSpawner({
      ...spawner,
      templateRules: [{
        id: 'copy-rule',
        attributeName: 'vehicle_type',
        attributeValue: 'heavy',
        templateEntityId: 'template-heavy-agv',
      }],
    });
    useEditorStore.getState().copySelectedEntities();
    useEditorStore.getState().pasteEntityClipboard();
    const pastedId = useEditorStore.getState().scene.selectedEntityId;
    assert.notEqual(pastedId, id);
    assert.deepEqual(
      useEditorStore.getState().scene.entities[pastedId].components.agvMap,
      useEditorStore.getState().scene.entities[id].components.agvMap,
    );
    assert.deepEqual(
      useEditorStore.getState().scene.entities[pastedId].components.deviceSpawner.templateRules,
      useEditorStore.getState().scene.entities[id].components.deviceSpawner.templateRules,
    );
  } finally {
    useEditorStore.setState(before, true);
  }
});

// 导出的中心线、箭头和编号分布在不同图层，折线首尾引用精确的点位圆心。
const dxf = (pairs) => [...pairs.flat(), ''].join('\r\n');
const circle = (x, y) => [[0, 'CIRCLE'], [8, 'Ndc8_Point'], [10, x], [20, y], [40, 100]];
const text = (layer, value, x) => [[0, 'TEXT'], [8, layer], [10, x], [20, 50], [40, 190], [1, value]];
const polyline = (points, layer = 'Ndc8_TestPath') => [
  [0, 'POLYLINE'], [8, layer], [66, 1],
  ...points.flatMap(([x, y]) => [[0, 'VERTEX'], [10, x], [20, y]]),
  [0, 'SEQEND'],
];
const lwpolyline = (points, layer = 'Ndc8_TestPath') => [
  [0, 'LWPOLYLINE'], [8, layer], [90, points.length],
  ...points.flatMap(([x, y]) => [[10, x], [20, y]]),
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

test('LWPOLYLINE 优化保存省略无箭头占位、或同层混合有无箭头与退化占位时正确提取全部路线', async () => {
  const noArrowParsed = await parseRouteFixture(false);
  assert.deepEqual(noArrowParsed.agvMap.tracks, [{
    id: '88', name: 'Ndc8_TestPath', fromNodeId: '1', toNodeId: '2', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.25 }, { x: 1, y: 0 }],
  }]);

  // 路线写在 Ndc8_Point 之前，并混合真实三角箭头、省略箭头、退化 (0,0) 占位和整层无箭头图层。
  const mixedContent = dxf([
    [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    ...lwpolyline([[0, 0], [1000, 0]], 'Ndc8_Mixed'),
    ...lwpolyline([[400, -50], [600, 0], [400, 50], [400, -50]], 'Ndc8_Mixed'),
    ...lwpolyline([[1000, 0], [2000, 0]], 'Ndc8_Mixed'),
    ...lwpolyline([[2000, 0], [1000, 0]], 'Ndc8_Mixed'),
    ...lwpolyline([[0, 0], [0, 0]], 'Ndc8_Mixed'),
    ...lwpolyline([[2000, 0], [0, 0]], 'Ndc8_NoArrowLayer'),
    ...circle(0, 0), ...circle(1000, 0), ...circle(2000, 0),
    ...text('Ndc8_PointID', '1', -100), ...text('Ndc8_PointID', '2', 900), ...text('Ndc8_PointID', '3', 1900),
    ...text('Ndc8_MixedID', '101', 500), ...text('Ndc8_MixedID', '102', 1500), ...text('Ndc8_MixedID', '103', 1500),
    ...text('Ndc8_NoArrowLayerID', '201', 1000),
    [0, 'ENDSEC'], [0, 'EOF'],
  ]);
  const mixed = await parseCadReferenceDxfStream(async () => new Response(mixedContent), {
    agvMap: { id: 'cad-mixed', name: '混合箭头地图' },
  });
  assert.deepEqual(
    mixed.agvMap.tracks.map(({ id, name, fromNodeId, toNodeId }) => [id, name, fromNodeId, toNodeId]),
    [
      ['101', 'Ndc8_Mixed', '1', '2'],
      ['102', 'Ndc8_Mixed', '2', '3'],
      ['103', 'Ndc8_Mixed', '3', '2'],
      ['201', 'Ndc8_NoArrowLayer', '3', '1'],
    ],
  );
});

test('中心线端点偏离点位、数量与编号不一致或出现多余箭头时阻止导入', async () => {
  const misalignedEndpoint = dxf([
    [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    ...circle(0, 0), ...circle(1000, 0),
    ...lwpolyline([[0, 0], [999, 0]]),
    ...text('Ndc8_PointID', '1', -100), ...text('Ndc8_PointID', '2', 900),
    ...text('Ndc8_TestPathID', '88', 450),
    [0, 'ENDSEC'], [0, 'EOF'],
  ]);
  await assert.rejects(
    parseCadReferenceDxfStream(async () => new Response(misalignedEndpoint), { agvMap: { id: 'cad-bad-1', name: '错端点' } }),
    /有效路线中心线（0）与编号数量（1）不一致/,
  );

  const extraArrow = dxf([
    [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    ...circle(0, 0), ...circle(1000, 0),
    ...lwpolyline([[0, 0], [1000, 0]]),
    ...lwpolyline([[400, -50], [600, 0], [400, 50]]),
    ...lwpolyline([[450, -50], [650, 0], [450, 50]]),
    ...text('Ndc8_PointID', '1', -100), ...text('Ndc8_PointID', '2', 900),
    ...text('Ndc8_TestPathID', '88', 450),
    [0, 'ENDSEC'], [0, 'EOF'],
  ]);
  await assert.rejects(
    parseCadReferenceDxfStream(async () => new Response(extraArrow), { agvMap: { id: 'cad-bad-2', name: '多余箭头' } }),
    /多余或错位的箭头图元/,
  );
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

test('NDC8 业务站点（Ndc8_Activity_*）提取精确/容差节点映射、隔离撞号并随场景序列化', async () => {
  const activityCircle = (layer, x, y) => [[0, 'CIRCLE'], [8, layer], [10, x], [20, y], [40, 200]];
  const mtext = (layer, value, x) => [[0, 'MTEXT'], [8, layer], [10, x], [20, 50], [40, 190], [1, value]];
  const content = dxf([
    [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    ...circle(0, 0),
    ...circle(1000, 0),
    ...circle(2000, 0),
    ...text('Ndc8_PointID', '1', 0),
    ...text('Ndc8_PointID', '2318', 1000),
    ...text('Ndc8_PointID', '1974', 2000),
    ...lwpolyline([[0, 0], [1000, 0]], 'Ndc8_Main'),
    ...lwpolyline([[1000, 0], [2000, 0]], 'Ndc8_Main'),
    ...text('Ndc8_MainID', 'T1', 500),
    ...text('Ndc8_MainID', 'T2', 1500),
    // 精确重合的站点 633 -> 2318，以及与路网点 1 撞号但实际位于 1974 附近（偏移 16 mm）的站点 1
    ...activityCircle('Ndc8_Activity_焊接线站点', 1000, 0),
    ...activityCircle('Ndc8_Activity_焊接线站点', 2016, 0),
    ...text('Ndc8_Activity_焊接线站点ID', '633', 1000),
    ...text('Ndc8_Activity_焊接线站点ID', '1', 2016),
    ...mtext('Ndc8_Activity_焊接线站点Name', '633', 1000),
    ...mtext('Ndc8_Activity_焊接线站点Name', '1974', 2016),
    [0, 'ENDSEC'], [0, 'EOF'],
  ]);
  const parsed = await parseCadReferenceDxfStream(async () => new Response(content), {
    agvMap: { id: 'cad-stations', name: '含站点地图' },
  });
  assert.deepEqual(parsed.agvMap.stations, [
    { id: '633', name: '633', nodeId: '2318', x: 1, y: 0, businessType: '焊接线站点' },
    { id: '1', name: '1974', nodeId: '1974', x: 2.016, y: 0, businessType: '焊接线站点' },
  ]);
  assert.equal(resolveAgvMapNodeId(parsed.agvMap, '633'), '2318');
  assert.equal(resolveAgvMapNodeId(parsed.agvMap, '1'), '1974');
  assert.equal(resolveAgvMapNodeId(parsed.agvMap, '2318'), '2318');
  assert.equal(resolveAgvMapNodeId(parsed.agvMap, '9999'), null);

  const entity = createAgvSpawnerEntity({ x: 0, y: 0, z: 0 });
  entity.components.agvMap = {
    ...entity.components.agvMap,
    mapId: parsed.agvMap.id,
    importedMap: parsed.agvMap,
  };
  const scene = createEmptySceneDocument('AGV站点序列化');
  scene.entityIds = [entity.id];
  scene.entities = { [entity.id]: entity };
  const restored = deserializeScene(serializeScene(scene));
  assert.deepEqual(restored.entities[entity.id].components.agvMap.importedMap, parsed.agvMap);
});

test('NDC8 业务站点偏离路网点超过容差、数量不一致或 JSON 引用无效节点时阻止导入', async () => {
  const activityCircle = (layer, x, y) => [[0, 'CIRCLE'], [8, layer], [10, x], [20, y], [40, 200]];
  const farStation = dxf([
    [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    ...circle(0, 0), ...circle(1000, 0),
    ...text('Ndc8_PointID', '1', 0), ...text('Ndc8_PointID', '2', 1000),
    ...lwpolyline([[0, 0], [1000, 0]], 'Ndc8_Main'),
    ...text('Ndc8_MainID', 'T1', 500),
    ...activityCircle('Ndc8_Activity_测试站', 1200, 0),
    ...text('Ndc8_Activity_测试站ID', 'S1', 1200),
    [0, 'ENDSEC'], [0, 'EOF'],
  ]);
  await assert.rejects(
    parseCadReferenceDxfStream(async () => new Response(farStation), { agvMap: { id: 'cad-far', name: '过远站点' } }),
    /附近未找到唯一的路网节点/,
  );

  const missingId = dxf([
    [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    ...circle(0, 0), ...circle(1000, 0),
    ...text('Ndc8_PointID', '1', 0), ...text('Ndc8_PointID', '2', 1000),
    ...lwpolyline([[0, 0], [1000, 0]], 'Ndc8_Main'),
    ...text('Ndc8_MainID', 'T1', 500),
    ...activityCircle('Ndc8_Activity_测试站', 0, 0),
    [0, 'ENDSEC'], [0, 'EOF'],
  ]);
  await assert.rejects(
    parseCadReferenceDxfStream(async () => new Response(missingId), { agvMap: { id: 'cad-noid', name: '缺编号站点' } }),
    /点位数量（1）与编号数量（0）不一致/,
  );

  assert.equal(
    sanitizeAgvMapDefinition({
      schemaVersion: 1,
      id: 'bad-station-ref',
      name: '无效站点引用',
      nodes: [{ id: '1', name: '1', x: 0, y: 0 }],
      tracks: [],
      stations: [{ id: '633', name: '633', nodeId: 'missing', x: 0, y: 0 }],
    }),
    null,
  );
  assert.equal(
    sanitizeAgvMapDefinition({
      schemaVersion: 1,
      id: 'dup-station-id',
      name: '重复站点编号',
      nodes: [{ id: '1', name: '1', x: 0, y: 0 }],
      tracks: [],
      stations: [
        { id: '633', name: '633', nodeId: '1', x: 0, y: 0 },
        { id: '633', name: '633-b', nodeId: '1', x: 0, y: 0 },
      ],
    }),
    null,
  );
});

test('AGV 地图导入完成后自动关闭进度框并记录导入日志', async (t) => {
  const { useEditorStore } = await modules.ssrLoadModule(entries.store);
  const { forgetCadReferenceLoadStatus, publishCadReferenceLoadStatus } =
    await modules.ssrLoadModule(entries.cadStatus);
  const beforeState = useEditorStore.getState();
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const originalWorker = globalThis.Worker;
  const sourceUrl = 'editor-asset://local/agv-progress-close.dxf';
  const content = dxf([
    [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    ...circle(0, 0), ...circle(1000, 0),
    ...lwpolyline([[0, 0], [1000, 0]]),
    ...text('Ndc8_PointID', '1', -100), ...text('Ndc8_PointID', '2', 900),
    ...text('Ndc8_TestPathID', '88', 450),
    [0, 'ENDSEC'], [0, 'EOF'],
  ]);
  let spawnerId = null;
  let unsubscribe = () => {};
  t.after(() => {
    unsubscribe();
    if (spawnerId) forgetCadReferenceLoadStatus(spawnerId);
    useEditorStore.setState(beforeState, true);
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
    globalThis.fetch = originalFetch;
  });

  useEditorStore.setState({
    scene: createEmptySceneDocument('AGV进度关闭'),
    runtimeMode: 'edit',
    history: { undoStack: [], redoStack: [] },
    hierarchySelectionIds: [],
    cadImportProgress: null,
    logs: [],
  });
  useEditorStore.getState().createAgvSpawner({ x: 0, y: 0, z: 0 });
  spawnerId = useEditorStore.getState().scene.selectedEntityId;
  assert.ok(spawnerId);

  globalThis.window = {
    editorApi: {
      importCadFile: async () => ({
        canceled: false,
        filePath: 'C:/example/agv-progress-close.dxf',
        sourceUrl,
        fileSizeBytes: Buffer.byteLength(content, 'utf8'),
      }),
    },
  };
  globalThis.Worker = class MockCadWorker {
    postMessage(request) {
      void parseCadReferenceDxfStream(async () => new Response(content), {
        agvMap: request.agvMap,
        unitScaleToMeters: request.unitScaleToMeters,
      }).then((result) => {
        this.onmessage?.({ data: { id: request.id, type: 'result', result } });
      });
    }
    terminate() {}
  };
  globalThis.fetch = async (url) => {
    assert.equal(url, sourceUrl);
    return new Response(content);
  };

  let sawActiveProgress = false;
  let publishedReady = false;
  unsubscribe = useEditorStore.subscribe((state) => {
    if (state.cadImportProgress?.active) sawActiveProgress = true;
    if (!publishedReady && state.scene.entities[spawnerId]?.components.cadReference?.sourceUrl === sourceUrl) {
      publishedReady = true;
      publishCadReferenceLoadStatus({
        entityId: spawnerId,
        sourceUrl,
        state: 'ready',
        percent: 100,
        detail: 'CAD 参考图已显示。',
      });
    }
  });

  await useEditorStore.getState().importCadReference(spawnerId);

  const afterState = useEditorStore.getState();
  assert.equal(sawActiveProgress, true);
  assert.equal(afterState.cadImportProgress, null, 'AGV 地图导入完成后进度框应自动关闭');
  assert.ok(afterState.scene.entities[spawnerId].components.agvMap.importedMap);
  assert.ok(
    afterState.logs.some((entry) => /导入AGV地图：agv-progress-close/.test(entry.message)),
    '导入日志应记录 AGV 地图导入摘要',
  );
});
