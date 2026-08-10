import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { ConveyorTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/conveyorDriver';
import { createConveyorTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import {
  CONVEYOR_CARGO_SIZE,
  createSpecializedTelemetrySharedState,
  type ConveyorCargoRuntimeEntry,
} from '../../src/runtime/babylon/telemetry/specialized/types';
import { resolveConveyorCargoTravelHalfRange } from '../../src/runtime/babylon/telemetry/conveyorCargoTravel';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

/**
 * 输送线探测点订阅/推送协议测试的几何约定（与 harness bounds 对齐）：
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
};

/** 多设备 harness：共享货物表与 collectModels 视图，帧函数镜像 facade（applyToModel 后执行推送扫描）。 */
function makeHarness(layout: Record<string, HarnessDeviceConfig>) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const models = new Map<string, ModelRuntimeEntry>();
  const logs: string[] = [];

  for (const [assetCode, config] of Object.entries(layout)) {
    const root = new TransformNode(`${assetCode}_root`, scene);
    const binding: Record<string, unknown> = {};
    if (config.autoDispose !== undefined) binding.cargoAutoDispose = config.autoDispose;
    if (config.origin !== undefined) binding.cargoOriginDevice = config.origin;
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
    /** 镜像 facade 帧调度：应用快照后执行帧尾推送扫描（与快照新旧无关）。 */
    apply: (assetCode: string, fields: Record<string, unknown>, deltaSeconds = 0.1, frames = 1, receivedAt?: number) => {
      const model = models.get(assetCode)!;
      for (let i = 0; i < frames; i += 1) {
        driver.applyToModel(model, makeSnapshot(assetCode, fields, receivedAt), deltaSeconds);
        driver.pushCargoToProbeSubscribers();
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
    /** 仅执行帧尾推送扫描（不驱动任何设备帧）。 */
    scan: () => driver.pushCargoToProbeSubscribers(),
  };
}

/** 获取唯一输送线货物的辅助：断言表中只有一份货物。 */
function onlyCargo(state: ReturnType<typeof createSpecializedTelemetrySharedState>): ConveyorCargoRuntimeEntry {
  assert.equal(state.conveyorCargoMeshes.size, 1, '输送线货物表中必须恰好一份货物');
  return [...state.conveyorCargoMeshes.values()][0];
}

test('直接邻居无货且 task 不一致（含无 task）：不订阅，仅挂起等待', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7', '必须登记等待 task');
    assert.equal(h.models.CV2.conveyorTelemetry.pendingTask, '7', 'pendingTask 保留');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, null, '等待方不得刷出货物');
    assert.equal(h.models.CV2.conveyorTelemetry.probeSubscription, null, '上游无货且 task 不一致不得订阅');
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '无货物被创建');
  } finally {
    h.dispose();
  }
});

test('直接邻居无货但同 task：进入等待并登记订阅（holderAssetCode/direction/seq）', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    // CV1 先收 task=7（探测点无上游且非起点 → 空载等待），CV2 凭同 task 订阅 CV1
    h.apply('CV1', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7', '必须登记等待 task');
    assert.equal(h.models.CV2.conveyorTelemetry.pendingTask, '7', 'pendingTask 保留');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, null, '等待方不得刷出货物');
    const subscription = h.models.CV2.conveyorTelemetry.probeSubscription;
    assert.ok(subscription, '必须登记向上游设备的订阅');
    assert.equal(subscription.holderAssetCode, 'CV1', '正转探测点必须触及上游 CV1');
    assert.equal(subscription.direction, 1);
    assert.equal(subscription.seq, 1, '首个订阅 seq 必须为 1');
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '无货物被创建');
  } finally {
    h.dispose();
  }
});

