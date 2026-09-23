import { getStackerMotionFrame } from '../../src/runtime/babylon/telemetry/stackerMotionState';
import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshBuilder, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { StackerTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/stackerDriver';
import { createStackerTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { createSpecializedTelemetrySharedState } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

function makeSnapshot(fields: Record<string, unknown>): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'stacker',
    assetCode: 'STK1',
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

/**
 * 构建 columns×layers 的单排 Locator。支撑位走解析公式（与 SceneRuntime 同源）：
 * 格子本地底面中心 = (列 × columnStepX, 层 × layerStepY, 0) 经 root 世界矩阵变换。
 * 默认 root 绕 Y 轴转 -90°（本地 +X 映射到世界 +Z），便于用 columnStepX/position 摆出目标支撑位。
 */
function makeLocator(
  scene: Scene,
  options: {
    columns: number;
    layers: number;
    startColumn: number;
    startLayer?: number;
    cellSteps?: { columnStepX: number; layerStepY: number };
    rootPosition?: Vector3;
    rootRotationY?: number;
  },
): LocatorRuntimeEntry {
  const root = new TransformNode('locator_root', scene);
  root.rotation.y = options.rootRotationY ?? -Math.PI / 2;
  if (options.rootPosition) root.position.copyFrom(options.rootPosition);
  root.computeWorldMatrix(true);
  return {
    entityId: 'loc1',
    root,
    columnLabelsRoot: new TransformNode('loc1_labels_root', scene),
    columnLabels: [],
    cellSteps: options.cellSteps ?? { columnStepX: 1, layerStepY: 1 },
    cellSize: { length: 1, height: 1, width: 1 },
    material: null,
    assetId: 'L1',
    signature: 'test',
    columns: options.columns,
    layers: options.layers,
    startColumn: options.startColumn,
    startLayer: options.startLayer ?? 1,
    columnReversed: false,
    deviceAssetCode: 'STK1',
    aisleCode: '',
    rowNumber: 2,
    storageDepth: 'near',
  } as unknown as LocatorRuntimeEntry;
}

function makeHarness() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const root = new TransformNode('stk_root', scene);
  const model = {
    assetCode: 'STK1',
    root,
    contentRoot: root,
    meshes: [],
    stackerTelemetry: createStackerTelemetryState(root),
    telemetryBinding: null,
    externalScriptRuntime: null,
  } as unknown as ModelRuntimeEntry;

  const ref: { locator: LocatorRuntimeEntry | null } = { locator: null };
  const logs: string[] = [];
  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [{ entityId: 'e1', model }],
    // 与 SceneRuntime.findLocatorByDevice 同规则：排号一致且列/层落在货格范围内才命中
    findLocatorByDevice: (_assetCode: string, x: number, y: number, z: number) => {
      const locator = ref.locator;
      if (!locator || locator.rowNumber !== z) return null;
      return x >= locator.startColumn && x < locator.startColumn + locator.columns && y >= locator.startLayer && y < locator.startLayer + locator.layers
        ? locator
        : null;
    },
    findLocatorsByDevice: () => (ref.locator ? [ref.locator] : []),
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
    // 与 SceneRuntime.setGeneratedCargoRootPose 同语义：位姿真正落到货物根节点，供朝向/位置断言
    setGeneratedCargoRootPose: (cargo: { root: TransformNode }, position: Vector3, rotation: Quaternion, scaling?: Vector3 | null) => {
      cargo.root.position.copyFrom(position);
      cargo.root.rotationQuaternion = rotation.clone();
      cargo.root.scaling.copyFrom(scaling ?? Vector3.OneReadOnly);
    },
    disposeGeneratedCargo: () => undefined,
    getModelWorldBounds: () => ({ minimum: new Vector3(-0.5, 0, -0.5), maximum: new Vector3(0.5, 3, 0.5) }),
  };
  const context = {
    scene,
    state,
    host,
    disposeStackerCargo: () => undefined,
    disposeConveyorCargo: () => undefined,
    getOrCreateStackerCargo: () => { throw new Error('not used'); },
    getOrCreateConveyorCargo: () => { throw new Error('not used'); },
    adoptGlobalCargoByTask: () => null,
    adoptConveyorPlatformCargo: () => null,
    placeCargoIntoConveyorPlatform: (_locatorEntityId: string, _cargoKey: string) => false,
  };
  const driver = new StackerTelemetryDriver(context as never);
  return {
    driver,
    state,
    model,
    logs,
    scene,
    ref,
    context,
    dispose: () => { scene.dispose(); engine.dispose(); },
    apply: (fields: Record<string, unknown>, deltaSeconds = 0.1, frames = 1) => {
      for (let i = 0; i < frames; i += 1) {
        driver.applyToModel(model, makeSnapshot(fields), deltaSeconds);
      }
    },
  };
}

