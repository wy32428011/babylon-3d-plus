import assert from 'node:assert/strict';
import test from 'node:test';

import { NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { ConveyorTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/conveyorDriver';
import { RgvTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/rgvDriver';
import {
  createConveyorTelemetryState,
  createRgvTelemetryState,
} from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import {
  createSpecializedTelemetrySharedState,
  type GeneratedCargoRuntimeEntry,
} from '../../src/runtime/babylon/telemetry/specialized/types';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

/**
 * RGV 列绑定一对多的订阅仲裁测试布局：
 * RGV1 在原点，行走轴为模型局部 z；列 5 绑定两台 conveyor（CVA 在 z=-4，CVB 在 z=+4），
 * 载货面中心（deckCenter）即列对齐基准。conveyor 行程轴为局部 x（与 conveyorTaskHandoff 一致）。
 */
const CVA_DECK = new Vector3(0.5, 0.8, -4);
const CVB_DECK = new Vector3(-0.5, 0.8, 4);

function makeRgvSnapshot(
  fields: Record<string, unknown>,
  receivedAt: number = Date.now(),
): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'rgv',
    assetCode: 'RGV1',
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

/** harness：RGV + 两台同列 conveyor 共享货物表，context 镜像 facade 的交付/门控实现。 */
function makeHarness() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const models = new Map<string, ModelRuntimeEntry>();
  const logs: string[] = [];

  const makeModel = (assetCode: string, center: Vector3, conveyorCapable: boolean): ModelRuntimeEntry => {
    const root = new TransformNode(`${assetCode}_root`, scene);
    root.position.copyFrom(center);
    const model = {
      assetCode,
      root,
      contentRoot: root,
      meshes: [],
      conveyorCapable,
      stackerCapable: false,
      rgvCapable: !conveyorCapable,
      conveyorTelemetry: createConveyorTelemetryState(),
      rgvTelemetry: createRgvTelemetryState(root),
      stackerTelemetry: null,
      telemetryBinding: null,
      externalScriptRuntime: null,
      entitySnapshot: { id: `e_${assetCode}` },
    } as unknown as ModelRuntimeEntry;
    models.set(assetCode, model);
    return model;
  };

  const rgvModel = makeModel('RGV1', Vector3.Zero(), false);
  rgvModel.telemetryBinding = { columnBindings: { '5': ['e_CVA', 'e_CVB'] } } as unknown as ModelRuntimeEntry['telemetryBinding'];
  makeModel('CVA', new Vector3(0, 0, -4), true);
  makeModel('CVB', new Vector3(0, 0, 4), true);

  const deckCenters: Record<string, Vector3> = { e_CVA: CVA_DECK, e_CVB: CVB_DECK };

  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [...models.values()].map((model) => ({ entityId: `e_${model.assetCode}`, model })),
    findLocatorByDevice: () => null,
    findLocatorsByDevice: () => [],
    findBuiltInSlotLocatorForHostModel: () => null,
    resolveCargoGeneratorForModel: () => null,
    resolveColumnTargetPose: (entityId: string) => {
      const model = models.get(entityId.replace(/^e_/, ''));
      if (!model) return null;
      return { position: model.root.position.clone(), rotation: Quaternion.Identity() };
    },
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
    setGeneratedCargoRootPose: (cargo: GeneratedCargoRuntimeEntry, position: Vector3, rotation: Quaternion) => {
      cargo.root.position.copyFrom(position);
      cargo.root.rotationQuaternion = rotation.clone();
    },
    disposeGeneratedCargo: () => undefined,
    getModelWorldBounds: (model: ModelRuntimeEntry) => ({
      minimum: model.root.position.add(new Vector3(-2, 0, -0.5)),
      maximum: model.root.position.add(new Vector3(2, 1, 0.5)),
    }),
  };

  let conveyorDriver!: ConveyorTelemetryDriver;
  let rgvDriver!: RgvTelemetryDriver;
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
    adoptConveyorPlatformCargo: () => null,
    placeCargoIntoConveyorPlatform: () => false,
    resolveConveyorDeckCenterWorld: (entityId: string) => deckCenters[entityId]?.clone() ?? null,
    // 镜像 SpecializedTelemetryRuntime.deliverRgvCargoToConveyorColumn：先预检再拆引用
    deliverRgvCargoToConveyorColumn: (entityId: string, cargoKey: string, task: string) => {
      const model = models.get(entityId.replace(/^e_/, ''));
      if (!model || !model.conveyorCapable) return false;
      if (!conveyorDriver.canAcceptRgvColumnPlacedCargo(model, task)) return false;
      const cargo = rgvDriver.detachClaimedCargoByKey(cargoKey);
      if (!cargo) return false;
      if (!conveyorDriver.acceptRgvColumnPlacedCargo(model, cargo, task)) {
        state.rgvCargoMeshes.set(cargoKey, cargo);
        return false;
      }
      return true;
    },
    isRgvCargoReadyForExternalPull: (cargo: GeneratedCargoRuntimeEntry) => rgvDriver.isRgvCargoReadyForExternalPull(cargo),
  };
  conveyorDriver = new ConveyorTelemetryDriver(context as never);
  rgvDriver = new RgvTelemetryDriver(context as never);

  return {
    state,
    logs,
    models: Object.fromEntries(models) as Record<string, ModelRuntimeEntry>,
    rgvModel,
    dispose: () => { scene.dispose(); engine.dispose(); },
    /** 镜像 facade 帧调度：应用 RGV 快照后执行帧尾外部持货拉取扫描。 */
    applyRgv: (fields: Record<string, unknown>, deltaSeconds = 0.1) => {
      rgvDriver.applyToModel(rgvModel, makeRgvSnapshot(fields), deltaSeconds);
      conveyorDriver.pullExternalHolderCargo();
    },
    /** 向 conveyor 货物表插入持有货物并置遥测引用（模拟输送线已持有的货箱）。 */
    insertConveyorCargo: (assetCode: string, task: string) => {
      const root = new TransformNode(`${assetCode}_cargo_root`, scene);
      const entry: GeneratedCargoRuntimeEntry = {
        assetCode,
        containerCode: '',
        task,
        root,
        outputOwner: null,
        fallback: null,
        generatorEntityId: null,
        handoff: null,
        axialLengthCache: null,
        lockedWorldRotation: null,
      };
      state.conveyorCargoMeshes.set(JSON.stringify([assetCode, 'cargo']), entry);
      models.get(assetCode)!.conveyorTelemetry.cargoCode = 'cargo';
      return entry;
    },
  };
}

