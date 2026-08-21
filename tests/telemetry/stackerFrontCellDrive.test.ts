import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshBuilder, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { StackerTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/stackerDriver';
import { createStackerTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { createSpecializedTelemetrySharedState } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

function makeSnapshot(fields: Record<string, unknown>): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'stacker',
    assetCode: 'STK1',
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
    cellSteps: options.cellSteps ?? { columnStepX: 1, layerStepY: 1 },
    cellSize: { length: 1, height: 1, width: 1 },
    material: null,
    assetId: 'L1',
    signature: 'test',
    columns: options.columns,
    layers: options.layers,
    startColumn: options.startColumn,
    startLayer: options.startLayer ?? 1,
    deviceAssetCode: 'STK1',
    rowNumber: 2,
    storageDepth: 'near',
  } as unknown as LocatorRuntimeEntry;
}

function makeHarness() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const root = new TransformNode('stk_root', scene);
  const model = {
    assetCode: 'STK1',
    root,
    contentRoot: root,
    meshes: [],
    stackerTelemetry: createStackerTelemetryState(root),
    telemetryBinding: null,
    externalScriptRuntime: null,
  } as unknown as ModelRuntimeEntry;

  const ref: { locator: LocatorRuntimeEntry | null } = { locator: null };
  const logs: string[] = [];
  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [{ entityId: 'e1', model }],
    // 与 SceneRuntime.findLocatorByDevice 同规则：排号一致且列/层落在货格范围内才命中
    findLocatorByDevice: (_assetCode: string, x: number, y: number, z: number) => {
      const locator = ref.locator;
      if (!locator || locator.rowNumber !== z) return null;
      return x >= locator.startColumn && x < locator.startColumn + locator.columns && y >= locator.startLayer && y < locator.startLayer + locator.layers
        ? locator
        : null;
    },
    findLocatorsByDevice: () => (ref.locator ? [ref.locator] : []),
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
    getModelWorldBounds: () => ({ minimum: new Vector3(-0.5, 0, -0.5), maximum: new Vector3(0.5, 3, 0.5) }),
  };
  const context = {
    scene,
    state,
    host,
    disposeStackerCargo: () => undefined,
    disposeConveyorCargo: () => undefined,
    getOrCreateStackerCargo: () => { throw new Error('not used'); },
    getOrCreateConveyorCargo: () => { throw new Error('not used'); },
    adoptGlobalCargoByTask: () => null,
    adoptConveyorPlatformCargo: () => null,
    placeCargoIntoConveyorPlatform: () => false,
  };
  const driver = new StackerTelemetryDriver(context as never);
  return {
    driver,
    state,
    model,
    logs,
    scene,
    ref,
    dispose: () => { scene.dispose(); engine.dispose(); },
    apply: (fields: Record<string, unknown>, deltaSeconds = 0.1, frames = 1) => {
      for (let i = 0; i < frames; i += 1) {
        driver.applyToModel(model, makeSnapshot(fields), deltaSeconds);
      }
    },
  };
}

/** 当前位上报帧：front_x/front_y/front_z 三字段是位置唯一驱动源。 */
const POSITION_FRAME = {
  mode: 4,
  front_command: 0,
  back_command: 9,
  front_x: 10,
  front_y: 1,
  front_z: 2,
  movement_x: 0,
  movement_y: 0,
  normal: true,
  errorCode: 0,
};

test('front_x/front_y/front_z 当前位驱动行走与升降到库位支撑位', () => {
  const h = makeHarness();
  try {
    // 列 10 层 1（列下标 9）的货格支撑位在 (0, 2, 20)：行走轴 z 上应收敛到 20
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME, 0.1, 400);
    const position = h.model.stackerTelemetry.rootPosition;
    assert.ok(position, '行走位置必须被初始化');
    assert.ok(Math.abs(position.z - 20) < 1e-6, `必须走到货格支撑位 z=20，实际 ${position.z}`);
    assert.ok(Math.abs(h.model.stackerTelemetry.liftOffset - 2) < 1e-6, `升降必须对齐货格底面 y=2，实际 ${h.model.stackerTelemetry.liftOffset}`);
  } finally {
    h.dispose();
  }
});

