import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MeshBuilder, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import type { DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { ConveyorTelemetryDriver } from '../../src/runtime/babylon/telemetry/specialized/conveyorDriver';
import { createConveyorTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import {
  CARGO_HANDOFF_SECONDS,
  CONVEYOR_CARGO_SIZE,
  createSpecializedTelemetrySharedState,
  type ConveyorCargoRuntimeEntry,
} from '../../src/runtime/babylon/telemetry/specialized/types';
import { resolveConveyorCargoTravelHalfRange } from '../../src/runtime/babylon/telemetry/conveyorCargoTravel';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

/**
 * 输送线链路流转协议测试的几何约定（与 harness bounds 对齐）：
 * 行走轴为局部 x（空 motion 配置缺省），货箱轴向长度 0.72，各设备跨度 4m → 行程半径 1.64。
 * 探测点 = 轨迹端点向外延伸一个货箱长度 → 距中心 1.64 + 0.72 = 2.36；布局中心距 4m 时恰好落入邻机包围盒。
 */
const SPAN_HALF = 2;
const CARGO_AXIAL = CONVEYOR_CARGO_SIZE.x;
const HALF_RANGE = resolveConveyorCargoTravelHalfRange(SPAN_HALF * 2, CARGO_AXIAL);
/** 空 motion 配置时的缺省走行速度（m/s），与 CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND 对齐。 */
const CARGO_SPEED = 0.3;

function makeSnapshot(
  assetCode: string,
  fields: Record<string, unknown>,
  receivedAt: number = Date.now(),
): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'conveyor',
    assetCode,
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

type HarnessDeviceConfig = {
  centerX: number;
  /** 世界 Z 中心（缺省 0）：直角布局校验用。 */
  centerZ?: number;
  autoDispose?: boolean;
  /** 起点设备：探测点无上游时允许自行创建货箱（telemetryBinding.cargoOriginDevice）。 */
  origin?: boolean;
  /** stacker 能力模型：仅作为探测点邻居/货物持有方存在，不应用输送线驱动。 */
  stacker?: boolean;
  /** lift 能力模型：作为提升机来料口的“下游”邻居，仅参与探测，不应用输送线驱动。 */
  lift?: boolean;
  /** 世界包围盒 x 方向半径（缺省 2m，span 4m）。 */
  halfSpanX?: number;
  /** 模型本地绕 Y 轴旋转（弧度）：验证 trajectoryDirection 的模型本地坐标语义。 */
  rotationY?: number;
  /** telemetryBinding.trajectoryDirection（x/-x/z/-z，模型本地坐标）。 */
  trajectoryDirection?: string;
  /** 合批遥测代理：无自身几何，包围盒/行程经宿主模型按相对位姿换算（值为宿主 assetCode）。 */
  proxyOf?: string;
  /** 内置站台货格：沿行走轴相对行程中心的偏移（米），正值 = 行走轴正端。 */
  platformOffset?: number;
};

/** 多设备 harness：共享货物表与 collectModels 视图，帧函数镜像 facade（applyToModel 后执行帧尾外部拉取扫描）。 */
function makeHarness(layout: Record<string, HarnessDeviceConfig>) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const state = createSpecializedTelemetrySharedState();
  const models = new Map<string, ModelRuntimeEntry>();
  const platformLocators = new Map<string, LocatorRuntimeEntry>();
  const logs: string[] = [];
  const boundsReads: string[] = [];

  const registerDevice = (assetCode: string, config: HarnessDeviceConfig) => {
    layout[assetCode] = config;
    const root = new TransformNode(`${assetCode}_root`, scene);
    if (config.rotationY !== undefined) root.rotation.y = config.rotationY;
    if (config.centerZ !== undefined) root.position.z = config.centerZ;
    // 代理条目必须把根节点放到自身位姿：相对矩阵换算依赖宿主与代理的根节点世界矩阵差。
    if (config.proxyOf) root.position.x = config.centerX;
    const binding: Record<string, unknown> = {};
    if (config.autoDispose !== undefined) binding.cargoAutoDispose = config.autoDispose;
    if (config.origin !== undefined) binding.cargoOriginDevice = config.origin;
    if (config.trajectoryDirection !== undefined) binding.trajectoryDirection = config.trajectoryDirection;
    const model = {
      assetCode,
      assetHandle: {},
      stackerTelemetryReady: true,
      root,
      contentRoot: root,
      meshes: [],
      conveyorCapable: !config.stacker && !config.lift,
      stackerCapable: !!config.stacker,
      liftCapable: !!config.lift,
      conveyorTelemetry: createConveyorTelemetryState(),
      telemetryBinding: Object.keys(binding).length > 0 ? binding : null,
      externalScriptRuntime: null,
      // 站台解析经 entitySnapshot.id 反查货格：与 collectModels 的 entityId 约定保持一致
      entitySnapshot: { id: `e_${assetCode}` },
    } as unknown as ModelRuntimeEntry;
    models.set(assetCode, model);
    if (config.platformOffset !== undefined) {
      // 镜像真实运行时：货格根节点挂在宿主模型根下，位置即站台支撑位
      const locatorRoot = new TransformNode(`e_${assetCode}_platformRoot`, scene);
      locatorRoot.parent = root;
      locatorRoot.position.x = config.centerX + config.platformOffset;
      platformLocators.set(`e_${assetCode}`, {
        entityId: `e_${assetCode}_platform`,
        root: locatorRoot,
        columns: 1,
        layers: 1,
        cellSteps: { columnStepX: CARGO_AXIAL, layerStepY: 0.34 },
      } as unknown as LocatorRuntimeEntry);
    }
    return model;
  };
  for (const [assetCode, config] of Object.entries(layout)) registerDevice(assetCode, config);
  for (const [assetCode, config] of Object.entries(layout)) {
    if (!config.proxyOf) continue;
    const proxyHost = models.get(config.proxyOf);
    assert.ok(proxyHost, `代理 ${assetCode} 的宿主 ${config.proxyOf} 必须存在`);
    (models.get(assetCode) as { telemetryProxySource?: ModelRuntimeEntry }).telemetryProxySource = proxyHost;
  }

  const host = {
    pushLog: (message: string) => { logs.push(message); },
    collectModels: () => [...models.values()].map((model) => ({ entityId: `e_${model.assetCode}`, model })),
    findLocatorByDevice: () => null,
    findLocatorsByDevice: () => [],
    findBuiltInSlotLocatorForHostModel: (hostEntityId: string) => platformLocators.get(hostEntityId) ?? null,
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
    setGeneratedCargoRootPose: (cargo: ConveyorCargoRuntimeEntry, position: Vector3, rotation?: Quaternion | null) => {
      cargo.root.position.copyFrom(position);
      // 镜像真实实现写朝向：被驱动过的持货即视为已摆位姿，后续交接才可建插值
      if (rotation) cargo.root.rotationQuaternion = rotation.clone();
    },
    disposeGeneratedCargo: () => undefined,
    getModelWorldBounds: (model: ModelRuntimeEntry) => {
      boundsReads.push(model.assetCode);
      const config = layout[model.assetCode];
      const centerX = config?.centerX ?? 0;
      const centerZ = config?.centerZ ?? 0;
      const halfSpanX = config?.halfSpanX ?? SPAN_HALF;
      // 绕 Y 轴旋转 ±90° 后包围盒长边沿世界 Z：与真实模型实测一致，行程轴投影才正确。
      const quarterTurn = config?.rotationY !== undefined && Math.abs(Math.sin(config.rotationY)) > 0.99;
      return quarterTurn
        ? {
            minimum: new Vector3(centerX - 0.5, 0, centerZ - halfSpanX),
            maximum: new Vector3(centerX + 0.5, 1, centerZ + halfSpanX),
          }
        : {
            minimum: new Vector3(centerX - halfSpanX, 0, centerZ - 0.5),
            maximum: new Vector3(centerX + halfSpanX, 1, centerZ + 0.5),
          };
    },
  };

  let shuttleHandoffPending = false;
  const context = {
    scene,
    state,
    host,
    disposeStackerCargo: () => undefined,
    disposeConveyorCargo: () => undefined,
    getOrCreateStackerCargo: () => { throw new Error('not used'); },
    getOrCreateConveyorCargo: () => { throw new Error('driver 内部自建，不应走 context'); },
    adoptGlobalCargoByTask: () => null,
    // 镜像 SpecializedTelemetryRuntime.detachClaimedCargoByReference：按引用从外部持货表摘除并清理遥测引用
    detachClaimedCargoByReference: (cargo: ConveyorCargoRuntimeEntry) => {
      const tables = [state.stackerCargoMeshes, state.conveyorCargoMeshes, state.rgvCargoMeshes, state.shuttleCargoMeshes];
      for (const table of tables) {
        for (const [key, entry] of [...table]) {
          if (entry !== (cargo as unknown)) continue;
          for (const model of models.values()) {
            const telemetry = model.conveyorTelemetry;
            if (telemetry?.cargoCode !== null && telemetry?.cargoCode !== undefined
              && JSON.stringify([model.assetCode, telemetry.cargoCode]) === key) {
              telemetry.cargoCode = null;
            }
            const stackerTelemetry = (model as { stackerTelemetry?: { frontCargoKey: string | null; backCargoKey: string | null } }).stackerTelemetry;
            if (stackerTelemetry) {
              if (stackerTelemetry.frontCargoKey === key) stackerTelemetry.frontCargoKey = null;
              if (stackerTelemetry.backCargoKey === key) stackerTelemetry.backCargoKey = null;
            }
          }
          table.delete(key);
          return entry;
        }
      }
      return null;
    },
    // 本套测试无 mode==4 站台待交接状态，门控恒 false
    isStackerCargoPendingPlatformHandoff: () => false,
    isShuttleCargoPendingPlatformHandoff: () => shuttleHandoffPending,
  };
  const driver = new ConveyorTelemetryDriver(context as never);

  return {
    driver,
    state,
    logs,
    boundsReads,
    scene,
    models: Object.fromEntries(models),
    registerDevice,
    syncTopology: () => driver.syncLinkTopology(),
    dispose: () => { scene.dispose(); engine.dispose(); },
    /** 镜像 facade 帧调度：帧首同步拓扑，应用快照后执行帧尾外部持货拉取扫描。 */
    apply: (assetCode: string, fields: Record<string, unknown>, deltaSeconds = 0.1, frames = 1, receivedAt?: number) => {
      const model = models.get(assetCode)!;
      for (let i = 0; i < frames; i += 1) {
        driver.syncLinkTopology();
        driver.applyToModel(model, makeSnapshot(assetCode, fields, receivedAt), deltaSeconds);
        driver.pullExternalHolderCargo();
      }
    },
    /** 向 stacker 货物表插入持有货物（模拟堆垛机已持有的货箱）。 */
    insertStackerCargo: (assetCode: string, task: string) => {
      const root = new TransformNode(`${assetCode}_cargo_root`, scene);
      // 已持货必然已被驱动写过位姿：置 rotationQuaternion 表示已摆位姿，交接才可建插值
      root.rotationQuaternion = Quaternion.Identity();
      const entry = {
        assetCode,
        containerCode: '',
        task,
        root,
        outputOwner: null,
        fallback: null,
        generatorEntityId: null,
        handoff: null,
      };
      state.stackerCargoMeshes.set(JSON.stringify([assetCode, 'front']), entry as ConveyorCargoRuntimeEntry);
      return entry;
    },
    /** 向 shuttle 货物表插入持有货物，并模拟收叉待交接门控。 */
    insertShuttleCargo: (assetCode: string, task: string, pending = true) => {
      const root = new TransformNode(`${assetCode}_cargo_root`, scene);
      root.rotationQuaternion = Quaternion.Identity();
      const entry = {
        assetCode,
        containerCode: '',
        task,
        root,
        outputOwner: null,
        fallback: null,
        generatorEntityId: null,
        handoff: null,
      };
      state.shuttleCargoMeshes.set(JSON.stringify([assetCode, 'cargo']), entry as ConveyorCargoRuntimeEntry);
      shuttleHandoffPending = pending;
      return entry;
    },
    setShuttleHandoffPending: (pending: boolean) => { shuttleHandoffPending = pending; },
    /** 向 conveyor 货物表插入持有货物并置 holder 遥测引用（模拟输送线已持有的货箱）。 */
    insertConveyorCargo: (assetCode: string, task: string) => {
      const root = new TransformNode(`${assetCode}_cargo_root`, scene);
      root.rotationQuaternion = Quaternion.Identity();
      const entry = {
        assetCode,
        containerCode: '',
        task,
        root,
        outputOwner: null,
        fallback: null,
        generatorEntityId: null,
        handoff: null,
      };
      state.conveyorCargoMeshes.set(JSON.stringify([assetCode, 'cargo']), entry as ConveyorCargoRuntimeEntry);
      models.get(assetCode)!.conveyorTelemetry.cargoCode = 'cargo';
      return entry;
    },
    /** 模拟 shuttle/stacker 向设备内置站台放货。 */
    placePlatformCargo: (assetCode: string, task = '') => {
      const root = new TransformNode(`${assetCode}_platform_cargo_root`, scene);
      const entry = {
        assetCode: 'SHUTTLE', containerCode: '', task, root,
        outputOwner: null, fallback: null, generatorEntityId: null, handoff: null,
        axialLengthCache: null, lockedWorldRotation: null,
      } as unknown as ConveyorCargoRuntimeEntry;
      const platform = platformLocators.get(`e_${assetCode}`);
      assert.ok(platform, `${assetCode} 必须配置内置站台`);
      assert.ok(driver.acceptPlatformPlacedCargo(models.get(assetCode)!, platform, entry), '站台放货必须被接收');
      return entry;
    },
    /** 向 RGV 货物表插入持有货物（模拟 RGV 行车中已持有的在途货箱，司机遥测引用由调用方自理）。 */
    insertRgvCargo: (assetCode: string, task: string) => {
      const root = new TransformNode(`${assetCode}_cargo_root`, scene);
      root.rotationQuaternion = Quaternion.Identity();
      const entry = {
        assetCode,
        containerCode: '',
        task,
        root,
        outputOwner: null,
        fallback: null,
        generatorEntityId: null,
        handoff: null,
      };
      state.rgvCargoMeshes.set(JSON.stringify([assetCode, 'front']), entry as ConveyorCargoRuntimeEntry);
      return entry;
    },
    /** 仅执行帧尾外部持货拉取扫描（不驱动任何设备帧）。 */
    scan: () => driver.pullExternalHolderCargo(),
    /** 取设备的内置站台货格（未配置返回 null）。 */
    platformOf: (assetCode: string) => platformLocators.get(`e_${assetCode}`) ?? null,
  };
}

/** 获取唯一输送线货物的辅助：断言表中只有一份货物。 */
function onlyCargo(state: ReturnType<typeof createSpecializedTelemetrySharedState>): ConveyorCargoRuntimeEntry {
  assert.equal(state.conveyorCargoMeshes.size, 1, '输送线货物表中必须恰好一份货物');
  return [...state.conveyorCargoMeshes.values()][0];
}

test('异步脚本晚就绪：未 ready 候选不参与嗅探，就绪后重建邻接且稳定帧不重扫', () => {
  const h = makeHarness({ A: { centerX: 0 }, B: { centerX: 4 } });
  try {
    const a = h.models.A;
    const b = h.models.B;
    b.stackerTelemetryReady = false;
    h.syncTopology();
    assert.deepEqual(a.conveyorTelemetry.probeNeighbors, { forward: null, reverse: null });
    assert.equal(h.boundsReads.includes('B'), false, '未 ready 候选不得读取加载中的退化包围盒');
    const loadingPlan = a.conveyorTelemetry.travelPlan;
    assert.ok(loadingPlan);

    b.stackerTelemetryReady = true;
    h.syncTopology();
    assert.equal(a.conveyorTelemetry.probeNeighbors?.reverse, 'B');
    assert.equal(b.conveyorTelemetry.probeNeighbors?.forward, 'A');
    assert.notStrictEqual(a.conveyorTelemetry.travelPlan, loadingPlan);

    const readyPlan = a.conveyorTelemetry.travelPlan;
    const readyNeighbors = a.conveyorTelemetry.probeNeighbors;
    const boundsReadCount = h.boundsReads.length;
    h.syncTopology();
    assert.strictEqual(a.conveyorTelemetry.travelPlan, readyPlan);
    assert.strictEqual(a.conveyorTelemetry.probeNeighbors, readyNeighbors);
    assert.equal(h.boundsReads.length, boundsReadCount, '稳定帧不得重复几何扫描');
  } finally {
    h.dispose();
  }
});

test('模型晚注册：先就绪设备的空邻居缓存自动接入新设备', () => {
  const h = makeHarness({ A: { centerX: 0 } });
  try {
    const a = h.models.A;
    h.syncTopology();
    assert.deepEqual(a.conveyorTelemetry.probeNeighbors, { forward: null, reverse: null });

    const b = h.registerDevice('B', { centerX: 4 });
    h.syncTopology();
    assert.equal(a.conveyorTelemetry.probeNeighbors?.reverse, 'B');
    assert.equal(b.conveyorTelemetry.probeNeighbors?.forward, 'A');
  } finally {
    h.dispose();
  }
});

test('三段链路中间设备晚就绪：已有持货与等待补通且同一货物只交付一次', () => {
  const h = makeHarness({ A: { centerX: 0 }, B: { centerX: 4 }, C: { centerX: 8 } });
  try {
    h.models.B.stackerTelemetryReady = false;
    h.apply('C', { task: 7, movement_x: 1 });
    assert.equal(h.models.C.conveyorTelemetry.waitingTask, '7');
    const cargo = h.insertConveyorCargo('A', '7');

    const probe = h.driver as unknown as {
      notifyAvailable(model: ModelRuntimeEntry, task: string, direction: number): void;
      sendSubscribe(model: ModelRuntimeEntry, task: string, direction: number): void;
    };
    const notifyAvailable = probe.notifyAvailable;
    const sendSubscribe = probe.sendSubscribe;
    let availableCount = 0;
    let subscribeCount = 0;
    probe.notifyAvailable = function (model, task, direction) {
      availableCount++;
      notifyAvailable.call(this, model, task, direction);
    };
    probe.sendSubscribe = function (model, task, direction) {
      subscribeCount++;
      sendSubscribe.call(this, model, task, direction);
    };

    h.models.B.stackerTelemetryReady = true;
    h.syncTopology();
    assert.ok(availableCount > 0);
    assert.ok(subscribeCount > 0);
    assert.strictEqual(onlyCargo(h.state), cargo);
    assert.equal(cargo.assetCode, 'C');
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.C.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.C.conveyorTelemetry.waitingTask, null);

    availableCount = subscribeCount = 0;
    h.syncTopology();
    assert.equal(availableCount, 0, '稳定拓扑不得重复补发 available');
    assert.equal(subscribeCount, 0, '稳定拓扑不得重复补发 subscribe');
    assert.strictEqual(onlyCargo(h.state), cargo);
  } finally {
    h.dispose();
  }
});

