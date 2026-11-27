import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import { createModelEntity } from '../../src/editor/model/SceneDocument';
import {
  createDefaultTelemetryBinding,
  isSpecializedTelemetryDeviceType,
  normalizeModelDataDrivenConfig,
  normalizeTelemetryBindingComponent,
  resolveModelTelemetryDataDrivenConfig,
} from '../../src/editor/model/telemetryBinding';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';
import { deviceTelemetryStore, type DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { telemetryRuntimeDiagnosticsStore } from '../../src/runtime/mqtt/telemetryRuntimeDiagnostics';
import { AGV_MOTION_DEFAULT_SEGMENT_SECONDS, AgvTelemetryDriver, resolveAgvYawRadians } from '../../src/runtime/babylon/telemetry/specialized/agvDriver';
import { BUILT_IN_AGV_MAPS } from '../../src/editor/model/agvMapLibrary';
import { createDefaultAgvRouteHighlightConfig } from '../../src/editor/model/agvMap';
import { isAgvRuntimeModel } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { SpecializedTelemetryRuntime } from '../../src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime';
import { createSpecializedTelemetrySharedState, type SpecializedTelemetryHost } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';
import { spawnedDeviceInspectorStore } from '../../src/runtime/mqtt/spawnedDeviceInspectorStore';
import { useEditorStore } from '../../src/editor/store/editorStore';

const DEGREES = Math.PI / 180;

function createSnapshot(fields: Record<string, unknown>, receivedAt = Date.now(), deviceType = 'agv'): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: `dt/factory/logistics/${deviceType}/AGV-01/twindatadriven/joint`,
    deviceType,
    assetCode: 'AGV-01',
    payloadDeviceCode: 'AGV-01',
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

function createAgvEntity(dataDrivenConfig?: unknown) {
  return createModelEntity(
    'agv.glb', 'editor-asset://local/agv.glb', 'AGV',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    dataDrivenConfig, undefined, undefined, undefined, 'agv',
  );
}

test('AGV 模型创建和旧场景恢复都带默认绑定，正方向轴可持久化', () => {
  const entity = createAgvEntity();
  assert.equal(isSpecializedTelemetryDeviceType('agv'), true);
  assert.equal(resolveModelTelemetryDataDrivenConfig(entity.components.modelAsset!)?.device.devType, 'agv');
  assert.deepEqual(entity.components.telemetryBinding, createDefaultTelemetryBinding('agv'));
  assert.equal(entity.components.telemetryBinding?.modelForwardAxis, 'x');

  entity.components.telemetryBinding = {
    ...entity.components.telemetryBinding!,
    modelForwardAxis: '-z',
  };
  const scene = {
    ...deserializeScene(JSON.stringify({ version: 7, units: { length: 'meter' }, scene: {
      id: 'empty', name: 'empty', entityIds: [], entities: {}, selectedEntityId: null,
    } })),
    entityIds: [entity.id],
    entities: { [entity.id]: entity },
  };
  const restored = deserializeScene(serializeScene(scene));
  assert.equal(restored.entities[entity.id].components.telemetryBinding?.modelForwardAxis, '-z');

  delete entity.components.telemetryBinding;
  const legacy = deserializeScene(serializeScene({ ...scene, entities: { [entity.id]: entity } }));
  assert.equal(legacy.entities[entity.id].components.telemetryBinding?.deviceType, 'agv');
  assert.equal(legacy.entities[entity.id].components.telemetryBinding?.modelForwardAxis, 'x');
  const normalized = normalizeTelemetryBindingComponent({
    deviceType: 'agv', modelForwardAxis: 'y',
  });
  assert.equal(normalized?.modelForwardAxis, undefined);
});

test('模型包 dataDriven 提供默认车头轴，模板绑定可覆盖且恢复时回到包默认值', () => {
  const config = normalizeModelDataDrivenConfig({
    device: { devType: 'agv', modelForwardAxis: '-z' },
    fixedNodes: [],
  });
  assert.equal(config?.device.modelForwardAxis, '-z');
  const entity = createAgvEntity({
    device: { devType: 'agv', modelForwardAxis: '-z' },
    fixedNodes: [],
  });
  assert.equal(entity.components.telemetryBinding?.modelForwardAxis, '-z');
  assert.deepEqual(
    createDefaultTelemetryBinding('agv', config?.device.modelForwardAxis),
    entity.components.telemetryBinding,
  );

  entity.components.telemetryBinding!.modelForwardAxis = 'z';
  const scene = {
    ...deserializeScene(JSON.stringify({ version: 7, units: { length: 'meter' }, scene: {
      id: 'empty', name: 'empty', entityIds: [], entities: {}, selectedEntityId: null,
    } })),
    entityIds: [entity.id],
    entities: { [entity.id]: entity },
  };
  assert.equal(
    deserializeScene(serializeScene(scene)).entities[entity.id].components.telemetryBinding?.modelForwardAxis,
    'z',
  );
});

test('agv_xxx 子类型复用 AGV 驱动并按原协议类型读取快照', t => {
  assert.equal(isSpecializedTelemetryDeviceType('agv_forklift'), true);
  const entity = createAgvEntity({
    device: { devType: 'agv_forklift', modelForwardAxis: '-z' },
    fixedNodes: [],
  });
  assert.equal(entity.components.telemetryBinding?.deviceType, 'agv_forklift');
  assert.equal(entity.components.telemetryBinding?.modelForwardAxis, '-z');

  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('agv-subtype-runtime', scene);
  const model = {
    root,
    contentRoot: new TransformNode('agv-subtype-content', scene),
    assetCode: 'AGV-01',
    assetHandle: {},
    stackerTelemetryReady: true,
    entitySnapshot: entity,
    telemetryBinding: entity.components.telemetryBinding,
    externalScriptRuntime: null,
  } as unknown as ModelRuntimeEntry;
  const host = {
    collectModels: () => [{ entityId: entity.id, model }],
    pushLog: () => undefined,
    updateExternalScriptContext: () => false,
  } as unknown as SpecializedTelemetryHost;
  const runtime = new SpecializedTelemetryRuntime(scene, host);
  t.after(() => {
    runtime.dispose();
    deviceTelemetryStore.clear();
    scene.dispose();
    engine.dispose();
  });

  assert.equal(isAgvRuntimeModel(model), true);
  assert.equal(runtime.resolveDeviceType(model), 'agv');
  deviceTelemetryStore.upsert(createSnapshot({ x: 3, y: 5, r: 0, mode: 2 }, Date.now(), 'agv_forklift'));
  runtime.applyFrame(0);
  assert.deepEqual(root.position.asArray(), [3, 0, 5]);
  assert.ok(Math.abs(root.rotation.y - Math.PI / 2) < 1e-12);
});

test('正方向轴将 r=0 的车头校准到场景 +X，顺时针 r 增加', () => {
  assert.ok(Math.abs(resolveAgvYawRadians(0, 'x') - 0) < 1e-12);
  assert.ok(Math.abs(resolveAgvYawRadians(0, '-x') - Math.PI) < 1e-12);
  assert.ok(Math.abs(resolveAgvYawRadians(0, 'z') + Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(resolveAgvYawRadians(0, '-z') - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(resolveAgvYawRadians(90, 'x') - 90 * DEGREES) < 1e-12);
});

test('AGV 首帧定位后按帧平滑消费 x/y/r，保留地面高度并忽略 z、缺失字段、故障和离线帧', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const root = new TransformNode('agv', scene);
  root.position.set(1, 0.4, 2);
  root.rotation.set(0.1, 0, -0.1);
  const model = {
    root,
    telemetryBinding: { ...createDefaultTelemetryBinding('agv'), modelForwardAxis: 'z' as const },
  } as ModelRuntimeEntry;
  const driver = new AgvTelemetryDriver();

  driver.applyToModel(model, createSnapshot({ x: 12.5, y: -8, z: null, r: 90 }), 0);
  assert.deepEqual(root.position.asArray(), [12.5, 0.4, -8]);
  assert.ok(Math.abs(root.rotation.y - 0) < 1e-12);
  assert.equal(root.rotation.x, 0.1);
  assert.equal(root.rotation.z, -0.1);

  const next = createSnapshot({ x: 20 });
  driver.applyToModel(model, next, AGV_MOTION_DEFAULT_SEGMENT_SECONDS / 2);
  assert.ok(root.position.x > 12.5 && root.position.x < 20);
  assert.deepEqual([root.position.y, root.position.z], [0.4, -8]);
  assert.equal(root.rotation.y, 0);
  for (let frame = 0; frame < 180; frame++) driver.applyToModel(model, next, 1 / 60);
  assert.ok(root.position.equalsWithEpsilon(new Vector3(20, 0.4, -8), 0.0002), `实际 ${root.position.toString()}`);
  driver.applyToModel(model, { ...createSnapshot({ x: 30, y: 40, r: 180 }), faulted: true }, 1);
  driver.applyToModel(model, createSnapshot({ x: 30, y: 40, r: 180, mode: 0 }), 1);
  assert.deepEqual(root.position.asArray(), [20, 0.4, -8]);
  assert.equal(root.rotation.y, 0);
});

test('AGV 连续目标更新保留当前速度，不在每段报文边界重新刹停', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const root = new TransformNode('agv-continuous-velocity', scene);
  const model = { root } as ModelRuntimeEntry;
  const driver = new AgvTelemetryDriver();

  driver.applyToModel(model, createSnapshot({ x: 0 }), 0);
  const firstTarget = createSnapshot({ x: 2 });
  driver.applyToModel(model, firstTarget, 0.2);
  const beforeFrame = root.position.x;
  driver.applyToModel(model, firstTarget, 1 / 60);
  const previousStep = root.position.x - beforeFrame;

  const beforeNewTarget = root.position.x;
  driver.applyToModel(model, createSnapshot({ x: 4 }), 1 / 60);
  const nextStep = root.position.x - beforeNewTarget;
  assert.ok(previousStep > 0);
  assert.ok(nextStep >= previousStep * 0.95, `新目标不得把速度清零：上一帧位移 ${previousStep}，下一帧位移 ${nextStep}`);
});

test('AGV 按真实两帧时间差匀速播放上一采样段，位置和角度均不使用缓入缓出', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const root = new TransformNode('agv-real-sampling-segment', scene);
  const model = { root } as ModelRuntimeEntry;
  const driver = new AgvTelemetryDriver();
  const sample = (fields: Record<string, unknown>, sourceTimestamp: number) => ({
    ...createSnapshot(fields, sourceTimestamp),
    sourceTimestamp,
  });

  driver.applyToModel(model, sample({ x: 94.73, y: 362.03, r: 176.63 }, 1000), 0);
  const second = sample({ x: 94.73, y: 361.03, r: 170.6 }, 2000);
  driver.applyToModel(model, second, 0.5);
  assert.ok(root.position.equalsWithEpsilon(new Vector3(94.73, 0, 361.53)));
  assert.ok(Math.abs(root.rotation.y - 173.615 * DEGREES) < 1e-10);
  driver.applyToModel(model, second, 0.5);
  assert.ok(root.position.equalsWithEpsilon(new Vector3(94.73, 0, 361.03)));

  const third = sample({ x: 94.73, y: 360.03, r: 156.55 }, 3000);
  driver.applyToModel(model, third, 0.5);
  assert.ok(root.position.equalsWithEpsilon(new Vector3(94.73, 0, 360.53)), '下一段应承接上一段终点并继续保持 1 米/秒');
  assert.ok(Math.abs(root.rotation.y - 163.575 * DEGREES) < 1e-10);
});

