import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAlarmTestModules } from '../helpers/alarmTestModules.mjs';

const server = await buildAlarmTestModules(true);
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

test('火警按配置字段匹配，解除、缺失和禁用不触发，最后值不超时', () => {
  const c = { ...alarm.createDefaultAlarmManager(), listenProperty: 'CUSTOM PROPERTY' };
  for (const value of [true, 1, 'true', '1']) assert.equal(alarm.isAlarmTriggered(c, model, { ...snapshot, fields: { fireAlarm: value } }, 1500), true);
  for (const fields of [{ fireAlarm: false }, {}, { fireAlarm: { active: true } }]) assert.equal(alarm.isAlarmTriggered(c, model, { ...snapshot, fields }, 1500), false);
  assert.equal(alarm.isAlarmTriggered(c, model, { ...snapshot, fields: { fireAlarm: true } }, 86400000), true);
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
    useEditorStore.getState().updateAlarmManager(id, { appearanceEffect: { effectKind: 'alarm-pulse' }, overrideColor: '#009900', targets: alarm.resizeAlarmTargets([], 2), listenProperty: 'CUSTOM PROPERTY', customProperty: 'fire.signal', customValue: '1' });
    assert.equal(useEditorStore.getState().scene.entities[id].components.alarmManager.overrideColor, '#009900');
    assert.equal(useEditorStore.getState().scene.entities[id].components.alarmManager.appearanceEffect.effectKind, 'alarm-pulse');
    useEditorStore.getState().undo();
    assert.equal(useEditorStore.getState().scene.entities[id].components.alarmManager.targets.length, 0);
    useEditorStore.getState().redo();
    assert.equal(useEditorStore.getState().scene.entities[id].components.alarmManager.customProperty, 'fire.signal');
    assert.equal(useEditorStore.getState().scene.entities[id].components.alarmManager.customValue, '1');
    const reloaded = deserializeScene(serializeScene(useEditorStore.getState().scene));
    assert.deepEqual(reloaded.entities[id].components.alarmManager, useEditorStore.getState().scene.entities[id].components.alarmManager);
    useEditorStore.getState().copySelectedEntities(); useEditorStore.getState().pasteEntityClipboard();
    const copied = useEditorStore.getState().scene.selectedEntityId;
    assert.notEqual(copied, id);
    assert.deepEqual(useEditorStore.getState().scene.entities[copied].components.alarmManager, useEditorStore.getState().scene.entities[id].components.alarmManager);
    useEditorStore.setState({ runtimeMode: 'preview' });
    useEditorStore.getState().updateAlarmManager(id, { overrideColor: '#000000' });
    assert.equal(useEditorStore.getState().scene.entities[id].components.alarmManager.overrideColor, '#009900');
  } finally { useEditorStore.setState(before, true); }
});

