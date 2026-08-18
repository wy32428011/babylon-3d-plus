import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

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

/** harness bounds 跨度 4m（x: -2..2）。 */
const SPAN = 4;
/** 内置货箱轴向 0.72 → 兜底行程半径 1.64。 */
const FALLBACK_HALF_RANGE = resolveConveyorCargoTravelHalfRange(SPAN, CONVEYOR_CARGO_SIZE.x);

function makeSnapshot(fields: Record<string, unknown>, receivedAt: number = Date.now()): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'conveyor',
    assetCode: 'CV1',
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

function makeHarness() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const root = new TransformNode('cv1_root', scene);
  const model = {
    assetCode: 'CV1',
    root,
    contentRoot: root,
    meshes: [],
    conveyorTelemetry: createConveyorTelemetryState(),
    telemetryBinding: { cargoOriginDevice: true },
    externalScriptRuntime: null,
  } as unknown as ModelRuntimeEntry;

  const host = {
    pushLog: () => undefined,
    collectModels: () => [{ entityId: 'e1', model }],
    findLocatorByDevice: () => null,
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
    getModelWorldBounds: () => ({ minimum: new Vector3(-2, 0, -0.5), maximum: new Vector3(2, 1, 0.5) }),
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
    detachClaimedCargoByReference: () => null,
  };
  const driver = new ConveyorTelemetryDriver(context as never);
  return {
    driver,
    state,
    model,
    scene,
    dispose: () => { scene.dispose(); engine.dispose(); },
    apply: (fields: Record<string, unknown>, deltaSeconds = 0.1, frames = 1) => {
      for (let i = 0; i < frames; i += 1) {
        driver.applyToModel(model, makeSnapshot(fields), deltaSeconds);
      }
    },
  };
}

const RUNNING = { task: 1, front_has_goods: 1, back_has_goods: 0, movement_x: 1 };

function currentCargo(h: ReturnType<typeof makeHarness>): ConveyorCargoRuntimeEntry {
  const cargo = h.state.conveyorCargoMeshes.get(h.driver.getConveyorCargoKey('CV1', 'cargo'));
  assert.ok(cargo, '货箱必须已刷出');
  return cargo;
}

/** 给货箱挂一个生成器模板输出：沿行走轴（x）长度 lengthX 的 Box。 */
function attachMeshOutput(h: ReturnType<typeof makeHarness>, cargo: ConveyorCargoRuntimeEntry, lengthX: number, signature: string): void {
  const mesh = MeshBuilder.CreateBox(`tpl_${signature}`, { width: lengthX, height: 0.5, depth: 0.5 }, h.scene);
  mesh.parent = cargo.root;
  cargo.outputOwner = {
    activeTargetSignature: signature,
    output: { kind: 'mesh', mesh },
  } as unknown as ConveyorCargoRuntimeEntry['outputOwner'];
}

test('模板未就绪时按内置货箱长度钳制终点（兜底 0.72）', () => {
  const h = makeHarness();
  try {
    h.apply(RUNNING, 0.1, 200);
    assert.equal(h.model.conveyorTelemetry.cargoTravelOffset, FALLBACK_HALF_RANGE, '货箱中心必须停在跨度/2 − 0.72/2');
  } finally {
    h.dispose();
  }
});

test('生成器模板实测长度驱动终点钳制：2m 模板停在跨度/2 − 1', () => {
  const h = makeHarness();
  try {
    h.apply(RUNNING);
    const cargo = currentCargo(h);
    attachMeshOutput(h, cargo, 2, 'sig-2m');

    h.apply(RUNNING, 0.1, 200);
    const expected = resolveConveyorCargoTravelHalfRange(SPAN, 2);
    assert.equal(h.model.conveyorTelemetry.cargoTravelOffset, expected, '货箱中心必须停在跨度/2 − 实测半长');
    assert.notEqual(expected, FALLBACK_HALF_RANGE);
    assert.deepEqual(cargo.axialLengthCache, { key: 'sig-2m:x', lengthMeters: 2 });
  } finally {
    h.dispose();
  }
});

test('同一模板签名命中缓存不重测，签名变化后按新模板重测', () => {
  const h = makeHarness();
  try {
    h.apply(RUNNING);
    const cargo = currentCargo(h);
    attachMeshOutput(h, cargo, 2, 'sig-a');
    h.apply(RUNNING, 0.1, 200);
    assert.equal(h.model.conveyorTelemetry.cargoTravelOffset, resolveConveyorCargoTravelHalfRange(SPAN, 2));

    // 同签名：模板 mesh 被替换/尺寸变化也不重测（缓存仍按 2m 钳制）
    attachMeshOutput(h, cargo, 3, 'sig-a');
    h.apply(RUNNING, 0.1, 1);
    assert.equal(h.model.conveyorTelemetry.cargoTravelOffset, resolveConveyorCargoTravelHalfRange(SPAN, 2));

    // 签名变化：按新模板 3m 重测，终点钳制更新
    attachMeshOutput(h, cargo, 3, 'sig-b');
    h.apply(RUNNING, 0.1, 1);
    assert.equal(h.model.conveyorTelemetry.cargoTravelOffset, resolveConveyorCargoTravelHalfRange(SPAN, 3));
    assert.deepEqual(cargo.axialLengthCache, { key: 'sig-b:x', lengthMeters: 3 });
  } finally {
    h.dispose();
  }
});
