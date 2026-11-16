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

function makeSnapshot(
  fields: Record<string, unknown>,
  receivedAt: number = Date.now(),
  faulted = false,
  sourceTimestamp: number | null = null,
): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'conveyor',
    assetCode: 'CV1',
    payloadDeviceCode: null,
    sourceTimestamp,
    sequence: null,
    receivedAt,
    fields,
    currentLocationKey: null,
    targetLocationKey: null,
    hasTargetLocation: false,
    faulted,
    message: '',
  };
}

function makeHarness(binding: { cargoAutoDispose?: boolean; cargoOriginDevice?: boolean; cargoInitialSync?: boolean; cargoTravelSpeed?: number } | null) {
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
    telemetryBinding: { cargoOriginDevice: true, cargoInitialSync: false, ...(binding ?? {}) },
    externalScriptRuntime: null,
  } as unknown as ModelRuntimeEntry;

  const host = {
    pushLog: () => undefined,
    collectModels: () => [{ entityId: 'e1', model }],
    findLocatorByDevice: () => null,
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
    scene,
    dispose: () => { scene.dispose(); engine.dispose(); },
    apply: (
      fields: Record<string, unknown>,
      deltaSeconds = 0.1,
      frames = 1,
      receivedAt?: number,
      faulted = false,
      sourceTimestamp: number | null = null,
    ) => {
      for (let i = 0; i < frames; i += 1) {
        driver.applyToModel(model, makeSnapshot(fields, receivedAt, faulted, sourceTimestamp), deltaSeconds);
      }
    },
  };
}

const RUNNING = { task: 1, front_has_goods: 1, back_has_goods: 0, movement_x: 1 };
const STOPPED_EMPTY = { task: 1, front_has_goods: 0, back_has_goods: 0, movement_x: 0 };
const DISPOSE_FRAME = { task: 1, front_has_goods: 0, back_has_goods: 0, movement_x: 0, mode: 2 };

test('telemetryBinding 归一化保留 cargoAutoDispose/cargoOriginDevice/cargoInitialSync 显式布尔值', () => {
  const base = { enabled: true, sourceId: 'default', deviceType: 'conveyor' };
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoAutoDispose: false })?.cargoAutoDispose, false);
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoAutoDispose: true })?.cargoAutoDispose, true);
  assert.equal(normalizeTelemetryBindingComponent(base)?.cargoAutoDispose, undefined);
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoOriginDevice: true })?.cargoOriginDevice, true);
  assert.equal(normalizeTelemetryBindingComponent(base)?.cargoOriginDevice, undefined);
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoInitialSync: true })?.cargoInitialSync, true);
  assert.equal(normalizeTelemetryBindingComponent(base)?.cargoInitialSync, undefined);
});

test('telemetryBinding 归一化保留正的 cargoTravelSpeed，非法值丢弃并封顶 100', () => {
  const base = { enabled: true, sourceId: 'default', deviceType: 'conveyor' };
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoTravelSpeed: 1.25 })?.cargoTravelSpeed, 1.25);
  assert.equal(normalizeTelemetryBindingComponent(base)?.cargoTravelSpeed, undefined);
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoTravelSpeed: 0 })?.cargoTravelSpeed, undefined);
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoTravelSpeed: -1 })?.cargoTravelSpeed, undefined);
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoTravelSpeed: Number.NaN })?.cargoTravelSpeed, undefined);
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoTravelSpeed: 500 })?.cargoTravelSpeed, 100);
});

test('货物输送速度实例覆盖：cargoTravelSpeed 优先于模型脚本默认速度', () => {
  const h = makeHarness({ cargoTravelSpeed: 1.2 });
  try {
    h.apply(RUNNING);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '前置：货物必须已刷出');
    const offset = h.model.conveyorTelemetry.cargoTravelOffset;
    h.apply(RUNNING);
    const delta = h.model.conveyorTelemetry.cargoTravelOffset - offset;
    assert.ok(Math.abs(delta - 1.2 * 0.1) < 1e-6, `货物应按覆盖速度 1.2 m/s 走行，实际单帧位移 ${delta}`);
  } finally {
    h.dispose();
  }
});

