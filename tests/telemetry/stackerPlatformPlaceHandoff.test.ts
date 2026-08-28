import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshBuilder, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { StackerTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/stackerDriver';
import { ConveyorTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/conveyorDriver';
import {
  createConveyorTelemetryState,
  createStackerTelemetryState,
} from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import {
  createSpecializedTelemetrySharedState,
  type GeneratedCargoRuntimeEntry,
} from '../../src/runtime/babylon/telemetry/specialized/types';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

/**
 * stacker 向 conveyor 内置站台放货的端到端复现（中鼎场景 DDJ2 → 1005）：
 * mode==4 下按 signalBits 前一帧锁存放货，伸足解绑落货后货物滞留 stacker 侧并登记待交接站台，
 * 收叉完毕（收叉停止边沿，或收叉动画完结触发相位退出兜底）才交付给站台 conveyor；
 * 交付后收叉回零的相位退出不得销毁已交接货物。
 */

function makeSnapshot(deviceType: string, assetCode: string, fields: Record<string, unknown>): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType,
    assetCode,
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

/** 站台货格世界支撑位（1005 内置 1×1 货格）：stacker 右侧 4m、高 1m。 */
const PLATFORM_SUPPORT = new Vector3(4, 1, 0);

function makeHarness() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const logs: string[] = [];

  // DDJ2 stacker：原点、identity 朝向；货叉轴 +x
  const stackerRoot = new TransformNode('ddj2_root', scene);
  const addBox = (name: string, height: number, centerY: number) => {
    const mesh = MeshBuilder.CreateBox(name, { width: 0.4, height, depth: 0.4 }, scene);
    mesh.parent = stackerRoot;
    mesh.position.set(0, centerY, 0);
    return mesh;
  };
  addBox('lizhu1.11', 3, 1.5);
  addBox('xiang.13', 0.2, 0.1);
  addBox('huocha.9', 0.1, 0.25);
  addBox('huocha2.10', 0.1, 0.25);
  stackerRoot.computeWorldMatrix(true);
  const stacker = {
    assetCode: 'DDJ2',
    root: stackerRoot,
    contentRoot: stackerRoot,
    meshes: [],
    stackerCapable: true,
    conveyorCapable: false,
    stackerTelemetry: createStackerTelemetryState(stackerRoot),
    conveyorTelemetry: createConveyorTelemetryState(),
    telemetryBinding: null,
    externalScriptRuntime: null,
    entitySnapshot: { id: 'e_DDJ2', components: {} },
  } as unknown as ModelRuntimeEntry;

  // 1005 链条机（conveyor）：x=5，行走轴 +x，跨度 ±2
  const conveyorRoot = new TransformNode('c1005_root', scene);
  conveyorRoot.position.set(5, 0, 0);
  conveyorRoot.computeWorldMatrix(true);
  const conveyor = {
    assetCode: '1005',
    root: conveyorRoot,
    contentRoot: conveyorRoot,
    meshes: [],
    stackerCapable: false,
    conveyorCapable: true,
    conveyorTelemetry: createConveyorTelemetryState(),
    stackerTelemetry: createStackerTelemetryState(conveyorRoot),
    telemetryBinding: null,
    externalScriptRuntime: null,
    entitySnapshot: { id: 'e_1005', components: {} },
  } as unknown as ModelRuntimeEntry;

  // 内置站台货格：挂在 1005 根下，世界支撑位 (4,1,0)；row 2 列 43 层 1（与 DDJ2 当前位匹配）
  const platformRoot = new TransformNode('slot_1005_root', scene);
  platformRoot.parent = conveyorRoot;
  platformRoot.position = PLATFORM_SUPPORT.subtract(conveyorRoot.position);
  platformRoot.computeWorldMatrix(true);
  const platformLocator = {
    entityId: 'slot_1005',
    root: platformRoot,
    columns: 1,
    layers: 1,
    startColumn: 43,
    startLayer: 1,
    columnReversed: false,
    cellSteps: { columnStepX: 1.3, layerStepY: 0.34 },
    rowNumber: 2,
    deviceAssetCode: 'DDJ2',
  } as unknown as LocatorRuntimeEntry;

  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [
      { entityId: 'e_DDJ2', model: stacker },
      { entityId: 'e_1005', model: conveyor },
    ],
    findLocatorByDevice: (assetCode: string, x: number, y: number, z: number) =>
      assetCode === 'DDJ2' && z === 2 && x === 43 && y === 1 ? platformLocator : null,
    findLocatorsByDevice: (assetCode: string) => (assetCode === 'DDJ2' ? [platformLocator] : []),
    findBuiltInSlotLocatorForHostModel: (hostEntityId: string) => (hostEntityId === 'e_1005' ? platformLocator : null),
    resolveBuiltInSlotHost: (locatorEntityId: string) =>
      locatorEntityId === 'slot_1005' ? { model: conveyor, locator: platformLocator } : null,
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
    setGeneratedCargoRootPose: (cargo: { root: TransformNode }, position: Vector3, rotation: Quaternion, scaling?: Vector3 | null) => {
      cargo.root.position.copyFrom(position);
      cargo.root.rotationQuaternion = rotation.clone();
      cargo.root.scaling.copyFrom(scaling ?? Vector3.OneReadOnly);
    },
    disposeGeneratedCargo: (_cargo: GeneratedCargoRuntimeEntry) => undefined,
    getModelWorldBounds: (model: ModelRuntimeEntry) =>
      model.assetCode === '1005'
        ? { minimum: new Vector3(3, 0, -0.5), maximum: new Vector3(7, 1, 0.5) }
        : { minimum: new Vector3(-0.5, 0, -0.5), maximum: new Vector3(0.5, 3, 0.5) },
  };

  // 镜像 SpecializedTelemetryRuntime 的交接线路：先建上下文壳，再注入两个 driver 的相互引用
  const context = { scene, state, host } as Record<string, unknown>;
  const stackerDriver = new StackerTelemetryDriver(context as never);
  const conveyorDriver = new ConveyorTelemetryDriver(context as never);
  context.disposeStackerCargo = (cargo: GeneratedCargoRuntimeEntry) => host.disposeGeneratedCargo(cargo);
  context.disposeConveyorCargo = (cargo: GeneratedCargoRuntimeEntry) => host.disposeGeneratedCargo(cargo);
  context.getOrCreateStackerCargo = (assetCode: string, side: 'front' | 'back') => stackerDriver.getOrCreateStackerCargo(assetCode, side);
  context.getOrCreateConveyorCargo = (assetCode: string, containerCode: string) => conveyorDriver.getOrCreateConveyorCargo(assetCode, containerCode);
  context.adoptGlobalCargoByTask = (task: string, claimingCargoKey: string) => {
    if (!task) return null;
    for (const [key, cargo] of [...state.stackerCargoMeshes]) {
      if (key !== claimingCargoKey && cargo.task === task) return stackerDriver.detachClaimedCargoByKey(key);
    }
    for (const [key, cargo] of [...state.conveyorCargoMeshes]) {
      if (key !== claimingCargoKey && cargo.task === task) return conveyorDriver.detachClaimedCargoByKey(key);
    }
    for (const [key, cargo] of [...state.rgvCargoMeshes]) {
      if (key !== claimingCargoKey && cargo.task === task) return null;
    }
    return null;
  };
  context.detachClaimedCargoByReference = (cargo: GeneratedCargoRuntimeEntry) => {
    for (const [key, entry] of [...state.stackerCargoMeshes]) {
      if (entry === cargo) return stackerDriver.detachClaimedCargoByKey(key);
    }
    for (const [key, entry] of [...state.conveyorCargoMeshes]) {
      if (entry === cargo) return conveyorDriver.detachClaimedCargoByKey(key);
    }
    return null;
  };
  context.adoptConveyorPlatformCargo = (locatorEntityId: string, stackerAssetCode: string) => {
    const resolved = host.resolveBuiltInSlotHost(locatorEntityId);
    if (!resolved) return null;
    return conveyorDriver.adoptPlatformCargoForStacker(resolved.model, stackerAssetCode);
  };
  context.placeCargoIntoConveyorPlatform = (locatorEntityId: string, cargoKey: string) => {
    const resolved = host.resolveBuiltInSlotHost(locatorEntityId);
    if (!resolved) return false;
    if (!conveyorDriver.canAcceptPlatformPlacedCargo(resolved.model, resolved.locator)) return false;
    const cargo = stackerDriver.detachClaimedCargoByKey(cargoKey);
    if (!cargo) return false;
    if (!conveyorDriver.acceptPlatformPlacedCargo(resolved.model, resolved.locator, cargo)) {
      state.stackerCargoMeshes.set(cargoKey, cargo);
      return false;
    }
    return true;
  };
  context.resolveConveyorDeckCenterWorld = () => null;
  context.deliverRgvCargoToConveyorColumn = () => false;
  context.isRgvCargoReadyForExternalPull = () => false;
  context.isStackerCargoPendingPlatformHandoff = (cargo: GeneratedCargoRuntimeEntry) =>
    stackerDriver.isStackerCargoPendingPlatformHandoff(cargo);

  let stackerFields: Record<string, unknown> = {};
  let conveyorFields: Record<string, unknown> = {};

  return {
    state,
    logs,
    stacker,
    conveyor,
    stackerDriver,
    conveyorDriver,
    dispose: () => { scene.dispose(); engine.dispose(); },
    /** 镜像 facade 帧调度：两台设备同帧推进。 */
    apply: (
      nextStackerFields: Record<string, unknown>,
      nextConveyorFields: Record<string, unknown>,
      deltaSeconds = 0.1,
      frames = 1,
    ) => {
      stackerFields = nextStackerFields;
      conveyorFields = nextConveyorFields;
      for (let i = 0; i < frames; i += 1) {
        stackerDriver.applyToModel(stacker, makeSnapshot('stacker', 'DDJ2', stackerFields) as never, deltaSeconds);
        conveyorDriver.applyToModel(conveyor, makeSnapshot('conveyor', '1005', conveyorFields), deltaSeconds);
        conveyorDriver.pullExternalHolderCargo();
      }
    },
  };
}

