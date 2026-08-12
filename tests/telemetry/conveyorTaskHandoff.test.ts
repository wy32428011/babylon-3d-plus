import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { ConveyorTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/conveyorDriver';
import { createConveyorTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import {
  CARGO_HANDOFF_SECONDS,
  CONVEYOR_CARGO_SIZE,
  createSpecializedTelemetrySharedState,
  type ConveyorCargoRuntimeEntry,
} from '../../src/runtime/babylon/telemetry/specialized/types';
import { resolveConveyorCargoTravelHalfRange } from '../../src/runtime/babylon/telemetry/conveyorCargoTravel';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

/**
 * 输送线链路流转协议测试的几何约定（与 harness bounds 对齐）：
 * 行走轴为局部 x（空 motion 配置缺省），货箱轴向长度 0.72，各设备跨度 4m → 行程半径 1.64。
 * 探测点 = 轨迹端点向外延伸一个货箱长度 → 距中心 1.64 + 0.72 = 2.36；布局中心距 4m 时恰好落入邻机包围盒。
 */
const SPAN_HALF = 2;
const CARGO_AXIAL = CONVEYOR_CARGO_SIZE.x;
const HALF_RANGE = resolveConveyorCargoTravelHalfRange(SPAN_HALF * 2, CARGO_AXIAL);
/** 空 motion 配置时的缺省走行速度（m/s），与 CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND 对齐。 */
const CARGO_SPEED = 0.3;

function makeSnapshot(
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

type HarnessDeviceConfig = {
  centerX: number;
  autoDispose?: boolean;
  /** 起点设备：探测点无上游时允许自行创建货箱（telemetryBinding.cargoOriginDevice）。 */
  origin?: boolean;
  /** stacker 能力模型：仅作为探测点邻居/货物持有方存在，不应用输送线驱动。 */
  stacker?: boolean;
  /** 世界包围盒 x 方向半径（缺省 2m，span 4m）。 */
  halfSpanX?: number;
  /** 模型本地绕 Y 轴旋转（弧度）：验证 trajectoryDirection 的模型本地坐标语义。 */
  rotationY?: number;
  /** telemetryBinding.trajectoryDirection（x/-x/z/-z，模型本地坐标）。 */
  trajectoryDirection?: string;
};

/** 多设备 harness：共享货物表与 collectModels 视图，帧函数镜像 facade（applyToModel 后执行帧尾外部拉取扫描）。 */
function makeHarness(layout: Record<string, HarnessDeviceConfig>) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const models = new Map<string, ModelRuntimeEntry>();
  const logs: string[] = [];

  for (const [assetCode, config] of Object.entries(layout)) {
    const root = new TransformNode(`${assetCode}_root`, scene);
    if (config.rotationY !== undefined) root.rotation.y = config.rotationY;
    const binding: Record<string, unknown> = {};
    if (config.autoDispose !== undefined) binding.cargoAutoDispose = config.autoDispose;
    if (config.origin !== undefined) binding.cargoOriginDevice = config.origin;
    if (config.trajectoryDirection !== undefined) binding.trajectoryDirection = config.trajectoryDirection;
    const model = {
      assetCode,
      root,
      contentRoot: root,
      meshes: [],
      conveyorCapable: !config.stacker,
      stackerCapable: !!config.stacker,
      conveyorTelemetry: createConveyorTelemetryState(),
      telemetryBinding: Object.keys(binding).length > 0 ? binding : null,
      externalScriptRuntime: null,
    } as unknown as ModelRuntimeEntry;
    models.set(assetCode, model);
  }

  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [...models.values()].map((model) => ({ entityId: `e_${model.assetCode}`, model })),
    findLocatorByDevice: () => null,
    findLocatorByDeviceAnyRow: () => null,
    findLocatorsByDevice: () => [],
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
    setGeneratedCargoRootPose: (cargo: ConveyorCargoRuntimeEntry, position: Vector3) => {
      cargo.root.position.copyFrom(position);
    },
    disposeGeneratedCargo: () => undefined,
    getModelWorldBounds: (model: ModelRuntimeEntry) => {
      const config = layout[model.assetCode];
      const centerX = config?.centerX ?? 0;
      const halfSpanX = config?.halfSpanX ?? SPAN_HALF;
      return {
        minimum: new Vector3(centerX - halfSpanX, 0, -0.5),
        maximum: new Vector3(centerX + halfSpanX, 1, 0.5),
      };
    },
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
    // 镜像 SpecializedTelemetryRuntime.detachClaimedCargoByReference：按引用从三张表摘除并清理遥测引用
    detachClaimedCargoByReference: (cargo: ConveyorCargoRuntimeEntry) => {
      const tables = [state.stackerCargoMeshes, state.conveyorCargoMeshes, state.rgvCargoMeshes];
      for (const table of tables) {
        for (const [key, entry] of [...table]) {
          if (entry !== (cargo as unknown)) continue;
          for (const model of models.values()) {
            const telemetry = model.conveyorTelemetry;
            if (telemetry?.cargoCode !== null && telemetry?.cargoCode !== undefined
              && JSON.stringify([model.assetCode, telemetry.cargoCode]) === key) {
              telemetry.cargoCode = null;
            }
            const stackerTelemetry = (model as { stackerTelemetry?: { frontCargoKey: string | null; backCargoKey: string | null } }).stackerTelemetry;
            if (stackerTelemetry) {
              if (stackerTelemetry.frontCargoKey === key) stackerTelemetry.frontCargoKey = null;
              if (stackerTelemetry.backCargoKey === key) stackerTelemetry.backCargoKey = null;
            }
          }
          table.delete(key);
          return entry;
        }
      }
      return null;
    },
  };
  const driver = new ConveyorTelemetryDriver(context as never);

  return {
    driver,
    state,
    logs,
    models: Object.fromEntries(models),
    dispose: () => { scene.dispose(); engine.dispose(); },
    /** 镜像 facade 帧调度：应用快照后执行帧尾外部持货拉取扫描（与快照新旧无关）。 */
    apply: (assetCode: string, fields: Record<string, unknown>, deltaSeconds = 0.1, frames = 1, receivedAt?: number) => {
      const model = models.get(assetCode)!;
      for (let i = 0; i < frames; i += 1) {
        driver.applyToModel(model, makeSnapshot(assetCode, fields, receivedAt), deltaSeconds);
        driver.pullExternalHolderCargo();
      }
    },
    /** 向 stacker 货物表插入持有货物（模拟堆垛机已持有的货箱）。 */
    insertStackerCargo: (assetCode: string, task: string) => {
      const root = new TransformNode(`${assetCode}_cargo_root`, scene);
      const entry = {
        assetCode,
        containerCode: '',
        task,
        root,
        outputOwner: null,
        fallback: null,
        generatorEntityId: null,
        handoff: null,
      };
      state.stackerCargoMeshes.set(JSON.stringify([assetCode, 'front']), entry as ConveyorCargoRuntimeEntry);
      return entry;
    },
    /** 向 conveyor 货物表插入持有货物并置 holder 遥测引用（模拟输送线已持有的货箱）。 */
    insertConveyorCargo: (assetCode: string, task: string) => {
      const root = new TransformNode(`${assetCode}_cargo_root`, scene);
      const entry = {
        assetCode,
        containerCode: '',
        task,
        root,
        outputOwner: null,
        fallback: null,
        generatorEntityId: null,
        handoff: null,
      };
      state.conveyorCargoMeshes.set(JSON.stringify([assetCode, 'cargo']), entry as ConveyorCargoRuntimeEntry);
      models.get(assetCode)!.conveyorTelemetry.cargoCode = 'cargo';
      return entry;
    },
    /** 仅执行帧尾外部持货拉取扫描（不驱动任何设备帧）。 */
    scan: () => driver.pullExternalHolderCargo(),
  };
}

/** 获取唯一输送线货物的辅助：断言表中只有一份货物。 */
function onlyCargo(state: ReturnType<typeof createSpecializedTelemetrySharedState>): ConveyorCargoRuntimeEntry {
  assert.equal(state.conveyorCargoMeshes.size, 1, '输送线货物表中必须恰好一份货物');
  return [...state.conveyorCargoMeshes.values()][0];
}

test('直接邻居无货：传递式订阅仍向上注册下位链路，本机挂起等待', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7', '必须登记等待 task');
    assert.equal(h.models.CV2.conveyorTelemetry.pendingTask, '7', 'pendingTask 保留');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, null, '等待方不得刷出货物');
    const link = h.models.CV1.conveyorTelemetry.downstreamLinks.get('CV2');
    assert.ok(link, '订阅必须注册到上游的下位链路');
    assert.equal(link.task, '7');
    assert.equal(link.hops, 1, '直接邻居 hops 必须为 1');
    assert.equal(link.direction, 1);
    assert.equal(h.models.CV2.conveyorTelemetry.upstreamLinks.size, 0, '无 available 通知不得有上位链路');
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '无货物被创建');
  } finally {
    h.dispose();
  }
});

