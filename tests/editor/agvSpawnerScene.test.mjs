import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAlarmTestModules } from '../helpers/alarmTestModules.mjs';

const server = await buildAlarmTestModules(true);
const { createAgvSpawnerEntity, createEmptySceneDocument } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
const { deserializeScene, serializeScene } = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
const { decodeBuiltInAssetDragPayload, encodeBuiltInAssetDragPayload } = await server.ssrLoadModule('/src/editor/assets/AssetDatabase.ts');

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
  const { useEditorStore } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
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
