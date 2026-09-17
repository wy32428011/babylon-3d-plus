import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshBuilder, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { ShuttleTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/shuttleDriver';
import { createShuttleTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { createSpecializedTelemetrySharedState } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

function makeSnapshot(fields: Record<string, unknown>): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'shuttle',
    assetCode: 'SH1',
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
    aisleCode?: string;
    deviceAssetCode?: string;
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
    deviceAssetCode: options.deviceAssetCode ?? '',
    aisleCode: options.aisleCode ?? 'A1',
    rowNumber: 2,
    storageDepth: 'near',
  } as unknown as LocatorRuntimeEntry;
}

function makeHarness() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const root = new TransformNode('shuttle_root', scene);
  const model = {
    assetCode: 'SH1',
    root,
    contentRoot: root,
    meshes: [],
    shuttleTelemetry: createShuttleTelemetryState(root),
    telemetryBinding: null,
    externalScriptRuntime: null,
    entitySnapshot: {
      id: 'e1',
      components: { modelAsset: { parameterValues: { aisleCode: 'A1' } } },
    },
  } as unknown as ModelRuntimeEntry;

  const ref: { locator: LocatorRuntimeEntry | null } = { locator: null };
  const logs: string[] = [];
  // 与 SceneRuntime.findLocatorByDevice/findLocatorByAisle 同规则：绑定一致 + 排号一致且列/层落在货格范围内才命中
  const matchLocator = (locator: LocatorRuntimeEntry, x: number, y: number, z: number) => {
    if (locator.rowNumber !== z) return null;
    return x >= locator.startColumn && x < locator.startColumn + locator.columns && y >= locator.startLayer && y < locator.startLayer + locator.layers
      ? locator
      : null;
  };
  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [{ entityId: 'e1', model }],
    findLocatorByDevice: (assetCode: string, x: number, y: number, z: number) => {
      const locator = ref.locator;
      if (!locator || locator.deviceAssetCode !== assetCode || !assetCode) return null;
      return matchLocator(locator, x, y, z);
    },
    findLocatorsByDevice: (assetCode: string) => (ref.locator && ref.locator.deviceAssetCode === assetCode && assetCode ? [ref.locator] : []),
    findLocatorByAisle: (aisleCode: string, x: number, y: number, z: number) => {
      const locator = ref.locator;
      if (!locator || locator.aisleCode !== aisleCode) return null;
      return matchLocator(locator, x, y, z);
    },
    findLocatorsByAisle: (aisleCode: string) => (ref.locator && ref.locator.aisleCode === aisleCode ? [ref.locator] : []),
    resolveBuiltInSlotHost: () => null,
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
    getModelWorldBounds: () => ({ minimum: new Vector3(-0.5, 0, -0.5), maximum: new Vector3(0.5, 0.5, 0.5) }),
  };
  const context = {
    scene,
    state,
    host,
    disposeShuttleCargo: () => undefined,
    getOrCreateShuttleCargo: () => { throw new Error('not used'); },
    adoptGlobalCargoByTask: () => null,
    adoptConveyorPlatformCargo: () => null,
    placeShuttleCargoIntoConveyorPlatform: (_locatorEntityId: string, _cargoKey: string) => false,
  };
  const driver = new ShuttleTelemetryDriver(context as never);
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

/** 为模型补齐多穿小车货叉几何：二段叉 huocha1（叉面中心 (0, 0.25, 0)，叉顶面 y=0.30），可选一段叉 duan1、载货平面三板（对象020/021/022，包围盒顶面 y=0.40）。 */
function makeShuttleGeometry(h: ReturnType<typeof makeHarness>, withStage1 = false, withDeck = false): void {
  const root = h.model.root;
  const fork = MeshBuilder.CreateBox('huocha1', { width: 0.4, height: 0.1, depth: 0.4 }, h.scene);
  fork.parent = root;
  fork.position.set(0, 0.25, 0);
  if (withStage1) {
    const stage1 = MeshBuilder.CreateBox('duan1', { width: 0.2, height: 0.1, depth: 0.4 }, h.scene);
    stage1.parent = root;
    stage1.position.set(0, 0.1, 0);
  }
  if (withDeck) {
    // 环抱机构载货台：三块台面板件，顶面 y=0.40（高于叉顶面 0.30，用于区分竖直基准）
    ['对象020', '对象021', '对象022'].forEach((name, index) => {
      const deck = MeshBuilder.CreateBox(name, { width: 0.3, height: 0.1, depth: 0.5 }, h.scene);
      deck.parent = root;
      deck.position.set((index - 1) * 0.2, 0.35, 0);
    });
  }
  root.computeWorldMatrix(true);
}

