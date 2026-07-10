import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeviceTelemetryStore,
  parseDeviceTelemetryMessage,
  type DeviceTelemetrySnapshot,
  type TelemetryAdapterConfig,
} from '../../src/runtime/mqtt/deviceTelemetry';

test('JSON Path 适配器支持文档式 $ 根前缀并保留无 $ 兼容', () => {
  const payloadText = JSON.stringify({
    device: { type: 'conveyor', assetCode: 'CV-ROOT-01' },
    state: { axes: [{ speed: 2.5 }] },
  });
  const rootPrefixedAdapter: TelemetryAdapterConfig = {
    kind: 'json-path',
    deviceTypePath: '$.device.type',
    assetCodePath: '$.device.assetCode',
    fields: { speed: '$.state.axes[0].speed' },
  };
  const legacyAdapter: TelemetryAdapterConfig = {
    kind: 'json-path',
    deviceTypePath: 'device.type',
    assetCodePath: 'device.assetCode',
    fields: { speed: 'state.axes[0].speed' },
  };
  const unsafeAdapter: TelemetryAdapterConfig = {
    kind: 'json-path',
    deviceTypePath: '$.device.type.constructor',
    assetCodePath: '$.device.assetCode',
    fields: {
      script: '$.state.axes[0][?(@.speed)]',
      prototype: '$.device.__proto__',
    },
  };

  const rootPrefixedSnapshot = parseDeviceTelemetryMessage('factory/custom/telemetry', payloadText, rootPrefixedAdapter);
  const legacySnapshot = parseDeviceTelemetryMessage('factory/custom/telemetry', payloadText, legacyAdapter);
  const unsafeSnapshot = parseDeviceTelemetryMessage('factory/custom/telemetry', payloadText, unsafeAdapter);

  assert.ok(rootPrefixedSnapshot);
  assert.equal(rootPrefixedSnapshot.deviceType, 'conveyor');
  assert.equal(rootPrefixedSnapshot.assetCode, 'CV-ROOT-01');
  assert.deepEqual(rootPrefixedSnapshot.fields, { speed: 2.5 });
  assert.deepEqual(legacySnapshot?.fields, { speed: 2.5 });
  assert.equal(unsafeSnapshot, null);
});

test('无序号无源时间且同 receivedAt 的不同快照进入前后两帧，相同内容仍去重', () => {
  const store = new DeviceTelemetryStore();
  const first = createSnapshot({ receivedAt: 1700000000000, fields: { speed: 1 } });
  const changedSameMillisecond = createSnapshot({ receivedAt: 1700000000000, fields: { speed: 2 } });
  const duplicateSameContent = createSnapshot({ receivedAt: 1700000000000, fields: { speed: 2 } });

  assert.equal(store.upsert(first), true);
  assert.equal(store.upsert(changedSameMillisecond), true);
  assert.equal(store.upsert(duplicateSameContent), false);
  assert.deepEqual(store.getSnapshotHistory('A-JSON-01', 'stacker'), {
    previous: first,
    current: changedSameMillisecond,
  });
});

test('无序号无源时间的相同内容心跳缓存稳定引用且不推进运动历史', () => {
  const store = new DeviceTelemetryStore();
  const first = createSnapshot({ receivedAt: 1700000000000, fields: { speed: 2 } });
  const heartbeat = createSnapshot({ receivedAt: 1700000001000, fields: { speed: 2 } });
  const duplicateHeartbeat = createSnapshot({ receivedAt: 1700000001000, fields: { speed: 2 } });
  const nextHeartbeat = createSnapshot({ receivedAt: 1700000002000, fields: { speed: 2 } });
  const staleChangedFrame = createSnapshot({ receivedAt: 1700000001500, fields: { speed: 3 } });

  assert.equal(store.upsert(first), true);
  assert.equal(store.upsert(heartbeat), false);
  const firstRead = store.getSnapshot('A-JSON-01', 'stacker');
  const secondRead = store.getSnapshot('A-JSON-01', 'stacker');
  assert.strictEqual(firstRead, secondRead);
  assert.equal(firstRead?.receivedAt, 1700000001000);

  assert.equal(store.upsert(duplicateHeartbeat), false);
  assert.strictEqual(store.getSnapshot('A-JSON-01', 'stacker'), firstRead);

  assert.equal(store.upsert(nextHeartbeat), false);
  const nextRead = store.getSnapshot('A-JSON-01', 'stacker');
  assert.notStrictEqual(nextRead, firstRead);
  assert.equal(nextRead?.receivedAt, 1700000002000);
  assert.equal(store.upsert(staleChangedFrame), false);
  assert.deepEqual(store.getSnapshotHistory('A-JSON-01', 'stacker'), {
    previous: null,
    current: first,
  });

  store.clearSource('default');
  assert.equal(store.getSnapshot('A-JSON-01', 'stacker'), null);
  assert.deepEqual(store.getSnapshots(), []);
});

test('内容相同但序号递增的心跳仍刷新当前快照和在线时间', () => {
  const store = new DeviceTelemetryStore();
  const first = createSnapshot({ sequence: 1, receivedAt: 1700000000000, fields: { speed: 2 } });
  const heartbeat = createSnapshot({ sequence: 2, receivedAt: 1700000001000, fields: { speed: 2 } });

  assert.equal(store.upsert(first), true);
  assert.equal(store.upsert(heartbeat), true);
  assert.equal(store.getSnapshot('A-JSON-01', 'stacker')?.sequence, 2);
  assert.equal(store.getSnapshot('A-JSON-01', 'stacker')?.receivedAt, 1700000001000);
});

/** 创建设备遥测快照测试数据。 */
function createSnapshot(overrides: Partial<DeviceTelemetrySnapshot>): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'dt/factory/logistics/stacker/A-JSON-01/twindatadriven/joint',
    deviceType: 'stacker',
    assetCode: 'A-JSON-01',
    payloadDeviceCode: 'A-JSON-01',
    sourceTimestamp: null,
    sequence: null,
    receivedAt: 1700000000000,
    fields: {},
    currentLocationKey: null,
    targetLocationKey: null,
    hasTargetLocation: false,
    faulted: false,
    message: '',
    ...overrides,
  };
}
