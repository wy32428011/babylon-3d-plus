import assert from 'node:assert/strict';
import test from 'node:test';

import { NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import { normalizeTelemetryBindingComponent } from '../../src/editor/model/telemetryBinding';
import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { ConveyorTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/conveyorDriver';
import { createConveyorTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import {
  CONVEYOR_CARGO_SIZE,
  createSpecializedTelemetrySharedState,
} from '../../src/runtime/babylon/telemetry/specialized/types';
import { resolveConveyorCargoTravelHalfRange } from '../../src/runtime/babylon/telemetry/conveyorCargoTravel';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

/** harness bounds 跨度 4m、货箱轴向 0.72 → 行程半径 1.64，刷出端偏移 = -1.64。 */
const HALF_RANGE = resolveConveyorCargoTravelHalfRange(4, CONVEYOR_CARGO_SIZE.x);

function makeSnapshot(fields: Record<string, unknown>, receivedAt: number = Date.now()): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'conveyor',
    assetCode: 'CV1',
    payloadDeviceCode: null,
    sourceTimestamp: null,
    sequence: null,
    receivedAt,
    fields,
    currentLocationKey: null,
    targetLocationKey: null,
    hasTargetLocation: false,
    faulted: false,
    message: '',
  };
}

function makeHarness(binding: { cargoAutoDispose?: boolean; cargoOriginDevice?: boolean } | null) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const root = new TransformNode('cv1_root', scene);
  const model = {
    assetCode: 'CV1',
    root,
    contentRoot: root,
    meshes: [],
    conveyorTelemetry: createConveyorTelemetryState(),
    // 单机无邻居场景：探测点触及不到任何设备，必须勾选起点设备才允许自行创建货箱
    telemetryBinding: { cargoOriginDevice: true, ...(binding ?? {}) },
    externalScriptRuntime: null,
  } as unknown as ModelRuntimeEntry;

  const host = {
    pushLog: () => undefined,
    collectModels: () => [{ entityId: 'e1', model }],
    findLocatorByDevice: () => null,
    getLocatorTarget: () => null,
    resolveCargoGeneratorForModel: () => null,
    resolveColumnTargetPose: () => null,
    resolveFetchDriveRowForLocator: () => null,
    suppressFetchCellForLocator: () => null,
    handleFetchRowSync: () => undefined,
    keepCargoForFetchRowSync: () => false,
    updateExternalScriptContext: () => true,
    refreshModelArrayRepresentation: () => undefined,
    getGeneratedCargoFallbackSpec: () => ({ size: Vector3.One(), color: '#fff', emissiveColor: '#000' }),
    ensureGeneratedCargoFallback: () => undefined,
    ensureGeneratedCargoOutputOwner: () => null,
    syncGeneratedCargoVisual: () => undefined,
    setGeneratedCargoRootPose: () => undefined,
    disposeGeneratedCargo: () => undefined,
    getModelWorldBounds: () => ({ minimum: new Vector3(-2, 0, -0.5), maximum: new Vector3(2, 1, 0.5) }),
  };
  const context = {
    scene,
    state,
    host,
    disposeStackerCargo: () => undefined,
    disposeConveyorCargo: () => undefined,
    getOrCreateStackerCargo: () => { throw new Error('not used'); },
    getOrCreateConveyorCargo: () => { throw new Error('driver 内部自建，不应走 context'); },
    adoptGlobalCargoByTask: () => null,
    detachClaimedCargoByReference: () => null,
  };
  const driver = new ConveyorTelemetryDriver(context as never);
  return {
    driver,
    state,
    model,
    dispose: () => { scene.dispose(); engine.dispose(); },
    apply: (fields: Record<string, unknown>, deltaSeconds = 0.1, frames = 1, receivedAt?: number) => {
      for (let i = 0; i < frames; i += 1) {
        driver.applyToModel(model, makeSnapshot(fields, receivedAt), deltaSeconds);
      }
    },
  };
}

const RUNNING = { task: 1, front_has_goods: 1, back_has_goods: 0, movement_x: 1 };
const STOPPED_EMPTY = { task: 1, front_has_goods: 0, back_has_goods: 0, movement_x: 0 };
const DISPOSE_FRAME = { task: 1, front_has_goods: 0, back_has_goods: 0, movement_x: 0, mode: 2 };

