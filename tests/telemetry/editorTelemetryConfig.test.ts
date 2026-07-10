import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createModelEntity, sanitizeMqttConfig } from '../../src/editor/model/SceneDocument';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';
import {
  createDefaultTelemetryBinding,
  normalizeModelDataDrivenConfig,
  normalizeTelemetryBindingComponent,
} from '../../src/editor/model/telemetryBinding';
import { isMqttConfigEqual, reindexRecordAfterRemoval, validateRuntimePreviewConfig } from '../../src/editor/model/mqttConfigUtils';

test('旧 MQTT 逗号 Topic 迁移为 EPV subscriptions 并维护 legacy topic', () => {
  const config = sanitizeMqttConfig({
    enabled: true,
    ip: '192.168.1.10',
    address: 'ws://192.168.1.10:8083/mqtt',
    topic: 'dt/a/+/joint, dt/b/+/joint',
    simulatorEnabled: false,
    simulatorAssetCode: 'DDJ2',
    simulatorScenario: 'cycle',
    simulatorIntervalMs: 500,
  });

  assert.equal(config.topic, 'dt/a/+/joint,dt/b/+/joint');
  assert.deepEqual(config.subscriptions.map((item) => item.topic), ['dt/a/+/joint', 'dt/b/+/joint']);
  assert.deepEqual(config.subscriptions.map((item) => item.adapter.kind), ['epv', 'epv']);
});

test('非法订阅会被过滤，JSON Path 字段必须是安全路径', () => {
  const config = sanitizeMqttConfig({
    ...createBaseMqttConfig(),
    subscriptions: [
      { topic: '', qos: 2, adapter: { kind: 'epv' } },
      {
        topic: 'valid/topic',
        qos: 1,
        adapter: {
          kind: 'json-path',
          sourceId: 'line-a',
          deviceTypePath: 'device.type',
          assetCodePath: 'device.asset',
          timestampPath: 'meta.ts',
          sequencePath: 'meta.seq',
          fields: { speed: 'state.axes[0].speed', unsafe: '../bad' },
        },
      },
    ],
  });

  assert.equal(config.subscriptions.length, 1);
  assert.equal(config.subscriptions[0].qos, 1);
  assert.deepEqual(config.subscriptions[0].adapter, {
    kind: 'json-path',
    sourceId: 'line-a',
    deviceTypePath: 'device.type',
    assetCodePath: 'device.asset',
    timestampPath: 'meta.ts',
    sequencePath: 'meta.seq',
    fields: { speed: 'state.axes[0].speed' },
  });
});

test('dataDriven 配置归一化并拒绝非法深度和非有限数值', () => {
  const config = normalizeModelDataDrivenConfig({
    device: { devType: 'stacker', defaultAssetCode: 'DDJ2', interpolationMs: 1e999 },
    motion: {
      lift: {
        channel: 'lift',
        fields: ['height', 123, 'speed'],
        mode: 'velocity',
        target: { kind: 'node', selector: 'Lift' },
        property: 'position',
        axis: 'y',
        scale: 2,
        offset: 1,
        min: 0,
        max: 30,
        smoothing: { kind: 'ema', alpha: 0.4 },
      },
      bad: { channel: 'bad', fields: ['bad'], mode: 'absolute', target: { kind: 'root' }, property: 'position', axis: 'x', scale: Number.POSITIVE_INFINITY },
    },
    fixedNodes: ['Base', 7],
  });

  assert.equal(config?.device.devType, 'stacker');
  assert.equal(config?.device.defaultAssetCode, 'DDJ2');
  assert.equal(config?.device.interpolationMs, 200);
  assert.deepEqual(config?.motion.lift.fields, ['height', 'speed']);
  assert.equal(config?.motion.lift.smoothing?.kind, 'ema');
  assert.equal(config?.motion.bad.scale, 1);
  assert.deepEqual(config?.fixedNodes, ['Base']);
  assert.equal(normalizeModelDataDrivenConfig(createDeepObject()), null);
});

test('遥测绑定 stale 默认值来自 expectedIntervalMs 的安全倍数', () => {
  const binding = normalizeTelemetryBindingComponent({ enabled: true, sourceId: 'plc', deviceType: 'stacker', expectedIntervalMs: 300 });

  assert.deepEqual(binding, {
    enabled: true,
    sourceId: 'plc',
    deviceType: 'stacker',
    expectedIntervalMs: 300,
    staleAfterMs: 2000,
    channelOverrides: {},
  });
});