test('上游持货后主动推送：下游无需再收 MQTT 消息即接管货物', () => {
  const h = makeHarness({ CV1: { centerX: -4, origin: true }, CV2: { centerX: 0 } });
  try {
    const stamp = 1_000_000;
    // CV2 先收 task：CV1 尚无货物且无 task → 不订阅（task 不一致），仅等待
    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 1, stamp);
    assert.equal(h.models.CV2.conveyorTelemetry.probeSubscription, null, '上游无货且 task 不一致时不得订阅');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7');

    // CV1 收 task 刷出（起点设备）；此刻无人订阅，货物留在 CV1
    h.apply('CV1', { task: 7, movement_x: 1 });
    assert.equal(onlyCargo(h.state).assetCode, 'CV1');

    // CV2 断流重放（同一 receivedAt，无新消息）：逐帧重估发现 CV1 持货 → 订阅并当帧被推送
    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 1, stamp);
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.assetCode, 'CV2', '货物必须换绑到订阅者');
    assert.equal(pushed.task, '7', '货物必须盖上订阅者的 task');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null, '持有方引用必须清空');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, 'cargo', '订阅者必须接管货物身份');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null, '被推送后必须退出等待');
    assert.equal(h.models.CV2.conveyorTelemetry.pendingTask, null);
    assert.equal(h.models.CV2.conveyorTelemetry.probeSubscription, null, '被推送后必须摘除订阅');
    assert.ok(Math.abs(h.models.CV2.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE)) < 1e-6,
      `订阅者必须从自身刷出端继续走行，实际 ${h.models.CV2.conveyorTelemetry.cargoTravelOffset}`);
    assert.equal(h.models.CV2.conveyorTelemetry.selfDriveDirection, 1, '被推送必须按订阅方向登记自驱');
    assert.ok(pushed.handoff, '必须登记交接插值保持视觉连续');
    assert.ok(h.logs.some((message) => message.includes('CV1') && message.includes('CV2')),
      '必须输出推送日志');

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

test('多台下游订阅同一上游：先订阅者先得，其余顺位等下一箱', () => {
  // CV3 放在 -0.5：其正转探测点 x=-2.86 同样落入 CV1 包围盒（且 CV2 探测点距 CV1 中心更近，不受影响）
  const h = makeHarness({
    CV1: { centerX: -4 },
    CV2: { centerX: 0 },
    CV3: { centerX: -0.5 },
  });
  try {
    // CV1 先收 task=7 空载等待（探测点无上游且非起点），CV2/CV3 凭同 task 先后订阅 CV1
    h.apply('CV1', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 1 });
    h.apply('CV3', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV2.conveyorTelemetry.probeSubscription?.holderAssetCode, 'CV1');
    assert.equal(h.models.CV3.conveyorTelemetry.probeSubscription?.holderAssetCode, 'CV1');
    const seq2 = h.models.CV2.conveyorTelemetry.probeSubscription!.seq;
    const seq3 = h.models.CV3.conveyorTelemetry.probeSubscription!.seq;
    assert.ok(seq2 < seq3, `先订阅者 seq 必须更小（${seq2} < ${seq3}）`);

    // 第一箱推给先订阅的 CV2；CV3 继续等待
    h.insertConveyorCargo('CV1', '7');
    h.scan();
    const first = onlyCargo(h.state);
    assert.equal(first.assetCode, 'CV2', '第一箱必须推给先订阅者');
    assert.equal(h.models.CV3.conveyorTelemetry.waitingTask, '7', 'CV3 必须继续等待');
    assert.ok(h.models.CV3.conveyorTelemetry.probeSubscription, 'CV3 订阅必须保留');

    // CV1 持第二箱 → 推给顺位的 CV3（货物盖上 CV3 等待的 task）
    h.insertConveyorCargo('CV1', '8');
    h.scan();
    const cargos = [...h.state.conveyorCargoMeshes.values()];
    assert.equal(cargos.length, 2);
    const second = cargos.find((cargo) => cargo.assetCode === 'CV3');
    assert.ok(second, '第二箱必须推给顺位的 CV3');
    assert.equal(second.task, '7', '推送的货物盖的是订阅者等待的 task');
    assert.equal(h.models.CV3.conveyorTelemetry.waitingTask, null);
  } finally {
    h.dispose();
  }
});