test('远程 travel 配置晚到：拓扑重建后按 Z 轴与 GD_4 节点重算行程', () => {
  const h = makeHarness({ A: { centerX: 0 } });
  try {
    const a = h.models.A;
    h.syncTopology();
    const fallbackPlan = a.conveyorTelemetry.travelPlan;
    assert.ok(fallbackPlan);
    assert.equal(fallbackPlan.travelContext.travelAxisName, 'x');
    fallbackPlan.perpendicularEndOffsets = { positive: 0.5, negative: null };

    const travelNode = MeshBuilder.CreateBox('GD_4', { width: 1, height: 0.2, depth: 4 }, h.scene);
    travelNode.parent = a.root;
    a.meshes = [travelNode];
    a.externalScriptRuntime = {
      getDataDrivenConfigs: () => [{
        device: { devType: 'conveyor' },
        cargo: { travel: { axis: 'z', nodes: ['GD_4'] } },
      }],
    } as unknown as ModelRuntimeEntry['externalScriptRuntime'];
    h.registerDevice('B', { centerX: 4 });
    h.syncTopology();

    const readyPlan = a.conveyorTelemetry.travelPlan;
    assert.ok(readyPlan);
    assert.notStrictEqual(readyPlan, fallbackPlan);
    assert.equal(readyPlan.travelContext.travelAxisName, 'z');
    assert.ok(Math.abs((readyPlan.travelContext.spanMeters ?? 0) - 4) < 1e-6);
    assert.equal(readyPlan.perpendicularEndOffsets, undefined, '旧直角终点必须随行程计划一并失效');
  } finally {
    h.dispose();
  }
});

test('直接邻居无货：传递式订阅仍向上注册下位链路，本机挂起等待', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7', '必须登记等待 task');
    assert.equal(h.models.CV2.conveyorTelemetry.pendingTask, '7', 'pendingTask 保留');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, null, '等待方不得刷出货物');
    const link = h.models.CV1.conveyorTelemetry.downstreamLinks.get('CV2');
    assert.ok(link, '订阅必须注册到上游的下位链路');
    assert.equal(link.task, '7');
    assert.equal(link.hops, 1, '直接邻居 hops 必须为 1');
    assert.equal(link.direction, 1);
    assert.equal(h.models.CV2.conveyorTelemetry.upstreamLinks.size, 0, '无 available 通知不得有上位链路');
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '无货物被创建');
  } finally {
    h.dispose();
  }
});

test('订阅驱动交付：本机报同 task 边沿时向上订阅，持有方按 1s/hops 插值交付', () => {
  const h = makeHarness({ CV1: { centerX: -4, origin: true }, CV2: { centerX: 0 }, CV3: { centerX: 4 } });
  try {
    // CV1 起点刷出并自驱在途
    h.apply('CV1', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, 'cargo', 'CV1 必须持有在途货');

    // CV2 报同 task 边沿：订阅触达 CV1，持有方立即交付到 CV2 进入端
    h.apply('CV2', { task: 7, movement_x: 1 });
    const cv2 = h.models.CV2.conveyorTelemetry;
    const cargo = onlyCargo(h.state);
    assert.equal(cargo.assetCode, 'CV2', '货物必须交付到本机');
    assert.equal(cargo.task, '7');
    assert.ok(cargo.handoff, '交付必须用 1s/hops 插值从当前位姿滑入');
    assert.equal(cargo.handoff.durationSeconds, CARGO_HANDOFF_SECONDS, '单跳交付插值时长必须为 1s');
    assert.equal(cv2.cargoCode, 'cargo');
    assert.equal(cv2.waitingTask, null, '交付后不得挂起等待');
    assert.equal(cv2.pendingTask, null, '交付后 pendingTask 必须清掉');
    // 落位即进入端（同帧自驱再推进一帧行程，故允许 +0.03m 容差）
    assert.ok(cv2.cargoTravelOffset >= -HALF_RANGE - 1e-6
      && cv2.cargoTravelOffset <= -HALF_RANGE + CARGO_SPEED * 0.1 + 1e-6,
      `交付必须落本机进入端（偏移约 ${-HALF_RANGE}），实际 ${cv2.cargoTravelOffset}`);
    assert.equal(cv2.handoffEntryOffset, null, '共线交付不得记录拐角进入偏移');
    assert.equal(h.models.CV1.conveyorTelemetry.downstreamLinks.size, 0, '收货退订必须清除订阅登记');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null, '原持货方必须摘除货物引用');
    // 交付后必须以新持货方 identity 通知下游，供单向探测的下游注册上位链路
    assert.equal(h.models.CV3.conveyorTelemetry.upstreamLinks.get('CV2')?.task, '7',
      '交付后必须以本机为持货方通知下游，供单向探测的下游注册上位链路');

    // 交付后货物沿本机自驱走行
    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 10);
    assert.ok(cv2.cargoTravelOffset > -HALF_RANGE, `交付后货物必须自驱走行，实际 ${cv2.cargoTravelOffset}`);
  } finally {
    h.dispose();
  }
});

test('订阅驱动：直接上游持异 task 货不交付，本机挂起等待', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.insertConveyorCargo('CV1', '6');
    h.apply('CV2', { task: 7, movement_x: 1 });
    const cv2 = h.models.CV2.conveyorTelemetry;
    assert.equal(cv2.waitingTask, '7', '上游无同 task 货时必须挂起等待');
    assert.equal(cv2.cargoCode, null, '异 task 货物不得被转移');
    const link = h.models.CV1.conveyorTelemetry.downstreamLinks.get('CV2');
    assert.ok(link, '订阅必须注册到上游下位链路');
    assert.equal(link.task, '7');
    const cargo = onlyCargo(h.state);
    assert.equal(cargo.assetCode, 'CV1', '异 task 货物必须留在原持货方');
    assert.equal(cargo.task, '6');
  } finally {
    h.dispose();
  }
});

