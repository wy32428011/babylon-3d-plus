import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAlarmTestModules } from '../helpers/alarmTestModules.mjs';

const server = await buildAlarmTestModules();
const alarm = await server.ssrLoadModule('/src/editor/model/alarmManager.ts');
const { DeviceTelemetryStore, parseDeviceTelemetryMessage } = await server.ssrLoadModule('/src/runtime/mqtt/deviceTelemetry.ts');
const { AlarmTelemetryTracker } = await server.ssrLoadModule('/src/runtime/mqtt/AlarmTelemetryTracker.ts');
const config = { ...alarm.createDefaultAlarmManager(), listenProperty: 'CUSTOM PROPERTY', customProperty: 'fire.signal', customValue: '1', warehouseAlarm: false };
const entity = { id: 'device-A', components: {
  modelAsset: { assetCode: 'A', dataDrivenConfig: { device: { devType: 'conveyor' } } },
  telemetryBinding: { enabled: true, sourceId: 'plant-1', deviceType: 'conveyor', staleAfterMs: 1000 },
} };
function message(data, { assetCode = 'A', sourceId = 'plant-1', sequence = 1, receivedAt = 1000 } = {}) {
  const snapshot = parseDeviceTelemetryMessage(`dt/factory/logistics/conveyor/${assetCode}/twindatadriven/joint`, JSON.stringify({ seq: sequence, data }), { kind: 'epv', sourceId });
  assert.ok(snapshot);
  return { ...snapshot, receivedAt };
}
function diagnostic(snapshot, options = {}) {
  return alarm.getAlarmCustomPropertyDiagnostic(options.config ?? config, options.entity ?? entity, snapshot, options.now ?? 1500);
}

test('绑定身份与运行时保持一致，显式绑定优先，缺省使用模型身份', () => {
  assert.deepEqual(alarm.resolveAlarmDeviceBinding(entity), { assetCode: 'A', deviceType: 'conveyor', sourceId: 'plant-1' });
  const explicit = { ...entity, components: { ...entity.components, telemetryBinding: { assetCode: 'B', deviceType: 'rgv', sourceId: 'plant-2' } } };
  assert.deepEqual(alarm.resolveAlarmDeviceBinding(explicit), { assetCode: 'B', deviceType: 'rgv', sourceId: 'plant-2' });
  assert.deepEqual(alarm.resolveAlarmDeviceBinding({ ...entity, components: { modelAsset: entity.components.modelAsset } }), { assetCode: 'A', deviceType: 'conveyor', sourceId: 'default' });
});

test('原始 MQTT p/v 按设备、数据源隔离，点位顺序与点号不改变精确匹配', () => {
  const store = new DeviceTelemetryStore();
  store.upsert(message([{ p: 'temperature', v: 36 }, { e: 'A', p: 'fire.signal', v: 1 }, { p: 'fire', v: { signal: 0 } }]));
  store.upsert(message([{ p: 'fire.signal', v: 0 }], { assetCode: 'B' }));
  store.upsert(message([{ p: 'fire.signal', v: 0 }], { sourceId: 'plant-2' }));
  const binding = alarm.resolveAlarmDeviceBinding(entity);
  const snapshot = store.getSnapshot(binding.assetCode, binding.deviceType, binding.sourceId);
  assert.equal(diagnostic(snapshot).status, 'matched');
  assert.equal(diagnostic(snapshot).value, 1);
  assert.equal(diagnostic(snapshot).trigger, 'fire');
  assert.equal(alarm.resolveAlarmTrigger(config, entity, store.getSnapshot('B', 'conveyor', 'plant-1'), 1500), null);
  assert.equal(alarm.resolveAlarmTrigger(config, entity, store.getSnapshot('A', 'conveyor', 'plant-2'), 1500), null);
});

test('normal=true 按 CUSTOM PROPERTY 配置报警，不受内置正常状态解释影响', () => {
  const c = { ...config, customProperty: 'normal', customValue: 'true' };
  for (const value of [true, 'true', 1, '1']) {
    const snapshot = message([{ e: 'A', p: 'normal', v: value }]);
    assert.equal(snapshot.faulted, false);
    assert.equal(diagnostic(snapshot, { config: c }).status, 'matched');
    assert.equal(alarm.resolveAlarmTrigger(c, entity, snapshot, 1500), 'fire');
  }
  for (const value of [false, 'false', 0, '0']) {
    assert.equal(alarm.resolveAlarmTrigger(c, entity, message([{ p: 'normal', v: value }]), 1500), null);
  }
});

