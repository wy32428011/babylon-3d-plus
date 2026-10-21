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
    rowNumber?: number;
    storageDepth?: 'near' | 'far';
    cellSteps?: { columnStepX: number; layerStepY: number };
    rootPosition?: Vector3;
    rootRotationY?: number;
    kind?: 'slot' | 'layerChangePlatform';
    platformTrackEndWorld?: Vector3 | null;
    retainCargo?: boolean;
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
    rowNumber: options.rowNumber ?? 2,
    storageDepth: options.storageDepth ?? 'near',
    kind: options.kind ?? 'slot',
    platformTrackEndWorld: options.platformTrackEndWorld ?? null,
    retainCargo: options.retainCargo === true,
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

  const ref: {
    locator: LocatorRuntimeEntry | null;
    extraLocators: LocatorRuntimeEntry[];
    /** 非 null 时模拟 fetch 驱动货格：抑制/留存方法返回该排号。 */
    fetchRow?: number | null;
    retainedCells: Array<[number, number]>;
    releasedCells: Array<[number, number]>;
    rowSyncs: number[];
    disposedShuttleCargos: unknown[];
  } = { locator: null, extraLocators: [], retainedCells: [], releasedCells: [], rowSyncs: [], disposedShuttleCargos: [] };
  const logs: string[] = [];
  const activeLocators = (): LocatorRuntimeEntry[] => (ref.locator ? [ref.locator, ...ref.extraLocators] : [...ref.extraLocators]);
  // 与 SceneRuntime.findLocatorByDevice/findLocatorByAisle 同规则：绑定一致 + 排号一致 + 排深一致（传值时）+ 列/层落在范围内，且唯一命中（多个命中返回 null）
  const matchLocator = (locator: LocatorRuntimeEntry, x: number, y: number, z: number, storageDepth?: 'near' | 'far') => {
    if (locator.rowNumber !== z) return null;
    if (storageDepth && locator.storageDepth !== storageDepth) return null;
    return x >= locator.startColumn && x < locator.startColumn + locator.columns && y >= locator.startLayer && y < locator.startLayer + locator.layers
      ? locator
      : null;
  };
  const findOne = (
    pick: (locator: LocatorRuntimeEntry) => boolean,
    x: number,
    y: number,
    z: number,
    storageDepth?: 'near' | 'far',
  ): LocatorRuntimeEntry | null => {
    let matched: LocatorRuntimeEntry | null = null;
    for (const locator of activeLocators()) {
      if (!pick(locator)) continue;
      if (!matchLocator(locator, x, y, z, storageDepth)) continue;
      if (matched) return null;
      matched = locator;
    }
    return matched;
  };
  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [{ entityId: 'e1', model }],
    findLocatorByDevice: (assetCode: string, x: number, y: number, z: number, storageDepth?: 'near' | 'far') =>
      (assetCode ? findOne((locator) => locator.deviceAssetCode === assetCode, x, y, z, storageDepth) : null),
    findLocatorsByDevice: (assetCode: string) => (assetCode ? activeLocators().filter((locator) => locator.deviceAssetCode === assetCode) : []),
    findLocatorByAisle: (aisleCode: string, x: number, y: number, z: number, storageDepth?: 'near' | 'far') =>
      findOne((locator) => locator.aisleCode === aisleCode, x, y, z, storageDepth),
    findLocatorsByAisle: (aisleCode: string) => activeLocators().filter((locator) => locator.aisleCode === aisleCode),
    findLayerChangePlatformLocator: (assetCode: string, aisleCode: string) => {
      let aisleMatch: LocatorRuntimeEntry | null = null;
      for (const entry of activeLocators()) {
        if (entry.kind !== 'layerChangePlatform') continue;
        if (assetCode && entry.deviceAssetCode === assetCode) return entry;
        if (!aisleMatch && aisleCode && entry.aisleCode === aisleCode) aisleMatch = entry;
      }
      return aisleMatch;
    },
    resolveBuiltInSlotHost: () => null,
    resolveCargoGeneratorForModel: () => null,
    resolveColumnTargetPose: () => null,
    resolveFetchDriveRowForLocator: () => ref.fetchRow ?? null,
    suppressFetchCellForLocator: () => ref.fetchRow ?? null,
    retainFetchCellForLocator: (_locator: LocatorRuntimeEntry, column: number, layer: number) => {
      ref.retainedCells.push([column, layer]);
      return ref.fetchRow ?? null;
    },
    releaseRetainedFetchCellForLocator: (_locator: LocatorRuntimeEntry, column: number, layer: number) => {
      ref.releasedCells.push([column, layer]);
    },
    handleFetchRowSync: (row: number) => { ref.rowSyncs.push(row); },
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
    disposeShuttleCargo: (cargo: unknown) => { ref.disposedShuttleCargos.push(cargo); },
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
 * 新协议帧：x/y 仅诊断；to_x/to_y/to_z 列/层/排 + to_Depth 排深（2 浅库位 / 8 深库位）指向当前阶段目标格；
 * Status：0 待机 / 1 取货中 / 2 取货完成 / 3 卸货中 / 4 卸货完成 / 5 移动中 / 6 移动完成 / 10 急停 / 11 未知。
 * _finish 事件不保证送达，测试主要走 1→5→3 的非 finish 转场。Locator 排号固定 2、排深 near → to_z=2, to_Depth=2。
 */