test('上游持货后事件驱动交付：available 通知触发订阅，当帧直达交付（下游无需再收消息）', () => {
  const h = makeHarness({ CV1: { centerX: -4, origin: true }, CV2: { centerX: 0 } });
  try {
    const stamp = 1_000_000;
    // CV2 先收 task：订阅注册到 CV1 下位链路，等待
    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 1, stamp);
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7');
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV2'));

    // CV1 收 task 刷出（起点设备）：available 通知 → CV2 注册上游并立即订阅 → CV1 持货命中当帧交付
    h.apply('CV1', { task: 7, movement_x: 1 });
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.assetCode, 'CV2', '货物必须换绑到订阅者');
    assert.equal(pushed.task, '7');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null, '持有方引用必须清空');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, 'cargo', '订阅者必须接管货物身份');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null, '被交付后必须退出等待');
    assert.equal(h.models.CV2.conveyorTelemetry.pendingTask, null);
    assert.ok(Math.abs(h.models.CV2.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE)) < 1e-6,
      `订阅者必须从自身刷出端继续走行，实际 ${h.models.CV2.conveyorTelemetry.cargoTravelOffset}`);
    assert.equal(h.models.CV2.conveyorTelemetry.selfDriveDirection, 1, '被交付必须按订阅方向登记自驱');
    // 起点刷出当帧直达交付的是从未摆位姿的新货：无历史位姿可插值，直接在目标位姿落位
    // （避免从世界原点飞入/从 Identity 自旋，且首个稳定位姿才建立朝向锁定）
    assert.equal(pushed.handoff, null, '新刷出货物无历史位姿，不得建交接插值');
    assert.equal(h.models.CV2.conveyorTelemetry.upstreamLinks.size, 0, 'taken 波必须清除该 task 的上位链路');
    assert.equal(h.models.CV1.conveyorTelemetry.downstreamLinks.size, 0, '收货退订必须清除下位链路登记');

    // 下游断流重放（同一 receivedAt，movement_x=0）：自驱仍按订阅方向推进
    h.apply('CV2', { task: 7, movement_x: 0 }, 0.1, 10, stamp);
    const selfDrivenOffset = h.models.CV2.conveyorTelemetry.cargoTravelOffset;
    assert.ok(
      Math.abs(selfDrivenOffset - (-HALF_RANGE + CARGO_SPEED * 0.1 * 10)) < 1e-6,
      `断流期间自驱必须推进到 ${-HALF_RANGE + CARGO_SPEED * 0.1 * 10}，实际 ${selfDrivenOffset}`,
    );
    // 新消息到达 movement_x=0（receivedAt 变化）：自驱不被打断，货物连贯驶向目标位
    h.apply('CV2', { task: 7, movement_x: 0 }, 0.1, 10, stamp + 1);
    assert.equal(h.models.CV2.conveyorTelemetry.selfDriveDirection, 1, 'movement_x=0 的新消息不得结束自驱');
    assert.ok(
      Math.abs(h.models.CV2.conveyorTelemetry.cargoTravelOffset - (selfDrivenOffset + CARGO_SPEED * 0.1 * 10)) < 1e-6,
      `自驱必须继续推进到 ${selfDrivenOffset + CARGO_SPEED * 0.1 * 10}，实际 ${h.models.CV2.conveyorTelemetry.cargoTravelOffset}`,
    );
  } finally {
    h.dispose();
  }
});

test('直角相邻：交付落点取两条中心轨迹交叉点，不再落到下游进入端', () => {
  // CV1 沿 +X、中心 (-4,0,0)；CV2 旋转 -90° 后沿 +Z、中心 (-2,0,0)，中心线交叉于 (-2,0,0)
  const h = makeHarness({ CV1: { centerX: -4, origin: true }, CV2: { centerX: -2, rotationY: -Math.PI / 2 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    h.apply('CV1', { task: 7, movement_x: 1 });

    const cv2 = h.models.CV2.conveyorTelemetry;
    assert.equal(cv2.cargoCode, 'cargo', '货物必须交付给下游');
    assert.ok(Math.abs(cv2.cargoTravelOffset) < 1e-6,
      `直角交付必须落在交叉点（下游偏移 0），实际 ${cv2.cargoTravelOffset}`);
  } finally {
    h.dispose();
  }
});

test('直角接驳：本机走行终点钳制到中心线交叉点，不再开到设备边沿', () => {
  // CV1 沿 +X、中心线 z=0；CV2 旋转 -90° 后沿 +Z，中心 (-2, 0, -1)、跨度 ±2。
  // 中心线交叉于 (-2,0)，沿 CV2 轴偏移 +1（在其跨度内、但小于正常行程半径 1.64）。
  const h = makeHarness({
    CV1: { centerX: -4, origin: true },
    CV2: { centerX: -2, centerZ: -1, halfSpanX: 2, rotationY: -Math.PI / 2 },
  });
  try {
    // 先让上游刷出并摆好位姿，再让下游订阅：货物带历史位姿，交接插值才存在
    h.apply('CV1', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 1 });
    const cv2 = h.models.CV2.conveyorTelemetry;
    assert.equal(cv2.cargoCode, 'cargo', '货物必须交付给下游');
    assert.ok(Math.abs(cv2.cargoTravelOffset - 1) < 1e-6, `交付落点应在交叉点 +1，实际 ${cv2.cargoTravelOffset}`);

    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 100);
    assert.ok(Math.abs(cv2.cargoTravelOffset - 1) < 1e-6,
      `走行终点必须停在交叉点 +1，不得开到设备边沿 1.64，实际 ${cv2.cargoTravelOffset}`);
  } finally {
    h.dispose();
  }
});

test('直角接驳有过渡段：交叉点超出下游正常行程时仍从拐角进入并沿轴驶入，不瞬移到进入端', () => {
  // CV1 沿 +X、中心 (-4,0,0)；CV2 旋转 -90° 后沿 +Z，中心线 x=-2，包围盒 Z∈[0.5,2.5]、中心 z=1.5。
  // 交叉点 (-2,0) 距 CV2 中心 -1.5m，超出其正常行程半径 0.64m（跨度 2m、货箱 0.72m），
  // 但仍在“端面 + 一个货箱长度”的过渡允许范围内。
  const h = makeHarness({
    CV1: { centerX: -4, origin: true },
    CV2: { centerX: -2, centerZ: 1.5, halfSpanX: 1, rotationY: -Math.PI / 2 },
  });
  try {
    // 先让上游刷出并摆好位姿，再让下游订阅：货物带历史位姿，交接插值才存在
    h.apply('CV1', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 1 });

    const cv2 = h.models.CV2.conveyorTelemetry;
    assert.equal(cv2.cargoCode, 'cargo', '货物必须交付给下游');
    assert.ok(Math.abs(cv2.cargoTravelOffset + 1.5) < 1e-6,
      `直角交付必须落在交叉点（下游偏移 -1.5），实际 ${cv2.cargoTravelOffset}`);
    assert.ok(Math.abs((cv2.handoffEntryOffset ?? 0) + 1.5) < 1e-6, '拐角进入偏移必须记录，供走行钳制放宽');
    assert.equal(cv2.entryHandoffPending, true, '直角交接插值期间必须冻结下游走行');

    // 交接插值（1s）期间货物固定在拐角，不得提前沿下游轴跑走
    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 9);
    assert.ok(Math.abs(cv2.cargoTravelOffset + 1.5) < 1e-6,
      `交接插值期间货物必须停在拐角，实际 ${cv2.cargoTravelOffset}`);

    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 1);
    assert.equal(cv2.entryHandoffPending, false, '插值完成后解除冻结');

    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 10);
    assert.ok(cv2.cargoTravelOffset > -1.5 && cv2.cargoTravelOffset < -1.19,
      `货物应从拐角连续驶入而不是瞬移，实际 ${cv2.cargoTravelOffset}`);

    h.apply('CV2', { task: 7, movement_x: 1 }, 0.1, 80);
    assert.ok(cv2.cargoTravelOffset > -0.64 + 1e-6, `驶入常规行程后继续沿轴走行，实际 ${cv2.cargoTravelOffset}`);
    assert.equal(cv2.handoffEntryOffset, null, '进入常规行程范围后必须解除拐角放宽');
  } finally {
    h.dispose();
  }
});

test('多台下游订阅同一 task：先注册者获得唯一货物，落选者标记过境并退订', () => {
  // CV3 放在 -0.5：其正转探测点 x=-2.86 同样落入 CV1 包围盒（且 CV2 探测点距 CV1 中心更近，不受影响）
  const h = makeHarness({
    CV1: { centerX: -4 },
    CV2: { centerX: 0 },
    CV3: { centerX: -0.5 },
  });
  try {
    // CV1 先收 task=7 空载等待（探测点无上游且非起点），CV2/CV3 凭同 task 先后订阅注册到 CV1
    h.apply('CV1', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 1 });
    h.apply('CV3', { task: 7, movement_x: 1 });
    assert.deepEqual([...h.models.CV1.conveyorTelemetry.downstreamLinks.keys()], ['CV2', 'CV3'],
      '下位链路必须按订阅到达顺序登记（先注册者先得）');

    // task 绑定的货物唯一：先注册的 CV2 获得交付；落选的 CV3 被 taken 波标记过境、退订并停止挂单
    h.insertConveyorCargo('CV1', '7');
    h.apply('CV1', { task: 7, movement_x: 1 });
    const first = onlyCargo(h.state);
    assert.equal(first.assetCode, 'CV2', '唯一货物必须交给先注册者');
    assert.equal(first.task, '7');
    assert.ok(h.models.CV3.conveyorTelemetry.transitedTasks.has('7'), '落选者必须标记过境');
    assert.equal(h.models.CV3.conveyorTelemetry.waitingTask, null, '落选者不得继续挂单');
    assert.equal(h.models.CV3.conveyorTelemetry.pendingTask, null);
    assert.equal(h.models.CV1.conveyorTelemetry.downstreamLinks.size, 0,
      '交付摘除 + 过境退订后下位链路必须清空');

    // 此后 CV1 再持同 task 货物：无订阅者，货物留在 CV1
    h.insertConveyorCargo('CV1', '7');
    h.apply('CV1', { task: 7, movement_x: 1 });
    const cargos = [...h.state.conveyorCargoMeshes.values()];
    assert.equal(cargos.length, 2);
    assert.ok(cargos.some((cargo) => cargo.assetCode === 'CV1'), '无订阅者时货物必须留在持有方');
  } finally {
    h.dispose();
  }
});

test('等待中方向翻转：链路失效清空并沿新方向重新订阅', () => {
  const h = makeHarness({
    CV1: { centerX: -4 },
    CV2: { centerX: 0 },
    CV3: { centerX: 4 },
  });
  try {
    // CV2 正转订阅 CV1
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV2'));

    // 翻转为反转：退订旧方向（CV1 摘除登记），以新方向订阅反转探测点触及的 CV3
    h.apply('CV2', { task: 7, movement_x: 2 });
    assert.equal(h.models.CV1.conveyorTelemetry.downstreamLinks.size, 0, '翻转必须退订旧方向上游');
    const link = h.models.CV3.conveyorTelemetry.downstreamLinks.get('CV2');
    assert.ok(link, '必须以新方向订阅新上游 CV3');
    assert.equal(link.direction, -1);
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7', '等待必须保留');
  } finally {
    h.dispose();
  }

  // stacker 邻居两侧探测点都覆盖：翻转而邻居不变时，外部拉取登记仅更新方向
  const h2 = makeHarness({ CV2: { centerX: 0 }, ST1: { centerX: 0, stacker: true, halfSpanX: 3 } });
  try {
    h2.apply('CV2', { task: 7, movement_x: 1 });
    const before = h2.models.CV2.conveyorTelemetry.externalPulls.get('CV2');
    assert.ok(before, 'stacker 邻居必须登记外部拉取');
    assert.equal(before.holderAssetCode, 'ST1');
    assert.equal(before.direction, 1);
    h2.apply('CV2', { task: 7, movement_x: 2 });
    const after = h2.models.CV2.conveyorTelemetry.externalPulls.get('CV2');
    assert.ok(after, '翻转后必须重新登记外部拉取');
    assert.equal(after.holderAssetCode, 'ST1', '同一邻居不得改变持货方');
    assert.equal(after.direction, -1, '方向必须更新');
  } finally {
    h2.dispose();
  }
});

test('探测点无上游时：起点设备自行创建货箱（movement_x=0 按正转刷出并自驱），非起点仅等待', () => {
  const h = makeHarness({ CV1: { centerX: 0, origin: true } });
  try {
    h.apply('CV1', { task: 7, movement_x: 0 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null, '起点设备无邻居不得等待');
    const cargo = onlyCargo(h.state);
    assert.equal(cargo.assetCode, 'CV1');
    assert.equal(cargo.task, '7');
    assert.ok(Math.abs(h.models.CV1.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE + CARGO_SPEED * 0.1)) < 1e-6,
      `movement_x=0 必须按正转刷在轨迹起点并当帧自驱推进，实际 ${h.models.CV1.conveyorTelemetry.cargoTravelOffset}`);
    assert.equal(h.models.CV1.conveyorTelemetry.selfDriveDirection, 1, 'movement_x=0 刷出必须登记正转自驱');
  } finally {
    h.dispose();
  }

  const h2 = makeHarness({ CV2: { centerX: 0 } });
  try {
    h2.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h2.models.CV2.conveyorTelemetry.waitingTask, '7', '非起点设备无邻居只能等待');
    assert.equal(h2.models.CV2.conveyorTelemetry.upstreamLinks.size, 0);
    assert.equal(h2.models.CV2.conveyorTelemetry.downstreamLinks.size, 0, '无邻居不得有链路登记');
    assert.equal(h2.state.conveyorCargoMeshes.size, 0, '非起点设备不得自行创建货箱');
  } finally {
    h2.dispose();
  }
});

