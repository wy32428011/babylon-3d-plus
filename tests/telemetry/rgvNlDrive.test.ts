import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshBuilder, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import { parseDeviceTelemetryMessage, type DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { RgvNlTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/rgvNlDriver';
import { SpecializedTelemetryRuntime } from '../../src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime';
import { createRgvNlTelemetryState, createStackerTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import {
  createSpecializedTelemetrySharedState,
  type GeneratedCargoRuntimeEntry,
} from '../../src/runtime/babylon/telemetry/specialized/types';
import { getNodesWorldBounds } from '../../src/runtime/babylon/runtimeNodeGeometry';
import {
  resolveBuiltInSlotLayoutParent,
  SceneLocatorController,
} from '../../src/runtime/babylon/scene-runtime/SceneLocatorController';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

const HOME_Z = 3;
const STACKER_Z = -3.5;
const SURFACE_Y = 1.1;

function makeSnapshot(fields: Record<string, unknown>, receivedAt: number): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'rgv_nl',
    assetCode: 'CUSTOM_RGV',
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
  const root = new TransformNode('custom_rgv_root', scene);
  const contentRoot = new TransformNode('custom_rgv_content', scene);
  contentRoot.parent = root;
  const track = MeshBuilder.CreateBox('track', { width: 2, height: 0.2, depth: 10 }, scene);
  track.parent = contentRoot;
  const deck = new TransformNode('载货台主体', scene);
  deck.parent = contentRoot;
  deck.position.z = HOME_Z;
  const surface = MeshBuilder.CreateBox('01', { width: 2, height: 0.2, depth: 2 }, scene);
  surface.parent = deck;
  surface.position.y = 1;
  root.computeWorldMatrix(true);

  const model = {
    assetCode: 'CUSTOM_RGV',
    root,
    contentRoot,
    meshes: [track, surface],
    rgvCapable: true,
    stackerTelemetry: createStackerTelemetryState(root),
    rgvNlTelemetry: createRgvNlTelemetryState(),
    telemetryBinding: null,
    entitySnapshot: {
      id: 'custom-rgv-entity',
      components: {
        modelAsset: {
          parameterValues: { aEndInset: 0.5, bEndInset: 1, travelSpeed: 2 },
        },
      },
    },
    externalScriptRuntime: {
      getDataDrivenConfigs: () => [{
        device: { devType: 'rgv_nl' },
        motion: {
          deckTransfer: {
            protocol: 'working_mode',
            speed: 0.8,
            speedParam: 'travelSpeed',
            deckNodes: ['载货台主体'],
            surfaceNodes: ['01'],
            homeEnd: 'b',
            aEndInsetParam: 'aEndInset',
            bEndInsetParam: 'bEndInset',
          },
        },
        cargo: {
          hasGoodsFields: ['front_has_goods', 'back_has_goods', 'has_goods'],
        },
      }],
    },
  } as unknown as ModelRuntimeEntry;

  const platformRoot = new TransformNode('custom_rgv_platform', scene);
  platformRoot.parent = deck;
  platformRoot.position.set(0, SURFACE_Y, 0);
  const platform = {
    entityId: 'custom-rgv-platform',
    root: platformRoot,
    columns: 1,
    layers: 1,
    startColumn: 1,
    startLayer: 1,
    columnReversed: false,
    cellSteps: { columnStepX: 0.72, layerStepY: 0.34 },
  } as unknown as LocatorRuntimeEntry;

  const host = {
    pushLog: () => undefined,
    collectModels: () => [{ entityId: 'custom-rgv-entity', model }],
    findLocatorByDevice: () => null,
    findBuiltInSlotLocatorForHostModel: (entityId: string) => entityId === 'custom-rgv-entity' ? platform : null,
    resolveBuiltInSlotHost: (locatorEntityId: string) => locatorEntityId === 'custom-rgv-platform' ? { model, locator: platform } : null,
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
    setGeneratedCargoRootPose: (cargo: GeneratedCargoRuntimeEntry, position: Vector3, rotation: Quaternion) => {
      cargo.root.position.copyFrom(position);
      cargo.root.rotationQuaternion = rotation.clone();
    },
    disposeGeneratedCargo: (cargo: GeneratedCargoRuntimeEntry) => cargo.root.dispose(),
    getModelWorldBounds: () => getNodesWorldBounds([track, deck]),
  };
  const context = {
    scene,
    state,
    host,
    disposeStackerCargo: () => undefined,
    disposeConveyorCargo: (cargo: GeneratedCargoRuntimeEntry) => host.disposeGeneratedCargo(cargo),
    disposeShuttleCargo: () => undefined,
    getOrCreateStackerCargo: () => { throw new Error('not used'); },
    getOrCreateConveyorCargo: () => { throw new Error('not used'); },
    getOrCreateShuttleCargo: () => { throw new Error('not used'); },
    adoptGlobalCargoByTask: () => null,
    detachClaimedCargoByReference: () => null,
  };
  const driver = new RgvNlTelemetryDriver(context as never);
  let receivedAt = 1000;
  return {
    model,
    deck,
    surface,
    platform,
    driver,
    state,
    host,
    scene,
    apply(fields: Record<string, unknown>, frames = 1, deltaSeconds = 0.1) {
      for (let index = 0; index < frames; index += 1) {
        receivedAt += 1;
        driver.applyToModel(model, makeSnapshot(fields, receivedAt), deltaSeconds);
      }
    },
    dispose() {
      scene.dispose();
      engine.dispose();
    },
  };
}

function makeExternalCargo(scene: Scene): GeneratedCargoRuntimeEntry {
  return {
    assetCode: 'STACKER',
    containerCode: 'BOX-2',
    task: '22',
    root: new TransformNode('incoming_cargo', scene),
    outputOwner: null,
    fallback: null,
    generatorEntityId: null,
    handoff: null,
    axialLengthCache: null,
    lockedWorldRotation: null,
  };
}

function assertNear(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-5, `${message}：期望 ${expected}，实际 ${actual}`);
}

test('working_mode=1：首载在B端，光电刷货，movement_x触发到A端，stacker取走后返回且不误重复刷货', () => {
  const h = makeHarness();
  try {
    h.apply({ working_mode: 1, movement_x: 0, has_goods: 0, task: 7 });
    assertNear(h.deck.position.z, HOME_Z, '首载必须保持模型默认B端上下货位');
    assert.equal(h.state.rgvNlCargoMeshes.size, 0);

    h.apply({ working_mode: 1, movement_x: 0, has_goods: 1, task: 7 });
    const cargo = h.state.rgvNlCargoMeshes.get(JSON.stringify(['CUSTOM_RGV', 'cargo']));
    assert.ok(cargo, '光电有货必须刷出货物');
    assert.equal(cargo.task, '7');
    assertNear(cargo.root.position.y, SURFACE_Y, '货物底面必须落在01节点上表面');
    assertNear(cargo.root.position.z, HOME_Z, '货物初始位于载货台中心');

    h.apply({ working_mode: 1, movement_x: 1, has_goods: 1, task: 7 });
    assertNear(h.deck.position.z, HOME_Z - 0.2, 'movement_x非零后载货台按设定速度向A端移动');
    h.platform.root.computeWorldMatrix(true);
    assertNear(h.platform.root.getAbsolutePosition().z, h.deck.position.z, '内置站台必须随载货台绑定移动');
    assertNear(cargo.root.position.z, h.deck.position.z, '货物必须随载货台移动');

    h.apply({ working_mode: 1, movement_x: 1, has_goods: 1, task: 7 }, 40);
    assertNear(h.deck.position.z, STACKER_Z, '载货台必须停在整体几何与A端内偏共同确定的端点');
    h.platform.root.computeWorldMatrix(true);
    assertNear(h.platform.root.getAbsolutePosition().z, STACKER_Z, '到位后站台仍与载货台中心一致');
    const adopted = h.driver.adoptPlatformCargoForStacker(h.model);
    assert.equal(adopted, cargo, '对接到位后stacker必须接管同一货物实例');
    assert.equal(h.model.rgvNlTelemetry.cargoKey, null);

    h.apply({ working_mode: 1, movement_x: 0, has_goods: 1, task: 7 }, 40);
    assertNear(h.deck.position.z, HOME_Z, 'stacker取货后空载货台必须返回B端');
    assert.equal(h.state.rgvNlCargoMeshes.size, 0, '光电未先清为零时不得重复刷出同一货物');

    h.apply({ working_mode: 1, movement_x: 0, has_goods: 0, task: 8 });
    h.apply({ working_mode: 1, movement_x: 0, has_goods: 1, task: 8 });
    assert.equal(h.state.rgvNlCargoMeshes.size, 1, '光电清零后的下一次有货必须允许新货物刷出');
  } finally {
    h.dispose();
  }
});

test('working_mode=2：首载到stacker端，接货后回B端，光电消失销毁并再次等待接货', () => {
  const h = makeHarness();
  try {
    h.apply({ working_mode: 2, movement_x: 0, has_goods: 0, task: 22 });
    assertNear(h.deck.position.z, STACKER_Z, 'working_mode=2首载必须直接位于stacker对接端');
    assert.equal(h.driver.canAcceptPlatformPlacedCargo(h.model, h.platform), true);

    const incoming = makeExternalCargo(h.deck.getScene());
    assert.equal(h.driver.acceptPlatformPlacedCargo(h.model, h.platform, incoming), true);
    assert.equal(h.driver.canAcceptPlatformPlacedCargo(h.model, h.platform), false, '已有货时不得重复接货');
    h.apply({ working_mode: 2, movement_x: 0, has_goods: 1, task: 22 }, 40);
    assertNear(h.deck.position.z, HOME_Z, '接到stacker货物后必须返回B端上下货位');
    assert.equal(h.state.rgvNlCargoMeshes.size, 1, '回程途中和到位且光电有货时必须保留货物');
    assertNear(incoming.root.position.z, HOME_Z, 'stacker放入的货物必须随载货台回到上下货位');

    h.apply({ working_mode: 2, movement_x: 0, has_goods: 0, task: 22 });
    assert.equal(h.state.rgvNlCargoMeshes.size, 0, '回到上下货位且光电消失后必须销毁货物');
    h.apply({ working_mode: 2, movement_x: 0, has_goods: 0, task: 22 }, 40);
    assertNear(h.deck.position.z, STACKER_Z, '销货后空载货台必须再次到stacker端等待');
  } finally {
    h.dispose();
  }
});

test('stacker交接门控：working_mode=1未达对接端不能取货，working_mode=2未达对接端不能放货', () => {
  const delivery = makeHarness();
  try {
    delivery.apply({ working_mode: 1, movement_x: 0, has_goods: 1, task: 7 });
    assert.equal(delivery.driver.adoptPlatformCargoForStacker(delivery.model), null);
    assert.equal(delivery.state.rgvNlCargoMeshes.size, 1);
  } finally {
    delivery.dispose();
  }

  const receiving = makeHarness();
  try {
    receiving.apply({ working_mode: 1, movement_x: 0, has_goods: 0, task: 0 });
    receiving.model.rgvNlTelemetry.workingMode = 2;
    assert.equal(receiving.driver.canAcceptPlatformPlacedCargo(receiving.model, receiving.platform), false);
  } finally {
    receiving.dispose();
  }
});


test('内置站台布局声明运动父节点后，货格真实挂载到载货台并继承后续位移', () => {
  const h = makeHarness();
  try {
    const controller = Object.create(SceneLocatorController.prototype) as SceneLocatorController;
    const layout = controller.readBuiltInSlotLayout({
      builtInSlotLayout: {
        parentNodeName: '载货台主体',
        firstCellCenterX: 0,
        firstLayerSurfaceY: SURFACE_Y,
        columnSpacing: 0.72,
        layerStepY: 0.34,
        depthCenterZ: 0,
      },
    });
    assert.equal(layout?.parentNodeName, '载货台主体');
    const parent = resolveBuiltInSlotLayoutParent(h.model, layout);
    assert.equal(parent, h.deck);
    h.platform.root.parent = parent;
    h.platform.root.position.set(0, SURFACE_Y, 0);
    h.deck.position.z = STACKER_Z;
    h.platform.root.computeWorldMatrix(true);
    assertNear(h.platform.root.getAbsolutePosition().z, STACKER_Z, '载货台后续位移必须直接传递给货格');
    assertNear(h.platform.root.getAbsolutePosition().y, SURFACE_Y, '货格支撑位必须保持台面上表面高度');
    assert.equal(resolveBuiltInSlotLayoutParent(h.model, null), h.model.root, '旧模型未声明父节点时仍挂模型根');
  } finally {
    h.dispose();
  }
});


test('SpecializedTelemetryRuntime 门面将 rgv_nl 内置站台取放分流到独立驱动', () => {
  const delivery = makeHarness();
  const deliveryFacade = new SpecializedTelemetryRuntime(delivery.scene, delivery.host as never);
  try {
    delivery.apply({ working_mode: 1, movement_x: 0, has_goods: 1, task: 7 });
    assert.equal(deliveryFacade.resolveDeviceType(delivery.model), 'rgv_nl', '资产路径含RGV时仍必须优先选择独立驱动');
    const cargo = delivery.state.rgvNlCargoMeshes.get(JSON.stringify(['CUSTOM_RGV', 'cargo']));
    assert.ok(cargo);
    deliveryFacade.state.rgvNlCargoMeshes.set(JSON.stringify(['CUSTOM_RGV', 'cargo']), cargo);
    assert.equal(
      deliveryFacade.adoptGlobalCargoByTask('7', 'other-device'),
      null,
      '未到stacker端时全局task接管也不得提前摘货',
    );
    delivery.apply({ working_mode: 1, movement_x: 1, has_goods: 1, task: 7 }, 40);
    assert.equal(deliveryFacade.isConveyorPlatformLocator('custom-rgv-platform'), false);
    assert.equal(deliveryFacade.isRgvNlPlatformLocator('custom-rgv-platform'), true);
    assert.equal(
      deliveryFacade.adoptConveyorPlatformCargo('custom-rgv-platform', 'STACKER'),
      cargo,
      'stacker取货必须由rgv_nl驱动接管同一货物',
    );
    assert.equal(delivery.model.rgvNlTelemetry.cargoKey, null);
  } finally {
    deliveryFacade.dispose();
    delivery.dispose();
  }

  const receiving = makeHarness();
  const receivingFacade = new SpecializedTelemetryRuntime(receiving.scene, receiving.host as never);
  try {
    receiving.apply({ working_mode: 2, movement_x: 0, has_goods: 0, task: 22 });
    const incoming = makeExternalCargo(receiving.scene);
    const stackerKey = JSON.stringify(['STACKER', 'front']);
    receivingFacade.state.stackerCargoMeshes.set(stackerKey, incoming);
    assert.equal(receivingFacade.placeCargoIntoConveyorPlatform('custom-rgv-platform', stackerKey), true);
    assert.equal(receivingFacade.state.stackerCargoMeshes.size, 0);
    assert.equal(
      receivingFacade.state.rgvNlCargoMeshes.get(JSON.stringify(['CUSTOM_RGV', 'cargo'])),
      incoming,
      'stacker放货必须进入独立rgv_nl货物表',
    );
    assert.equal(receiving.model.rgvNlTelemetry.cargoKey, JSON.stringify(['CUSTOM_RGV', 'cargo']));
  } finally {
    receivingFacade.dispose();
    receiving.dispose();
  }
});


test('rgv_nl MQTT 快照复用光电位归一化，但保持独立设备类型主键', () => {
  const snapshot = parseDeviceTelemetryMessage(
    'dt/factory/logistics/rgv_nl/CUSTOM_RGV/twindatadriven/joint',
    JSON.stringify({ data: [{ p: 'signalBits', v: 1 }] }),
    { kind: 'epv' },
  );
  assert.ok(snapshot);
  assert.equal(snapshot.deviceType, 'rgv_nl');
  assert.equal(snapshot.fields.front_has_goods, true);
  assert.equal(snapshot.fields.back_has_goods, false);
});


test('working_mode=1光电归零：清除此前刷出的残留货物并返回B端，不等待stacker事件', () => {
  const h = makeHarness();
  try {
    h.apply({ working_mode: 1, movement_x: 0, front_has_goods: 1, back_has_goods: 0, task: 7 });
    assert.equal(h.state.rgvNlCargoMeshes.size, 1, '前置：光电有货必须刷出货物');
    h.apply({ working_mode: 1, movement_x: 1, front_has_goods: 1, back_has_goods: 0, task: 7 }, 5);
    assert.ok(h.deck.position.z < HOME_Z, '前置：载货台已经开始向stacker端移动');

    h.apply({ working_mode: 1, movement_x: 0, signalBits: 0, front_has_goods: false, back_has_goods: false, task: 0 });
    assert.equal(h.state.rgvNlCargoMeshes.size, 0, '光电明确无货必须立即清除残留货物');
    assert.equal(h.model.rgvNlTelemetry.cargoKey, null);
    h.apply({ working_mode: 1, movement_x: 0, signalBits: 0, front_has_goods: false, back_has_goods: false, task: 0 }, 40);
    assertNear(h.deck.position.z, HOME_Z, '光电无货后空载货台必须返回B端');
  } finally {
    h.dispose();
  }
});