/** 声明两段货叉节点分组与载货平面节点（与模型包 meta.json 的 dataDriven.motion 同构）。 */
function declareShuttleMotion(h: ReturnType<typeof makeHarness>): void {
  (h.model as { externalScriptRuntime: unknown }).externalScriptRuntime = {
    getDataDrivenConfigs: () => [{
      motion: {
        cargoDeckNodes: ['对象020', '对象021', '对象022'],
        fork: { stage2Nodes: ['huocha1'], stage1Nodes: ['duan1'] },
      },
    }],
  };
}

/**
 * 新协议帧：x/y 仅诊断；to_x/to_y 列层 + to_Depth 位值（1/2/4/8 → 排 1-4）指向当前阶段目标格；
 * Status：0 待机 / 1 装货 / 2 卸货 / 3 移动中。Locator 排号固定 2 → to_Depth=2。
 */
function targetFrame(status: number, toX: number, toY: number, toDepth = 2, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { x: 0, y: 0, to_x: toX, to_y: toY, to_Depth: toDepth, Status: status, errorCode: 0, ...extra };
}

test('货格匹配：绑定巷道一致 + 列层范围命中才动作，失配一次性报错并冻结', () => {
  const h = makeHarness();
  try {
    // 货格巷道 A2 ≠ 小车参数 A1：目标位失配，报错一次且整机不动
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, aisleCode: 'A2', rootPosition: new Vector3(0, 2, 11) });
    const MOVE = targetFrame(3, 10, 1);
    h.apply(MOVE);
    h.apply(MOVE);
    const errors = h.logs.filter((message) => message.includes('未匹配到任何已绑定货格'));
    assert.equal(errors.length, 1, '同一目标位重复上报只能报错一次');
    assert.ok(errors[0].includes('巷道A1') && errors[0].includes('排2 列10 层1'), `报错须含巷道/排/列/层，实际：${errors[0]}`);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z) < 1e-9, '巷道失配时不得移动');

    // 巷道改回 A1：命中并吸附到货格支撑位（列 10 → z=20）
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, aisleCode: 'A1', rootPosition: new Vector3(0, 2, 11) });
    h.apply(MOVE, 0.1, 1);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6, `首帧必须吸附到 z=20，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);
  } finally {
    h.dispose();
  }
});

test('货格匹配：绑定设备（deviceAssetCode）命中时无需巷道匹配', () => {
  const h = makeHarness();
  try {
    // 货格绑定设备 SH1，巷道 A9 ≠ 小车参数 A1：设备路径优先命中
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, aisleCode: 'A9', deviceAssetCode: 'SH1', rootPosition: new Vector3(0, 2, 11) });
    h.apply(targetFrame(3, 10, 1), 0.1, 1);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6, '绑定设备货格必须命中并吸附');
    assert.equal(h.logs.filter((message) => message.includes('未匹配到任何已绑定货格')).length, 0, '设备命中不得报失配');
  } finally {
    h.dispose();
  }
});

test('绑定设备与巷道都无货格时报错一次，整机保持不动', () => {
  const h = makeHarness();
  try {
    (h.model.entitySnapshot as { components: { modelAsset: { parameterValues: Record<string, unknown> } } })
      .components.modelAsset.parameterValues = {};
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, aisleCode: 'A2', rootPosition: new Vector3(0, 2, 11) });
    const MOVE = targetFrame(3, 10, 1);
    h.apply(MOVE);
    h.apply(MOVE);
    const errors = h.logs.filter((message) => message.includes('未匹配到任何已绑定货格'));
    assert.equal(errors.length, 1, '无货格可匹配只能报错一次');
    assert.ok(errors[0].includes('巷道未配置'), `未配置巷道时报错须体现，实际：${errors[0]}`);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z) < 1e-9, '无货格匹配时不得移动');
  } finally {
    h.dispose();
  }
});

test('Status=3 走行：向目标格连续推进并收敛，Status=0 停驻', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 3, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    // 目标列 10（支撑位 z=20）：首帧吸附到位
    h.apply(targetFrame(3, 10, 1), 0.1, 1);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6);

    // 目标列 5（支撑位 z=15）：走行必须立即连续移动并最终收敛
    const MOVE5 = targetFrame(3, 5, 1);
    h.apply(MOVE5, 0.1, 1);
    const zAfter1 = h.model.shuttleTelemetry.rootPosition!.z;
    assert.ok(zAfter1 < 20 && zAfter1 > 15, `走行必须立即向列 5 连续移动，实际 z=${zAfter1}`);
    h.apply(MOVE5, 0.1, 400);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 15) < 1e-6, `必须收敛到目标列 5 支撑位 z=15，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);

    // 任务完结 to_ 清零且 Status=0：车体停驻保持原位
    h.apply(targetFrame(0, 0, 0, 0), 0.1, 5);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 15) < 1e-6, 'Status=0 且无目标时必须保持原位');
  } finally {
    h.dispose();
  }
});

