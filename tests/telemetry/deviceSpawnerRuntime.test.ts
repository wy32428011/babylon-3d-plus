import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSpawnedDeviceKey,
  DeviceSpawnerRuntime,
  type DeviceSpawnerConfig,
} from '../../src/runtime/babylon/telemetry/spawner/DeviceSpawnerRuntime';
import {
  deviceTelemetryStore,
  ingestDeviceTelemetryMessage,
} from '../../src/runtime/mqtt/deviceTelemetry';

const SPAWNER: DeviceSpawnerConfig = {
  entityId: 'entity-spawner-1',
  entityName: '设备产生器',
  spawnerCode: 'AGV-SPAWN',
  templateEntityId: 'entity-template-1',
  timeoutSeconds: 30,
  deviceType: 'agv',
};

/** 动态设备使用与常规设备一致的 topic：assetCode 为设备自身编号。 */
function topicFor(assetCode: string, deviceType = 'agv'): string {
  return `dt/factory/logistics/${deviceType}/${assetCode}/twindatadriven/joint`;
}

function createHost() {
  const logs: string[] = [];
  const spawned: { spawnerCode: string; assetCode: string }[] = [];
  const disposed: string[] = [];
  const knownDevices = new Set<string>();
  let spawnResult = true;
  const host = {
    pushLog(message: string) {
      logs.push(message);
    },
    spawnDeviceInstance(spawner: DeviceSpawnerConfig, assetCode: string) {
      if (!spawnResult) return false;
      spawned.push({ spawnerCode: spawner.spawnerCode, assetCode });
      return true;
    },
    disposeDeviceInstance(key: string) {
      disposed.push(key);
    },
    isDeviceKnown(sourceId: string, deviceType: string, assetCode: string) {
      return knownDevices.has(`${sourceId}:${deviceType}:${assetCode}`);
    },
  };
  return {
    host,
    logs,
    spawned,
    disposed,
    knownDevices,
    setSpawnResult(value: boolean) {
      spawnResult = value;
    },
  };
}

/** 经统一入口投递一条消息；withSpawner 时点位携带产生器 id（上线首条）。 */
function sendMessage(assetCode: string, points: Record<string, unknown>[], { withSpawner = true, deviceType = 'agv' } = {}) {
  return ingestDeviceTelemetryMessage(
    topicFor(assetCode, deviceType),
    JSON.stringify({
      data: points.map((point) => (withSpawner ? { s: 'AGV-SPAWN', ...point } : point)),
      ts: new Date().toISOString(),
    }),
    { store: deviceTelemetryStore },
  );
}

test('首条带 s 的消息触发生成，客户端 upsert 的快照即实例驱动数据源', () => {
  const { host, spawned, disposed } = createHost();
  const runtime = new DeviceSpawnerRuntime(host);
  runtime.configure([SPAWNER]);
  try {
    sendMessage('AGV-01', [{ p: 'distance_x', v: 4.2 }]);
    assert.deepEqual(spawned, [{ spawnerCode: 'AGV-SPAWN', assetCode: 'AGV-01' }]);

    const snapshot = deviceTelemetryStore.getSnapshot('AGV-01', 'agv', 'default');
    assert.ok(snapshot, '快照应写入遥测仓库供驱动消费');
    assert.equal(snapshot.fields.distance_x, 4.2);
    assert.equal(snapshot.spawnerCode, 'AGV-SPAWN');

    // 同一资产编号再次收到消息：不重复生成，只刷新快照与心跳
    sendMessage('AGV-01', [{ p: 'distance_x', v: 7.7 }]);
    assert.equal(spawned.length, 1);
    assert.equal(deviceTelemetryStore.getSnapshot('AGV-01', 'agv', 'default')?.fields.distance_x, 7.7);
    assert.equal(disposed.length, 0);
  } finally {
    runtime.disposeAll();
    deviceTelemetryStore.clear();
  }
});