test('AGV 车头跨越零度时沿最短转角平滑旋转', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const root = new TransformNode('agv-shortest-yaw', scene);
  const model = { root } as ModelRuntimeEntry;
  const driver = new AgvTelemetryDriver();

  const wrappedYaw = () => Math.atan2(Math.sin(root.rotation.y), Math.cos(root.rotation.y));
  driver.applyToModel(model, createSnapshot({ r: 350 }), 0);
  assert.ok(Math.abs(wrappedYaw() + 10 * DEGREES) < 1e-12);
  const next = createSnapshot({ r: 10 });
  driver.applyToModel(model, next, AGV_MOTION_DEFAULT_SEGMENT_SECONDS / 2);
  assert.ok(wrappedYaw() > -10 * DEGREES && wrappedYaw() < 10 * DEGREES, `应经 0° 转向，实际 ${root.rotation.y / DEGREES}°`);
  for (let frame = 0; frame < 180; frame++) driver.applyToModel(model, next, 1 / 60);
  assert.ok(Math.abs(wrappedYaw() - 10 * DEGREES) < 0.0002);
});

test('专用运行时仅凭 modelAsset.deviceType 识别 AGV，并驱动匹配快照', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('agv-runtime', scene);
  const entity = createAgvEntity();
  const model = {
    root,
    contentRoot: new TransformNode('agv-content', scene),
    assetCode: 'AGV-01',
    assetHandle: {},
    stackerTelemetryReady: true,
    entitySnapshot: entity,
    telemetryBinding: entity.components.telemetryBinding,
    externalScriptRuntime: null,
  } as unknown as ModelRuntimeEntry;
  const host = {
    collectModels: () => [{ entityId: entity.id, model }],
    pushLog: () => undefined,
    updateExternalScriptContext: () => false,
  } as unknown as SpecializedTelemetryHost;
  const runtime = new SpecializedTelemetryRuntime(scene, host);
  t.after(() => {
    runtime.dispose();
    deviceTelemetryStore.clear();
    scene.dispose();
    engine.dispose();
  });

  assert.equal(isAgvRuntimeModel(model), true);
  assert.equal(runtime.resolveDeviceType(model), 'agv');
  deviceTelemetryStore.upsert(createSnapshot({ x: 4, y: 6, r: 90, mode: 2 }));
  runtime.applyFrame(1 / 60);
  assert.deepEqual(root.position.asArray(), [4, 0, 6]);
  assert.ok(Math.abs(root.rotation.y - Math.PI / 2) < 1e-12);

  root.position.set(4, 0, 6);
  deviceTelemetryStore.upsert(createSnapshot({ x: 100, y: 100, r: 180 }, Date.now() - 10_000));
  runtime.applyFrame(1 / 60);
  assert.deepEqual(root.position.asArray(), [4, 0, 6], '断流快照不得继续驱动');
});

