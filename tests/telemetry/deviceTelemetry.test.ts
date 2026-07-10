import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { MqttConfig } from '../../src/editor/model/SceneDocument';

import { resolveMqttStackerSubscriptions } from '../../src/runtime/mqtt/MqttStackerTelemetryConfig';
import { GenericTelemetrySimulator, createGenericTelemetrySimulatorPayload } from '../../src/runtime/mqtt/GenericTelemetrySimulator';
import { StackerTelemetrySimulator } from '../../src/runtime/mqtt/StackerTelemetrySimulator';
import {
  deviceTelemetryStore,
  DeviceTelemetryStore,
  parseDeviceTelemetryMessage,
  type DeviceTelemetrySnapshot,
  type TelemetryAdapterConfig,
} from '../../src/runtime/mqtt/deviceTelemetry';

test('EPV 适配器过滤非本设备点位和非有限数值，并保留 Stacker 兼容字段', () => {
  const topic = 'dt/factory/logistics/stacker/STK-01/twindatadriven/joint';
  const payloadText = '{"seq":7,"ts":1700000000123,"data":[{"e":"STK-01","p":"front_x","v":2},{"e":"OTHER","p":"front_y","v":9},{"e":"STK-01","p":"bad","v":1e999},{"e":"STK-01","p":"normal","v":false},{"e":"STK-01","p":"errorCode","v":0},{"e":"STK-01","p":"message","v":"急停"}]}';

  const snapshot = parseDeviceTelemetryMessage(topic, payloadText);

  assert.ok(snapshot);
  assert.equal(snapshot.sourceId, 'default');
  assert.equal(snapshot.deviceType, 'stacker');
  assert.equal(snapshot.assetCode, 'STK-01');
  assert.equal(snapshot.sequence, 7);
  assert.equal(snapshot.sourceTimestamp, 1700000000123);
  assert.deepEqual(snapshot.fields, {
    front_x: 2,
    normal: false,
    errorCode: 0,
    message: '急停',
  });
  assert.equal(snapshot.faulted, true);
});

test('JSON Path 适配器只解析安全点号和数组索引路径，缺失字段跳过', () => {
  const adapter: TelemetryAdapterConfig = {
    kind: 'json-path',
    sourceId: 'plc-a',
    deviceTypePath: 'device.type',
    assetCodePath: 'device.assetCode',
    timestampPath: 'meta.timestamp',
    sequencePath: 'meta.sequence',
    fields: {
      speed: 'state.axes[0].speed',
      label: 'state.labels[1]',
      missing: 'state.labels[9]',
    },
  };
  const payloadText = JSON.stringify({
    device: { type: 'conveyor', assetCode: 'CV-02' },
    meta: { timestamp: '1700000000456', sequence: 11 },
    state: { axes: [{ speed: 1.25 }], labels: ['a', 'b'] },
  });

  const snapshot = parseDeviceTelemetryMessage('custom/topic', payloadText, adapter);

  assert.ok(snapshot);
  assert.equal(snapshot.sourceId, 'plc-a');
  assert.equal(snapshot.deviceType, 'conveyor');
  assert.equal(snapshot.assetCode, 'CV-02');
  assert.equal(snapshot.sourceTimestamp, 1700000000456);
  assert.equal(snapshot.sequence, 11);
  assert.deepEqual(snapshot.fields, { speed: 1.25, label: 'b' });
});

test('DeviceTelemetryStore 以 sourceId/deviceType/assetCode 保存历史并拒绝乱序数据', () => {
  const store = new DeviceTelemetryStore();
  const first = createSnapshot({ sequence: 1, sourceTimestamp: 100, receivedAt: 1000, fields: { speed: 1 } });
  const second = createSnapshot({ sequence: 2, sourceTimestamp: 200, receivedAt: 2000, fields: { speed: 2 } });
  const duplicate = createSnapshot({ sequence: 2, sourceTimestamp: 200, receivedAt: 3000, fields: { speed: 3 } });
  const staleTimestamp = createSnapshot({ sequence: null, sourceTimestamp: 150, receivedAt: 4000, fields: { speed: 4 } });

  assert.equal(store.upsert(first), true);
  assert.equal(store.upsert(second), true);
  assert.equal(store.upsert(duplicate), false);
  assert.equal(store.upsert(staleTimestamp), false);

  assert.deepEqual(store.getSnapshot('A-01', 'stacker')?.fields, { speed: 2 });
  assert.deepEqual(store.getSnapshotHistory('A-01', 'stacker'), {
    previous: first,
    current: second,
  });
  assert.equal(store.getSnapshotsByDeviceType('stacker').length, 1);
});


test('DeviceTelemetryStore 在无序号和无源时间时按内容签名拒绝重复快照', () => {
  const store = new DeviceTelemetryStore();
  const first = createSnapshot({ sequence: null, sourceTimestamp: null, receivedAt: 1000, fields: { speed: 1 } });
  const sameContentLater = createSnapshot({ sequence: null, sourceTimestamp: null, receivedAt: 2000, fields: { speed: 1 } });
  const changedFieldsLater = createSnapshot({ sequence: null, sourceTimestamp: null, receivedAt: 3000, fields: { speed: 2 } });

  assert.equal(store.upsert(first), true);
  assert.equal(store.upsert(sameContentLater), false);
  assert.equal(store.upsert(changedFieldsLater), true);

  assert.deepEqual(store.getSnapshotHistory('A-01', 'stacker'), {
    previous: first,
    current: changedFieldsLater,
  });
});



