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
    topic: 'dt/factory/logistics/stacker/DDJ10/twindatadriven/joint',
    deviceType: 'stacker',
    assetCode: 'DDJ10',
    payloadDeviceCode: 'DDJ10',
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

/** 构建单排 Locator；rootPosition.x 偏移让货格位于货叉轴正方向（伸出方向由货格几何决定）。 */
function makeLocator(
  scene: Scene,
  options: {
    rowNumber: number;
    rootPosition: Vector3;
  },
): LocatorRuntimeEntry {
  const root = new TransformNode('locator_root_' + options.rowNumber, scene);
  root.rotation.y = -Math.PI / 2;
  root.position.copyFrom(options.rootPosition);
  root.computeWorldMatrix(true);
  return {
    entityId: 'loc_' + options.rowNumber,
    root,
    columnLabelsRoot: new TransformNode('loc_' + options.rowNumber + '_labels_root', scene),
    columnLabels: [],
    cellSteps: { columnStepX: 1, layerStepY: 1 },
    cellSize: { length: 1, height: 1, width: 1 },
    material: null,
    assetId: 'L' + options.rowNumber,
    signature: 'test-' + options.rowNumber,
    columns: 20,
    layers: 3,
    startColumn: 1,
    startLayer: 1,
    columnReversed: false,
    deviceAssetCode: 'DDJ10',
    aisleCode: '',
    rowNumber: options.rowNumber,
    storageDepth: 'near',
    retainCargo: false,
  } as unknown as LocatorRuntimeEntry;
}

/** 夹抱式 miniload 测试台：双段货叉 + 载货台面 pidai.top，脚本声明 cargoPlatformNodes。side=1 货格在 +x，side=-1 在 -x。 */
function makeHarness(side: 1 | -1 = 1) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const root = new TransformNode('miniload_root', scene);
  const model = {
    assetCode: 'DDJ10',
    root,
    contentRoot: root,
    meshes: [],
    stackerTelemetry: createStackerTelemetryState(root),
    telemetryBinding: null,
    externalScriptRuntime: null,
  } as unknown as ModelRuntimeEntry;

  const addBox = (name: string, size: { width: number; height: number; depth: number }, center: Vector3) => {
    const mesh = MeshBuilder.CreateBox(name, size, scene);
    mesh.parent = root;
    mesh.position.copyFrom(center);
  };
  addBox('lizhu1.11', { width: 0.4, height: 3, depth: 0.4 }, new Vector3(0, 1.5, 0));
  addBox('xiang.13', { width: 0.4, height: 0.2, depth: 0.4 }, new Vector3(0, 0.1, 0));
  addBox('huocha2.10', { width: 0.1, height: 0.1, depth: 0.4 }, new Vector3(0, 0.25, 0));
  addBox('huocha.9', { width: 0.1, height: 0.1, depth: 0.4 }, new Vector3(0, 0.25, 0));
  addBox('pidai.top', { width: 0.4, height: 0.05, depth: 0.4 }, new Vector3(0, 0.5, 0));
  root.computeWorldMatrix(true);
  (model as { externalScriptRuntime: unknown }).externalScriptRuntime = {
    getDataDrivenConfigs: () => [{
      motion: {
        fork: { frontStageOneNodes: ['huocha2.10'], frontStageTwoNodes: ['huocha.9'] },
        cargoPlatformNodes: ['pidai.top'],
      },
    }],
  };

  // 排 11/12/14 三条库位线；x=±1 使货格位于货叉轴对应侧（模拟真实数据：14 排 mv1/2 正向、11 排 mv3/4 负向）
  const locators = [11, 12, 14].map((row) => makeLocator(scene, { rowNumber: row, rootPosition: new Vector3(side, 2, 11) }));
  const logs: string[] = [];
  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [{ entityId: 'e1', model }],
    findLocatorByDevice: (_assetCode: string, x: number, y: number, z: number) => {
      for (const locator of locators) {
        if (locator.rowNumber !== z) continue;
        if (x >= locator.startColumn && x < locator.startColumn + locator.columns
          && y >= locator.startLayer && y < locator.startLayer + locator.layers) return locator;
      }
      return null;
    },
    findLocatorsByDevice: () => locators,
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
    driver, state, model, logs, scene,
    dispose: () => { scene.dispose(); engine.dispose(); },
    apply: (fields: Record<string, unknown>, deltaSeconds = 0.1, frames = 1) => {
      for (let i = 0; i < frames; i += 1) driver.applyToModel(model, makeSnapshot(fields), deltaSeconds);
    },
  };
}