test('首条 front_ 消息直接吸附到上报库位，不从原点缓慢追赶', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply(POSITION_FRAME, 0.1, 1);
    const position = h.model.stackerTelemetry.rootPosition;
    assert.ok(position);
    assert.ok(Math.abs(position.z - 20) < 1e-6, `首帧必须一步到位吸附到 z=20，实际 ${position.z}`);
    assert.ok(Math.abs(h.model.stackerTelemetry.liftOffset - 2) < 1e-6, `首帧升降必须吸附到 y=2，实际 ${h.model.stackerTelemetry.liftOffset}`);
  } finally {
    h.dispose();
  }
});

test('front_ 变化间隔已知时按窗口剩余时间自适应提速，上限 8 m/s', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    // 先吸附到列 10（z=20）
    h.apply(POSITION_FRAME, 0.1, 1);
    assert.ok(Math.abs(h.model.stackerTelemetry.rootPosition!.z - 20) < 1e-6);

    // 转到列 5（z=15）触发变化检测；随后人为固定变化间隔 300ms 并把位置归位，单独计量下一帧
    h.apply({ ...POSITION_FRAME, front_x: 5 }, 0.1, 1);
    h.model.stackerTelemetry.frontCellChangeIntervalMs = 300;
    h.model.stackerTelemetry.lastFrontCellChangedAtMs = performance.now();
    h.model.stackerTelemetry.rootPosition!.z = 20;
    // 5m / 0.3s ≈ 16.7 m/s，必须被钳到 8 m/s → 单帧走 0.8m
    h.apply({ ...POSITION_FRAME, front_x: 5 }, 0.1, 1);
    const z = h.model.stackerTelemetry.rootPosition!.z;
    assert.ok(Math.abs(z - (20 - 8 * 0.1)) < 1e-6, `自适应提速后单帧必须走 0.8m（8 m/s 上限），实际 z=${z}`);

    // 缺省（无变化间隔）时保持默认 1.2 m/s → 单帧走 0.12m
    h.model.stackerTelemetry.frontCellChangeIntervalMs = null;
    h.model.stackerTelemetry.lastFrontCellChangedAtMs = null;
    h.model.stackerTelemetry.rootPosition!.z = 20;
    h.apply({ ...POSITION_FRAME, front_x: 5 }, 0.1, 1);
    const z2 = h.model.stackerTelemetry.rootPosition!.z;
    assert.ok(Math.abs(z2 - (20 - 1.2 * 0.1)) < 1e-6, `无间隔信息时必须退回默认速度 1.2 m/s，实际 z=${z2}`);
  } finally {
    h.dispose();
  }
});

test('当前位未匹配到任何已绑定货格时报错一次，整机保持不动', () => {
  const h = makeHarness();
  try {
    h.apply(POSITION_FRAME);
    h.apply(POSITION_FRAME);
    const errors = h.logs.filter((message) => message.includes('未匹配到任何已绑定货格'));
    assert.equal(errors.length, 1, '同一当前位重复上报只能报错一次');
    assert.ok(errors[0].includes('排2 列10 层1'), `报错须含排/列/层，实际：${errors[0]}`);
    const position = h.model.stackerTelemetry.rootPosition;
    assert.ok(position);
    assert.ok(Math.abs(position.z) < 1e-9, `未绑定货格时不得移动，实际 z=${position.z}`);
    assert.equal(h.model.stackerTelemetry.liftOffset, 0);
  } finally {
    h.dispose();
  }
});

