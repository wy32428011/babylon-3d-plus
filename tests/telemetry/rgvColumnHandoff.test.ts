import assert from 'node:assert/strict';
import test from 'node:test';

import { NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { ConveyorTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/conveyorDriver';
import { RgvTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/rgvDriver';
import {
  createConveyorTelemetryState,
  createRgvTelemetryState,
} from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import {
  CONVEYOR_CARGO_SIZE,
  createSpecializedTelemetrySharedState,
  type GeneratedCargoRuntimeEntry,
} from '../../src/runtime/babylon/telemetry/specialized/types';
import { resolveConveyorCargoTravelHalfRange } from '../../src/runtime/babylon/telemetry/conveyorCargoTravel';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

/**
 * RGV 列绑定一对多的订阅仲裁测试布局：
 * RGV1 在原点，行走轴为模型局部 z；列 5 绑定两台 conveyor（CVA 在 z=-4，CVB 在 z=+4），
 * 载货面中心（deckCenter）即列对齐基准。conveyor 行程轴为局部 x（与 conveyorTaskHandoff 一致）。
 */
const CVA_DECK = new Vector3(0.5, 0.8, -4);
const CVB_DECK = new Vector3(-0.5, 0.8, 4);

function makeRgvSnapshot(
  fields: Record<string, unknown>,
  receivedAt: number = Date.now(),
): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'rgv',
    assetCode: 'RGV1',
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

function makeConveyorSnapshot(
  assetCode: string,
  fields: Record<string, unknown>,
  receivedAt: number = Date.now(),
): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'conveyor',
    assetCode,
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

/** harness：RGV + 两台同列 conveyor 共享货物表，context 镜像 facade 的交付/门控实现。 */
function makeHarness() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const models = new Map<string, ModelRuntimeEntry>();
  const logs: string[] = [];

  const makeModel = (assetCode: string, center: Vector3, conveyorCapable: boolean): ModelRuntimeEntry => {
    const root = new TransformNode(`${assetCode}_root`, scene);
    root.position.copyFrom(center);
    const model = {
      assetCode,
      root,
      contentRoot: root,
      meshes: [],
      conveyorCapable,
      stackerCapable: false,
      rgvCapable: !conveyorCapable,
      conveyorTelemetry: createConveyorTelemetryState(),
      rgvTelemetry: createRgvTelemetryState(root),
      stackerTelemetry: null,
      telemetryBinding: null,
      externalScriptRuntime: null,
      entitySnapshot: { id: `e_${assetCode}` },
    } as unknown as ModelRuntimeEntry;
    models.set(assetCode, model);
    return model;
  };

  const rgvModel = makeModel('RGV1', Vector3.Zero(), false);
  rgvModel.telemetryBinding = { columnBindings: { '5': ['e_CVA', 'e_CVB'] } } as unknown as ModelRuntimeEntry['telemetryBinding'];
  makeModel('CVA', new Vector3(0, 0, -4), true);
  makeModel('CVB', new Vector3(0, 0, 4), true);

  const deckCenters: Record<string, Vector3> = { e_CVA: CVA_DECK, e_CVB: CVB_DECK };

  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [...models.values()].map((model) => ({ entityId: `e_${model.assetCode}`, model })),
    findLocatorByDevice: () => null,
    findLocatorsByDevice: () => [],
    findBuiltInSlotLocatorForHostModel: () => null,
    resolveCargoGeneratorForModel: () => null,
    resolveColumnTargetPose: (entityId: string) => {
      const model = models.get(entityId.replace(/^e_/, ''));
      if (!model) return null;
      return { position: model.root.position.clone(), rotation: Quaternion.Identity() };
    },
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
    setGeneratedCargoRootPose: (cargo: GeneratedCargoRuntimeEntry, position: Vector3, rotation: Quaternion) => {
      cargo.root.position.copyFrom(position);
      cargo.root.rotationQuaternion = rotation.clone();
    },
    disposeGeneratedCargo: () => undefined,
    getModelWorldBounds: (model: ModelRuntimeEntry) => ({
      minimum: model.root.position.add(new Vector3(-2, 0, -0.5)),
      maximum: model.root.position.add(new Vector3(2, 1, 0.5)),
    }),
  };

  let conveyorDriver!: ConveyorTelemetryDriver;
  let rgvDriver!: RgvTelemetryDriver;
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
    adoptConveyorPlatformCargo: () => null,
    placeCargoIntoConveyorPlatform: () => false,
    resolveConveyorDeckCenterWorld: (entityId: string) => deckCenters[entityId]?.clone() ?? null,
    // 镜像 SpecializedTelemetryRuntime.deliverRgvCargoToConveyorColumn：先预检再拆引用
    deliverRgvCargoToConveyorColumn: (entityId: string, cargoKey: string, task: string, preserveAxialPosition = false) => {
      const model = models.get(entityId.replace(/^e_/, ''));
      if (!model || !model.conveyorCapable) return false;
      if (!conveyorDriver.canAcceptRgvColumnPlacedCargo(model, task)) return false;
      const cargo = rgvDriver.detachClaimedCargoByKey(cargoKey);
      if (!cargo) return false;
      if (!conveyorDriver.acceptRgvColumnPlacedCargo(model, cargo, task, preserveAxialPosition)) {
        state.rgvCargoMeshes.set(cargoKey, cargo);
        return false;
      }
      return true;
    },
    isRgvCargoReadyForExternalPull: (cargo: GeneratedCargoRuntimeEntry) => rgvDriver.isRgvCargoReadyForExternalPull(cargo),
    isStackerCargoPendingPlatformHandoff: () => false,
  };
  conveyorDriver = new ConveyorTelemetryDriver(context as never);
  rgvDriver = new RgvTelemetryDriver(context as never);

  return {
    state,
    logs,
    models: Object.fromEntries(models) as Record<string, ModelRuntimeEntry>,
    rgvModel,
    dispose: () => { scene.dispose(); engine.dispose(); },
    /** 镜像 facade 帧调度：应用 RGV 快照后执行帧尾外部持货拉取扫描。 */
    applyRgv: (fields: Record<string, unknown>, deltaSeconds = 0.1) => {
      rgvDriver.applyToModel(rgvModel, makeRgvSnapshot(fields), deltaSeconds);
      conveyorDriver.pullExternalHolderCargo();
    },
    /** 驱动指定 conveyor 一帧（镜像 facade 对每台设备应用快照）。 */
    applyConveyor: (assetCode: string, fields: Record<string, unknown>, deltaSeconds = 0.1, receivedAt?: number) => {
      conveyorDriver.applyToModel(models.get(assetCode)!, makeConveyorSnapshot(assetCode, fields, receivedAt), deltaSeconds);
    },
    /** 向 conveyor 货物表插入持有货物并置遥测引用（模拟输送线已持有的货箱）。 */
    insertConveyorCargo: (assetCode: string, task: string) => {
      const root = new TransformNode(`${assetCode}_cargo_root`, scene);
      const entry: GeneratedCargoRuntimeEntry = {
        assetCode,
        containerCode: '',
        task,
        root,
        outputOwner: null,
        fallback: null,
        generatorEntityId: null,
        handoff: null,
        axialLengthCache: null,
        lockedWorldRotation: null,
      };
      state.conveyorCargoMeshes.set(JSON.stringify([assetCode, 'cargo']), entry);
      models.get(assetCode)!.conveyorTelemetry.cargoCode = 'cargo';
      return entry;
    },
  };
}

