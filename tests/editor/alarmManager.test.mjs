import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, ssr: { noExternal: ['@linkiez/dxf-renew'] } });
after(() => server.close());
const alarm = await server.ssrLoadModule('/src/editor/model/alarmManager.ts');
const { createEmptySceneDocument } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
const { serializeScene, deserializeScene } = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
const { createPersistedModelThinInstanceScene } = await server.ssrLoadModule('/src/editor/model/editModeModelThinInstances.ts');

const modelAsset = { sourcePath: 'C:/models/device.glb', sourceUrl: 'editor-asset://local/device.glb', lengthUnit: 'm', unitScaleToMeters: 1, assetCode: 'device-1' };
const target = { kind: 'model', assetId: 'device', displayName: '设备', modelAsset };
const model = { id: 'device-1', name: '设备 1', visible: true, locked: false, parentId: null, childrenIds: [], components: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, modelAsset, telemetryBinding: { enabled: true, sourceId: 'default', deviceType: 'device', staleAfterMs: 1000 } } };
const snapshot = { receivedAt: 1000, faulted: false, fields: { runningState: 'running' } };

test('目标 Size 保留已有槽位，支持缩小和扩展，拒绝非法上限', () => {
  const c = alarm.createDefaultAlarmManager();
  c.targets = [{ id: 'one', model: target, entityId: '' }];
  assert.equal(alarm.resizeAlarmTargets(c.targets, 3)[0], c.targets[0]);
  assert.equal(alarm.resizeAlarmTargets(c.targets, 0).length, 0);
  assert.throws(() => alarm.resizeAlarmTargets([], 10000));
});

test('报警配置、主题和空槽完整保存重载', () => {
  const scene = createEmptySceneDocument('报警场景');
  const entity = alarm.createAlarmManagerEntity({ x: 3, y: 0, z: 4 });
  entity.components.alarmManager.targets = alarm.resizeAlarmTargets([], 2);
  entity.components.alarmManager.theme = { projectId: 'p', screenId: 's', name: '告警', screenUrl: 'https://example.com/s' };
  scene.entityIds.push(entity.id); scene.entities[entity.id] = entity;
  assert.deepEqual(deserializeScene(serializeScene(scene)).entities[entity.id].components.alarmManager, entity.components.alarmManager);
});

test('运行状态匹配、故障优先和失联超时不混淆', () => {
  const c = alarm.createDefaultAlarmManager();
  assert.equal(alarm.isAlarmTriggered(c, model, snapshot, 1500), true);
  assert.equal(alarm.isAlarmTriggered(c, model, { ...snapshot, faulted: true }, 1500), false);
  c.runningState = 'alarm';
  assert.equal(alarm.isAlarmTriggered(c, model, { ...snapshot, faulted: true }, 1500), true);
  assert.equal(alarm.isAlarmTriggered(c, model, { ...snapshot, faulted: true }, 3000), false);
  c.runningState = 'offline';
  assert.equal(alarm.isAlarmTriggered(c, model, snapshot, 3000), true);
  assert.equal(alarm.isAlarmTriggered(c, model, null, 3000), false);
});

test('火警按配置字段匹配，解除、缺失、过期和禁用均不触发', () => {
  const c = { ...alarm.createDefaultAlarmManager(), listenProperty: 'CUSTOM PROPERTY' };
  for (const value of [true, 1, 'true', '1']) assert.equal(alarm.isAlarmTriggered(c, model, { ...snapshot, fields: { fireAlarm: value } }, 1500), true);
  for (const fields of [{ fireAlarm: false }, {}, { fireAlarm: { active: true } }]) assert.equal(alarm.isAlarmTriggered(c, model, { ...snapshot, fields }, 1500), false);
  assert.equal(alarm.isAlarmTriggered(c, model, { ...snapshot, fields: { fireAlarm: true } }, 3000), false);
  assert.equal(alarm.isAlarmTriggered(c, { ...model, components: { ...model.components, telemetryBinding: { enabled: false } } }, snapshot, 1500), false);
});