/** 当前位上报帧：front_x/front_y/front_z 三字段是位置唯一驱动源。 */
const POSITION_FRAME = {
  mode: 4,
  front_command: 0,
  back_command: 9,
  front_x: 10,
  front_y: 1,
  front_z: 2,
  movement_x: 0,
  movement_y: 0,
  normal: true,
  errorCode: 0,
};
/** 为模型补齐堆垛机几何：立柱 y[0,3]，载货台 y[0,0.2]，前后叉 y[0.2,0.3] → 物理升降行程 [0, 2.7]。 */
function makeStackerGeometry(h: ReturnType<typeof makeHarness>): void {
  const root = h.model.root;
  const addBox = (name: string, height: number, centerY: number) => {
    const mesh = MeshBuilder.CreateBox(name, { width: 0.4, height, depth: 0.4 }, h.scene);
    mesh.parent = root;
    mesh.position.set(0, centerY, 0);
    return mesh;
  };
  addBox('lizhu1.11', 3, 1.5);
  addBox('xiang.13', 0.2, 0.1);
  addBox('huocha.9', 0.1, 0.25);
  addBox('huocha2.10', 0.1, 0.25);
  root.computeWorldMatrix(true);
}

test('首帧吸附不产生箭头，帧号对应当前场景帧', () => {
  const h = makeHarness();
  try {
    assert.equal(getStackerMotionFrame(h.model), null);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 3, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME);
    const frame = getStackerMotionFrame(h.model)!;
    assert.ok(frame);
    assert.equal(frame.frameId, h.scene.getFrameId());
    for (const channel of [frame.travel, frame.lift, frame.frontFork, frame.backFork]) {
      assert.deepEqual(channel, { direction: 0, speed: 0 });
    }
    assert.equal(h.model.stackerTelemetry.rootPosition!.z, 20);
  } finally { h.dispose(); }
});

test('行走升降方向速度来自实际执行位移，不依赖 movement_x/y 编码', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 3, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME);
    const previousZ = h.model.stackerTelemetry.rootPosition!.z;
    const previousLift = h.model.stackerTelemetry.liftOffset;
    h.apply({ ...POSITION_FRAME, to_x: 5, to_y: 2, to_z: 2, movement_x: 1, movement_y: 2 });
    const frame = getStackerMotionFrame(h.model)!;
    assert.equal(frame.travel.direction, -1);
    assert.equal(frame.lift.direction, 1);
    assert.ok(Math.abs(frame.travel.speed - (previousZ - h.model.stackerTelemetry.rootPosition!.z) / 0.1) < 1e-9);
    assert.ok(Math.abs(frame.lift.speed - (h.model.stackerTelemetry.liftOffset - previousLift) / 0.1) < 1e-9);
    assert.deepEqual(frame.frontFork, { direction: 0, speed: 0 });
    assert.deepEqual(frame.backFork, { direction: 0, speed: 0 });
    assert.equal(h.model.root.position.z, 0, '模型根节点不移动，不能用根节点采样');
  } finally { h.dispose(); }
});

test('最后一帧输出到位钳制后的速度，到位后静止', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 3, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME);
    h.model.stackerTelemetry.rootPosition!.z = 20.001;
    h.model.stackerTelemetry.liftOffset = 1.999;
    h.apply(POSITION_FRAME);
    let frame = getStackerMotionFrame(h.model)!;
    assert.equal(frame.travel.direction, -1);
    assert.equal(frame.lift.direction, 1);
    assert.ok(Math.abs(frame.travel.speed - 0.01) < 1e-9);
    assert.ok(Math.abs(frame.lift.speed - 0.01) < 1e-9);
    h.apply(POSITION_FRAME);
    frame = getStackerMotionFrame(h.model)!;
    assert.deepEqual(frame.travel, { direction: 0, speed: 0 });
    assert.deepEqual(frame.lift, { direction: 0, speed: 0 });
  } finally { h.dispose(); }
});

test('前后叉分别输出实际伸出和收回方向', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    h.apply({ mode: 1, front_command: 0, back_command: 0, front_movement_z: 1, back_movement_z: 3 });
    let frame = getStackerMotionFrame(h.model)!;
    assert.equal(frame.frontFork.direction, 1);
    assert.equal(frame.backFork.direction, -1);
    assert.ok(frame.frontFork.speed > 0);
    assert.ok(frame.backFork.speed > 0);
    h.apply({ mode: 1, front_command: 0, back_command: 0, front_movement_z: 2, back_movement_z: 4 });
    frame = getStackerMotionFrame(h.model)!;
    assert.equal(frame.frontFork.direction, -1);
    assert.equal(frame.backFork.direction, 1);
    assert.equal(h.model.stackerTelemetry.frontForkOffset, 0);
    assert.equal(h.model.stackerTelemetry.backForkOffset, 0);
  } finally { h.dispose(); }
});