test('从模型库导入设备保留中台身份，报警目标和场景实例保存重开后仍一致', async () => {
  const { useEditorStore } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  const { createModelGeneratorTargetFromAsset } = await server.ssrLoadModule('/src/editor/model/modelGenerator.ts');
  const before = useEditorStore.getState();
  const path = 'C:/SharedResources/Assets/Models/Model-42-设备/device.glb';
  const asset = { id: path, name: '设备', kind: 'model', libraryKind: 'model', path, sourceUrl: 'editor-asset://local/' + encodeURIComponent(path),
    lengthUnit: 'meter', dataPlatformSourceKey: 'a'.repeat(64) };
  try {
    useEditorStore.setState({ scene: createEmptySceneDocument('模型身份'), runtimeMode: 'edit', history: { undoStack: [], redoStack: [] }, hierarchySelectionIds: [] });
    useEditorStore.getState().importModelAsset(asset);
    const state = useEditorStore.getState();
    const id = state.scene.selectedEntityId;
    const expected = createModelGeneratorTargetFromAsset(asset).modelAsset.dataPlatformModel;
    assert.ok(expected);
    assert.deepEqual(state.scene.entities[id].components.modelAsset.dataPlatformModel, expected);
    assert.deepEqual(deserializeScene(serializeScene(state.scene)).entities[id].components.modelAsset.dataPlatformModel, expected);
    state.undo();
    assert.equal(useEditorStore.getState().scene.entities[id], undefined);
    useEditorStore.getState().redo();
    assert.deepEqual(useEditorStore.getState().scene.entities[id].components.modelAsset.dataPlatformModel, expected);
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
    const activeMaterial = mesh.material;
    const firstIntensity = activeMaterial.emissiveColor.r;
    runtime.update(1016);
    assert.equal(mesh.material, activeMaterial, '逐帧呼吸不能重建材质');
    assert.notEqual(mesh.material.emissiveColor.r, firstIntensity, '在250ms条件评估间隔内仍应逐帧呼吸');
    assert.ok(Math.abs(mesh.material.emissiveColor.r - firstIntensity) < 0.05, '相邻帧亮度应连续平滑');
    assert.equal(other.material, material, '正常设备不能被报警材质污染');
    runtime.update(1500); assert.equal(events.length, 1);
    deviceTelemetryStore.upsert({ ...snapshot, receivedAt: 1800, fields: { runningState: 'idle' }, sourceId: 'default', deviceType: 'device', assetCode: model.id, sequence: 2, topic: 'test', sourceTimestamp: null });
    runtime.update(1800);
    assert.equal(mesh.material, material); assert.equal(runtime.getOverlayItems().length, 0);
    assert.equal(runtime.isActive(manager.id, model.id), false);
    assert.equal(scene.materials.includes(activeMaterial), false, '报警解除应释放呼吸覆盖材质');
    deviceTelemetryStore.upsert({ ...snapshot, receivedAt: 2100, sourceId: 'default', deviceType: 'device', assetCode: model.id, sequence: 3, topic: 'test', sourceTimestamp: null });
    runtime.update(2100);
    assert.equal(runtime.isActive(manager.id, model.id), true);
    const restartedMaterial = mesh.material;
    runtime.reset();
    assert.equal(mesh.material, material, '停止预览应还原原材质');
    assert.equal(scene.materials.includes(restartedMaterial), false);
    assert.equal(runtime.isActive(manager.id, model.id), false);
  } finally { runtime.dispose(); deviceTelemetryStore.clear(); scene.dispose(); engine.dispose(); }
});

test('报警呼吸只影响活动集合，普通状态色保持静态且实例隔离可还原', async () => {
  const { NullEngine, Scene, MeshBuilder, StandardMaterial } = await import('@babylonjs/core');
  const { AlarmColorOverrides } = await server.ssrLoadModule('/src/runtime/babylon/AlarmManagerRuntime.ts');
  const engine = new NullEngine(), scene = new Scene(engine);
  const target = MeshBuilder.CreateBox('pulse-target', {}, scene);
  const idle = MeshBuilder.CreateBox('idle-target', {}, scene);
  const original = new StandardMaterial('shared-original', scene);
  target.material = idle.material = original;
  const instance = target.createInstance('pulse-instance');
  const tint = new AlarmColorOverrides();
  try {
    const desired = new Map([[target, '#ff0000'], [idle, '#00ff00'], [instance, '#ff0000']]);
    const active = new Set([target, instance]);
    tint.apply(desired, active, 0.9);
    const targetMaterial = target.material;
    const proxy = scene.meshes.find(mesh => mesh.name === 'pulse-instance_alarm');
    assert.ok(Math.abs(targetMaterial.emissiveColor.r - 0.9) < 0.000001);
    assert.ok(Math.abs(idle.material.emissiveColor.g - 0.35) < 0.000001);
    assert.ok(Math.abs(proxy.material.emissiveColor.r - 0.9) < 0.000001);
    tint.apply(desired, active, 0.4);
    assert.equal(target.material, targetMaterial);
    assert.ok(Math.abs(target.material.emissiveColor.r - 0.4) < 0.000001);
    assert.ok(Math.abs(idle.material.emissiveColor.g - 0.35) < 0.000001);
    assert.deepEqual(original.emissiveColor.asArray(), [0, 0, 0]);
    tint.apply(desired);
    assert.ok(Math.abs(target.material.emissiveColor.r - 0.35) < 0.000001, '没有active集合时保持旧静态颜色行为');
    tint.clear();
    assert.equal(target.material, original); assert.equal(idle.material, original);
    assert.equal(instance.material, original); assert.equal(instance.isEnabled(), true);
    assert.equal(proxy.isDisposed(), true); assert.equal(scene.materials.includes(targetMaterial), false);
  } finally { tint.clear(); scene.dispose(); engine.dispose(); }
});