test('受监控实例解除旧合批关系，未监控设备继续合批', () => {
  const scene = createEmptySceneDocument('合批');
  const manager = alarm.createAlarmManagerEntity({ x: 0, y: 0, z: 0 });
  manager.components.alarmManager.targets = [{ id: 'one', model: target, entityId: model.id }];
  const second = structuredClone(model); second.id = 'second'; second.components.modelArrayInstance = { sourceEntityId: model.id };
  const third = structuredClone(model); third.id = 'third'; third.components.modelAsset.sourceUrl = 'editor-asset://local/other.glb';
  const fourth = structuredClone(third); fourth.id = 'fourth';
  for (const e of [manager, model, second, third, fourth]) { scene.entityIds.push(e.id); scene.entities[e.id] = e; }
  const saved = createPersistedModelThinInstanceScene(scene);
  assert.equal(saved.entities.second.components.modelArrayInstance, undefined);
  assert.ok(saved.entities.fourth.components.modelArrayInstance || saved.entities.third.components.modelArrayInstance);
});

test('拒绝主动内容地址和超量配置', () => {
  const c = alarm.createDefaultAlarmManager();
  assert.throws(() => alarm.normalizeAlarmManager({ ...c, contentUrl: 'javascript:alert(1)' }));
  assert.throws(() => alarm.normalizeAlarmManager({ ...c, targets: Array(10000).fill({}) }));
  assert.throws(() => alarm.normalizeAlarmManager({ ...c, overrideColor: 'red;display:none' }));
});

test('仓库告警独立于设备状态，关闭后不再接管仓库火警', () => {
  const c = alarm.createDefaultAlarmManager();
  const fire = { ...snapshot, fields: { runningState: 'idle', warehouseAlarm: true } };
  assert.equal(alarm.resolveAlarmTrigger(c, model, fire, 1500), 'warehouse');
  c.warehouseAlarm = false;
  assert.equal(alarm.resolveAlarmTrigger(c, model, fire, 1500), null);
  c.listenProperty = 'CUSTOM PROPERTY';
  assert.equal(alarm.resolveAlarmTrigger(c, model, { ...fire, fields: { fireAlarm: true } }, 1500), 'fire');
});

test('Store 创建、属性修改、撤销重做、复制及预览只读', async () => {
  const { useEditorStore } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  const before = useEditorStore.getState();
  try {
    useEditorStore.setState({ scene: createEmptySceneDocument('报警编辑'), runtimeMode: 'edit', history: { undoStack: [], redoStack: [] }, hierarchySelectionIds: [] });
    useEditorStore.getState().createAlarmManager({ x: 1, y: 2, z: 3 });
    const id = useEditorStore.getState().scene.selectedEntityId;
    assert.ok(id);
    useEditorStore.getState().updateAlarmManager(id, { overrideColor: '#009900', targets: alarm.resizeAlarmTargets([], 2) });
    assert.equal(useEditorStore.getState().scene.entities[id].components.alarmManager.overrideColor, '#009900');
    useEditorStore.getState().undo();
    assert.equal(useEditorStore.getState().scene.entities[id].components.alarmManager.targets.length, 0);
    useEditorStore.getState().redo();
    useEditorStore.getState().copySelectedEntities(); useEditorStore.getState().pasteEntityClipboard();
    const copied = useEditorStore.getState().scene.selectedEntityId;
    assert.notEqual(copied, id);
    assert.deepEqual(useEditorStore.getState().scene.entities[copied].components.alarmManager, useEditorStore.getState().scene.entities[id].components.alarmManager);
    useEditorStore.setState({ runtimeMode: 'preview' });
    useEditorStore.getState().updateAlarmManager(id, { overrideColor: '#000000' });
    assert.equal(useEditorStore.getState().scene.entities[id].components.alarmManager.overrideColor, '#009900');
  } finally { useEditorStore.setState(before, true); }
});