function targetFrame(status: number, toX: number, toY: number, toZ = 2, toDepth = 2, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { x: 0, y: 0, to_x: toX, to_y: toY, to_z: toZ, to_Depth: toDepth, Status: status, errorCode: 0, ...extra };
}

test('货格匹配：绑定巷道一致 + 列层范围命中才动作，失配一次性报错并冻结', () => {
  const h = makeHarness();
  try {
    // 货格巷道 A2 ≠ 小车参数 A1：目标位失配，报错一次且整机不动
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, aisleCode: 'A2', rootPosition: new Vector3(0, 2, 11) });
    const MOVE = targetFrame(5, 10, 1);
    h.apply(MOVE);
    h.apply(MOVE);
    const errors = h.logs.filter((message) => message.includes('未匹配到任何已绑定货格'));
    assert.equal(errors.length, 1, '同一目标位重复上报只能报错一次');
    assert.ok(errors[0].includes('巷道A1') && errors[0].includes('排2 浅库位 列10 层1'), `报错须含巷道/排/排深/列/层，实际：${errors[0]}`);
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
    h.apply(targetFrame(5, 10, 1), 0.1, 1);
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
    const MOVE = targetFrame(5, 10, 1);
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

test('Status=5 走行：向目标格连续推进并收敛，Status=0 停驻', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 3, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    // 目标列 10（支撑位 z=20）：首帧吸附到位
    h.apply(targetFrame(5, 10, 1), 0.1, 1);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6);

    // 目标列 5（支撑位 z=15）：走行必须立即连续移动并最终收敛
    const MOVE5 = targetFrame(5, 5, 1);
    h.apply(MOVE5, 0.1, 1);
    const zAfter1 = h.model.shuttleTelemetry.rootPosition!.z;
    assert.ok(zAfter1 < 20 && zAfter1 > 15, `走行必须立即向列 5 连续移动，实际 z=${zAfter1}`);
    h.apply(MOVE5, 0.1, 400);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 15) < 1e-6, `必须收敛到目标列 5 支撑位 z=15，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);

    // 任务完结 to_ 清零且 Status=0：车体停驻保持原位
    h.apply(targetFrame(0, 0, 0, 0, 0), 0.1, 5);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 15) < 1e-6, 'Status=0 且无目标时必须保持原位');
  } finally {
    h.dispose();
  }
});

test('目标位失配与非法 to_Depth：冻结走行并各一次性告警', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(targetFrame(5, 10, 1), 0.1, 1);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6);

    const BAD_CELL = targetFrame(5, 99, 1);
    h.apply(BAD_CELL, 0.1, 10);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6, '目标位失配必须冻结走行');
    assert.equal(
      h.logs.filter((message) => message.includes('目标位') && message.includes('列99')).length,
      1,
      '目标位失配告警必须只报一次',
    );

    const BAD_DEPTH = targetFrame(5, 5, 1, 2, 3);
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

test('目标格联合排深匹配：同排浅/深两库位由 to_Depth 区分命中', () => {
  const h = makeHarness();
  try {
    // 同排（排 2）两个库位：浅位列 10 支撑位 z=20、深位列 10 支撑位 z=21
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, storageDepth: 'near', rootPosition: new Vector3(0, 2, 11) });
    h.ref.extraLocators = [
      makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, storageDepth: 'far', rootPosition: new Vector3(0, 2, 12) }),
    ];

    // to_z=2 排 + to_Depth=2 浅库位：吸附 z=20
    h.apply(targetFrame(5, 10, 1, 2, 2), 0.1, 1);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6, `浅库位必须吸附 z=20，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);

    // to_Depth=8 深库位：目标格键变化（含排深），走行到 z=21
    h.apply(targetFrame(5, 10, 1, 2, 8), 0.1, 400);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 21) < 1e-6, `深库位必须走行到 z=21，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);
    assert.equal(
      h.logs.filter((message) => message.includes('未匹配到任何已绑定货格') || message.includes('超出已绑定货格范围')).length,
      0,
      '排深参与匹配后同排两库位必须唯一命中，不得报失配',
    );
  } finally {
    h.dispose();
  }
});

test('目标字段缺失或 to_Depth 非 2/8：一次性告警并冻结，不降级猜测', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(targetFrame(5, 10, 1, 2, 2), 0.1, 1);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6);

    // 旧协议帧（缺 to_z）：必须冻结，不按旧 to_Depth 位编码回退
    const MISSING_Z = { x: 0, y: 0, to_x: 5, to_y: 1, to_Depth: 2, Status: 5, errorCode: 0 };
    h.apply(MISSING_Z, 0.1, 10);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6, 'to_z 缺失必须冻结走行');
    assert.equal(h.logs.filter((message) => message.includes('缺 to_z')).length, 1, 'to_z 缺失告警必须只报一次');

    // to_Depth=4（既非 2 浅库位也非 8 深库位）：同样冻结
    const BAD_DEPTH = targetFrame(5, 5, 1, 2, 4);
    h.apply(BAD_DEPTH, 0.1, 10);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6, '非法排深必须冻结走行');
    assert.equal(h.logs.filter((message) => message.includes('to_Depth=4 非法')).length, 1, '非法排深告警必须只报一次');

    // 目标字段整体缺失（心跳帧）：无目标，不告警也不移动
    const HEARTBEAT = { x: 0, y: 0, Status: 0, errorCode: 0 };
    h.apply(HEARTBEAT, 0.1, 5);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6, '无目标帧必须保持原位');
    assert.equal(h.logs.filter((message) => message.includes('目标字段非法')).length, 2, '仅缺 to_z 与非法排深各报一次，心跳帧不得告警');
  } finally {
    h.dispose();
  }
});

test('取货（Status=1）：到位自动伸叉刷货，伸满绑定上叉，自动收回完结且同相位不重复', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    // 列沿世界 +X 排布：列 10 支撑位在 (20, 2, 0)，叉收回位中心 x=0
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(11, 2, 0), rootRotationY: 0 });
    const FETCH = targetFrame(1, 10, 1, 2, 2, { task: 7001 });

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

    // Status=1→5 伴随目标格跳变（行走开始，无 take_finish 帧）：已绑定货物随叉随行，不得进入 catch-up 也不得销毁
    h.apply(targetFrame(5, 5, 1, 2, 2, { task: 7001 }), 0.1, 1);
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
    h.apply(targetFrame(5, 10, 2), 0.1, 1);
    const fork = h.scene.getMeshByName('huocha1')!;
    assert.ok(Math.abs(fork.position.y - 2.95) < 1e-6, `层 2 闪现后叉面中心 y 必须为 2.95，实际 ${fork.position.y}`);
    assert.ok(Math.abs(fork.position.z - 20) < 1e-6, `同时必须吸附到目标列 z=20，实际 ${fork.position.z}`);

    // 目标层跳到层 1：直接闪现，无竖直动画
    h.apply(targetFrame(5, 10, 1), 0.1, 1);
    assert.ok(Math.abs(fork.position.y - 1.95) < 1e-6, `层变换必须直接闪现到叉面中心 y=1.95，实际 ${fork.position.y}`);
  } finally {
    h.dispose();
  }
});

test('等待换层时 to_y 与当前层 y 不同：不闪到目标层，y 追平后恢复执行', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    // 层距 1m、底层 y=2：层 1 支撑位 y=2（叉面 1.95），层 3 支撑位 y=4（叉面 3.95）；列 5 → z=15，列 10 → z=20
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 4, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    const fork = h.scene.getMeshByName('huocha1')!;

    // 先就位层 1 列 5
    h.apply(targetFrame(5, 5, 1, 2, 2, { y: 1 }), 0.1, 1);
    assert.ok(Math.abs(fork.position.y - 1.95) < 1e-6, `层 1 叉面应为 1.95，实际 ${fork.position.y}`);
    assert.ok(Math.abs(fork.position.z - 15) < 1e-6, `列 5 应吸附 z=15，实际 ${fork.position.z}`);

    // 实测数据 29_ line 560：等待换层期间 PLC 先报目标层（y=1, to_y=3）——不得闪到层 3/列 10，保持原位
    const WAIT = targetFrame(4, 10, 3, 2, 2, { y: 1 });
    h.apply(WAIT, 0.1, 3);
    assert.ok(Math.abs(fork.position.y - 1.95) < 1e-6, `跨层门控必须保持层 1（叉面 1.95），实际 ${fork.position.y}`);
    assert.ok(Math.abs(fork.position.z - 15) < 1e-6, `跨层门控必须保持列 5（z=15），实际 ${fork.position.z}`);
    assert.equal(h.logs.filter((message) => message.includes('未匹配到任何已绑定货格')).length, 0, '跨层门控不得报目标失配');

    // 换层完成出梯后 y 追平 to_y：恢复执行，先闪到层 3，再走行到列 10
    const RESUME = targetFrame(5, 10, 3, 2, 2, { y: 3 });
    h.apply(RESUME, 0.1, 1);
    assert.ok(Math.abs(fork.position.y - 3.95) < 1e-6, `y 追平后必须闪现到层 3（叉面 3.95），实际 ${fork.position.y}`);
    h.apply(RESUME, 0.1, 60);
    assert.ok(Math.abs(fork.position.z - 20) < 1e-6, `y 追平后必须走行到列 10（z=20），实际 ${fork.position.z}`);
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
    h.apply(targetFrame(5, 10, 2), 0.1, 1);
    const fork = h.scene.getMeshByName('huocha1')!;
    assert.ok(Math.abs(fork.position.y - 2.85) < 1e-6, `层 2 闪现须以载货平面顶面对齐（叉面中心 y=2.85），实际 ${fork.position.y}`);
    const deck = h.scene.getMeshByName('对象020')!;
    assert.ok(Math.abs(deck.position.y - 2.95) < 1e-6, `载货平面中心 y 必须为 2.95（顶面 3.0 贴支撑位），实际 ${deck.position.y}`);

    // 装货全流程：货物底面贴载货平面顶面（=货格支撑位 y=3），交接无跳变
    const FETCH = targetFrame(1, 10, 2, 2, 2, { task: 7008 });
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
    const FETCH = targetFrame(1, 10, 1, 2, 2, { task: 7002 });
    h.apply(FETCH, 0.1, 8);
    assert.ok(h.model.shuttleTelemetry.forkOffset > 0.05, '货叉必须已伸出');
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, false);

    // 目标格跳到列 5 且 Status=5（设备转场）：进入 catch-up，收叉期间整机冻结
    const MOVE5 = targetFrame(5, 5, 1, 2, 2, { task: 7002 });
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

test('卸货（Status=3）：补建绑定、伸满解绑落格、收回完结销毁，同相位不重复补建', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    // 列 10 支撑位 (0, 2, 20)：货格正对叉中心，伸叉行程回退叉全长 0.4m
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    const PLACE = targetFrame(3, 10, 1, 2, 2, { task: 7003 });

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

test('卸货到留存内置货格：货物留在格口不销毁，再次取货接管同一实例', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, {
      columns: 10,
      layers: 1,
      startColumn: 1,
      retainCargo: true,
      rootPosition: new Vector3(0, 2, 11),
    });
    const PLACE = targetFrame(3, 10, 1, 2, 2, { task: 7003 });
    h.apply(PLACE, 0.1, 1);
    h.apply(PLACE, 0.1, 20);
    h.apply(PLACE, 0.1, 30);

    assert.equal(h.state.shuttleCargoMeshes.size, 0, '放货完成后货物必须移出本机货物表');
    assert.equal(h.model.shuttleTelemetry.cargoKey, null);
    assert.equal(h.state.slotRetainedCargoMeshes.size, 1, '货物必须进入格口留存表');
    const entry = [...h.state.slotRetainedCargoMeshes.values()][0];
    assert.equal(entry.locatorEntityId, h.ref.locator.entityId);
    assert.equal(entry.column, 10);
    assert.equal(entry.layer, 1);
    assert.equal(entry.rowNumber, null, '非 fetch 货格不留存排号');
    assert.ok(
      Vector3.Distance(entry.cargo.root.position, new Vector3(0, 2, 20)) < 1e-6,
      `留存货物必须停在格口支撑位 (0,2,20)，实际 ${entry.cargo.root.position}`,
    );
    assert.equal(h.ref.disposedShuttleCargos.length, 0, '留存货物不得被销毁');
    assert.equal(h.ref.retainedCells.length, 0, '非 fetch 货格不建立持久抑制');

    // 再次取同格：接管留在货架上的同一货物实例
    const retainedCargo = entry.cargo;
    const FETCH = targetFrame(1, 10, 1, 2, 2, { task: 7004 });
    h.apply(FETCH, 0.1, 1);
    assert.equal(h.state.slotRetainedCargoMeshes.size, 0, '取货后留存表必须清空');
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '留存货物必须被本机接管');
    const taken = [...h.state.shuttleCargoMeshes.values()][0];
    assert.equal(taken, retainedCargo, '必须复用留在货架上的同一货物实例');
    assert.equal(h.model.shuttleTelemetry.cargoKey, h.driver.getShuttleCargoKey('SH1'));
  } finally {
    h.dispose();
  }
});

test('留存格口接单排同步：放货建立持久抑制并刷新同排，取货后释放抑制', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.fetchRow = 2;
    h.ref.locator = makeLocator(h.scene, {
      columns: 10,
      layers: 1,
      startColumn: 1,
      retainCargo: true,
      rootPosition: new Vector3(0, 2, 11),
    });
    const PLACE = targetFrame(3, 10, 1, 2, 2, { task: 7003 });
    h.apply(PLACE, 0.1, 1);
    h.apply(PLACE, 0.1, 20);
    h.apply(PLACE, 0.1, 30);

    assert.equal(h.state.slotRetainedCargoMeshes.size, 1);
    const entry = [...h.state.slotRetainedCargoMeshes.values()][0];
    assert.equal(entry.rowNumber, 2, '留存条目记录锁定排号');
    assert.deepEqual(h.ref.retainedCells, [[10, 1]], '放货完成必须建立持久抑制');
    assert.deepEqual(h.ref.rowSyncs, [2], '放货完成必须触发同排同步');

    h.apply(targetFrame(1, 10, 1, 2, 2, { task: 7004 }), 0.1, 1);
    assert.equal(h.state.slotRetainedCargoMeshes.size, 0);
    assert.deepEqual(h.ref.releasedCells, [[10, 1]], '取货后必须释放持久抑制');
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
    const PLACE = targetFrame(3, 10, 1, 2, 2, { task: 7007 });

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

test('_finish 帧缺失：Status 直接 1→5→3 仍能自行完结取货并启动卸货', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    // 列沿走行轴 Z 排布：列 10 支撑位 z=20、列 5 支撑位 z=15
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });

    // 取货全程不发送 take_finish=2：动作由收叉动画自行完结
    const FETCH = targetFrame(1, 10, 1, 2, 2, { task: 7100 });
    h.apply(FETCH, 0.1, 1000);
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '取货动作必须由收叉动画自行完结');
    assert.equal(h.model.shuttleTelemetry.statusActionDone, true);

    // 直接 1→5 移动（无 take_finish / move_finish）：走行到列 5
    h.apply(targetFrame(5, 5, 1, 2, 2, { task: 7100 }), 0.1, 400);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 15) < 1e-6, `无 finish 帧也必须走到列 5，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);

    // 直接 5→3 卸货（无 move_finish 前置）：同样进入伸叉相位并自行完结
    const PLACE = targetFrame(3, 5, 1, 2, 2, { task: 7100 });
    h.apply(PLACE, 0.1, 1);
    assert.equal(h.model.shuttleTelemetry.forkPhase, 'extending', '无 unload_finish 前置也必须进入卸货伸叉');
    h.apply(PLACE, 0.1, 1000);
    assert.equal(h.model.shuttleTelemetry.statusActionDone, true, '卸货动作必须由收叉动画自行完结');
    assert.equal(h.model.shuttleTelemetry.cargoKey, null, '卸货完结后货物引用必须清空');
  } finally {
    h.dispose();
  }
});

