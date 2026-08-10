import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createModelDeviceTypeOptions,
  getModelDeviceType,
  matchesModelDeviceType,
} from '../../src/editor/assets/modelLibraryDeviceTypeFilter.ts';

function createAsset(parameterScriptMetadata: unknown[]) {
  return { parameterScriptMetadata };
}

test('优先从 values.deviceType.value 提取模型类型', () => {
  const asset = createAsset([{
    values: { deviceType: { value: ' 输送 ' } },
    fields: [{ key: 'deviceType', defaultValue: '货物' }],
  }]);

  assert.equal(getModelDeviceType(asset), '输送');
});

test('values 缺失时从 deviceType 字段默认值提取模型类型', () => {
  const asset = createAsset([{
    fields: [{ key: 'deviceType', defaultValue: ' 多穿库 ' }],
  }]);

  assert.equal(getModelDeviceType(asset), '多穿库');
});

test('跳过非法和空白元数据并读取第一个有效类型', () => {
  const asset = createAsset([
    null,
    { values: { deviceType: { value: '   ' } } },
    { fields: [{ key: 'deviceType', defaultValue: 12 }] },
    { values: { deviceType: { value: '堆垛机' } } },
  ]);

  assert.equal(getModelDeviceType(asset), '堆垛机');
  assert.equal(getModelDeviceType({}), null);
});

test('类型选项去除空值、去重并按中文顺序排列', () => {
  const assets = [
    createAsset([{ values: { deviceType: { value: '输送' } } }]),
    createAsset([{ fields: [{ key: 'deviceType', defaultValue: '多穿库' }] }]),
    createAsset([{ values: { deviceType: { value: '输送' } } }]),
    createAsset([{ values: { deviceType: { value: '堆垛机' } } }]),
    createAsset([]),
  ];

  assert.deepEqual(createModelDeviceTypeOptions(assets), ['堆垛机', '多穿库', '输送']);
});

test('具体类型只匹配声明了相同 deviceType 的模型卡片', () => {
  const importedModel = {
    name: '辊道机',
    asset: {
      kind: 'model',
      parameterScriptMetadata: [{ values: { deviceType: { value: '输送' } } }],
    },
  };
  const unclassifiedModel = { name: '普通模型', asset: { kind: 'model' } };
  const builtInModel = { name: '立方体', builtIn: { kind: 'mesh', meshKind: 'cube' } };

  assert.equal(matchesModelDeviceType(importedModel, ''), true);
  assert.equal(matchesModelDeviceType(importedModel, '输送'), true);
  assert.equal(matchesModelDeviceType(importedModel, '多穿库'), false);
  assert.equal(matchesModelDeviceType(unclassifiedModel, '输送'), false);
  assert.equal(matchesModelDeviceType(builtInModel, '输送'), false);
});