test('AGV 断流时完成已开始的过渡，到位后保持静止', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('agv-stale-motion', scene);
  const entity = createAgvEntity();
  const model = {
    root,
    contentRoot: new TransformNode('agv-stale-content', scene),
    assetCode: 'AGV-01',
    assetHandle: {},
    stackerTelemetryReady: true,
    entitySnapshot: entity,
    telemetryBinding: entity.components.telemetryBinding,
    externalScriptRuntime: null,
  } as unknown as ModelRuntimeEntry;
  const host = {
    collectModels: () => [{ entityId: entity.id, model }],
    pushLog: () => undefined,
    updateExternalScriptContext: () => false,
  } as unknown as SpecializedTelemetryHost;
  const runtime = new SpecializedTelemetryRuntime(scene, host);
  t.after(() => {
    runtime.dispose();
    deviceTelemetryStore.clear();
    scene.dispose();
    engine.dispose();
  });

  const receivedAt = Date.now();
  deviceTelemetryStore.upsert(createSnapshot({ x: 0, y: 0, r: 0, mode: 2 }, receivedAt));
  runtime.applyFrame(0);
  deviceTelemetryStore.upsert(createSnapshot({ x: 7, y: 0, r: 0, mode: 2 }, receivedAt + 1000));
  runtime.applyFrame(0.1);
  const previousX = root.position.x;
  assert.ok(previousX > 0 && previousX < 7, `新目标应先产生中间位置，实际 ${previousX}`);

  t.mock.method(Date, 'now', () => receivedAt + 10_001);
  runtime.applyFrame(0.1);
  assert.ok(root.position.x > previousX && root.position.x < 7, '断流不应把已开始的动画冻结在半路');
  for (let frame = 0; frame < 180; frame++) runtime.applyFrame(1 / 60);
  assert.ok(Math.abs(root.position.x - 7) < 0.0002, `实际 ${root.position.toString()}`);
  runtime.applyFrame(0.1);
  assert.ok(Math.abs(root.position.x - 7) < 1e-12);
});