test('DeviceTelemetryStore clearSource 只清理指定 sourceId 快照', () => {
  const store = new DeviceTelemetryStore();
  const owned = createSnapshot({ sourceId: 'owned', assetCode: 'OWN-01', fields: { speed: 1 } });
  const foreign = createSnapshot({ sourceId: 'foreign', assetCode: 'EXT-01', fields: { speed: 9 } });

  assert.equal(store.upsert(owned), true);
  assert.equal(store.upsert(foreign), true);
  store.clearSource('owned');

  assert.equal(store.getSnapshot('OWN-01', 'stacker', 'owned'), null);
  assert.equal(store.getSnapshot('EXT-01', 'stacker', 'foreign'), foreign);
});



test('MqttStackerTelemetryClient 原样透传 JSON Path subscription 配置', () => {
  const jsonPathSubscription = {
    topic: 'factory/custom/telemetry',
    qos: 1 as const,
    adapter: {
      kind: 'json-path' as const,
      sourceId: 'plc-json',
      deviceTypePath: 'device.type',
      assetCodePath: 'device.assetCode',
      timestampPath: 'meta.timestamp',
      sequencePath: 'meta.sequence',
      fields: { speed: 'state.speed' },
    },
  };
  const config = createMqttConfig({ subscriptions: [jsonPathSubscription] });

  const subscriptions = resolveMqttStackerSubscriptions(config);

  assert.equal(subscriptions, config.subscriptions);
  assert.equal(subscriptions[0].qos, 1);
  assert.equal(subscriptions[0].adapter.kind, 'json-path');
  assert.equal(subscriptions[0].adapter.sourceId, 'plc-json');
  assert.deepEqual(subscriptions[0].adapter, jsonPathSubscription.adapter);

  const wrapperSource = readFileSync('src/runtime/mqtt/MqttStackerTelemetryClient.ts', 'utf8');
  assert.match(wrapperSource, /subscriptions:\s*config\.subscriptions/);
  assert.match(wrapperSource, /resolveMqttStackerSubscriptions\(config\)/);
  assert.match(wrapperSource, /subscriptions,\s*\n\s*\}\);/);
});

test('MqttStackerTelemetryClient 仅在 subscriptions 为空时回退 legacy topic', () => {
  const config = createMqttConfig({
    topic: 'legacy/a, legacy/b',
    subscriptions: [],
  });

  assert.deepEqual(resolveMqttStackerSubscriptions(config), [
    { topic: 'legacy/a', qos: 0, adapter: { kind: 'epv' } },
    { topic: 'legacy/b', qos: 0, adapter: { kind: 'epv' } },
  ]);
});

test('StackerTelemetrySimulator 停用时只清理默认源模拟快照', () => {
  const originalWindow = globalThis.window;
  const timers = new Set<number>();
  let nextTimerId = 1;
  globalThis.window = {
    setInterval: () => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.add(timerId);
      return timerId;
    },
    clearInterval: (timerId: number) => {
      timers.delete(timerId);
    },
  } as unknown as Window & typeof globalThis;

  try {
    deviceTelemetryStore.clear();
    const simulator = new StackerTelemetrySimulator(() => undefined);
    const foreign = createSnapshot({ sourceId: 'foreign', assetCode: 'EXT-01', fields: { speed: 9 } });
    assert.equal(deviceTelemetryStore.upsert(foreign), true);

    simulator.updateConfig(createMqttConfig({ enabled: true, simulatorEnabled: true }));
    assert.ok(deviceTelemetryStore.getSnapshot('STK-SIM-01', 'stacker'));

    simulator.updateConfig(createMqttConfig({ enabled: true, simulatorEnabled: false, address: '' }));

    assert.equal(deviceTelemetryStore.getSnapshot('STK-SIM-01', 'stacker'), null);
    assert.equal(deviceTelemetryStore.getSnapshot('EXT-01', 'stacker', 'foreign'), foreign);
    assert.equal(timers.size, 0);
    simulator.dispose();
  } finally {
    deviceTelemetryStore.clear();
    globalThis.window = originalWindow;
  }
});