test('运行时报警边沿、颜色隔离、立标与解除清理', async () => {
  const { NullEngine, Scene, MeshBuilder, StandardMaterial, FreeCamera, Vector3 } = await import('@babylonjs/core');
  const { AlarmManagerRuntime, AlarmColorOverrides } = await server.ssrLoadModule('/src/runtime/babylon/AlarmManagerRuntime.ts');
  const { deviceTelemetryStore } = await server.ssrLoadModule('/src/runtime/mqtt/deviceTelemetry.ts');
  const engine = new NullEngine(); const scene = new Scene(engine); new FreeCamera('camera', new Vector3(0, 2, -10), scene);
  const mesh = MeshBuilder.CreateBox('device', {}, scene);
  const other = MeshBuilder.CreateBox('normal', {}, scene);
  const material = new StandardMaterial('shared', scene); mesh.material = other.material = material;
  const tint = new AlarmColorOverrides();
  tint.apply(new Map([[mesh, '#ff0000']]));
  assert.notEqual(mesh.material, material); assert.equal(other.material, material);
  tint.clear(); assert.equal(mesh.material, material);
  const instance = mesh.createInstance('instance');
  tint.apply(new Map([[instance, '#00ff00']]));
  assert.equal(mesh.material, material); assert.equal(instance.isEnabled(), false);
  tint.clear(); assert.equal(instance.isEnabled(), true); assert.equal(instance.material, material);
  const manager = alarm.createAlarmManagerEntity({ x: 0, y: 0, z: 0 });
  manager.components.alarmManager.targets = [{ id: 'one', model: target, entityId: '' }];
  manager.components.alarmManager.showMarker = true;
  manager.components.alarmManager.appearanceModel = { kind: 'mesh', meshKind: 'sphere', displayName: '外观', materialColor: '#ff0000' };
  manager.components.alarmManager.associationType = 'builtin';
  manager.components.alarmManager.theme = { projectId: 'p', screenId: 's', name: '告警', screenUrl: 'https://example.com/s' };
  const doc = { ...createEmptySceneDocument('runtime'), entityIds: [manager.id, model.id], entities: { [manager.id]: manager, [model.id]: model } };
  const events = [];
  const runtime = new AlarmManagerRuntime(scene, { meshes: () => [mesh], visible: () => true, bounds: () => ({ minimum: Vector3.Zero(), maximum: Vector3.One() }), activate: event => events.push(event), report: message => { throw new Error(message); } });
  try {
    runtime.sync(doc);
    deviceTelemetryStore.upsert({ ...snapshot, sourceId: 'default', deviceType: 'device', assetCode: model.id, sequence: 1, topic: 'test', sourceTimestamp: null });
    runtime.update(1000);
    assert.equal(events.length, 1); assert.equal(events[0].theme.screenId, 's');
    assert.notEqual(mesh.material, material); assert.equal(other.material, material);
    assert.equal(runtime.getOverlayItems().length, 1);
    assert.ok(runtime.getOverlayItems()[0].mesh.material);
    assert.equal(runtime.isActive(manager.id, model.id), true);
    runtime.update(1500); assert.equal(events.length, 1);
    deviceTelemetryStore.upsert({ ...snapshot, receivedAt: 1800, fields: { runningState: 'idle' }, sourceId: 'default', deviceType: 'device', assetCode: model.id, sequence: 2, topic: 'test', sourceTimestamp: null });
    runtime.update(1800);
    assert.equal(mesh.material, material); assert.equal(runtime.getOverlayItems().length, 0);
    assert.equal(runtime.isActive(manager.id, model.id), false);
  } finally { runtime.dispose(); deviceTelemetryStore.clear(); scene.dispose(); engine.dispose(); }
});
