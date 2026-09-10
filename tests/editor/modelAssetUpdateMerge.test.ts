import assert from 'node:assert/strict';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';
const [{ mergeModelAssetUpdate, mergeSceneModelAssetUpdate }] = await importIsolatedTypeScriptModules([
  'src/editor/assets/mergeModelAssetUpdate.ts',
]) as [typeof import('../../src/editor/assets/mergeModelAssetUpdate')];
const number = (key = 'length', defaultValue = 10): any => ({ key, label: key, type: 'number', defaultValue });
const asset = (parameters: any[] = [number()], values: any = {}): any => ({
  sourcePath: 'old.glb', sourceUrl: 'old-url', lengthUnit: 'meter', unitScaleToMeters: 1,
  parameterConfig: { schema: 'babylon-editor.model-parameters', version: 1, parameters, bindings: [] }, parameterValues: values,
});

test('所有合并入口采用同一新版规则，不残留严格冲突分支', () => {
  assert.equal(mergeModelAssetUpdate, mergeSceneModelAssetUpdate);
});
test('旧实例没有保存值时使用新版默认，不沿用旧定义默认', () => {
  assert.equal(mergeModelAssetUpdate(asset(), asset([number('length', 20)])).parameterValues!.length, 20);
});
test('参数改key视为删除旧key并新增，不按label推断旧值', () => {
  const merged = mergeModelAssetUpdate(asset([number('old')], { old: 99 }), asset([{ ...number('new', 3), label: 'old' }]));
  assert.deepEqual(merged.parameterValues, { new: 3 });
});
test('同key类型、范围、单位、枚举变化保留原显式值并使用新定义', () => {
  const values = [0, false, '', 100, 'removed-choice', { x: 0, y: 1, z: 2 }];
  for (const value of values) {
    const previous = asset([number()], { length: value });
    const next = asset([{ key: 'length', label: '新版', type: 'enum', options: [{ value: 'a', label: 'A' }], defaultValue: 'a' }]);
    const warnings: string[] = [];
    const merged = mergeModelAssetUpdate(previous, next, '实体 A', message => warnings.push(message));
    assert.deepEqual(merged.parameterValues!.length, value);
    assert.deepEqual(merged.parameterConfig, next.parameterConfig);
    assert.ok(warnings.length);
  }
});
test('新增规则可引用同名保留参数，也可按新版顺序覆盖属性', () => {
  const previous = asset([number()], { length: 12 }), next = asset([number(), number('new', 3)]);
  previous.parameterConfig.bindings = [{ target: { kind: 'node', name: 'old' }, property: 'alpha', value: { param: 'length' } }];
  next.parameterConfig.bindings = [{ target: { kind: 'node', name: 'new' }, property: 'alpha', value: { param: 'new' } }];
  next.parameterConfig.rules = [{ when: { param: 'length' }, set: next.parameterConfig.bindings }];
  const merged = mergeModelAssetUpdate(previous, next);
  assert.deepEqual(merged.parameterConfig, next.parameterConfig);
  assert.deepEqual(merged.parameterValues, { length: 12, new: 3 });
});
test('移除参数同时移除旧常量规则，不要求新版保留旧执行语义', () => {
  const previous = asset();
  previous.parameterConfig.rules = [{ when: true, set: [] }];
  const next = asset([]), merged = mergeModelAssetUpdate(previous, next);
  assert.deepEqual(merged.parameterConfig, next.parameterConfig);
  assert.deepEqual(merged.parameterValues, {});
});
test('更新资源身份脚本配置、删除旧快照，保留实例assetCode与扩展', () => {
  const previous = { ...asset(), assetCode: '000123', sceneExtension: { enabled: false }, sourceSnapshot: { contentSha256: 'old' } };
  const next = { ...asset(), sourceUrl: 'new', assetRevision: 'v2', assetCode: 'wrong', scriptAssets: [{ name: 'new', path: 'new.ts', sourceUrl: 'new.ts' }] };
  const merged = mergeModelAssetUpdate(previous, next);
  assert.equal(merged.assetCode, '000123');
  assert.deepEqual(merged.sceneExtension, previous.sceneExtension);
  assert.equal(merged.sourceUrl, 'new');
  assert.equal(merged.assetRevision, 'v2');
  assert.equal('sourceSnapshot' in merged, false);
  assert.deepEqual(merged.scriptAssets, next.scriptAssets);
  assert.equal('assetCode' in mergeModelAssetUpdate(asset(), next), false);
});
test('key为原型属性时也只创建自有参数，不污染其他实例', () => {
  const values = JSON.parse('{"__proto__": 4, "constructor": 8}');
  const merged = mergeModelAssetUpdate(asset(), asset([number('__proto__'), number('constructor')]));
  assert.equal(Object.hasOwn(merged.parameterValues!, '__proto__'), true);
  const kept = mergeModelAssetUpdate(asset([], values), asset([number('__proto__'), number('constructor')]));
  assert.equal(kept.parameterValues!.__proto__, 4);
  assert.equal(kept.parameterValues!.constructor, 8);
  assert.equal(Object.getPrototypeOf(kept.parameterValues), Object.prototype);
});