test('上游持货后事件驱动交付：available 通知触发订阅，当帧直达交付（下游无需再收消息）', () => {
  const h = makeHarness({ CV1: { centerX: -4, origin: true }, CV2: { centerX: 0 } });
  try {
    const stamp = 1_000_000;
    // CV2 先收 task：订阅注册到 CV1 下位链路，等待
    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 1, stamp);
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7');
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV2'));

    // CV1 收 task 刷出（起点设备）：available 通知 → CV2 注册上游并立即订阅 → CV1 持货命中当帧交付
    h.apply('CV1', { task: 7, movement_x: 1 });
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.assetCode, 'CV2', '货物必须换绑到订阅者');
    assert.equal(pushed.task, '7');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null, '持有方引用必须清空');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, 'cargo', '订阅者必须接管货物身份');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null, '被交付后必须退出等待');
    assert.equal(h.models.CV2.conveyorTelemetry.pendingTask, null);
    assert.ok(Math.abs(h.models.CV2.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE)) < 1e-6,
      `订阅者必须从自身刷出端继续走行，实际 ${h.models.CV2.conveyorTelemetry.cargoTravelOffset}`);
    assert.equal(h.models.CV2.conveyorTelemetry.selfDriveDirection, 1, '被交付必须按订阅方向登记自驱');
    assert.ok(pushed.handoff, '必须登记交接插值保持视觉连续');
    assert.ok(Math.abs(pushed.handoff!.durationSeconds - CARGO_HANDOFF_SECONDS) < 1e-6,
      `单跳交付交接时长必须为 ${CARGO_HANDOFF_SECONDS}s，实际 ${pushed.handoff!.durationSeconds}`);
    assert.equal(h.models.CV2.conveyorTelemetry.upstreamLinks.size, 0, 'taken 波必须清除该 task 的上位链路');
    assert.equal(h.models.CV1.conveyorTelemetry.downstreamLinks.size, 0, '收货退订必须清除下位链路登记');

    // 下游断流重放（同一 receivedAt，movement_x=0）：自驱仍按订阅方向推进
    h.apply('CV2', { task: 7, movement_x: 0 }, 0.1, 10, stamp);
    const selfDrivenOffset = h.models.CV2.conveyorTelemetry.cargoTravelOffset;
    assert.ok(
      Math.abs(selfDrivenOffset - (-HALF_RANGE + CARGO_SPEED * 0.1 * 10)) < 1e-6,
      `断流期间自驱必须推进到 ${-HALF_RANGE + CARGO_SPEED * 0.1 * 10}，实际 ${selfDrivenOffset}`,
    );
    // 新消息到达（receivedAt 变化）：自驱结束，movement_x=0 即停车
    h.apply('CV2', { task: 7, movement_x: 0 }, 0.1, 10, stamp + 1);
    assert.equal(h.models.CV2.conveyorTelemetry.selfDriveDirection, 0, '新消息必须结束自驱');
    assert.ok(Math.abs(h.models.CV2.conveyorTelemetry.cargoTravelOffset - selfDrivenOffset) < 1e-6,
      '新消息 movement_x=0 必须立即停车');
  } finally {
    h.dispose();
  }
});