const FETCH_CELL = { front_x: 5, front_y: 1, front_z: 14, to_x: 5, to_y: 1, to_z: 14 };
const TRANSIT_CELL = { front_x: 5, front_y: 1, front_z: 12, to_x: 15, to_y: 1, to_z: 12 };

/**
 * 复现 3_诺力五期.jsonl / 4_诺力五期.jsonl 取货序列（14 排 mv1/2 正向侧、11 排 mv3/4 负向侧）：
 * 伸叉取货绑定 → 缩回进行中（真实设备整个缩回到位发生在报文间隔内）→
 * 新帧已是「cmd=3 + front 跳到中转排」：货物是刚取到的在途货，不能被当作放货在中转格口解绑，
 * 且滑移插值在货叉轴两侧必须同号（负向侧不得把货物镜像到对面）。
 */
for (const side of [1, -1] as const) {
  test(`取货缩回被相位跳变打断（${side > 0 ? '正向 mv1/2（14 排侧）' : '负向 mv3/4（11 排侧）'}）：在途货随叉搬运，收叉后停在载货台正中`, () => {
    const h = makeHarness(side);
    try {
      // 设备空闲在 (5,1,12)
      h.apply({ ...TRANSIT_CELL, front_command: 0, front_movement_z: 0, front_task: 251833 }, 0.1, 50);

      // 下发取货并伸叉，直到绑定（真实数据伸出约 4 秒）
      const FETCH_FRAME = { ...FETCH_CELL, front_command: 1, front_movement_z: 1, front_task: 251834 };
      let bound = false;
      for (let i = 0; i < 400 && !bound; i += 1) {
        h.apply(FETCH_FRAME, 0.1, 1);
        bound = h.model.stackerTelemetry.frontCargoBoundToFork === true;
      }
      assert.equal(bound, true, '伸足必须绑定货物');
      const reach = Math.abs(h.model.stackerTelemetry.frontForkOffset);
      assert.ok(reach > 0.1, `伸出行程必须有效，实际 ${reach}`);

      // 缩回若干帧，保持部分伸出（模拟报文间隔内真实设备已缩回到位、动画未完成）
      const RETRACT_FRAME = { ...FETCH_CELL, front_command: 1, front_movement_z: 2, front_task: 251834 };
      let partial = 0;
      for (let i = 0; i < 400; i += 1) {
        h.apply(RETRACT_FRAME, 0.1, 1);
        partial = Math.abs(h.model.stackerTelemetry.frontForkOffset);
        if (partial < reach * 0.6) break;
      }
      assert.ok(partial > 1e-3 && partial < reach, `跳变时货叉必须仍在部分伸出，实际 ${partial}`);

      // 部分伸出时货物必须滑向载货台但未越过中心（符号与取货侧一致，不得镜像到对面）
      const midCargo = [...h.state.stackerCargoMeshes.values()][0];
      assert.ok(midCargo, '部分伸出时货物必须存在');
      assert.ok(
        Math.sign(midCargo.root.position.x) === side && Math.abs(midCargo.root.position.x) < reach,
        `部分伸出时货物必须在取货一侧滑向载货台（side=${side}），实际 x=${midCargo.root.position.x}`,
      );

      // 跳变帧：新帧已是放货相位（cmd=3）且 front 跳到中转排
      h.apply({ ...TRANSIT_CELL, front_command: 3, front_movement_z: 0, front_task: 251834 }, 0.1, 1);
      assert.equal(
        h.model.stackerTelemetry.frontCargoBoundToFork, true,
        '取货在途货遇到相位跳变必须保持绑定随叉搬运（不得在中转格口解绑丢货）',
      );
      assert.equal(h.model.stackerTelemetry.frontCargoHoldPosition, null, '在途货不得有箱位滞留位');

      // catch-up 加速收叉：收完后货物停在载货台正中（pidai.top 中心 x=0、台面顶 y=0.525）
      h.apply({ ...TRANSIT_CELL, front_command: 3, front_movement_z: 0, front_task: 251834 }, 0.1, 60);
      assert.equal(h.model.stackerTelemetry.frontForkOffset, 0, 'catch-up 必须收叉归零');
      assert.equal(h.model.stackerTelemetry.forkCatchUp, false, '收叉完成后退出 catch-up');
      const cargo = [...h.state.stackerCargoMeshes.values()][0];
      assert.ok(cargo, '货物必须仍存在');
      assert.ok(Math.abs(cargo.root.position.x) < 1e-6, `收叉后货物必须停在载货台正中 x=0，实际 ${cargo.root.position.x}`);
      assert.ok(Math.abs(cargo.root.position.y - 0.525) < 1e-6, `货物底面必须在台面顶 y=0.525，实际 ${cargo.root.position.y}`);
    } finally {
      h.dispose();
    }
  });
}