test('telemetryBinding 归一化保留 cargoAutoDispose/cargoOriginDevice 显式布尔值', () => {
  const base = { enabled: true, sourceId: 'default', deviceType: 'conveyor' };
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoAutoDispose: false })?.cargoAutoDispose, false);
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoAutoDispose: true })?.cargoAutoDispose, true);
  assert.equal(normalizeTelemetryBindingComponent(base)?.cargoAutoDispose, undefined);
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoOriginDevice: true })?.cargoOriginDevice, true);
  assert.equal(normalizeTelemetryBindingComponent(base)?.cargoOriginDevice, undefined);
});

test('非起点设备探测点无上游时不刷出，仅进入等待', () => {
  const h = makeHarness({ cargoOriginDevice: false });
  try {
    h.apply(RUNNING);
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '非起点设备无邻居不得自行创建货箱');
    assert.equal(h.model.conveyorTelemetry.waitingTask, '1', '必须进入等待');
    assert.equal(h.model.conveyorTelemetry.probeSubscription, null, '无订阅对象不得登记');
  } finally {
    h.dispose();
  }
});

test('勾选自动销毁：mode=2 且双光电无货时清空货物', () => {
  const h = makeHarness({ cargoAutoDispose: true });
  try {
    h.apply(RUNNING);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '线体运行后必须刷出货物');

    h.apply(STOPPED_EMPTY);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '仅停线（无 mode=2）不得销毁货物');

    h.apply({ ...DISPOSE_FRAME, front_has_goods: 1 });
    assert.equal(h.state.conveyorCargoMeshes.size, 1, 'mode=2 但光电有货时不得销毁货物');

    h.apply(DISPOSE_FRAME);
    h.apply(DISPOSE_FRAME);
    assert.equal(h.state.conveyorCargoMeshes.size, 0, 'mode=2 且双光电无货后货物必须被销毁');
    assert.equal(h.model.conveyorTelemetry.cargoCode, null);
  } finally {
    h.dispose();
  }
});

test('movement_x 非 0 即刷出，不依赖光电信号；刷出位置只由转向决定', () => {
  const h = makeHarness({ cargoAutoDispose: true });
  try {
    h.apply({ task: 5, front_has_goods: 0, back_has_goods: 0, movement_x: 1 });
    assert.equal(h.state.conveyorCargoMeshes.size, 1, 'task 模式：光电无货但 movement_x 非 0 必须刷出');
    const forwardSpawnOffset = h.model.conveyorTelemetry.cargoTravelOffset;

    h.apply({ task: 5, front_has_goods: 0, back_has_goods: 0, movement_x: 0, mode: 2 });
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '前置：货物已被自动销毁');

    h.apply({ task: 6, front_has_goods: 0, back_has_goods: 0, movement_x: 2 });
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '反转同样必须刷出');
    assert.ok(
      Math.sign(h.model.conveyorTelemetry.cargoTravelOffset) === -Math.sign(forwardSpawnOffset),
      '反转刷出位置必须与正转刷出位置相反',
    );
  } finally {
    h.dispose();
  }

  const anonymous = makeHarness(null);
  try {
    anonymous.apply({ front_has_goods: 0, back_has_goods: 0, movement_x: 1 });
    assert.equal(anonymous.state.conveyorCargoMeshes.size, 1, '匿名模式：光电无货但 movement_x 非 0 必须刷出');
  } finally {
    anonymous.dispose();
  }
});

test('同 task 重发不得重走刷出+走行，只有新 task 才刷出', () => {
  const h = makeHarness({ cargoAutoDispose: true });
  try {
    h.apply(RUNNING);
    assert.equal(h.state.conveyorCargoMeshes.size, 1);
    h.apply(DISPOSE_FRAME);
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '前置：货物已被自动销毁');

    // 同一 task 重发完整刷出帧：不得重新刷出。
    h.apply(RUNNING);
    h.apply(RUNNING);
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '同 task 重发不得重新刷出');

    // 新 task 边沿：正常刷出并走行。
    h.apply({ ...RUNNING, task: 2 });
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '新 task 必须正常刷出');
    const offsetAfterSpawn = h.model.conveyorTelemetry.cargoTravelOffset;
    h.apply({ ...RUNNING, task: 2 });
    assert.ok(
      Math.abs(h.model.conveyorTelemetry.cargoTravelOffset - offsetAfterSpawn) > 1e-9,
      '新 task 货物必须随线体运行走行',
    );
  } finally {
    h.dispose();
  }
});

