import assert from 'node:assert/strict';
import test from 'node:test';
import type { Entity } from '../../src/editor/model/Entity';
import type { SceneDocument } from '../../src/editor/model/SceneDocument';
import {
  calculateModelArraySignedCopyCount,
  createEntityArrayName,
  createModelArrayIdentity,
  getEntityArrayIdentifierError,
  getEntityArrayParameterError,
  getShiftEntityArrayIdentityBehavior,
  getShiftEntityArrayKind,
  isShiftEntityArraySupported,
  normalizeModelArrayDirection,
} from '../../src/editor/model/modelArray';

function createModelEntity(id: string, name: string, assetCode: string): Entity {
  return {
    id,
    name,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      modelAsset: {
        assetCode,
        sourcePath: 'fixture.glb',
        sourceUrl: 'fixture.glb',
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
      },
    },
  };
}

function createBaseEntity(id: string, name = id): Entity {
  return {
    id,
    name,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    },
  };
}

function createLocatorEntity(id: string, name: string, assetId: string): Entity {
  const entity = createBaseEntity(id, name);
  entity.components.locator = {
    assetId,
    storageDepth: 'near',
    length: 1,
    width: 1,
    height: 1,
    columns: 1,
    layers: 1,
    startColumn: 1,
    columnGap: 0,
    layerGap: 0,
    deviceAssetCode: '',
    rowNumber: 1,
  };
  return entity;
}

function createScene(...entities: Entity[]): SceneDocument {
  return {
    name: 'Model Array Test',
    entityIds: entities.map((entity) => entity.id),
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
    selectedEntityId: entities[0]?.id ?? null,
  } as unknown as SceneDocument;
}

test('阵列名称按源名称末尾数字递增且不添加“副本”', () => {
  assert.deepEqual(createEntityArrayName('测试 1001', 1), { ok: true, name: '测试 1002' });
  assert.deepEqual(createEntityArrayName('测试 1001', 3), { ok: true, name: '测试 1004' });
  assert.deepEqual(createEntityArrayName('DEV009', 1), { ok: true, name: 'DEV010' });
  assert.deepEqual(createEntityArrayName('测试', 2), { ok: true, name: '测试2' });
});

test('导入模型名称按源名称递增，资产编号按自身编号或规则递增', () => {
  assert.deepEqual(createModelArrayIdentity('测试 1001', 'DEV9', 1, ''), {
    ok: true,
    name: '测试 1002',
    assetCode: 'DEV10',
  });
  assert.deepEqual(createModelArrayIdentity('测试 1001', 'DEV009', 2, ''), {
    ok: true,
    name: '测试 1003',
    assetCode: 'DEV011',
  });
  assert.deepEqual(createModelArrayIdentity('测试', 'IGNORED', 1, '${1}-1-1'), {
    ok: true,
    name: '测试1',
    assetCode: '2-1-1',
  });
});

test('生成名称超过 80 字符时阻止阵列', () => {
  const result = createEntityArrayName('X'.repeat(80), 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /80/);
});

test('名称、资产编号或自定义规则递增超过安全整数时阻止生成', () => {
  const nameOverflow = createEntityArrayName('测试 9007199254740991', 1);
  assert.equal(nameOverflow.ok, false);
  if (!nameOverflow.ok) assert.match(nameOverflow.error, /安全整数/);

  const assetOverflow = createModelArrayIdentity('测试 1', 'DEV9007199254740991', 1, '');
  assert.equal(assetOverflow.ok, false);
  if (!assetOverflow.ok) assert.match(assetOverflow.error, /安全整数/);

  const ruleOverflow = createModelArrayIdentity('测试 1', 'DEV1', 1, '${9007199254740991}');
  assert.equal(ruleOverflow.ok, false);
  if (!ruleOverflow.ok) assert.match(ruleOverflow.error, /安全整数/);
});

test('阵列数量和净间距必须满足共享提交边界', () => {
  assert.match(getEntityArrayParameterError(0, 0) ?? '', /1-100/);
  assert.match(getEntityArrayParameterError(101, 0) ?? '', /1-100/);
  assert.match(getEntityArrayParameterError(1.5, 0) ?? '', /整数/);
  assert.match(getEntityArrayParameterError(1, -0.1) ?? '', /大于等于 0/);
  assert.match(getEntityArrayParameterError(1, Number.NaN) ?? '', /有限数值/);
  assert.equal(getEntityArrayParameterError(100, 0), null);
});

test('拖动距离按半跨度阈值、正负方向和上限换算副本数量', () => {
  assert.equal(calculateModelArraySignedCopyCount(0.49, 1), 0);
  assert.equal(calculateModelArraySignedCopyCount(0.5, 1), 1);
  assert.equal(calculateModelArraySignedCopyCount(1.6, 1), 2);
  assert.equal(calculateModelArraySignedCopyCount(-0.5, 1), -1);
  assert.equal(calculateModelArraySignedCopyCount(-2.6, 1), -3);
  assert.equal(calculateModelArraySignedCopyCount(500, 1), 100);
  assert.equal(calculateModelArraySignedCopyCount(1, 0), 0);
});

test('世界方向归一化拒绝零向量和非法值', () => {
  assert.deepEqual(normalizeModelArrayDirection({ x: 3, y: 0, z: 4 }), { x: 0.6, y: 0, z: 0.8 });
  assert.equal(normalizeModelArrayDirection({ x: 0, y: 0, z: 0 }), null);
  assert.equal(normalizeModelArrayDirection({ x: Number.NaN, y: 0, z: 1 }), null);
});

