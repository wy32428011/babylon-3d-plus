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
    deviceAssetCode: '',
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
  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [{ entityId: 'e1', model }],
    // 与 SceneRuntime.findLocatorByAisle 同规则：巷道一致 + 排号一致且列/层落在货格范围内才命中
    findLocatorByAisle: (aisleCode: string, x: number, y: number, z: number) => {
      const locator = ref.locator;
      if (!locator || locator.aisleCode !== aisleCode || locator.rowNumber !== z) return null;
      return x >= locator.startColumn && x < locator.startColumn + locator.columns && y >= locator.startLayer && y < locator.startLayer + locator.layers
        ? locator
        : null;
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

/** 为模型补齐多穿小车货叉几何：单套货叉 huocha1，叉面中心 (0, 0.25, 0)。 */
function makeShuttleGeometry(h: ReturnType<typeof makeHarness>): void {
  const root = h.model.root;
  const fork = MeshBuilder.CreateBox('huocha1', { width: 0.4, height: 0.1, depth: 0.4 }, h.scene);
  fork.parent = root;
  fork.position.set(0, 0.25, 0);
  root.computeWorldMatrix(true);
}

/** 当前位上报帧：front_x/front_y/front_z 三字段是位置唯一驱动源（排=front_z=2）。 */
const POSITION_FRAME = {
  front_command: 0,
  back_command: 0,
  front_x: 10,
  front_y: 1,
  front_z: 2,
  errorCode: 0,
};

test('巷道匹配：aisleCode 一致 + 列层范围命中才走行，不一致时一次性报错并保持不动', () => {
  const h = makeHarness();
  try {
    // 货格巷道 A2 ≠ 小车参数 A1：当前位失配，报错一次且整机不动
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, aisleCode: 'A2', rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME);
    h.apply(POSITION_FRAME);
    const errors = h.logs.filter((message) => message.includes('未匹配到任何已绑定货格'));
    assert.equal(errors.length, 1, '同一当前位重复上报只能报错一次');
    assert.ok(errors[0].includes('巷道A1') && errors[0].includes('排2 列10 层1'), `报错须含巷道/排/列/层，实际：${errors[0]}`);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z) < 1e-9, '巷道失配时不得移动');

    // 巷道改回 A1：命中并吸附到货格支撑位（列 10 → z=20）
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, aisleCode: 'A1', rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME, 0.1, 1);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6, `首帧必须吸附到 z=20，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);
  } finally {
    h.dispose();
  }
});

test('未配置巷道编号时报错一次，整机保持不动', () => {
  const h = makeHarness();
  try {
    (h.model.entitySnapshot as { components: { modelAsset: { parameterValues: Record<string, unknown> } } })
      .components.modelAsset.parameterValues = {};
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME);
    h.apply(POSITION_FRAME);
    const errors = h.logs.filter((message) => message.includes('未配置巷道编号'));
    assert.equal(errors.length, 1, '未配置巷道编号只能报错一次');
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z) < 1e-9, '未配置巷道时不得移动');
  } finally {
    h.dispose();
  }
});

test('to_x/to_y/to_z 匹配巷道货格时以目标位为走行终点：当前位未跳变即连续滑向目标', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 3, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    // 设备停在列 10（支撑位 z=20）：首帧吸附到位
    h.apply(POSITION_FRAME, 0.1, 10);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6);

    // WCS 下发目标列 5（支撑位 z=15）：当前位 front_ 保持列 10，走行必须立即以目标格为终点连续移动
    const TO_FRAME = { ...POSITION_FRAME, to_x: 5, to_y: 2, to_z: 2 };
    h.apply(TO_FRAME, 0.1, 1);
    const zAfter1 = h.model.shuttleTelemetry.rootPosition!.z;
    assert.ok(zAfter1 < 20 && zAfter1 > 15, `目标位驱动必须立即向列 5 连续移动，实际 z=${zAfter1}`);

    // 持续上报：最终收敛到目标格支撑位（全程当前位未跳变，证明不依赖 front_ 追赶）
    h.apply(TO_FRAME, 0.1, 400);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 15) < 1e-6, `必须收敛到目标列 5 支撑位 z=15，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);

    // 任务完结 to_ 清零且当前位已跟上（列 5）：回退当前位驱动，目标相同保持原位
    h.apply({ ...POSITION_FRAME, front_x: 5, front_y: 2, to_x: 0, to_y: 0, to_z: 0 }, 0.1, 5);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 15) < 1e-6, 'to_ 清零且当前位已跟上时必须保持原位');
  } finally {
    h.dispose();
  }
});