test('Status=10 急停：冻结货叉与走行，状态恢复后从冻结位置继续动作', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(11, 2, 0), rootRotationY: 0 });

    // 取货伸叉途中（8 帧 × 0.025m = 0.2m，未伸满未绑定）
    const FETCH = targetFrame(1, 10, 1, 2, 2, { task: 7101 });
    h.apply(FETCH, 0.1, 8);
    const frozenOffset = h.model.shuttleTelemetry.forkOffset;
    const frozenPosition = h.model.shuttleTelemetry.rootPosition!.clone();
    assert.ok(frozenOffset > 0.05, '货叉必须已伸出');

    // 急停：货叉保持当前位置，不收叉也不继续伸出
    h.apply(targetFrame(10, 10, 1, 2, 2, { task: 7101 }), 0.1, 20);
    assert.ok(Math.abs(h.model.shuttleTelemetry.forkOffset - frozenOffset) < 1e-9, '急停期间货叉必须冻结');
    assert.ok(Vector3.Distance(h.model.shuttleTelemetry.rootPosition!, frozenPosition) < 1e-9, '急停期间车体必须停驻');
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '急停不得销毁货物');
    assert.ok(h.logs.some((message) => message.includes('急停触发')), '急停必须提示');

    // 恢复取货：从冻结位置继续伸叉
    h.apply(FETCH, 0.1, 1);
    assert.ok(h.model.shuttleTelemetry.forkOffset > frozenOffset, '状态恢复后必须继续伸叉');
  } finally {
    h.dispose();
  }
});