test('转场补偿收叉有箭头，本体行走和升降仍冻结', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 3, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME);
    h.model.stackerTelemetry.frontForkOffset = 1;
    h.model.stackerTelemetry.backForkOffset = -1;
    h.apply({ ...POSITION_FRAME, front_x: 5 });
    const frame = getStackerMotionFrame(h.model)!;
    assert.equal(frame.frontFork.direction, -1);
    assert.equal(frame.backFork.direction, 1);
    assert.deepEqual(frame.travel, { direction: 0, speed: 0 });
    assert.deepEqual(frame.lift, { direction: 0, speed: 0 });
  } finally { h.dispose(); }
});

test('故障帧不输出运动箭头，包括已有的补偿收叉路径', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    h.model.stackerTelemetry.frontForkOffset = 1;
    h.model.stackerTelemetry.forkCatchUp = true;
    h.driver.applyToModel(h.model, { ...makeSnapshot(POSITION_FRAME), faulted: true } as never, 0.1);
    const frame = getStackerMotionFrame(h.model)!;
    for (const channel of [frame.travel, frame.lift, frame.frontFork, frame.backFork]) {
      assert.deepEqual(channel, { direction: 0, speed: 0 });
    }
  } finally { h.dispose(); }
});

test('无效帧间隔不会污染运行状态或产生箭头', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 3, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME);
    for (const deltaSeconds of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      h.apply({ ...POSITION_FRAME, to_x: 5, to_y: 2, to_z: 2, front_movement_z: 1 }, deltaSeconds);
      const frame = getStackerMotionFrame(h.model)!;
      for (const channel of [frame.travel, frame.lift, frame.frontFork, frame.backFork]) {
        assert.deepEqual(channel, { direction: 0, speed: 0 });
      }
      assert.equal(h.model.stackerTelemetry.rootPosition!.z, 20);
      assert.equal(h.model.stackerTelemetry.liftOffset, 2);
    }
  } finally { h.dispose(); }
});

test('旋转与镜像模型按局部行走轴输出方向，速度使用世界米制位移', () => {
  for (const mirrored of [false, true]) {
    const h = makeHarness();
    try {
      h.model.root.rotation.y = Math.PI / 2;
      h.model.root.scaling.set(2, 2, mirrored ? -2 : 2);
      h.model.root.computeWorldMatrix(true);
      h.ref.locator = makeLocator(h.scene, {
        columns: 10, layers: 1, startColumn: 1,
        rootPosition: new Vector3(11, 0, 0), rootRotationY: 0,
      });
      h.apply(POSITION_FRAME);
      const before = h.model.stackerTelemetry.rootPosition!.clone();
      h.apply({ ...POSITION_FRAME, to_x: 5, to_y: 1, to_z: 2 });
      const frame = getStackerMotionFrame(h.model)!;
      assert.equal(frame.travel.direction, mirrored ? 1 : -1);
      assert.ok(Math.abs(frame.travel.speed - Vector3.Distance(before, h.model.stackerTelemetry.rootPosition!) / 0.1) < 1e-9);
    } finally { h.dispose(); }
  }
});

test('已在升降行程边界且遥测目标越界时箭头保持静止', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 20, startColumn: 1, rootPosition: new Vector3(0, 0, 11) });
    h.apply({ ...POSITION_FRAME, front_y: 20 });
    h.apply({ ...POSITION_FRAME, front_y: 20 });
    assert.deepEqual(getStackerMotionFrame(h.model)!.lift, { direction: 0, speed: 0 });
    assert.ok(Math.abs(h.model.stackerTelemetry.liftOffset - 2.7) < 1e-6);
    // 外部重载/校准把偏移置于物理范围外；回到边界只算纠偏，不能闪出反向箭头。
    h.model.stackerTelemetry.liftOffset = 100;
    h.apply({ ...POSITION_FRAME, front_y: 20 });
    assert.deepEqual(getStackerMotionFrame(h.model)!.lift, { direction: 0, speed: 0 });
  } finally { h.dispose(); }
});

test('运行基准重建后重新吸附不会继承上一帧的运动状态', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 3, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME);
    h.apply({ ...POSITION_FRAME, to_x: 5, to_y: 2, to_z: 2 });
    assert.equal(getStackerMotionFrame(h.model)!.travel.direction, -1);
    h.model.stackerTelemetry = createStackerTelemetryState(h.model.root);
    h.apply(POSITION_FRAME);
    const frame = getStackerMotionFrame(h.model)!;
    assert.deepEqual(frame.travel, { direction: 0, speed: 0 });
    assert.deepEqual(frame.lift, { direction: 0, speed: 0 });
  } finally { h.dispose(); }
});