/** 放货协议三帧：command 2 补建车上货 → movement_z 起转锁列 → 停转完成交接。 */
function runPlaceSequence(h: ReturnType<typeof makeHarness>, task: number): void {
  h.applyRgv({ front_command: 2, front_y: 5, front_task: task, front_movement_z: 0 });
  h.applyRgv({ front_command: 2, front_y: 5, front_task: task, front_movement_z: 1 });
  h.applyRgv({ front_command: 2, front_y: 5, front_task: task, front_movement_z: 0 });
}

test('同列多台放货：停转边沿把货物交付给正在等待该 task 的 conveyor，另一台无货', () => {
  const h = makeHarness();
  try {
    // CVA 等待 task 101（订阅在链），CVB 无等待
    h.models.CVA.conveyorTelemetry.pendingTask = '101';
    h.models.CVA.conveyorTelemetry.waitingTask = '101';

    runPlaceSequence(h, 101);

    assert.equal(h.state.rgvCargoMeshes.size, 0, 'RGV 货物表必须已清空');
    assert.equal(h.rgvModel.rgvTelemetry.frontCargoKey, null, 'RGV 前工位引用必须已清理');
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '货物必须交付给唯一一台 conveyor');
    const delivered = [...h.state.conveyorCargoMeshes.values()][0];
    assert.equal(delivered.assetCode, 'CVA', '等待方 CVA 必须收到货物');
    assert.equal(delivered.task, '101');
    const cvaState = h.models.CVA.conveyorTelemetry;
    assert.equal(cvaState.cargoCode, 'cargo', 'CVA 必须置持货引用');
    assert.equal(cvaState.pendingTask, null, '交付后清挂单');
    assert.equal(cvaState.waitingTask, null, '交付后清等待');
    assert.notEqual(cvaState.selfDriveDirection, 0, '承接后必须登记自驱走行');
    assert.equal(h.models.CVB.conveyorTelemetry.cargoCode, null, 'CVB 不得有货');
  } finally {
    h.dispose();
  }
});

test('同列多台放货：该列无任何 conveyor 等待时保持停转销毁语义', () => {
  const h = makeHarness();
  try {
    runPlaceSequence(h, 102);

    assert.equal(h.state.rgvCargoMeshes.size, 0, 'RGV 货物表必须已清空');
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '无等待方时货物必须销毁，不得进入 conveyor');
    assert.equal(h.rgvModel.rgvTelemetry.frontCargoKey, null);
  } finally {
    h.dispose();
  }
});

test('同列多台取货：行走对齐持有该 task 货物的 conveyor 载货面中心', () => {
  const h = makeHarness();
  try {
    h.insertConveyorCargo('CVB', '202');
    h.applyRgv({ front_command: 1, front_y: 5, front_task: 202, front_movement_z: 1 });
    assert.equal(h.rgvModel.rgvTelemetry.rootPosition?.z, CVB_DECK.z, '必须对齐持货方 CVB 的载货面');
  } finally {
    h.dispose();
  }
});

test('同列多台取货：无持货方时回退首个绑定实体', () => {
  const h = makeHarness();
  try {
    h.insertConveyorCargo('CVB', '999');
    h.applyRgv({ front_command: 1, front_y: 5, front_task: 202, front_movement_z: 1 });
    assert.equal(h.rgvModel.rgvTelemetry.rootPosition?.z, CVA_DECK.z, '无匹配持货方必须回退首个绑定 CVA');
  } finally {
    h.dispose();
  }
});
