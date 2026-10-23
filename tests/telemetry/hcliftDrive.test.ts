import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshBuilder, NullEngine, Scene, TransformNode } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { HcliftTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/hcliftDriver';
import { createHcliftTelemetryState, createShuttleTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { createSpecializedTelemetrySharedState } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';
import { getLiftMotionFrame } from '../../src/runtime/babylon/telemetry/liftMotionState';

function makeSnapshot(fields: Record<string, unknown>): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default', topic: 'test/hclift', deviceType: 'hclift', assetCode: '1701',
    payloadDeviceCode: null, sourceTimestamp: null, sequence: null, receivedAt: Date.now(),
    fields, currentLocationKey: null, targetLocationKey: null, hasTargetLocation: false,
    faulted: false, message: '',
  };
}

function makeHarness(options: { withShuttle?: boolean; shuttleAisle?: string } = {}) {
  const withShuttle = options.withShuttle ?? true;
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const root = new TransformNode('hclift_root', scene);

  // 载货台两块板：包围盒中心 (0,0.5,0)、顶面 0.55
  for (const [index, name] of ['Box050', 'Box051'].entries()) {
    const deck = MeshBuilder.CreateBox(name, { width: 0.6, height: 0.1, depth: 1 }, scene);
    deck.parent = root;
    deck.position.set(index === 0 ? -0.3 : 0.3, 0.5, 0);
  }
  root.computeWorldMatrix(true);

  const hcliftModel = {
    assetCode: '1701',
    root,
    contentRoot: root,
    meshes: [],
    hcliftTelemetry: createHcliftTelemetryState(root),
    telemetryBinding: { aisleCode: 'A1' },
    externalScriptRuntime: {
      getDataDrivenConfigs: () => [{
        device: { devType: 'hclift' },
        motion: { lift: { nodes: ['Box050', 'Box051'], speed: 1 } },
        cargo: { nodes: ['Box050', 'Box051'] },
      }],
    },
    entitySnapshot: { id: 'hclift1', components: { modelAsset: { parameterValues: {} } } },
    assetHandle: {},
    stackerTelemetryReady: true,
  } as unknown as ModelRuntimeEntry;

  let shuttleModel: ModelRuntimeEntry | null = null;
  if (withShuttle) {
    const shuttleRoot = new TransformNode('shuttle_root', scene);
    shuttleModel = {
      assetCode: '1',
      root: shuttleRoot,
      contentRoot: shuttleRoot,
      meshes: [],
      shuttleTelemetry: createShuttleTelemetryState(shuttleRoot),
      telemetryBinding: null,
      externalScriptRuntime: { getDataDrivenConfigs: () => [{ device: { devType: 'shuttle' } }] },
      entitySnapshot: {
        id: 's1',
        components: { modelAsset: { parameterValues: { aisleCode: options.shuttleAisle ?? 'A1' } } },
      },
    } as unknown as ModelRuntimeEntry;
  }

  const platformRoot = new TransformNode('platform_root', scene);
  platformRoot.computeWorldMatrix(true);
  const platform = {
    entityId: 'p1',
    root: platformRoot,
    kind: 'layerChangePlatform',
    startColumn: -1,
    columns: 1,
    startLayer: 1,
    layers: 4,
    rowNumber: 1,
    aisleCode: 'A1',
    deviceAssetCode: '',
    columnReversed: false,
    cellSteps: { columnStepX: 1, layerStepY: 1 },
    cellSize: { length: 1, height: 1, width: 1 },
    platformTrackEndWorld: null,
  } as unknown as LocatorRuntimeEntry;

  const models: { entityId: string; model: ModelRuntimeEntry }[] = [{ entityId: 'hclift1', model: hcliftModel }];
  if (shuttleModel) models.push({ entityId: 's1', model: shuttleModel });

  const logs: string[] = [];
  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => models,
    findLayerChangePlatformLocator: () => platform,
  };
  const driver = new HcliftTelemetryDriver({ scene, state, host } as never);

  return {
    state,
    logs,
    hcliftModel,
    platform,
    dispose: () => { scene.dispose(); engine.dispose(); },
    apply: (fields: Record<string, unknown>, frames = 1, deltaSeconds = 0.1) => {
      for (let i = 0; i < frames; i += 1) driver.applyToModel(hcliftModel, makeSnapshot(fields), deltaSeconds);
    },
    setOccupancy: (patch: Partial<{ phase: 'entering' | 'loaded'; updatedAtMs: number; shuttleFaulted: boolean; shuttleStatus: number }>) => {
      state.hcliftDeckOccupancies.set('hclift1', {
        shuttleAssetCode: '1',
        aisleCode: 'A1',
        phase: 'loaded',
        shuttleStatus: 0,
        shuttleFaulted: false,
        updatedAtMs: Date.now(),
        ...patch,
      });
    },
  };
}