test('目标位失配与非法 to_Depth：冻结走行并各一次性告警', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(targetFrame(3, 10, 1), 0.1, 1);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6);

    const BAD_CELL = targetFrame(3, 99, 1);
    h.apply(BAD_CELL, 0.1, 10);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6, '目标位失配必须冻结走行');
    assert.equal(
      h.logs.filter((message) => message.includes('目标位') && message.includes('列99')).length,
      1,
      '目标位失配告警必须只报一次',
    );

    const BAD_DEPTH = targetFrame(3, 5, 1, 3);
    h.apply(BAD_DEPTH, 0.1, 10);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6, 'to_Depth 非法必须冻结走行');
    assert.equal(
      h.logs.filter((message) => message.includes('to_Depth=3 非法')).length,
      1,
      'to_Depth 非法告警必须只报一次',
    );
  } finally {
    h.dispose();
  }
});

test('装货（Status=1）：到位自动伸叉刷货，伸满绑定上叉，自动收回完结且同相位不重复', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    // 列沿世界 +X 排布：列 10 支撑位在 (20, 2, 0)，叉收回位中心 x=0
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(11, 2, 0), rootRotationY: 0 });
    const FETCH = targetFrame(1, 10, 1, 2, { task: 7001 });

    // 到位（首帧吸附）后自动进入伸叉相位并刷出货物，货物暂留货格
    h.apply(FETCH, 0.1, 1);
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '装货相位开始必须刷出货物');
    assert.equal(h.model.shuttleTelemetry.forkPhase, 'extending', '到位后必须自动进入伸叉相位');
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, false, '伸叉未到位前货物不得绑定');

    // 60 帧 × 0.25 m/s × 0.1s = 1.5m：越过叉模型全长 0.4m 继续伸出（不钳位），货格在 +x 侧即朝 +x 伸
    h.apply(FETCH, 0.1, 59);
    assert.ok(Math.abs(h.model.shuttleTelemetry.forkOffset - 1.5) < 1e-6, `伸叉必须越过叉长 0.4，实际 ${h.model.shuttleTelemetry.forkOffset}`);
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, false, '未伸满前货物保持滞留货格');

    // 再 800 帧：伸满（20m）绑定上叉后自动收回 60 帧（1.5m）
    h.apply(FETCH, 0.1, 800);
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '伸叉到位必须绑定货物上叉');
    assert.equal(h.model.shuttleTelemetry.forkPhase, 'retracting', '伸满后必须自动收回');
    assert.ok(Math.abs(h.model.shuttleTelemetry.forkOffset - 18.5) < 1e-6, `收回中偏移实际 ${h.model.shuttleTelemetry.forkOffset}`);

    // 再 800 帧：收回归零，相位完结，货物随叉带回
    h.apply(FETCH, 0.1, 800);
    assert.equal(h.model.shuttleTelemetry.forkOffset, 0, '收叉必须归零');
    assert.equal(h.model.shuttleTelemetry.forkPhase, 'idle');
    assert.equal(h.model.shuttleTelemetry.statusActionDone, true, '相位完结必须置动作完成');
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '装货完结后货物保持绑定随叉');
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '货物必须保留在小车上');

    // 同相位持续上报：不得重复刷货/伸叉
    h.apply(FETCH, 0.1, 20);
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '同相位不得重复刷货');
    assert.equal(h.model.shuttleTelemetry.forkOffset, 0, '同相位不得重复伸叉');

    // Status=1→3 伴随目标格跳变（行走开始）：已绑定货物随叉随行，不得进入 catch-up 也不得销毁
    h.apply(targetFrame(3, 5, 1, 2, { task: 7001 }), 0.1, 1);
    assert.equal(h.model.shuttleTelemetry.forkCatchUp, false, '已绑定货物随行不得进入 catch-up');
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '目标格跳变不得销毁已绑定货物');
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '货物必须保持绑定随叉随行');
  } finally {
    h.dispose();
  }
});