test('非起点设备探测点无上游时不刷出，仅进入等待', () => {
  const h = makeHarness({ cargoOriginDevice: false });
  try {
    h.apply(RUNNING);
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '非起点设备无邻居不得自行创建货箱');
    assert.equal(h.model.conveyorTelemetry.waitingTask, '1', '必须进入等待');
    assert.equal(h.model.conveyorTelemetry.upstreamLinks.size, 0, '无邻居不得有上位链路登记');
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
    assert.equal(anonymous.state.conveyorCargoMeshes.size, 0, '匿名模式已移除：无 task 字段不得刷出');
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

    // 新消息 movement_x=0：自驱不被打断，连贯推进（自驱只被 movement_x 非 0 的字段接管）
    h.apply({ ...STOPPED_EMPTY, task: 2 }, 0.1, 1, 4000);
    assert.equal(h.model.conveyorTelemetry.selfDriveDirection, 1, 'movement_x=0 的新消息不得结束自驱');
    const continuedOffset = h.model.conveyorTelemetry.cargoTravelOffset;
    assert.ok(
      Math.abs(continuedOffset - (offsetAfterReuse + 0.3 * 0.1)) < 1e-6,
      `movement_x=0 的新消息下自驱必须继续推进到 ${offsetAfterReuse + 0.03}，实际 ${continuedOffset}`,
    );

    // 线体运行（movement_x=1）：字段显式接管，自驱清零，货物继续走行
    h.apply({ ...RUNNING, task: 2 }, 0.1, 1, 5000);
    assert.equal(h.model.conveyorTelemetry.selfDriveDirection, 0, 'movement_x 非 0 的新消息必须接管字段驱动');
    assert.ok(
      h.model.conveyorTelemetry.cargoTravelOffset > continuedOffset,
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
    assert.equal(h.model.conveyorTelemetry.upstreamLinks.size, 0, '单机无邻居不得有上位链路');
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

    // 新消息到达 movement_x=0：自驱不被打断，继续连贯推进
    h.apply({ task: 5, front_has_goods: 0, back_has_goods: 0, movement_x: 0 }, 0.1, 1, 2000);
    assert.equal(h.model.conveyorTelemetry.selfDriveDirection, 1, 'movement_x=0 的新消息不得结束自驱');
    assert.ok(
      Math.abs(h.model.conveyorTelemetry.cargoTravelOffset - (selfDrivenOffset + 0.3 * 0.1)) < 1e-6,
      `自驱必须在新消息 movement_x=0 时继续推进到 ${selfDrivenOffset + 0.03}，实际 ${h.model.conveyorTelemetry.cargoTravelOffset}`,
    );
  } finally {
    h.dispose();
  }
});

const INITIAL_FRONT = { task: 7, front_has_goods: 1, back_has_goods: 0, movement_x: 0 };
const INITIAL_BACK = { task: 7, front_has_goods: 0, back_has_goods: 1, movement_x: 0 };
const INITIAL_BOTH = { task: 7, front_has_goods: 1, back_has_goods: 1, movement_x: 0 };

test('显式取消启动光电同步：光电有货且带 task 的首次加载仍只进入等待', () => {
  const h = makeHarness({ cargoOriginDevice: false, cargoInitialSync: false });
  try {
    for (const receivedAt of [1000, 2000, 3000]) h.apply(INITIAL_FRONT, 0.1, 1, receivedAt);
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '显式取消后不得建箱');
    assert.equal(h.model.conveyorTelemetry.waitingTask, '7', '原有等待上游语义必须保持');
  } finally {
    h.dispose();
  }
});

test('历史场景未写 cargoInitialSync 时默认开启：停线首帧补建', () => {
  const h = makeHarness({ cargoOriginDevice: false, cargoInitialSync: undefined });
  try {
    h.apply(INITIAL_FRONT, 0.1, 1, 1000);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '缺省未写字段必须按默认开启处理');
    assert.equal(h.model.conveyorTelemetry.cargoCode, 'cargo');
  } finally {
    h.dispose();
  }
});