test('多台下游订阅同一 task：先注册者获得唯一货物，落选者标记过境并退订', () => {
  // CV3 放在 -0.5：其正转探测点 x=-2.86 同样落入 CV1 包围盒（且 CV2 探测点距 CV1 中心更近，不受影响）
  const h = makeHarness({
    CV1: { centerX: -4 },
    CV2: { centerX: 0 },
    CV3: { centerX: -0.5 },
  });
  try {
    // CV1 先收 task=7 空载等待（探测点无上游且非起点），CV2/CV3 凭同 task 先后订阅注册到 CV1
    h.apply('CV1', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 1 });
    h.apply('CV3', { task: 7, movement_x: 1 });
    assert.deepEqual([...h.models.CV1.conveyorTelemetry.downstreamLinks.keys()], ['CV2', 'CV3'],
      '下位链路必须按订阅到达顺序登记（先注册者先得）');

    // task 绑定的货物唯一：先注册的 CV2 获得交付；落选的 CV3 被 taken 波标记过境、退订并停止挂单
    h.insertConveyorCargo('CV1', '7');
    h.apply('CV1', { task: 7, movement_x: 1 });
    const first = onlyCargo(h.state);
    assert.equal(first.assetCode, 'CV2', '唯一货物必须交给先注册者');
    assert.equal(first.task, '7');
    assert.ok(h.models.CV3.conveyorTelemetry.transitedTasks.has('7'), '落选者必须标记过境');
    assert.equal(h.models.CV3.conveyorTelemetry.waitingTask, null, '落选者不得继续挂单');
    assert.equal(h.models.CV3.conveyorTelemetry.pendingTask, null);
    assert.equal(h.models.CV1.conveyorTelemetry.downstreamLinks.size, 0,
      '交付摘除 + 过境退订后下位链路必须清空');

    // 此后 CV1 再持同 task 货物：无订阅者，货物留在 CV1
    h.insertConveyorCargo('CV1', '7');
    h.apply('CV1', { task: 7, movement_x: 1 });
    const cargos = [...h.state.conveyorCargoMeshes.values()];
    assert.equal(cargos.length, 2);
    assert.ok(cargos.some((cargo) => cargo.assetCode === 'CV1'), '无订阅者时货物必须留在持有方');
  } finally {
    h.dispose();
  }
});

