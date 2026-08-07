import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { StackerTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/stackerDriver';
import { createStackerTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { createSpecializedTelemetrySharedState } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

/** 与 deviceTelemetry.createLocationKey 同规则：目标位全 0 或字段缺失时无目标位。 */
function makeSnapshot(fields: Record<string, unknown>): DeviceTelemetrySnapshot {
  const targets = [fields.to_x, fields.to_y, fields.to_z];
  const allNumbers = targets.every((value) => typeof value === 'number');
  const allZero = allNumbers && targets.every((value) => value === 0);
  const targetLocationKey = allNumbers && !allZero ? targets.join('-') : null;
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
    targetLocationKey,
    hasTargetLocation: targetLocationKey !== null,
    faulted: false,
    message: '',
  };
}

/** 构建 columns×layers 的单排 Locator，cellPositions 按（层优先行展开）下标放置支撑位为 position 的货格。 */
function makeLocator(
  scene: Scene,
  options: { columns: number; layers: number; startColumn: number; cellPositions: Record<number, Vector3> },
): LocatorRuntimeEntry {
  const root = new TransformNode('locator_root', scene);
  const boxCount = options.columns * options.layers;
  const boxes = Array.from({ length: boxCount }, (_, index) => {
    const mesh = MeshBuilder.CreateBox(`cell_${index}`, { size: 2 }, scene);
    mesh.parent = root;
    const support = options.cellPositions[index];
    // size=2 的 box 中心抬高 1m 后底面即支撑位
    mesh.position.set(support?.x ?? -100, (support?.y ?? 0) + 1, support?.z ?? -100);
    return mesh;
  });
  root.computeWorldMatrix(true);
  return {
    entityId: 'loc1',
    root,
    boxes,
    material: null,
    assetId: 'L1',
    signature: 'test',
    columns: options.columns,
    layers: options.layers,
    startColumn: options.startColumn,
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
    findLocatorByDevice: () => ref.locator,
    findLocatorByDeviceAnyRow: (_assetCode: string, x: number, y: number) => {
      const locator = ref.locator;
      if (!locator) return null;
      // 与 SceneRuntime.findLocatorByDeviceAnyRow 同规则：仅当列/层落在货格范围内才命中
      return x >= locator.startColumn && x < locator.startColumn + locator.columns && y >= 1 && y <= locator.layers
        ? locator
        : null;
    },
    findLocatorsByDevice: () => (ref.locator ? [ref.locator] : []),
    getLocatorTarget: () => ref.locator,
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
    setGeneratedCargoRootPose: () => undefined,
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

/** 与 temp.log 现场帧一致：空闲、to 全 0、携带 distance 编码器值。 */
const IDLE_FRAME = {
  mode: 4,
  front_command: 0,
  back_command: 9,
  front_x: 10,
  front_y: 1,
  front_z: 0,
  to_x: 0,
  to_y: 0,
  to_z: 0,
  movement_x: 0,
  movement_y: 0,
  distance_x: 13.1528,
  distance_y: 0.3501,
  normal: true,
  errorCode: 0,
};

test('空闲时按 front_x/front_y 跨排吸附已绑定货格，distance 编码器不再校准', () => {
  const h = makeHarness();
  try {
    // 列 10 层 1（下标 9）的货格支撑位在 (0, 2, 20)：行走轴 z 上应收敛到 20 而不是 distance_x 的 13.1528
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, cellPositions: { 9: new Vector3(0, 2, 20) } });
    h.apply(IDLE_FRAME, 0.1, 400);
    const position = h.model.stackerTelemetry.rootPosition;
    assert.ok(position, '行走位置必须被初始化');
    assert.ok(Math.abs(position.z - 20) < 1e-6, `空闲吸附必须走到货格支撑位 z=20，实际 ${position.z}`);
    assert.ok(Math.abs(h.model.stackerTelemetry.liftOffset - 2) < 1e-6, `升降必须对齐货格底面 y=2，实际 ${h.model.stackerTelemetry.liftOffset}`);
  } finally {
    h.dispose();
  }
});

test('空闲且无任何已绑定货格时报错一次，整机保持不动', () => {
  const h = makeHarness();
  try {
    h.apply(IDLE_FRAME);
    h.apply(IDLE_FRAME);
    const errors = h.logs.filter((message) => message.includes('未匹配到任何已绑定货格'));
    assert.equal(errors.length, 1, '同一当前位重复上报只能报错一次');
    const position = h.model.stackerTelemetry.rootPosition;
    assert.ok(position);
    assert.ok(Math.abs(position.z) < 1e-9, `未绑定货格时不得移动，实际 z=${position.z}`);
    assert.equal(h.model.stackerTelemetry.liftOffset, 0);
  } finally {
    h.dispose();
  }
});

test('取货/放货命令期间不做空闲吸附', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 1, startColumn: 1, cellPositions: { 9: new Vector3(0, 2, 20) } });
    h.apply({ ...IDLE_FRAME, front_command: 1 }, 0.1, 50);
    const position = h.model.stackerTelemetry.rootPosition;
    assert.ok(position);
    assert.ok(Math.abs(position.z) < 1e-9, `取货命令期间不得按 front_x/front_y 吸附，实际 z=${position.z}`);
    assert.equal(h.model.stackerTelemetry.liftOffset, 0);
  } finally {
    h.dispose();
  }
});