test('起点设备刷货前检查外部持货：RGV 已持有同 task 在途实物时转为等待，推送交付被正常接收', () => {
  const h = makeHarness({ CV1: { centerX: 0, origin: true } });
  try {
    // RGV 已持有 task=7 货物在途（静态探测缓存找不到行车中的 RGV，探测点视为无上游）
    h.insertRgvCargo('RGV1', '7');
    h.apply('CV1', { task: 7, movement_x: 0 });
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '7', '外部持货在途时必须转为等待而非刷幻影货');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null, '本机不得占用持货引用');
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '不得自行创建货箱');
    assert.equal(h.state.rgvCargoMeshes.size, 1, 'RGV 在途货物不受影响');

    // RGV 推送交付（镜像 facade：预检 → 摘除原引用 → 落地）
    const model = h.models.CV1;
    assert.equal(h.driver.canAcceptRgvColumnPlacedCargo(model, '7'), true, '等待方必须通过 RGV 列放货预检');
    const rgvCargo = h.state.rgvCargoMeshes.get(JSON.stringify(['RGV1', 'front']))!;
    h.state.rgvCargoMeshes.delete(JSON.stringify(['RGV1', 'front']));
    assert.equal(h.driver.acceptRgvColumnPlacedCargo(model, rgvCargo, '7'), true, '推送交付必须被接收');
    assert.equal(model.conveyorTelemetry.cargoCode, 'cargo', '交付后必须置持货引用');
    assert.equal(model.conveyorTelemetry.waitingTask, null, '交付后清等待');
    const delivered = onlyCargo(h.state);
    assert.equal(delivered.task, '7');
    assert.ok(
      Math.abs(model.conveyorTelemetry.cargoTravelOffset + HALF_RANGE) < 1e-6,
      `交付瞬间必须落在进入端 -${HALF_RANGE}，实际 ${model.conveyorTelemetry.cargoTravelOffset}`,
    );
    assert.equal(model.conveyorTelemetry.selfDriveDirection, 1, '承接后必须登记自驱走行');
  } finally {
    h.dispose();
  }
});

test('lift 放货接收方未挂单：保留货物自身 task，不得改成匿名', () => {
  const h = makeHarness({ CV1: { centerX: 0 } });
  try {
    const cargo = h.insertRgvCargo('RGV1', '7001');
    h.state.rgvCargoMeshes.delete(JSON.stringify(['RGV1', 'front']));
    const model = h.models.CV1;
    assert.equal(model.conveyorTelemetry.pendingTask, null, '前置：接收方未挂单');
    assert.equal(model.conveyorTelemetry.waitingTask, null);

    // requireTaskMatch=false（lift 送料层交付），task 参数为空
    assert.equal(h.driver.acceptRgvColumnPlacedCargo(model, cargo as ConveyorCargoRuntimeEntry, '', false, false), true);
    assert.equal(cargo.task, '7001', '接收方未挂单时必须保留货物自身 task，避免匿名货无法继续交付');
  } finally {
    h.dispose();
  }
});

test('lift 放货接收方挂异 task 等待：保留货物身份并清残留等待，不得给新货改号补位', () => {
  const h = makeHarness({ CV1: { centerX: -8 }, CV2: { centerX: -4 }, CV3: { centerX: 0 }, CV4: { centerX: 4 } });
  try {
    // CV4 先报 task=100（无货）：订阅沿链上行，CV2 登记下位链路
    h.apply('CV4', { task: 100, movement_x: 1 });
    assert.ok(h.models.CV2.conveyorTelemetry.downstreamLinks.has('CV4'), '前置：订阅必须已注册到 CV2');
    // CV2 也报 task=100（无货）：形成残留等待
    h.apply('CV2', { task: 100, movement_x: 1 });
    const cv2 = h.models.CV2.conveyorTelemetry;
    assert.equal(cv2.waitingTask, '100', '前置：CV2 必须挂着残留等待');

    // 提升机把一件全新 task=200 的货推进 CV2（requireTaskMatch=false，task 参数为空）
    const lifted = h.insertRgvCargo('RGV1', '200');
    h.state.rgvCargoMeshes.delete(JSON.stringify(['RGV1', 'front']));
    assert.equal(h.driver.acceptRgvColumnPlacedCargo(h.models.CV2, lifted as ConveyorCargoRuntimeEntry, '', false, false), true);
    assert.equal(lifted.task, '200', '新货不得被残留等待改号');
    assert.equal(lifted.assetCode, 'CV2', '新货必须留在接收方');
    assert.equal(cv2.cargoCode, 'cargo', '接收方必须持有新货');
    assert.equal(cv2.pendingTask, null, '残留 pendingTask 必须清除');
    assert.equal(cv2.waitingTask, null, '残留等待必须清除，不得被新货兑现');
    assert.ok(cv2.downstreamLinks.has('CV4'), '旧 task 订阅登记不得被新货触发交付');

    // 下游报出自己的 task 边沿（货到才报）：旧等待清除，按新 task 正常接走
    h.apply('CV4', { task: 200, movement_x: 1 });
    assert.equal(lifted.assetCode, 'CV4', '下游 task 边沿到达后必须按 task=200 正常交付');
    assert.equal(lifted.task, '200');
  } finally {
    h.dispose();
  }
});

test('持货新 task 规则一：旧货无下游订阅且上游无新 task 货 → 复用盖新 task 并通知下游', () => {
  const h = makeHarness({ CV1: { centerX: -4, origin: true }, CV2: { centerX: 0 } });
  try {
    // CV1 先持有 task=3 的货物并走行一段
    h.apply('CV1', { task: 3, movement_x: 1 }, 0.1, 10);
    const held = onlyCargo(h.state);
    const heldRoot = held.root;
    const strandedOffset = h.models.CV1.conveyorTelemetry.cargoTravelOffset;
    assert.ok(Math.abs(strandedOffset - (-HALF_RANGE + CARGO_SPEED * 0.1 * 10)) < 1e-6);
    // CV2 凭 available 通知注册了上位链路（task=3）
    assert.equal(h.models.CV2.conveyorTelemetry.upstreamLinks.get('CV1')?.task, '3');

    h.apply('CV1', { task: 5, movement_x: 0 });
    assert.equal(onlyCargo(h.state).task, '3', '复用宽限期内不得立即给在机货改号');
    assert.equal(h.models.CV1.conveyorTelemetry.pendingTask, '5', '宽限期内新 task 必须保持挂起');
    // 宽限期内下游始终没有订阅：到期后按滞留箱复用盖号
    h.apply('CV1', { task: 5, movement_x: 0 }, 1, 3);
    const reused = onlyCargo(h.state);
    assert.equal(reused.root, heldRoot, '必须复用同一货物实例');
    assert.equal(reused.task, '5', '宽限期到期后必须盖上新 task');
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null, '持有滞留箱不得进入等待');
    assert.equal(h.models.CV1.conveyorTelemetry.pendingTask, null);
    assert.equal(h.models.CV1.conveyorTelemetry.selfDriveDirection, 1, 'movement_x=0 复用必须登记正转自驱');
    assert.ok(Math.abs(h.models.CV1.conveyorTelemetry.cargoTravelOffset - (strandedOffset + CARGO_SPEED * (0.1 + 3))) < 1e-6,
      `复用必须从滞留位置继续走行，期望 ${strandedOffset + CARGO_SPEED * (0.1 + 3)}，实际 ${h.models.CV1.conveyorTelemetry.cargoTravelOffset}`);
    // taken(3)+available(5) 波：下游上位链路更新为新 task
    assert.equal(h.models.CV2.conveyorTelemetry.upstreamLinks.get('CV1')?.task, '5',
      '复用后必须通知下游新 task 持货');
  } finally {
    h.dispose();
  }
});

test('持货新 task 规则二：旧货已有下游订阅 → 先正常交付，本机按无货流程订阅新 task', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    // CV2 先订阅 task=3（注册到 CV1 下位链路），随后 CV1 持有 task=3 货物（带订阅持有）
    h.apply('CV2', { task: 3, movement_x: 1 });
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV2'));
    const held = h.insertConveyorCargo('CV1', '3');

    // CV1 收到新 task=5：旧货先交付给 CV2，本机转为等待 task=5
    h.apply('CV1', { task: 5, movement_x: 1 });
    const delivered = onlyCargo(h.state);
    assert.equal(delivered.root, held.root, '旧货必须原实例交付');
    assert.equal(delivered.assetCode, 'CV2', '旧货必须交付给已订阅的下游');
    assert.equal(delivered.task, '3', '货物与 task 绑定，交付不重写 task');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '5', '本机必须按无货流程等待新 task');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null);
    assert.equal(h.models.CV2.conveyorTelemetry.selfDriveDirection, 1);
  } finally {
    h.dispose();
  }
});

test('持货新 task 规则三：旧货无订阅但上游有新 task 货 → 销毁旧货等传递（当帧被交付）', () => {
  const h = makeHarness({ CV0: { centerX: -8 }, CV1: { centerX: -4 } });
  try {
    // CV0 持有 task=5 货物；CV1 持有 task=3 滞留箱（无下游订阅）
    const upstreamCargo = h.insertConveyorCargo('CV0', '5');
    const oldCargo = h.insertConveyorCargo('CV1', '3');

    // CV1 收 task=5：探测到上游持有新 task 货 → 销毁旧箱、订阅上游 → 当帧被交付
    h.apply('CV1', { task: 5, movement_x: 1 });
    const delivered = onlyCargo(h.state);
    assert.equal(delivered.root, upstreamCargo.root, '必须接管上游 task=5 的货物实例');
    assert.notEqual(delivered.root, oldCargo.root, '旧箱必须被销毁而非复用');
    assert.equal(delivered.assetCode, 'CV1');
    assert.equal(delivered.task, '5');
    assert.equal(h.models.CV0.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, null, '当帧被交付后不得残留等待');
    assert.equal(h.models.CV1.conveyorTelemetry.selfDriveDirection, 1);
  } finally {
    h.dispose();
  }
});

test('异 task 货物不交付（货物与 task 绑定）；上游复用盖新 task 后命中订阅即交付', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.insertConveyorCargo('CV1', '3');
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV2'), '订阅必须登记');
    assert.equal(onlyCargo(h.state).assetCode, 'CV1', '异 task 货物不得交付');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7', 'CV2 必须持续等待本 task 的货');

    // CV1 收 task=7：旧货无 task=3 的订阅 → 复用盖 7 → 命中 CV2 的订阅当帧交付
    h.apply('CV1', { task: 7, movement_x: 1 });
    const delivered = onlyCargo(h.state);
    assert.equal(delivered.assetCode, 'CV2');
    assert.equal(delivered.task, '7');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null);
  } finally {
    h.dispose();
  }
});

test('mode=0 退出等待并退订：上游摘除下位链路登记，此后持货不再交付', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV2'));

    h.apply('CV2', { task: 7, movement_x: 0, mode: 0 });
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null, 'mode=0 必须退出等待');
    assert.equal(h.models.CV2.conveyorTelemetry.pendingTask, null, '退出等待必须放弃 pendingTask');
    assert.equal(h.models.CV1.conveyorTelemetry.downstreamLinks.size, 0, '退订必须沿链摘除登记');

    // 退订后上游持货不再交付
    h.insertConveyorCargo('CV1', '7');
    h.apply('CV1', { task: 7, movement_x: 1 });
    assert.equal(onlyCargo(h.state).assetCode, 'CV1', '退订后货物必须留在上游');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, null);
  } finally {
    h.dispose();
  }
});

test('等待方 mode=2 不退出等待、不影响被交付资格', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    h.apply('CV2', { task: 7, movement_x: 0, mode: 2, front_has_goods: 0, back_has_goods: 0 });
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, '7', '等待方 mode=2 不得退出等待');
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV2'), '等待方 mode=2 不得退订');

    h.insertConveyorCargo('CV1', '7');
    h.apply('CV1', { task: 7, movement_x: 1 });
    assert.equal(onlyCargo(h.state).assetCode, 'CV2', 'mode=2 的等待者仍必须能被交付');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null);
  } finally {
    h.dispose();
  }
});