test('to_Depth=0 无排深接驳位：不按排深过滤，唯一命中输送线内置货格', () => {
  const h = makeHarness();
  try {
    // 接驳位：列 0、排 2、层 3，场景中该内置货格的实际排深为 near
    h.ref.locator = makeLocator(h.scene, {
      columns: 1, layers: 4, startColumn: 0, rowNumber: 2, storageDepth: 'near',
      rootPosition: new Vector3(0, 2, 11),
    });
    h.apply(targetFrame(5, 0, 3, 2, 0), 0.1, 1);
    assert.ok(
      Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 11) < 1e-6,
      `D0 目标必须解析并吸附到接驳位 z=11，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`,
    );
    assert.equal(h.logs.filter((message) => message.includes('to_Depth')).length, 0, 'D0 不得报 to_Depth 非法');
    assert.equal(
      h.logs.filter((message) => message.includes('未匹配') || message.includes('超出已绑定货格范围')).length,
      0,
      'D0 接驳位必须唯一命中',
    );
  } finally {
    h.dispose();
  }
});

test('to_Depth=0 同排浅/深两库位同时命中：唯一匹配失败并冻结，不猜测排深', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 1, layers: 4, startColumn: 0, rowNumber: 2, storageDepth: 'near' });
    h.ref.extraLocators = [
      makeLocator(h.scene, { columns: 1, layers: 4, startColumn: 0, rowNumber: 2, storageDepth: 'far' }),
    ];
    h.apply(targetFrame(5, 0, 3, 2, 0), 0.1, 1);
    assert.ok(
      Math.abs(h.model.shuttleTelemetry.rootPosition!.z) < 1e-9,
      '无排深且多命中时必须冻结在原位，不得猜测',
    );
    assert.equal(
      h.logs.filter((message) => message.includes('超出已绑定货格范围')).length,
      1,
      '多命中时必须一次性告警',
    );
  } finally {
    h.dispose();
  }
});