test('to_x/to_y/to_z 匹配不到巷道货格时回退当前位驱动并一次性告警', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME, 0.1, 10);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6);

    const BAD_TO_FRAME = { ...POSITION_FRAME, to_x: 99, to_y: 1, to_z: 2 };
    h.apply(BAD_TO_FRAME, 0.1, 10);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6, '目标位失配必须回退当前位驱动');
    assert.equal(
      h.logs.filter((message) => message.includes('目标位') && message.includes('列99')).length,
      1,
      '目标位失配告警必须只报一次',
    );
  } finally {
    h.dispose();
  }
});

test('伸叉方向由货格几何决定：货格在 +x 侧时 movement 3 也必须朝 +x 伸，叉心对准货格支撑位，行程不钳位', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    // 列沿世界 +X 排布：列 10（列下标 9）支撑位在 (20, 2, 0)，叉收回位中心 x=0
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(11, 2, 0), rootRotationY: 0 });
    h.apply(POSITION_FRAME, 0.1, 10);

    // 60 帧 × 0.25 m/s × 0.1s = 1.5m：越过叉模型全长 0.4m 继续伸出（不钳位）
    h.apply({ ...POSITION_FRAME, front_movement_z: 3 }, 0.1, 60);
    const extended = h.model.shuttleTelemetry.forkOffset;
    assert.ok(Math.abs(extended - 1.5) < 1e-6, `movement 3 必须按几何朝 +x 伸出并越过叉长 0.4，实际 ${extended}`);

    // 继续伸出直至叉中心对准货格中心（20m，悬空）
    h.apply({ ...POSITION_FRAME, front_movement_z: 3 }, 0.1, 800);
    assert.ok(Math.abs(h.model.shuttleTelemetry.forkOffset - 20) < 1e-6, `最终必须伸到货格中心 20m，实际 ${h.model.shuttleTelemetry.forkOffset}`);

    // 收回与方向无关：movement 2/4 均归 0
    h.apply({ ...POSITION_FRAME, front_movement_z: 4 }, 0.1, 900);
    assert.equal(h.model.shuttleTelemetry.forkOffset, 0);
  } finally {
    h.dispose();
  }
});

test('伸叉方向由货格几何决定：货格在 −x 侧时 movement 1 也必须朝 −x 伸', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    // 列沿世界 +X 排布但货格在负侧：列 10 支撑位在 (−20, 2, 0)
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(-29, 2, 0), rootRotationY: 0 });
    h.apply(POSITION_FRAME, 0.1, 10);

    h.apply({ ...POSITION_FRAME, front_movement_z: 1 }, 0.1, 60);
    const extended = h.model.shuttleTelemetry.forkOffset;
    assert.ok(Math.abs(extended + 1.5) < 1e-6, `movement 1 必须按几何朝 −x 伸出，实际 ${extended}`);

    h.apply({ ...POSITION_FRAME, front_movement_z: 1 }, 0.1, 800);
    assert.ok(Math.abs(h.model.shuttleTelemetry.forkOffset + 20) < 1e-6, `最终必须伸到货格中心 −20m，实际 ${h.model.shuttleTelemetry.forkOffset}`);
  } finally {
    h.dispose();
  }
});

test('走行与伸叉互斥：本体移动期间货叉收回原点', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    // 列沿世界 +Z 排布：列 10 支撑位 z=20，列 2 支撑位 z=12（走行轴上有 8m 行程差）
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME, 0.1, 10);

    // 先伸出一段
    h.apply({ ...POSITION_FRAME, front_movement_z: 1 }, 0.1, 10);
    assert.ok(h.model.shuttleTelemetry.forkOffset > 0.05, '货叉必须已伸出');

    // 下发远处目标位（列 2 支撑位 z=12，车体需从 z=20 走行 8m）：
    // 走行期间伸叉信号保持 1，货叉仍必须收回（20 帧收叉行程 0.5m 足够归零，且走行远未完成）
    h.apply({ ...POSITION_FRAME, front_movement_z: 1, to_x: 2, to_y: 1, to_z: 2 }, 0.1, 20);
    assert.equal(h.model.shuttleTelemetry.forkOffset, 0, '走行期间货叉必须收回原点');
  } finally {
    h.dispose();
  }
});