test('hclift 发布载货台水平中心与台面高度', () => {
  const h = makeHarness({ withShuttle: false });
  try {
    h.apply({ lift_current_level: 1, task_target_level: 1 });
    const surface = h.state.hcliftPlatformSurfaces.get('hclift1');
    assert.ok(surface, '必须发布载货台状态');
    assert.ok(Math.abs(surface.supportY - 0.55) < 1e-6, `台面高度应为 0.55，实际 ${surface.supportY}`);
    assert.ok(Math.abs(surface.deckCenter.x) < 1e-6 && Math.abs(surface.deckCenter.z) < 1e-6,
      `载货台中心应在 (0,0)，实际 (${surface.deckCenter.x},${surface.deckCenter.z})`);
  } finally {
    h.dispose();
  }
});

test('有 work_state 时仅 ws=5 放行升降：ws=2 即使占位 loaded 也不升降', () => {
  const h = makeHarness({ withShuttle: true });
  try {
    h.apply({ lift_current_level: 1, task_target_level: 1 });
    h.setOccupancy({ phase: 'loaded' });
    const target = { lift_current_level: 1, task_target_level: 3, work_state: 2 };

    h.apply(target, 30);
    assert.equal(h.hcliftModel.hcliftTelemetry.liftOffset, 0, '取小车完成（ws=2）也不得升降，只有 ws=5 放行');

    h.apply({ ...target, work_state: 5 }, 30);
    assert.ok(Math.abs(h.hcliftModel.hcliftTelemetry.liftOffset - 1.45) < 1e-6,
      `ws=5 移动中必须升到层 3 偏移 1.45，实际 ${h.hcliftModel.hcliftTelemetry.liftOffset}`);
  } finally {
    h.dispose();
  }
});

test('hclift 门控：1 取小车中/3 卸小车中锁高度，5 移动中放行换层动画，急停仍否决', () => {
  const h = makeHarness({ withShuttle: true });
  try {
    h.apply({ lift_current_level: 1, task_target_level: 1 });

    // 取小车中（ws=1）：无占位也不得升降
    h.apply({ lift_current_level: 1, task_target_level: 3, work_state: 1 }, 30);
    assert.ok(Math.abs(h.hcliftModel.hcliftTelemetry.liftOffset) < 1e-6,
      `取小车中必须锁高度，实际 ${h.hcliftModel.hcliftTelemetry.liftOffset}`);

    // 卸小车中（ws=3）：同样锁高度
    h.apply({ lift_current_level: 1, task_target_level: 3, work_state: 3 }, 30);
    assert.ok(Math.abs(h.hcliftModel.hcliftTelemetry.liftOffset) < 1e-6,
      `卸小车中必须锁高度，实际 ${h.hcliftModel.hcliftTelemetry.liftOffset}`);

    // 移动中（ws=5）：无占位也以工作状态放行换层动画
    h.apply({ lift_current_level: 1, task_target_level: 3, work_state: 5 }, 30);
    assert.ok(Math.abs(h.hcliftModel.hcliftTelemetry.liftOffset - 1.45) < 1e-6,
      `移动中必须执行升降动画到层 3，实际 ${h.hcliftModel.hcliftTelemetry.liftOffset}`);

    // 卸小车中（ws=3）：目标回层 1 也锁高度
    h.apply({ lift_current_level: 3, task_target_level: 1, work_state: 3 }, 30);
    assert.ok(Math.abs(h.hcliftModel.hcliftTelemetry.liftOffset - 1.45) < 1e-6,
      `卸小车中不得移动，实际 ${h.hcliftModel.hcliftTelemetry.liftOffset}`);

    // 移动中（ws=5）：允许回层 1
    h.apply({ lift_current_level: 3, task_target_level: 1, work_state: 5 }, 30);
    assert.ok(Math.abs(h.hcliftModel.hcliftTelemetry.liftOffset) < 1e-6,
      `移动中必须回层 1，实际 ${h.hcliftModel.hcliftTelemetry.liftOffset}`);

    // 仍能读到新鲜占位时，小车急停/故障继续否决
    h.setOccupancy({ phase: 'loaded', shuttleFaulted: true });
    h.apply({ lift_current_level: 1, task_target_level: 3, work_state: 5 }, 30);
    assert.ok(Math.abs(h.hcliftModel.hcliftTelemetry.liftOffset) < 1e-6, '小车急停时工作状态不得放行升降');
  } finally {
    h.dispose();
  }
});

test('无 work_state 字段的旧模型：保持原占位门控（无关联小车/其它巷道不阻塞）', () => {
  const h = makeHarness({ withShuttle: false });
  try {
    h.apply({ lift_current_level: 1, task_target_level: 1 });
    h.apply({ lift_current_level: 1, task_target_level: 3 }, 30);
    assert.ok(Math.abs(h.hcliftModel.hcliftTelemetry.liftOffset - 1.45) < 1e-6, '无关联小车时不得被门控阻塞');
  } finally {
    h.dispose();
  }

  const other = makeHarness({ withShuttle: true, shuttleAisle: 'A2' });
  try {
    other.apply({ lift_current_level: 1, task_target_level: 1 });
    other.apply({ lift_current_level: 1, task_target_level: 3 }, 30);
    assert.ok(Math.abs(other.hcliftModel.hcliftTelemetry.liftOffset - 1.45) < 1e-6, '其它巷道小车不得阻塞本提升机');
  } finally {
    other.dispose();
  }
});