test('报警目标按稳定模型身份解析，资源同步换路径后 normal=true 仍能命中', () => {
  const identity = { sourceKey: 'a'.repeat(64), kind: 'model', resourceId: '42', modelPath: 'models/device.glb' };
  const model = { sourcePath: 'C:/cache/v1/device.glb', sourceUrl: 'editor-asset://local/C%3A%2Fcache%2Fv1%2Fdevice.glb', dataPlatformModel: identity };
  const target = { ...entity, components: { ...entity.components, modelAsset: { ...entity.components.modelAsset,
    sourcePath: 'C:/cache/v2/device.glb', sourceUrl: 'editor-asset://local/C%3A%2Fcache%2Fv2%2Fdevice.glb', dataPlatformModel: { ...identity },
  } } };
  const scene = { entityIds: [target.id], entities: { [target.id]: target } };
  for (const targetType of ['ENTITY', 'MODEL']) {
    const c = { ...config, targetType, customProperty: 'normal', customValue: 'true',
      targets: [{ id: 'slot', entityId: '', model: { kind: 'model', modelAsset: model } }],
    };
    const targets = alarm.resolveAlarmTargets(scene, c);
    assert.deepEqual(targets.map(value => value.id), [target.id], targetType + ' 应保留同步后的目标');
    assert.equal(alarm.resolveAlarmTrigger(c, targets[0], message([{ p: 'normal', v: true }]), 1500), 'fire');
  }
});

test('旧场景无模型身份时兼容同一路径的URL编码和修订参数', () => {
  const target = { ...entity, components: { ...entity.components, modelAsset: { ...entity.components.modelAsset,
    sourcePath: 'C:/models/device.glb', sourceUrl: 'editor-asset://local/C%3A%2Fmodels%2Fdevice.glb?revision=2',
  } } };
  const c = { ...config, targets: [{ id: 'slot', entityId: '', model: { kind: 'model', modelAsset: {
    sourcePath: 'C:\\models\\device.glb', sourceUrl: 'editor-asset://local/C%3A%5Cmodels%5Cdevice.glb?revision=1',
  } } }] };
  assert.deepEqual(alarm.resolveAlarmTargets({ entityIds: [target.id], entities: { [target.id]: target } }, c), [target]);
});

test('模型身份不跨中台来源、资源或包内子模型，明确实体限定不扩大范围', () => {
  const identity = { sourceKey: 'a'.repeat(64), kind: 'model', resourceId: '42', modelPath: 'device.glb' };
  const asset = { sourceUrl: 'editor-asset://local/device.glb', dataPlatformModel: identity };
  const targets = [{ id: 'slot', entityId: '', model: { kind: 'model', modelAsset: asset } }];
  const variants = [{}, { sourceKey: 'b'.repeat(64) }, { kind: 'combo' }, { resourceId: '43' }, { modelPath: 'other.glb' }];
  const devices = variants.map((patch, i) => ({ ...entity, id: 'device-' + i, components: { ...entity.components,
    modelAsset: { ...entity.components.modelAsset, ...asset, dataPlatformModel: { ...identity, ...patch } },
  } }));
  const scene = { entityIds: devices.map(d => d.id), entities: Object.fromEntries(devices.map(d => [d.id, d])) };
  assert.deepEqual(alarm.resolveAlarmTargets(scene, { ...config, targets }).map(d => d.id), ['device-0']);
  assert.deepEqual(alarm.resolveAlarmTargets(scene, { ...config, targets: [{ ...targets[0], entityId: 'device-2' }] }).map(d => d.id), ['device-2']);
  assert.deepEqual(alarm.resolveAlarmTargets(scene, { ...config, targets: [{ ...targets[0], entityId: 'deleted-device' }] }), []);
  assert.deepEqual(alarm.resolveAlarmTargets(scene, { ...config, targetType: 'MODEL', targets: [{ ...targets[0], entityId: 'device-2' }] }).map(d => d.id), ['device-0']);
  assert.deepEqual([...alarm.collectAlarmIndependentEntityIds({ entityIds: ['manager', ...scene.entityIds], entities: {
    ...scene.entities, manager: { id: 'manager', components: { alarmManager: { ...config, targets } } },
  } })], ['device-0']);
});

test('旧实体缺少中台身份时仍可按精确资源位置匹配，不按名称猜测', () => {
  const modelAsset = { sourcePath: 'C:/models/device.glb', sourceUrl: 'editor-asset://local/device.glb' };
  const target = { ...entity, components: { ...entity.components, modelAsset } };
  const c = { ...config, targets: [{ id: 'slot', entityId: '', model: { kind: 'model', modelAsset: {
    ...modelAsset, dataPlatformModel: { sourceKey: 'a'.repeat(64), kind: 'model', resourceId: '42', modelPath: 'device.glb' },
  } } }] };
  const scene = { entityIds: [target.id], entities: { [target.id]: target } };
  assert.deepEqual(alarm.resolveAlarmTargets(scene, c), [target]);
  const other = { ...target, components: { ...target.components, modelAsset: { sourcePath: 'C:/other/device.glb', sourceUrl: 'editor-asset://local/other.glb' } } };
  assert.deepEqual(alarm.resolveAlarmTargets({ ...scene, entities: { [target.id]: other } }, c), []);
});