test('front_ 变化时快速收尾：货叉加速收回原点后才允许走行', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });

    // 先到位（列 10，支撑位 z=20）
    h.apply(POSITION_FRAME, 0.1, 400);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-6);

    // 伸叉：目标行程由货格几何解算，必须大于 0
    h.apply({ ...POSITION_FRAME, front_movement_z: 1 }, 0.1, 60);
    assert.ok(h.model.shuttleTelemetry.forkOffset > 0.05, '货叉必须已伸出');

    // front_ 跳到列 5：进入 catch-up，收叉期间整机冻结
    h.apply({ ...POSITION_FRAME, front_x: 5 }, 0.1, 1);
    assert.equal(h.model.shuttleTelemetry.forkCatchUp, true, 'front_ 变化且货叉已伸出必须进入 catch-up');
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 20) < 1e-9, '收叉期间走行必须冻结');

    // 加速收叉（0.25m/s × 4 倍率）迅速归零并退出 catch-up
    h.apply({ ...POSITION_FRAME, front_x: 5 }, 0.1, 10);
    assert.equal(h.model.shuttleTelemetry.forkOffset, 0);
    assert.equal(h.model.shuttleTelemetry.forkCatchUp, false);

    // 退出 catch-up 后向新当前位（列 5，支撑位 z=15）走行
    h.apply({ ...POSITION_FRAME, front_x: 5 }, 0.1, 200);
    assert.ok(Math.abs(h.model.shuttleTelemetry.rootPosition!.z - 15) < 1e-6, `收叉完成后必须走到新货格 z=15，实际 ${h.model.shuttleTelemetry.rootPosition!.z}`);
  } finally {
    h.dispose();
  }
});

test('取货：command 1 + 伸叉开始刷货，伸足绑定上叉，相位退出收尾后货物随叉带回', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    const FETCH_FRAME = { ...POSITION_FRAME, front_command: 1, front_task: 7001 };

    // 到位后在列 10 取货：伸叉刷货 → 到位绑定 → 收叉带回
    h.apply(FETCH_FRAME, 0.1, 10);
    assert.equal(h.state.shuttleCargoMeshes.size, 0, 'command 1 本身不得提前刷货');
    h.apply({ ...FETCH_FRAME, front_movement_z: 1 }, 0.1, 60);
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '伸叉取货必须刷出货物');
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '伸叉到位必须绑定货物上叉');
    h.apply({ ...FETCH_FRAME, front_movement_z: 2 }, 0.1, 60);
    assert.equal(h.model.shuttleTelemetry.forkOffset, 0, '收叉必须归零');

    // command 1→3 伴随库位跳变（行走开始）：已绑定货物随叉随行，不得进入 catch-up 也不得销毁
    h.apply({ ...FETCH_FRAME, front_command: 3, front_x: 5, front_movement_z: 0 }, 0.1, 1);
    assert.equal(h.model.shuttleTelemetry.forkCatchUp, false, '已绑定货物随行不得进入 catch-up');
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '库位跳变不得销毁已绑定货物');
    assert.notEqual(h.model.shuttleTelemetry.cargoKey, null, '货物引用必须保留');
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '货物必须保持绑定随叉随行');
  } finally {
    h.dispose();
  }
});