/** 1005 空闲基线帧：task 370 在持/刚流过，movement 停止。 */
const CONVEYOR_IDLE = { task: 370, movement_x: 0, signalBits: 8 };
/** DDJ2 到达站台（43,1,2）停稳：货箱内有货（bit17=1），command 在 mode 4 下不可靠（恒 1）。 */
const STACKER_ARRIVED = {
  mode: 4, front_command: 1, back_command: 9,
  front_x: 43, front_y: 1, front_z: 2,
  front_task: 12279, front_movement_z: 0,
  front_signalBits: 33685504, movement_x: 0, movement_y: 0, normal: true, errorCode: 0,
};

test('mode==4 放货到 conveyor 站台：伸足落货登记待交接，收叉动画完结（相位退出兜底）才交付', () => {
  const h = makeHarness();
  try {
    // 1005 先跑几帧空闲基线（线首站台：task 边沿挂起等待 stacker 交付）
    h.apply({ ...STACKER_ARRIVED, front_x: 0, front_y: 0, front_z: 0, front_signalBits: 0, front_task: 0 }, CONVEYOR_IDLE, 0.1, 5);

    // 模拟取货完成后的持货状态：cargo 已绑定前叉（task 12279）
    const cargo = h.stackerDriver.getOrCreateStackerCargo('DDJ2', 'front');
    cargo.task = '12279';
    const st = h.stacker.stackerTelemetry;
    st.frontCargoKey = JSON.stringify(['DDJ2', 'front']);
    st.frontCargoBoundToFork = true;

    // 到位停稳（bit17=1 建立前一帧有货样本）
    h.apply(STACKER_ARRIVED, CONVEYOR_IDLE, 0.1, 5);
    assert.equal(st.frontSignalCargoPresent, true, '停稳帧必须建立有货样本');

    // 伸叉放货：同帧信号位已翻 0（货转移到叉上）；前一帧有货 → 锁存放货
    h.apply({ ...STACKER_ARRIVED, front_signalBits: 0, front_movement_z: 3 }, CONVEYOR_IDLE, 0.1, 1);
    assert.equal(st.frontSignalAction, 'place', '伸叉起点必须按前一帧有货锁存为放货');

    // 继续伸足（目标行程 = 站台支撑位 x=4m，允许悬空）：解绑落货但 mode==4 不交付，登记待交接站台
    h.apply({ ...STACKER_ARRIVED, front_signalBits: 0, front_movement_z: 3 }, CONVEYOR_IDLE, 0.1, 200);
    assert.equal(st.frontCargoBoundToFork, false, '伸足必须解绑落货');
    assert.equal(st.frontCargoPendingPlatformLocatorId, 'slot_1005', 'mode==4 落货必须登记待交接站台');
    assert.equal(h.state.stackerCargoMeshes.size, 1, '收叉完毕前货物必须留在 stacker 侧（待交接）');
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '收叉完毕前不得交付给 1005');

    // 伸出后停帧（上帧是伸出而非收叉）：不得误触发收叉停止边沿交付
    h.apply({ ...STACKER_ARRIVED, front_signalBits: 0, front_movement_z: 0 }, CONVEYOR_IDLE, 0.1, 5);
    assert.equal(h.state.stackerCargoMeshes.size, 1, '伸出后停帧不得误触发交付（上帧非收叉）');
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '伸出后停帧 1005 不得收货');

    // 收叉回零：锁存清除产生相位退出边沿 → 兜底交付站台滞留货，货物不得被销毁
    h.apply({ ...STACKER_ARRIVED, front_signalBits: 0, front_movement_z: 4 }, CONVEYOR_IDLE, 0.1, 200);
    assert.equal(st.frontForkOffset, 0, '收叉必须归零');
    assert.equal(st.frontSignalAction, null, '收叉回零后锁存必须清除');
    assert.equal(h.state.stackerCargoMeshes.size, 0, '相位退出交付后 stacker 货物表必须清空');
    assert.equal(st.frontCargoPendingPlatformLocatorId, null, '交付成功后待交接登记必须清除');
    const conveyorCargo = h.state.conveyorCargoMeshes.get(JSON.stringify(['1005', 'cargo']));
    assert.ok(conveyorCargo, '收叉完毕后货物必须由 1005 持有');
    assert.ok(
      Math.abs(conveyorCargo.root.position.x - PLATFORM_SUPPORT.x) < 0.05,
      `货物必须落在站台支撑位 x=${PLATFORM_SUPPORT.x}，实际 ${conveyorCargo.root.position.x}`,
    );

    // 1005 接到新 task 驶离：滞留货物复用盖 task 后随行，不得消失
    h.apply(STACKER_ARRIVED, { task: 371, movement_x: 1, signalBits: 0 }, 0.1, 30);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '1005 新 task 必须复用滞留货物而非销毁');
  } finally {
    h.dispose();
  }
});