test('等待中方向翻转：邻居不变保留 seq 仅更新方向；邻居变化重新排队', () => {
  const h = makeHarness({
    CV1: { centerX: -4 },
    CV2: { centerX: 0 },
    CV3: { centerX: 4 },
  });
  try {
    // CV1/CV3 先收 task=7 空载等待，CV2 正转订阅 CV1
    h.apply('CV1', { task: 7, movement_x: 1 });
    h.apply('CV3', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV2.conveyorTelemetry.probeSubscription?.holderAssetCode, 'CV1');
    // 翻转为反转：反转探测点触及 CV3 → 邻居变化必须重新排队（新 seq）
    h.apply('CV2', { task: 7, movement_x: 2 });
    const moved = h.models.CV2.conveyorTelemetry.probeSubscription;
    assert.ok(moved);
    assert.equal(moved.holderAssetCode, 'CV3', '反转探测点必须触及下游侧设备 CV3');
    assert.equal(moved.direction, -1);
    assert.ok(moved.seq > 1, '邻居变化必须重新排队（seq 增大）');
  } finally {
    h.dispose();
  }

  // 堆垛机包围盒同时覆盖两侧探测点：方向翻转邻居不变，保留 seq 仅更新方向
  const h2 = makeHarness({ CV2: { centerX: 0 }, ST1: { centerX: 0, stacker: true, halfSpanX: 3 } });
  try {
    h2.apply('CV2', { task: 7, movement_x: 1 });
    const before = h2.models.CV2.conveyorTelemetry.probeSubscription;
    assert.ok(before);
    assert.equal(before.holderAssetCode, 'ST1');
    h2.apply('CV2', { task: 7, movement_x: 2 });
    const after = h2.models.CV2.conveyorTelemetry.probeSubscription;
    assert.ok(after);
    assert.equal(after.holderAssetCode, 'ST1', '同一邻居不得重新排队');
    assert.equal(after.direction, -1, '方向必须更新');
    assert.equal(after.seq, before.seq, '邻居不变必须保留 seq');
  } finally {
    h2.dispose();
  }
});

test('探测点无上游时：起点设备自行创建货箱（movement_x=0 按正转刷出并自驱），非起点仅等待', () => {
  const h = makeHarness({ CV1: { centerX: 0, origin: true } });
  try {
    h.apply('CV1', { task: 7, movement_x: 0 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null, '起点设备无邻居不得等待');
    assert.equal(h.models.CV1.conveyorTelemetry.probeSubscription, null, '无邻居不得登记订阅');
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
    assert.equal(h2.models.CV2.conveyorTelemetry.probeSubscription, null, '无订阅对象不得登记');
    assert.equal(h2.state.conveyorCargoMeshes.size, 0, '非起点设备不得自行创建货箱');
  } finally {
    h2.dispose();
  }
});

test('自身持有滞留货箱时新 task 直接复用，不等待不订阅', () => {
  const h = makeHarness({ CV1: { centerX: -4, origin: true }, CV2: { centerX: 0 } });
  try {
    // CV1 先持有 task=3 的货物并走行一段（CV2 是其反转侧邻居，但复用优先于订阅）
    h.apply('CV1', { task: 3, movement_x: 1 }, 0.1, 10);
    const held = onlyCargo(h.state);
    const heldRoot = held.root;
    const strandedOffset = h.models.CV1.conveyorTelemetry.cargoTravelOffset;
    assert.ok(Math.abs(strandedOffset - (-HALF_RANGE + CARGO_SPEED * 0.1 * 10)) < 1e-6);

    h.apply('CV1', { task: 5, movement_x: 0 });
    const reused = onlyCargo(h.state);
    assert.equal(reused.root, heldRoot, '必须复用同一货物实例');
    assert.equal(reused.task, '5', '必须盖上新 task');
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null, '持有滞留箱不得进入等待');
    assert.equal(h.models.CV1.conveyorTelemetry.probeSubscription, null, '持有滞留箱不得订阅上游');
    assert.equal(h.models.CV1.conveyorTelemetry.pendingTask, null);
    assert.equal(h.models.CV1.conveyorTelemetry.selfDriveDirection, 1, 'movement_x=0 复用必须登记正转自驱');
    assert.ok(Math.abs(h.models.CV1.conveyorTelemetry.cargoTravelOffset - (strandedOffset + CARGO_SPEED * 0.1)) < 1e-6,
      `复用必须从滞留位置继续走行，期望 ${strandedOffset + CARGO_SPEED * 0.1}，实际 ${h.models.CV1.conveyorTelemetry.cargoTravelOffset}`);
  } finally {
    h.dispose();
  }
});

test('mode=0 退出等待并退订，上游货物保持不动', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    // CV1 先收 task=7 空载等待，CV2 凭同 task 订阅 CV1
    h.apply('CV1', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.ok(h.models.CV2.conveyorTelemetry.probeSubscription);
    h.apply('CV2', { task: 7, movement_x: 0, mode: 0 });
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null, 'mode=0 必须退出等待');
    assert.equal(h.models.CV2.conveyorTelemetry.pendingTask, null, '退出等待必须放弃 pendingTask');
    assert.equal(h.models.CV2.conveyorTelemetry.probeSubscription, null, '退出等待必须退订');

    // 退订后上游持货不再推送
    h.insertConveyorCargo('CV1', '7');
    h.scan();
    assert.equal(onlyCargo(h.state).assetCode, 'CV1', '退订后货物必须留在上游');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, null);
  } finally {
    h.dispose();
  }
});