test('急停（work_state=10）冻结升降', () => {
  const h = makeHarness({ withShuttle: true });
  try {
    h.apply({ lift_current_level: 1, task_target_level: 1 });
    h.setOccupancy({ phase: 'loaded' });
    h.apply({ lift_current_level: 1, task_target_level: 3, work_state: 5 }, 5);
    const before = h.hcliftModel.hcliftTelemetry.liftOffset;
    assert.ok(before > 0, '前置：已经开始升降');
    h.apply({ lift_current_level: 1, task_target_level: 3, work_state: 10 }, 10);
    assert.equal(h.hcliftModel.hcliftTelemetry.liftOffset, before, '急停期间必须冻结');
  } finally {
    h.dispose();
  }
});

test('小车占用载货台但急停：hclift 不得升降', () => {
  const h = makeHarness({ withShuttle: true });
  try {
    h.apply({ lift_current_level: 1, task_target_level: 1 });
    h.setOccupancy({ phase: 'loaded', shuttleStatus: 10 });
    h.apply({ lift_current_level: 1, task_target_level: 3, work_state: 5 }, 10);
    assert.equal(h.hcliftModel.hcliftTelemetry.liftOffset, 0, '车上急停时提升机不得升降');
  } finally {
    h.dispose();
  }
});


test('换层提升机摘要排除初层吸附，实际升降后按方向和真实速度输出', () => {
  const h = makeHarness({ withShuttle: false });
  try {
    h.apply({ lift_current_level: 2, task_target_level: 2 });
    let frame = getLiftMotionFrame(h.hcliftModel)!;
    assert.equal(frame.lift.direction, 0);
    assert.deepEqual(frame.front, { direction: 0, speed: 0 });
    assert.deepEqual(frame.back, { direction: 0, speed: 0 });
    h.apply({ lift_current_level: 2, task_target_level: 3 });
    frame = getLiftMotionFrame(h.hcliftModel)!;
    assert.equal(frame.lift.direction, 1);
    assert.ok(Math.abs(frame.lift.speed - 1) < 1e-6);
    h.apply({ lift_current_level: 2, task_target_level: 1 });
    assert.equal(getLiftMotionFrame(h.hcliftModel)!.lift.direction, -1);
    h.apply({ lift_current_level: 2, task_target_level: 1, work_state: 10 });
    assert.equal(getLiftMotionFrame(h.hcliftModel)!.lift.direction, 0);
  } finally { h.dispose(); }
});

test('换层提升机门控未满足与约束纠偏不产生箭头', () => {
  const h = makeHarness({ withShuttle: true });
  try {
    h.apply({ lift_current_level: 1, task_target_level: 1 });
    const waiting = { lift_current_level: 1, task_target_level: 3, work_state: 2 };
    h.apply(waiting);
    assert.equal(getLiftMotionFrame(h.hcliftModel)!.lift.direction, 0, 'ws=2 门控未满足不得产生箭头');
    const moving = { ...waiting, work_state: 5 };
    h.apply(moving);
    assert.equal(getLiftMotionFrame(h.hcliftModel)!.lift.direction, 1);
    h.hcliftModel.hcliftTelemetry.liftOffset = -100;
    h.apply(moving);
    assert.equal(getLiftMotionFrame(h.hcliftModel)!.lift.direction, 0, '范围纠偏不能解释为运行');
  } finally { h.dispose(); }
});

test('首帧同时上报当前层与目标层：目标偏移按吸附前基线解析，不叠加入场吸附位移', () => {
  const h = makeHarness({ withShuttle: false });
  try {
    // 展会实测首条报文：lift_current_level=4、task_target_level=1、work_state=1（取小车中）
    h.apply({ lift_current_level: 4, task_target_level: 1, work_state: 1 });
    const t = h.hcliftModel.hcliftTelemetry;
    assert.ok(Math.abs(t.liftOffset - 2.45) < 1e-6, `首帧必须吸附到当前层 4（偏移 2.45），实际 ${t.liftOffset}`);
    assert.equal(t.targetLevel, 1, '目标层必须记录为 1');
    assert.ok(
      t.liftTargetOffset !== null && Math.abs(t.liftTargetOffset) < 1e-6,
      `目标层 1 偏移必须为 0（吸附位移不得重复扣除），实际 ${t.liftTargetOffset}`,
    );

    // 移动中放行后下降到层 1，而不是漂移到站台范围之外
    h.apply({ lift_current_level: 4, task_target_level: 1, work_state: 5 }, 30);
    assert.ok(Math.abs(t.liftOffset) < 1e-6, `必须下降到层 1（偏移 0），实际 ${t.liftOffset}`);
    assert.ok(Math.abs(h.state.hcliftPlatformSurfaces.get('hclift1')!.supportY - 0.55) < 1e-6, '台面高度必须回到层 1');
  } finally { h.dispose(); }
});