test('当前位超出已绑定货格列/层范围时报越界错误（含排号与范围），整机保持不动', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 2, startColumn: 1 });
    // 列越界：columns=10，front_x=15
    h.apply({ ...POSITION_FRAME, front_x: 15, front_y: 1 });
    // 层越界：layers=2，front_y=9
    h.apply({ ...POSITION_FRAME, front_x: 5, front_y: 9 });
    // 同一当前位重复上报不重复刷日志
    h.apply({ ...POSITION_FRAME, front_x: 15, front_y: 1 });

    const rangeErrors = h.logs.filter((message) => message.includes('超出已绑定货格范围'));
    assert.equal(rangeErrors.length, 2, `列/层越界各报一次，实际 ${rangeErrors.length} 条`);
    assert.ok(rangeErrors[0].includes('排2 列15 层1') && rangeErrors[0].includes('列1-10 层1-2'), `越界错误须含当前位与范围，实际：${rangeErrors[0]}`);
    assert.ok(rangeErrors[1].includes('列5 层9'));
    assert.equal(h.logs.filter((message) => message.includes('未匹配到任何已绑定货格')).length, 0, '越界不应报未绑定');
    const position = h.model.stackerTelemetry.rootPosition;
    assert.ok(position);
    assert.ok(Math.abs(position.z) < 1e-9, `越界时不得移动，实际 z=${position.z}`);
    assert.equal(h.model.stackerTelemetry.liftOffset, 0);
  } finally {
    h.dispose();
  }
});

test('front_ 三字段为 0 或缺失视为未上报：不驱动也不报错', () => {
  const h = makeHarness();
  try {
    h.apply({ ...POSITION_FRAME, front_x: 0, front_y: 0, front_z: 0 });
    const position = h.model.stackerTelemetry.rootPosition;
    assert.ok(position);
    assert.ok(Math.abs(position.z) < 1e-9);
    assert.equal(h.model.stackerTelemetry.liftOffset, 0);
    assert.equal(h.logs.filter((message) => message.includes('已绑定货格')).length, 0);
  } finally {
    h.dispose();
  }
});

test('front_ 任一非零即为真实坐标：起始列 0 的线框库位正常定位', () => {
  const h = makeHarness();
  try {
    // 起始列 0 起始层 1 的 1×2 线框：front(0, 2, 排2) → 列下标 0 层下标 1，支撑位 (0, 3, 11)
    h.ref.locator = makeLocator(h.scene, { columns: 1, layers: 2, startColumn: 0, startLayer: 1, rootPosition: new Vector3(0, 2, 11) });
    h.apply({ ...POSITION_FRAME, front_x: 0, front_y: 2, front_z: 2 }, 0.1, 1);
    const position = h.model.stackerTelemetry.rootPosition;
    assert.ok(position);
    assert.ok(Math.abs(position.z - 11) < 1e-6, `列 0 必须定位到支撑位 z=11，实际 ${position.z}`);
    assert.ok(Math.abs(h.model.stackerTelemetry.liftOffset - 3) < 1e-6, `层 2 必须定位到支撑位 y=3，实际 ${h.model.stackerTelemetry.liftOffset}`);
    assert.equal(h.logs.filter((message) => message.includes('已绑定货格')).length, 0, '合法坐标不得报错');
  } finally {
    h.dispose();
  }
});

/** 为模型补齐堆垛机几何：立柱 y[0,3]，载货台 y[0,0.2]，前后叉 y[0.2,0.3] → 物理升降行程 [0, 2.7]。 */
function makeStackerGeometry(h: ReturnType<typeof makeHarness>): void {
  const root = h.model.root;
  const addBox = (name: string, height: number, centerY: number) => {
    const mesh = MeshBuilder.CreateBox(name, { width: 0.4, height, depth: 0.4 }, h.scene);
    mesh.parent = root;
    mesh.position.set(0, centerY, 0);
    return mesh;
  };
  addBox('lizhu1.11', 3, 1.5);
  addBox('xiang.13', 0.2, 0.1);
  addBox('huocha.9', 0.1, 0.25);
  addBox('huocha2.10', 0.1, 0.25);
  root.computeWorldMatrix(true);
}