test('已有递增对象名称冲突时阻止阵列', () => {
  const source = createModelEntity('source', '测试 1001', 'DEV9');
  const conflictingName = createModelEntity('existing', '测试 1002', 'OTHER');
  assert.match(
    getEntityArrayIdentifierError(createScene(source, conflictingName), ['source'], 1, '') ?? '',
    /对象名称“测试 1002”已存在/,
  );
});

test('已有资产编号冲突时阻止阵列', () => {
  const source = createModelEntity('source', 'Source', 'DEV9');
  const conflictingCode = createModelEntity('existing', 'Other', 'DEV10');
  assert.match(
    getEntityArrayIdentifierError(createScene(source, conflictingCode), ['source'], 1, '') ?? '',
    /资产编号“DEV10”已存在/,
  );
});

test('不同源资产编号生成的新副本互相冲突时阻止阵列', () => {
  const first = createModelEntity('first', 'First', 'DEV9');
  const second = createModelEntity('second', 'Second', 'DEV09');
  assert.match(
    getEntityArrayIdentifierError(createScene(first, second), ['first', 'second'], 1, '') ?? '',
    /资产编号“DEV10”已存在/,
  );
});

test('多个源模型生成结果互相占用时阻止阵列', () => {
  const first = createModelEntity('first', 'First', 'DEV1');
  const second = createModelEntity('second', 'Second', 'DEV2');
  assert.match(
    getEntityArrayIdentifierError(createScene(first, second), ['first', 'second'], 1, '') ?? '',
    /资产编号“DEV2”已存在/,
  );
});

test('无名称和资产编号冲突时允许阵列', () => {
  const source = createModelEntity('source', 'Source', 'DEV9');
  assert.equal(getEntityArrayIdentifierError(createScene(source), ['source'], 3, ''), null);
});


test('Shift 阵列支持导入模型、内置 Mesh、定位线框、CAD 和 POI', () => {
  const model = createModelEntity('model', 'Model', 'DEV1');
  const mesh = createBaseEntity('mesh');
  mesh.components.meshRenderer = { meshKind: 'cube', materialColor: '#ffffff' };
  const locator = createLocatorEntity('locator', 'Locator', 'LOC1');
  const cad = createBaseEntity('cad');
  cad.components.cadReference = {} as Entity['components']['cadReference'];
  const poi = createBaseEntity('poi');
  poi.components.poiEffect = {} as Entity['components']['poiEffect'];

  assert.equal(getShiftEntityArrayKind(model), 'model');
  assert.equal(getShiftEntityArrayKind(mesh), 'mesh');
  assert.equal(getShiftEntityArrayKind(locator), 'locator');
  assert.equal(getShiftEntityArrayKind(cad), 'cad-reference');
  assert.equal(getShiftEntityArrayKind(poi), 'poi');
  assert.ok([model, mesh, locator, cad, poi].every(isShiftEntityArraySupported));
});

test('Shift 阵列排除文件夹、灯光、模型生成器和无运行时模型组件实体', () => {
  const folder = { ...createBaseEntity('folder'), isFolder: true };
  const light = createBaseEntity('light');
  light.components.light = { lightKind: 'point', intensity: 1 };
  const generator = createBaseEntity('generator');
  generator.components.modelGenerator = {} as Entity['components']['modelGenerator'];
  const transformOnly = createBaseEntity('transform-only');

  assert.equal(getShiftEntityArrayKind(folder), null);
  assert.equal(getShiftEntityArrayKind(light), null);
  assert.equal(getShiftEntityArrayKind(generator), null);
  assert.equal(getShiftEntityArrayKind(transformOnly), null);
  assert.ok([folder, light, generator, transformOnly].every((entity) => !isShiftEntityArraySupported(entity)));
});

test('Shift 阵列按实体类型启用资产编号规则或仅名称行为', () => {
  const model = createModelEntity('model', 'Model', 'DEV1');
  const locator = createLocatorEntity('locator', 'Locator', 'LOC1');
  const mesh = createBaseEntity('mesh');
  mesh.components.meshRenderer = { meshKind: 'cube', materialColor: '#ffffff' };

  assert.equal(getShiftEntityArrayIdentityBehavior(model), 'asset-number');
  assert.equal(getShiftEntityArrayIdentityBehavior(locator), 'asset-number');
  assert.equal(getShiftEntityArrayIdentityBehavior(mesh), 'name-only');
  assert.equal(getShiftEntityArrayIdentityBehavior(createBaseEntity('invalid')), null);
});

test('定位线框名称和资产编号分别按各自源值递增', () => {
  const source = createLocatorEntity('source', 'Locator', 'LOC9');
  assert.equal(getEntityArrayIdentifierError(createScene(source), ['source'], 2, ''), null);

  const conflict = createLocatorEntity('conflict', 'Other Locator', 'LOC10');
  assert.match(
    getEntityArrayIdentifierError(createScene(source, conflict), ['source'], 1, '') ?? '',
    /资产编号“LOC10”已存在/,
  );
});

test('无资产编号实体禁用自定义编号规则但允许默认空间阵列', () => {
  const mesh = createBaseEntity('mesh', 'Cube');
  mesh.components.meshRenderer = { meshKind: 'cube', materialColor: '#ffffff' };

  assert.equal(getEntityArrayIdentifierError(createScene(mesh), ['mesh'], 2, ''), null);
  assert.match(
    getEntityArrayIdentifierError(createScene(mesh), ['mesh'], 2, '${1}') ?? '',
    /仅支持一个带资产编号的源对象/,
  );
});