/** 放货协议三帧：command 2 补建车上货 → movement_z 起转锁列（等待方就绪即当场交付） → 停转兜底交接。 */
function runPlaceSequence(h: ReturnType<typeof makeHarness>, task: number): void {
  h.applyRgv({ front_command: 2, front_y: 5, front_task: task, front_movement_z: 0 });
  h.applyRgv({ front_command: 2, front_y: 5, front_task: task, front_movement_z: 1 });
  h.applyRgv({ front_command: 2, front_y: 5, front_task: task, front_movement_z: 0 });
}

test('同列多台放货：起转锁列即交付给正在等待该 task 的 conveyor，不等停转，另一台无货', () => {
  const h = makeHarness();
  try {
    // CVA 等待 task 101（订阅在链），CVB 无等待
    h.models.CVA.conveyorTelemetry.pendingTask = '101';
    h.models.CVA.conveyorTelemetry.waitingTask = '101';

    h.applyRgv({ front_command: 2, front_y: 5, front_task: 101, front_movement_z: 0 });
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '放货起始帧不得提前交付');

    // 起转锁列帧：等待方已就绪，货物当场交付释放
    h.applyRgv({ front_command: 2, front_y: 5, front_task: 101, front_movement_z: 1 });
    assert.equal(h.state.rgvCargoMeshes.size, 0, '起转帧交付后 RGV 货物表必须已清空');
    assert.equal(h.rgvModel.rgvTelemetry.frontCargoKey, null, '起转帧交付后 RGV 前工位引用必须已清理');
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '起转帧货物必须已交付给唯一一台 conveyor');
    const delivered = [...h.state.conveyorCargoMeshes.values()][0];
    assert.equal(delivered.assetCode, 'CVA', '等待方 CVA 必须收到货物');
    assert.equal(delivered.task, '101');
    const cvaState = h.models.CVA.conveyorTelemetry;
    assert.equal(cvaState.cargoCode, 'cargo', 'CVA 必须置持货引用');
    assert.equal(cvaState.pendingTask, null, '交付后清挂单');
    assert.equal(cvaState.waitingTask, null, '交付后清等待');
    assert.notEqual(cvaState.selfDriveDirection, 0, '承接后必须登记自驱走行');
    assert.equal(h.models.CVB.conveyorTelemetry.cargoCode, null, 'CVB 不得有货');

    // 停转边沿：交付已完成，兜底不得重复交付或销毁
    h.applyRgv({ front_command: 2, front_y: 5, front_task: 101, front_movement_z: 0 });
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '停转兜底不得影响已交付货物');
    assert.equal(h.models.CVA.conveyorTelemetry.cargoCode, 'cargo');
  } finally {
    h.dispose();
  }
});