test('等待方 mode=2 不退出等待、不影响被推送资格', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV1', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 0, mode: 2, front_has_goods: 0, back_has_goods: 0 });
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7', '等待方 mode=2 不得退出等待');
    assert.ok(h.models.CV2.conveyorTelemetry.probeSubscription, '等待方 mode=2 不得退订');

    h.insertConveyorCargo('CV1', '7');
    h.scan();
    assert.equal(onlyCargo(h.state).assetCode, 'CV2', 'mode=2 的等待者仍必须能被推送');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null);
  } finally {
    h.dispose();
  }
});

test('反转（movement_x=2）使用反转探测点订阅，接管后按反转方向自驱', () => {
  const h = makeHarness({ CV2: { centerX: 0 }, CV3: { centerX: 4 } });
  try {
    // CV3 以匿名模式持货（不参与 task 协议）
    h.apply('CV3', { movement_x: 1 }, 0.1, 5);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, 'CV3 必须持有匿名货物');
    const heldRoot = onlyCargo(h.state).root;

    // CV2 收 task 且反转：反转探测点触及 CV3 → 订阅 → 推送
    h.apply('CV2', { task: 7, movement_x: 2 });
    const subscription = h.models.CV2.conveyorTelemetry.probeSubscription;
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, 'cargo', 'CV3 持货当帧即被推送');
    assert.equal(subscription, null, '被推送后订阅摘除');
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.root, heldRoot, '必须接管同一货物实例');
    assert.equal(pushed.assetCode, 'CV2');
    assert.equal(pushed.task, '7', '匿名货物被推送后盖上订阅者 task');
    assert.ok(Math.abs(h.models.CV2.conveyorTelemetry.cargoTravelOffset - HALF_RANGE) < 1e-6,
      `反转必须从轨迹终点侧接入，实际 ${h.models.CV2.conveyorTelemetry.cargoTravelOffset}`);
    assert.equal(h.models.CV2.conveyorTelemetry.selfDriveDirection, -1, '必须按反转方向自驱');
  } finally {
    h.dispose();
  }
});

test('探测点嗅探 stacker 持有的货箱：推送后从 stacker 表迁入 conveyor 表', () => {
  const h = makeHarness({ ST1: { centerX: -4, stacker: true }, CV2: { centerX: 0 } });
  try {
    const stackerCargo = h.insertStackerCargo('ST1', '7');

    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h.state.stackerCargoMeshes.size, 0, '货物必须从 stacker 表摘除');
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.root, stackerCargo.root, '必须接管 stacker 同一货物实例');
    assert.equal(pushed.assetCode, 'CV2', '货物必须换绑到输送线');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null);
  } finally {
    h.dispose();
  }
});

test('链式接力：A 推 B、B 推 C，同一货物实例沿订阅链传到末端', () => {
  const h = makeHarness({
    CV1: { centerX: -4, origin: true },
    CV2: { centerX: 0 },
    CV3: { centerX: 4 },
  });
  try {
    // CV1 起点刷出；CV2 订阅 CV1；CV3 订阅 CV2
    h.apply('CV1', { task: 7, movement_x: 1 });
    const originRoot = onlyCargo(h.state).root;

    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(onlyCargo(h.state).assetCode, 'CV2', 'CV1 持货必须先推给 CV2');

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

test('等待中收到新 task：旧订阅失效，按新 task 重估（无同 task 上游则无订阅）', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV1', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.ok(h.models.CV2.conveyorTelemetry.probeSubscription, '同 task 时必须订阅 CV1');

    // 下游 task 改变（7→9）：旧订阅退订；CV1 的 task 仍是 7，与新 task 不匹配 → 无订阅目标
    h.apply('CV2', { task: 9, movement_x: 1 });
    assert.equal(h.models.CV2.conveyorTelemetry.probeSubscription, null, 'task 改变后旧订阅不得存续');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '9', '仍按新 task 等待');
    assert.equal(h.models.CV2.conveyorTelemetry.pendingTask, '9');
  } finally {
    h.dispose();
  }
});