test('启动光电同步：前端光电连续有货时在负端物化滞留货，线体未走行不自动拉走', () => {
  const h = makeHarness({ cargoOriginDevice: false, cargoInitialSync: true });
  try {
    for (const receivedAt of [1000, 2000, 3000]) h.apply(INITIAL_FRONT, 0.1, 1, receivedAt);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '连续确认后必须补建一个货箱');
    const cargo = [...h.state.conveyorCargoMeshes.values()][0];
    assert.equal(cargo.task, '7');
    assert.equal(h.model.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.model.conveyorTelemetry.selfDriveDirection, 0, '首载物化不得登记自驱');
    assert.equal(h.model.conveyorTelemetry.initialSensorHold, true);
    assert.equal(h.model.conveyorTelemetry.initialSyncDone, true);
    assert.ok(
      Math.abs(h.model.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE)) < 1e-6,
      `前端有货应落在负端 ${-HALF_RANGE}，实际 ${h.model.conveyorTelemetry.cargoTravelOffset}`,
    );

    // 同 task 后续帧不得重复建箱，也不得被帧级交付拉走。
    for (const receivedAt of [4000, 5000]) h.apply(INITIAL_FRONT, 0.1, 1, receivedAt);
    assert.equal(h.state.conveyorCargoMeshes.size, 1);
    assert.ok(Math.abs(h.model.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE)) < 1e-6);

    // 线体真正走行后才解除滞留门控。
    h.apply({ ...INITIAL_FRONT, movement_x: 1 }, 0.1, 1, 6000);
    assert.equal(h.model.conveyorTelemetry.initialSensorHold, false);
    assert.ok(h.model.conveyorTelemetry.cargoTravelOffset > -HALF_RANGE, '线体走行后货箱必须开始移动');
  } finally {
    h.dispose();
  }
});

test('启动光电同步：后端光电落在正端，双端都有货落在中心', () => {
  const back = makeHarness({ cargoOriginDevice: false, cargoInitialSync: true });
  try {
    for (const receivedAt of [1000, 2000, 3000]) back.apply(INITIAL_BACK, 0.1, 1, receivedAt);
    assert.equal(back.state.conveyorCargoMeshes.size, 1);
    assert.ok(
      Math.abs(back.model.conveyorTelemetry.cargoTravelOffset - HALF_RANGE) < 1e-6,
      `后端有货应落在正端 ${HALF_RANGE}，实际 ${back.model.conveyorTelemetry.cargoTravelOffset}`,
    );
  } finally {
    back.dispose();
  }

  const both = makeHarness({ cargoOriginDevice: false, cargoInitialSync: true });
  try {
    for (const receivedAt of [1000, 2000, 3000]) both.apply(INITIAL_BOTH, 0.1, 1, receivedAt);
    assert.equal(both.state.conveyorCargoMeshes.size, 1);
    assert.ok(
      Math.abs(both.model.conveyorTelemetry.cargoTravelOffset) < 1e-6,
      `双端都有货应落在中心，实际 ${both.model.conveyorTelemetry.cargoTravelOffset}`,
    );
  } finally {
    both.dispose();
  }
});

test('启动光电同步：无 task 不建箱，光电抖动后重新计数仍可在窗口内补建', () => {
  const noTask = makeHarness({ cargoOriginDevice: false, cargoInitialSync: true });
  try {
    for (const receivedAt of [1000, 2000, 3000]) {
      noTask.apply({ front_has_goods: 1, back_has_goods: 0, movement_x: 0 }, 0.1, 1, receivedAt);
    }
    assert.equal(noTask.state.conveyorCargoMeshes.size, 0, '无 task 不得凭光电建箱');
    assert.equal(noTask.model.conveyorTelemetry.initialSyncDone, false, '无 task 时仍应保留窗口等待后续报文');
  } finally {
    noTask.dispose();
  }

  const flapping = makeHarness({ cargoOriginDevice: false, cargoInitialSync: true });
  try {
    for (const receivedAt of [1000, 2000, 3000]) {
      flapping.apply({ task: 7, front_has_goods: 0, back_has_goods: 0, movement_x: 0 }, 0.1, 1, receivedAt);
    }
    assert.equal(flapping.state.conveyorCargoMeshes.size, 0);
    for (const receivedAt of [4000, 5000, 6000]) flapping.apply(INITIAL_FRONT, 0.1, 1, receivedAt);
    assert.equal(flapping.state.conveyorCargoMeshes.size, 1, '窗口内光电恢复后必须补建');
  } finally {
    flapping.dispose();
  }
});