test('缺省不勾选自动销毁：mode=2 且光电无货时货物保持，等待下游接管', () => {
  const h = makeHarness(null);
  try {
    h.apply(RUNNING);
    assert.equal(h.state.conveyorCargoMeshes.size, 1);

    h.apply(DISPOSE_FRAME);
    h.apply(DISPOSE_FRAME);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '关闭自动销毁后 mode=2 不得清空货物');
    assert.notEqual(h.model.conveyorTelemetry.cargoCode, null);

    // 同 task 重发完整刷出帧：不得重复刷出或重置回刷出端（线体运行中货物继续走行为正常）。
    const offset = h.model.conveyorTelemetry.cargoTravelOffset;
    h.apply(RUNNING);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '同 task 重发不得生成第二份货物');
    assert.ok(
      h.model.conveyorTelemetry.cargoTravelOffset > offset,
      '同 task 重发不得把货物重置回刷出端',
    );

    // 下游凭同 task 接管：货物条目移交，本机引用清空。
    const key = h.driver.getConveyorCargoKey('CV1', h.model.conveyorTelemetry.cargoCode!);
    const claimed = h.driver.detachClaimedCargoByKey(key);
    assert.ok(claimed, '下游必须能凭 key 取走货物实例');
    assert.equal(h.model.conveyorTelemetry.cargoCode, null);
    assert.equal(h.state.conveyorCargoMeshes.size, 0);

    // 接管后同 task 重发仍不得重刷。
    h.apply(RUNNING);
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '接管后同 task 重发不得重新刷出');
  } finally {
    h.dispose();
  }
});

test('缺省不勾选自动销毁：新 task 边沿即复用遗留箱，盖上新 task 从滞留位置继续走行', () => {
  const h = makeHarness(null);
  try {
    h.apply(RUNNING, 0.1, 1, 1000);
    for (let i = 0; i < 10; i += 1) h.apply(RUNNING, 0.1, 1, 1000);
    const leftover = [...h.state.conveyorCargoMeshes.values()][0];
    const leftoverRoot = leftover.root;
    assert.equal(leftover.task, '1');

    // mode=2 停线遗留：货物与引用保持
    h.apply(DISPOSE_FRAME, 0.1, 1, 2000);
    assert.equal(h.state.conveyorCargoMeshes.size, 1);
    const strandedOffset = h.model.conveyorTelemetry.cargoTravelOffset;

    // 新 task 边沿即复用（不再等线体运行）：不销毁不重建，movement_x=0 按正转登记自驱，当帧推进一帧
    h.apply({ ...STOPPED_EMPTY, task: 2, containerCode: 'C-2' }, 0.1, 1, 3000);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '不得生成第二份货物');
    const reused = [...h.state.conveyorCargoMeshes.values()][0];
    assert.equal(reused.root, leftoverRoot, '必须复用遗留箱实例，不得销毁重建');
    assert.equal(reused.task, '2', '复用箱必须盖上新 task');
    assert.equal(reused.containerCode, 'C-2');
    assert.equal(h.model.conveyorTelemetry.selfDriveDirection, 1, 'movement_x=0 刷出必须登记正转自驱');
    const offsetAfterReuse = h.model.conveyorTelemetry.cargoTravelOffset;
    assert.ok(
      Math.abs(offsetAfterReuse - (strandedOffset + 0.3 * 0.1)) < 1e-6,
      `复用必须从滞留位置继续走行，期望 ${strandedOffset + 0.03}，实际 ${offsetAfterReuse}`,
    );

    // 下一条新消息 movement_x=0：自驱结束，立即停车
    h.apply({ ...STOPPED_EMPTY, task: 2 }, 0.1, 1, 4000);
    assert.equal(h.model.conveyorTelemetry.selfDriveDirection, 0, '新消息必须结束自驱');
    assert.equal(h.model.conveyorTelemetry.cargoTravelOffset, offsetAfterReuse, '新消息 movement_x=0 必须停车');

    // 线体运行后从滞留位置继续走行
    h.apply({ ...RUNNING, task: 2 }, 0.1, 1, 5000);
    assert.ok(
      h.model.conveyorTelemetry.cargoTravelOffset > offsetAfterReuse,
      '复用后货物必须随线体继续走行',
    );
  } finally {
    h.dispose();
  }
});

