import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { migrateLegacySceneV1ToV2 } from '../../src/editor/project/sceneMigration';

type PlainObject = Record<string, unknown>;

function createGeneratorComponent(extraFields: PlainObject = {}): PlainObject {
  return {
    defaultTarget: null,
    rules: [],
    metadataTtlSeconds: 30,
    fetchBindings: [],
    dataSource: 'mqtt',
    ...extraFields,
  };
}

function createDeviceComponents(assetCode: string, deviceType: string, withBinding = true): PlainObject {
  if (!withBinding) {
    return {
      modelAsset: { assetCode, dataDrivenConfig: { device: { devType: deviceType } } },
    };
  }
  return {
    telemetryBinding: {
      enabled: true,
      sourceId: 'sim',
      deviceType,
      assetCode,
      expectedIntervalMs: 1000,
      staleAfterMs: 5000,
      channelOverrides: {},
    },
  };
}

function createEntity(id: string, components: PlainObject): PlainObject {
  return { id, name: id, isFolder: false, parentId: null, childrenIds: [], components };
}

function createLegacyScene(entities: Record<string, PlainObject>): PlainObject {
  return { id: 'scene_legacy', name: 'Legacy', entityIds: Object.keys(entities), entities };
}

function readBinding(scene: PlainObject, entityId: string): PlainObject {
  const entities = scene.entities as Record<string, PlainObject>;
  const entity = entities[entityId] as PlainObject;
  const components = entity.components as PlainObject;
  const binding = components.telemetryBinding as PlainObject | undefined;
  assert.ok(binding, `实体 ${entityId} 缺少 telemetryBinding`);
  return binding;
}

test('v1 场景迁移：生成器 bindings 反转为设备 cargoGeneratorId，warehouseFlow 转为 upstream 链', () => {
  const scene = createLegacyScene({
    entity_gen: createEntity('entity_gen', {
      modelGenerator: createGeneratorComponent({
        bindings: [
          { id: 'b_in', sourceId: 'sim', deviceType: 'conveyor', assetCode: '1004' },
          { id: 'b_stk', sourceId: 'sim', deviceType: 'stacker', assetCode: 'DDJ2' },
          { id: 'b_out', sourceId: 'sim', deviceType: 'conveyor', assetCode: '1005' },
        ],
        warehouseFlow: { enabled: true, inboundBindingId: 'b_in', stackerBindingId: 'b_stk', outboundBindingId: 'b_out' },
      }),
    }),
    entity_inbound: createEntity('entity_inbound', createDeviceComponents('1004', 'conveyor')),
    entity_stacker: createEntity('entity_stacker', createDeviceComponents('DDJ2', 'stacker')),
    entity_outbound: createEntity('entity_outbound', createDeviceComponents('1005', 'conveyor')),
  });

  const summary = migrateLegacySceneV1ToV2(scene);
  assert.equal(summary.migratedCargoGenerators, 3);
  assert.equal(summary.migratedUpstreams, 2);
  assert.deepEqual(summary.warnings, []);

  const entities = scene.entities as Record<string, PlainObject>;
  const generator = (entities.entity_gen as PlainObject).components as PlainObject;
  const generatorComponent = generator.modelGenerator as PlainObject;
  assert.equal('bindings' in generatorComponent, false);
  assert.equal('warehouseFlow' in generatorComponent, false);

  const inbound = readBinding(scene, 'entity_inbound');
  const stacker = readBinding(scene, 'entity_stacker');
  const outbound = readBinding(scene, 'entity_outbound');
  assert.equal(inbound.cargoGeneratorId, 'entity_gen');
  assert.equal(stacker.cargoGeneratorId, 'entity_gen');
  assert.equal(outbound.cargoGeneratorId, 'entity_gen');
  assert.equal(inbound.upstreamAssetCode, undefined);
  assert.equal(stacker.upstreamAssetCode, '1004');
  assert.equal(outbound.upstreamAssetCode, 'DDJ2');
});

