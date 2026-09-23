import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBuilder, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';
import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { RgvTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/rgvDriver';
import { createConveyorTelemetryState, createRgvTelemetryState, resetRgvTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { createSpecializedTelemetrySharedState } from '../../src/runtime/babylon/telemetry/specialized/types';
import { clearRgvMotionFrame, getRgvMotionFrame, publishRgvMotionFrame } from '../../src/runtime/babylon/telemetry/rgvMotionState';

function makeHarness(rotation = 0, mirror = false) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('rgv_root', scene);
  root.rotation.y = rotation;
  root.scaling.x = mirror ? -1 : 1;
  const addBox = (name: string, width: number, depth: number, z = 0) => {
    const mesh = MeshBuilder.CreateBox(name, { width, height: 0.2, depth }, scene);
    mesh.parent = root;
    mesh.position.set(0, 0.1, z);
    mesh.computeWorldMatrix(true);
    return mesh;
  };
  const track = addBox('track', 2, 30);
  const front = addBox('front', 2, 1, 1);
  const back = addBox('back', 2, 1, -1);
  const model = {
    assetCode: 'RGV1', root, contentRoot: root, meshes: [track, front, back],
    rgvTelemetry: createRgvTelemetryState(root),
    telemetryBinding: { columnBindings: { '1': ['right'], '2': ['left'], '3': ['right', 'left'] } },
    externalScriptRuntime: { getDataDrivenConfigs: () => [{ fixedNodes: ['track'], cargo: { frontNodes: ['front'], backNodes: ['back'] } }] },
  } as unknown as ModelRuntimeEntry;
  const state = createSpecializedTelemetrySharedState();
  const candidates = ['right', 'left'].map((id) => ({
    entityId: id,
    model: { assetCode: id, conveyorCapable: true, conveyorTelemetry: createConveyorTelemetryState(), rgvTelemetry: createRgvTelemetryState(root) } as unknown as ModelRuntimeEntry,
  }));
  const pose = (id: string) => ({
    position: Vector3.TransformCoordinates(new Vector3(id === 'right' ? 4 : -4, 0.2, id === 'right' ? 6 : -6), root.computeWorldMatrix(true)),
    rotation: Quaternion.Identity(),
  });
  let deliver = false;
  let driver: RgvTelemetryDriver;
  const context = {
    scene, state,
    host: {
      pushLog: () => undefined,
      collectModels: () => [{ entityId: 'rgv', model }, ...candidates],
      resolveColumnTargetPose: (id: string) => candidates.some((entry) => entry.entityId === id) ? pose(id) : null,
      resolveCargoGeneratorForModel: () => null,
      syncGeneratedCargoVisual: () => undefined,
      setGeneratedCargoRootPose: () => undefined,
      disposeGeneratedCargo: () => undefined,
    },
    resolveConveyorDeckCenterWorld: () => null,
    adoptGlobalCargoByTask: () => null,
    deliverRgvCargoToConveyorColumn: (_id: string, key: string) => deliver && !!driver.detachClaimedCargoByKey(key),
  };
  driver = new RgvTelemetryDriver(context as never);
  const apply = (fields: Record<string, unknown>, deltaSeconds = 0.1, faulted = false,
    identity: Partial<Pick<DeviceTelemetrySnapshot, 'sourceId' | 'deviceType' | 'assetCode'>> = {}) => {
    const snapshot = { sourceId: 'default', deviceType: 'rgv', assetCode: 'RGV1', fields, faulted, message: '', ...identity } as DeviceTelemetrySnapshot;
    driver.applyToModel(model, snapshot, deltaSeconds);
    return getRgvMotionFrame(model)!;
  };
  return { model, scene, state, candidates, apply, enableDelivery: () => { deliver = true; }, dispose: () => { scene.dispose(); engine.dispose(); } };
}

test('运动摘要按模型隔离、保留帧号、拒绝无效位移并可清空，基准替换不复用旧帧', () => {
  const h = makeHarness();
  try {
    assert.equal(getRgvMotionFrame(h.model), null);
    publishRgvMotionFrame(h.model, 42, 0.5, { travel: -2, front: 1, back: Number.NaN });
    assert.deepEqual(getRgvMotionFrame(h.model), { frameId: 42, travel: { direction: -1, speed: 4 }, front: { direction: 1, speed: 2 }, back: { direction: 0, speed: 0 } });
    publishRgvMotionFrame(h.model, 43, 0, { travel: 2, front: 1, back: 1 });
    assert.deepEqual(getRgvMotionFrame(h.model)!.front, { direction: 0, speed: 0 });
    clearRgvMotionFrame(h.model);
    assert.equal(getRgvMotionFrame(h.model), null);
    publishRgvMotionFrame(h.model, 44, 1, { travel: 1, front: 1, back: 1 });
    h.model.rgvTelemetry = createRgvTelemetryState(h.model.root);
    assert.equal(getRgvMotionFrame(h.model), null);
  } finally { h.dispose(); }
});

test('行走最后一帧速度按到位距离钳制，后续静止帧清除方向', () => {
  const h = makeHarness();
  try {
    h.apply({ go_column: 1 });
    h.model.rgvTelemetry.rootPosition = h.model.rgvTelemetry.travelTargetPosition!.subtract(new Vector3(0, 0, 0.001));
    const frame = h.apply({ go_column: 1 });
    assert.equal(frame.travel.direction, 1);
    assert.ok(Math.abs(frame.travel.speed - 0.01) < 1e-8);
    assert.deepEqual(h.apply({ go_column: 1 }).travel, { direction: 0, speed: 0 });
  } finally { h.dispose(); }
});

test('实际预览重置原地清理遥测状态时，立即废弃运动摘要并重新屏蔽首帧行走', () => {
  const h = makeHarness();
  try {
    h.apply({ go_column: 1 });
    assert.equal(h.apply({ go_column: 1 }).travel.direction, 1);
    const previousState = h.model.rgvTelemetry;
    resetRgvTelemetryState(h.model);
    assert.equal(h.model.rgvTelemetry, previousState, '项目重置函数原地保留遥测状态对象');
    assert.equal(getRgvMotionFrame(h.model), null, '旧运动帧必须在真实重置后立即失效');
    assert.equal(h.apply({ go_column: 1 }).travel.direction, 0, '重新运行的第一帧不得继承 initialized');
    assert.equal(h.apply({ go_column: 1 }).travel.direction, 1);
  } finally { h.dispose(); }
});

test('完整设备身份变化后，同 task/列/运行编码不继承旧设备的交接方向', () => {
  for (const identity of [{ sourceId: 'another-source' }, { assetCode: 'RGV2' }, { deviceType: 'another-type' }]) {
    const h = makeHarness();
    try {
      const fields = { front_command: 1, front_y: 1, front_task: 8, front_movement_z: 1 };
      assert.equal(h.apply(fields).front.direction, -1);
      assert.equal(h.apply(fields, 0.1, false, identity).front.direction, 0);
      assert.equal(h.apply(fields, 0.1, false, identity).front.direction, 0);
      h.apply({ ...fields, front_movement_z: 0 }, 0.1, false, identity);
      assert.equal(h.apply(fields, 0.1, false, identity).front.direction, -1, '新设备出现真实起转边沿后可重新锁定');
    } finally { h.dispose(); }
  }
});

test('未知起转列或缺少有效台面时不猜测工位输送方向', () => {
  for (const noDeck of [false, true]) {
    const h = makeHarness();
    try {
      if (noDeck) {
        for (const mesh of h.model.meshes.filter((mesh) => mesh.name !== 'track')) mesh.dispose();
        h.model.meshes = h.model.meshes.filter((mesh) => mesh.name === 'track');
      }
      const frame = h.apply({ front_command: 1, front_y: noDeck ? 1 : 99, front_movement_z: 1 });
      assert.deepEqual(frame.front, { direction: 0, speed: 0 });
    } finally { h.dispose(); }
  }
});

test('首帧不输出行走箭头，随后按本帧连续位移输出局部 Z 方向和米制速度', () => {
  const h = makeHarness();
  try {
    const fields = { go_column: 1, front_command: 0, front_movement_z: 0, back_movement_z: 0, movement_x: 2 };
    assert.equal(h.apply(fields).travel.direction, 0);
    const before = h.model.rgvTelemetry.rootPosition!.clone();
    const frame = h.apply(fields);
    assert.equal(frame.travel.direction, 1);
    assert.equal(frame.frameId, h.scene.getFrameId());
    assert.ok(Math.abs(frame.travel.speed - Vector3.Distance(before, h.model.rgvTelemetry.rootPosition!) / 0.1) < 1e-8);
    assert.equal(h.apply({ ...fields, go_column: 2 }).travel.direction, -1);
  } finally { h.dispose(); }
});

test('滚筒起转瞬时对齐、轨道范围纠偏与未知目标不产生行走箭头', () => {
  const h = makeHarness();
  try {
    h.apply({ go_column: 1, front_movement_z: 0 });
    assert.equal(h.apply({ go_column: 1, front_movement_z: 1 }).travel.direction, 0);
    h.model.rgvTelemetry.rootPosition!.z = 100;
    assert.equal(h.apply({ go_column: 1, front_movement_z: 0 }).travel.direction, 0);
    h.apply({ go_column: 2, front_movement_z: 0 });
    assert.equal(h.apply({ go_column: 99, front_movement_z: 0 }).travel.direction, 0);
  } finally { h.dispose(); }
});

test('前后工位按接驳侧与取放语义独立显示，movement_z 1/2 不决定左右', () => {
  const h = makeHarness();
  try {
    const fields = { front_command: 1, front_y: 1, front_movement_z: 1, back_command: 2, back_y: 1, back_movement_z: 2 };
    let frame = h.apply(fields);
    assert.equal(frame.front.direction, -1);
    assert.equal(frame.back.direction, 1);
    assert.ok(frame.front.speed > 0 && frame.back.speed > 0);
    frame = h.apply({ ...fields, front_movement_z: 2, back_movement_z: 1 });
    assert.equal(frame.front.direction, -1);
    assert.equal(frame.back.direction, 1);
    h.apply({ front_command: 0, front_movement_z: 0, back_command: 0, back_movement_z: 0 });
    frame = h.apply({ front_command: 3, front_y: 2, front_movement_z: 2, back_command: 2, back_y: 2, back_movement_z: 1 });
    assert.equal(frame.front.direction, 1);
    assert.equal(frame.back.direction, -1);
  } finally { h.dispose(); }
});

test('交接起转沿用已仲裁的接驳侧，交付后货物引用清空仍持续显示至停转', () => {
  const h = makeHarness();
  try {
    h.candidates[1].model.conveyorTelemetry.waitingTask = '71';
    h.enableDelivery();
    const fields = { front_command: 2, front_y: 3, front_task: 71, front_movement_z: 0 };
    h.apply(fields);
    assert.equal(h.apply({ ...fields, front_movement_z: 1 }).front.direction, -1);
    assert.equal(h.model.rgvTelemetry.frontCargoKey, null);
    assert.equal(h.state.rgvCargoMeshes.size, 0);
    h.candidates[1].model.conveyorTelemetry.waitingTask = null;
    assert.equal(h.apply({ ...fields, front_movement_z: 2 }).front.direction, -1, '等待态变化不得重新仲裁已锁定方向');
    assert.equal(h.apply(fields).front.direction, 0);
  } finally { h.dispose(); }
});

test('取货接驳侧沿用持有相同 task 的候选，动作结束立即停止', () => {
  const h = makeHarness();
  try {
    h.state.conveyorCargoMeshes.set('held', { assetCode: 'left', task: '19' } as never);
    const fields = { front_command: 1, front_y: 3, front_task: 19, front_movement_z: 1 };
    assert.equal(h.apply(fields).front.direction, 1);
    assert.equal(h.apply({ ...fields, front_command: 0 }).front.direction, 0);
  } finally { h.dispose(); }
});

test('车上货物 task 与放货指令 task 不同时，方向仍沿用货物仲裁且保持本次起转锁定', () => {
  const h = makeHarness();
  try {
    h.apply({ front_command: 1, front_y: 1, front_task: 8, front_movement_z: 1 });
    h.apply({ front_command: 0, front_y: 1, front_task: 8, front_movement_z: 0 });
    h.candidates[1].model.conveyorTelemetry.waitingTask = '8';
    const fields = { front_command: 2, front_y: 3, front_task: 9, front_movement_z: 0 };
    h.apply(fields);
    assert.equal(h.apply({ ...fields, front_movement_z: 1 }).front.direction, -1);
    assert.equal(h.apply({ ...fields, front_movement_z: 1 }).front.direction, -1);
  } finally { h.dispose(); }
});

test('故障、无效列/命令/滚筒编码、task 切换及运行基准重建不继承旧交接方向', () => {
  for (const change of [{ front_y: 99 }, { front_y: 0 }, { front_command: 9 }, { front_movement_z: 99 }, { front_task: 9 }, { faulted: true }, { reset: true }]) {
    const h = makeHarness();
    try {
      const fields = { front_command: 1, front_y: 1, front_task: 8, front_movement_z: 1 };
      assert.equal(h.apply(fields).front.direction, -1);
      if ('reset' in change) h.model.rgvTelemetry = createRgvTelemetryState(h.model.root);
      const frame = h.apply({ ...fields, ...change }, 0.1, 'faulted' in change);
      assert.equal(frame.front.direction, 'reset' in change ? -1 : 0, '重建后有效起转可新建方向；其他无效状态必须停止');
      if (!('reset' in change)) assert.equal(h.apply(fields).front.direction, 0, '没有新起转边沿不能复用上次锁定');
      else assert.equal(frame.travel.direction, 0);
    } finally { h.dispose(); }
  }
});

test('无效帧间隔不产生运动摘要或污染车体位置', () => {
  const h = makeHarness();
  try {
    h.apply({ go_column: 1 });
    const before = h.model.rgvTelemetry.rootPosition!.clone();
    for (const delta of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const frame = h.apply({ go_column: 1 }, delta);
      assert.deepEqual(frame.travel, { direction: 0, speed: 0 });
      assert.ok(h.model.rgvTelemetry.rootPosition!.equals(before));
    }
  } finally { h.dispose(); }
});

test('旋转与镜像模型继续按模型局部轴输出方向', () => {
  for (const mirror of [false, true]) {
    const h = makeHarness(Math.PI / 2, mirror);
    try {
      h.apply({ go_column: 1 });
      assert.equal(h.apply({ go_column: 1 }).travel.direction, 1);
      assert.equal(h.apply({ front_command: 1, front_y: 1, front_movement_z: 1 }).front.direction, -1);
    } finally { h.dispose(); }
  }
});