test('模型实体根据 dataDriven devType 创建默认 telemetryBinding 且 assetCode 不重复保存', () => {
  const entity = createModelEntity(
    'model.glb',
    'editor-asset://local/model.glb',
    '模型',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'DDJ2',
    undefined,
    { device: { devType: 'stacker', defaultAssetCode: 'DDJ2' } },
  );

  assert.match(entity.components.modelAsset?.assetCode ?? '', /^DDJ2-/);
  assert.equal(entity.components.modelAsset?.dataDrivenConfig?.device.devType, 'stacker');
  assert.deepEqual(entity.components.telemetryBinding, createDefaultTelemetryBinding('stacker'));
});

test('SceneSerializer roundtrip 保存新字段并兼容旧场景缺省字段', () => {
  const entity = createModelEntity(
    'model.glb',
    'editor-asset://local/model.glb',
    '模型',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'MODEL',
    undefined,
    { device: { devType: 'stacker', defaultAssetCode: 'MODEL' }, motion: { x: { channel: 'x', fields: ['x'], mode: 'absolute', target: { kind: 'root' }, property: 'position', axis: 'x' } } },
  );
  const scene = {
    id: 'scene_1',
    name: '测试场景',
    entityIds: [entity.id],
    entities: { [entity.id]: entity },
    selectedEntityId: entity.id,
    mqttConfig: sanitizeMqttConfig({ ...createBaseMqttConfig(), subscriptions: [{ topic: 'valid/topic', qos: 0, adapter: { kind: 'epv' } }] }),
    sceneSettings: undefined,
  };

  const loaded = deserializeScene(serializeScene(scene as never));

  assert.equal(loaded.entities[entity.id].components.modelAsset?.dataDrivenConfig?.device.devType, 'stacker');
  assert.equal(loaded.entities[entity.id].components.telemetryBinding?.deviceType, 'stacker');
  assert.equal(loaded.mqttConfig.subscriptions[0].topic, 'valid/topic');

  const legacyLoaded = deserializeScene(JSON.stringify({ version: 1, scene: { ...scene, mqttConfig: undefined, sceneSettings: undefined } }));
  assert.ok(legacyLoaded.mqttConfig.subscriptions.length > 0);
  assert.equal(legacyLoaded.entities[entity.id].components.telemetryBinding?.deviceType, 'stacker');
});

function createBaseMqttConfig() {
  return {
    enabled: false,
    ip: '',
    address: '',
    topic: 'legacy/topic',
    simulatorEnabled: false,
    simulatorAssetCode: 'DDJ2',
    simulatorScenario: 'cycle' as const,
    simulatorIntervalMs: 500,
  };
}

function createDeepObject(): unknown {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 12; index += 1) value = { child: value };
  return value;
}

test('通用 MQTT 无 Broker 示例可被正式场景序列化器加载且映射匹配模拟器状态', () => {
  const scene = deserializeScene(readFileSync('examples/scenes/generic-mqtt-motion-demo.scene.json', 'utf8'));

  assert.equal(scene.mqttConfig.simulatorScenario, 'generic');
  assert.equal(scene.mqttConfig.simulatorAssetCode, 'GEN-A,GEN-B');
  const gltf = JSON.parse(readFileSync('examples/model-packages/GenericMqttMotionDemo/GenericMqttMotionDemo.gltf', 'utf8')) as {
    nodes: Array<{ name?: string }>;
    animations: Array<{ name?: string; channels: Array<{ target: { node: number } }> }>;
  };
  const doorPulse = gltf.animations.find((animation) => animation.name === 'DoorPulse');
  assert.ok(doorPulse);
  assert.equal(gltf.nodes[doorPulse.channels[0].target.node]?.name, 'ScreenSurface');
  for (const entityId of ['entity_generic_mqtt_gen_a', 'entity_generic_mqtt_gen_b']) {
    const entity = scene.entities[entityId];
    assert.ok(entity.components.modelAsset?.dataDrivenConfig);
    assert.equal(entity.components.telemetryBinding?.deviceType, 'generic-machine');
    const actionMap = entity.components.modelAsset.dataDrivenConfig.motion.operation_state.actionMap;
    assert.equal(actionMap?.forward, 'play');
    assert.equal(actionMap?.reverse, 'reverse');
    assert.equal(actionMap?.fault, 'play');
    assert.equal(actionMap?.recovery, 'play');
  }
});