test('GenericTelemetrySimulator 按 EPV 入口写入两台 generic-machine 且方向相反', () => {
  const originalWindow = globalThis.window;
  const timers = new Set<number>();
  let nextTimerId = 1;
  globalThis.window = {
    setInterval: () => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.add(timerId);
      return timerId;
    },
    clearInterval: (timerId: number) => {
      timers.delete(timerId);
    },
  } as unknown as Window & typeof globalThis;

  try {
    deviceTelemetryStore.clear();
    const logs: string[] = [];
    const simulator = new GenericTelemetrySimulator((message) => logs.push(message));
    simulator.updateConfig(createMqttConfig({ enabled: true, simulatorEnabled: true, simulatorScenario: 'generic', simulatorAssetCode: 'GEN-A, GEN-B', simulatorIntervalMs: 500 }));

    const first = deviceTelemetryStore.getSnapshot('GEN-A', 'generic-machine');
    const second = deviceTelemetryStore.getSnapshot('GEN-B', 'generic-machine');

    assert.ok(first);
    assert.ok(second);
    assert.equal(first.fields.operation_state, 'forward');
    assert.equal(second.fields.operation_state, 'reverse');
    assert.equal(first.fields.normal, true);
    assert.equal(first.fields.errorCode, 0);
    assert.equal(first.fields.message, 'generic forward');
    assert.equal(first.sequence, 0);
    assert.equal(typeof first.sourceTimestamp, 'number');
    assert.notEqual(first.fields.position_x, second.fields.position_x);
    assert.notEqual(first.fields.joint_angle_deg, second.fields.joint_angle_deg);
    assert.equal(timers.size, 1);

    simulator.dispose();
    assert.equal(deviceTelemetryStore.getSnapshot('GEN-A', 'generic-machine'), null);
    assert.equal(deviceTelemetryStore.getSnapshot('GEN-B', 'generic-machine'), null);
    assert.equal(logs.filter((message) => message.includes('generic')).length >= 1, true);
  } finally {
    deviceTelemetryStore.clear();
    globalThis.window = originalWindow;
  }
});

test('GenericTelemetrySimulator 20 秒周期覆盖 fault stale recovery 阶段', () => {
  const startMs = 1_700_000_000_000;
  const forward = createGenericTelemetrySimulatorPayload('GEN-A', 0, startMs, startMs, 0, 2);
  const reverse = createGenericTelemetrySimulatorPayload('GEN-A', 6_000, startMs + 6_000, startMs, 0, 2);
  const fault = createGenericTelemetrySimulatorPayload('GEN-A', 10_000, startMs + 10_000, startMs, 0, 2);
  const stale = createGenericTelemetrySimulatorPayload('GEN-A', 14_000, startMs + 14_000, startMs, 0, 2);
  const recovery = createGenericTelemetrySimulatorPayload('GEN-A', 19_000, startMs + 19_000, startMs, 0, 2);

  assert.equal(readPayloadPoint(forward, 'operation_state'), 'forward');
  assert.equal(readPayloadPoint(reverse, 'operation_state'), 'reverse');
  assert.equal(readPayloadPoint(fault, 'operation_state'), 'fault');
  assert.equal(readPayloadPoint(fault, 'normal'), false);
  assert.equal(stale, null);
  assert.equal(readPayloadPoint(recovery, 'operation_state'), 'recovery');
  assert.equal(readPayloadPoint(recovery, 'normal'), true);
});

test('MqttTelemetryClient 事件回调具备 stale client 守卫并使用连接时订阅快照', () => {
  const clientSource = readFileSync('src/runtime/mqtt/MqttTelemetryClient.ts', 'utf8');
  for (const eventName of ['connect', 'message', 'error', 'close']) {
    const eventIndex = clientSource.indexOf("client.on('" + eventName + "'");
    assert.notEqual(eventIndex, -1, eventName + ' 事件必须存在');
    const nextEventIndex = clientSource.indexOf('client.on(', eventIndex + 1);
    const eventBlock = clientSource.slice(eventIndex, nextEventIndex === -1 ? undefined : nextEventIndex);
    assert.match(eventBlock, /this\.client !== client/, eventName + ' 事件必须忽略旧 client 回调');
  }
  assert.match(clientSource, /resolveSubscriptionForTopic\(topic, subscriptions\)/);
  assert.doesNotMatch(clientSource, /resolveSubscriptionForTopic\(topic, this\.activeSubscriptions\)/);
});

function createSnapshot(overrides: Partial<DeviceTelemetrySnapshot>): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'dt/factory/logistics/stacker/A-01/twindatadriven/joint',
    deviceType: 'stacker',
    assetCode: 'A-01',
    payloadDeviceCode: 'A-01',
    sourceTimestamp: null,
    sequence: null,
    receivedAt: Date.now(),
    fields: {},
    currentLocationKey: null,
    targetLocationKey: null,
    hasTargetLocation: false,
    faulted: false,
    message: '',
    ...overrides,
  };
}


function createMqttConfig(overrides: Partial<MqttConfig> = {}): MqttConfig {
  return {
    enabled: false,
    ip: '',
    address: '',
    topic: 'dt/factory/logistics/stacker/STK-SIM-01/twindatadriven/joint',
    subscriptions: [{ topic: 'dt/factory/logistics/stacker/STK-SIM-01/twindatadriven/joint', qos: 0, adapter: { kind: 'epv' } }],
    simulatorEnabled: false,
    simulatorAssetCode: 'STK-SIM-01',
    simulatorScenario: 'cycle',
    simulatorIntervalMs: 1000,
    ...overrides,
  };
}

function readPayloadPoint(payload: ReturnType<typeof createGenericTelemetrySimulatorPayload>, name: string): unknown {
  if (!payload) return undefined;
  return payload.data.find((point) => point.p === name)?.v;
}