test('同列多台放货：等待方起转后出现时停转边沿兜底交付', () => {
  const h = makeHarness();
  try {
    // 起转帧该列尚无等待方：货物保持车上/插值状态不销毁
    h.applyRgv({ front_command: 2, front_y: 5, front_task: 103, front_movement_z: 0 });
    h.applyRgv({ front_command: 2, front_y: 5, front_task: 103, front_movement_z: 1 });
    assert.equal(h.state.rgvCargoMeshes.size, 1, '无等待方时起转帧不得销毁货物');

    // 插值途中 CVA 才开始等待该 task
    h.models.CVA.conveyorTelemetry.pendingTask = '103';
    h.models.CVA.conveyorTelemetry.waitingTask = '103';

    // 停转边沿兜底交付
    h.applyRgv({ front_command: 2, front_y: 5, front_task: 103, front_movement_z: 0 });
    assert.equal(h.state.rgvCargoMeshes.size, 0, '停转兜底交付后 RGV 货物表必须清空');
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '停转兜底必须把货物交给中途出现的等待方');
    assert.equal([...h.state.conveyorCargoMeshes.values()][0].assetCode, 'CVA');
  } finally {
    h.dispose();
  }
});

test('同列多台放货：承接方消息滞后的兜底交付按货物当前位置投影对齐轨迹，不回进入端重来', () => {
  const h = makeHarness();
  try {
    // 起转帧该列尚无等待方：交付失败，交接插值开始推进（progress < 1）
    h.applyRgv({ front_command: 2, front_y: 5, front_task: 103, front_movement_z: 0 });
    h.applyRgv({ front_command: 2, front_y: 5, front_task: 103, front_movement_z: 1 });
    assert.equal(h.state.rgvCargoMeshes.size, 1, '无等待方时起转帧不得销毁货物');

    // CVA 的 task 消息滞后到达（真实帧进入等待）；货物已随交接插值移离车体（行走轴坐标 +0.8，侧向偏出轨迹 0.6m）
    const staleAt = Date.now();
    h.applyConveyor('CVA', { task: 103, movement_x: 0 }, 0.1, staleAt);
    assert.equal(h.models.CVA.conveyorTelemetry.waitingTask, '103', 'CVA 必须已进入等待');
    const cargo = [...h.state.rgvCargoMeshes.values()][0];
    cargo.root.position.set(0.8, 0.8, -4.6);

    // 停转边沿兜底交付：按当前位置投影到 CVA 行走轴（包围盒中心 (0,0.5,-4)，轴向 x → 偏移 0.8）
    h.applyRgv({ front_command: 2, front_y: 5, front_task: 103, front_movement_z: 0 });
    const cvaState = h.models.CVA.conveyorTelemetry;
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '停转兜底必须把货物交给中途出现的等待方');
    assert.equal(cvaState.cargoCode, 'cargo');
    const halfRange = resolveConveyorCargoTravelHalfRange(4, CONVEYOR_CARGO_SIZE.x);
    assert.ok(
      Math.abs(cvaState.cargoTravelOffset - 0.8) < 1e-6,
      `滞后承接必须按当前位置投影落地（0.8），不得回进入端 -${halfRange}，实际 ${cvaState.cargoTravelOffset}`,
    );
    assert.equal(cvaState.selfDriveDirection, 1, '承接后必须登记自驱走行');

    // 消息断流期间重放同一快照（stale receivedAt）：handoff 1s 内从侧缘姿态平滑对齐轨迹（z 收敛到 -4），
    // 同时按预设速度（0.3m/s）向终点推进
    for (let i = 0; i < 10; i += 1) h.applyConveyor('CVA', { task: 103, movement_x: 0 }, 0.1, staleAt);
    assert.ok(Math.abs(cvaState.cargoTravelOffset - 1.1) < 1e-6, `自驱 1s 后偏移应为 1.1，实际 ${cvaState.cargoTravelOffset}`);
    assert.ok(Math.abs(cargo.root.position.x - 1.1) < 1e-6, `handoff 完结后 x 应为目标偏移 1.1，实际 ${cargo.root.position.x}`);
    assert.ok(Math.abs(cargo.root.position.z - (-4)) < 1e-6, `handoff 完结后必须已对齐轨迹 z=-4，实际 ${cargo.root.position.z}`);

    // 持续自驱直至终点端停住
    for (let i = 0; i < 30; i += 1) h.applyConveyor('CVA', { task: 103, movement_x: 0 }, 0.1, staleAt);
    assert.ok(
      Math.abs(cargo.root.position.x - halfRange) < 1e-6,
      `货物必须最终停在终点端 +${halfRange}，实际 x=${cargo.root.position.x}`,
    );
  } finally {
    h.dispose();
  }
});