test('反转（movement_x=2）沿反转探测点订阅，交付后从轨迹终点侧接入并按反转方向自驱', () => {
  const h = makeHarness({ CV2: { centerX: 0 }, CV3: { centerX: 4 } });
  try {
    const held = h.insertConveyorCargo('CV3', '7');

    h.apply('CV2', { task: 7, movement_x: 2 });
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.root, held.root, '必须接管同一货物实例');
    assert.equal(pushed.assetCode, 'CV2');
    assert.equal(pushed.task, '7');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, 'cargo', 'CV3 持货当帧即被交付');
    // 交付发生在本机帧内（订阅传播同步命中持货方）：当帧走行已按反转方向推进一格
    assert.ok(Math.abs(h.models.CV2.conveyorTelemetry.cargoTravelOffset - (HALF_RANGE - CARGO_SPEED * 0.1)) < 1e-6,
      `反转必须从轨迹终点侧接入并当帧内移，实际 ${h.models.CV2.conveyorTelemetry.cargoTravelOffset}`);
    assert.equal(h.models.CV2.conveyorTelemetry.selfDriveDirection, -1, '必须按反转方向自驱');
  } finally {
    h.dispose();
  }
});

test('stacker 持货拉取：订阅触达非 conveyor 邻居登记 externalPulls，帧尾扫描代交付', () => {
  const h = makeHarness({ ST1: { centerX: -4, stacker: true }, CV2: { centerX: 0 } });
  try {
    const stackerCargo = h.insertStackerCargo('ST1', '7');

    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h.state.stackerCargoMeshes.size, 0, '货物必须从 stacker 表摘除');
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.root, stackerCargo.root, '必须接管 stacker 同一货物实例');
    assert.equal(pushed.assetCode, 'CV2', '货物必须换绑到输送线');
    assert.equal(pushed.task, '7');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.CV2.conveyorTelemetry.waitingTask, null);
    assert.equal(h.models.CV2.conveyorTelemetry.externalPulls.size, 0, '拉取完成后登记必须清除');
    assert.ok(Math.abs(pushed.handoff!.durationSeconds - CARGO_HANDOFF_SECONDS) < 1e-6,
      '相邻外部拉取 hops=1，交接时长不加速');
  } finally {
    h.dispose();
  }
});

test('shuttle 待收叉站台货：externalPull 不得提前摘除，释放后按原订阅链路交接', () => {
  const h = makeHarness({ SH1: { centerX: -4, stacker: true }, CV2: { centerX: 0 } });
  try {
    const shuttleCargo = h.insertShuttleCargo('SH1', '7');

    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h.state.shuttleCargoMeshes.size, 1, '收叉前货物必须留在 shuttle 表');
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '收叉前不得进入 conveyor 持货表');
    assert.equal(h.models.CV2.conveyorTelemetry.externalPulls.size, 1, '等待期间必须保留外部拉取登记');

    h.setShuttleHandoffPending(false);
    h.scan();
    assert.equal(h.state.shuttleCargoMeshes.size, 0, '门控释放后必须摘除 shuttle 原引用');
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.root, shuttleCargo.root, '必须接管 shuttle 同一货物实例');
    assert.equal(pushed.assetCode, 'CV2');
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.CV2.conveyorTelemetry.externalPulls.size, 0);
  } finally {
    h.dispose();
  }
});

test('链式接力：同帧逐级传递，同一货物实例沿链路传到末端', () => {
  const h = makeHarness({
    CV1: { centerX: -4, origin: true },
    CV2: { centerX: 0 },
    CV3: { centerX: 4 },
  });
  try {
    // CV1 起点刷出；CV2 订阅 → 当帧交付；CV3 订阅 → 同帧接力交付
    h.apply('CV1', { task: 7, movement_x: 1 });
    const originRoot = onlyCargo(h.state).root;

    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(onlyCargo(h.state).assetCode, 'CV2', 'CV1 持货必须先交付 CV2');

    h.apply('CV3', { task: 7, movement_x: 1 });
    const final = onlyCargo(h.state);
    assert.equal(final.root, originRoot, '链式接力必须保持同一货物实例');
    assert.equal(final.assetCode, 'CV3', '货物必须最终传到末端 CV3');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.CV2.conveyorTelemetry.cargoCode, null, '中间设备接力后不得留存货物');
    assert.equal(h.models.CV3.conveyorTelemetry.cargoCode, 'cargo');
  } finally {
    h.dispose();
  }
});

test('多跳直达交付：越级跳过空载中间设备，新刷货物直接落位不插值', () => {
  const h = makeHarness({
    UP: { centerX: -4, origin: true },
    MID: { centerX: 0 },
    DOWN: { centerX: 4 },
  });
  try {
    // DOWN 先收 task=7：订阅经 MID 传递到 UP（MID/UP 依次登记 hops=1/2）
    h.apply('DOWN', { task: 7, movement_x: 1 });
    assert.equal(h.models.MID.conveyorTelemetry.downstreamLinks.get('DOWN')?.hops, 1);
    assert.equal(h.models.UP.conveyorTelemetry.downstreamLinks.get('DOWN')?.hops, 2);

    // UP 起点刷出 → 直达交付 DOWN（MID 全程不持货）；新货无历史位姿，不建交接插值直接落位
    h.apply('UP', { task: 7, movement_x: 1 });
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.assetCode, 'DOWN', '货物必须直达交付给最终订阅者');
    assert.equal(pushed.task, '7');
    assert.equal(h.models.UP.conveyorTelemetry.cargoCode, null, 'UP 引用必须清空');
    assert.equal(h.models.MID.conveyorTelemetry.cargoCode, null, 'MID 全程不得持货');
    assert.equal(h.models.DOWN.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.DOWN.conveyorTelemetry.waitingTask, null);
    assert.equal(h.models.DOWN.conveyorTelemetry.selfDriveDirection, 1);
    assert.ok(Math.abs(h.models.DOWN.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE)) < 1e-6,
      `DOWN 必须从自身刷出端接入，实际 ${h.models.DOWN.conveyorTelemetry.cargoTravelOffset}`);
    assert.equal(pushed.handoff, null, '新刷出货物无历史位姿，不得建交接插值');
    // 收货退订沿链清除登记
    assert.equal(h.models.MID.conveyorTelemetry.downstreamLinks.size, 0, 'MID 必须摘除 DOWN 的登记');
    assert.equal(h.models.UP.conveyorTelemetry.downstreamLinks.size, 0, 'UP 必须摘除 DOWN 的登记');
  } finally {
    h.dispose();
  }
});

test('多跳直达交付（已摆位姿持货）：交接动画按跳数加速（1s/hops）', () => {
  const h = makeHarness({
    UP: { centerX: -4, origin: true },
    MID: { centerX: 0 },
    DOWN: { centerX: 4 },
  });
  try {
    // DOWN 先收 task=7：订阅经 MID 传递到 UP（MID/UP 依次登记 hops=1/2）
    h.apply('DOWN', { task: 7, movement_x: 1 });
    assert.equal(h.models.MID.conveyorTelemetry.downstreamLinks.get('DOWN')?.hops, 1);
    assert.equal(h.models.UP.conveyorTelemetry.downstreamLinks.get('DOWN')?.hops, 2);

    // UP 已摆位姿持货（在途货物被订阅命中）→ 直达交付 DOWN，hops=2 → 交接时长减半。
    // UP 不带新 task：避免起点设备交付后按无货流程再刷新货。
    h.insertConveyorCargo('UP', '7');
    h.apply('UP', { movement_x: 1 });
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.assetCode, 'DOWN', '货物必须直达交付给最终订阅者');
    assert.equal(pushed.task, '7');
    assert.equal(h.models.UP.conveyorTelemetry.cargoCode, null, 'UP 引用必须清空');
    assert.equal(h.models.MID.conveyorTelemetry.cargoCode, null, 'MID 全程不得持货');
    assert.equal(h.models.DOWN.conveyorTelemetry.cargoCode, 'cargo');
    assert.ok(pushed.handoff, '已摆位姿货物交付必须登记交接插值保持视觉连续');
    assert.ok(Math.abs(pushed.handoff!.durationSeconds - CARGO_HANDOFF_SECONDS / 2) < 1e-6,
      `两跳交付交接时长必须减半为 ${CARGO_HANDOFF_SECONDS / 2}s，实际 ${pushed.handoff!.durationSeconds}`);
    // 收货退订沿链清除登记
    assert.equal(h.models.MID.conveyorTelemetry.downstreamLinks.size, 0, 'MID 必须摘除 DOWN 的登记');
    assert.equal(h.models.UP.conveyorTelemetry.downstreamLinks.size, 0, 'UP 必须摘除 DOWN 的登记');
  } finally {
    h.dispose();
  }
});

test('越级交付过境标记：等待中的中间设备标记 transitedTasks，此后同 task 仅更新 lastTask', () => {
  const h = makeHarness({
    UP: { centerX: -4, origin: true },
    MID: { centerX: 0 },
    DOWN: { centerX: 4 },
  });
  try {
    // DOWN 先订阅（UP 下位链路先登记 DOWN），MID 后订阅同 task
    h.apply('DOWN', { task: 7, movement_x: 1 });
    h.apply('MID', { task: 7, movement_x: 1 });
    assert.deepEqual([...h.models.UP.conveyorTelemetry.downstreamLinks.keys()], ['DOWN', 'MID']);

    // UP 刷出 → 直达交付先注册的 DOWN（越过等待中的 MID）→ taken 波把 MID 标记过境
    h.apply('UP', { task: 7, movement_x: 1 });
    assert.equal(onlyCargo(h.state).assetCode, 'DOWN');
    assert.ok(h.models.MID.conveyorTelemetry.transitedTasks.has('7'), 'MID 必须标记过境 task');
    assert.equal(h.models.MID.conveyorTelemetry.waitingTask, null, '过境后不得继续挂单');
    assert.equal(h.models.MID.conveyorTelemetry.pendingTask, null);

    // MID 改收 task=8 再回到 7：已过境，仅更新 lastTask，自身 task=8 的等待与登记不受影响
    h.apply('MID', { task: 8, movement_x: 1 });
    assert.equal(h.models.MID.conveyorTelemetry.waitingTask, '8');
    h.apply('MID', { task: 7, movement_x: 1 });
    assert.equal(h.models.MID.conveyorTelemetry.lastTask, '7', 'lastTask 仍须更新');
    assert.equal(h.models.MID.conveyorTelemetry.currentTask, '8', '已过境 task 不得覆盖自身 task');
    assert.equal(h.models.MID.conveyorTelemetry.pendingTask, '8', '自身 task=8 的等待必须保持');
    assert.equal(h.models.MID.conveyorTelemetry.waitingTask, '8');
    assert.equal(h.models.UP.conveyorTelemetry.downstreamLinks.get('MID')?.task, '8',
      '自身 task=8 的订阅登记必须保留，过境 task 不得新增登记');
    assert.equal(h.models.UP.conveyorTelemetry.downstreamLinks.size, 1);
    assert.equal(h.state.conveyorCargoMeshes.size, 1, '不得产生新货物');
  } finally {
    h.dispose();
  }
});

test('侧向通知注册：B 探测不到 A 时凭 available 注册上游并订阅成功', () => {
  // B 中心 4.4、半径 2.1：A 的出口探测点 x=2.36 落入 B[2.3,6.5]，B 的入口探测点 x=1.94 探不到 A[-2,2]
  const h = makeHarness({
    A: { centerX: 0, origin: true },
    B: { centerX: 4.4, halfSpanX: 2.1 },
  });
  try {
    // B 先收 task：探不到上游、无注册上游 → 仅等待
    h.apply('B', { task: 7, movement_x: 1 });
    assert.equal(h.models.B.conveyorTelemetry.waitingTask, '7');
    assert.equal(h.models.B.conveyorTelemetry.upstreamLinks.size, 0);

    // A 起点刷出 → available 通知触及 B 侧面 → B 注册 A 为上游并立即订阅 → A 当帧交付
    h.apply('A', { task: 7, movement_x: 1 });
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.assetCode, 'B', 'B 必须凭通知注册的链路收到货物');
    assert.equal(pushed.task, '7');
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.B.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.B.conveyorTelemetry.waitingTask, null);
  } finally {
    h.dispose();
  }
});

test('成环布局防环：消息 visited 丢弃回环，链路登记不重复不溢出', () => {
  // 三机相距 100m 探测点互不触及；手工注入上位链路成环 A→B→C→A（模拟通知泛洪形成的环）
  const h = makeHarness({
    A: { centerX: 0 },
    B: { centerX: 100 },
    C: { centerX: 200 },
  });
  try {
    const link = { task: '7', holderAssetCode: '', hops: 1, direction: 1 };
    h.models.A.conveyorTelemetry.upstreamLinks.set('B', { ...link, holderAssetCode: 'B' });
    h.models.B.conveyorTelemetry.upstreamLinks.set('C', { ...link, holderAssetCode: 'C' });
    h.models.C.conveyorTelemetry.upstreamLinks.set('A', { ...link, holderAssetCode: 'A' });

    // A 收 task=7：沿注册上游订阅 A→B→C→A，回环被 visited 丢弃
    h.apply('A', { task: 7, movement_x: 1 });
    assert.equal(h.models.A.conveyorTelemetry.waitingTask, '7');
    assert.ok(h.models.B.conveyorTelemetry.downstreamLinks.has('A'));
    assert.ok(h.models.C.conveyorTelemetry.downstreamLinks.has('A'));
    assert.equal(h.models.A.conveyorTelemetry.downstreamLinks.size, 0, '回环丢弃后 A 不得重复登记自身');
    assert.equal(h.state.conveyorCargoMeshes.size, 0);
  } finally {
    h.dispose();
  }
});