test('等待中方向翻转：链路失效清空并沿新方向重新订阅', () => {
  const h = makeHarness({
    CV1: { centerX: -4 },
    CV2: { centerX: 0 },
    CV3: { centerX: 4 },
  });
  try {
    // CV2 正转订阅 CV1
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV2'));

    // 翻转为反转：退订旧方向（CV1 摘除登记），以新方向订阅反转探测点触及的 CV3
    h.apply('CV2', { task: 7, movement_x: 2 });
    assert.equal(h.models.CV1.conveyorTelemetry.downstreamLinks.size, 0, '翻转必须退订旧方向上游');
    const link = h.models.CV3.conveyorTelemetry.downstreamLinks.get('CV2');
    assert.ok(link, '必须以新方向订阅新上游 CV3');
    assert.equal(link.direction, -1);
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7', '等待必须保留');
  } finally {
    h.dispose();
  }

  // stacker 邻居两侧探测点都覆盖：翻转而邻居不变时，外部拉取登记仅更新方向
  const h2 = makeHarness({ CV2: { centerX: 0 }, ST1: { centerX: 0, stacker: true, halfSpanX: 3 } });
  try {
    h2.apply('CV2', { task: 7, movement_x: 1 });
    const before = h2.models.CV2.conveyorTelemetry.externalPulls.get('CV2');
    assert.ok(before, 'stacker 邻居必须登记外部拉取');
    assert.equal(before.holderAssetCode, 'ST1');
    assert.equal(before.direction, 1);
    h2.apply('CV2', { task: 7, movement_x: 2 });
    const after = h2.models.CV2.conveyorTelemetry.externalPulls.get('CV2');
    assert.ok(after, '翻转后必须重新登记外部拉取');
    assert.equal(after.holderAssetCode, 'ST1', '同一邻居不得改变持货方');
    assert.equal(after.direction, -1, '方向必须更新');
  } finally {
    h2.dispose();
  }
});

test('探测点无上游时：起点设备自行创建货箱（movement_x=0 按正转刷出并自驱），非起点仅等待', () => {
  const h = makeHarness({ CV1: { centerX: 0, origin: true } });
  try {
    h.apply('CV1', { task: 7, movement_x: 0 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null, '起点设备无邻居不得等待');
    const cargo = onlyCargo(h.state);
    assert.equal(cargo.assetCode, 'CV1');
    assert.equal(cargo.task, '7');
    assert.ok(Math.abs(h.models.CV1.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE + CARGO_SPEED * 0.1)) < 1e-6,
      `movement_x=0 必须按正转刷在轨迹起点并当帧自驱推进，实际 ${h.models.CV1.conveyorTelemetry.cargoTravelOffset}`);
    assert.equal(h.models.CV1.conveyorTelemetry.selfDriveDirection, 1, 'movement_x=0 刷出必须登记正转自驱');
  } finally {
    h.dispose();
  }

  const h2 = makeHarness({ CV2: { centerX: 0 } });
  try {
    h2.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h2.models.CV2.conveyorTelemetry.waitingTask, '7', '非起点设备无邻居只能等待');
    assert.equal(h2.models.CV2.conveyorTelemetry.upstreamLinks.size, 0);
    assert.equal(h2.models.CV2.conveyorTelemetry.downstreamLinks.size, 0, '无邻居不得有链路登记');
    assert.equal(h2.state.conveyorCargoMeshes.size, 0, '非起点设备不得自行创建货箱');
  } finally {
    h2.dispose();
  }
});

test('持货新 task 规则一：旧货无下游订阅且上游无新 task 货 → 复用盖新 task 并通知下游', () => {
  const h = makeHarness({ CV1: { centerX: -4, origin: true }, CV2: { centerX: 0 } });
  try {
    // CV1 先持有 task=3 的货物并走行一段
    h.apply('CV1', { task: 3, movement_x: 1 }, 0.1, 10);
    const held = onlyCargo(h.state);
    const heldRoot = held.root;
    const strandedOffset = h.models.CV1.conveyorTelemetry.cargoTravelOffset;
    assert.ok(Math.abs(strandedOffset - (-HALF_RANGE + CARGO_SPEED * 0.1 * 10)) < 1e-6);
    // CV2 凭 available 通知注册了上位链路（task=3）
    assert.equal(h.models.CV2.conveyorTelemetry.upstreamLinks.get('CV1')?.task, '3');

    h.apply('CV1', { task: 5, movement_x: 0 });
    const reused = onlyCargo(h.state);
    assert.equal(reused.root, heldRoot, '必须复用同一货物实例');
    assert.equal(reused.task, '5', '必须盖上新 task');
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null, '持有滞留箱不得进入等待');
    assert.equal(h.models.CV1.conveyorTelemetry.pendingTask, null);
    assert.equal(h.models.CV1.conveyorTelemetry.selfDriveDirection, 1, 'movement_x=0 复用必须登记正转自驱');
    assert.ok(Math.abs(h.models.CV1.conveyorTelemetry.cargoTravelOffset - (strandedOffset + CARGO_SPEED * 0.1)) < 1e-6,
      `复用必须从滞留位置继续走行，期望 ${strandedOffset + CARGO_SPEED * 0.1}，实际 ${h.models.CV1.conveyorTelemetry.cargoTravelOffset}`);
    // taken(3)+available(5) 波：下游上位链路更新为新 task
    assert.equal(h.models.CV2.conveyorTelemetry.upstreamLinks.get('CV1')?.task, '5',
      '复用后必须通知下游新 task 持货');
  } finally {
    h.dispose();
  }
});