test('x=-2 驶入 hclift 载货台：以 deckCenter 为目标并发布 entering/loaded 占位', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, {
      columns: 1, layers: 4, startColumn: -1, rowNumber: 1, kind: 'layerChangePlatform',
      rootPosition: new Vector3(0, 2, 11),
      platformTrackEndWorld: new Vector3(0, 2, 10.5),
    });
    h.state.hcliftPlatformSurfaces.set('hclift1', {
      assetCode: '1701',
      aisleCode: 'A1',
      supportY: 2.5,
      deckCenter: new Vector3(0, 2.5, 9.673),
      targetLevel: 1,
      arrived: true,
      updatedAtMs: Date.now(),
    });
    const platformFrame = { x: -1, y: 1, to_x: 0, to_y: 3, to_z: 1, to_Depth: 0, Status: 5, errorCode: 0 };

    // x=-1：站台货格中心停靠，占位为 entering
    h.apply(platformFrame, 0.1, 1);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 11) < 1e-6, `x=-1 必须停站台中心 z=11，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);
    assert.equal(h.state.hcliftDeckOccupancies.get('hclift1')?.phase, 'entering', 'x=-1 占位必须为 entering');

    // x=-2：继续驶入载货台中心（约 1.327m），入场中保持 entering
    const deckFrame = { ...platformFrame, x: -2 };
    h.apply(deckFrame, 0.1, 5);
    const midZ = h.model.shuttleTelemetry.rootPosition!.z;
    assert.ok(midZ < 11 && midZ > 9.673, `入场中必须朝载货台中心移动，实际 z=${midZ}`);
    assert.equal(h.state.hcliftDeckOccupancies.get('hclift1')?.phase, 'entering', '未到位前占位必须为 entering');

    // 到位：rootPosition 对齐 deckCenter，占位切换 loaded
    h.apply(deckFrame, 0.1, 40);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 9.673) < 1e-6, `必须驶入载货台中心 z=9.673，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);
    assert.equal(h.state.hcliftDeckOccupancies.get('hclift1')?.phase, 'loaded', '停稳后占位必须为 loaded');
    assert.equal(h.model.shuttleTelemetry.hcliftOccupancyKey, 'hclift1');

    // 离开平台：占位清除
    h.apply({ ...platformFrame, x: 0, Status: 0, to_x: 0, to_y: 0, to_z: 0, to_Depth: 0 }, 0.1, 1);
    assert.equal(h.state.hcliftDeckOccupancies.size, 0, '离开后必须清除占位');
    assert.equal(h.model.shuttleTelemetry.hcliftOccupancyKey, null);
  } finally {
    h.dispose();
  }
});

