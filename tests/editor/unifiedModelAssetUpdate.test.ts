import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';
const [{ mergeSceneModelAssetUpdate }] = await importIsolatedTypeScriptModules([
  'src/editor/assets/mergeModelAssetUpdate.ts',
]) as [typeof import('../../src/editor/assets/mergeModelAssetUpdate')];
const asset = (): any => ({ sourcePath: 'old.glb', sourceUrl: 'old-url', lengthUnit: 'meter', unitScaleToMeters: 1,
  parameterConfig: { schema: 'babylon-editor.model-parameters', version: 1,
    parameters: [{ key: 'width', label: '宽度', type: 'number', defaultValue: 10, min: 0, max: 100 }],
    bindings: [{ target: { kind: 'node', name: 'Body' }, property: 'alpha', value: { param: 'width' } }] },
  parameterValues: { width: 0 }, assetCode: '0001',
  dataDrivenConfig: { custom: 'old-motion' }, builtInSlotBindingConfig: { custom: 'old-slot' } });

test('资源与参数规则全部采用新版，仅保留同key实例值及业务字段', () => {
  const previous = asset(), next = asset(), before = structuredClone(previous);
  next.sourceUrl = 'new-url';
  next.parameterConfig.parameters[0].max = 5;
  next.parameterConfig.bindings[0].target.name = 'NewBody';
  next.dataDrivenConfig.custom = 'new-motion';
  next.builtInSlotBindingConfig.custom = 'new-slot';
  const merged = mergeSceneModelAssetUpdate(previous, next);
  assert.equal(merged.sourceUrl, 'new-url');
  for (const key of ['parameterConfig', 'dataDrivenConfig', 'builtInSlotBindingConfig']) assert.deepEqual(merged[key], next[key]);
  assert.deepEqual(merged.parameterValues, { width: 0 });
  assert.equal(merged.assetCode, '0001');
  assert.deepEqual(previous, before);
});

test('新增用新版默认、删除旧参数、同key各实例保留独立值', () => {
  const previous = asset(), next = asset();
  previous.parameterValues.deleted = 42;
  previous.parameterConfig.parameters.push({ key: 'deleted', type: 'number', defaultValue: 42 });
  next.parameterConfig.parameters.push({ key: 'height', type: 'number', defaultValue: 3 });
  next.parameterValues.height = 999;
  const other = structuredClone(previous); other.parameterValues.width = 20;
  assert.deepEqual(mergeSceneModelAssetUpdate(previous, next).parameterValues, { width: 0, height: 3 });
  assert.deepEqual(mergeSceneModelAssetUpdate(other, next).parameterValues, { width: 20, height: 3 });
  assert.equal(previous.parameterValues.deleted, 42);
});

test('同key类型及单位冲突只warning，旧值不转换不截断，新模型仍替换', () => {
  const previous = asset(), next = asset(), warnings: string[] = [];
  previous.parameterValues.width = 35;
  next.parameterConfig.parameters[0] = { key: 'width', label: '宽度', type: 'string', defaultValue: 'new' };
  next.lengthUnit = 'centimeter'; next.unitScaleToMeters = 0.01;
  const merged = mergeSceneModelAssetUpdate(previous, next, 'DEVICE-01', warning => warnings.push(warning));
  assert.equal(merged.parameterValues!.width, 35);
  assert.equal(merged.parameterConfig!.parameters[0].type, 'string');
  assert.equal(merged.lengthUnit, 'centimeter');
  assert.ok(warnings.some(warning => /DEVICE-01.*width/.test(warning)));
});

test('0、false、空字符串、向量均保留；未保存值采用新版默认', () => {
  const previous = asset(), next = asset();
  next.parameterConfig.parameters = [
    { key: 'width', type: 'number', defaultValue: 9 }, { key: 'enabled', type: 'boolean', defaultValue: true },
    { key: 'label', type: 'string', defaultValue: 'new' }, { key: 'vector', type: 'vector3', defaultValue: { x: 9, y: 9, z: 9 } },
    { key: 'unset', type: 'number', defaultValue: 7 },
  ];
  previous.parameterValues = { width: 0, enabled: false, label: '', vector: { x: 0, y: 2, z: 3 } };
  const merged = mergeSceneModelAssetUpdate(previous, next);
  assert.deepEqual(merged.parameterValues, { ...previous.parameterValues, unset: 7 });
  assert.notEqual(merged.parameterValues!.vector, previous.parameterValues.vector);
});

test('新版不含参数配置时删除全部旧参数及包内部规则', () => {
  const previous = asset(), next = asset();
  for (const key of ['parameterConfig', 'parameterValues', 'dataDrivenConfig', 'builtInSlotBindingConfig']) delete next[key];
  const merged = mergeSceneModelAssetUpdate(previous, next);
  for (const key of ['parameterConfig', 'parameterValues', 'dataDrivenConfig', 'builtInSlotBindingConfig']) assert.equal(key in merged, false);
  assert.equal(merged.assetCode, '0001');
});