test('legacy stacker/yzj dataDriven 形状归一到通用通道且保留动作语义', () => {
  const config = normalizeModelDataDrivenConfig({
    device: { device: 'DDJ', devType: 'stacker', defaultAssetCode: 'DDJ2', interpolationMs: 120 },
    motion: {
      travel: {
        kind: 'translate',
        fields: ['x'],
        nodes: ['Bridge', 'Trolley'],
        fallbackPattern: '^Bridge',
        property: 'position',
        axis: 'x',
        speed: 0.5,
        limits: { min: -12, max: 18 },
      },
      direction: {
        kind: 'rotate',
        field: 'direction',
        valueMode: 'action',
        nodes: ['Wheel'],
        axis: 'y',
        actionMap: { '-1': -1, '0': 0, '1': 1, stop: 'idle' },
      },
      yzjClamp: {
        kind: 'translate',
        field: 'clamp',
        nodes: ['ClampLeft', 'ClampRight'],
        fallbackPattern: 'Clamp.*',
        speed: 2,
        limits: { min: 0, max: 1 },
      },
    },
  });

  assert.equal(config?.motion.travel.legacyKind, 'translate');
  assert.deepEqual(config?.motion.travel.target.selectors, ['Bridge', 'Trolley']);
  assert.equal(config?.motion.travel.target.fallbackPattern, '^Bridge');
  assert.equal(config?.motion.travel.speed, 0.5);
  assert.equal(config?.motion.travel.scale, 0.5);
  assert.equal(config?.motion.travel.min, -12);
  assert.equal(config?.motion.travel.max, 18);
  assert.equal(config?.motion.direction.legacyKind, 'rotate');
  assert.equal(config?.motion.direction.valueMode, 'action');
  assert.deepEqual(config?.motion.direction.fields, ['direction']);
  assert.deepEqual(config?.motion.direction.actionMap, { '-1': -1, '0': 0, '1': 1, stop: 'idle' });
  assert.equal(config?.motion.yzjClamp.target.fallbackPattern, 'Clamp.*');
});

test('默认遥测绑定不复制实例资产编号，运行时应从 modelAsset.assetCode 取缺省值', () => {
  const entity = createModelEntity(
    'model.glb',
    'editor-asset://local/model.glb',
    '模型',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'DDJ2',
    undefined,
    { device: { devType: 'stacker', defaultAssetCode: 'DDJ2' } },
  );

  assert.match(entity.components.modelAsset?.assetCode ?? '', /^DDJ2-/);
  assert.equal(entity.components.telemetryBinding?.assetCode, undefined);
  assert.deepEqual(entity.components.telemetryBinding, createDefaultTelemetryBinding('stacker'));
});

test('SceneSerializer 遇到非数组 subscriptions 时回退 legacy topic 迁移', () => {
  const entity = createModelEntity('model.glb', 'editor-asset://local/model.glb', '模型');
  const scene = {
    id: 'scene_legacy_subscriptions',
    name: '旧订阅场景',
    entityIds: [entity.id],
    entities: { [entity.id]: entity },
    selectedEntityId: null,
    mqttConfig: { ...createBaseMqttConfig(), topic: 'legacy/a,legacy/b', subscriptions: { bad: true } },
  };

  const loaded = deserializeScene(JSON.stringify({ version: 1, scene }));

  assert.deepEqual(loaded.mqttConfig.subscriptions.map((item) => item.topic), ['legacy/a', 'legacy/b']);
});