test('后续消息不带 s 也能按 assetCode 反查保活，防止超时销毁', () => {
  const { host, spawned, disposed } = createHost();
  const runtime = new DeviceSpawnerRuntime(host);
  runtime.configure([SPAWNER]);
  try {
    sendMessage('AGV-01', [{ p: 'normal', v: true }]);
    assert.equal(spawned.length, 1);

    runtime.applyFrame(Date.now() + 29_000);
    assert.equal(disposed.length, 0, '超时前不应销毁');
    sendMessage('AGV-01', [{ p: 'distance_x', v: 1 }], { withSpawner: false });
    runtime.applyFrame(Date.now() + 29_000);
    assert.equal(disposed.length, 0, '不带 s 的保活消息必须刷新实例心跳');

    runtime.applyFrame(Date.now() + 31_000);
    assert.equal(disposed.length, 1, '保活中断后仍应超时销毁');
  } finally {
    runtime.disposeAll();
    deviceTelemetryStore.clear();
  }
});

test('显式下线（可不带 s）销毁实例；下线后不带 s 不重生，带 s 重生', () => {
  const { host, spawned, disposed } = createHost();
  const runtime = new DeviceSpawnerRuntime(host);
  runtime.configure([SPAWNER]);
  try {
    sendMessage('AGV-01', [{ p: 'normal', v: true }]);
    sendMessage('AGV-01', [{ p: 'status', v: 'offline' }], { withSpawner: false });
    assert.deepEqual(disposed, [createSpawnedDeviceKey('AGV-SPAWN', 'AGV-01')]);

    sendMessage('AGV-01', [{ p: 'normal', v: true }], { withSpawner: false });
    assert.equal(spawned.length, 1, '下线后不带 s 的消息不得重生实例');

    sendMessage('AGV-01', [{ p: 'normal', v: true }], { withSpawner: true });
    assert.equal(spawned.length, 2, '重新上线首条消息携带 s 应重新生成实例');
  } finally {
    runtime.disposeAll();
    deviceTelemetryStore.clear();
  }
});

test('未知资产编号的下线消息被忽略，不触发生成', () => {
  const { host, spawned } = createHost();
  const runtime = new DeviceSpawnerRuntime(host);
  runtime.configure([SPAWNER]);
  try {
    sendMessage('AGV-09', [{ p: 'status', v: 'offline' }]);
    assert.equal(spawned.length, 0);
  } finally {
    runtime.disposeAll();
    deviceTelemetryStore.clear();
  }
});

test('既有设备（静态或其他产生器实例）占用编号时不再生成', () => {
  const { host, spawned, knownDevices } = createHost();
  knownDevices.add('default:agv:AGV-01');
  const runtime = new DeviceSpawnerRuntime(host);
  runtime.configure([SPAWNER]);
  try {
    sendMessage('AGV-01', [{ p: 'distance_x', v: 4.2 }]);
    assert.equal(spawned.length, 0, 'isDeviceKnown 命中时消息直达既有设备，不生成动态实例');
    // 快照仍入仓库，供既有设备驱动消费
    assert.equal(deviceTelemetryStore.getSnapshot('AGV-01', 'agv', 'default')?.fields.distance_x, 4.2);
  } finally {
    runtime.disposeAll();
    deviceTelemetryStore.clear();
  }
});

test('产生器按 (spawnerCode, deviceType) 复合严格匹配：deviceType 不一致不生成', () => {
  const { host, logs, spawned } = createHost();
  const runtime = new DeviceSpawnerRuntime(host);
  runtime.configure([SPAWNER]);
  try {
    sendMessage('AGV-01', [{ p: 'normal', v: true }], { deviceType: 'shuttle' });
    assert.equal(spawned.length, 0, 'deviceType 不匹配不得生成');
    assert.equal(logs.filter((line) => line.includes('未匹配')).length, 1, '同一组合只告警一次');

    sendMessage('AGV-01', [{ p: 'normal', v: true }], { deviceType: 'shuttle' });
    assert.equal(logs.filter((line) => line.includes('未匹配')).length, 1);

    sendMessage('AGV-01', [{ p: 'normal', v: true }]);
    assert.equal(spawned.length, 1, 'deviceType 匹配后正常生成');
  } finally {
    runtime.disposeAll();
    deviceTelemetryStore.clear();
  }
});

