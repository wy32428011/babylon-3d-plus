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
import { AgvTelemetryDriver, resolveAgvYawRadians } from '../../src/runtime/babylon/telemetry/specialized/agvDriver';
import { isAgvRuntimeModel } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { SpecializedTelemetryRuntime } from '../../src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime';
import type { SpecializedTelemetryHost } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';
import { spawnedDeviceInspectorStore } from '../../src/runtime/mqtt/spawnedDeviceInspectorStore';
import { useEditorStore } from '../../src/editor/store/editorStore';

const DEGREES = Math.PI / 180;

function createSnapshot(fields: Record<string, unknown>, receivedAt = Date.now()): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'dt/factory/logistics/agv/AGV-01/twindatadriven/joint',
    deviceType: 'agv',
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

test('正方向轴将 r=0 的车头校准到场景 +X，顺时针 r 增加', () => {
  assert.ok(Math.abs(resolveAgvYawRadians(0, 'x') - 0) < 1e-12);
  assert.ok(Math.abs(resolveAgvYawRadians(0, '-x') - Math.PI) < 1e-12);
  assert.ok(Math.abs(resolveAgvYawRadians(0, 'z') + Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(resolveAgvYawRadians(0, '-z') - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(resolveAgvYawRadians(90, 'x') - 90 * DEGREES) < 1e-12);
});

test('AGV 驱动消费 x/y/r，保留地面高度并忽略 z、缺失字段、故障和离线帧', t => {
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

  driver.applyToModel(model, createSnapshot({ x: 12.5, y: -8, z: null, r: 90 }));
  assert.deepEqual(root.position.asArray(), [12.5, 0.4, -8]);
  assert.ok(Math.abs(root.rotation.y - 0) < 1e-12);
  assert.equal(root.rotation.x, 0.1);
  assert.equal(root.rotation.z, -0.1);

  driver.applyToModel(model, createSnapshot({ x: 20 }));
  assert.deepEqual(root.position.asArray(), [20, 0.4, -8]);
  assert.equal(root.rotation.y, 0);
  driver.applyToModel(model, { ...createSnapshot({ x: 30, y: 40, r: 180 }), faulted: true });
  driver.applyToModel(model, createSnapshot({ x: 30, y: 40, r: 180, mode: 0 }));
  assert.deepEqual(root.position.asArray(), [20, 0.4, -8]);
  assert.equal(root.rotation.y, 0);
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

  driver.applyToModel(model, createSnapshot({ x: 2, y: 4, mode: 2 }));
  assert.ok(root.position.equalsWithEpsilon(new Vector3(30, 1, 10)));

  driver.applyToModel(model, createSnapshot({ x: 3, mode: 2 }));
  assert.ok(root.position.equalsWithEpsilon(new Vector3(30, 1, 5)), `只更新 x 时必须保留地图 y 通道，实际 ${root.position.toString()}`);

  model.agvMapPlacement = {
    transform: {
      position: { x: 10, y: 0, z: 20 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    map: { xAxis: '-x', yAxis: '-z', scale: 1 },
  };
  driver.applyToModel(model, createSnapshot({ x: 2, y: 3, mode: 2 }));
  assert.deepEqual(root.position.asArray(), [8, 0, 17]);
});