test('MQTT 配置比较必须深比较 subscriptions 的 qos adapter fields', () => {
  const base = sanitizeMqttConfig({
    ...createBaseMqttConfig(),
    subscriptions: [{ topic: 'same/topic', qos: 0, adapter: { kind: 'json-path', fields: { speed: 'a.speed' } } }],
  });
  const qosChanged = sanitizeMqttConfig({
    ...createBaseMqttConfig(),
    subscriptions: [{ topic: 'same/topic', qos: 1, adapter: { kind: 'json-path', fields: { speed: 'a.speed' } } }],
  });
  const fieldsChanged = sanitizeMqttConfig({
    ...createBaseMqttConfig(),
    subscriptions: [{ topic: 'same/topic', qos: 0, adapter: { kind: 'json-path', fields: { speed: 'b.speed' } } }],
  });

  assert.equal(isMqttConfigEqual(base, base), true);
  assert.equal(isMqttConfigEqual(base, qosChanged), false);
  assert.equal(isMqttConfigEqual(base, fieldsChanged), false);
});

test('删除订阅时 draft/error 索引重建且删除项错误不再阻塞保存', () => {
  assert.deepEqual(reindexRecordAfterRemoval({ 0: '{}', 1: 'bad', 2: '{"ok":true}' }, 1), {
    0: '{}',
    1: '{"ok":true}',
  });
  assert.deepEqual(reindexRecordAfterRemoval({ 0: '', 1: 'fields JSON 格式不完整或不合法。', 2: '' }, 1), {
    0: '',
    1: '',
  });
});

test('运行预检按模拟器、浏览器协议与 Electron MQTT 协议校验配置', () => {
  const disabled = validateRuntimePreviewConfig(sanitizeMqttConfig(createBaseMqttConfig()), { electronMqttAvailable: false });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, 'mqtt-disabled');
  assert.match(disabled.message, /未启用/);

  const simulator = validateRuntimePreviewConfig(
    sanitizeMqttConfig({ ...createBaseMqttConfig(), enabled: true, simulatorEnabled: true, address: '', subscriptions: [] }),
    { electronMqttAvailable: false },
  );
  assert.equal(simulator.ok, true);
  assert.equal(simulator.source, 'simulator');

  const browserMqtt = validateRuntimePreviewConfig(
    sanitizeMqttConfig({ ...createBaseMqttConfig(), enabled: true, address: 'mqtt://127.0.0.1:1883', subscriptions: [{ topic: 'valid/topic', qos: 0, adapter: { kind: 'epv' } }] }),
    { electronMqttAvailable: false },
  );
  assert.equal(browserMqtt.ok, false);
  assert.equal(browserMqtt.code, 'unsupported-browser-protocol');
  assert.match(browserMqtt.message, /ws\/wss/);

  const electronMqtt = validateRuntimePreviewConfig(
    sanitizeMqttConfig({ ...createBaseMqttConfig(), enabled: true, address: 'mqtt://127.0.0.1:1883', subscriptions: [{ topic: 'valid/topic', qos: 0, adapter: { kind: 'epv' } }] }),
    { electronMqttAvailable: true },
  );
  assert.equal(electronMqtt.ok, true);
  assert.equal(electronMqtt.source, 'mqtt');

  const electronInvalidProtocol = validateRuntimePreviewConfig(
    sanitizeMqttConfig({ ...createBaseMqttConfig(), enabled: true, address: 'http://127.0.0.1/mqtt', subscriptions: [{ topic: 'valid/topic', qos: 0, adapter: { kind: 'epv' } }] }),
    { electronMqttAvailable: true },
  );
  assert.equal(electronInvalidProtocol.ok, false);
  assert.equal(electronInvalidProtocol.code, 'unsupported-electron-protocol');

  const missingAddress = validateRuntimePreviewConfig(
    sanitizeMqttConfig({ ...createBaseMqttConfig(), enabled: true, address: '', subscriptions: [{ topic: 'valid/topic', qos: 0, adapter: { kind: 'epv' } }] }),
    { electronMqttAvailable: false },
  );
  assert.equal(missingAddress.ok, false);
  assert.equal(missingAddress.code, 'missing-address');

  const missingSubscription = validateRuntimePreviewConfig(
    {
      ...sanitizeMqttConfig({ ...createBaseMqttConfig(), enabled: true, address: 'ws://127.0.0.1:8083/mqtt' }),
      topic: '',
      subscriptions: [],
    },
    { electronMqttAvailable: false },
  );
  assert.equal(missingSubscription.ok, false);
  assert.equal(missingSubscription.code, 'missing-subscription');
});