test('同列多台放货：该列无任何 conveyor 等待时保持停转销毁语义', () => {
  const h = makeHarness();
  try {
    runPlaceSequence(h, 102);

    assert.equal(h.state.rgvCargoMeshes.size, 0, 'RGV 货物表必须已清空');
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '无等待方时货物必须销毁，不得进入 conveyor');
    assert.equal(h.rgvModel.rgvTelemetry.frontCargoKey, null);
  } finally {
    h.dispose();
  }
});

test('同列多台取货：行走对齐持有该 task 货物的 conveyor 载货面中心', () => {
  const h = makeHarness();
  try {
    h.insertConveyorCargo('CVB', '202');
    h.applyRgv({ front_command: 1, front_y: 5, front_task: 202, front_movement_z: 1 });
    assert.equal(h.rgvModel.rgvTelemetry.rootPosition?.z, CVB_DECK.z, '必须对齐持货方 CVB 的载货面');
  } finally {
    h.dispose();
  }
});

test('同列多台取货：无持货方时回退首个绑定实体', () => {
  const h = makeHarness();
  try {
    h.insertConveyorCargo('CVB', '999');
    h.applyRgv({ front_command: 1, front_y: 5, front_task: 202, front_movement_z: 1 });
    assert.equal(h.rgvModel.rgvTelemetry.rootPosition?.z, CVA_DECK.z, '无匹配持货方必须回退首个绑定 CVA');
  } finally {
    h.dispose();
  }
});