test('帧调度契约：applyWhenStale 仅自驱，帧尾无条件执行外部持货拉取扫描', () => {
  const source = readFileSync('src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime.ts', 'utf8');
  const conveyorRegistration = source.match(/deviceType: 'conveyor',[\s\S]*?\},\r?\n/);
  assert.ok(conveyorRegistration, '必须存在 conveyor 驱动注册项');
  assert.match(
    conveyorRegistration[0],
    /applyWhenStale: \(model\) => \(model\.conveyorTelemetry\?\.selfDriveDirection \?\? 0\) !== 0/,
    'conveyor 注册断流驱动必须仅判定接管自驱',
  );
  assert.doesNotMatch(
    conveyorRegistration[0],
    /needsLockedPushOutDrive/,
    '锁定协议已移除，不得残留出货动画断流判定',
  );
  assert.match(
    source,
    /this\.conveyorDriver\.pullExternalHolderCargo\(\)/,
    'applyFrame 帧尾必须执行外部持货拉取扫描',
  );
});

test('trajectoryDirection 为模型本地坐标：模型旋转 180° 后正转仍从本地轨迹起点刷出', () => {
  const h = makeHarness({
    CV1: { centerX: 0, origin: true, rotationY: Math.PI, trajectoryDirection: 'x' },
  });
  try {
    // 本地 x 轴经 180° 旋转后指向世界 −x；trajectoryDirection='x' 按本地语义
    // 正转刷出端为本地轨迹起点 → 世界 +x 端（若按世界语义会刷在世界 −x 端）。
    h.apply('CV1', { task: 7, movement_x: 1 });
    const cargo = onlyCargo(h.state);
    const spawnX = cargo.root.position.x;
    assert.ok(spawnX > HALF_RANGE - 0.1,
      `正转必须从世界 +x 端（本地轨迹起点）刷出，实际 x=${spawnX}`);

    // 继续走行：货物沿本地轨迹方向推进，即世界 −x 方向
    h.apply('CV1', { task: 7, movement_x: 1 }, 0.1, 10);
    const laterX = cargo.root.position.x;
    assert.ok(laterX < spawnX, `货物必须向世界 −x 方向走行：${spawnX} → ${laterX}`);

    // 对照：trajectoryDirection='-x' 时刷出端翻到世界 −x 端
    const h2 = makeHarness({
      CV1: { centerX: 0, origin: true, rotationY: Math.PI, trajectoryDirection: '-x' },
    });
    try {
      h2.apply('CV1', { task: 7, movement_x: 1 });
      const cargo2 = onlyCargo(h2.state);
      assert.ok(cargo2.root.position.x < -(HALF_RANGE - 0.1),
        `trajectoryDirection='-x' 必须从世界 −x 端刷出，实际 x=${cargo2.root.position.x}`);
    } finally {
      h2.dispose();
    }
  } finally {
    h.dispose();
  }
});

test('合批遥测代理：订阅沿代理几何上行注册，货物越级直达交付到代理设备', () => {
  // CV3 是 CV2 的合批代理（无自身几何，包围盒经宿主换算）；链路必须穿过宿主邻居 CV2 到达 CV1。
  const h = makeHarness({
    CV1: { centerX: -4, origin: true },
    CV2: { centerX: 0 },
    CV3: { centerX: 4, proxyOf: 'CV2' },
  });
  try {
    const stamp = 1_000_000;
    // CV3（代理）先收 task：探测点由宿主包围盒换算得到，订阅沿 CV3→CV2→CV1 上行注册
    h.apply('CV3', { task: 9, movement_x: 1 }, 0.1, 1, stamp);
    assert.equal(h.models.CV3.conveyorTelemetry.waitingTask, '9', '代理设备必须登记等待 task');
    assert.ok(h.models.CV2.conveyorTelemetry.downstreamLinks.has('CV3'), '订阅必须途经宿主邻居 CV2');
    assert.ok(h.models.CV1.conveyorTelemetry.downstreamLinks.has('CV3'), '订阅必须传递到起点 CV1');

    // CV1 刷出后事件驱动交付：货物越级直达最终订阅者 CV3（代理的行程上下文参与交付落地）
    h.apply('CV1', { task: 9, movement_x: 1 });
    const pushed = onlyCargo(h.state);
    assert.equal(pushed.assetCode, 'CV3', '货物必须换绑到代理设备');
    assert.equal(pushed.task, '9');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null, '持有方引用必须清空');
    assert.equal(h.models.CV3.conveyorTelemetry.cargoCode, 'cargo', '代理设备必须接管货物身份');
    assert.equal(h.models.CV3.conveyorTelemetry.waitingTask, null, '被交付后必须退出等待');
    assert.ok(Math.abs(h.models.CV3.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE)) < 1e-6,
      '代理设备货物必须从本机刷出端开始走行');
    assert.equal(h.models.CV3.conveyorTelemetry.selfDriveDirection, 1, '承接后必须登记自驱方向');

    // 代理设备断流自驱（同一 receivedAt 重放）：货物从 CV3 刷出端（世界 x=4−1.64）向终点推进
    h.apply('CV3', { task: 9, movement_x: 0 }, 0.1, 5, stamp);
    const movedX = pushed.root.position.x;
    assert.ok(movedX > 4 - HALF_RANGE, `代理设备货物必须在本机位姿走行，实际 x=${movedX}`);
  } finally {
    h.dispose();
  }
});

test('合批代理作为起点设备：探测无上游时在代理自身位姿刷出货物', () => {
  const h = makeHarness({
    CV1: { centerX: -4, origin: true, proxyOf: 'CV2' },
    CV2: { centerX: 0 },
    CV3: { centerX: 4, proxyOf: 'CV2' },
  });
  try {
    h.apply('CV1', { task: 9, movement_x: 1 });
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, 'cargo', '代理起点必须刷出货物');
    const cargo = onlyCargo(h.state);
    assert.equal(cargo.assetCode, 'CV1');
    // 刷出端 −HALF_RANGE，刷出当帧随 movement_x=1 前进一个帧步长
    const expectedX = -4 - HALF_RANGE + CARGO_SPEED * 0.1;
    assert.ok(Math.abs(cargo.root.position.x - expectedX) < 1e-6,
      `货物必须刷在代理自身位姿刷出端（${expectedX}），实际 x=${cargo.root.position.x}`);
  } finally {
    h.dispose();
  }
});

test('货物支撑点落在设备包围盒上表面（harness 包围盒 y∈[0,1]，支撑点 y=1）', () => {
  const h = makeHarness({ CV1: { centerX: 0, origin: true } });
  try {
    h.apply('CV1', { task: 1, movement_x: 0 });
    const cargo = onlyCargo(h.state);
    assert.ok(Math.abs(cargo.root.position.y - 1) < 1e-6,
      `货物底部必须贴包围盒上表面 y=1，实际 y=${cargo.root.position.y}`);
  } finally {
    h.dispose();
  }
});

test('上架站台：上游交付的货物从入口端走行并停在站台支撑位，不冲到线体端部', () => {
  // A 在 0，站台在行走轴 +1.5（B 端侧，行程半径 1.64 内）；UP 在 -4 持货
  const h = makeHarness({ UP: { centerX: -4, origin: true }, A: { centerX: 0, platformOffset: 1.5 } });
  try {
    h.apply('A', { task: 7, movement_x: 1 });
    assert.equal(h.models.A.conveyorTelemetry.waitingTask, '7', '有上游必须走订阅等待，而非等 stacker');
    h.apply('UP', { task: 7, movement_x: 1 });
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, 'cargo', '上游持货必须当帧交付到 A');
    assert.ok(Math.abs(h.models.A.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE)) < 1e-6,
      `货物必须从 A 入口端（${-HALF_RANGE}）开始走行，实际 ${h.models.A.conveyorTelemetry.cargoTravelOffset}`);
    h.apply('A', { task: 7, movement_x: 1 }, 0.1, 200);
    const offset = h.models.A.conveyorTelemetry.cargoTravelOffset;
    assert.ok(Math.abs(offset - 1.5) < 1e-6, `货物必须钳制停在站台偏移 1.5，实际 ${offset}`);
    const cargo = onlyCargo(h.state);
    assert.ok(Math.abs(cargo.root.position.x - 1.5) < 1e-6,
      `货物世界位置必须停在站台 x=1.5，实际 x=${cargo.root.position.x}`);
  } finally {
    h.dispose();
  }
});

test('线首站台：新 task 不自建不订阅等待 stacker；放货落座站台成为滞留货物，不自动驶离', () => {
  // A 在 0，站台在行走轴 −1.5（A 端=线首上游侧），无上游邻居
  const h = makeHarness({ A: { centerX: 0, platformOffset: -1.5 } });
  try {
    h.apply('A', { task: 9, movement_x: 1 });
    assert.equal(h.models.A.conveyorTelemetry.waitingTask, '9', '线首站台机必须挂起等待 stacker');
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, null, '不得自建货箱');
    assert.equal(h.state.conveyorCargoMeshes.size, 0, '货物表必须为空');

    const cargoRoot = new TransformNode('stk_cargo_root', h.scene);
    const cargo = {
      assetCode: 'STK1', containerCode: '', task: '', root: cargoRoot,
      outputOwner: null, fallback: null, generatorEntityId: null, handoff: null, axialLengthCache: null, lockedWorldRotation: null,
    } as unknown as ConveyorCargoRuntimeEntry;
    const platform = h.platformOf('A');
    assert.ok(platform, '站台货格必须存在');
    assert.ok(h.driver.acceptPlatformPlacedCargo(h.models.A, platform!, cargo), '站台放货必须被接收');
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, 'cargo', '放货后登记为本机持货');
    assert.ok(Math.abs(h.models.A.conveyorTelemetry.cargoTravelOffset - (-1.5)) < 1e-6,
      `货物必须落座站台偏移 −1.5，实际 ${h.models.A.conveyorTelemetry.cargoTravelOffset}`);
    assert.equal(h.models.A.conveyorTelemetry.waitingTask, null, '放货后退出等待');
    assert.equal(cargo.task, '9', '等待中的 task 必须由放入货物兑现');
    assert.equal(h.models.A.conveyorTelemetry.selfDriveDirection, 0, '放货后不得自动驶离，货物滞留站台');

    // 滞留货物随字段驱动正常驶离站台走向出口
    h.apply('A', { task: 9, movement_x: 1 }, 0.1, 200);
    const offset = h.models.A.conveyorTelemetry.cargoTravelOffset;
    assert.ok(Math.abs(offset - HALF_RANGE) < 1e-6,
      `站台滞留货物必须随 movement 走向出口端（${HALF_RANGE}），实际 ${offset}`);
  } finally {
    h.dispose();
  }
});

test('线首站台：下游预订阅时放货不得直接交付，须走到本机出口（1033/1034 回归）', () => {
  const h = makeHarness({ A: { centerX: 0, platformOffset: -1.5 }, B: { centerX: 4 } });
  try {
    h.apply('A', { task: 9, movement_x: 1 });
    h.apply('B', { task: 9, movement_x: 1 });
    assert.ok(h.models.A.conveyorTelemetry.downstreamLinks.has('B'), '下游必须已向上游站台机登记订阅');

    const cargo = h.placePlatformCargo('A');
    assert.equal(cargo.task, '9');
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.B.conveyorTelemetry.cargoCode, null, '落座当帧不得被预订阅直接接走');
    assert.equal(h.models.A.conveyorTelemetry.platformPlacedCargo, true);
    assert.equal(h.models.A.conveyorTelemetry.selfDriveDirection, 0, '落座不得自动启动');

    h.apply('A', { task: 0, movement_x: 1 });
    const drivenOffset = h.models.A.conveyorTelemetry.cargoTravelOffset;
    assert.ok(drivenOffset > -1.5 && drivenOffset < HALF_RANGE, '货物必须先随字段在 1034 机内走行');
    h.apply('A', { task: 0, movement_x: 0 }, 0.1, 3);
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, 'cargo', '未到出口仍不得交付');
    assert.equal(h.models.B.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.A.conveyorTelemetry.platformPlacedCargo, true);

    h.apply('A', { task: 0, movement_x: 0 }, 0.1, 200);
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, null, '到出口后才允许交付');
    assert.equal(h.models.B.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.A.conveyorTelemetry.platformPlacedCargo, false);
    assert.ok(Math.abs(h.models.A.conveyorTelemetry.cargoTravelOffset - HALF_RANGE) < 1e-6);
    assert.ok(Math.abs(h.models.B.conveyorTelemetry.cargoTravelOffset - (-HALF_RANGE)) < 1e-6);
    assert.equal(cargo.assetCode, 'B');
  } finally {
    h.dispose();
  }
});