test('CUSTOM PROPERTY 原始 MQTT 多设备边沿、绑定覆盖、隐藏与解除保持一致', async () => {
  const { NullEngine, Scene, MeshBuilder, StandardMaterial, FreeCamera, Vector3 } = await import('@babylonjs/core');
  const { AlarmManagerRuntime } = await server.ssrLoadModule('/src/runtime/babylon/AlarmManagerRuntime.ts');
  const { deviceTelemetryStore, parseDeviceTelemetryMessage } = await server.ssrLoadModule('/src/runtime/mqtt/deviceTelemetry.ts');
  const engine = new NullEngine(); const scene = new Scene(engine); new FreeCamera('camera', new Vector3(0, 2, -10), scene);
  const first = structuredClone(model), second = structuredClone(model);
  first.components.telemetryBinding.assetCode = 'MQTT-A';
  second.id = 'device-2'; second.components.modelAsset.assetCode = 'MQTT-B';
  const manager = alarm.createAlarmManagerEntity({ x: 0, y: 0, z: 0 });
  Object.assign(manager.components.alarmManager, { listenProperty: 'CUSTOM PROPERTY', customProperty: 'sensor.fire', customValue: '1', warehouseAlarm: false, appearanceModel: { kind: 'mesh', meshKind: 'sphere', displayName: '外观', materialColor: '#ff0000' }, targets: [{ id: 'all', model: target, entityId: '' }], showMarker: true, associationType: 'builtin' });
  const doc = { ...createEmptySceneDocument('mqtt'), entityIds: [manager.id, first.id, second.id], entities: { [manager.id]: manager, [first.id]: first, [second.id]: second } };
  const material = new StandardMaterial('shared', scene);
  const meshes = new Map([first, second].map(entity => { const mesh = MeshBuilder.CreateBox(entity.id, {}, scene); mesh.material = material; return [entity.id, mesh]; }));
  const events = []; const hidden = new Set(); let sequence = 0;
  const runtime = new AlarmManagerRuntime(scene, { meshes: id => [meshes.get(id)], visible: id => !hidden.has(id), bounds: () => ({ minimum: Vector3.Zero(), maximum: Vector3.One() }), activate: event => events.push(event), report: message => { throw new Error(message); } });
  const signal = (assetCode, value, now, sourceId = 'default') => {
    const snapshot = parseDeviceTelemetryMessage('dt/factory/logistics/device/' + assetCode + '/twindatadriven/joint', JSON.stringify({ seq: ++sequence, data: value === undefined ? [{ p: 'temperature', v: 22 }] : [{ e: assetCode, p: 'sensor.fire', v: value }] }), { kind: 'epv', sourceId });
    deviceTelemetryStore.upsert({ ...snapshot, receivedAt: now }); runtime.update(now);
  };
  try {
    runtime.sync(doc);
    signal('MQTT-A', 0, 1000); assert.equal(events.length, 0);
    signal('MQTT-A', 1, 1300, 'other-source'); assert.equal(events.length, 0);
    signal('MQTT-A', 1, 1600); assert.equal(events.length, 1);
    assert.equal(runtime.isActive(manager.id, first.id), true); assert.equal(runtime.isActive(manager.id, second.id), false);
    assert.notEqual(meshes.get(first.id).material, material); assert.equal(meshes.get(second.id).material, material);
    signal('MQTT-A', 1, 1900); assert.equal(events.length, 1);
    signal('MQTT-B', 1, 2200); assert.equal(events.length, 2); assert.equal(runtime.getOverlayItems().length, 2);
    signal('MQTT-A', 0, 2500); assert.equal(runtime.isActive(manager.id, first.id), false);
    assert.equal(meshes.get(first.id).material, material); assert.equal(runtime.isActive(manager.id, second.id), true);
    hidden.add(second.id); runtime.update(2800); assert.equal(runtime.getOverlayItems().length, 0);
    hidden.clear(); signal('MQTT-B', 1, 3100); assert.equal(events.length, 3);
    const heldMaterial = meshes.get(second.id).material;
    signal('MQTT-B', undefined, 3400); assert.equal(runtime.isActive(manager.id, second.id), true, '未携带该点位不是新值');
    assert.equal(meshes.get(second.id).material, heldMaterial);
    signal('MQTT-B', 1, 3700); runtime.update(86400000);
    assert.equal(runtime.isActive(manager.id, second.id), true, '相同值和长时间无更新均持续报警');
    assert.equal(events.length, 3, '持续报警不能重复激活');
    signal('MQTT-B', 0, 86400300); assert.equal(runtime.isActive(manager.id, second.id), false);
    assert.equal(meshes.get(second.id).material, material);
    signal('MQTT-B', 1, 86400600);
    signal('MQTT-B', undefined, 86400900);
    runtime.sync(doc); runtime.update(86401200);
    assert.equal(runtime.isActive(manager.id, second.id), true, '文档同步不清除同一订阅的最后点位值');
    runtime.reset(); assert.equal(runtime.isActive(manager.id, second.id), false);
    signal('MQTT-B', 1, 86401500);
    assert.equal(runtime.isActive(manager.id, second.id), true, '停止再启动仍能接收同一订阅的新值');
  } finally { runtime.dispose(); deviceTelemetryStore.clear(); scene.dispose(); engine.dispose(); }
});

