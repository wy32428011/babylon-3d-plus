import assert from 'node:assert/strict';
import test from 'node:test';
import type { Entity } from '../../src/editor/model/Entity';
import type { SceneDocument } from '../../src/editor/model/SceneDocument';
import {
  calculateModelArraySignedCopyCount,
  createModelArrayIdentity,
  getEntityArrayIdentifierError,
  getEntityArrayParameterError,
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

function createScene(...entities: Entity[]): SceneDocument {
  return {
    name: 'Model Array Test',
    entityIds: entities.map((entity) => entity.id),
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
    selectedEntityId: entities[0]?.id ?? null,
  } as unknown as SceneDocument;
}

test('模型名称与资产编号按源 assetCode 同步递增', () => {
  assert.deepEqual(createModelArrayIdentity('DEV9', 1, ''), {
    ok: true,
    name: 'DEV10',
    assetCode: 'DEV10',
  });
  assert.deepEqual(createModelArrayIdentity('DEV009', 1, ''), {
    ok: true,
    name: 'DEV010',
    assetCode: 'DEV010',
  });
  assert.deepEqual(createModelArrayIdentity('DEV', 2, ''), {
    ok: true,
    name: 'DEV2',
    assetCode: 'DEV2',
  });
  assert.deepEqual(createModelArrayIdentity('IGNORED', 1, '${1}-1-1'), {
    ok: true,
    name: '2-1-1',
    assetCode: '2-1-1',
  });
});

test('同步名称超过 80 字符时阻止生成', () => {
  const result = createModelArrayIdentity('X'.repeat(80), 1, '');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /80/);
});

test('尾数字或自定义规则递增超过安全整数时阻止生成', () => {
  const sourceOverflow = createModelArrayIdentity('DEV9007199254740991', 1, '');
  assert.equal(sourceOverflow.ok, false);
  if (!sourceOverflow.ok) assert.match(sourceOverflow.error, /安全整数/);

  const ruleOverflow = createModelArrayIdentity('DEV1', 1, '${9007199254740991}');
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

test('已有模型名称冲突时阻止阵列', () => {
  const source = createModelEntity('source', 'Source', 'DEV9');
  const conflictingName = createModelEntity('existing', 'DEV10', 'OTHER');
  assert.match(
    getEntityArrayIdentifierError(createScene(source, conflictingName), ['source'], 1, '') ?? '',
    /模型名称“DEV10”已存在/,
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

test('不同源编号生成的新副本互相冲突时阻止阵列', () => {
  const first = createModelEntity('first', 'First', 'DEV9');
  const second = createModelEntity('second', 'Second', 'DEV09');
  assert.match(
    getEntityArrayIdentifierError(createScene(first, second), ['first', 'second'], 1, '') ?? '',
    /模型名称“DEV10”已存在/,
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