test('线首站台：出口交付时下游暂时占用，保留订阅并在腾空后交付同一货物', () => {
  const h = makeHarness({ A: { centerX: 0, platformOffset: -1.5 }, B: { centerX: 4 } });
  try {
    h.apply('A', { task: 9, movement_x: 1 });
    h.apply('B', { task: 9, movement_x: 1 });
    const cargo = h.placePlatformCargo('A', '9');
    h.insertConveyorCargo('B', '8');

    h.apply('A', { task: 0, movement_x: 1 }, 0.1, 200);
    assert.equal(h.models.A.conveyorTelemetry.platformPlacedCargo, false, '前置：货物已到出口');
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, 'cargo', '下游占用时原货必须留在本机');
    assert.equal(h.models.A.conveyorTelemetry.downstreamLinks.has('B'), true, '暂时占用不得删除订阅');
    assert.equal(cargo.assetCode, 'A');
    assert.equal(h.models.B.conveyorTelemetry.cargoCode, 'cargo', '不得覆盖下游上一箱货');

    h.driver.detachClaimedCargoByKey(h.driver.getConveyorCargoKey('B', 'cargo'));
    h.apply('A', { task: 0, movement_x: 0 });
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.B.conveyorTelemetry.cargoCode, 'cargo', '下游腾空后必须自动恢复交付');
    assert.equal(cargo.assetCode, 'B');
    assert.equal(onlyCargo(h.state).root, cargo.root, '必须继续交付同一货物实例');
  } finally {
    h.dispose();
  }
});

test('externalPull 接收方暂时占用：保留登记并在腾空后拉取同一货物', () => {
  const h = makeHarness({ ST1: { centerX: -4, stacker: true }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 7, movement_x: 1 });
    assert.equal(h.models.CV2.conveyorTelemetry.externalPulls.size, 1);
    h.insertConveyorCargo('CV2', '8');
    const stackerCargo = h.insertStackerCargo('ST1', '7');

    h.scan();
    assert.equal(h.state.stackerCargoMeshes.size, 1, '接收方占用时不得摘除 stacker 原货');
    assert.equal(h.models.CV2.conveyorTelemetry.externalPulls.size, 1, '暂时占用不得删除 externalPull');
    assert.equal(stackerCargo.assetCode, 'ST1');

    h.driver.detachClaimedCargoByKey(h.driver.getConveyorCargoKey('CV2', 'cargo'));
    h.scan();
    assert.equal(h.state.stackerCargoMeshes.size, 0);
    assert.equal(stackerCargo.assetCode, 'CV2', '接收方腾空后必须恢复原拉取链路');
    assert.equal(onlyCargo(h.state).root, stackerCargo.root);
    assert.equal(h.models.CV2.conveyorTelemetry.externalPulls.size, 0);
  } finally {
    h.dispose();
  }
});

test('线首站台：出口门控期间新 task 超过宽限且上游已持新货，旧货仍不得销毁或改号', () => {
  const h = makeHarness({ A: { centerX: 0, platformOffset: -1.5 }, B: { centerX: 4 } });
  try {
    h.apply('A', { task: 9, movement_x: 1 });
    h.apply('B', { task: 9, movement_x: 1 });
    const cargo = h.placePlatformCargo('A', '9');
    h.models.A.conveyorTelemetry.upstreamLinks.set('UP', {
      task: '10', holderAssetCode: 'UP', hops: 1, direction: 1,
    });

    h.apply('A', { task: 10, movement_x: 0 }, 1, 5);
    assert.equal(h.models.A.conveyorTelemetry.pendingTaskAgeSeconds > 3, true, '前置：必须超过普通复用宽限');
    assert.equal(h.models.A.conveyorTelemetry.platformPlacedCargo, true);
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, 'cargo');
    assert.equal(h.models.A.conveyorTelemetry.pendingTask, '10', '新 task 必须挂起等旧货交付');
    assert.equal(cargo.task, '9', '规则三不得销毁已有有效订阅的门控旧货');
    assert.equal(cargo.assetCode, 'A');

    h.apply('A', { task: 10, movement_x: 1 }, 0.1, 200);
    assert.equal(cargo.assetCode, 'B', '到出口后必须交付原 task 货物');
    assert.equal(cargo.task, '9');
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, null);
    assert.equal(h.models.A.conveyorTelemetry.waitingTask, '10', '旧货交付后新 task 必须继续原等待流程');
    assert.equal(h.models.B.conveyorTelemetry.cargoCode, 'cargo');
  } finally {
    h.dispose();
  }
});

test('线首站台：放货落点已在出口时下一帧解除交付门控', () => {
  const h = makeHarness({ A: { centerX: 0, platformOffset: HALF_RANGE }, B: { centerX: 4 } });
  try {
    h.apply('A', { task: 9, movement_x: 1 });
    h.apply('B', { task: 9, movement_x: 1 });
    h.placePlatformCargo('A');
    h.apply('A', { task: 9, movement_x: 0 });
    assert.equal(h.models.A.conveyorTelemetry.platformPlacedCargo, false);
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, 'cargo', '解除门控当帧仍保持原持货');
    h.apply('A', { task: 9, movement_x: 0 });
    assert.equal(h.models.B.conveyorTelemetry.cargoCode, 'cargo', '出口货不得被门控永久阻塞');
  } finally {
    h.dispose();
  }
});

test('线首站台：货物被取走或销货后清理出口门控', () => {
  for (const action of ['pickup', 'dispose'] as const) {
    const h = makeHarness({ A: { centerX: 0, platformOffset: -1.5, autoDispose: true }, B: { centerX: 4 } });
    try {
      h.apply('A', { task: 9, movement_x: 1 });
      h.apply('B', { task: 9, movement_x: 1 });
      const cargo = h.placePlatformCargo('A');
      assert.equal(h.models.A.conveyorTelemetry.platformPlacedCargo, true);
      if (action === 'pickup') {
        assert.equal(h.driver.adoptPlatformCargoForStacker(h.models.A, 'SH1'), cargo);
      } else {
        h.apply('A', { task: 9, movement_x: 0, mode: 2, front_has_goods: 0, back_has_goods: 0 });
      }
      assert.equal(h.models.A.conveyorTelemetry.cargoCode, null);
      assert.equal(h.models.A.conveyorTelemetry.platformPlacedCargo, false);
      assert.equal(h.state.conveyorCargoMeshes.size, 0);
    } finally {
      h.dispose();
    }
  }
});

test('上架站台：站台在入口侧时上游来货仍恒以站台为终点（不冲到对侧端部）', () => {
  // 回归 test3 场景：A 在 0，站台在行走轴 +1.5（与上游同侧=入口侧）；UP 在 +4 持货，流向 -X（movement_x=2）
  const h = makeHarness({ UP: { centerX: 4, origin: true }, A: { centerX: 0, platformOffset: 1.5 } });
  try {
    h.apply('A', { task: 7, movement_x: 2 });
    assert.equal(h.models.A.conveyorTelemetry.waitingTask, '7', '有上游必须走订阅等待');
    h.apply('UP', { task: 7, movement_x: 2 });
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, 'cargo', '上游持货必须当帧交付到 A');
    assert.ok(Math.abs(h.models.A.conveyorTelemetry.cargoTravelOffset - HALF_RANGE) < 1e-6,
      `货物必须从 A 入口端（${HALF_RANGE}）开始走行，实际 ${h.models.A.conveyorTelemetry.cargoTravelOffset}`);
    h.apply('A', { task: 7, movement_x: 2 }, 0.1, 200);
    const offset = h.models.A.conveyorTelemetry.cargoTravelOffset;
    assert.ok(Math.abs(offset - 1.5) < 1e-6,
      `站台虽在入口侧，货物仍必须停在站台偏移 1.5，实际 ${offset}`);
    const cargo = onlyCargo(h.state);
    assert.ok(Math.abs(cargo.root.position.x - 1.5) < 1e-6,
      `货物世界位置必须停在站台 x=1.5，实际 x=${cargo.root.position.x}`);
  } finally {
    h.dispose();
  }
});

test('线首站台：无等待 task 时放货成为滞留货物，后续新 task 复用该货物驶离', () => {
  // A 在 0，站台在 −1.5，无上游；stacker 先在站台放货（A 尚无 task），随后 A 接到新 task
  const h = makeHarness({ A: { centerX: 0, platformOffset: -1.5 } });
  try {
    const cargoRoot = new TransformNode('stk_cargo_root', h.scene);
    const cargo = {
      assetCode: 'STK1', containerCode: '', task: '', root: cargoRoot,
      outputOwner: null, fallback: null, generatorEntityId: null, handoff: null, axialLengthCache: null, lockedWorldRotation: null,
    } as unknown as ConveyorCargoRuntimeEntry;
    const platform = h.platformOf('A');
    assert.ok(platform, '站台货格必须存在');
    assert.ok(h.driver.acceptPlatformPlacedCargo(h.models.A, platform!, cargo), '站台放货必须被接收');
    assert.equal(h.models.A.conveyorTelemetry.cargoCode, 'cargo', '放货后登记为本机持货');
    assert.ok(Math.abs(h.models.A.conveyorTelemetry.cargoTravelOffset - (-1.5)) < 1e-6,
      `货物必须落座站台偏移 −1.5，实际 ${h.models.A.conveyorTelemetry.cargoTravelOffset}`);
    assert.equal(h.models.A.conveyorTelemetry.selfDriveDirection, 0, '放货后不得自动驶离');

    h.apply('A', { task: 5, movement_x: 1 }, 0.1, 200);
    assert.equal(cargo.task, '5', '后续新 task 必须复用站台滞留货物（盖 task）');
    assert.equal(h.models.A.conveyorTelemetry.waitingTask, null, '有滞留货物不得转入等待');
    const offset = h.models.A.conveyorTelemetry.cargoTravelOffset;
    assert.ok(Math.abs(offset - HALF_RANGE) < 1e-6,
      `复用后货物必须走向出口端（${HALF_RANGE}），实际 ${offset}`);
  } finally {
    h.dispose();
  }
});

test('线首站台：放入货物自带 task 与等待 task 不同时不盖号，保留身份等本机 task 边沿复用驶离', () => {
  // A 在 0，站台在 −1.5，无上游；启动晚错过 task 9 的源事件，A 滞留等待 9；shuttle 放入自带 task 10 的新货
  const h = makeHarness({ A: { centerX: 0, platformOffset: -1.5 } });
  try {
    h.apply('A', { task: 9, movement_x: 1 });
    assert.equal(h.models.A.conveyorTelemetry.waitingTask, '9', '线首站台机必须挂起等待');

    const cargoRoot = new TransformNode('sh_cargo_root', h.scene);
    const cargo = {
      assetCode: 'SH1', containerCode: '', task: '10', root: cargoRoot,
      outputOwner: null, fallback: null, generatorEntityId: null, handoff: null, axialLengthCache: null, lockedWorldRotation: null,
    } as unknown as ConveyorCargoRuntimeEntry;
    const platform = h.platformOf('A');
    assert.ok(platform, '站台货格必须存在');
    assert.ok(h.driver.acceptPlatformPlacedCargo(h.models.A, platform!, cargo), '站台放货必须被接收');
    assert.equal(cargo.task, '10', '不得把新货盖号成滞留等待的旧 task 9（防补位）');
    assert.equal(h.models.A.conveyorTelemetry.waitingTask, null, '站台被实物占用必须退出等待');
    assert.equal(h.models.A.conveyorTelemetry.lastTask, '9', '不得预写 lastTask，否则本机 task 10 边沿被吞');
    assert.equal(h.models.A.conveyorTelemetry.selfDriveDirection, 0, '落座后不得自动驶离');
    assert.ok(Math.abs(h.models.A.conveyorTelemetry.cargoTravelOffset - (-1.5)) < 1e-6,
      `货物必须落座站台偏移 −1.5，实际 ${h.models.A.conveyorTelemetry.cargoTravelOffset}`);

    // 本机上报 task 10：新 task 边沿 → 滞留箱复用（task 不变）驶离
    h.apply('A', { task: 10, movement_x: 1 }, 0.1, 200);
    assert.equal(cargo.task, '10', '复用不得改变货物 task');
    assert.equal(h.models.A.conveyorTelemetry.waitingTask, null, '有滞留货物不得转入等待');
    const offset = h.models.A.conveyorTelemetry.cargoTravelOffset;
    assert.ok(Math.abs(offset - HALF_RANGE) < 1e-6,
      `本机 task 边沿后货物必须走向出口端（${HALF_RANGE}），实际 ${offset}`);
  } finally {
    h.dispose();
  }
});

