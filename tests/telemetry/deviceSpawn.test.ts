import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeviceTelemetryStore,
  ingestDeviceTelemetryMessage,
  onDeviceTelemetryMessages,
  parseDeviceTelemetryMessage,
  type DeviceTelemetrySnapshot,
} from '../../src/runtime/mqtt/deviceTelemetry';

const TOPIC = 'dt/factory/logistics/agv/AGV-01/twindatadriven/joint';

test('EPV 解析提取首个有效 s 为 spawnerCode，兼容数字与缺失', () => {
  const withString = parseDeviceTelemetryMessage(
    TOPIC,
    JSON.stringify({ data: [{ p: 'distance_x', v: 1, s: 'AGV-SPAWN' }] }),
  );
  assert.equal(withString?.spawnerCode, 'AGV-SPAWN');

  const withNumber = parseDeviceTelemetryMessage(
    TOPIC,
    JSON.stringify({ data: [{ p: 'distance_x', v: 1, s: 42 }] }),
  );
  assert.equal(withNumber?.spawnerCode, '42');

  const firstValidWins = parseDeviceTelemetryMessage(
    TOPIC,
    JSON.stringify({
      data: [
        { p: 'distance_x', v: 1 },
        { p: 'movement_x', v: 1, s: 'FIRST' },
        { p: 'normal', v: true, s: 'SECOND' },
      ],
    }),
  );
  assert.equal(firstValidWins?.spawnerCode, 'FIRST');

  const missing = parseDeviceTelemetryMessage(
    TOPIC,
    JSON.stringify({ data: [{ p: 'distance_x', v: 1 }] }),
  );
  assert.equal(missing?.spawnerCode, null);
});

test('twindatadriven 常规消息 e 过滤回归：assetCode 取自 topic，e 不一致的点位丢弃', () => {
  const snapshot = parseDeviceTelemetryMessage(
    'dt/factory/logistics/stacker/STK-01/twindatadriven/joint',
    '{"seq":7,"ts":1700000000123,"data":[{"e":"STK-01","p":"front_x","v":2},{"e":"OTHER","p":"front_x","v":9},{"p":"normal","v":true}]}',
  );
  assert.ok(snapshot);
  assert.equal(snapshot.assetCode, 'STK-01');
  assert.equal(snapshot.payloadDeviceCode, 'STK-01');
  assert.deepEqual(snapshot.fields, { front_x: 2, normal: true });
  assert.equal(snapshot.spawnerCode, null);
});

test('ingestDeviceTelemetryMessage 完成 解析→写入仓库→通知订阅者 全链路', () => {
  const store = new DeviceTelemetryStore();
  const received: DeviceTelemetrySnapshot[] = [];
  const unsubscribe = onDeviceTelemetryMessages((snapshot) => received.push(snapshot));
  try {
    const snapshot = ingestDeviceTelemetryMessage(
      TOPIC,
      JSON.stringify({ data: [{ p: 'distance_x', v: 4.2, s: 'AGV-SPAWN' }] }),
      { store },
    );
    assert.ok(snapshot);
    assert.equal(store.getSnapshot('AGV-01', 'agv', 'default')?.fields.distance_x, 4.2);
    assert.equal(received.length, 1);
    assert.equal(received[0].assetCode, 'AGV-01');
    assert.equal(received[0].spawnerCode, 'AGV-SPAWN');

    // 退订后不再通知，但仓库仍写入
    unsubscribe();
    ingestDeviceTelemetryMessage(TOPIC, JSON.stringify({ data: [{ p: 'distance_x', v: 9 }] }), { store });
    assert.equal(received.length, 1);
    assert.equal(store.getSnapshot('AGV-01', 'agv', 'default')?.fields.distance_x, 9);
  } finally {
    unsubscribe();
  }
});

test('spawnerCode 不进内容签名：同内容带/不带 s 判重，但订阅者仍收到每条消息（保活语义）', () => {
  const store = new DeviceTelemetryStore();
  const received: DeviceTelemetrySnapshot[] = [];
  const unsubscribe = onDeviceTelemetryMessages((snapshot) => received.push(snapshot));
  try {
    const first = ingestDeviceTelemetryMessage(
      TOPIC,
      JSON.stringify({ data: [{ p: 'distance_x', v: 4.2, s: 'AGV-SPAWN' }] }),
      { store },
    );
    const second = ingestDeviceTelemetryMessage(
      TOPIC,
      JSON.stringify({ data: [{ p: 'distance_x', v: 4.2 }] }),
      { store },
    );
    assert.ok(first && second);
    assert.equal(second.spawnerCode, null);
    // 内容签名不含 spawnerCode：第二条与第一条同内容，仓库判重不推进（快照仍是带 s 的第一条）
    assert.equal(store.getSnapshot('AGV-01', 'agv', 'default')?.spawnerCode, 'AGV-SPAWN');
    // 但订阅者两条都收到（产生器保活依赖每条消息触达）
    assert.equal(received.length, 2);
  } finally {
    unsubscribe();
  }
});

test('非设备遥测 topic 返回 null，不通知订阅者', () => {
  const store = new DeviceTelemetryStore();
  const received: DeviceTelemetrySnapshot[] = [];
  const unsubscribe = onDeviceTelemetryMessages((snapshot) => received.push(snapshot));
  try {
    const snapshot = ingestDeviceTelemetryMessage(
      'dt/factory/logistics/agv/AGV-01/other/joint',
      JSON.stringify({ data: [{ p: 'normal', v: true }] }),
      { store },
    );
    assert.equal(snapshot, null);
    assert.equal(received.length, 0);
  } finally {
    unsubscribe();
  }
});
