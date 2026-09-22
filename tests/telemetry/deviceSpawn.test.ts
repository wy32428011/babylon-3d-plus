import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSpawnSnapshot,
  dispatchDeviceSpawnMessages,
  isDeviceSpawnTopic,
  onDeviceSpawnMessages,
  parseDeviceSpawnMessages,
  parseDeviceSpawnTopic,
  parseDeviceTelemetryMessage,
} from '../../src/runtime/mqtt/deviceTelemetry';

const SPAWN_TOPIC = 'dt/factory/logistics/agv/AGV-SPAWN/dataspawn/joint';

test('dataspawn topic 解析产生器 id，且不与 twindatadriven 互相命中', () => {
  assert.deepEqual(parseDeviceSpawnTopic(SPAWN_TOPIC), { deviceType: 'agv', spawnerCode: 'AGV-SPAWN' });
  assert.equal(isDeviceSpawnTopic(SPAWN_TOPIC), true);
  assert.equal(isDeviceSpawnTopic('dt/factory/logistics/stacker/STK-01/twindatadriven/joint'), false);
  assert.equal(parseDeviceSpawnTopic('dt/factory/logistics/agv/AGV-SPAWN/dataspawn'), null);
});

test('spawn 消息按 e 拆分多设备，s 缺失用 topic 段兜底，s 不一致与缺 e/p 的点位丢弃', () => {
  const payloadText = JSON.stringify({
    seq: 3,
    ts: 1700000000123,
    data: [
      { e: 'AGV-01', p: 'distance_x', v: 4.2 },
      { e: 'AGV-01', p: 'movement_x', v: 1, s: 'AGV-SPAWN' },
      { e: 'AGV-02', p: 'normal', v: true, s: 'AGV-SPAWN' },
      { e: 'AGV-02', p: 'distance_x', v: 9, s: 'OTHER-SPAWNER' },
      { p: 'distance_x', v: 1 },
      { e: 'AGV-03', p: '', v: 1 },
    ],
  });
  const payloadTextWithInvalid = payloadText.replace(
    '"data":[',
    '"data":[{"e":"AGV-01","p":"bad","v":1e999},',
  );

  const messages = parseDeviceSpawnMessages(SPAWN_TOPIC, payloadTextWithInvalid, 'line-a');

  assert.equal(messages.length, 2);
  const agv01 = messages.find((message) => message.assetCode === 'AGV-01');
  const agv02 = messages.find((message) => message.assetCode === 'AGV-02');
  assert.ok(agv01 && agv02);
  assert.equal(agv01.spawnerCode, 'AGV-SPAWN');
  assert.equal(agv01.deviceType, 'agv');
  assert.equal(agv01.sourceId, 'line-a');
  assert.equal(agv01.sequence, 3);
  assert.equal(agv01.sourceTimestamp, 1700000000123);
  assert.deepEqual(agv01.points, [
    { p: 'distance_x', v: 4.2 },
    { p: 'movement_x', v: 1 },
  ]);
  assert.deepEqual(agv02.points, [{ p: 'normal', v: true }]);
});

test('spawn 消息不做 e 与 topic 段相等过滤', () => {
  const payloadText = JSON.stringify({ data: [{ e: 'ANY-CODE', p: 'normal', v: true }] });
  const messages = parseDeviceSpawnMessages(SPAWN_TOPIC, payloadText);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].assetCode, 'ANY-CODE');
});

test('createSpawnSnapshot 复用统一归一语义并派生故障状态', () => {
  const [message] = parseDeviceSpawnMessages(
    SPAWN_TOPIC,
    JSON.stringify({
      ts: 1700000000123,
      data: [
        { e: 'AGV-01', p: 'normal', v: false },
        { e: 'AGV-01', p: 'errorCode', v: 9001 },
        { e: 'AGV-01', p: 'message', v: '模拟急停' },
      ],
    }),
  );
  assert.ok(message);

  const snapshot = createSpawnSnapshot(message);

  assert.equal(snapshot.deviceType, 'agv');
  assert.equal(snapshot.assetCode, 'AGV-01');
  assert.deepEqual(snapshot.fields, { normal: false, errorCode: 9001, message: '模拟急停' });
  assert.equal(snapshot.faulted, true);
});

test('dispatchDeviceSpawnMessages 命中 dataspawn topic 时分发给订阅者并拦截常规解析', () => {
  const received: string[][] = [];
  const unsubscribe = onDeviceSpawnMessages((messages) => {
    received.push(messages.map((message) => message.assetCode));
  });
  try {
    const hit = dispatchDeviceSpawnMessages(
      SPAWN_TOPIC,
      JSON.stringify({ data: [{ e: 'AGV-01', p: 'normal', v: true }] }),
    );
    assert.equal(hit, true);
    assert.deepEqual(received, [['AGV-01']]);

    const miss = dispatchDeviceSpawnMessages(
      'dt/factory/logistics/stacker/STK-01/twindatadriven/joint',
      JSON.stringify({ data: [{ e: 'STK-01', p: 'normal', v: true }] }),
    );
    assert.equal(miss, false);
  } finally {
    unsubscribe();
  }
});

test('twindatadriven 常规消息不受 spawn 解析影响（回归）', () => {
  const snapshot = parseDeviceTelemetryMessage(
    'dt/factory/logistics/stacker/STK-01/twindatadriven/joint',
    '{"seq":7,"ts":1700000000123,"data":[{"e":"STK-01","p":"front_x","v":2},{"e":"STK-01","p":"normal","v":true}]}',
  );
  assert.ok(snapshot);
  assert.equal(snapshot.assetCode, 'STK-01');
  assert.deepEqual(snapshot.fields, { front_x: 2, normal: true });
});