test('放货：叉未达行程时收叉边沿即解绑落货，货物留在目标箱位不随叉带回', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    const PLACE_FRAME = { ...POSITION_FRAME, front_command: 3, front_task: 7002 };

    // 放货相位补建叉上货物并立即绑定
    h.apply(PLACE_FRAME, 0.1, 1);
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '放货相位必须补建叉上货物');
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '放货补建货物必须立即绑定');

    // 伸出 2 帧（约 0.05m，远未达目标行程）：到位判定不触发，货物保持绑定
    h.apply({ ...PLACE_FRAME, front_movement_z: 1 }, 0.1, 2);
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '未达行程前货物必须保持绑定');

    // 停止帧不冲掉边沿检测
    h.apply({ ...PLACE_FRAME, front_movement_z: 0 }, 0.1, 3);
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, true, '停止帧期间货物必须保持绑定');

    // 收叉边沿：按到达动作点立即解绑落货，货物留在目标箱位支撑位
    h.apply({ ...PLACE_FRAME, front_movement_z: 2 }, 0.1, 1);
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, false, '收叉边沿必须立即解绑落货');
    assert.notEqual(h.model.shuttleTelemetry.cargoHoldPosition, null, '解绑后货物必须留存目标箱位支撑位');

    // 继续收叉至归零：货物静止于箱位，不随叉带回
    h.apply({ ...PLACE_FRAME, front_movement_z: 2 }, 0.1, 60);
    assert.equal(h.model.shuttleTelemetry.forkOffset, 0, '收叉必须归零');
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '货物必须留存在箱位');
    const cargo = [...h.state.shuttleCargoMeshes.values()][0];
    assert.ok(
      Vector3.Distance(cargo.root.position, new Vector3(0, 2, 20)) < 1e-6,
      `货物必须静止于目标箱位支撑位 (0,2,20)，实际 ${cargo.root.position}`,
    );

    // command 3→5 相位退出：非 fetch 保留路径货物销毁（交接给货格渲染）
    h.apply({ ...PLACE_FRAME, front_command: 5, front_movement_z: 0 }, 0.1, 1);
    assert.equal(h.state.shuttleCargoMeshes.size, 0, '放货完成后货物必须销毁');
    assert.equal(h.model.shuttleTelemetry.cargoKey, null, '放货完成后货物引用必须清空');
  } finally {
    h.dispose();
  }
});

test('放货到 conveyor 站台：落货当场交付（placeShuttleCargoIntoConveyorPlatform），不补建第二个货物', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    // 模拟交接成功：与 SpecializedTelemetryRuntime.placeShuttleCargoIntoConveyorPlatform 同语义，摘除货物并清理引用
    h.context.placeShuttleCargoIntoConveyorPlatform = (_locatorEntityId: string, cargoKey: string) => {
      h.driver.detachClaimedCargoByKey(cargoKey);
      return true;
    };
    const PLACE_FRAME = { ...POSITION_FRAME, front_command: 3, front_task: 7007 };

    h.apply(PLACE_FRAME, 0.1, 1);
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '放货相位必须补建叉上货物');
    h.apply({ ...PLACE_FRAME, front_movement_z: 1 }, 0.1, 2);
    h.apply({ ...PLACE_FRAME, front_movement_z: 0 }, 0.1, 2);

    // 收叉边沿：重试解绑落货；无 mode==4 延后，落货当场交付给 conveyor
    h.apply({ ...PLACE_FRAME, front_movement_z: 2 }, 0.1, 1);
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, false, '收叉边沿必须解绑落货');
    assert.equal(h.state.shuttleCargoMeshes.size, 0, '落货当场交接成功后货物必须离开 shuttle 货物表');
    assert.equal(h.model.shuttleTelemetry.cargoKey, null, '交接成功后货物引用必须清空');

    // command 仍为 3 的后续收叉帧：不得因 cargoKey 为空而补建第二个货物
    h.apply({ ...PLACE_FRAME, front_movement_z: 2 }, 0.1, 5);
    assert.equal(h.state.shuttleCargoMeshes.size, 0, '交接成功后不得补建第二个货物');
    assert.equal(h.model.shuttleTelemetry.cargoBoundToFork, false, '叉上不得再有绑定货物');
  } finally {
    h.dispose();
  }
});

test('back 侧活动且 front 空闲时按 back 字段驱动同一套货叉（front 优先仲裁）', () => {
  const h = makeHarness();
  try {
    makeShuttleGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    const FETCH_FRAME = { ...POSITION_FRAME, back_command: 1, back_task: 7008 };

    h.apply({ ...FETCH_FRAME, back_movement_z: 1 }, 0.1, 60);
    assert.equal(h.state.shuttleCargoMeshes.size, 1, 'back 侧伸叉取货必须刷出货物');
    assert.ok(Math.abs(h.model.shuttleTelemetry.forkOffset) > 0.05, 'back 侧信号必须驱动共用货叉');

    // front 同时活动（front 优先）：back 的收叉信号不再生效，按 front 语义处理
    h.apply({ ...POSITION_FRAME, front_command: 1, front_movement_z: 0, front_task: 7008, back_command: 1, back_movement_z: 2 }, 0.1, 60);
    assert.ok(Math.abs(h.model.shuttleTelemetry.forkOffset) > 0.05, 'front 活动优先时 back 收叉信号不得生效');
  } finally {
    h.dispose();
  }
});