test('mode==4 放货到 conveyor 站台：收叉中途停止（上帧收叉本帧停止）即触发交付，不等收叉动画完结', () => {
  const h = makeHarness();
  try {
    h.apply({ ...STACKER_ARRIVED, front_x: 0, front_y: 0, front_z: 0, front_signalBits: 0, front_task: 0 }, CONVEYOR_IDLE, 0.1, 5);

    const cargo = h.stackerDriver.getOrCreateStackerCargo('DDJ2', 'front');
    cargo.task = '12279';
    const st = h.stacker.stackerTelemetry;
    st.frontCargoKey = JSON.stringify(['DDJ2', 'front']);
    st.frontCargoBoundToFork = true;

    h.apply(STACKER_ARRIVED, CONVEYOR_IDLE, 0.1, 5);
    // 伸足落货：登记待交接，货物滞留 stacker 侧
    h.apply({ ...STACKER_ARRIVED, front_signalBits: 0, front_movement_z: 3 }, CONVEYOR_IDLE, 0.1, 200);
    assert.equal(st.frontCargoPendingPlatformLocatorId, 'slot_1005', '落货后必须登记待交接站台');
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '收叉完毕前不得交付');

    // 收叉 3 帧（行程远未走完）后停止：上帧收叉本帧停止 → 信号边沿当场交付
    h.apply({ ...STACKER_ARRIVED, front_signalBits: 0, front_movement_z: 4 }, CONVEYOR_IDLE, 0.1, 3);
    assert.ok(st.frontForkOffset > 0.05, `收叉 3 帧后货叉应仍在行程中，实际 ${st.frontForkOffset}`);
    h.apply({ ...STACKER_ARRIVED, front_signalBits: 0, front_movement_z: 0 }, CONVEYOR_IDLE, 0.1, 1);
    assert.equal(h.state.stackerCargoMeshes.size, 0, '收叉停止边沿必须当场交付站台滞留货');
    const conveyorCargo = h.state.conveyorCargoMeshes.get(JSON.stringify(['1005', 'cargo']));
    assert.ok(conveyorCargo, '信号边沿交付后货物必须由 1005 持有');
    assert.ok(st.frontForkOffset > 0.05, `交付时货叉尚未收完（证明非动画完结路径），实际 ${st.frontForkOffset}`);
    assert.equal(st.frontCargoPendingPlatformLocatorId, null, '交付成功后待交接登记必须清除');
    assert.ok(
      Math.abs(conveyorCargo.root.position.x - PLATFORM_SUPPORT.x) < 0.05,
      `货物必须落在站台支撑位 x=${PLATFORM_SUPPORT.x}，实际 ${conveyorCargo.root.position.x}`,
    );

    // 后续收叉回零：货物已交付，锁存清除的相位退出不得销毁
    h.apply({ ...STACKER_ARRIVED, front_signalBits: 0, front_movement_z: 4 }, CONVEYOR_IDLE, 0.1, 200);
    assert.equal(st.frontForkOffset, 0, '收叉必须归零');
    assert.equal(st.frontSignalAction, null, '收叉回零后锁存必须清除');
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '相位退出不得销毁已交接货物');
    assert.equal(h.state.stackerCargoMeshes.size, 0, 'stacker 侧不得残留货物');
  } finally {
    h.dispose();
  }
});