test('持货新 task 规则二：旧货已有下游订阅 → 先正常交付，本机按无货流程订阅新 task', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    // CV2 先订阅 task=3（注册到 CV1 下位链路），随后 CV1 持有 task=3 货物（带订阅持有）
    h.apply('CV2', { task: 3, movement_x: 1 });
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV2'));
    const held = h.insertConveyorCargo('CV1', '3');

    // CV1 收到新 task=5：旧货先交付给 CV2，本机转为等待 task=5
    h.apply('CV1', { task: 5, movement_x: 1 });
    const delivered = onlyCargo(h.state);
    assert.equal(delivered.root, held.root, '旧货必须原实例交付');
    assert.equal(delivered.assetCode, 'CV2', '旧货必须交付给已订阅的下游');
    assert.equal(delivered.task, '3', '货物与 task 绑定，交付不重写 task');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '5', '本机必须按无货流程等待新 task');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null);
    assert.equal(h.models.CV2.conveyorTelemetry.selfDriveDirection, 1);
  } finally {
    h.dispose();
  }
});

test('持货新 task 规则三：旧货无订阅但上游有新 task 货 → 销毁旧货等传递（当帧被交付）', () => {
  const h = makeHarness({ CV0: { centerX: -8 }, CV1: { centerX: -4 } });
  try {
    // CV0 持有 task=5 货物；CV1 持有 task=3 滞留箱（无下游订阅）
    const upstreamCargo = h.insertConveyorCargo('CV0', '5');
    const oldCargo = h.insertConveyorCargo('CV1', '3');

    // CV1 收 task=5：探测到上游持有新 task 货 → 销毁旧箱、订阅上游 → 当帧被交付
    h.apply('CV1', { task: 5, movement_x: 1 });
    const delivered = onlyCargo(h.state);
    assert.equal(delivered.root, upstreamCargo.root, '必须接管上游 task=5 的货物实例');
    assert.notEqual(delivered.root, oldCargo.root, '旧箱必须被销毁而非复用');
    assert.equal(delivered.assetCode, 'CV1');
    assert.equal(delivered.task, '5');
    assert.equal(h.models.CV0.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null, '当帧被交付后不得残留等待');
    assert.equal(h.models.CV1.conveyorTelemetry.selfDriveDirection, 1);
  } finally {
    h.dispose();
  }
});

test('异 task 货物不交付（货物与 task 绑定）；上游复用盖新 task 后命中订阅即交付', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.insertConveyorCargo('CV1', '3');
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV2'), '订阅必须登记');
    assert.equal(onlyCargo(h.state).assetCode, 'CV1', '异 task 货物不得交付');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7', 'CV2 必须持续等待本 task 的货');

    // CV1 收 task=7：旧货无 task=3 的订阅 → 复用盖 7 → 命中 CV2 的订阅当帧交付
    h.apply('CV1', { task: 7, movement_x: 1 });
    const delivered = onlyCargo(h.state);
    assert.equal(delivered.assetCode, 'CV2');
    assert.equal(delivered.task, '7');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null);
  } finally {
    h.dispose();
  }
});

test('mode=0 退出等待并退订：上游摘除下位链路登记，此后持货不再交付', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV2'));

    h.apply('CV2', { task: 7, movement_x: 0, mode: 0 });
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null, 'mode=0 必须退出等待');
    assert.equal(h.models.CV2.conveyorTelemetry.pendingTask, null, '退出等待必须放弃 pendingTask');
    assert.equal(h.models.CV1.conveyorTelemetry.downstreamLinks.size, 0, '退订必须沿链摘除登记');

    // 退订后上游持货不再交付
    h.insertConveyorCargo('CV1', '7');
    h.apply('CV1', { task: 7, movement_x: 1 });
    assert.equal(onlyCargo(h.state).assetCode, 'CV1', '退订后货物必须留在上游');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, null);
  } finally {
    h.dispose();
  }
});

