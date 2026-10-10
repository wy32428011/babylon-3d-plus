import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshBuilder, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { ConveyorTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/conveyorDriver';
import { LiftTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/liftDriver';
import {
  createConveyorTelemetryState,
  createLiftTelemetryState,
} from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import {
  CONVEYOR_CARGO_SIZE,
  createSpecializedTelemetrySharedState,
  type GeneratedCargoRuntimeEntry,
} from '../../src/runtime/babylon/telemetry/specialized/types';
import { resolveConveyorCargoTravelHalfRange } from '../../src/runtime/babylon/telemetry/conveyorCargoTravel';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

/**
 * lift 双工位 + work_state 状态机测试布局：
 * LIFT1 在原点，载货面为 1×0.1×0.6 的 box（顶面基线 y=0.05，沿 x 跨度 1m → 工位锚点偏移 ±0.25）。
 * 来料 conveyor CIN（e_CIN）支撑点在 x=-2，送料 conveyor COUT（e_COUT）支撑点在 x=+2，
 * 轨迹轴自动推断为 +x（来料→送料）：step1（stations[0]，前）锚点 x=-0.25，step2（stations[1]，后）锚点 x=+0.25。
 * 层绑定：来料层 1（默认支撑面 y=0.05 → 目标偏移 0），送料层 2（y=2.05 → 目标偏移 2.0）。
 */
const DECK_TOP_BASE_Y = 0.05;
const STATION_OFFSET = 0.25;

function makeLiftSnapshot(
  fields: Record<string, unknown>,
  receivedAt: number = Date.now(),
): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'lift',
    assetCode: 'LIFT1',
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

type HarnessOptions = {
  /** 来料层支撑面世界 Y（默认 0.05 → 目标偏移 0）。 */
  incomingSurfaceY?: number;
  /** 送料层支撑面世界 Y（默认 2.05 → 目标偏移 2.0）。 */
  outgoingSurfaceY?: number;
  /** 覆盖 lift 模型脚本 dataDriven 声明。 */
  dataDriven?: Record<string, unknown>;
};

/** harness：LIFT1 + 来料/送料两台 conveyor 共享货物表，context 镜像 facade 的接管/交付实现。 */
function makeHarness(options: HarnessOptions = {}) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const models = new Map<string, ModelRuntimeEntry>();
  const logs: string[] = [];
  const delivered: GeneratedCargoRuntimeEntry[] = [];

  const incomingSurface = new Vector3(-2, options.incomingSurfaceY ?? DECK_TOP_BASE_Y, 0);
  const outgoingSurface = new Vector3(2, options.outgoingSurfaceY ?? 2.05, 0);
  const deckPoints: Record<string, Vector3> = { e_CIN: incomingSurface, e_COUT: outgoingSurface };

  const makeModel = (assetCode: string, conveyorCapable: boolean, position?: Vector3): ModelRuntimeEntry => {
    const root = new TransformNode(`${assetCode}_root`, scene);
    if (position) root.position.copyFrom(position);
    const model = {
      assetCode,
      root,
      contentRoot: root,
      meshes: [],
      conveyorCapable,
      stackerCapable: false,
      rgvCapable: false,
      liftCapable: assetCode === 'LIFT1',
      conveyorTelemetry: createConveyorTelemetryState(),
      liftTelemetry: createLiftTelemetryState(root),
      telemetryBinding: null,
      externalScriptRuntime: null,
      entitySnapshot: { id: `e_${assetCode}`, components: {} },
    } as unknown as ModelRuntimeEntry;
    models.set(assetCode, model);
    return model;
  };

  const liftModel = makeModel('LIFT1', false);
  const deck = MeshBuilder.CreateBox('lift_deck', { width: 1, height: 0.1, depth: 0.6 }, scene);
  deck.parent = liftModel.root;
  const dataDriven = options.dataDriven ?? {
    motion: { lift: { nodes: ['lift_deck'], speed: 1 } },
    cargo: { nodes: ['lift_deck'] },
  };
  (liftModel as { externalScriptRuntime: unknown }).externalScriptRuntime = {
    getDataDrivenConfigs: () => [dataDriven],
  };
  liftModel.telemetryBinding = {
    incomingLayerBindings: { '1': ['e_CIN'] },
    outgoingLayerBindings: { '2': ['e_COUT'] },
  } as unknown as ModelRuntimeEntry['telemetryBinding'];
  // COUT 摆位 (2,0,0)：入口探测点 x = 2 - (1.64+0.72) = -0.36 落在 LIFT1 包围盒内（订阅波触达 lift 的几何前提）；
  // CIN 摆位 (-4,0,0) 远离探测点，不干扰邻居判定。
  makeModel('CIN', true, new Vector3(-4, 0, 0));
  makeModel('COUT', true, new Vector3(2, 0, 0));

  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [...models.values()].map((model) => ({ entityId: `e_${model.assetCode}`, model })),
    findLocatorByDevice: () => null,
    findLocatorsByDevice: () => [],
    findBuiltInSlotLocatorForHostModel: () => null,
    resolveCargoGeneratorForModel: () => null,
    getGeneratedCargoFallbackSpec: () => ({ size: Vector3.One(), color: '#fff', emissiveColor: '#000' }),
    ensureGeneratedCargoFallback: () => undefined,
    ensureGeneratedCargoOutputOwner: () => null,
    syncGeneratedCargoVisual: () => undefined,
    setGeneratedCargoRootPose: (cargo: GeneratedCargoRuntimeEntry, position: Vector3, rotation: Quaternion) => {
      cargo.root.position.copyFrom(position);
      cargo.root.rotationQuaternion = rotation.clone();
    },
    disposeGeneratedCargo: () => undefined,
    // 世界包围盒：lift 含探测点（COUT 入口探测点 (-0.36,1,0) 必须落在 lift 盒内订阅波才触达）；
    // conveyor 按 root ± (2,1,0.5)（x 跨度 4m → 行程半径 1.64，探测偏移 2.36）。
    getModelWorldBounds: (model: ModelRuntimeEntry) => {
      if (model.assetCode === 'LIFT1') {
        return { minimum: new Vector3(-1, 0, -0.5), maximum: new Vector3(1, 2.2, 0.5) };
      }
      return {
        minimum: model.root.position.add(new Vector3(-2, -1, -0.5)),
        maximum: model.root.position.add(new Vector3(2, 1, 0.5)),
      };
    },
  };

  let liftDriver!: LiftTelemetryDriver;
  const conveyorByEntity = (entityId: string) => models.get(entityId.replace(/^e_/, '')) ?? null;
  const context = {
    scene,
    state,
    host,
    // 镜像 facade adoptConveyorCargoForLift：无视 task 接管该 conveyor 当前持货
    adoptConveyorCargoForLift: (entityId: string, _liftAssetCode: string) => {
      const model = conveyorByEntity(entityId);
      if (!model || model.conveyorTelemetry.cargoCode === null) return null;
      const key = JSON.stringify([model.assetCode, 'cargo']);
      const cargo = state.conveyorCargoMeshes.get(key) ?? null;
      if (!cargo) return null;
      state.conveyorCargoMeshes.delete(key);
      model.conveyorTelemetry.cargoCode = null;
      return cargo;
    },
    // 镜像 facade deliverLiftCargoToConveyorLayer：仅查无货（等待中的 task 不挡交付），交付瞬间改标接收方 task；
    // 同时镜像 settleCargoTransfer 的入表与走行初始化（进入端落地 + 自驱登记），保证交付后 conveyor 可真实走行。
    deliverLiftCargoToConveyorLayer: (entityId: string, cargoKey: string, _preserveAxialPosition = false) => {
      const model = conveyorByEntity(entityId);
      if (!model) return false;
      const conveyorState = model.conveyorTelemetry;
      if (conveyorState.cargoCode !== null) return false;
      const cargo = liftDriver.detachClaimedCargoByKey(cargoKey);
      if (!cargo) return false;
      cargo.task = conveyorState.pendingTask ?? conveyorState.waitingTask ?? '';
      cargo.assetCode = model.assetCode;
      conveyorState.pendingTask = null;
      conveyorState.waitingTask = null;
      conveyorState.cargoCode = 'cargo';
      conveyorState.cargoTravelOffset = -resolveConveyorCargoTravelHalfRange(4, CONVEYOR_CARGO_SIZE.x);
      conveyorState.selfDriveDirection = 1;
      state.conveyorCargoMeshes.set(JSON.stringify([model.assetCode, 'cargo']), cargo);
      delivered.push(cargo);
      return true;
    },
    resolveConveyorDeckSurfacePoint: (entityId: string) => deckPoints[entityId]?.clone() ?? null,
    // 镜像 facade detachClaimedCargoByReference：lift 货物走 detachClaimedCargoByKey 同步清工位引用
    detachClaimedCargoByReference: (cargo: GeneratedCargoRuntimeEntry) => {
      for (const [key, entry] of state.conveyorCargoMeshes.entries()) {
        if (entry === cargo) {
          state.conveyorCargoMeshes.delete(key);
          return cargo;
        }
      }
      for (const [key, entry] of state.liftCargoMeshes.entries()) {
        if (entry === cargo) return liftDriver.detachClaimedCargoByKey(key);
      }
      return null;
    },
    isRgvCargoReadyForExternalPull: () => false,
    isLiftCargoReadyForExternalPull: (cargo: GeneratedCargoRuntimeEntry) => liftDriver.isLiftCargoReadyForExternalPull(cargo),
    isStackerCargoPendingPlatformHandoff: () => false,
  };
  liftDriver = new LiftTelemetryDriver(context as never);
  const conveyorDriver = new ConveyorTelemetryDriver(context as never);

  return {
    state,
    logs,
    delivered,
    liftModel,
    liftDriver,
    conveyorDriver,
    models: Object.fromEntries(models) as Record<string, ModelRuntimeEntry>,
    dispose: () => { scene.dispose(); engine.dispose(); },
    applyLift: (fields: Record<string, unknown>, deltaSeconds = 0.1) => {
      liftDriver.applyToModel(liftModel, makeLiftSnapshot(fields), deltaSeconds);
    },
    /** 驱动指定 conveyor 一帧（镜像 facade 对每台设备应用快照）。 */
    applyConveyor: (assetCode: string, fields: Record<string, unknown>, deltaSeconds = 0.1) => {
      conveyorDriver.applyToModel(models.get(assetCode)!, makeConveyorSnapshot(assetCode, fields), deltaSeconds);
    },
    /** 镜像 facade 帧尾：外部持货拉取扫描。 */
    pullExternal: () => {
      conveyorDriver.pullExternalHolderCargo();
    },
    /** 向 conveyor 货物表插入持有货物并置遥测引用（模拟输送线已持有的货箱），货箱落在其支撑点上。 */
    insertConveyorCargo: (assetCode: string, task: string) => {
      const root = new TransformNode(`${assetCode}_cargo_root`, scene);
      root.position.copyFrom(deckPoints[`e_${assetCode}`] ?? Vector3.Zero());
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

type Harness = ReturnType<typeof makeHarness>;

function runFrames(h: Harness, fields: Record<string, unknown>, count: number): void {
  for (let i = 0; i < count; i += 1) h.applyLift(fields);
}

function runUntil(h: Harness, fields: Record<string, unknown>, condition: () => boolean, maxFrames = 60): void {
  for (let i = 0; i < maxFrames && !condition(); i += 1) h.applyLift(fields);
  assert.ok(condition(), '条件必须在限定帧数内达成');
}

/** 兼容路径（无 work_state）把两箱先后收上台：A 进 step2（后），B 进 step1（前）。 */
function adoptTwoCargos(h: Harness): { a: GeneratedCargoRuntimeEntry; b: GeneratedCargoRuntimeEntry } {
  const incoming = { reference_upper_step: 1, level_upper: 1 };
  const a = h.insertConveyorCargo('CIN', '901');
  h.applyLift(incoming);
  assert.equal(h.liftModel.liftTelemetry.stations[1].cargoKey, JSON.stringify(['LIFT1', 1]), '先收的货必须进 step2（后工位）');
  runUntil(h, incoming, () => h.liftModel.liftTelemetry.stations[1].cargoOnBoard);

  const b = h.insertConveyorCargo('CIN', '902');
  h.applyLift(incoming);
  assert.equal(h.liftModel.liftTelemetry.stations[0].cargoKey, JSON.stringify(['LIFT1', 0]), '后收的货必须进 step1（前工位）');
  runUntil(h, incoming, () => h.liftModel.liftTelemetry.stations[0].cargoOnBoard);
  return { a, b };
}

test('兼容路径（无 work_state）双工位接收顺序：先收进 step2 后端，后收进 step1 前端，锚点前后错开', () => {
  const h = makeHarness();
  try {
    const { a, b } = adoptTwoCargos(h);

    assert.equal(h.state.liftCargoMeshes.size, 2);
    assert.ok(Math.abs(a.root.position.x - STATION_OFFSET) < 1e-6, `step2 锚点 x 应为 +${STATION_OFFSET}，实际 ${a.root.position.x}`);
    assert.ok(Math.abs(b.root.position.x + STATION_OFFSET) < 1e-6, `step1 锚点 x 应为 -${STATION_OFFSET}，实际 ${b.root.position.x}`);
    assert.ok(Math.abs(a.root.position.y - DECK_TOP_BASE_Y) < 1e-6, `货物须贴载货面顶面 y=${DECK_TOP_BASE_Y}，实际 ${a.root.position.y}`);
  } finally {
    h.dispose();
  }
});

test('双工位占满时来料层拒取：来料 conveyor 持货不被接管，下帧继续重试', () => {
  const h = makeHarness();
  try {
    adoptTwoCargos(h);
    h.insertConveyorCargo('CIN', '903');

    runFrames(h, { reference_upper_step: 1, level_upper: 1 }, 5);
    assert.equal(h.models.CIN.conveyorTelemetry.cargoCode, 'cargo', '双满时不得接管来料货物');
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '第三箱必须留在来料 conveyor');
    assert.equal(h.state.liftCargoMeshes.size, 2, 'lift 货物表不得超双工位上限');
  } finally {
    h.dispose();
  }
});

test('送料侧 step2 先出，step1 平移到后端锚点后再出', () => {
  const h = makeHarness();
  try {
    const { a, b } = adoptTwoCargos(h);

    // 向送料层 2 移动（目标偏移 2.0，速度 1m/s）：到位帧 step2 的 A 当场交付
    const outgoing = { reference_upper_step: 2, level_upper: 2 };
    runUntil(h, outgoing, () => h.liftModel.liftTelemetry.arrivedTargetKey === '1:2');
    assert.deepEqual(h.delivered, [a], '到位帧必须先交付 step2 的 A');
    assert.equal(h.liftModel.liftTelemetry.stations[1].cargoKey, null);
    h.models.COUT.conveyorTelemetry.cargoCode = null; // 模拟下游把 A 运走

    // 下一帧：step2 空 + step1 有货，但承接冷却（CARGO_HANDOFF_SECONDS）未结束 → B 不得立即平移，
    // 等离台的 A 在接收方侧承接平滑播完再启动，避免两货动画并发（视觉上 step1 先动）
    h.applyLift(outgoing);
    assert.equal(h.liftModel.liftTelemetry.stations[1].cargoKey, null, '承接冷却期内不得启动 step1→step2 平移');
    assert.equal(h.liftModel.liftTelemetry.stations[0].cargoKey, JSON.stringify(['LIFT1', 0]), 'B 必须仍在 step1');

    // 冷却结束后：B rekey 到 step2，从 step1 锚点平移
    runFrames(h, outgoing, 10);
    const back = h.liftModel.liftTelemetry.stations[1];
    assert.equal(back.cargoKey, JSON.stringify(['LIFT1', 1]), '冷却结束后 step1 货必须 rekey 到 step2');
    assert.equal(h.liftModel.liftTelemetry.stations[0].cargoKey, null, 'step1 必须已清空');
    assert.ok(back.transferActive && !back.cargoOnBoard, '平移插值必须进行中');

    // 平移途中：货物在两锚点之间、随台升到送料层高度
    runFrames(h, outgoing, 7);
    assert.ok(
      b.root.position.x > -STATION_OFFSET && b.root.position.x < STATION_OFFSET,
      `平移途中 x 须在 ±${STATION_OFFSET} 之间，实际 ${b.root.position.x}`,
    );
    assert.ok(Math.abs(b.root.position.y - 2.05) < 1e-6, `平移途中 y 须为送料层台面 2.05，实际 ${b.root.position.y}`);

    // 平移完成后交付 B
    runUntil(h, outgoing, () => h.delivered.length === 2);
    assert.deepEqual(h.delivered, [a, b], '交付顺序必须为 step2 先、step1 后');
    assert.equal(h.state.liftCargoMeshes.size, 0, '全部交付后 lift 货物表必须清空');
  } finally {
    h.dispose();
  }
});

test('work_state=1 未到位 4 倍速赶位，到位前不取货；0/6 只移动不交接，回到 1 才取货', () => {
  // 来料支撑面 y=1.05 → 目标偏移 1.0（速度 1m/s，正常 10 帧，4 倍速 2.5 帧）
  const h = makeHarness({ incomingSurfaceY: 1.05 });
  try {
    h.insertConveyorCargo('CIN', '901');
    const fields = { reference_upper_step: 1, level_upper: 1, work_state: 1 };

    h.applyLift(fields);
    assert.ok(
      Math.abs(h.liftModel.liftTelemetry.liftOffset - 0.4) < 1e-6,
      `work_state=1 未到位必须 4 倍速赶位（首帧 0.4），实际 ${h.liftModel.liftTelemetry.liftOffset}`,
    );
    assert.equal(h.liftModel.liftTelemetry.stations[1].cargoKey, null, '未到位不得取货');

    h.applyLift(fields);
    h.applyLift(fields);
    assert.equal(h.liftModel.liftTelemetry.arrivedTargetKey, '0:1', '3 帧（1.2m 行程）必须已到位');
    assert.equal(h.liftModel.liftTelemetry.stations[1].cargoKey, JSON.stringify(['LIFT1', 1]), '到位且 work_state=1 必须取货');

    // 换一个目标层（送料层 2）：work_state=0/6 只移动不交接
    const h2 = makeHarness();
    try {
      h2.insertConveyorCargo('CIN', '901');
      runFrames(h2, { reference_upper_step: 1, level_upper: 1, work_state: 0 }, 3);
      assert.equal(h2.liftModel.liftTelemetry.stations[1].cargoKey, null, 'work_state=0 到位也不得取货');
      runFrames(h2, { reference_upper_step: 1, level_upper: 1, work_state: 6 }, 2);
      assert.equal(h2.liftModel.liftTelemetry.stations[1].cargoKey, null, 'work_state=6 到位也不得取货');
      h2.applyLift({ reference_upper_step: 1, level_upper: 1, work_state: 1 });
      assert.equal(h2.liftModel.liftTelemetry.stations[1].cargoKey, JSON.stringify(['LIFT1', 1]), '回到 work_state=1 必须立即取货');
    } finally {
      h2.dispose();
    }
  } finally {
    h.dispose();
  }
});

test('work_state=2 补齐取货动画：取货插值直接推满上台', () => {
  const h = makeHarness();
  try {
    const cargo = h.insertConveyorCargo('CIN', '901');
    h.applyLift({ reference_upper_step: 1, level_upper: 1, work_state: 1 });
    const back = h.liftModel.liftTelemetry.stations[1];
    assert.ok(back.transferActive && back.transferProgress < 1, '取货插值必须进行中');

    h.applyLift({ reference_upper_step: 1, level_upper: 1, work_state: 2 });
    assert.equal(back.transferProgress, 1, 'work_state=2 必须把取货进度推满');
    assert.equal(back.cargoOnBoard, true, 'work_state=2 后货物必须在台上');
    assert.equal(back.transferActive, false);
    assert.ok(Math.abs(cargo.root.position.x - STATION_OFFSET) < 1e-6, '货物必须落在 step2 锚点');
  } finally {
    h.dispose();
  }
});

test('work_state=3 接收方忙时货留 step2 锚点原位等待（不预播送出动画），接收方空闲后交付', () => {
  const h = makeHarness();
  try {
    const { a } = adoptTwoCargos(h);

    // 送料层到位（work_state=3），但 COUT 被占用：A 滞留 step2 锚点原位，不进入任何送出插值
    h.models.COUT.conveyorTelemetry.cargoCode = 'cargo';
    const outgoing = { reference_upper_step: 2, level_upper: 2, work_state: 3 };
    runUntil(h, outgoing, () => h.liftModel.liftTelemetry.arrivedTargetKey === '1:2');
    const back = h.liftModel.liftTelemetry.stations[1];
    assert.equal(h.delivered.length, 0, '接收方忙不得交付');
    assert.equal(back.cargoOnBoard, true, '货必须留在 step2 锚点');
    assert.equal(back.transferActive, false, '接收方忙时不得启动送出插值（避免滑入输送线撞上在机货）');

    runFrames(h, outgoing, 5);
    assert.equal(h.delivered.length, 0, '接收方忙持续不得交付');
    assert.equal(h.state.liftCargoMeshes.size, 2, '滞留期间货物不得销毁');
    assert.ok(Math.abs(a.root.position.x - STATION_OFFSET) < 1e-6, '滞留期间货必须停在 step2 锚点原位');

    // work_state=5 同为卸货门控：接收方忙仍锚点等待
    runFrames(h, { reference_upper_step: 2, level_upper: 2, work_state: 5 }, 3);
    assert.equal(h.delivered.length, 0, '接收方忙仍不得交付');
    assert.equal(back.cargoOnBoard, true, 'work_state=5 下仍须留锚点等待');

    // 接收方空闲 + 回到 work_state=3：当帧交付（A 先出，B 仍在 step1——承接冷却期内不平移）
    h.models.COUT.conveyorTelemetry.cargoCode = null;
    h.applyLift(outgoing);
    assert.deepEqual(h.delivered, [a], '接收方空闲后必须交付 step2 的 A');
    assert.equal(h.liftModel.liftTelemetry.stations[0].cargoKey, JSON.stringify(['LIFT1', 0]), 'step1 的 B 不受影响');
  } finally {
    h.dispose();
  }
});

test('work_state=10 急停冻结：不移动不交接，恢复后继续', () => {
  const h = makeHarness();
  try {
    const outgoing = { reference_upper_step: 2, level_upper: 2, work_state: 6 };
    runFrames(h, outgoing, 2);
    const offsetBeforeStop = h.liftModel.liftTelemetry.liftOffset;
    assert.ok(offsetBeforeStop > 0 && offsetBeforeStop < 2, '急停前必须处于移动途中');

    runFrames(h, { reference_upper_step: 2, level_upper: 2, work_state: 10 }, 5);
    assert.equal(h.liftModel.liftTelemetry.liftOffset, offsetBeforeStop, '急停必须冻结升降');
    assert.equal(h.liftModel.liftTelemetry.arrivedTargetKey, null, '急停期间不得锁到位');

    runUntil(h, outgoing, () => h.liftModel.liftTelemetry.arrivedTargetKey === '1:2');
    assert.ok(Math.abs(h.liftModel.liftTelemetry.liftOffset - 2) < 1e-6, '恢复后必须继续移动到目标层');
  } finally {
    h.dispose();
  }
});

test('task_num_fin_first_up/second_up 仅标注对应工位 cargo.task：变化才写，字段缺失不清除', () => {
  const h = makeHarness();
  try {
    const { a, b } = adoptTwoCargos(h);
    assert.equal(a.task, '901');
    assert.equal(b.task, '902');

    const incoming = { reference_upper_step: 1, level_upper: 1 };
    h.applyLift({ ...incoming, task_num_fin_first_up: 111, task_num_fin_second_up: 222 });
    assert.equal(b.task, '111', 'first_up 必须标注 step1 货物');
    assert.equal(a.task, '222', 'second_up 必须标注 step2 货物');

    h.applyLift({ ...incoming, task_num_fin_first_up: 0 });
    assert.equal(b.task, '', 'task 号 0 必须归一化为匿名');
    assert.equal(a.task, '222', '字段缺失不得清除既有标注');

    h.applyLift(incoming);
    assert.equal(a.task, '222', '缺字段帧不得改动既有标注');
  } finally {
    h.dispose();
  }
});

test('目标层不在绑定表：不响应不移动，一次性 Console 告警', () => {
  const h = makeHarness();
  try {
    runFrames(h, { reference_upper_step: 1, level_upper: 9, work_state: 1 }, 5);
    assert.equal(h.liftModel.liftTelemetry.liftOffset, 0, '未绑定层不得移动');
    assert.equal(h.liftModel.liftTelemetry.targetKey, null, '未绑定层不得记录目标');
    const unboundLogs = h.logs.filter((message) => message.includes('未绑定'));
    assert.equal(unboundLogs.length, 1, '未绑定告警必须只报一次');
    assert.ok(unboundLogs[0].includes('不响应不移动'), '告警必须说明不响应不移动');
  } finally {
    h.dispose();
  }
});

test('dataDriven.motion.lift.travelAxis 覆盖轨迹轴：工位锚点沿声明轴错开', () => {
  const h = makeHarness({
    dataDriven: {
      motion: { lift: { nodes: ['lift_deck'], speed: 1, travelAxis: 'z' } },
      cargo: { nodes: ['lift_deck'] },
    },
  });
  try {
    // 载货面沿 z 跨度 0.6 → 工位偏移 ±0.15；覆盖后不再按绑定推断的 x 轴分区
    const cargo = h.insertConveyorCargo('CIN', '901');
    const incoming = { reference_upper_step: 1, level_upper: 1 };
    h.applyLift(incoming);
    runUntil(h, incoming, () => h.liftModel.liftTelemetry.stations[1].cargoOnBoard);
    assert.ok(Math.abs(cargo.root.position.z - 0.15) < 1e-6, `step2 锚点 z 应为 +0.15，实际 ${cargo.root.position.z}`);
    assert.ok(Math.abs(cargo.root.position.x) < 1e-6, `覆盖 z 轴后 x 不得错开，实际 ${cargo.root.position.x}`);
  } finally {
    h.dispose();
  }
});

test('conveyor 仅查无货预检：requireTaskMatch=false 时等待中的 task 不挡交付', () => {
  const h = makeHarness();
  try {
    const cout = h.models.COUT;
    assert.equal(h.conveyorDriver.canAcceptRgvColumnPlacedCargo(cout, '', true), false, '空 task 走 task 匹配必须拒收');
    assert.equal(h.conveyorDriver.canAcceptRgvColumnPlacedCargo(cout, '', false), true, '无货必须放行');

    cout.conveyorTelemetry.pendingTask = '777';
    assert.equal(h.conveyorDriver.canAcceptRgvColumnPlacedCargo(cout, '', false), true, '挂单等待中不得挡交付');
    cout.conveyorTelemetry.pendingTask = null;
    cout.conveyorTelemetry.waitingTask = '777';
    assert.equal(h.conveyorDriver.canAcceptRgvColumnPlacedCargo(cout, '', false), true, '订阅等待中不得挡交付');
    cout.conveyorTelemetry.waitingTask = null;
    cout.conveyorTelemetry.cargoCode = 'cargo';
    assert.equal(h.conveyorDriver.canAcceptRgvColumnPlacedCargo(cout, '', false), false, '已有货不得放行');
  } finally {
    h.dispose();
  }
});

test('work_state=2（取货完成）同为取货门控：到位即取货并补齐动画上台', () => {
  const h = makeHarness();
  try {
    h.insertConveyorCargo('CIN', '901');
    h.applyLift({ reference_upper_step: 1, level_upper: 1, work_state: 2 });
    const back = h.liftModel.liftTelemetry.stations[1];
    assert.equal(back.cargoKey, JSON.stringify(['LIFT1', 1]), 'work_state=2 必须允许取货');
    assert.equal(back.cargoOnBoard, true, '取货完成信号下同帧补齐上台');
    assert.equal(back.transferActive, false);
  } finally {
    h.dispose();
  }
});

test('work_state=5（卸货完成）同为卸货门控：到位即交付，不等 doing；接收方等待 task 时改标接收方 task', () => {
  const h = makeHarness();
  try {
    const { a } = adoptTwoCargos(h);

    // 接收方先到 task 开始等待：不得挡交付
    h.models.COUT.conveyorTelemetry.pendingTask = '777';
    h.models.COUT.conveyorTelemetry.waitingTask = '777';

    // 从未 doing：全程 work_state=5，到位帧即交付 step2 的 A
    const outgoing = { reference_upper_step: 2, level_upper: 2, work_state: 5 };
    runUntil(h, outgoing, () => h.liftModel.liftTelemetry.arrivedTargetKey === '1:2');
    assert.deepEqual(h.delivered, [a], 'work_state=5 到位必须立即交付');
    assert.equal(a.task, '777', '交付必须改标接收方等待的 task 接入仲裁链');
    assert.equal(h.models.COUT.conveyorTelemetry.pendingTask, null, '交付后清接收方挂单');
    assert.equal(h.liftModel.liftTelemetry.stations[1].cargoKey, null);
  } finally {
    h.dispose();
  }
});

/** COUT 轨迹终点世界 x：root(2,0,0) + 行程半径（span 4m、内置货箱 x 长 0.72）。 */
const COUT_TRAVEL_END_X = 2 + resolveConveyorCargoTravelHalfRange(4, CONVEYOR_CARGO_SIZE.x);

/** 驱动 COUT 走行直到货物抵达轨迹终点（字段驱动 movement_x=1）。 */
function runConveyorToEnd(h: Harness, cargo: GeneratedCargoRuntimeEntry): void {
  for (let i = 0; i < 300 && cargo.root.position.x < COUT_TRAVEL_END_X - 1e-3; i += 1) {
    h.applyConveyor('COUT', { task: cargo.task === '' ? 0 : Number(cargo.task), movement_x: 1 });
  }
  assert.ok(
    Math.abs(cargo.root.position.x - COUT_TRAVEL_END_X) < 0.05,
    `货物必须走到轨迹终点 x=${COUT_TRAVEL_END_X}，实际 ${cargo.root.position.x}`,
  );
}

/** 模拟 COUT 把货物交给更下游：出表并清持货引用。 */
function ejectConveyorCargo(h: Harness): void {
  h.state.conveyorCargoMeshes.delete(JSON.stringify(['COUT', 'cargo']));
  h.models.COUT.conveyorTelemetry.cargoCode = null;
}

test('输送线先取（订阅波 pull）：探测登记触达 lift，step2 货被拉走走到轨迹终点，step1 货排队接续交付', () => {
  const h = makeHarness();
  try {
    const { a, b } = adoptTwoCargos(h);

    // ws=6 升送料层（只移动不交接），到位后标注 step2 的 A 为 task 12
    const lifting = { reference_upper_step: 2, level_upper: 2, work_state: 6 };
    runUntil(h, lifting, () => h.liftModel.liftTelemetry.arrivedTargetKey === '1:2');
    assert.equal(h.delivered.length, 0, 'work_state=6 不得交接');
    h.applyLift({ ...lifting, task_num_fin_second_up: 12 });
    assert.equal(a.task, '12');

    // COUT 接到 task 12：订阅波入口探测邻居为 lift → 登记 externalPulls（探测过滤必须含 lift）
    h.applyConveyor('COUT', { task: 12 });
    const cout = h.models.COUT.conveyorTelemetry;
    assert.equal(cout.waitingTask, '12');
    const pull = cout.externalPulls.get('COUT');
    assert.ok(pull, '订阅波必须在 COUT 登记 lift 外部拉取');
    assert.equal(pull.holderAssetCode, 'LIFT1', '外部持货方必须是 LIFT1');

    // 帧尾 pull：A（step2）被拉走交付 COUT，工位引用同步清理，B 滞留 step1 不动（ws=6 不交接）
    h.pullExternal();
    assert.equal(h.state.liftCargoMeshes.size, 1, 'A 必须离开 lift 货物表');
    assert.equal(h.liftModel.liftTelemetry.stations[1].cargoKey, null, 'step2 工位引用必须清理');
    assert.equal(h.liftModel.liftTelemetry.stations[0].cargoKey, JSON.stringify(['LIFT1', 0]), 'B 必须仍在 step1');
    assert.equal(cout.cargoCode, 'cargo', 'COUT 必须持货');
    assert.equal(a.assetCode, 'COUT', 'A 必须换绑 COUT');
    assert.equal(cout.externalPulls.size, 0, '拉取后登记必须摘除');
    h.applyLift(lifting);
    assert.equal(h.liftModel.liftTelemetry.stations[1].cargoKey, null, 'ws=6 不得触发 step1 平移');

    // COUT 接手走行：A 走到轨迹终点
    runConveyorToEnd(h, a);

    // ws=3：承接冷却（A 被拉走时触发）期内 B 不得启动平移；冷却随帧消退后 B 平移到 step2，
    // COUT 仍占货 → B 在 step2 锚点原位等待（不丢货不悬空不预滑）
    const delivering = { reference_upper_step: 2, level_upper: 2, work_state: 3 };
    h.applyLift(delivering);
    assert.equal(h.liftModel.liftTelemetry.stations[1].cargoKey, null, '承接冷却期内不得启动 step1→step2 平移');
    runFrames(h, lifting, 10);
    h.applyLift(delivering);
    assert.equal(h.liftModel.liftTelemetry.stations[1].cargoKey, JSON.stringify(['LIFT1', 1]), '冷却结束后 ws=3 必须触发 B 平移到 step2');
    runUntil(h, delivering, () => h.liftModel.liftTelemetry.stations[1].cargoOnBoard);
    assert.equal(h.liftModel.liftTelemetry.stations[1].transferActive, false, '接收方忙时不得启动送出插值');
    assert.equal(h.delivered.length, 0, 'COUT 占用期间 B 不得交付');
    assert.equal(h.state.liftCargoMeshes.size, 1, 'B 滞留期间不得销毁');

    // A 被下游取走 → B 交付成功：排队离开提升机，顺序保持 A 先 B 后
    ejectConveyorCargo(h);
    runUntil(h, delivering, () => h.delivered.length === 1);
    assert.deepEqual(h.delivered, [b], 'A 被拉走后 B 必须接续交付');
    assert.equal(h.state.liftCargoMeshes.size, 0, '全部离开后 lift 货物表必须清空');
  } finally {
    h.dispose();
  }
});

test('提升机先给 + 输送线后接 task：匿名交付滞留，新 task 复用盖戳走到轨迹终点，step1 货接续交付', () => {
  const h = makeHarness();
  try {
    const { a, b } = adoptTwoCargos(h);

    // ws=5 升送料层：到位帧 step2 的 A 当场匿名交付给无 task 的 COUT
    const delivering = { reference_upper_step: 2, level_upper: 2, work_state: 5 };
    runUntil(h, delivering, () => h.delivered.length === 1);
    assert.deepEqual(h.delivered, [a]);
    assert.equal(a.task, '', '接收方无 task 时必须匿名交付');
    assert.equal(h.models.COUT.conveyorTelemetry.cargoCode, 'cargo');

    // COUT 后接到 task 12：滞留箱复用盖戳（lift 上 B task=902 ≠ 12，不触发销毁等传递分支）
    h.applyConveyor('COUT', { task: 12 });
    assert.equal(a.task, '12', '滞留箱必须复用盖新 task');
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '复用不得新建货箱');
    assert.equal(h.models.COUT.conveyorTelemetry.waitingTask, null, '已有货不得转入等待');

    // A 走到轨迹终点
    runConveyorToEnd(h, a);

    // A 被下游取走 → B 平移到 step2 并交付：排队顺序 A 先 B 后
    ejectConveyorCargo(h);
    runUntil(h, delivering, () => h.delivered.length === 2);
    assert.deepEqual(h.delivered, [a, b], '交付顺序必须 step2 先、step1 后');
    assert.equal(h.state.liftCargoMeshes.size, 0);
  } finally {
    h.dispose();
  }
});

test('回归：lift 持同 task 标注在途货不触发规则三销毁——先交付的匿名滞留货必须复用盖戳', () => {
  const h = makeHarness();
  try {
    const { a, b } = adoptTwoCargos(h);

    // ws=5 升送料层：step2 的 A 当场匿名交付给无 task 的 COUT（交付早于接收方 task 边沿）
    const delivering = { reference_upper_step: 2, level_upper: 2, work_state: 5 };
    runUntil(h, delivering, () => h.delivered.length === 1);
    assert.equal(a.task, '');
    assert.equal(h.models.COUT.conveyorTelemetry.cargoCode, 'cargo');

    // lift 滞留的 B 被 task_num_fin 标注为 12（实测数据：step1 货 rekey 到 step2 后被 task_num_fin_second_up 改写）
    h.applyLift({ ...delivering, task_num_fin_first_up: 12 });
    assert.equal(b.task, '12');

    // COUT 后接到 task 12：上游探测命中 lift 的同 task 标注货也不得销毁 A，必须复用盖戳
    h.applyConveyor('COUT', { task: 12 });
    assert.equal(h.models.COUT.conveyorTelemetry.cargoCode, 'cargo', 'lift 持同 task 标注货不得触发规则三销毁在机货');
    assert.equal(a.task, '12', '滞留箱必须复用盖新 task');
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '不得销毁或新建货箱');
    assert.ok(h.state.liftCargoMeshes.size > 0, 'lift 上的 B 必须保持原状');

    // A 走到轨迹终点 → 被下游取走 → B 接续交付：实物排队顺序不丢
    runConveyorToEnd(h, a);
    ejectConveyorCargo(h);
    runUntil(h, delivering, () => h.delivered.length === 2);
    assert.deepEqual(h.delivered, [a, b], '交付顺序必须 step2 先、step1 后');
  } finally {
    h.dispose();
  }
});

test('pull 排队门控：step2 占用时 step1 货不可被外部拉取，step2 先出顺序不被破坏', () => {
  const h = makeHarness();
  try {
    const { a, b } = adoptTwoCargos(h);
    const lifting = { reference_upper_step: 2, level_upper: 2, work_state: 6 };
    runUntil(h, lifting, () => h.liftModel.liftTelemetry.arrivedTargetKey === '1:2');

    assert.equal(h.liftDriver.isLiftCargoReadyForExternalPull(a), true, 'step2 货到位在台必须可拉');
    assert.equal(h.liftDriver.isLiftCargoReadyForExternalPull(b), false, 'step2 占用时 step1 货必须拒拉');

    // A 被拉走后 B 平移到 step2 锚点、台静止（ws=6 不启动放货）时才恢复可拉
    h.liftDriver.detachClaimedCargoByKey(JSON.stringify(['LIFT1', 1]));
    assert.equal(h.liftDriver.isLiftCargoReadyForExternalPull(b), true, 'step2 清空后 step1 货必须恢复可拉');
  } finally {
    h.dispose();
  }
});