test('启动光电同步：故障帧不计样本，恢复健康后仍可补建', () => {
  const h = makeHarness({ cargoOriginDevice: false, cargoInitialSync: true });
  try {
    for (const receivedAt of [1000, 2000, 3000]) h.apply(INITIAL_FRONT, 0.1, 1, receivedAt, true);
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '故障帧不得建箱');
    for (const receivedAt of [4000, 5000, 6000]) h.apply(INITIAL_FRONT, 0.1, 1, receivedAt);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '故障恢复后必须继续首载同步');
  } finally {
    h.dispose();
  }
});

test('启动光电同步：同 task 已被其他设备持有时不重复建箱', () => {
  const h = makeHarness({ cargoOriginDevice: false, cargoInitialSync: true });
  try {
    const otherRoot = new TransformNode('other_cargo_root', h.scene);
    h.state.conveyorCargoMeshes.set(JSON.stringify(['OTHER', 'cargo']), {
      assetCode: 'OTHER',
      containerCode: '',
      task: '7',
      root: otherRoot,
      outputOwner: null,
      fallback: null,
      generatorEntityId: null,
      handoff: null,
      axialLengthCache: null,
      lockedWorldRotation: null,
    } as never);
    for (const receivedAt of [1000, 2000, 3000]) h.apply(INITIAL_FRONT, 0.1, 1, receivedAt);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '同 task 只能保留一个货物实例');
    assert.equal(h.model.conveyorTelemetry.cargoCode, null, '本机不得再建第二个同 task 货箱');
    assert.equal(h.model.conveyorTelemetry.initialSyncDone, true);
  } finally {
    h.dispose();
  }
});

test('启动光电同步：停线首条有货快照立即物化，运行中仍需连续确认', () => {
  const stopped = makeHarness({ cargoOriginDevice: false, cargoInitialSync: true });
  try {
    stopped.apply(INITIAL_FRONT, 0.1, 1, 1000);
    assert.equal(stopped.state.conveyorCargoMeshes.size, 1, '停线存量为稳定状态，首条快照即可建箱');
  } finally {
    stopped.dispose();
  }

  const running = makeHarness({ cargoOriginDevice: false, cargoInitialSync: true });
  try {
    running.apply({ ...INITIAL_FRONT, movement_x: 1 }, 0.1, 1, 1000);
    assert.equal(running.state.conveyorCargoMeshes.size, 0, '运行中的单条光电脉冲不得立即建箱');
    running.apply({ ...INITIAL_FRONT, movement_x: 1 }, 0.1, 1, 2000);
    running.apply({ ...INITIAL_FRONT, movement_x: 1 }, 0.1, 1, 3000);
    assert.equal(running.state.conveyorCargoMeshes.size, 1, '运行中连续 3 条确认后建箱');
  } finally {
    running.dispose();
  }
});

test('启动光电同步：快放回放 receivedAt 相同但 sourceTimestamp 递增时仍逐条计数', () => {
  const h = makeHarness({ cargoOriginDevice: false, cargoInitialSync: true });
  try {
    for (const sourceTimestamp of [100, 200, 300]) h.apply(INITIAL_FRONT, 0.1, 1, 1000, false, sourceTimestamp);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '三条不同来源时间的报文必须能完成首载确认');
  } finally {
    h.dispose();
  }
});