test('等待方 mode=2 不退出等待、不影响被交付资格', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 0, mode: 2, front_has_goods: 0, back_has_goods: 0 });
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7', '等待方 mode=2 不得退出等待');
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV2'), '等待方 mode=2 不得退订');

    h.insertConveyorCargo('CV1', '7');
    h.apply('CV1', { task: 7, movement_x: 1 });
    assert.equal(onlyCargo(h.state).assetCode, 'CV2', 'mode=2 的等待者仍必须能被交付');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null);
  } finally {
    h.dispose();
  }
});

test('反转（movement_x=2）沿反转探测点订阅，交付后从轨迹终点侧接入并按反转方向自驱', () => {
  const h = makeHarness({ CV2: { centerX: 0 }, CV3: { centerX: 4 } });
  try {
    const held = h.insertConveyorCargo('CV3', '7');

    h.apply('CV2', { task: 7, movement_x: 2 });
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.root, held.root, '必须接管同一货物实例');
    assert.equal(pushed.assetCode, 'CV2');
    assert.equal(pushed.task, '7');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, 'cargo', 'CV3 持货当帧即被交付');
    // 交付发生在本机帧内（订阅传播同步命中持货方）：当帧走行已按反转方向推进一格
    assert.ok(Math.abs(h.models.CV2.conveyorTelemetry.cargoTravelOffset - (HALF_RANGE - CARGO_SPEED * 0.1)) < 1e-6,
      `反转必须从轨迹终点侧接入并当帧内移，实际 ${h.models.CV2.conveyorTelemetry.cargoTravelOffset}`);
    assert.equal(h.models.CV2.conveyorTelemetry.selfDriveDirection, -1, '必须按反转方向自驱');
  } finally {
    h.dispose();
  }
});

test('stacker 持货拉取：订阅触达非 conveyor 邻居登记 externalPulls，帧尾扫描代交付', () => {
  const h = makeHarness({ ST1: { centerX: -4, stacker: true }, CV2: { centerX: 0 } });
  try {
    const stackerCargo = h.insertStackerCargo('ST1', '7');

    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h.state.stackerCargoMeshes.size, 0, '货物必须从 stacker 表摘除');
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.root, stackerCargo.root, '必须接管 stacker 同一货物实例');
    assert.equal(pushed.assetCode, 'CV2', '货物必须换绑到输送线');
    assert.equal(pushed.task, '7');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null);
    assert.equal(h.models.CV2.conveyorTelemetry.externalPulls.size, 0, '拉取完成后登记必须清除');
    assert.ok(Math.abs(pushed.handoff!.durationSeconds - CARGO_HANDOFF_SECONDS) < 1e-6,
      '相邻外部拉取 hops=1，交接时长不加速');
  } finally {
    h.dispose();
  }
});

test('链式接力：同帧逐级传递，同一货物实例沿链路传到末端', () => {
  const h = makeHarness({
    CV1: { centerX: -4, origin: true },
    CV2: { centerX: 0 },
    CV3: { centerX: 4 },
  });
  try {
    // CV1 起点刷出；CV2 订阅 → 当帧交付；CV3 订阅 → 同帧接力交付
    h.apply('CV1', { task: 7, movement_x: 1 });
    const originRoot = onlyCargo(h.state).root;

    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(onlyCargo(h.state).assetCode, 'CV2', 'CV1 持货必须先交付 CV2');

    h.apply('CV3', { task: 7, movement_x: 1 });
    const final = onlyCargo(h.state);
    assert.equal(final.root, originRoot, '链式接力必须保持同一货物实例');
    assert.equal(final.assetCode, 'CV3', '货物必须最终传到末端 CV3');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, null, '中间设备接力后不得留存货物');
    assert.equal(h.models.CV3.conveyorTelemetry.cargoCode, 'cargo');
  } finally {
    h.dispose();
  }
});