test('等待期间上游 task 改变：订阅失效摘除，等待保留', () => {
  const h = makeHarness({ UP: { centerX: -4 }, DOWN: { centerX: 0 } });
  try {
    const stamp = 1_000_000;
    h.apply('UP', { task: 7, movement_x: 1 }, 0.1, 1, stamp);
    h.apply('DOWN', { task: 7, movement_x: 1 }, 0.1, 1, stamp);
    assert.equal(h.models.DOWN.conveyorTelemetry.probeSubscription?.holderAssetCode, 'UP');

    // UP 改收 task=8：DOWN 断流重放（无新消息）逐帧重估 → 目标失配，订阅摘除
    h.apply('UP', { task: 8, movement_x: 1 }, 0.1, 1, stamp + 1);
    h.apply('DOWN', { task: 7, movement_x: 1 }, 0.1, 1, stamp);
    assert.equal(h.models.DOWN.conveyorTelemetry.probeSubscription, null, '上游 task 改变后订阅不得存续');
    assert.equal(h.models.DOWN.conveyorTelemetry.waitingTask, '7', '等待必须保留，目标复现时可重新订阅');
    assert.equal(h.models.DOWN.conveyorTelemetry.pendingTask, '7');
  } finally {
    h.dispose();
  }
});

test('越级订阅：跳过空载且 task 不一致的中间设备直订同 task 上位设备；中间设备记录流转 task 后不再响应同 task', () => {
  const h = makeHarness({
    UP: { centerX: -4 },
    MID: { centerX: 0 },
    DOWN: { centerX: 4 },
  });
  try {
    // UP 收 task=7 空载等待；MID 收 task=3（与 7 不一致）；DOWN 收 task=7 → 越过 MID 直订 UP
    h.apply('UP', { task: 7, movement_x: 1 });
    h.apply('MID', { task: 3, movement_x: 1 });
    h.apply('DOWN', { task: 7, movement_x: 1 });
    const subscription = h.models.DOWN.conveyorTelemetry.probeSubscription;
    assert.ok(subscription, '必须登记订阅');
    assert.equal(subscription.holderAssetCode, 'UP', '必须越过 MID 直订同 task 的 UP');
    assert.equal(h.models.DOWN.conveyorTelemetry.waitingTask, '7');

    // UP 持货 → 帧级扫描直推 DOWN（跳过 MID）
    h.insertConveyorCargo('UP', '7');
    h.scan();
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.assetCode, 'DOWN', '货物必须直推给 DOWN');
    assert.equal(pushed.task, '7');
    assert.equal(h.models.UP.conveyorTelemetry.cargoCode, null, 'UP 引用必须清空');
    assert.equal(h.models.MID.conveyorTelemetry.cargoCode, null, 'MID 全程不得持货');
    assert.equal(h.models.DOWN.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.DOWN.conveyorTelemetry.waitingTask, null);
    assert.equal(h.models.DOWN.conveyorTelemetry.selfDriveDirection, 1);
    assert.ok(Math.abs(h.models.DOWN.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE)) < 1e-6,
      `DOWN 必须从自身刷出端接入，实际 ${h.models.DOWN.conveyorTelemetry.cargoTravelOffset}`);
    assert.ok(pushed.handoff, '必须登记交接插值保持视觉连续');

    // 中间设备记录已流转 task：此后收到同 task 不再触发边沿/订阅（自身 task=3 的等待状态不受影响）
    assert.ok(h.models.MID.conveyorTelemetry.bypassedTasks.has('7'), 'MID 必须记录流转过的 task');
    h.apply('MID', { task: 7, movement_x: 1 });
    assert.equal(h.models.MID.conveyorTelemetry.lastTask, '7', 'lastTask 仍须更新');
    assert.equal(h.models.MID.conveyorTelemetry.currentTask, '3', '已流转 task 不得覆盖自身 task');
    assert.equal(h.models.MID.conveyorTelemetry.pendingTask, '3', '自身 task=3 的等待必须保持');
    assert.equal(h.models.MID.conveyorTelemetry.waitingTask, '3');
    assert.equal(h.models.MID.conveyorTelemetry.probeSubscription, null, '已流转 task 不得再向上游订阅');
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '不得产生新货物');
  } finally {
    h.dispose();
  }
});

test('直接邻居持异 task 货物：持货优先，仍订阅并被推送（货物盖订阅者 task）', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.insertConveyorCargo('CV1', '3');
    h.apply('CV2', { task: 7, movement_x: 1 });
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.assetCode, 'CV2', '邻居持货即订阅并当帧被推送，不看货物 task');
    assert.equal(pushed.task, '7', '货物必须盖上订阅者的 task');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null);
  } finally {
    h.dispose();
  }
});

test('帧调度契约：applyWhenStale 仅自驱，帧尾无条件执行推送扫描', () => {
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
    /this\.conveyorDriver\.pushCargoToProbeSubscribers\(\)/,
    'applyFrame 帧尾必须执行探测点订阅推送扫描',
  );
});