test('诊断区分禁用、缺少绑定、未配置、等待、点位缺失与不支持值，已收到的点位不因时间过期', () => {
  const active = message([{ p: 'fire.signal', v: 1 }]);
  const disabled = { ...entity, components: { ...entity.components, telemetryBinding: { ...entity.components.telemetryBinding, enabled: false } } };
  assert.equal(diagnostic(active, { entity: disabled }).status, 'disabled');
  assert.equal(diagnostic(null, { entity: { id: 'none', components: {} } }).status, 'unbound');
  assert.equal(diagnostic(active, { config: { ...config, customProperty: '' } }).status, 'unconfigured');
  assert.equal(diagnostic(null).status, 'waiting');
  assert.equal(diagnostic(active, { now: 2000 }).status, 'matched');
  assert.equal(diagnostic(active, { now: 86400000 }).status, 'matched');
  assert.equal(diagnostic(active, { now: 86400000 }).trigger, 'fire');
  assert.equal(diagnostic(message([{ p: 'temperature', v: 20 }])).status, 'missing');
  assert.equal(diagnostic(message([{ p: 'fire.signal' }])).status, 'missing');
  for (const value of [null, {}, []]) assert.equal(diagnostic(message([{ p: 'fire.signal', v: value }])).status, 'invalid');
  assert.equal(diagnostic(message([{ p: 'fire.signal', v: 0 }])).status, 'unmatched');
});

test('值比较保留数值字符串、单向布尔兼容及旧点路径规则，零和空串不当作缺失', () => {
  const cases = [
    ['1', 1, true], ['1', '1', true], ['1', true, false],
    ['true', true, true], ['true', 1, true], ['true', ' TRUE ', true],
    ['false', false, true], ['false', 0, true], ['0', false, false],
    ['0', 0, true], ['', '', true], ['ALARM', 'alarm', true], ['001', 1, false],
  ];
  for (const [expected, actual, matches] of cases) {
    const snapshot = message([{ p: 'fire.signal', v: actual }]);
    const c = { ...config, customValue: expected };
    assert.equal(diagnostic(snapshot, { config: c }).status, matches ? 'matched' : 'unmatched', `${JSON.stringify(expected)} / ${JSON.stringify(actual)}`);
    assert.equal(alarm.isAlarmTriggered(c, entity, snapshot, 1500), matches);
  }
  assert.equal(diagnostic(message([{ p: 'fire', v: { signal: 1 } }])).status, 'matched');
  assert.equal(diagnostic(message([{ p: 'Fire.signal', v: 1 }])).status, 'missing');
});

test('原始遥测仍按整帧替换，重复p和乱序规则保持，报警另行保留所订阅点位', () => {
  const store = new DeviceTelemetryStore();
  store.upsert(message([{ p: 'fire.signal', v: 0 }, { p: 'fire.signal', v: 1 }, { e: 'B', p: 'fire.signal', v: 0 }]));
  assert.equal(diagnostic(store.getSnapshot('A', 'conveyor', 'plant-1')).status, 'matched');
  store.upsert(message([{ p: 'temperature', v: 30 }], { sequence: 2, receivedAt: 1300 }));
  assert.equal(diagnostic(store.getSnapshot('A', 'conveyor', 'plant-1')).status, 'missing');
  assert.equal(store.upsert(message([{ p: 'fire.signal', v: 1 }], { sequence: 1, receivedAt: 1400 })), false);
  assert.equal(diagnostic(store.getSnapshot('A', 'conveyor', 'plant-1')).trigger, null);
});