test('多跳直达交付：越级跳过空载中间设备，交接动画按跳数加速（1s/hops）', () => {
  const h = makeHarness({
    UP: { centerX: -4, origin: true },
    MID: { centerX: 0 },
    DOWN: { centerX: 4 },
  });
  try {
    // DOWN 先收 task=7：订阅经 MID 传递到 UP（MID/UP 依次登记 hops=1/2）
    h.apply('DOWN', { task: 7, movement_x: 1 });
    assert.equal(h.models.MID.conveyorTelemetry.downstreamLinks.get('DOWN')?.hops, 1);
    assert.equal(h.models.UP.conveyorTelemetry.downstreamLinks.get('DOWN')?.hops, 2);

    // UP 起点刷出 → 直达交付 DOWN（MID 全程不持货），hops=2 → 交接时长减半
    h.apply('UP', { task: 7, movement_x: 1 });
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.assetCode, 'DOWN', '货物必须直达交付给最终订阅者');
    assert.equal(pushed.task, '7');
    assert.equal(h.models.UP.conveyorTelemetry.cargoCode, null, 'UP 引用必须清空');
    assert.equal(h.models.MID.conveyorTelemetry.cargoCode, null, 'MID 全程不得持货');
    assert.equal(h.models.DOWN.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.DOWN.conveyorTelemetry.waitingTask, null);
    assert.equal(h.models.DOWN.conveyorTelemetry.selfDriveDirection, 1);
    assert.ok(Math.abs(h.models.DOWN.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE)) < 1e-6,
      `DOWN 必须从自身刷出端接入，实际 ${h.models.DOWN.conveyorTelemetry.cargoTravelOffset}`);
    assert.ok(pushed.handoff, '必须登记交接插值保持视觉连续');
    assert.ok(Math.abs(pushed.handoff!.durationSeconds - CARGO_HANDOFF_SECONDS / 2) < 1e-6,
      `两跳交付交接时长必须减半为 ${CARGO_HANDOFF_SECONDS / 2}s，实际 ${pushed.handoff!.durationSeconds}`);
    // 收货退订沿链清除登记
    assert.equal(h.models.MID.conveyorTelemetry.downstreamLinks.size, 0, 'MID 必须摘除 DOWN 的登记');
    assert.equal(h.models.UP.conveyorTelemetry.downstreamLinks.size, 0, 'UP 必须摘除 DOWN 的登记');
  } finally {
    h.dispose();
  }
});

test('越级交付过境标记：等待中的中间设备标记 transitedTasks，此后同 task 仅更新 lastTask', () => {
  const h = makeHarness({
    UP: { centerX: -4, origin: true },
    MID: { centerX: 0 },
    DOWN: { centerX: 4 },
  });
  try {
    // DOWN 先订阅（UP 下位链路先登记 DOWN），MID 后订阅同 task
    h.apply('DOWN', { task: 7, movement_x: 1 });
    h.apply('MID', { task: 7, movement_x: 1 });
    assert.deepEqual([...h.models.UP.conveyorTelemetry.downstreamLinks.keys()], ['DOWN', 'MID']);

    // UP 刷出 → 直达交付先注册的 DOWN（越过等待中的 MID）→ taken 波把 MID 标记过境
    h.apply('UP', { task: 7, movement_x: 1 });
    assert.equal(onlyCargo(h.state).assetCode, 'DOWN');
    assert.ok(h.models.MID.conveyorTelemetry.transitedTasks.has('7'), 'MID 必须标记过境 task');
    assert.equal(h.models.MID.conveyorTelemetry.waitingTask, null, '过境后不得继续挂单');
    assert.equal(h.models.MID.conveyorTelemetry.pendingTask, null);

    // MID 改收 task=8 再回到 7：已过境，仅更新 lastTask，自身 task=8 的等待与登记不受影响
    h.apply('MID', { task: 8, movement_x: 1 });
    assert.equal(h.models.MID.conveyorTelemetry.waitingTask, '8');
    h.apply('MID', { task: 7, movement_x: 1 });
    assert.equal(h.models.MID.conveyorTelemetry.lastTask, '7', 'lastTask 仍须更新');
    assert.equal(h.models.MID.conveyorTelemetry.currentTask, '8', '已过境 task 不得覆盖自身 task');
    assert.equal(h.models.MID.conveyorTelemetry.pendingTask, '8', '自身 task=8 的等待必须保持');
    assert.equal(h.models.MID.conveyorTelemetry.waitingTask, '8');
    assert.equal(h.models.UP.conveyorTelemetry.downstreamLinks.get('MID')?.task, '8',
      '自身 task=8 的订阅登记必须保留，过境 task 不得新增登记');
    assert.equal(h.models.UP.conveyorTelemetry.downstreamLinks.size, 1);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '不得产生新货物');
  } finally {
    h.dispose();
  }
});

test('侧向通知注册：B 探测不到 A 时凭 available 注册上游并订阅成功', () => {
  // B 中心 4.4、半径 2.1：A 的出口探测点 x=2.36 落入 B[2.3,6.5]，B 的入口探测点 x=1.94 探不到 A[-2,2]
  const h = makeHarness({
    A: { centerX: 0, origin: true },
    B: { centerX: 4.4, halfSpanX: 2.1 },
  });
  try {
    // B 先收 task：探不到上游、无注册上游 → 仅等待
    h.apply('B', { task: 7, movement_x: 1 });
    assert.equal(h.models.B.conveyorTelemetry.waitingTask, '7');
    assert.equal(h.models.B.conveyorTelemetry.upstreamLinks.size, 0);

    // A 起点刷出 → available 通知触及 B 侧面 → B 注册 A 为上游并立即订阅 → A 当帧交付
    h.apply('A', { task: 7, movement_x: 1 });
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.assetCode, 'B', 'B 必须凭通知注册的链路收到货物');
    assert.equal(pushed.task, '7');
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.B.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.B.conveyorTelemetry.waitingTask, null);
  } finally {
    h.dispose();
  }
});