test('模型缓存路径变化并保存重开后，normal=true 仍覆盖红色、创建特效并在false时恢复', async () => {
  const { NullEngine, Scene, MeshBuilder, StandardMaterial, Vector3 } = await import('@babylonjs/core');
  const { AlarmManagerRuntime } = await server.ssrLoadModule('/src/runtime/babylon/AlarmManagerRuntime.ts');
  const { deviceTelemetryStore, parseDeviceTelemetryMessage } = await server.ssrLoadModule('/src/runtime/mqtt/deviceTelemetry.ts');
  const identity = { sourceKey: 'a'.repeat(64), kind: 'model', resourceId: '42', modelPath: 'device.glb' };
  const device = structuredClone(model);
  Object.assign(device.components.modelAsset, { sourcePath: 'C:/updated/device.glb', sourceUrl: 'editor-asset://local/C%3A%2Fupdated%2Fdevice.glb', lengthUnit: 'meter', dataPlatformModel: identity });
  const manager = alarm.createAlarmManagerEntity({ x: 0, y: 0, z: 0 });
  manager.components.alarmManager = alarm.normalizeAlarmManager({ ...manager.components.alarmManager,
    listenProperty: 'CUSTOM PROPERTY', customProperty: 'normal', customValue: 'true', warehouseAlarm: false,
    appearanceEffect: { effectKind: 'alarm-pulse' },
    targets: [{ id: 'slot', entityId: '', model: { ...target, modelAsset: { ...target.modelAsset, lengthUnit: 'meter', dataPlatformModel: identity } } }],
  });
  const doc = deserializeScene(serializeScene({ ...createEmptySceneDocument('缓存更新报警'), entityIds: [manager.id, device.id], entities: { [manager.id]: manager, [device.id]: device } }));
  const engine = new NullEngine(), scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('alarm-target', {}, scene), other = MeshBuilder.CreateBox('other-device', {}, scene);
  const original = new StandardMaterial('shared-original', scene); mesh.material = other.material = original;
  const runtime = new AlarmManagerRuntime(scene, { meshes: () => [mesh], visible: () => true,
    bounds: () => ({ minimum: Vector3.Zero(), maximum: Vector3.One() }), activate: () => {}, report: message => { throw new Error(message); } });
  const signal = (value, now) => {
    const packet = parseDeviceTelemetryMessage(`dt/factory/logistics/device/${device.components.modelAsset.assetCode}/twindatadriven/joint`, JSON.stringify({ seq: now, data: [{ p: 'normal', v: value }] }), { kind: 'epv', sourceId: 'default' });
    assert.ok(packet);
    deviceTelemetryStore.upsert({ ...packet, receivedAt: now }); runtime.update(now);
  };
  try {
    runtime.sync(doc); signal(true, 1000);
    assert.equal(runtime.isActive(manager.id, device.id), true);
    assert.equal(mesh.material.diffuseColor.toHexString().toLowerCase(), '#ff1717');
    assert.equal(other.material, original);
    const effect = scene.getTransformNodeByName(manager.id + ':alarm:' + device.id + '_poiEffectRoot');
    assert.ok(effect, 'normal=true 应生成所选报警特效');
    signal(false, 1300);
    assert.equal(runtime.isActive(manager.id, device.id), false);
    assert.equal(mesh.material, original);
    assert.equal(effect.isDisposed(), true);
  } finally { runtime.dispose(); deviceTelemetryStore.clear(); scene.dispose(); engine.dispose(); }
});