test('超时无消息的实例在 applyFrame 帧尾统一销毁', () => {
  const { host, spawned, disposed } = createHost();
  const runtime = new DeviceSpawnerRuntime(host);
  runtime.configure([SPAWNER]);
  try {
    sendMessage('AGV-01', [{ p: 'normal', v: true }]);
    sendMessage('AGV-02', [{ p: 'normal', v: true }]);
    assert.equal(spawned.length, 2);

    const now = Date.now();
    runtime.applyFrame(now + 10_000);
    assert.equal(disposed.length, 0, '超时前不应销毁');

    runtime.applyFrame(now + 31_000);
    assert.equal(disposed.length, 2, '两台实例都应超时销毁');
  } finally {
    runtime.disposeAll();
    deviceTelemetryStore.clear();
  }
});

test('模板未就绪时 spawn 失败不登记实例，下一条消息重试', () => {
  const { host, spawned, setSpawnResult } = createHost();
  const runtime = new DeviceSpawnerRuntime(host);
  runtime.configure([SPAWNER]);
  try {
    setSpawnResult(false);
    sendMessage('AGV-01', [{ p: 'normal', v: true }]);
    assert.equal(spawned.length, 0);

    setSpawnResult(true);
    sendMessage('AGV-01', [{ p: 'normal', v: true }]);
    assert.equal(spawned.length, 1, '模板就绪后重试应生成实例');
  } finally {
    runtime.disposeAll();
    deviceTelemetryStore.clear();
  }
});

test('未注册的产生器 id 只记录一次日志，disposeAll 销毁全部实例并退订消息', () => {
  const { host, logs, spawned, disposed } = createHost();
  const runtime = new DeviceSpawnerRuntime(host);
  runtime.configure([SPAWNER]);
  try {
    sendMessage('AGV-09', [{ p: 'normal', v: true }], { withSpawner: true });
    // 覆盖 s=AGV-SPAWN 的默认值，换成未注册的产生器 id
    ingestDeviceTelemetryMessage(
      topicFor('AGV-09'),
      JSON.stringify({ data: [{ p: 'normal', v: true, s: 'UNKNOWN' }], ts: new Date().toISOString() }),
      { store: deviceTelemetryStore },
    );
    ingestDeviceTelemetryMessage(
      topicFor('AGV-09'),
      JSON.stringify({ data: [{ p: 'normal', v: true, s: 'UNKNOWN' }], ts: new Date().toISOString() }),
      { store: deviceTelemetryStore },
    );
    assert.equal(spawned.length, 1, 'AGV-09 首条已用已注册产生器生成');
    assert.equal(logs.filter((line) => line.includes('未匹配')).length, 0, '已生成实例的消息直接保活，不触发未匹配告警');

    sendMessage('AGV-10', [{ p: 'normal', v: true, s: 'UNKNOWN' }], { withSpawner: false });
    sendMessage('AGV-10', [{ p: 'normal', v: true, s: 'UNKNOWN' }], { withSpawner: false });
    assert.equal(logs.filter((line) => line.includes('未匹配')).length, 1, '同一未知产生器只告警一次');

    sendMessage('AGV-02', [{ p: 'normal', v: true }]);
    assert.equal(spawned.length, 2);
  } finally {
    runtime.disposeAll();
  }
  assert.equal(disposed.length, 2, 'disposeAll 应销毁全部存活实例');

  // 退订后消息不再触发任何行为
  sendMessage('AGV-03', [{ p: 'normal', v: true }]);
  assert.equal(spawned.length, 2);
  deviceTelemetryStore.clear();
});