test('front_ 高层货格驱动升降时被整机框架物理钳制，载货台不得飞出立柱', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    // 层 20（层下标 19，layerStepY=1）支撑位 y=19，远超物理行程；必须被钳在框架顶部 3 - 货叉顶 0.3 = 2.7m
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 20, startColumn: 1, rootPosition: new Vector3(0, 0, 11) });
    h.apply({ ...POSITION_FRAME, front_y: 20 }, 0.1, 600);
    const liftOffset = h.model.stackerTelemetry.liftOffset;
    assert.ok(Math.abs(liftOffset - 2.7) < 1e-6, `升降必须停在物理上限 2.7m，实际 ${liftOffset}`);
  } finally {
    h.dispose();
  }
});

test('front_ 变化时快速收尾：货叉加速收回原点后才允许平移', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });

    // 先到位（列 10，支撑位 z=20）
    h.apply(POSITION_FRAME, 0.1, 400);
    assert.ok(Math.abs(h.model.stackerTelemetry.rootPosition!.z - 20) < 1e-6);

    // 伸前叉：目标行程由货格几何解算，必须大于 0
    h.apply({ ...POSITION_FRAME, front_movement_z: 1 }, 0.1, 60);
    const extended = h.model.stackerTelemetry.frontForkOffset;
    assert.ok(extended > 0.05, `前叉必须已伸出，实际 ${extended}`);

    // front_ 跳到列 5：进入 catch-up，收叉期间整机冻结
    h.apply({ ...POSITION_FRAME, front_x: 5 }, 0.1, 1);
    assert.equal(h.model.stackerTelemetry.forkCatchUp, true, 'front_ 变化且货叉已伸出必须进入 catch-up');
    assert.ok(Math.abs(h.model.stackerTelemetry.rootPosition!.z - 20) < 1e-9, '收叉期间行走必须冻结');

    // 加速收叉（0.25m/s × 4 倍率）迅速归零并退出 catch-up
    h.apply({ ...POSITION_FRAME, front_x: 5 }, 0.1, 10);
    assert.equal(h.model.stackerTelemetry.frontForkOffset, 0);
    assert.equal(h.model.stackerTelemetry.forkCatchUp, false);

    // 退出 catch-up 后向新当前位（列 5，支撑位 z=15）平移
    h.apply({ ...POSITION_FRAME, front_x: 5 }, 0.1, 200);
    assert.ok(Math.abs(h.model.stackerTelemetry.rootPosition!.z - 15) < 1e-6, `收叉完成后必须走到新货格 z=15，实际 ${h.model.stackerTelemetry.rootPosition!.z}`);
  } finally {
    h.dispose();
  }
});

test('取货绑定后 command 1→3 伴随库位跳变不销毁货物：已绑定货物随叉随行不算动作未完结', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    const FETCH_FRAME = { ...POSITION_FRAME, front_command: 1, front_task: 7001 };

    // 到位后在列 10 取货：伸叉刷货 → 到位绑定 → 收叉带回
    h.apply(FETCH_FRAME, 0.1, 10);
    h.apply({ ...FETCH_FRAME, front_movement_z: 1 }, 0.1, 60);
    assert.equal(h.state.stackerCargoMeshes.size, 1, '伸叉取货必须刷出货物');
    assert.equal(h.model.stackerTelemetry.frontCargoBoundToFork, true, '伸叉到位必须绑定货物上叉');
    h.apply({ ...FETCH_FRAME, front_movement_z: 2 }, 0.1, 60);
    assert.equal(h.model.stackerTelemetry.frontForkOffset, 0, '收叉必须归零');

    // 真实 WCS 模式：command 直接 1→3 且 front_ 同帧跳到新列（行走开始），已绑定货物不得被中途放货收尾销毁
    h.apply({ ...FETCH_FRAME, front_command: 3, front_x: 5, front_movement_z: 0 }, 0.1, 1);
    assert.equal(h.model.stackerTelemetry.forkCatchUp, false, '已绑定货物随行不得进入 catch-up');
    assert.equal(h.state.stackerCargoMeshes.size, 1, '库位跳变不得销毁已绑定货物');
    assert.notEqual(h.model.stackerTelemetry.frontCargoKey, null, '货物引用必须保留');
    assert.equal(h.model.stackerTelemetry.frontCargoBoundToFork, true, '货物必须保持绑定随叉随行');

    // 行走途中持续 command=3 + 库位连续更新：货物始终存活
    h.apply({ ...FETCH_FRAME, front_command: 3, front_x: 4, front_movement_z: 0 }, 0.1, 1);
    h.apply({ ...FETCH_FRAME, front_command: 3, front_x: 3, front_movement_z: 0 }, 0.1, 1);
    assert.equal(h.state.stackerCargoMeshes.size, 1, '放货行走途中货物必须存活');
  } finally {
    h.dispose();
  }
});