test('伸叉方向由货格几何决定：货格在 −x 侧时装货必须朝 −x 伸', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    // 列沿世界 +X 排布但货格在负侧：列 10 支撑位在 (−20, 2, 0)
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(-29, 2, 0), rootRotationY: 0 });
    const FETCH = targetFrame(1, 10, 1);

    h.apply(FETCH, 0.1, 60);
    assert.ok(Math.abs(h.model.shuttleTelemetry.forkOffset + 1.5) < 1e-6, `货格在 −x 侧必须朝 −x 伸出，实际 ${h.model.shuttleTelemetry.forkOffset}`);

    h.apply(FETCH, 0.1, 800);
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '伸满后必须绑定');
    assert.ok(Math.abs(h.model.shuttleTelemetry.forkOffset + 18.5) < 1e-6, `收回中偏移实际 ${h.model.shuttleTelemetry.forkOffset}`);
  } finally {
    h.dispose();
  }
});

test('Y 层闪现：每帧对齐目标格层高，二段叉顶面与货格底面持平', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    // 层距 1m、底层 y=2：层 2 支撑位 y=3，层 1 支撑位 y=2
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 3, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });

    // 目标层 2：叉顶面（收回位 y=0.30）必须闪现到 y=3（叉面中心 2.95）
    h.apply(targetFrame(3, 10, 2), 0.1, 1);
    const fork = h.scene.getMeshByName('huocha1')!;
    assert.ok(Math.abs(fork.position.y - 2.95) < 1e-6, `层 2 闪现后叉面中心 y 必须为 2.95，实际 ${fork.position.y}`);
    assert.ok(Math.abs(fork.position.z - 20) < 1e-6, `同时必须吸附到目标列 z=20，实际 ${fork.position.z}`);

    // 目标层跳到层 1：直接闪现，无竖直动画
    h.apply(targetFrame(3, 10, 1), 0.1, 1);
    assert.ok(Math.abs(fork.position.y - 1.95) < 1e-6, `层变换必须直接闪现到叉面中心 y=1.95，实际 ${fork.position.y}`);
  } finally {
    h.dispose();
  }
});