test('AGV 运行时诊断发布任务路线和不可达状态', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('agv-route-diagnostic', scene);
  const entity = createAgvEntity();
  const model = {
    root,
    contentRoot: new TransformNode('agv-route-diagnostic-content', scene),
    assetCode: 'AGV-01',
    assetHandle: {},
    stackerTelemetryReady: true,
    entitySnapshot: entity,
    telemetryBinding: entity.components.telemetryBinding,
    externalScriptRuntime: null,
    agvMapPlacement: {
      transform: entity.components.transform,
      map: { xAxis: 'x', yAxis: 'z', scale: 1 },
      definition: BUILT_IN_AGV_MAPS[0],
    },
  } as unknown as ModelRuntimeEntry;
  const host = {
    collectModels: () => [{ entityId: entity.id, model }],
    pushLog: () => undefined,
    updateExternalScriptContext: () => false,
  } as unknown as SpecializedTelemetryHost;
  const runtime = new SpecializedTelemetryRuntime(scene, host);
  t.after(() => {
    runtime.dispose();
    deviceTelemetryStore.clear();
    telemetryRuntimeDiagnosticsStore.clear();
    scene.dispose();
    engine.dispose();
  });

  deviceTelemetryStore.upsert(createSnapshot({ x: 0, y: 0, task_begin_point: 'P01', task_end_point: 'P03' }));
  runtime.applyFrame(0);
  runtime.applyFrame(1 / 60);
  assert.deepEqual(telemetryRuntimeDiagnosticsStore.getSnapshot(entity.id)?.agvTaskRoute, {
    startNodeId: 'P01', endNodeId: 'P03', nodeIds: ['P01', 'P02', 'P03'],
    trackIds: ['T01', 'T02'], distance: 20,
  });

  deviceTelemetryStore.upsert(createSnapshot({ x: 0, y: 0, task_begin_point: 220, task_end_point: 72 }));
  runtime.applyFrame(1 / 60);
  runtime.applyFrame(1 / 60);
  assert.deepEqual(telemetryRuntimeDiagnosticsStore.getSnapshot(entity.id)?.agvTaskRoute, {
    startNodeId: '220', endNodeId: '72', nodeIds: [], trackIds: [], distance: null,
  });
});

test('动态 AGV 使用独立 Inspector 选区，配置来自模板且不会写入场景选区', () => {
  const before = useEditorStore.getState();
  const template = createAgvEntity({
    device: { devType: 'agv', modelForwardAxis: '-z' },
    fixedNodes: [],
  });
  const entityId = 'spawned:AGV\u0000AGV-02';
  const entity = {
    ...JSON.parse(JSON.stringify(template)),
    id: entityId,
  } as typeof template;
  entity.components.modelAsset!.assetCode = 'AGV-02';
  entity.components.telemetryBinding = {
    ...entity.components.telemetryBinding!,
    assetCode: 'AGV-02',
    modelForwardAxis: 'z',
  };
  spawnedDeviceInspectorStore.register({
    entityId,
    entity,
    spawnerEntityId: 'agv-spawner',
    spawnerName: 'AGV产生器',
  });
  try {
    useEditorStore.setState({
      scene: { ...before.scene, selectedEntityId: template.id },
      hierarchySelectionIds: [template.id],
    });
    useEditorStore.getState().selectSpawnedDevice(entityId);
    const selected = useEditorStore.getState();
    assert.equal(selected.selectedSpawnedDeviceId, entityId);
    assert.equal(selected.scene.selectedEntityId, null);
    assert.deepEqual(selected.hierarchySelectionIds, []);
    assert.equal(spawnedDeviceInspectorStore.getSnapshot(entityId)?.entity.components.modelAsset?.assetCode, 'AGV-02');
    assert.equal(spawnedDeviceInspectorStore.getSnapshot(entityId)?.entity.components.telemetryBinding?.modelForwardAxis, 'z');
    assert.equal(spawnedDeviceInspectorStore.getSnapshot(entityId)?.spawnerName, 'AGV产生器');

    useEditorStore.getState().selectEntity(template.id);
    assert.equal(useEditorStore.getState().selectedSpawnedDeviceId, null);
    spawnedDeviceInspectorStore.delete(entityId);
    assert.equal(spawnedDeviceInspectorStore.getSnapshot(entityId), null);
  } finally {
    spawnedDeviceInspectorStore.clear();
    useEditorStore.setState(before, true);
  }
});