test('换层结束后出梯：Status=1 未到位时先走到取货站台再伸叉', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    // 换层站台列 -1；取货站台列 0（位于 z=12，与站台 z=11 相隔 1m）
    h.ref.locator = makeLocator(h.scene, {
      columns: 1, layers: 4, startColumn: -1, rowNumber: 1, kind: 'layerChangePlatform',
      rootPosition: new Vector3(0, 2, 11),
    });
    h.ref.extraLocators = [
      makeLocator(h.scene, {
        columns: 1, layers: 4, startColumn: 0, rowNumber: 1, storageDepth: 'near',
        rootPosition: new Vector3(0, 2, 12),
      }),
    ];
    h.state.hcliftPlatformSurfaces.set('hclift1', {
      assetCode: '1701', aisleCode: 'A1', supportY: 2.5,
      deckCenter: new Vector3(0, 2.5, 9.673), targetLevel: 3, arrived: false, updatedAtMs: Date.now(),
    });

    // 进梯 → 换层 → 出梯回站台
    h.apply({ x: -1, y: 1, to_x: 0, to_y: 3, to_z: 1, to_Depth: 0, Status: 5, errorCode: 0 }, 0.1, 2);
    h.apply({ x: -2, y: 0, to_x: 0, to_y: 3, to_z: 1, to_Depth: 0, Status: 5, errorCode: 0 }, 0.1, 40);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 9.673) < 1e-6, '必须驶入载货台');
    h.apply({ x: -1, y: 3, to_x: 0, to_y: 3, to_z: 1, to_Depth: 0, Status: 5, errorCode: 0 }, 0.1, 40);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 11) < 1e-6, '出梯必须回到站台中心');

    // 出梯后 PLC 立即报 Status=1（取货中），此时车必须补走到取货站台再伸叉
    const fetchFrame = { x: 0, y: 3, to_x: 0, to_y: 3, to_z: 1, to_Depth: 0, Status: 1, errorCode: 0 };
    h.apply(fetchFrame, 0.1, 15);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 12) < 1e-6,
      `必须补走到取货站台 z=12，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);
    assert.equal(h.model.shuttleTelemetry.forkPhase, 'extending', '到位后必须开始伸叉取货');
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '取货开始必须刷出货物');
  } finally {
    h.dispose();
  }
});

test('目标字段清零（Status=4 完结帧）：保持上一帧高度，不弹回初始位置', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, {
      columns: 1, layers: 4, startColumn: 0, rowNumber: 1, storageDepth: 'near',
      rootPosition: new Vector3(0, 2, 11),
    });
    const fork = h.scene.getMeshByName('huocha1')!;

    // 目标层 3：支撑 y=4，叉面中心 = 4 − 0.30 + 0.25 = 3.95
    h.apply({ x: 0, y: 3, to_x: 0, to_y: 3, to_z: 1, to_Depth: 2, Status: 3, errorCode: 0 }, 0.1, 1);
    assert.ok(Math.abs(fork.position.y - 3.95) < 1e-6, `目标层 3 叉面应为 3.95，实际 ${fork.position.y}`);

    // 实测数据 line 313：Status=4，to_* 全 0
    h.apply({ x: 0, y: 3, to_x: 0, to_y: 0, to_z: 0, to_Depth: 0, Status: 4, errorCode: 0 }, 0.1, 1);
    assert.ok(Math.abs(fork.position.y - 3.95) < 1e-6, `无目标帧必须保持上一帧高度，实际 ${fork.position.y}`);
  } finally {
    h.dispose();
  }
});

test('进梯途中 x=-1 的 y=0 瞬时帧：保持最近有效层，不闪到 to_y 目标层', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, {
      columns: 1, layers: 4, startColumn: -1, rowNumber: 1, kind: 'layerChangePlatform',
      rootPosition: new Vector3(0, 2, 11),
    });
    const frame = { to_x: 0, to_y: 3, to_z: 1, to_Depth: 0, Status: 5, errorCode: 0 };
    const fork = h.scene.getMeshByName('huocha1')!;

    h.apply({ ...frame, x: -1, y: 1 }, 0.1, 1);
    assert.ok(Math.abs(fork.position.y - 2.05) < 1e-6, `层 1 叉面应为 2.05，实际 ${fork.position.y}`);

    // 实测数据 line 3599：进梯瞬间 x=-1,y=0,to_y=3
    h.apply({ ...frame, x: -1, y: 0 }, 0.1, 1);
    assert.ok(Math.abs(fork.position.y - 2.05) < 1e-6, `y=0 瞬时帧必须保持层 1，实际 ${fork.position.y}`);

    // 实测数据 line 398：进梯过渡帧 x=255,y=0,to_y=3
    h.apply({ ...frame, x: 255, y: 0 }, 0.1, 1);
    assert.ok(Math.abs(fork.position.y - 2.05) < 1e-6, `x=255 过渡帧必须保持层 1，实际 ${fork.position.y}`);

    h.apply({ ...frame, x: -2, y: 0 }, 0.1, 1);
    assert.ok(Math.abs(fork.position.y - 2.05) < 1e-6, `进入提升机后仍保持层 1，实际 ${fork.position.y}`);
  } finally {
    h.dispose();
  }
});

test('x=-2 进梯但提升机数据未发布：保持进梯前层，不闪到 to_y 目标层', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, {
      columns: 1, layers: 4, startColumn: -1, rowNumber: 1, kind: 'layerChangePlatform',
      rootPosition: new Vector3(0, 2, 11),
    });

    // 进梯前在层 1：叉面中心 = 支撑位 y=2 - 车底 0.20 + 叉基线 0.25 = 2.05
    h.apply({ x: -1, y: 1, to_x: 0, to_y: 3, to_z: 1, to_Depth: 0, Status: 5, errorCode: 0 }, 0.1, 1);
    const fork = h.scene.getMeshByName('huocha1')!;
    assert.ok(Math.abs(fork.position.y - 2.05) < 1e-6, `进梯前必须保持层 1（叉面 2.05），实际 ${fork.position.y}`);

    // 进入提升机且 y=0、无 hclift 台面数据：不得按 to_y=3 闪现到层 3（叉面 4.05）
    h.apply({ x: -2, y: 0, to_x: 0, to_y: 3, to_z: 1, to_Depth: 0, Status: 5, errorCode: 0 }, 0.1, 1);
    assert.ok(Math.abs(fork.position.y - 2.05) < 1e-6, `缺台面数据时必须保持进梯前层 1，实际 ${fork.position.y}`);
  } finally {
    h.dispose();
  }
});

test('x=-2 载货台已被其他小车占用：不覆盖占位并保持原位', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, {
      columns: 1, layers: 4, startColumn: -1, rowNumber: 1, kind: 'layerChangePlatform',
      rootPosition: new Vector3(0, 2, 11),
    });
    h.state.hcliftPlatformSurfaces.set('hclift1', {
      assetCode: '1701', aisleCode: 'A1', supportY: 2.5,
      deckCenter: new Vector3(0, 2.5, 9.673), targetLevel: 3, arrived: false, updatedAtMs: Date.now(),
    });
    h.state.hcliftDeckOccupancies.set('hclift1', {
      shuttleAssetCode: 'OTHER', aisleCode: 'A1', phase: 'loaded',
      shuttleStatus: 0, shuttleFaulted: false, updatedAtMs: Date.now(),
    });

    h.apply({ x: -2, y: 1, to_x: 0, to_y: 3, to_z: 1, to_Depth: 0, Status: 5, errorCode: 0 }, 0.1, 5);
    const occupancy = h.state.hcliftDeckOccupancies.get('hclift1');
    assert.equal(occupancy?.shuttleAssetCode, 'OTHER', '已有占位不得被覆盖');
    assert.ok(h.logs.some((message) => message.includes('已被小车 OTHER 占用')), '占用冲突必须提示');
    assert.equal(h.model.shuttleTelemetry.hcliftOccupancyKey, null, '冲突车不得登记占位');
  } finally {
    h.dispose();
  }
});

test('x=-2 换层中 y 上报 0：回退 to_y 解析站台层，不冻结', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, {
      columns: 1, layers: 4, startColumn: 0, rowNumber: 1, kind: 'layerChangePlatform',
      rootPosition: new Vector3(0, 2, 11),
    });
    const PLATFORM = { x: -2, y: 0, to_x: 0, to_y: 4, to_z: 1, to_Depth: 0, Status: 5, errorCode: 0 };

    h.apply(PLATFORM, 0.1, 1);
    assert.equal(h.logs.filter((message) => message.includes('y=0')).length, 0, 'x=-2 且 y=0 必须回退 to_y，不得告警');
    assert.equal(
      (h.model.root.metadata as { shuttleTelemetry?: { targetFound?: boolean } }).shuttleTelemetry?.targetFound,
      true,
      '必须解析到换层站台货格',
    );
    // 回退到 to_y=4：层 4 支撑位 y=5，车体底部 0.20 对齐支撑位 → 叉面中心由 0.25 闪现到 5.05
    const fork = h.scene.getMeshByName('huocha1')!;
    assert.ok(Math.abs(fork.position.y - 5.05) < 1e-6, `必须按 to_y=4 闪现对齐，实际叉面中心 y=${fork.position.y}`);
  } finally {
    h.dispose();
  }
});