test('取货绑定全程保持货物世界朝向：货叉托举不改变货物姿态（不 snap 到机体朝向）', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    // locator 默认 root 绕 Y 转 -90°（本地 +X 映射到世界 +Z），与机体 identity 朝向可区分
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    const FETCH_FRAME = { ...POSITION_FRAME, front_command: 1, front_task: 7001 };

    h.apply({ ...FETCH_FRAME, front_movement_z: 1 }, 0.1, 1);
    assert.equal(h.state.stackerCargoMeshes.size, 1, '伸叉取货必须刷出货物');
    const cargo = [...h.state.stackerCargoMeshes.values()][0];
    const beforeBind = cargo.root.rotationQuaternion!.clone();
    assert.ok(
      Math.abs(Quaternion.Dot(beforeBind, Quaternion.Identity())) < 0.999,
      '未绑定货物必须取货格朝向而非机体 identity 朝向',
    );

    // 伸叉到位触发绑定：朝向必须保持（旧实现 snap 到机体 identity）
    h.apply({ ...FETCH_FRAME, front_movement_z: 1 }, 0.1, 60);
    assert.equal(h.model.stackerTelemetry.frontCargoBoundToFork, true, '伸叉到位必须绑定货物上叉');
    assert.ok(
      Math.abs(Quaternion.Dot(cargo.root.rotationQuaternion!, beforeBind)) > 0.999,
      '绑定后货物朝向必须保持绑定前朝向',
    );

    // 收叉 + command 1→3 行走：朝向仍保持
    h.apply({ ...FETCH_FRAME, front_movement_z: 2 }, 0.1, 60);
    h.apply({ ...FETCH_FRAME, front_command: 3, front_x: 9, front_movement_z: 0 }, 0.1, 3);
    assert.ok(
      Math.abs(Quaternion.Dot(cargo.root.rotationQuaternion!, beforeBind)) > 0.999,
      '搬运全程货物朝向必须保持',
    );
  } finally {
    h.dispose();
  }
});

test('放货叉未达行程时收叉边沿即解绑落货：货物不随叉带回', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    const PLACE_FRAME = { ...POSITION_FRAME, front_command: 3, front_task: 7002 };

    // 放货相位补建叉上货物并立即绑定
    h.apply(PLACE_FRAME, 0.1, 1);
    assert.equal(h.state.stackerCargoMeshes.size, 1, '放货相位必须补建叉上货物');
    assert.equal(h.model.stackerTelemetry.frontCargoBoundToFork, true, '放货补建货物必须立即绑定');

    // 伸出 2 帧（约 0.05m，远未达满行程 0.8m）：到位判定不触发，货物保持绑定
    h.apply({ ...PLACE_FRAME, front_movement_z: 1 }, 0.1, 2);
    assert.equal(h.model.stackerTelemetry.frontCargoBoundToFork, true, '未达行程前货物必须保持绑定');

    // 收叉边沿：按到达动作点立即解绑落货，货物留在目标箱位支撑位
    h.apply({ ...PLACE_FRAME, front_movement_z: 2 }, 0.1, 1);
    assert.equal(h.model.stackerTelemetry.frontCargoBoundToFork, false, '收叉边沿必须立即解绑落货');
    assert.notEqual(h.model.stackerTelemetry.frontCargoHoldPosition, null, '解绑后货物必须留存目标箱位支撑位');

    // 继续收叉至归零：货物静止于箱位，不随叉带回
    h.apply({ ...PLACE_FRAME, front_movement_z: 2 }, 0.1, 60);
    assert.equal(h.model.stackerTelemetry.frontForkOffset, 0, '收叉必须归零');
    assert.equal(h.model.stackerTelemetry.frontCargoBoundToFork, false, '货物不得随叉带回');
    assert.equal(h.state.stackerCargoMeshes.size, 1, '货物必须留存在箱位');
    const cargo = [...h.state.stackerCargoMeshes.values()][0];
    assert.ok(
      Vector3.Distance(cargo.root.position, new Vector3(0, 2, 20)) < 1e-6,
      `货物必须静止于目标箱位支撑位 (0,2,20)，实际 ${cargo.root.position}`,
    );
  } finally {
    h.dispose();
  }
});