test('动态 AGV 按产生器原点、地图比例尺、轴映射和 Transform 定位', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const root = new TransformNode('agv-map-position', scene);
  const model = {
    root,
    agvMapPlacement: {
      transform: {
        position: { x: 10, y: 1, z: 20 },
        rotation: { x: 0, y: Math.PI / 2, z: 0 },
        scale: { x: 2, y: 1, z: 2 },
      },
      map: { xAxis: 'x', yAxis: 'z', scale: 2.5 },
    },
  } as unknown as ModelRuntimeEntry;
  const driver = new AgvTelemetryDriver();

  driver.applyToModel(model, createSnapshot({ x: 2, y: 4, mode: 2 }), 0);
  assert.ok(root.position.equalsWithEpsilon(new Vector3(30, 1, 10)));

  const next = createSnapshot({ x: 3, mode: 2 });
  driver.applyToModel(model, next, AGV_MOTION_DEFAULT_SEGMENT_SECONDS / 2);
  assert.ok(Math.abs(root.position.x - 30) < 1e-6 && root.position.z < 10 && root.position.z > 5, `实际 ${root.position.toString()}`);
  for (let frame = 0; frame < 180; frame++) driver.applyToModel(model, next, 1 / 60);
  assert.ok(root.position.equalsWithEpsilon(new Vector3(30, 1, 5), 0.0002), `只更新 x 时必须保留地图 y 通道，实际 ${root.position.toString()}`);

  driver.resetMotionStates();
  model.agvMapPlacement = {
    transform: {
      position: { x: 10, y: 0, z: 20 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    map: { xAxis: '-x', yAxis: '-z', scale: 1 },
  };
  driver.applyToModel(model, createSnapshot({ x: 2, y: 3, mode: 2 }), 0);
  assert.deepEqual(root.position.asArray(), [8, 0, 17]);
});

test('动态 AGV 按 MQTT 站点名称计算并缓存地图最短路线，不覆盖真实坐标', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const root = new TransformNode('agv-task-route', scene);
  const model = {
    root,
    agvMapPlacement: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      map: { xAxis: 'x', yAxis: 'z', scale: 1 },
      routeHighlight: createDefaultAgvRouteHighlightConfig(),
      definition: {
        ...BUILT_IN_AGV_MAPS[0],
        stations: [
          { id: 'S01', name: '取货站', nodeId: 'P01', x: 0, y: 0 },
          { id: 'S03', name: '质检站', nodeId: 'P03', x: 12, y: 8 },
          { id: 'SC01', name: '充电站', nodeId: 'C01', x: -4, y: 0 },
        ],
      },
    },
  } as unknown as ModelRuntimeEntry;
  const driver = new AgvTelemetryDriver();

  driver.applyToModel(model, createSnapshot({ x: 1, y: 2, task_begin_point: '取货站', task_end_point: '质检站' }), 0);
  const route = driver.getTaskRoute(model);
  assert.deepEqual(route?.nodeIds, ['P01', 'P02', 'P03']);
  assert.deepEqual(route?.trackIds, ['T01', 'T02']);
  assert.equal(route?.distance, 20);
  assert.deepEqual(root.position.asArray(), [1, 0, 2], '任务路线不得替代 MQTT 实时位置');
  const highlightMesh = scene.meshes.find(mesh => mesh.metadata?.agvTaskRouteHighlight);
  assert.ok(highlightMesh, '有效任务路线应创建高亮几何');

  const sameTask = createSnapshot({ x: 1, y: 2, task_begin_point: '取货站', task_end_point: '质检站' });
  driver.applyToModel(model, sameTask, 1 / 60);
  assert.equal(driver.getTaskRoute(model), route, '相同任务应复用路线缓存');
  assert.equal(scene.meshes.find(mesh => mesh.metadata?.agvTaskRouteHighlight), highlightMesh);
  driver.applyToModel(model, createSnapshot({ x: 1, y: 2, task_begin_point: 220, task_end_point: 72 }), 1 / 60);
  assert.equal(driver.getTaskRoute(model), null, '不存在的站点名称必须返回无路线');
  assert.equal(highlightMesh.isDisposed(), true, '任务失效时应释放旧路线高亮');
  driver.applyToModel(model, createSnapshot({ x: 1, y: 2, task_begin_point: '充电站', task_end_point: '取货站' }), 1 / 60);
  assert.equal(driver.getTaskRoute(model), null, '站点存在但轨迹方向不贯通时必须返回无路线');
});