test('放货起转交付后货物落在 conveyor 进入端，随后随行走逐步移向终点', () => {
  const h = makeHarness();
  try {
    // CVA 真实帧驱动进入等待 task 101（订阅登记）
    h.applyConveyor('CVA', { task: 101, movement_x: 0 });
    h.applyConveyor('CVA', { task: 101, movement_x: 0 });
    assert.equal(h.models.CVA.conveyorTelemetry.waitingTask, '101', 'CVA 必须已进入等待');

    // RGV 放货：起转帧完成交付
    h.applyRgv({ front_command: 2, front_y: 5, front_task: 101, front_movement_z: 0 });
    h.applyRgv({ front_command: 2, front_y: 5, front_task: 101, front_movement_z: 1 });
    const cvaState = h.models.CVA.conveyorTelemetry;
    assert.equal(cvaState.cargoCode, 'cargo', '起转帧必须完成交付');

    // CVA 跨度 4m（bounds ±2）、货箱轴向 0.72 → 行程半径 1.64；交付瞬间必须落在进入端
    const halfRange = resolveConveyorCargoTravelHalfRange(4, CONVEYOR_CARGO_SIZE.x);
    assert.ok(
      Math.abs(cvaState.cargoTravelOffset + halfRange) < 1e-6,
      `交付瞬间偏移必须在进入端 -${halfRange}，实际 ${cvaState.cargoTravelOffset}`,
    );
    const cargo = [...h.state.conveyorCargoMeshes.values()][0];

    // 行走 1s（覆盖 handoff 插值窗口）：货物须仍在进入端半区，不得直接落在终点
    for (let i = 0; i < 10; i += 1) h.applyConveyor('CVA', { task: 101, movement_x: 1 });
    assert.ok(
      cargo.root.position.x < -1.0,
      `行走 1s 后货物须仍在进入端半区（期望 ≈${(-halfRange + 0.3).toFixed(2)}），实际 x=${cargo.root.position.x}`,
    );

    // 持续行走：偏移持续推进直到终点端停住
    for (let i = 0; i < 110; i += 1) h.applyConveyor('CVA', { task: 101, movement_x: 1 });
    assert.ok(
      Math.abs(cargo.root.position.x - halfRange) < 1e-6,
      `货物必须最终停在终点端 +${halfRange}，实际 x=${cargo.root.position.x}`,
    );
  } finally {
    h.dispose();
  }
});

test('go_column 非 0 时优先于当前列驱动行走：动画连续滑向目标列，为 0 时不再驱动', () => {
  const h = makeHarness();
  try {
    // 当前列 front_y=2 未绑定任何实体（当前列驱动解析失败），go_column=5 下发目标列：
    // 车体必须立即以列 5（对齐位 z=-4）为目标连续移动，不等当前列跳变
    const FRAME = { front_y: 2, back_y: 0, front_command: 0, back_command: 0, front_movement_z: 0, back_movement_z: 0, go_column: 5 };
    h.applyRgv(FRAME, 0.1);
    assert.equal(h.models.RGV1.rgvTelemetry.travelTargetColumn, 5, 'go_column 非 0 必须作为行走目标列');
    const z1 = h.models.RGV1.rgvTelemetry.rootPosition!.z;
    assert.ok(z1 < 0 && z1 > -4, `go_column 驱动必须立即连续移动，实际 z=${z1}`);

    // 持续上报（当前列始终未跟上）：最终收敛到列 5 对齐位
    for (let i = 0; i < 60; i += 1) h.applyRgv(FRAME, 0.1);
    const zFinal = h.models.RGV1.rgvTelemetry.rootPosition!.z;
    assert.ok(Math.abs(zFinal + 4) < 1e-6, `必须收敛到列 5 对齐位 z=-4，实际 ${zFinal}`);
    assert.equal(h.models.RGV1.rgvTelemetry.travelTargetPosition, null, '到位后行走目标必须消费清空');

    // go_column 为 0（任务完结）：回退当前列驱动（front_y=2 无绑定解析失败），车保持原位
    h.applyRgv({ ...FRAME, go_column: 0 }, 0.1);
    assert.ok(
      Math.abs(h.models.RGV1.rgvTelemetry.rootPosition!.z + 4) < 1e-6,
      'go_column 为 0 且当前列未跟上时必须保持原位',
    );
  } finally {
    h.dispose();
  }
});