test('成环布局防环：消息 visited 丢弃回环，链路登记不重复不溢出', () => {
  // 三机相距 100m 探测点互不触及；手工注入上位链路成环 A→B→C→A（模拟通知泛洪形成的环）
  const h = makeHarness({
    A: { centerX: 0 },
    B: { centerX: 100 },
    C: { centerX: 200 },
  });
  try {
    const link = { task: '7', holderAssetCode: '', hops: 1, direction: 1 };
    h.models.A.conveyorTelemetry.upstreamLinks.set('B', { ...link, holderAssetCode: 'B' });
    h.models.B.conveyorTelemetry.upstreamLinks.set('C', { ...link, holderAssetCode: 'C' });
    h.models.C.conveyorTelemetry.upstreamLinks.set('A', { ...link, holderAssetCode: 'A' });

    // A 收 task=7：沿注册上游订阅 A→B→C→A，回环被 visited 丢弃
    h.apply('A', { task: 7, movement_x: 1 });
    assert.equal(h.models.A.conveyorTelemetry.waitingTask, '7');
    assert.ok(h.models.B.conveyorTelemetry.downstreamLinks.has('A'));
    assert.ok(h.models.C.conveyorTelemetry.downstreamLinks.has('A'));
    assert.equal(h.models.A.conveyorTelemetry.downstreamLinks.size, 0, '回环丢弃后 A 不得重复登记自身');
    assert.equal(h.state.conveyorCargoMeshes.size, 0);
  } finally {
    h.dispose();
  }
});

test('帧调度契约：applyWhenStale 仅自驱，帧尾无条件执行外部持货拉取扫描', () => {
  const source = readFileSync('src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime.ts', 'utf8');
  const conveyorRegistration = source.match(/deviceType: 'conveyor',[\s\S]*?\},\r?\n/);
  assert.ok(conveyorRegistration, '必须存在 conveyor 驱动注册项');
  assert.match(
    conveyorRegistration[0],
    /applyWhenStale: \(model\) => \(model\.conveyorTelemetry\?\.selfDriveDirection \?\? 0\) !== 0/,
    'conveyor 注册断流驱动必须仅判定接管自驱',
  );
  assert.doesNotMatch(
    conveyorRegistration[0],
    /needsLockedPushOutDrive/,
    '锁定协议已移除，不得残留出货动画断流判定',
  );
  assert.match(
    source,
    /this\.conveyorDriver\.pullExternalHolderCargo\(\)/,
    'applyFrame 帧尾必须执行外部持货拉取扫描',
  );
});

test('trajectoryDirection 为模型本地坐标：模型旋转 180° 后正转仍从本地轨迹起点刷出', () => {
  const h = makeHarness({
    CV1: { centerX: 0, origin: true, rotationY: Math.PI, trajectoryDirection: 'x' },
  });
  try {
    // 本地 x 轴经 180° 旋转后指向世界 −x；trajectoryDirection='x' 按本地语义
    // 正转刷出端为本地轨迹起点 → 世界 +x 端（若按世界语义会刷在世界 −x 端）。
    h.apply('CV1', { task: 7, movement_x: 1 });
    const cargo = onlyCargo(h.state);
    const spawnX = cargo.root.position.x;
    assert.ok(spawnX > HALF_RANGE - 0.1,
      `正转必须从世界 +x 端（本地轨迹起点）刷出，实际 x=${spawnX}`);

    // 继续走行：货物沿本地轨迹方向推进，即世界 −x 方向
    h.apply('CV1', { task: 7, movement_x: 1 }, 0.1, 10);
    const laterX = cargo.root.position.x;
    assert.ok(laterX < spawnX, `货物必须向世界 −x 方向走行：${spawnX} → ${laterX}`);

    // 对照：trajectoryDirection='-x' 时刷出端翻到世界 −x 端
    const h2 = makeHarness({
      CV1: { centerX: 0, origin: true, rotationY: Math.PI, trajectoryDirection: '-x' },
    });
    try {
      h2.apply('CV1', { task: 7, movement_x: 1 });
      const cargo2 = onlyCargo(h2.state);
      assert.ok(cargo2.root.position.x < -(HALF_RANGE - 0.1),
        `trajectoryDirection='-x' 必须从世界 −x 端刷出，实际 x=${cargo2.root.position.x}`);
    } finally {
      h2.dispose();
    }
  } finally {
    h.dispose();
  }
});