test('取货叉未达行程时收叉边沿即绑定上叉：货物随叉带回', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(0, 2, 11) });
    const FETCH_FRAME = { ...POSITION_FRAME, front_command: 1, front_task: 7003 };

    h.apply({ ...FETCH_FRAME, front_movement_z: 1 }, 0.1, 2);
    assert.equal(h.state.stackerCargoMeshes.size, 1, '伸叉取货必须刷出货物');
    assert.equal(h.model.stackerTelemetry.frontCargoBoundToFork, false, '未达行程前货物不得绑定');

    h.apply({ ...FETCH_FRAME, front_movement_z: 2 }, 0.1, 1);
    assert.equal(h.model.stackerTelemetry.frontCargoBoundToFork, true, '收叉边沿必须立即绑定上叉');

    h.apply({ ...FETCH_FRAME, front_movement_z: 2 }, 0.1, 60);
    assert.equal(h.model.stackerTelemetry.frontForkOffset, 0, '收叉必须归零');
    assert.equal(h.model.stackerTelemetry.frontCargoBoundToFork, true, '货物必须随叉带回');
    assert.equal(h.state.stackerCargoMeshes.size, 1, '货物必须存活');
  } finally {
    h.dispose();
  }
});

test('伸叉方向由货格几何决定：货格在 +x 侧时 movement 3（旧"左伸"码）也必须朝 +x 伸', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    // 列沿世界 +X 排布：列 10（列下标 9）支撑位在 (20, 2, 0)，叉收回位中心 x=0
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(11, 2, 0), rootRotationY: 0 });
    h.apply(POSITION_FRAME, 0.1, 10);

    h.apply({ ...POSITION_FRAME, front_movement_z: 3 }, 0.1, 60);
    const extended = h.model.stackerTelemetry.frontForkOffset;
    assert.ok(Math.abs(extended - 0.8) < 1e-6, `movement 3 必须按几何朝 +x 伸到满行程 0.8，实际 ${extended}`);

    // 收回与方向无关：movement 2/4 均归 0
    h.apply({ ...POSITION_FRAME, front_movement_z: 4 }, 0.1, 60);
    assert.equal(h.model.stackerTelemetry.frontForkOffset, 0);
  } finally {
    h.dispose();
  }
});

test('伸叉方向由货格几何决定：货格在 −x 侧时 movement 1（旧"右伸"码）也必须朝 −x 伸', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    // 列沿世界 +X 排布但货格在负侧：列 10 支撑位在 (−20, 2, 0)
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, rootPosition: new Vector3(-29, 2, 0), rootRotationY: 0 });
    h.apply(POSITION_FRAME, 0.1, 10);

    h.apply({ ...POSITION_FRAME, front_movement_z: 1 }, 0.1, 60);
    const extended = h.model.stackerTelemetry.frontForkOffset;
    assert.ok(Math.abs(extended + 0.8) < 1e-6, `movement 1 必须按几何朝 −x 伸到满行程 −0.8，实际 ${extended}`);

    h.apply({ ...POSITION_FRAME, front_movement_z: 2 }, 0.1, 60);
    assert.equal(h.model.stackerTelemetry.frontForkOffset, 0);
  } finally {
    h.dispose();
  }
});