test('环抱式载货：载货平面顶面（cargoDeckNodes）替代叉顶面作为竖直基准，货物底面贴载货平面', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h, false, true);
    declareShuttleMotion(h);
    // 层距 1m、底层 y=2：层 2 支撑位 y=3
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 3, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });

    // 目标层 2：载货平面顶面（收回位 y=0.40）闪现到 y=3 → 整车 Y 偏移 2.60，叉面中心 y=2.85（非托起基准的 2.95）
    h.apply(targetFrame(3, 10, 2), 0.1, 1);
    const fork = h.scene.getMeshByName('huocha1')!;
    assert.ok(Math.abs(fork.position.y - 2.85) < 1e-6, `层 2 闪现须以载货平面顶面对齐（叉面中心 y=2.85），实际 ${fork.position.y}`);
    const deck = h.scene.getMeshByName('对象020')!;
    assert.ok(Math.abs(deck.position.y - 2.95) < 1e-6, `载货平面中心 y 必须为 2.95（顶面 3.0 贴支撑位），实际 ${deck.position.y}`);

    // 装货全流程：货物底面贴载货平面顶面（=货格支撑位 y=3），交接无跳变
    const FETCH = targetFrame(1, 10, 2, 2, { task: 7008 });
    h.apply(FETCH, 0.1, 1);
    assert.equal(h.model.shuttleTelemetry.forkPhase, 'extending', '到位后必须自动进入伸叉相位');
    h.apply(FETCH, 0.1, 800);
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '伸叉到位必须绑定货物上叉');
    const cargo = [...h.state.shuttleCargoMeshes.values()][0];
    assert.ok(Math.abs(cargo.root.position.y - 3) < 1e-6, `绑定后货物底面必须贴载货平面顶面 y=3，实际 ${cargo.root.position.y}`);

    // 收回完结：货物随叉保持 y=3（环抱：底面高于叉顶面 0.10，叉不托底）
    h.apply(FETCH, 0.1, 800);
    assert.equal(h.model.shuttleTelemetry.forkOffset, 0, '收叉必须归零');
    assert.ok(Math.abs(cargo.root.position.y - 3) < 1e-6, `收回后货物底面必须保持载货平面顶面 y=3，实际 ${cargo.root.position.y}`);
    assert.ok(Math.abs(fork.position.y - 2.85) < 1e-6, `收回后叉面中心必须保持 y=2.85，实际 ${fork.position.y}`);
  } finally {
    h.dispose();
  }
});

test('两段货叉比例联动：一段偏移恒为二段一半，同步启动同步到位', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h, true);
    declareShuttleMotion(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(11, 2, 0), rootRotationY: 0 });

    // 40 帧 × 0.025m = 二段伸出 1.0m（目标行程 20m，仍在伸出中）
    h.apply(targetFrame(1, 10, 1), 0.1, 40);
    assert.ok(Math.abs(h.model.shuttleTelemetry.forkOffset - 1.0) < 1e-6, `二段偏移实际 ${h.model.shuttleTelemetry.forkOffset}`);
    const stage2 = h.scene.getMeshByName('huocha1')!;
    const stage1 = h.scene.getMeshByName('duan1')!;
    assert.ok(Math.abs(stage2.position.x - 1.0) < 1e-6, `二段节点必须偏移 1.0，实际 ${stage2.position.x}`);
    assert.ok(Math.abs(stage1.position.x - 0.5) < 1e-6, `一段节点必须偏移二段一半 0.5，实际 ${stage1.position.x}`);
  } finally {
    h.dispose();
  }
});