test('当前位超出已绑定货格列/层范围时报越界错误（含范围信息），整机保持不动', () => {
  const h = makeHarness();
  try {
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 2, startColumn: 1, cellPositions: {} });
    // 列越界：columns=10，front_x=15
    h.apply({ ...IDLE_FRAME, front_x: 15, front_y: 1 });
    // 层越界：layers=2，front_y=9
    h.apply({ ...IDLE_FRAME, front_x: 5, front_y: 9 });
    // 同一当前位重复上报不重复刷日志
    h.apply({ ...IDLE_FRAME, front_x: 15, front_y: 1 });

    const rangeErrors = h.logs.filter((message) => message.includes('超出已绑定货格范围'));
    assert.equal(rangeErrors.length, 2, `列/层越界各报一次，实际 ${rangeErrors.length} 条`);
    assert.ok(rangeErrors[0].includes('列15 层1') && rangeErrors[0].includes('列1-10 层1-2'), `越界错误须含当前位与范围，实际：${rangeErrors[0]}`);
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

test('front_x/front_y 为 0 视为未上报：不吸附也不报错', () => {
  const h = makeHarness();
  try {
    h.apply({ ...IDLE_FRAME, front_x: 0, front_y: 0 });
    const position = h.model.stackerTelemetry.rootPosition;
    assert.ok(position);
    assert.ok(Math.abs(position.z) < 1e-9);
    assert.equal(h.logs.filter((message) => message.includes('未匹配到任何已绑定货格')).length, 0);
  } finally {
    h.dispose();
  }
});

test('有效目标位（to_x/to_y/to_z）驱动优先于空闲吸附', () => {
  const h = makeHarness();
  try {
    // 列 5 层 1（下标 4）支撑位 (0, 1.5, 8)；列 10 层 1（下标 9）支撑位 (0, 2, 20)
    h.ref.locator = makeLocator(h.scene, {
      columns: 10,
      layers: 1,
      startColumn: 1,
      cellPositions: { 4: new Vector3(0, 1.5, 8), 9: new Vector3(0, 2, 20) },
    });
    h.apply({ ...IDLE_FRAME, to_x: 5, to_y: 1, to_z: 2, front_x: 10, front_y: 1 }, 0.1, 400);
    const position = h.model.stackerTelemetry.rootPosition;
    assert.ok(position);
    assert.ok(Math.abs(position.z - 8) < 1e-6, `目标位驱动必须走到 z=8，实际 ${position.z}`);
    assert.ok(Math.abs(h.model.stackerTelemetry.liftOffset - 1.5) < 1e-6);
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

test('movement_y 持续上升时被整机框架物理钳制，载货台不得飞出立柱', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    // 0.3m/s × 30s = 9m 请求行程，必须被钳在框架顶部 3 - 货叉顶 0.3 = 2.7m
    h.apply({ ...IDLE_FRAME, front_x: 0, front_y: 0, movement_y: 1 }, 0.1, 300);
    const liftOffset = h.model.stackerTelemetry.liftOffset;
    assert.ok(Math.abs(liftOffset - 2.7) < 1e-6, `升降必须停在物理上限 2.7m，实际 ${liftOffset}`);
  } finally {
    h.dispose();
  }
});

test('front_y 越界报错后 movement_y 兜底上升同样受物理钳制', () => {
  const h = makeHarness();
  try {
    makeStackerGeometry(h);
    h.ref.locator = makeLocator(h.scene, { columns: 10, layers: 2, startColumn: 1, cellPositions: {} });
    h.apply({ ...IDLE_FRAME, front_x: 5, front_y: 9, movement_y: 1 }, 0.1, 300);
    const errors = h.logs.filter((message) => message.includes('超出已绑定货格范围'));
    assert.equal(errors.length, 1, '同一当前位只报一次越界错误');
    const liftOffset = h.model.stackerTelemetry.liftOffset;
    assert.ok(Math.abs(liftOffset - 2.7) < 1e-6, `越界报错后载货台不得飞出模型，实际 ${liftOffset}`);
  } finally {
    h.dispose();
  }
});
