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
  createSpecializedTelemetrySharedState,
  type GeneratedCargoRuntimeEntry,
} from '../../src/runtime/babylon/telemetry/specialized/types';
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

  const makeModel = (assetCode: string, conveyorCapable: boolean): ModelRuntimeEntry => {
    const root = new TransformNode(`${assetCode}_root`, scene);
    const model = {
      assetCode,
      root,
      contentRoot: root,
      meshes: [],
      conveyorCapable,
      stackerCapable: false,
      rgvCapable: false,
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
  makeModel('CIN', true);
  makeModel('COUT', true);

  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [...models.values()].map((model) => ({ entityId: `e_${model.assetCode}`, model })),
    resolveCargoGeneratorForModel: () => null,
    syncGeneratedCargoVisual: () => undefined,
    setGeneratedCargoRootPose: (cargo: GeneratedCargoRuntimeEntry, position: Vector3, rotation: Quaternion) => {
      cargo.root.position.copyFrom(position);
      cargo.root.rotationQuaternion = rotation.clone();
    },
    disposeGeneratedCargo: () => undefined,
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
    // 镜像 facade deliverLiftCargoToConveyorLayer：仅查完全空闲（无视 task），先预检再拆引用
    deliverLiftCargoToConveyorLayer: (entityId: string, cargoKey: string, _preserveAxialPosition = false) => {
      const model = conveyorByEntity(entityId);
      if (!model) return false;
      const conveyorState = model.conveyorTelemetry;
      if (conveyorState.cargoCode !== null || conveyorState.pendingTask !== null || conveyorState.waitingTask !== null) {
        return false;
      }
      const cargo = liftDriver.detachClaimedCargoByKey(cargoKey);
      if (!cargo) return false;
      conveyorState.cargoCode = 'cargo';
      delivered.push(cargo);
      return true;
    },
    resolveConveyorDeckSurfacePoint: (entityId: string) => deckPoints[entityId]?.clone() ?? null,
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

    // 下一帧：step2 空 + step1 有货 → B rekey 到 step2，从 step1 锚点平移
    h.applyLift(outgoing);
    const back = h.liftModel.liftTelemetry.stations[1];
    assert.equal(back.cargoKey, JSON.stringify(['LIFT1', 1]), 'step1 货必须 rekey 到 step2');
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

test('work_state=3 接收方忙时滞留重试，work_state=5 补齐放货动画，接收方空闲后交付', () => {
  const h = makeHarness();
  try {
    const { a } = adoptTwoCargos(h);

    // 送料层到位（work_state=3），但 COUT 被占用：A 进入放货插值并滞留
    h.models.COUT.conveyorTelemetry.cargoCode = 'cargo';
    const outgoing = { reference_upper_step: 2, level_upper: 2, work_state: 3 };
    runUntil(h, outgoing, () => h.liftModel.liftTelemetry.arrivedTargetKey === '1:2');
    const back = h.liftModel.liftTelemetry.stations[1];
    assert.equal(h.delivered.length, 0, '接收方忙不得交付');
    assert.ok(back.transferActive && back.transferDirection === -1, '必须进入放货插值');
    const progressAfterArrival = back.transferProgress;

    runFrames(h, outgoing, 3);
    assert.ok(back.transferProgress < progressAfterArrival, '放货插值必须向输送线端推进');
    assert.equal(h.state.liftCargoMeshes.size, 2, '滞留期间货物不得销毁');

    // work_state=5：放货动画补齐到输送线端，接收方仍忙则继续滞留
    h.applyLift({ reference_upper_step: 2, level_upper: 2, work_state: 5 });
    assert.equal(back.transferProgress, 0, 'work_state=5 必须把放货进度推到输送线端');
    assert.equal(h.delivered.length, 0, '接收方忙仍不得交付');

    // 接收方空闲 + 回到 work_state=3：交付成功（A 先出，B 仍在 step1）
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

test('conveyor 仅查空闲预检：requireTaskMatch=false 无视 task 匹配但要求完全空闲', () => {
  const h = makeHarness();
  try {
    const cout = h.models.COUT;
    assert.equal(h.conveyorDriver.canAcceptRgvColumnPlacedCargo(cout, '', true), false, '空 task 走 task 匹配必须拒收');
    assert.equal(h.conveyorDriver.canAcceptRgvColumnPlacedCargo(cout, '', false), true, '完全空闲必须放行');

    cout.conveyorTelemetry.pendingTask = '777';
    assert.equal(h.conveyorDriver.canAcceptRgvColumnPlacedCargo(cout, '', false), false, '有挂单仲裁中不得放行');
    cout.conveyorTelemetry.pendingTask = null;
    cout.conveyorTelemetry.waitingTask = '777';
    assert.equal(h.conveyorDriver.canAcceptRgvColumnPlacedCargo(cout, '', false), false, '有等待仲裁中不得放行');
    cout.conveyorTelemetry.waitingTask = null;
    cout.conveyorTelemetry.cargoCode = 'cargo';
    assert.equal(h.conveyorDriver.canAcceptRgvColumnPlacedCargo(cout, '', false), false, '已有货不得放行');
  } finally {
    h.dispose();
  }
});