test('新 task 边沿复用在机旧箱：与 autoDispose 无关，同一实例盖新 task 从滞留位置继续走行', () => {
  const h = makeHarness(null);
  try {
    h.apply(RUNNING, 0.1);
    for (let i = 0; i < 5; i += 1) h.apply(RUNNING, 0.1);
    const oldRoot = [...h.state.conveyorCargoMeshes.values()][0].root;
    const strandedOffset = h.model.conveyorTelemetry.cargoTravelOffset;

    // 旧箱仍在机上时收新 task（movement_x=0）：探测点协议下直接复用旧箱，不销毁不重建
    h.apply({ ...STOPPED_EMPTY, task: 2 });
    assert.equal(h.state.conveyorCargoMeshes.size, 1);
    const reused = [...h.state.conveyorCargoMeshes.values()][0];
    assert.equal(reused.root, oldRoot, '新 task 必须直接复用滞留箱实例');
    assert.equal(reused.task, '2');
    assert.equal(h.model.conveyorTelemetry.waitingTask, null, '持有滞留箱不得进入等待');
    assert.equal(h.model.conveyorTelemetry.probeSubscription, null, '持有滞留箱不得订阅上游');
    assert.equal(h.model.conveyorTelemetry.selfDriveDirection, 1, 'movement_x=0 复用必须登记正转自驱');
    assert.ok(
      Math.abs(h.model.conveyorTelemetry.cargoTravelOffset - (strandedOffset + 0.3 * 0.1)) < 1e-6,
      `复用必须从滞留位置继续走行，期望 ${strandedOffset + 0.03}，实际 ${h.model.conveyorTelemetry.cargoTravelOffset}`,
    );
  } finally {
    h.dispose();
  }
});

test('新 task 边沿即刷出：无旧箱时 movement_x=0 也立即刷在轨迹起点并自驱推进', () => {
  const h = makeHarness(null);
  try {
    // 首条消息 movement_x=0：立即刷出并按正转自驱（不再等 movement_x 非 0）
    h.apply({ task: 5, front_has_goods: 0, back_has_goods: 0, movement_x: 0 }, 0.1, 1, 1000);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, 'movement_x=0 的新 task 也必须立即刷出');
    assert.equal(h.model.conveyorTelemetry.selfDriveDirection, 1);
    const spawnedOffset = h.model.conveyorTelemetry.cargoTravelOffset;
    assert.ok(
      Math.abs(spawnedOffset - (-HALF_RANGE + 0.3 * 0.1)) < 1e-6,
      `刷出端 -1.64 + 当帧自驱 0.03，实际 ${spawnedOffset}`,
    );

    // 断流重放（同一 receivedAt）：自驱持续推进
    h.apply({ task: 5, front_has_goods: 0, back_has_goods: 0, movement_x: 0 }, 0.1, 10, 1000);
    const selfDrivenOffset = h.model.conveyorTelemetry.cargoTravelOffset;
    assert.ok(
      Math.abs(selfDrivenOffset - (spawnedOffset + 0.3 * 0.1 * 10)) < 1e-6,
      `自驱必须持续推进到 ${spawnedOffset + 0.3}，实际 ${selfDrivenOffset}`,
    );

    // 新消息到达 movement_x=0：自驱结束，立即停车
    h.apply({ task: 5, front_has_goods: 0, back_has_goods: 0, movement_x: 0 }, 0.1, 1, 2000);
    assert.equal(h.model.conveyorTelemetry.selfDriveDirection, 0, '新消息必须结束自驱');
    assert.equal(h.model.conveyorTelemetry.cargoTravelOffset, selfDrivenOffset, '新消息 movement_x=0 必须停车');
  } finally {
    h.dispose();
  }
});