test('报警逐消息保留点位，间隔内的其它点位不覆盖，重复值和长时间无新值不解除', () => {
  const store = new DeviceTelemetryStore(), tracker = new AlarmTelemetryTracker(store);
  const binding = alarm.resolveAlarmDeviceBinding(entity);
  tracker.watch([{ ...binding, properties: ['fire.signal'] }]);
  try {
    store.upsert(message([{ p: 'fire.signal', v: 1 }]));
    store.upsert(message([{ p: 'temperature', v: 30 }], { sequence: 2, receivedAt: 1100 }));
    assert.equal(store.getSnapshot('A', 'conveyor', 'plant-1').fields['fire.signal'], undefined);
    const held = tracker.getSnapshot(binding, 'fire.signal');
    assert.equal(held.receivedAt, 1000, '其它点位消息不更新该点位接收时间');
    assert.equal(diagnostic(held, { now: 86400000 }).status, 'matched');
    store.upsert(message([{ p: 'fire.signal', v: 1 }], { sequence: 3, receivedAt: 86400300 }));
    assert.equal(diagnostic(tracker.getSnapshot(binding), { now: 172800000 }).trigger, 'fire');
    assert.equal(store.upsert(message([{ p: 'fire.signal', v: 0 }], { sequence: 2, receivedAt: 86400500 })), false);
    assert.equal(diagnostic(tracker.getSnapshot(binding)).status, 'matched');
    store.upsert(message([{ p: 'fire.signal', v: 0 }], { sequence: 4, receivedAt: 172800300 }));
    assert.equal(diagnostic(tracker.getSnapshot(binding)).status, 'unmatched');
    store.upsert(message([{ p: 'fire.signal', v: null }], { sequence: 5, receivedAt: 172800600 }));
    assert.equal(diagnostic(tracker.getSnapshot(binding)).status, 'invalid');
    store.upsert(message([{ p: 'fire.signal' }], { sequence: 6, receivedAt: 172800900 }));
    assert.equal(diagnostic(tracker.getSnapshot(binding)).status, 'invalid', '缺失v不重新定义上次值');
  } finally { tracker.dispose(); }
});

test('后打开的诊断复用运行时保留点位，订阅释放后不残留历史', () => {
  const store = new DeviceTelemetryStore(), runtime = new AlarmTelemetryTracker(store);
  const binding = alarm.resolveAlarmDeviceBinding(entity), request = { ...binding, properties: ['fire.signal'] };
  runtime.watch([request]);
  store.upsert(message([{ p: 'fire.signal', v: 1 }]));
  store.upsert(message([{ p: 'temperature', v: 30 }], { sequence: 2, receivedAt: 1300 }));
  const panel = new AlarmTelemetryTracker(store);
  try {
    panel.watch([request]);
    assert.equal(diagnostic(panel.getSnapshot(binding)).status, 'matched');
    panel.dispose();
    assert.equal(diagnostic(runtime.getSnapshot(binding)).status, 'matched');
    runtime.dispose();
    const reopened = new AlarmTelemetryTracker(store);
    try { reopened.watch([request]); assert.equal(diagnostic(reopened.getSnapshot(binding)).status, 'missing'); }
    finally { reopened.dispose(); }
  } finally { panel.dispose(); runtime.dispose(); }
});

test('报警值按设备与来源隔离，显式清空、取消订阅和重启正确释放或重新接收', () => {
  const store = new DeviceTelemetryStore(), tracker = new AlarmTelemetryTracker(store);
  const binding = alarm.resolveAlarmDeviceBinding(entity), other = { ...binding, sourceId: 'plant-2' };
  tracker.watch([{ ...binding, properties: ['fire.signal'] }, { ...other, properties: ['fire.signal'] }]);
  try {
    store.upsert(message([{ p: 'fire.signal', v: 1 }]));
    store.upsert(message([{ p: 'fire.signal', v: 0 }], { sourceId: 'plant-2' }));
    assert.equal(diagnostic(tracker.getSnapshot(binding)).status, 'matched');
    assert.equal(diagnostic(tracker.getSnapshot(other)).status, 'unmatched');
    store.clearSource('plant-1');
    assert.equal(tracker.getSnapshot(binding), null);
    assert.equal(diagnostic(tracker.getSnapshot(other)).status, 'unmatched');
    tracker.reset(); assert.equal(tracker.getSnapshot(other), null);
    store.upsert(message([{ p: 'fire.signal', v: 1 }], { sourceId: 'plant-2', sequence: 2, receivedAt: 1300 }));
    assert.equal(diagnostic(tracker.getSnapshot(other)).status, 'matched');
    tracker.watch([]); assert.equal(tracker.getSnapshot(other), null);
    tracker.watch([{ ...binding, properties: ['fire.signal'] }]);
    store.upsert(message([{ p: 'fire.signal', v: 1 }]));
    store.clear(); assert.equal(tracker.getSnapshot(binding), null);
  } finally { tracker.dispose(); }
});

test('仓库条件与自定义条件分别诊断，不把缺失点位显示为火警命中', () => {
  const c = { ...config, warehouseAlarm: true };
  const warehouseOnly = diagnostic(message([{ p: 'warehouseAlarm', v: true }]), { config: c });
  assert.equal(warehouseOnly.status, 'missing');
  assert.equal(warehouseOnly.trigger, 'warehouse');
  assert.equal(diagnostic(message([{ p: 'fire.signal', v: 1 }]), { config: c }).trigger, 'warehouse');
});