test('告警信息卡使用真实设备名及本轮触发时间，文档同步不改变持续报警时间', async () => {
  const { NullEngine, Scene, MeshBuilder, Vector3 } = await import('@babylonjs/core');
  const { AlarmManagerRuntime } = await server.ssrLoadModule('/src/runtime/babylon/AlarmManagerRuntime.ts');
  const { createAlarmAppearancePreset } = await server.ssrLoadModule('/src/editor/model/alarmAppearancePresets.ts');
  const { deviceTelemetryStore } = await server.ssrLoadModule('/src/runtime/mqtt/deviceTelemetry.ts');
  const manager = alarm.createAlarmManagerEntity({ x: 0, y: 0, z: 0 });
  manager.components.alarmManager = alarm.normalizeAlarmManager({ ...manager.components.alarmManager,
    listenProperty: 'CUSTOM PROPERTY', customProperty: 'normal', customValue: 'true', warehouseAlarm: false,
    appearanceEffect: createAlarmAppearancePreset('label'), overrideColorEnabled: false,
    targets: [{ id: 'slot', model: null, entityId: model.id }],
  });
  const doc = { ...createEmptySceneDocument('报警时间'), entityIds: [manager.id, model.id], entities: { [manager.id]: manager, [model.id]: model } };
  const engine = new NullEngine(), scene = new Scene(engine), mesh = MeshBuilder.CreateBox('device', {}, scene);
  const runtime = new AlarmManagerRuntime(scene, { meshes: () => [mesh], visible: () => true,
    bounds: () => ({ minimum: Vector3.Zero(), maximum: Vector3.One() }), activate: () => {}, report: message => { throw new Error(message); } });
  let parameters;
  const render = runtime.effects.sync.bind(runtime.effects);
  runtime.effects.sync = (entity, ...args) => { parameters = entity.components.poiEffect.configuration.parameters; render(entity, ...args); };
  const send = (fields, now) => {
    deviceTelemetryStore.upsert({ ...snapshot, fields, receivedAt: now, sourceId: 'default', deviceType: 'device', assetCode: model.id, sequence: now, topic: 'test', sourceTimestamp: null });
    runtime.update(now);
  };
  try {
    runtime.sync(doc); send({ normal: true }, 1000);
    assert.equal(parameters.title, model.name);
    const firstTime = parameters.timeText;
    assert.equal(firstTime, new Date(1000).toLocaleString());
    send({ temperature: 30 }, 1300); runtime.sync(doc); runtime.update(1600);
    assert.equal(parameters.timeText, firstTime);
    send({ normal: true }, 1900); assert.equal(parameters.timeText, firstTime);
    send({ normal: false }, 2200); assert.equal(runtime.isActive(manager.id, model.id), false);
    send({ normal: true }, 4000); assert.equal(parameters.timeText, new Date(4000).toLocaleString());
    assert.notEqual(parameters.timeText, firstTime);
    assert.equal(manager.components.alarmManager.appearanceEffect.configuration.parameters.timeText, undefined, '运行时间不写回场景配置');
    mesh.rotation.set(0.6, 0.5, 0.3); runtime.update(4300);
    const effectName = manager.id + ':alarm:' + model.id + '_poiEffectRoot';
    assert.deepEqual(scene.getTransformNodeByName(effectName).rotationQuaternion.asArray(), [0, 0, 0, 1], '设备倾斜时悬浮卡片保持竖直');
    manager.components.alarmManager.appearanceEffect = createAlarmAppearancePreset('zone');
    runtime.sync(doc); runtime.update(4600);
    const groundRotation = scene.getTransformNodeByName(effectName).rotationQuaternion.asArray();
    assert.ok(Math.abs(groundRotation[0]) < 1e-8 && Math.abs(groundRotation[2]) < 1e-8, '警戒圈只跟随水平朝向，不能随设备俯仰翻滚');
  } finally { runtime.dispose(); deviceTelemetryStore.clear(); scene.dispose(); engine.dispose(); }
});

test('报警外观保存特效配置，旧模型外观兼容，拒绝非附着型特效', () => {
  const c = alarm.normalizeAlarmManager({ ...alarm.createDefaultAlarmManager(), appearanceEffect: { effectKind: 'alarm-pulse', primaryColor: '#123456' } });
  assert.equal(c.appearanceEffect?.effectKind, 'alarm-pulse');
  assert.equal(c.appearanceEffect.primaryColor, '#123456');
  const manager = alarm.createAlarmManagerEntity({ x: 0, y: 0, z: 0 });
  manager.components.alarmManager = c;
  const doc = { ...createEmptySceneDocument('外观保存'), entityIds: [manager.id], entities: { [manager.id]: manager } };
  assert.deepEqual(deserializeScene(serializeScene(doc)).entities[manager.id].components.alarmManager.appearanceEffect, c.appearanceEffect);
  for (const effectKind of ['invalid', 'environment-fog', 'day-night', 'target-follow']) assert.throws(() => alarm.normalizeAlarmManager({ ...c, appearanceEffect: { effectKind } }));
  const legacyModel = { kind: 'mesh', meshKind: 'sphere', displayName: '旧外观', materialColor: '#ff0000' };
  const legacy = alarm.normalizeAlarmManager({ appearanceModel: legacyModel });
  assert.deepEqual(legacy.appearanceModel, legacyModel);
  assert.equal(legacy.appearanceEffect, null);
  assert.equal(alarm.normalizeAlarmManager({ ...c, appearanceModel: target }).appearanceModel, null);
});