test('RGV 起转交付后 movement 脉冲清零自驱再静默：字段接管结束必须自动续行到行程终点（中鼎 1004 回归）', () => {
  // 现场序列：RGV 起转当场交付（pendingTask 命中，投影落地）→ conveyor 续报 movement_x=1 清零自驱
  // → 字段静默（快速回放下字段窗口推进量≈0）→ 自驱必须重新登记，把货物续行到行程终点。
  const h = makeHarness({ CV1: { centerX: 0 } });
  try {
    h.apply('CV1', { task: 101, mode: 2, movement_x: 0 }, 0.1, 1, 1000);
    assert.equal(h.models.CV1.conveyorTelemetry.pendingTask, '101', 'mode=2 边沿也必须登记 pendingTask');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null);

    // 镜像 facade 推送交付：预检 → 摘除原引用 → 落地（起转当场交付 progress<1 → 按当前位置投影）
    const model = h.models.CV1;
    assert.equal(h.driver.canAcceptRgvColumnPlacedCargo(model, '101'), true, 'pendingTask 命中必须过预检');
    const rgvCargoKey = JSON.stringify(['RGV1', 'front']);
    h.insertRgvCargo('RGV1', '101');
    const rgvCargo = h.state.rgvCargoMeshes.get(rgvCargoKey)!;
    rgvCargo.root.position.x = -HALF_RANGE;
    h.state.rgvCargoMeshes.delete(rgvCargoKey);
    assert.equal(h.driver.acceptRgvColumnPlacedCargo(model, rgvCargo, '101', true), true);
    assert.ok(Math.abs(model.conveyorTelemetry.cargoTravelOffset + HALF_RANGE) < 1e-6,
      `投影落地必须在进入端 ${-HALF_RANGE}，实际 ${model.conveyorTelemetry.cargoTravelOffset}`);
    assert.equal(model.conveyorTelemetry.selfDriveDirection, 1, '承接即走行必须登记自驱');

    // 字段接管：movement_x=1 新消息清零自驱并字段驱动少许（快速回放下该窗口推进量极小）
    h.apply('CV1', { task: 101, mode: 3, movement_x: 1 }, 0.1, 3, 2000);
    assert.equal(model.conveyorTelemetry.selfDriveDirection, 0, 'movement 非 0 新消息必须清零自驱');
    const stranded = -HALF_RANGE + CARGO_SPEED * 0.1 * 3;
    assert.ok(Math.abs(model.conveyorTelemetry.cargoTravelOffset - stranded) < 1e-6,
      `字段驱动必须推进到 ${stranded}，实际 ${model.conveyorTelemetry.cargoTravelOffset}`);

    // 字段静默：movement=0 后自驱必须重新登记，货物续行到行程终点
    h.apply('CV1', { task: 101, mode: 2, movement_x: 0 }, 0.1, 10, 3000);
    assert.ok(model.conveyorTelemetry.cargoTravelOffset > stranded + CARGO_SPEED * 0.1 * 9,
      `字段静默后必须续行，实际 ${model.conveyorTelemetry.cargoTravelOffset}`);
    h.apply('CV1', { task: 101, mode: 2, movement_x: 0 }, 0.1, 150, 4000);
    assert.ok(Math.abs(model.conveyorTelemetry.cargoTravelOffset - HALF_RANGE) < 1e-6,
      `货物必须续行到行程终点 ${HALF_RANGE}，实际 ${model.conveyorTelemetry.cargoTravelOffset}`);
  } finally {
    h.dispose();
  }
});

test('滞留箱复用登记自驱后 movement 脉冲清零再静默：必须续行到行程终点（中鼎 1005 回归）', () => {
  // 现场序列：stacker 站台放货成滞留货 → 新 task 复用登记自驱 → conveyor movement_x=1 脉冲清零自驱
  // → 字段静默 → 自驱必须重新登记，把货物续行到行程终点。
  const h = makeHarness({ CV1: { centerX: 0 } });
  try {
    const held = h.insertConveyorCargo('CV1', '370');
    h.apply('CV1', { task: 371, mode: 2, movement_x: 0 }, 0.1, 1, 1000);
    assert.equal(held.task, '371', '滞留箱必须复用盖新 task');
    assert.equal(h.models.CV1.conveyorTelemetry.selfDriveDirection, 1, '复用必须登记自驱驶离');
    const afterReuse = CARGO_SPEED * 0.1;
    assert.ok(Math.abs(h.models.CV1.conveyorTelemetry.cargoTravelOffset - afterReuse) < 1e-6,
      `复用当帧必须自驱推进到 ${afterReuse}，实际 ${h.models.CV1.conveyorTelemetry.cargoTravelOffset}`);

    // 字段接管脉冲清零自驱
    h.apply('CV1', { task: 371, mode: 3, movement_x: 1 }, 0.1, 2, 2000);
    assert.equal(h.models.CV1.conveyorTelemetry.selfDriveDirection, 0);
    const stranded = afterReuse + CARGO_SPEED * 0.1 * 2;
    assert.ok(Math.abs(h.models.CV1.conveyorTelemetry.cargoTravelOffset - stranded) < 1e-6);

    // 字段静默后续行到终点
    h.apply('CV1', { task: 371, mode: 2, movement_x: 0 }, 0.1, 150, 3000);
    assert.ok(Math.abs(h.models.CV1.conveyorTelemetry.cargoTravelOffset - HALF_RANGE) < 1e-6,
      `货物必须续行到行程终点 ${HALF_RANGE}，实际 ${h.models.CV1.conveyorTelemetry.cargoTravelOffset}`);
  } finally {
    h.dispose();
  }
});

test('lift 推来匿名货：PLC 已不再上报残留等待 task 时保留匿名落机并清等待，不越级拽走', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 }, CV3: { centerX: 4 } });
  try {
    // 下游先订阅 task=100，CV2 登记下位链路
    h.apply('CV3', { task: 100, movement_x: 1 });
    assert.ok(h.models.CV2.conveyorTelemetry.downstreamLinks.has('CV3'));
    // CV2 报 task=100 后 PLC 很快归零（启动晚残留的旧等待）
    h.apply('CV2', { task: 100, movement_x: 1 });
    h.apply('CV2', { task: 0, movement_x: 1 });
    const cv2 = h.models.CV2.conveyorTelemetry;
    assert.equal(cv2.waitingTask, '100');
    assert.equal(cv2.snapshotTask, '', 'PLC 当前已不再上报 100');

    // 提升机推来一件匿名货（task 为空）
    const lifted = h.insertRgvCargo('RGV1', '');
    h.state.rgvCargoMeshes.delete(JSON.stringify(['RGV1', 'front']));
    assert.equal(h.driver.acceptRgvColumnPlacedCargo(h.models.CV2, lifted as ConveyorCargoRuntimeEntry, '', false, false), true);
    assert.equal(lifted.task, '', 'PLC 已不持有等待 task 时，匿名货不得被改号');
    assert.equal(lifted.assetCode, 'CV2', '匿名货必须留在接收方');
    assert.equal(cv2.waitingTask, null, '残留等待必须清除');
    assert.equal(cv2.pendingTask, null, '残留挂单必须清除');
    assert.ok(cv2.downstreamLinks.has('CV3'), '旧 task 订阅登记不得触发匿名货交付');
  } finally {
    h.dispose();
  }
});

test('lift 推来匿名货：PLC 当前仍上报等待 task 时由推货兑现该 task', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    h.apply('CV2', { task: 100, movement_x: 1 });
    const cv2 = h.models.CV2.conveyorTelemetry;
    assert.equal(cv2.waitingTask, '100');
    assert.equal(cv2.snapshotTask, '100', 'PLC 当前仍上报 100');

    const lifted = h.insertRgvCargo('RGV1', '');
    h.state.rgvCargoMeshes.delete(JSON.stringify(['RGV1', 'front']));
    assert.equal(h.driver.acceptRgvColumnPlacedCargo(h.models.CV2, lifted as ConveyorCargoRuntimeEntry, '', false, false), true);
    assert.equal(lifted.task, '100', 'PLC 仍持有时匿名货由等待 task 兑现');
    assert.equal(lifted.assetCode, 'CV2');
    assert.equal(cv2.waitingTask, null);
  } finally {
    h.dispose();
  }
});

test('提升机双货连续下料：在机货先等下游接走，不被下一件 task 边沿改号，接收方腾空后第二件正常落地', () => {
  const h = makeHarness({ CV1: { centerX: -4, origin: true }, CV2: { centerX: 0 }, CV3: { centerX: 4 } });
  try {
    // CV1 刷出 task=1，CV2 报 edge 后订阅交付到 CV2（对应 1023 先接第一件货）
    h.apply('CV1', { task: 1, movement_x: 1 });
    h.apply('CV2', { task: 1, movement_x: 1 });
    const first = onlyCargo(h.state);
    assert.equal(first.assetCode, 'CV2');
    assert.equal(first.task, '1');

    // 第二件货的 task 边沿紧随其后到达，但下游 CV3 还没报 task=1：不得立即复用改号
    h.apply('CV2', { task: 2, movement_x: 1 });
    const cv2 = h.models.CV2.conveyorTelemetry;
    assert.equal(first.task, '1', '宽限期内第一件货不得被改号');
    assert.equal(cv2.cargoCode, 'cargo', '第一件货必须仍在机');
    assert.equal(cv2.pendingTask, '2', '第二件 task 必须保持挂起');

    // 下游 CV3 报 task=1：CV2 把在机货正常交付，接收方腾空
    h.apply('CV3', { task: 1, movement_x: 1 });
    assert.equal(first.assetCode, 'CV3', '第一件货必须被下游接走');
    assert.equal(first.task, '1', '第一件货身份不得丢失');
    assert.equal(cv2.cargoCode, null, '交付后接收方必须腾空');
    assert.equal(cv2.pendingTask, '2', '第二件 task 仍在等待落地');

    // 提升机把第二件 task=2 推进已腾空的 CV2：正常接收
    const second = h.insertRgvCargo('RGV1', '2');
    h.state.rgvCargoMeshes.delete(JSON.stringify(['RGV1', 'front']));
    assert.equal(h.driver.acceptRgvColumnPlacedCargo(h.models.CV2, second as ConveyorCargoRuntimeEntry, '', false, false), true);
    assert.equal(second.assetCode, 'CV2');
    assert.equal(second.task, '2', '第二件货必须保留自身 task');
    assert.equal(cv2.cargoCode, 'cargo');
    assert.equal(cv2.pendingTask, null);
  } finally {
    h.dispose();
  }
});

test('提升机来料口：下一件 task 边沿先于提升机取货到达时，保留在机货等提升机取走', () => {
  const h = makeHarness({ CV1: { centerX: 0 }, LIFT1: { centerX: 4, lift: true } });
  try {
    const held = h.insertConveyorCargo('CV1', '100');
    h.apply('CV1', { task: 100, movement_x: 1 });
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, 'cargo', '前置：在机货 task=100');

    // 提升机还没回来取货，下一件 task=101 的边沿已经到了
    h.apply('CV1', { task: 101, movement_x: 1 });
    assert.equal(held.task, '100', '提升机来料口在机货不得被下一件 task 改号');
    assert.equal(h.models.CV1.conveyorTelemetry.pendingTask, '101', '新 task 必须保持挂起等提升机取走');

    // 提升机取走当前持货（adopt 无视 task 接管）
    h.driver.detachClaimedCargoByKey(h.driver.getConveyorCargoKey('CV1', 'cargo'));
    h.apply('CV1', { task: 101, movement_x: 1 });
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, null, '提升机取走后本机必须腾空');
    assert.equal(h.models.CV1.conveyorTelemetry.waitingTask, '101', '腾空后按新 task 进入等待/订阅');
    assert.equal(held.task, '100', '被提升机取走的货物身份不得被改写');
  } finally {
    h.dispose();
  }
});

test('下游 conveyor 仍持货（排队进提升机）：上游在机货不得被下一件 task 改号', () => {
  const h = makeHarness({ CV1: { centerX: -4 }, CV2: { centerX: 0 } });
  try {
    // CV2 被前一件货占着（排队），CV1 持有 task=100
    h.insertConveyorCargo('CV2', '200');
    const held = h.insertConveyorCargo('CV1', '100');
    h.apply('CV1', { task: 100, movement_x: 1 });

    // 下一件 task=101 边沿到达：下游仍占用，超过普通 3s 宽限也不得改号
    h.apply('CV1', { task: 101, movement_x: 1 }, 1, 5);
    assert.equal(held.task, '100', '下游排队期间在机货不得改号');
    assert.equal(h.models.CV1.conveyorTelemetry.pendingTask, '101', '新 task 必须保持挂起等队列排空');
    assert.equal(h.models.CV1.conveyorTelemetry.cargoCode, 'cargo');
  } finally {
    h.dispose();
  }
});
