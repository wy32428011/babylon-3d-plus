import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSpawnedDeviceKey,
  DeviceSpawnerRuntime,
  type DeviceSpawnerConfig,
} from '../../src/runtime/babylon/telemetry/spawner/DeviceSpawnerRuntime';
import {
  deviceTelemetryStore,
  dispatchDeviceSpawnMessages,
} from '../../src/runtime/mqtt/deviceTelemetry';

const SPAWNER: DeviceSpawnerConfig = {
  entityId: 'entity-spawner-1',
  entityName: '设备产生器',
  spawnerCode: 'AGV-SPAWN',
  templateEntityId: 'entity-template-1',
  timeoutSeconds: 30,
  deviceType: 'agv',
};

const TOPIC = 'dt/factory/logistics/agv/AGV-SPAWN/dataspawn/joint';

function createHost() {
  const logs: string[] = [];
  const spawned: { spawnerCode: string; assetCode: string }[] = [];
  const disposed: string[] = [];
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
  };
  return {
    host,
    logs,
    spawned,
    disposed,
    setSpawnResult(value: boolean) {
      spawnResult = value;
    },
  };
}

function dispatchPoints(points: Record<string, unknown>[]): boolean {
  return dispatchDeviceSpawnMessages(TOPIC, JSON.stringify({ data: points, ts: new Date().toISOString() }));
}

test('产生器消息驱动生成实例并写入模板派生设备类型的快照', () => {
  const { host, spawned, disposed } = createHost();
  const runtime = new DeviceSpawnerRuntime(host);
  runtime.configure([SPAWNER]);
  try {
    assert.equal(dispatchPoints([{ e: 'AGV-01', p: 'distance_x', v: 4.2 }]), true);
    assert.deepEqual(spawned, [{ spawnerCode: 'AGV-SPAWN', assetCode: 'AGV-01' }]);

    const snapshot = deviceTelemetryStore.getSnapshot('AGV-01', 'agv', 'default');
    assert.ok(snapshot, '快照应写入遥测仓库供驱动消费');
    assert.equal(snapshot.fields.distance_x, 4.2);

    // 同一资产编号再次收到消息：不重复生成，只刷新快照
    dispatchPoints([{ e: 'AGV-01', p: 'distance_x', v: 7.7 }]);
    assert.equal(spawned.length, 1);
    assert.equal(deviceTelemetryStore.getSnapshot('AGV-01', 'agv', 'default')?.fields.distance_x, 7.7);
    assert.equal(disposed.length, 0);
  } finally {
    runtime.disposeAll();
    deviceTelemetryStore.clear();
  }
});

test('显式下线消息销毁实例，之后的普通消息重新生成', () => {
  const { host, spawned, disposed } = createHost();
  const runtime = new DeviceSpawnerRuntime(host);
  runtime.configure([SPAWNER]);
  try {
    dispatchPoints([{ e: 'AGV-01', p: 'normal', v: true }]);
    dispatchPoints([{ e: 'AGV-01', p: 'status', v: 'offline' }]);
    assert.deepEqual(disposed, [createSpawnedDeviceKey('AGV-SPAWN', 'AGV-01')]);

    dispatchPoints([{ e: 'AGV-01', p: 'normal', v: true }]);
    assert.equal(spawned.length, 2, '下线后收到新消息应重新生成实例');
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
    dispatchPoints([{ e: 'AGV-01', p: 'normal', v: true }]);
    dispatchPoints([{ e: 'AGV-02', p: 'normal', v: true }]);
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
    dispatchPoints([{ e: 'AGV-01', p: 'normal', v: true }]);
    assert.equal(spawned.length, 0);

    setSpawnResult(true);
    dispatchPoints([{ e: 'AGV-01', p: 'normal', v: true }]);
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
    dispatchDeviceSpawnMessages(
      'dt/factory/logistics/agv/UNKNOWN/dataspawn/joint',
      JSON.stringify({ data: [{ e: 'AGV-09', p: 'normal', v: true }] }),
    );
    dispatchDeviceSpawnMessages(
      'dt/factory/logistics/agv/UNKNOWN/dataspawn/joint',
      JSON.stringify({ data: [{ e: 'AGV-09', p: 'normal', v: true }] }),
    );
    assert.equal(spawned.length, 0);
    assert.equal(logs.filter((line) => line.includes('未匹配')).length, 1, '同一未知产生器只告警一次');

    dispatchPoints([{ e: 'AGV-01', p: 'normal', v: true }]);
    dispatchPoints([{ e: 'AGV-02', p: 'normal', v: true }]);
    assert.equal(spawned.length, 2);
  } finally {
    runtime.disposeAll();
  }
  assert.equal(disposed.length, 2, 'disposeAll 应销毁全部存活实例');

  // 退订后消息不再触发任何行为
  dispatchPoints([{ e: 'AGV-03', p: 'normal', v: true }]);
  assert.equal(spawned.length, 2);
  deviceTelemetryStore.clear();
});