test('报警特效按设备独立附着、逐帧跟随、隐藏解除释放并恢复模型外观', async () => {
  const { NullEngine, Scene, MeshBuilder, StandardMaterial, FreeCamera, Vector3, TransformNode } = await import('@babylonjs/core');
  const { AlarmManagerRuntime } = await server.ssrLoadModule('/src/runtime/babylon/AlarmManagerRuntime.ts');
  const { deviceTelemetryStore } = await server.ssrLoadModule('/src/runtime/mqtt/deviceTelemetry.ts');
  const engine = new NullEngine(), scene = new Scene(engine);
  new FreeCamera('camera', new Vector3(0, 2, -10), scene);
  const root = new TransformNode('device-root', scene);
  const mesh = MeshBuilder.CreateBox('device', {}, scene); mesh.parent = root;
  const normal = MeshBuilder.CreateBox('normal', {}, scene);
  const material = new StandardMaterial('original', scene); mesh.material = normal.material = material;
  const manager = alarm.createAlarmManagerEntity({ x: 100, y: 0, z: 100 });
  manager.components.alarmManager = alarm.normalizeAlarmManager({ ...manager.components.alarmManager, targets: [{ id: 'slot', model: null, entityId: model.id }], appearanceEffect: { effectKind: 'alarm-pulse' } });
  const doc = { ...createEmptySceneDocument('外观运行'), entityIds: [manager.id, model.id], entities: { [manager.id]: manager, [model.id]: model } };
  let visible = true;
  const runtime = new AlarmManagerRuntime(scene, { meshes: () => [mesh], node: () => root, visible: () => visible, bounds: () => { mesh.computeWorldMatrix(true); const b = mesh.getBoundingInfo().boundingBox; return { minimum: b.minimumWorld, maximum: b.maximumWorld }; }, activate: () => {}, report: message => { throw new Error(message); } });
  const signal = now => deviceTelemetryStore.upsert({ ...snapshot, receivedAt: now, sourceId: 'default', deviceType: 'device', assetCode: model.id, sequence: now, topic: 'test', sourceTimestamp: null });
  const key = manager.id + ':alarm:' + model.id;
  try {
    runtime.sync(doc); signal(1000); runtime.update(1000);
    const effectRoot = scene.getTransformNodeByName(key + '_poiEffectRoot');
    assert.ok(effectRoot, '所选特效应生成运行时外观');
    assert.equal(scene.particleSystems.length, 0, '选择光圈不应回退成火焰');
    assert.equal(effectRoot.position.x, 0);
    root.position.x = 7; root.rotation.y = Math.PI / 2; runtime.update(1016);
    assert.equal(effectRoot.position.x, 7, '移动目标后下一帧跟随');
    assert.ok(Math.abs(effectRoot.rotationQuaternion.y) > 0.7, '随目标世界旋转');
    assert.equal(normal.material, material);
    visible = false; runtime.update(1300);
    assert.equal(effectRoot.isDisposed(), true); assert.equal(mesh.material, material);
    visible = true;
    manager.components.alarmManager = alarm.normalizeAlarmManager({ ...manager.components.alarmManager, appearanceEffect: {
      effectKind: 'hologram', configuration: { target: { mode: 'entity', entityId: 'unrelated-device' },
        data: { mode: 'mqtt', sourceId: 'unrelated', deviceType: 'device', assetCode: 'missing', missing: 'hide' }, parameters: {} },
    } });
    runtime.sync(doc); signal(1600); runtime.update(1600); scene.render();
    assert.equal(mesh.material.wireframe, true, '报警外观的参数配置不能再次要求独立目标或MQTT绑定');
    assert.equal(normal.material, material);
    runtime.reset(); assert.equal(mesh.material, material);
    assert.equal(scene.transformNodes.some(node => node.name === key + '_poiEffectRoot'), false);
  } finally { runtime.dispose(); deviceTelemetryStore.clear(); scene.dispose(); engine.dispose(); }
});
