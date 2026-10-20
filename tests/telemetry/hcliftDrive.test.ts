import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshBuilder, NullEngine, Scene, TransformNode } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { HcliftTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/hcliftDriver';
import { createHcliftTelemetryState, createShuttleTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { createSpecializedTelemetrySharedState } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

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

test('有关联小车时：无占位/入场中/过期/ws=1 不升降，loaded 且 ws=2 才升降', () => {
  const h = makeHarness({ withShuttle: true });
  try {
    h.apply({ lift_current_level: 1, task_target_level: 1 });
    const target = { lift_current_level: 1, task_target_level: 3, work_state: 2 };

    h.apply(target, 10);
    assert.equal(h.hcliftModel.hcliftTelemetry.liftOffset, 0, '无占位时不得升降');

    h.setOccupancy({ phase: 'entering' });
    h.apply(target, 10);
    assert.equal(h.hcliftModel.hcliftTelemetry.liftOffset, 0, '入场中不得升降');

    h.setOccupancy({ phase: 'loaded', updatedAtMs: Date.now() - 5000 });
    h.apply(target, 10);
    assert.equal(h.hcliftModel.hcliftTelemetry.liftOffset, 0, '占位过期不得升降');

    h.setOccupancy({ phase: 'loaded' });
    h.apply({ ...target, work_state: 1 }, 10);
    assert.equal(h.hcliftModel.hcliftTelemetry.liftOffset, 0, '取小车中（ws=1）不得升降');

    h.apply(target, 30);
    assert.ok(Math.abs(h.hcliftModel.hcliftTelemetry.liftOffset - 1.45) < 1e-6,
      `小车上台且 ws=2 后必须升到层 3 偏移 1.45，实际 ${h.hcliftModel.hcliftTelemetry.liftOffset}`);
  } finally {
    h.dispose();
  }
});

test('无关联小车（或小车在其它巷道）：保持旧行为，目标层变化即升降', () => {
  const h = makeHarness({ withShuttle: false });
  try {
    h.apply({ lift_current_level: 1, task_target_level: 1 });
    h.apply({ lift_current_level: 1, task_target_level: 3, work_state: 2 }, 30);
    assert.ok(Math.abs(h.hcliftModel.hcliftTelemetry.liftOffset - 1.45) < 1e-6, '无关联小车时不得被门控阻塞');
  } finally {
    h.dispose();
  }

  const other = makeHarness({ withShuttle: true, shuttleAisle: 'A2' });
  try {
    other.apply({ lift_current_level: 1, task_target_level: 1 });
    other.apply({ lift_current_level: 1, task_target_level: 3, work_state: 2 }, 30);
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
    h.apply({ lift_current_level: 1, task_target_level: 3, work_state: 2 }, 5);
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
    h.apply({ lift_current_level: 1, task_target_level: 3, work_state: 2 }, 10);
    assert.equal(h.hcliftModel.hcliftTelemetry.liftOffset, 0, '车上急停时提升机不得升降');
  } finally {
    h.dispose();
  }
});
