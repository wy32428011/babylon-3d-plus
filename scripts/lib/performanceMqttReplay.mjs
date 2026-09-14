import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';

// 复用 mqtt 自带依赖，不要求 npm 把传递依赖提升到项目根目录。
const require = createRequire(import.meta.url);
const mqttRequire = createRequire(require.resolve('mqtt'));
const mqttPacket = mqttRequire('mqtt-packet');
const { WebSocket, WebSocketServer, createWebSocketStream } = mqttRequire('ws');

/** 隔离性能回放服务，只绑定 loopback，不连接或向实际 Broker 发布消息。 */
export async function createPerformanceMqttReplay(devices, intervalMs = 500, options = {}) {
  assert.ok(Number.isFinite(intervalMs) && intervalMs >= 100);
  const records = options.records ?? null;
  if (records) {
    assert.ok(records.length > 0 && records.length <= 10000);
    assert.ok(records.every((record, index) => Number.isFinite(record.atMs) && typeof record.topic === 'string'
      && typeof record.payloadText === 'string' && (index === 0 || record.atMs >= records[index - 1].atMs)));
    assert.ok(records.reduce((total, record) => total + Buffer.byteLength(record.payloadText), 0) <= 16 * 1024 * 1024);
  }
  const timeline = records?.map(record => ({ ...record, atMs: record.atMs - records[0].atMs }))
    .filter(record => record.atMs <= (options.durationMs ?? Infinity));
  const sockets = new Set();
  const subscriptions = new Map();
  const transports = new WeakMap();
  let timer, tick = 0, running = false, generation = 0;
  let mode = 'silent';
  let replayStarted = 0, recordIndex = 0;
  let messages = 0, bytes = 0, failures = 0;
  const failureDetails = [];
  const send = (socket, packet) => {
    if (socket.destroyed || socket.writableEnded || transports.get(socket)?.readyState !== WebSocket.OPEN) return false;
    if (socket.writableLength > 1024 * 1024) {
      failures += 1;
      socket.destroy(new Error('性能回放客户端积压超过上限'));
      return false;
    }
    socket.write(mqttPacket.generate(packet));
    return true;
  };
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', websocket => {
    const socket = createWebSocketStream(websocket);
    transports.set(socket, websocket);
    websocket.once('close', () => {
      subscriptions.delete(socket);
      sockets.delete(socket);
      socket.destroy();
    });
    sockets.add(socket);
    const parser = mqttPacket.parser();
    socket.on('data', chunk => parser.parse(chunk));
    socket.on('error', error => { failures += 1; if (failureDetails.length < 10) failureDetails.push(error.code || error.message); });
    socket.on('close', () => { sockets.delete(socket); subscriptions.delete(socket); });
    parser.on('error', () => { failures += 1; socket.destroy(); });
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') send(socket, { cmd: 'connack', returnCode: 0, sessionPresent: false });
      else if (packet.cmd === 'subscribe') {
        subscriptions.set(socket, packet.subscriptions.map(value => value.topic));
        send(socket, { cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0) });
      } else if (packet.cmd === 'pingreq') send(socket, { cmd: 'pingresp' });
      else if (packet.cmd === 'disconnect') socket.end();
      else if (packet.cmd === 'unsubscribe') {
        subscriptions.delete(socket);
        send(socket, { cmd: 'unsuback', messageId: packet.messageId });
      }
    });
  });
  await once(server, 'listening');
  const publication = (topic, payloadText) => {
    const payload = Buffer.from(payloadText);
    for (const [socket, filters] of subscriptions) {
      if (!filters.some(filter => matches(filter, topic))) continue;
      if (send(socket, { cmd: 'publish', topic, payload, qos: 0, retain: false, dup: false })) {
        messages += 1;
        bytes += payload.length;
      }
    }
  };
  const publish = currentGeneration => {
    if (!running || generation !== currentGeneration) return;
    if (mode === 'silent') return;
    if (mode === 'motion' && timeline) {
      const elapsed = performance.now() - replayStarted;
      while (recordIndex < timeline.length && timeline[recordIndex].atMs <= elapsed) {
        const record = timeline[recordIndex++];
        publication(record.topic, record.payloadText);
        tick += 1;
      }
      if (recordIndex < timeline.length) timer = setTimeout(() => publish(currentGeneration),
        Math.max(1, timeline[recordIndex].atMs - (performance.now() - replayStarted)));
      return;
    }
    if (mode !== 'silent') {
      for (const device of devices) {
        const topic = `dt/factory/logistics/${device.deviceType}/${device.assetCode}/twindatadriven/joint`;
        publication(topic, JSON.stringify(createPerformanceReplayPayload(device, tick, mode, intervalMs)));
      }
      tick += 1;
    }
    timer = setTimeout(() => publish(currentGeneration), intervalMs);
  };
  return {
    address: `ws://127.0.0.1:${server.address().port}/mqtt`,
    setMode(next) {
      assert.ok(['silent', 'static', 'motion'].includes(next));
      generation += 1;
      clearTimeout(timer);
      mode = next;
      tick = 0;
      recordIndex = 0;
      replayStarted = performance.now();
      messages = 0;
      bytes = 0;
      running = true;
      publish(generation);
    },
    getMetrics: () => ({ mode, ticks: tick, messages, bytes, failures, failureDetails: [...failureDetails], clients: subscriptions.size }),
    async close() {
      running = false;
      generation += 1;
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export function createPerformanceReplayPayload(device, tick, mode, intervalMs = 500) {
  const moving = mode === 'motion';
  const seconds = tick * intervalMs / 1000;
  const direction = moving ? Math.floor(seconds / 8) % 2 + 1 : 0;
  const fields = {
    normal: true, errorCode: 0, runningState: moving ? 'running' : 'idle',
    mode: device.deviceType === 'conveyor' ? 2 : 3,
    movement_x: direction, movement_y: 0, rpm_x: moving ? 12 : 0,
    distance_x: moving ? Number((1 + Math.sin(seconds / 4) * 0.4).toFixed(4)) : 1,
    distance_y: 0, front_distance_z: 0, back_distance_z: 0,
    front_movement_z: 0, back_movement_z: 0, front_command: 0, back_command: 0,
    to_x: 0, to_y: 0, to_z: 0, task: 0, front_task: 0, back_task: 0,
    containerCode: '', front_containerCode: '', back_containerCode: '', containerQuantity: 0,
  };
  // 同值心跳不带时序；变化回放使用固定序号和固定源时间，C/D 可以逐条比较。
  return { data: Object.entries(fields).map(([p, v]) => ({ e: device.assetCode, p, v })),
    ...(moving ? { seq: tick + 1, ts: new Date(1_800_000_000_000 + tick * intervalMs).toISOString() } : {}) };
}

function matches(filter, topic) {
  const segments = topic.split('/');
  const filters = filter.split('/');
  for (let index = 0; index < filters.length; index += 1) {
    if (filters[index] === '#') return true;
    if (filters[index] !== '+' && filters[index] !== segments[index]) return false;
  }
  return segments.length === filters.length;
}
