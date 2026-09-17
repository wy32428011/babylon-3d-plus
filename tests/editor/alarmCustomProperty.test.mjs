import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAlarmTestModules } from '../helpers/alarmTestModules.mjs';

const server = await buildAlarmTestModules();
const alarm = await server.ssrLoadModule('/src/editor/model/alarmManager.ts');
const { DeviceTelemetryStore, parseDeviceTelemetryMessage } = await server.ssrLoadModule('/src/runtime/mqtt/deviceTelemetry.ts');
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

test('诊断区分禁用、缺少绑定、未配置、等待、过期、点位缺失与不支持值', () => {
  const active = message([{ p: 'fire.signal', v: 1 }]);
  const disabled = { ...entity, components: { ...entity.components, telemetryBinding: { ...entity.components.telemetryBinding, enabled: false } } };
  assert.equal(diagnostic(active, { entity: disabled }).status, 'disabled');
  assert.equal(diagnostic(null, { entity: { id: 'none', components: {} } }).status, 'unbound');
  assert.equal(diagnostic(active, { config: { ...config, customProperty: '' } }).status, 'unconfigured');
  assert.equal(diagnostic(null).status, 'waiting');
  assert.equal(diagnostic(active, { now: 2000 }).status, 'matched');
  assert.equal(diagnostic(active, { now: 2001 }).status, 'stale');
  assert.equal(diagnostic(active, { now: 2001 }).trigger, null);
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

test('重复 p 最后有效项优先，错误 e 不混入；整帧缺点位不被累计为旧报警', () => {
  const store = new DeviceTelemetryStore();
  store.upsert(message([{ p: 'fire.signal', v: 0 }, { p: 'fire.signal', v: 1 }, { e: 'B', p: 'fire.signal', v: 0 }]));
  assert.equal(diagnostic(store.getSnapshot('A', 'conveyor', 'plant-1')).status, 'matched');
  store.upsert(message([{ p: 'temperature', v: 30 }], { sequence: 2, receivedAt: 1300 }));
  assert.equal(diagnostic(store.getSnapshot('A', 'conveyor', 'plant-1')).status, 'missing');
  assert.equal(store.upsert(message([{ p: 'fire.signal', v: 1 }], { sequence: 1, receivedAt: 1400 })), false);
  assert.equal(diagnostic(store.getSnapshot('A', 'conveyor', 'plant-1')).trigger, null);
});

test('仓库条件与自定义条件分别诊断，不把缺失点位显示为火警命中', () => {
  const c = { ...config, warehouseAlarm: true };
  const warehouseOnly = diagnostic(message([{ p: 'warehouseAlarm', v: true }]), { config: c });
  assert.equal(warehouseOnly.status, 'missing');
  assert.equal(warehouseOnly.trigger, 'warehouse');
  assert.equal(diagnostic(message([{ p: 'fire.signal', v: 1 }]), { config: c }).trigger, 'warehouse');
});