test('AGV 触及当前路线节点时保留原计划轨迹，不重新选择其它可达路线', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const root = new TransformNode('agv-task-keep-route', scene);
  const definition = {
    schemaVersion: 1 as const,
    id: 'keep-route-test',
    name: '保留当前路线测试',
    nodes: [
      { id: 'A', name: 'A', x: 0, y: 0 },
      { id: 'B', name: 'B', x: 10, y: 0 },
      { id: 'C', name: 'C', x: 10, y: 10 },
    ],
    tracks: [
      { id: 'AB', fromNodeId: 'A', toNodeId: 'B' },
      {
        id: 'BC-planned',
        fromNodeId: 'B',
        toNodeId: 'C',
        points: [{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }],
      },
    ],
  };
  const model = {
    root,
    agvMapPlacement: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      map: { xAxis: 'x', yAxis: 'z', scale: 1, nodeRadius: 0.2 },
      routeHighlight: createDefaultAgvRouteHighlightConfig(),
      definition,
    },
  } as unknown as ModelRuntimeEntry;
  const driver = new AgvTelemetryDriver();
  const snapshot = createSnapshot({ x: 0, y: 0, task_begin_point: 'A', task_end_point: 'C' });
  driver.applyToModel(model, snapshot, 0);
  assert.deepEqual(driver.getTaskRoute(model)?.trackIds, ['AB', 'BC-planned']);
  const initialHighlight = scene.meshes.find(mesh => mesh.metadata?.agvTaskRouteHighlight)!;

  definition.tracks.push({ id: 'BC-alternative', fromNodeId: 'B', toNodeId: 'C' });
  root.position.set(10, 0, 0);
  driver.applyToModel(model, snapshot, 0);
  assert.deepEqual(driver.getTaskRoute(model)?.nodeIds, ['B', 'C']);
  assert.deepEqual(driver.getTaskRoute(model)?.trackIds, ['BC-planned'], '当前路线仍贯通时不得改选其它轨迹');
  assert.deepEqual(driver.getTaskRoute(model)?.points, [
    { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 },
  ]);
  assert.equal(initialHighlight.isDisposed(), false, '正常途经节点不得重建高亮');
  assert.equal(scene.meshes.find(mesh => mesh.metadata?.agvTaskRouteHighlight), initialHighlight);
  driver.resetMotionStates();
});

test('AGV 经过与当前线段重叠的其他节点时不重规划、不重建高亮', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const root = new TransformNode('agv-task-overlapping-node', scene);
  const model = {
    root,
    agvMapPlacement: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      map: { xAxis: 'x', yAxis: 'z', scale: 1, nodeRadius: 0.2 },
      routeHighlight: createDefaultAgvRouteHighlightConfig(),
      definition: {
        schemaVersion: 1 as const,
        id: 'overlapping-node-test',
        name: '重叠节点测试',
        nodes: [
          { id: 'A', name: 'A', x: 0, y: 0 },
          { id: 'B', name: 'B', x: 10, y: 0 },
          { id: 'C', name: 'C', x: 10, y: 10 },
          { id: 'D', name: 'D', x: 5, y: 0 },
        ],
        tracks: [
          { id: 'AB', fromNodeId: 'A', toNodeId: 'B' },
          { id: 'BC', fromNodeId: 'B', toNodeId: 'C' },
          {
            id: 'DC',
            fromNodeId: 'D',
            toNodeId: 'C',
            points: [{ x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
          },
        ],
      },
    },
  } as unknown as ModelRuntimeEntry;
  const driver = new AgvTelemetryDriver();
  const snapshot = createSnapshot({ x: 0, y: 0, task_begin_point: 'A', task_end_point: 'C' });
  driver.applyToModel(model, snapshot, 0);
  const initialRoute = driver.getTaskRoute(model);
  const initialHighlight = scene.meshes.find(mesh => mesh.metadata?.agvTaskRouteHighlight)!;
  assert.deepEqual(initialRoute?.trackIds, ['AB', 'BC']);

  root.position.set(5, 0, 0);
  driver.applyToModel(model, snapshot, 0);
  assert.equal(driver.getTaskRoute(model), initialRoute, '重叠节点不得替换仍然遵循的当前路线');
  assert.equal(initialHighlight.isDisposed(), false);
  assert.equal(scene.meshes.find(mesh => mesh.metadata?.agvTaskRouteHighlight), initialHighlight);
  driver.resetMotionStates();
});

