import assert from 'node:assert/strict';
import test from 'node:test';

import { NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import { normalizeTelemetryBindingComponent } from '../../src/editor/model/telemetryBinding';
import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { ConveyorTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/conveyorDriver';
import { createConveyorTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { createSpecializedTelemetrySharedState } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

function makeSnapshot(fields: Record<string, unknown>): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'conveyor',
    assetCode: 'CV1',
    payloadDeviceCode: null,
    sourceTimestamp: null,
    sequence: null,
    receivedAt: Date.now(),
    fields,
    currentLocationKey: null,
    targetLocationKey: null,
    hasTargetLocation: false,
    faulted: false,
    message: '',
  };
}

function makeHarness(binding: { cargoAutoDispose?: boolean } | null) {
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
    telemetryBinding: binding,
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
  };
  const driver = new ConveyorTelemetryDriver(context as never);
  return {
    driver,
    state,
    model,
    dispose: () => { scene.dispose(); engine.dispose(); },
    apply: (fields: Record<string, unknown>, deltaSeconds = 0.1) => {
      driver.applyToModel(model, makeSnapshot(fields), deltaSeconds);
    },
  };
}

const RUNNING = { task: 1, front_has_goods: 1, back_has_goods: 0, movement_x: 1 };
const STOPPED_EMPTY = { task: 1, front_has_goods: 0, back_has_goods: 0, movement_x: 0 };
const DISPOSE_FRAME = { task: 1, front_has_goods: 0, back_has_goods: 0, movement_x: 0, mode: 2 };

test('telemetryBinding 归一化保留 cargoAutoDispose 显式布尔值', () => {
  const base = { enabled: true, sourceId: 'default', deviceType: 'conveyor' };
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoAutoDispose: false })?.cargoAutoDispose, false);
  assert.equal(normalizeTelemetryBindingComponent({ ...base, cargoAutoDispose: true })?.cargoAutoDispose, true);
  assert.equal(normalizeTelemetryBindingComponent(base)?.cargoAutoDispose, undefined);
});

test('默认开启自动销毁：mode=2 且双光电无货时清空货物', () => {
  const h = makeHarness(null);
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
  const h = makeHarness(null);
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
  const h = makeHarness(null);
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

test('关闭自动销毁：mode=2 且光电无货时货物保持，等待下游凭 task 接管', () => {
  const h = makeHarness({ cargoAutoDispose: false });
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