test('v1 场景迁移：匹配到多台或零台设备的旧绑定被跳过并记录警告，其余绑定照常迁移', () => {
  const scene = createLegacyScene({
    entity_gen: createEntity('entity_gen', {
      modelGenerator: createGeneratorComponent({
        bindings: [
          { id: 'b_ok', sourceId: 'sim', deviceType: 'conveyor', assetCode: '1004' },
          { id: 'b_missing', sourceId: 'sim', deviceType: 'conveyor', assetCode: 'MISSING' },
          { id: 'b_dup', sourceId: 'sim', deviceType: 'conveyor', assetCode: 'DUP' },
        ],
      }),
    }),
    entity_inbound: createEntity('entity_inbound', createDeviceComponents('1004', 'conveyor')),
    entity_dup_a: createEntity('entity_dup_a', createDeviceComponents('DUP', 'conveyor')),
    entity_dup_b: createEntity('entity_dup_b', createDeviceComponents('DUP', 'conveyor')),
  });

  const summary = migrateLegacySceneV1ToV2(scene);
  assert.equal(summary.migratedCargoGenerators, 1);
  assert.equal(summary.warnings.length, 2);
  assert.equal(readBinding(scene, 'entity_inbound').cargoGeneratorId, 'entity_gen');
  assert.equal(readBinding(scene, 'entity_dup_a').cargoGeneratorId, undefined);
  assert.equal(readBinding(scene, 'entity_dup_b').cargoGeneratorId, undefined);
});

test('v1 场景迁移：设备缺少 telemetryBinding 时按旧绑定合成最小结构', () => {
  const scene = createLegacyScene({
    entity_gen: createEntity('entity_gen', {
      modelGenerator: createGeneratorComponent({
        bindings: [{ id: 'b1', sourceId: 'sim', deviceType: 'conveyor', assetCode: '1004' }],
      }),
    }),
    entity_device: createEntity('entity_device', createDeviceComponents('1004', 'conveyor', false)),
  });

  const summary = migrateLegacySceneV1ToV2(scene);
  assert.equal(summary.migratedCargoGenerators, 1);
  const binding = readBinding(scene, 'entity_device');
  assert.equal(binding.cargoGeneratorId, 'entity_gen');
  assert.equal(binding.assetCode, '1004');
  assert.equal(binding.deviceType, 'conveyor');
});

test('v1 场景迁移：warehouseFlow 未启用时只反转绑定，不写入 upstream', () => {
  const scene = createLegacyScene({
    entity_gen: createEntity('entity_gen', {
      modelGenerator: createGeneratorComponent({
        bindings: [{ id: 'b1', sourceId: 'sim', deviceType: 'conveyor', assetCode: '1004' }],
        warehouseFlow: { enabled: false, inboundBindingId: '', stackerBindingId: '', outboundBindingId: '' },
      }),
    }),
    entity_inbound: createEntity('entity_inbound', createDeviceComponents('1004', 'conveyor')),
  });

  const summary = migrateLegacySceneV1ToV2(scene);
  assert.equal(summary.migratedCargoGenerators, 1);
  assert.equal(summary.migratedUpstreams, 0);
  const binding = readBinding(scene, 'entity_inbound');
  assert.equal(binding.cargoGeneratorId, 'entity_gen');
  assert.equal(binding.upstreamAssetCode, undefined);
});

test('SceneSerializer 接受 v1/v2 并在 v1 上执行迁移，序列化始终写出 version 2', () => {
  const source = readFileSync('src/editor/project/SceneSerializer.ts', 'utf8');
  assert.match(source, /JSON\.stringify\(\{ version: 2,/);
  assert.match(source, /document\.version !== 1 && document\.version !== 2/);
  assert.match(source, /migrateLegacySceneV1ToV2\(rawScene\)/);
});