test('AGV 触及不同节点后从该节点向原任务终点重规划，触及终点后释放路线', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const root = new TransformNode('agv-task-reroute', scene);
  const model = {
    root,
    agvMapPlacement: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      map: { xAxis: 'x', yAxis: 'z', scale: 1, nodeRadius: 1 },
      routeHighlight: createDefaultAgvRouteHighlightConfig(),
      definition: BUILT_IN_AGV_MAPS[0],
    },
  } as unknown as ModelRuntimeEntry;
  const driver = new AgvTelemetryDriver();
  const snapshot = createSnapshot({ x: 0, y: 0, task_begin_point: 'P01', task_end_point: 'P03' });
  driver.applyToModel(model, snapshot, 0);
  const initialRoute = driver.getTaskRoute(model);
  const initialHighlight = scene.meshes.find(mesh => mesh.metadata?.agvTaskRouteHighlight)!;
  assert.deepEqual(initialRoute?.nodeIds, ['P01', 'P02', 'P03']);

  root.position.set(11.5, 0, 0);
  driver.applyToModel(model, snapshot, 0);
  const intermediateRoute = driver.getTaskRoute(model);
  assert.deepEqual(intermediateRoute?.nodeIds, ['P02', 'P03'], '进入中间节点半径后应截断已行驶路线');
  assert.equal(initialHighlight.isDisposed(), false, '正常途经节点不得重建高亮');
  const intermediateHighlight = scene.meshes.find(mesh => mesh.metadata?.agvTaskRouteHighlight)!;
  assert.equal(intermediateHighlight, initialHighlight);
  driver.applyToModel(model, snapshot, 0);
  assert.equal(driver.getTaskRoute(model), intermediateRoute, '同一节点范围内不得重复规划');
  assert.equal(scene.meshes.find(mesh => mesh.metadata?.agvTaskRouteHighlight), intermediateHighlight);

  root.position.set(0.5, 0, 8);
  driver.applyToModel(model, snapshot, 0);
  assert.deepEqual(driver.getTaskRoute(model)?.nodeIds, ['P04', 'P03'], '偏航触及其它节点后应保留原终点并选择最短路线');
  assert.equal(intermediateHighlight.isDisposed(), true);
  assert.deepEqual(root.position.asArray(), [0.5, 0, 8], '重规划不得改变车辆真实位置');

  root.position.set(12, 0, 8);
  driver.applyToModel(model, snapshot, 0);
  assert.deepEqual(driver.getTaskRoute(model)?.nodeIds, ['P03']);
  assert.equal(driver.getTaskRoute(model)?.distance, 0);
  assert.equal(scene.meshes.some(mesh => mesh.metadata?.agvTaskRouteHighlight && !mesh.isDisposed()), false, '触及终点后不得保留高亮');
  driver.resetMotionStates();
});


test('AGV signalBits=1 按模板生成器刷货并跟随载货节点集合，缺失信号保持，0 销货', t => {
  const deckNodeNames = ['Box002.002', 'Box003.002', 'Box004.002', 'Box005.002', 'Box006.002'];
  const entity = createAgvEntity({
    device: { devType: 'agv', modelForwardAxis: 'x' },
    cargo: { nodes: deckNodeNames },
    fixedNodes: [],
  });
  entity.components.telemetryBinding!.cargoGeneratorId = 'generator-agv';
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('agv-cargo-runtime', scene);
  const contentRoot = new TransformNode('agv-cargo-content', scene);
  contentRoot.parent = root;
  deckNodeNames.forEach((name, index) => {
    const mesh = MeshBuilder.CreateBox(name, { size: 0.2 }, scene);
    mesh.parent = contentRoot;
    mesh.position.set((index - 2) * 0.1, 0.2, 0);
  });
  const model = {
    root,
    contentRoot,
    meshes: contentRoot.getChildMeshes(false),
    assetCode: 'AGV-01',
    assetHandle: {},
    stackerTelemetryReady: true,
    entitySnapshot: entity,
    telemetryBinding: entity.components.telemetryBinding,
    resolvedModelAsset: entity.components.modelAsset,
    externalScriptRuntime: null,
  } as unknown as ModelRuntimeEntry;
  const generator = { entityId: 'generator-agv' };
  const visualCalls: Array<{ kind: string; generator: unknown }> = [];
  const logs: string[] = [];
  const host = {
    collectModels: () => [{ entityId: entity.id, model }],
    pushLog: (message: string) => logs.push(message),
    updateExternalScriptContext: () => false,
    resolveCargoGeneratorForModel: () => generator,
    syncGeneratedCargoVisual: (_cargo: unknown, kind: string, _snapshot: unknown, resolved: unknown) => {
      visualCalls.push({ kind, generator: resolved });
    },
    setGeneratedCargoRootPose: (cargo: { root: TransformNode }, position: Vector3, rotation: import('@babylonjs/core').Quaternion) => {
      cargo.root.position.copyFrom(position);
      cargo.root.rotationQuaternion = rotation.clone();
    },
    disposeGeneratedCargo: (cargo: { root: TransformNode }) => cargo.root.dispose(),
  } as unknown as SpecializedTelemetryHost;
  const runtime = new SpecializedTelemetryRuntime(scene, host);
  t.after(() => {
    runtime.dispose();
    deviceTelemetryStore.clear();
    scene.dispose();
    engine.dispose();
  });

  const now = Date.now();
  deviceTelemetryStore.upsert(createSnapshot({
    x: 3, y: 5, r: 0, mode: 2, signalBits: 1, containerCode: 'CTN-005', task: 3005,
  }, now));
  runtime.applyFrame(0);
  const cargo = runtime.state.agvCargoMeshes.get('AGV-01');
  assert.ok(cargo, logs.join('\n'));
  assert.equal(cargo.containerCode, 'CTN-005');
  assert.equal(cargo.task, '3005');
  assert.ok(Vector3.Distance(cargo.root.position, new Vector3(3, 0.3, 5)) < 1e-6);
  assert.deepEqual(visualCalls, [{ kind: 'agv', generator }]);

  deviceTelemetryStore.upsert(createSnapshot({ x: 3, y: 5, r: 0, mode: 2 }, now + 1));
  runtime.applyFrame(0.016);
  assert.equal(runtime.state.agvCargoMeshes.get('AGV-01'), cargo);

  deviceTelemetryStore.upsert(createSnapshot({ x: 3, y: 5, r: 0, mode: 2, signalBits: 0 }, now + 2));
  runtime.applyFrame(0.016);
  assert.equal(runtime.state.agvCargoMeshes.size, 0);
  assert.equal(cargo.root.isDisposed(), true);
});


