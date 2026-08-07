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
 * 输送线等待/交出协议测试的几何约定（与 harness bounds 对齐）：
 * 行走轴为局部 x（空 motion 配置缺省），货箱轴向长度 0.72，各设备跨度 4m → 行程半径 1.64。
 * 出货动画目标 = 1.64 + 0.72/2 = 2.0（正转方向，超出终点半程即停）。
 */
const SPAN_HALF = 2;
const CARGO_AXIAL = CONVEYOR_CARGO_SIZE.x;
const HALF_RANGE = resolveConveyorCargoTravelHalfRange(SPAN_HALF * 2, CARGO_AXIAL);
const PUSH_TARGET = HALF_RANGE + CARGO_AXIAL / 2;
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

/** 多输送线 harness：共享货物表与 collectModels 视图，setGeneratedCargoRootPose 落地到 root 供世界坐标断言。 */
function makeHarness(layout: Record<string, { centerX: number; autoDispose?: boolean }>) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const models = new Map<string, ModelRuntimeEntry>();
  const logs: string[] = [];

  for (const [assetCode, config] of Object.entries(layout)) {
    const root = new TransformNode(`${assetCode}_root`, scene);
    const model = {
      assetCode,
      root,
      contentRoot: root,
      meshes: [],
      conveyorTelemetry: createConveyorTelemetryState(),
      telemetryBinding: config.autoDispose === undefined ? null : { cargoAutoDispose: config.autoDispose },
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
      const centerX = layout[model.assetCode]?.centerX ?? 0;
      return {
        minimum: new Vector3(centerX - SPAN_HALF, 0, -0.5),
        maximum: new Vector3(centerX + SPAN_HALF, 1, 0.5),
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
    // 镜像 SpecializedTelemetryRuntime.adoptGlobalCargoByTask 的输送线表实现
    adoptGlobalCargoByTask: (task: string, claimingCargoKey: string) => {
      if (!task) return null;
      for (const [key, cargo] of [...state.conveyorCargoMeshes]) {
        if (key === claimingCargoKey || cargo.task !== task) continue;
        for (const model of models.values()) {
          const cargoCode = model.conveyorTelemetry.cargoCode;
          if (cargoCode !== null && JSON.stringify([model.assetCode, cargoCode]) === key) {
            model.conveyorTelemetry.cargoCode = null;
          }
        }
        state.conveyorCargoMeshes.delete(key);
        return cargo;
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
    apply: (assetCode: string, fields: Record<string, unknown>, deltaSeconds = 0.1, frames = 1, receivedAt?: number) => {
      const model = models.get(assetCode)!;
      for (let i = 0; i < frames; i += 1) {
        driver.applyToModel(model, makeSnapshot(assetCode, fields, receivedAt), deltaSeconds);
      }
    },
  };
}

/** 获取唯一货物的辅助：断言表中只有一份货物。 */
function onlyCargo(state: ReturnType<typeof createSpecializedTelemetrySharedState>): ConveyorCargoRuntimeEntry {
  assert.equal(state.conveyorCargoMeshes.size, 1, '货物表中必须恰好一份货物');
  return [...state.conveyorCargoMeshes.values()][0];
}

test('他设备输送线持有同 task 货物时放弃刷出进入等待', () => {
  const h = makeHarness({ CV1: { centerX: 5 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h.state.conveyorCargoMeshes.size, 1, 'CV2 必须先刷出货物');

    h.apply('CV1', { task: 7, movement_x: 1 });
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '等待方不得刷出第二份货物');
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '7', '必须登记等待 task');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.CV1.conveyorTelemetry.pendingTask, '7', 'pendingTask 保留，交出/退出后仍可按原 task 接管');
  } finally {
    h.dispose();
  }
});

test('等待方 mode=2 不退出等待（完成判定只看持有方），mode=0 仍退出', () => {
  const h = makeHarness({ CV1: { centerX: 5 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    h.apply('CV1', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '7');

    // 等待方 mode=2 不是任务完成：不退出等待、不放弃 pendingTask
    h.apply('CV1', { task: 7, movement_x: 0, mode: 2 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '7', '等待方 mode=2 不得退出等待');
    assert.equal(h.models.CV1.conveyorTelemetry.pendingTask, '7', '等待方 mode=2 不得放弃 pendingTask');

    // 持有方 mode=2 判定完成：仍交出给该等待者（等待方 mode=2 不影响接管资格）
    h.apply('CV2', { task: 7, movement_x: 0, mode: 2, front_has_goods: 0, back_has_goods: 0 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null, '被交出后等待结束');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, 'cargo', '等待方 mode=2 也必须能接管货物');

    // mode=0 仍退出等待并放弃 pendingTask
    h.apply('CV2', { task: 9, movement_x: 1 });
    h.apply('CV1', { task: 9, movement_x: 1 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '9', '前置：新 task 边沿重新进入等待');
    h.apply('CV1', { task: 9, movement_x: 0, mode: 0 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null, 'mode=0 必须退出等待');
    assert.equal(h.models.CV1.conveyorTelemetry.pendingTask, null, '退出等待必须一并放弃 pendingTask');
  } finally {
    h.dispose();
  }
});

test('等待中收到新 task 时旧等待作废，走新 task 自建流程', () => {
  const h = makeHarness({ CV1: { centerX: 5 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    h.apply('CV1', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '7');

    h.apply('CV1', { task: 9, movement_x: 1 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null, '新 task 边沿必须清掉旧等待');
    assert.equal(h.state.conveyorCargoMeshes.size, 2, '新 task 无持有方，必须自建货物');
    const own = [...h.state.conveyorCargoMeshes.values()].find((cargo) => cargo.assetCode === 'CV1');
    assert.ok(own, 'CV1 必须持有自建货物');
    assert.equal(own.task, '9');
  } finally {
    h.dispose();
  }
});

test('存在等待设备时持有方执行出货动画：向轨迹终点额外推进半个货箱长度', () => {
  const h = makeHarness({ CV1: { centerX: 5 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    const cargo = onlyCargo(h.state);

    // 无等待者：货物走到常规行程端即停住
    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 200);
    assert.ok(Math.abs(h.models.CV2.conveyorTelemetry.cargoTravelOffset - HALF_RANGE) < 1e-6,
      `无等待者时必须停在 halfRange=${HALF_RANGE}，实际 ${h.models.CV2.conveyorTelemetry.cargoTravelOffset}`);

    // 出现等待者：即使线体停止（movement_x=0）也向终点额外推进半个货箱长度
    h.apply('CV1', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '7');
    h.apply('CV2', { task: 7, movement_x: 0 }, 0.1, 200);
    const offset = h.models.CV2.conveyorTelemetry.cargoTravelOffset;
    assert.ok(Math.abs(offset - PUSH_TARGET) < 1e-6, `出货动画必须推进到 ${PUSH_TARGET}，实际 ${offset}`);
    assert.ok(Math.abs(cargo.root.position.x - PUSH_TARGET) < 1e-6, `货箱中心必须停在轨迹端点 x=${PUSH_TARGET}，实际 ${cargo.root.position.x}`);
    assert.ok(cargo.root.position.x + CARGO_AXIAL / 2 > SPAN_HALF, `货箱前半身必须越出持有方轨迹端点 x=${SPAN_HALF}`);
  } finally {
    h.dispose();
  }
});

test('出货动画期间收到释放逻辑立即移交，不等动画结束', () => {
  const h = makeHarness({ CV1: { centerX: 5 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 200);
    h.apply('CV1', { task: 7, movement_x: 1 });

    // 出货动画推进 5 帧（0.15m），仍在半程目标之下
    h.apply('CV2', { task: 7, movement_x: 0 }, 0.1, 5);
    const midOffset = h.models.CV2.conveyorTelemetry.cargoTravelOffset;
    assert.ok(midOffset > HALF_RANGE && midOffset < PUSH_TARGET, `前置：动画必须进行中（${HALF_RANGE} < ${midOffset} < ${PUSH_TARGET}）`);

    // 动画进行中收到 mode=2：立即释放
    h.apply('CV2', { task: 7, movement_x: 0, mode: 2, front_has_goods: 0, back_has_goods: 0 });
    const transferred = onlyCargo(h.state);
    assert.equal(transferred.assetCode, 'CV1', '动画期间收到释放必须立即移交');
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null);
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, 'cargo');
  } finally {
    h.dispose();
  }
});

test('持有方 mode=2 时交出货物：实例不销毁、换绑等待方，且交出优先于自动销毁', () => {
  const h = makeHarness({ CV1: { centerX: 5 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    const cargo = onlyCargo(h.state);
    const rootBefore = cargo.root;
    h.apply('CV1', { task: 7, movement_x: 1 });

    // CV2 默认开启自动销毁（binding 为 null）：有等待者时必须移交而非销毁
    h.apply('CV2', { task: 7, movement_x: 0, mode: 2, front_has_goods: 0, back_has_goods: 0 });

    const transferred = onlyCargo(h.state);
    assert.equal(transferred.root, rootBefore, '货物实例必须保持不销毁');
    assert.equal(transferred.assetCode, 'CV1', '货物必须换绑到等待方');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, null, '持有方引用必须清空');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, 'cargo', '等待方必须接管货物身份');
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null, '等待标记必须清除');
    assert.equal(h.models.CV1.conveyorTelemetry.pendingTask, null);
    assert.ok(Math.abs(h.models.CV1.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE)) < 1e-6,
      `等待方必须从自身刷出端继续走行，实际 ${h.models.CV1.conveyorTelemetry.cargoTravelOffset}`);
    assert.ok(transferred.handoff, '必须登记交接插值保持视觉连续');
    assert.ok(h.logs.some((message) => message.includes('CV2') && message.includes('CV1') && message.includes('task=7')),
      '必须输出移交日志');
  } finally {
    h.dispose();
  }
});

test('持有方收到新 task 时交出旧 task 货物，新 task 当帧即刷出', () => {
  const h = makeHarness({ CV1: { centerX: 5 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    h.apply('CV1', { task: 7, movement_x: 1 });

    h.apply('CV2', { task: 8, movement_x: 0 });
    const transferred = [...h.state.conveyorCargoMeshes.values()].find((cargo) => cargo.task === '7');
    assert.ok(transferred, '旧 task 货物必须存在');
    assert.equal(transferred.assetCode, 'CV1', '新 task 边沿必须把旧 task 货物交给等待方');
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null);

    // 新 task 边沿当帧即刷出（不再等 movement_x 非 0）：movement_x=0 按正转刷在起点并自驱推进
    assert.equal(h.models.CV2.conveyorTelemetry.currentTask, '8');
    assert.equal(h.models.CV2.conveyorTelemetry.pendingTask, null, '新 task 当帧即刷出，pendingTask 已消费');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, 'cargo', '持有方必须持有新 task 货物');
    assert.equal(h.models.CV2.conveyorTelemetry.selfDriveDirection, 1, 'movement_x=0 刷出必须登记正转自驱');
    const spawned = [...h.state.conveyorCargoMeshes.values()].find((cargo) => cargo.assetCode === 'CV2');
    assert.ok(spawned);
    assert.equal(spawned.task, '8');
    assert.ok(
      Math.abs(h.models.CV2.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE + 0.3 * 0.1)) < 1e-6,
      `新箱必须刷在轨迹起点并当帧自驱推进，实际 ${h.models.CV2.conveyorTelemetry.cargoTravelOffset}`,
    );
  } finally {
    h.dispose();
  }
});

test('多台等待设备时由上货坐标距货物世界坐标最近者接管', () => {
  const h = makeHarness({ CV1: { centerX: -5 }, CV2: { centerX: 0 }, CV3: { centerX: 5 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    // 两台下游都在等待：CV1 上货点 x=-6.64，CV3 上货点 x=+3.36
    h.apply('CV1', { task: 7, movement_x: 1 });
    h.apply('CV3', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '7');
    assert.equal(h.models.CV3.conveyorTelemetry.waitingTask, '7');

    // 出货动画把货物推到 x≈+2.0，距 CV3 上货点（3.36）更近
    h.apply('CV2', { task: 7, movement_x: 0 }, 0.1, 200);
    h.apply('CV2', { task: 7, movement_x: 0, mode: 2, front_has_goods: 0, back_has_goods: 0 });

    const transferred = onlyCargo(h.state);
    assert.equal(transferred.assetCode, 'CV3', '货物必须由世界坐标最近的等待设备接管');
    assert.equal(h.models.CV3.conveyorTelemetry.waitingTask, null);
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '7', '未被选中的等待设备继续保持等待');
  } finally {
    h.dispose();
  }
});

test('等待中本机已有货物保持静止；被交出时遗留箱销毁、新箱接管', () => {
  const h = makeHarness({ CV1: { centerX: 5, autoDispose: false }, CV2: { centerX: 0 } });
  try {
    // CV1 先持有 task=3 的货物并走行一段
    h.apply('CV1', { task: 3, movement_x: 1 }, 0.1, 10);
    const ownCargo = [...h.state.conveyorCargoMeshes.values()].find((cargo) => cargo.assetCode === 'CV1')!;
    const frozenOffset = h.models.CV1.conveyorTelemetry.cargoTravelOffset;

    // CV2 持有 task=7，CV1 收 task=7 进入等待
    h.apply('CV2', { task: 7, movement_x: 1 });
    h.apply('CV1', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '7');

    // 等待中本机已有货物不得继续走行
    h.apply('CV1', { task: 7, movement_x: 1 }, 0.1, 10);
    assert.equal(h.models.CV1.conveyorTelemetry.cargoTravelOffset, frozenOffset, '等待中本机货物必须静止');

    // 持有方交出：CV1 的遗留箱销毁，task=7 货物接管
    h.apply('CV2', { task: 7, movement_x: 0, mode: 2, front_has_goods: 0, back_has_goods: 0 });
    const transferred = onlyCargo(h.state);
    assert.equal(transferred.assetCode, 'CV1');
    assert.equal(transferred.task, '7');
    assert.notEqual(transferred.root, ownCargo.root, '遗留箱必须被销毁，由 task=7 货物替换');
  } finally {
    h.dispose();
  }
});

test('接管后断流期间按接管方向自驱走行，新消息到达即恢复字段驱动', () => {
  const h = makeHarness({ CV1: { centerX: 5 }, CV2: { centerX: 0 } });
  try {
    const stamp = 1_000_000;
    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 1, stamp);
    h.apply('CV1', { task: 7, movement_x: 1 }, 0.1, 1, stamp);
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '7');

    // 持有方收新消息 mode=2 → 交出；CV1 接管时登记自驱方向
    h.apply('CV2', { task: 7, movement_x: 0, mode: 2, front_has_goods: 0, back_has_goods: 0 }, 0.1, 1, stamp + 1);
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, 'cargo', '前置：CV1 必须已接管货物');
    assert.equal(h.models.CV1.conveyorTelemetry.selfDriveDirection, 1, '接管必须登记自驱方向');
    const takeoverOffset = h.models.CV1.conveyorTelemetry.cargoTravelOffset;
    assert.ok(Math.abs(takeoverOffset - (-HALF_RANGE)) < 1e-6, '接管起点必须为刷出端');

    // 断流重放（同一 receivedAt，缓存 movement_x=0）：自驱仍按接管方向推进
    h.apply('CV1', { task: 7, movement_x: 0 }, 0.1, 10, stamp);
    const selfDrivenOffset = h.models.CV1.conveyorTelemetry.cargoTravelOffset;
    assert.ok(
      Math.abs(selfDrivenOffset - (takeoverOffset + CARGO_SPEED * 0.1 * 10)) < 1e-6,
      `自驱必须按走行速度推进到 ${takeoverOffset + CARGO_SPEED * 0.1 * 10}，实际 ${selfDrivenOffset}`,
    );
    assert.equal(h.models.CV1.conveyorTelemetry.selfDriveDirection, 1, '断流重放不得清零自驱');

    // 新消息到达（receivedAt 变化）：自驱结束，movement_x=0 即停车
    h.apply('CV1', { task: 7, movement_x: 0 }, 0.1, 10, stamp + 2);
    assert.equal(h.models.CV1.conveyorTelemetry.selfDriveDirection, 0, '新消息必须结束自驱');
    assert.ok(
      Math.abs(h.models.CV1.conveyorTelemetry.cargoTravelOffset - selfDrivenOffset) < 1e-6,
      '新消息 movement_x=0 必须立即停车',
    );
  } finally {
    h.dispose();
  }
});

test('帧调度在快照断流时仍驱动处于接管自驱的输送线', () => {
  const source = readFileSync('src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime.ts', 'utf8');
  const conveyorRegistration = source.match(/deviceType: 'conveyor',[\s\S]*?\},\r?\n/);
  assert.ok(conveyorRegistration, '必须存在 conveyor 驱动注册项');
  assert.match(
    conveyorRegistration[0],
    /applyWhenStale: \(model\) => \(model\.conveyorTelemetry\?\.selfDriveDirection \?\? 0\) !== 0/,
    'conveyor 注册必须声明断流自驱判定',
  );
  assert.match(
    source,
    /!frame\.stale \|\| \(driver\.applyWhenStale\?\.\(candidate\.model\) \?\? false\)/,
    'applyFrame 必须在快照断流且驱动声明自驱时仍应用缓存快照',
  );
});