test('目标格跳变 catch-up：货叉加速收回原点后才允许走行', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });

    // 装货伸叉途中（8 帧 × 0.025m = 0.2m，未伸满未绑定）
    const FETCH = targetFrame(1, 10, 1, 2, { task: 7002 });
    h.apply(FETCH, 0.1, 8);
    assert.ok(h.model.shuttleTelemetry.forkOffset > 0.05, '货叉必须已伸出');
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, false);

    // 目标格跳到列 5 且 Status=3（设备转场）：进入 catch-up，收叉期间整机冻结
    const MOVE5 = targetFrame(3, 5, 1, 2, { task: 7002 });
    h.apply(MOVE5, 0.1, 1);
    assert.equal(h.model.shuttleTelemetry.forkCatchUp, true, '目标格跳变且货叉已伸出必须进入 catch-up');
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-9, '收叉期间走行必须冻结');

    // 加速收叉（0.25m/s × 4 倍率）迅速归零并退出 catch-up
    h.apply(MOVE5, 0.1, 10);
    assert.equal(h.model.shuttleTelemetry.forkOffset, 0);
    assert.equal(h.model.shuttleTelemetry.forkCatchUp, false);

    // 退出 catch-up 后向新目标格（列 5，支撑位 z=15）走行，已兜底绑定的货物随叉随行
    h.apply(MOVE5, 0.1, 400);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 15) < 1e-6, `收叉完成后必须走到新货格 z=15，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '转场不得销毁货物');
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, 'catch-up 必须兜底绑定货物');
  } finally {
    h.dispose();
  }
});

test('卸货（Status=2）：补建绑定、伸满解绑落格、收回完结销毁，同相位不重复补建', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    // 列 10 支撑位 (0, 2, 20)：货格正对叉中心，伸叉行程回退叉全长 0.4m
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    const PLACE = targetFrame(2, 10, 1, 2, { task: 7003 });

    // 卸货相位入口补建叉上货物并立即绑定
    h.apply(PLACE, 0.1, 1);
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '卸货相位必须补建叉上货物');
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '卸货补建货物必须立即绑定');

    // 伸出途中（11 帧 ≈ 0.275m，未达 0.4m 行程）：货物保持绑定
    h.apply(PLACE, 0.1, 10);
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '未达行程前货物必须保持绑定');

    // 再 10 帧：伸满（16 帧 × 0.025m = 0.4m）解绑落货，货物留在目标箱位支撑位
    h.apply(PLACE, 0.1, 10);
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, false, '伸满必须解绑落货');
    assert.notEqual(h.model.shuttleTelemetry.cargoHoldPosition, null, '解绑后货物必须留存目标箱位支撑位');
    const cargo = [...h.state.shuttleCargoMeshes.values()][0];
    assert.ok(
      Vector3.Distance(cargo.root.position, new Vector3(0, 2, 20)) < 1e-6,
      `货物必须静止于目标箱位支撑位 (0,2,20)，实际 ${cargo.root.position}`,
    );

    // 继续收叉至归零：相位完结，非 fetch 保留路径货物销毁
    h.apply(PLACE, 0.1, 30);
    assert.equal(h.model.shuttleTelemetry.forkOffset, 0, '收叉必须归零');
    assert.equal(h.model.shuttleTelemetry.statusActionDone, true);
    assert.equal(h.state.shuttleCargoMeshes.size, 0, '卸货完成后货物必须销毁');
    assert.equal(h.model.shuttleTelemetry.cargoKey, null, '卸货完成后货物引用必须清空');

    // 同相位持续上报：不得重复补建
    h.apply(PLACE, 0.1, 10);
    assert.equal(h.state.shuttleCargoMeshes.size, 0, '同相位不得重复补建货物');
  } finally {
    h.dispose();
  }
});

test('卸货到 conveyor 站台：落货当场交付（placeShuttleCargoIntoConveyorPlatform），不补建第二个货物', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    // 模拟交接成功：与 SpecializedTelemetryRuntime.placeShuttleCargoIntoConveyorPlatform 同语义，摘除货物并清理引用
    h.context.placeShuttleCargoIntoConveyorPlatform = (_locatorEntityId: string, cargoKey: string) => {
      h.driver.detachClaimedCargoByKey(cargoKey);
      return true;
    };
    const PLACE = targetFrame(2, 10, 1, 2, { task: 7007 });

    h.apply(PLACE, 0.1, 1);
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '卸货相位必须补建叉上货物');

    // 伸满解绑落货：当场交接给 conveyor，货物离开 shuttle 货物表
    h.apply(PLACE, 0.1, 20);
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, false, '伸满必须解绑落货');
    assert.equal(h.state.shuttleCargoMeshes.size, 0, '落货当场交接成功后货物必须离开 shuttle 货物表');
    assert.equal(h.model.shuttleTelemetry.cargoKey, null, '交接成功后货物引用必须清空');

    // 后续收叉帧：不得因 cargoKey 为空而补建第二个货物
    h.apply(PLACE, 0.1, 10);
    assert.equal(h.state.shuttleCargoMeshes.size, 0, '交接成功后不得补建第二个货物');
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, false, '叉上不得再有绑定货物');
  } finally {
    h.dispose();
  }
});
