import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import mqtt from 'mqtt';
import { createPerformanceMqttReplay, createPerformanceReplayPayload } from '../../scripts/lib/performanceMqttReplay.mjs';

test('隔离 MQTT 回放经实际订阅保序到达，同值心跳与运动序列确定可重复', async () => {
  const device = { deviceType: 'stacker', assetCode: 'fixture-1' };
  assert.deepEqual(createPerformanceReplayPayload(device, 1, 'static'), createPerformanceReplayPayload(device, 2, 'static'));
  assert.deepEqual(createPerformanceReplayPayload(device, 8, 'motion'), createPerformanceReplayPayload(device, 8, 'motion'));
  const server = await createPerformanceMqttReplay([device], 100);
  const client = mqtt.connect(server.address, { reconnectPeriod: 0 });
  try {
    await once(client, 'connect');
    await client.subscribeAsync('dt/factory/logistics/+/+/twindatadriven/joint');
    const received = [];
    const complete = new Promise(resolve => client.on('message', (_topic, payload) => {
      received.push(JSON.parse(payload.toString()));
      if (received.length === 3) resolve();
    }));
    server.setMode('motion');
    await complete;
    assert.deepEqual(received.slice(0, 3).map(value => value.seq), [1, 2, 3]);
    assert.equal(server.getMetrics().failures, 0);
  } finally {
    await client.endAsync(true);
    await server.close();
  }
});

test('反复开始停止预览的物理连接不会与上一轮回放重叠', async () => {
  const server = await createPerformanceMqttReplay([{ deviceType: 'conveyor', assetCode: 'fixture' }], 100);
  try {
    for (let index = 0; index < 3; index += 1) {
      const client = mqtt.connect(server.address, { reconnectPeriod: 0 });
      try {
        await once(client, 'connect');
        await client.subscribeAsync('dt/factory/logistics/+/+/twindatadriven/joint');
        const received = once(client, 'message');
        server.setMode('static');
        await received;
        server.setMode('silent');
      } finally {
        await client.endAsync(true);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(server.getMetrics().failures, 0, JSON.stringify(server.getMetrics()));
    assert.equal(server.getMetrics().clients, 0);
  } finally {
    await server.close();
  }
});

test('真实录制按原顺序和原始 payload 重放，不改写源时间与序号', async () => {
  const records = [
    { atMs: 1000, topic: 'dt/factory/logistics/stacker/A/twindatadriven/joint', payloadText: '{"seq":7,"ts":123,"data":[]}' },
    { atMs: 1030, topic: 'dt/factory/logistics/stacker/A/twindatadriven/joint', payloadText: '{"seq":8,"ts":153,"data":[]}' },
  ];
  const server = await createPerformanceMqttReplay([], 100, { records, durationMs: 30 });
  const client = mqtt.connect(server.address, { reconnectPeriod: 0 });
  try {
    await once(client, 'connect');
    await client.subscribeAsync('dt/factory/logistics/#');
    const payloads = [];
    const completed = new Promise(resolve => client.on('message', (_topic, payload) => {
      payloads.push(payload.toString());
      if (payloads.length === 2) resolve();
    }));
    server.setMode('motion');
    await completed;
    assert.deepEqual(payloads, records.map(record => record.payloadText));
    assert.equal(server.getMetrics().ticks, 2);
    server.setMode('silent');
  } finally {
    await client.endAsync(true); await server.close();
  }
});