test('AGV command 驱动载货台及伴随结构升降，货物同步并在放货完成后清理', t => {
  const deckNodeNames = ['Box001', 'Box002'];
  const liftNodeNames = [...deckNodeNames, 'Box003', 'Cylinder005'];
  const entity = createAgvEntity({
    device: { devType: 'agv', modelForwardAxis: 'x' },
    cargo: { deckNodes: deckNodeNames, lift: { followNodes: liftNodeNames, distance: 0.1, speed: 0.2 } },
    fixedNodes: [],
  });
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('agv-lift-runtime', scene);
  const contentRoot = new TransformNode('agv-lift-content', scene);
  contentRoot.parent = root;
  const nodes = new Map<string, import('@babylonjs/core').Mesh>();
  for (const name of liftNodeNames) {
    const mesh = MeshBuilder.CreateBox(name, { size: 0.2 }, scene);
    mesh.parent = contentRoot;
    mesh.position.y = 0.2;
    nodes.set(name, mesh);
  }
  const model = {
    root,
    contentRoot,
    meshes: [...nodes.values()],
    assetCode: 'AGV-01',
    telemetryBinding: entity.components.telemetryBinding,
    resolvedModelAsset: entity.components.modelAsset,
    entitySnapshot: entity,
    externalScriptRuntime: null,
  } as unknown as ModelRuntimeEntry;
  const state = createSpecializedTelemetrySharedState();
  const host = {
    pushLog: () => undefined,
    resolveCargoGeneratorForModel: () => null,
    syncGeneratedCargoVisual: () => undefined,
    setGeneratedCargoRootPose: (cargo: { root: TransformNode }, position: Vector3, rotation: import('@babylonjs/core').Quaternion) => {
      cargo.root.position.copyFrom(position);
      cargo.root.rotationQuaternion = rotation.clone();
    },
    disposeGeneratedCargo: (cargo: { root: TransformNode }) => cargo.root.dispose(),
  } as unknown as SpecializedTelemetryHost;
  const driver = new AgvTelemetryDriver({ scene, state, host } as import('../../src/runtime/babylon/telemetry/specialized/types').SpecializedTelemetryDriverContext);
  t.after(() => {
    driver.resetMotionStates();
    scene.dispose();
    engine.dispose();
  });

  const apply = (command: number, deltaSeconds: number) => {
    driver.applyToModel(model, createSnapshot({
      x: 0, y: 0, r: 0, mode: 2, command, signalBits: 1, containerCode: 'CTN-005', task: 3005,
    }), deltaSeconds);
  };
  apply(1, 0);
  const cargo = state.agvCargoMeshes.get('AGV-01');
  assert.ok(cargo);
  assert.ok(Math.abs(cargo.root.position.y - 0.3) < 1e-6, '取货中保持低位');

  apply(3, 0.25);
  assert.ok(Math.abs(cargo.root.position.y - 0.35) < 1e-6, '取货完成抬升一半');
  assert.ok(Math.abs(nodes.get('Box003')!.position.y - 0.25) < 1e-6, '伴随结构同步抬升');
  assert.equal(driver.hasPendingMotion(model), true);

  apply(0, 0.25);
  assert.ok(Math.abs(cargo.root.position.y - 0.4) < 1e-6, '运输保持全抬升');
  assert.equal(driver.hasPendingMotion(model), false);

  apply(4, 0.25);
  assert.ok(Math.abs(cargo.root.position.y - 0.35) < 1e-6, '放货中下降一半');
  apply(6, 0.25);
  assert.equal(state.agvCargoMeshes.size, 0, '放货完成后即使光电仍有货也清货');
  assert.ok(Math.abs(nodes.get('Cylinder005')!.position.y - 0.2) < 1e-6, '放货完成结构回低位');

  apply(3, 0.5);
  assert.ok(Math.abs(nodes.get('Box003')!.position.y - 0.3) < 1e-6);
  driver.resetMotionStates();
  for (const name of liftNodeNames) {
    assert.ok(Math.abs(nodes.get(name)!.position.y - 0.2) < 1e-6, `${name} 应恢复编辑基线`);
  }
});
