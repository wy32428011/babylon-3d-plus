import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
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
import { isAgvRuntimeModel } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { SpecializedTelemetryRuntime } from '../../src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime';
import type { SpecializedTelemetryHost } from '../../src/runtime/babylon/telemetry/specialized/types';
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
  assert.equal(normalizeTelemetryBindingComponent({
    deviceType: 'agv', modelForwardAxis: 'y',
  })?.modelForwardAxis, undefined);
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

  const sameTask = createSnapshot({ x: 1, y: 2, task_begin_point: '取货站', task_end_point: '质检站' });
  driver.applyToModel(model, sameTask, 1 / 60);
  assert.equal(driver.getTaskRoute(model), route, '相同任务应复用路线缓存');
  driver.applyToModel(model, createSnapshot({ x: 1, y: 2, task_begin_point: 220, task_end_point: 72 }), 1 / 60);
  assert.equal(driver.getTaskRoute(model), null, '不存在的站点名称必须返回无路线');
  driver.applyToModel(model, createSnapshot({ x: 1, y: 2, task_begin_point: '充电站', task_end_point: '取货站' }), 1 / 60);
  assert.equal(driver.getTaskRoute(model), null, '站点存在但轨迹方向不贯通时必须返回无路线');
});
