import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import type { ModelAssetTemplate } from '../../src/editor/model/components';
import type { ModelNumberParameterDefinition, ModelParameterDefinition } from '../../src/editor/model/modelParameters';

const server = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true } });
after(() => server.close());
const { mergeModelAssetUpdate } = await server.ssrLoadModule('/src/editor/assets/mergeModelAssetUpdate.ts');

const number = (key = 'length'): ModelNumberParameterDefinition => ({ key, label: key, type: 'number', defaultValue: 10 });
function asset(parameters: ModelParameterDefinition[] = [number()], values = {}): ModelAssetTemplate {
  return { sourcePath: 'old/model.glb', sourceUrl: 'editor-asset://local/old/model.glb', lengthUnit: 'm', unitScaleToMeters: 1,
    parameterConfig: { schema: 'babylon-editor.model-parameters', version: 1, parameters, bindings: [] }, parameterValues: values };
}

test('preserves falsy and vector values while adding only missing defaults without mutating inputs', () => {
  const definitions: ModelParameterDefinition[] = [number(), { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: true },
    { key: 'text', label: 'Text', type: 'string', defaultValue: 'new' }, { key: 'offset', label: 'Offset', type: 'vector3', defaultValue: { x: 1, y: 1, z: 1 } }];
  const previous = asset(definitions, { length: 0, enabled: false, text: '', offset: { x: 0, y: 2, z: 3 } });
  const next = asset([...definitions, number('new')], { length: 999, new: 999 });
  const before = JSON.stringify([previous, next]);
  const result = mergeModelAssetUpdate(previous, next);
  assert.deepEqual(result.parameterValues, { ...previous.parameterValues, new: 10 });
  assert.equal(JSON.stringify([previous, next]), before);
  assert.notEqual(result.parameterValues.offset, previous.parameterValues!.offset);
});

test('uses previous default when an old instance omitted the saved value', () => {
  assert.equal(mergeModelAssetUpdate(asset(), asset([{ ...number(), defaultValue: 20 }])).parameterValues.length, 10);
});

test('retains scene extensions and assetCode, replaces known resource fields, and removes stale snapshots', () => {
  const previous = { ...asset(), assetCode: '000123', sceneExtension: { enabled: false }, sourceSnapshot: { contentSha256: 'old' }, scriptAssets: [{ name: 'old', path: 'old.js', sourceUrl: 'old.js' }], dataDrivenConfig: {} };
  const next = { ...asset(), sourcePath: 'new/model.glb', assetCode: 'wrong', assetRevision: 'v2' };
  const result = mergeModelAssetUpdate(previous, next);
  assert.equal(result.assetCode, '000123');
  assert.deepEqual(result.sceneExtension, previous.sceneExtension);
  assert.equal(result.sourcePath, 'new/model.glb');
  assert.equal(result.assetRevision, 'v2');
  for (const key of ['sourceSnapshot', 'scriptAssets', 'dataDrivenConfig']) assert.equal(key in result, false);
  assert.deepEqual(mergeModelAssetUpdate(previous, { ...next, sourceSnapshot: { contentSha256: 'new' } }).sourceSnapshot, { contentSha256: 'new' });
});

test('does not introduce an instance assetCode into a template', () => {
  assert.equal('assetCode' in mergeModelAssetUpdate(asset(), { ...asset(), assetCode: 'wrong' }), false);
});

test('rejects removed definitions or orphan stored parameters and includes instance context', () => {
  assert.throws(() => mergeModelAssetUpdate(asset(), asset([]), '实体 A'), /实体 A.*length.*删除/);
  assert.throws(() => mergeModelAssetUpdate(asset([], { legacy: 0 }), asset([])), /legacy/);
});

test('rejects type and parameter unit changes', () => {
  assert.throws(() => mergeModelAssetUpdate(asset(), asset([{ key: 'length', label: 'Length', type: 'string', defaultValue: '' }])), /length.*类型/);
  assert.throws(() => mergeModelAssetUpdate(asset([{ ...number(), unit: 'm' }]), asset([{ ...number(), unit: 'cm' }])), /length.*单位/);
});

test('rejects source units or meter scale changes', () => {
  assert.throws(() => mergeModelAssetUpdate(asset(), { ...asset(), lengthUnit: 'cm', unitScaleToMeters: 0.01 }), /单位/);
  assert.throws(() => mergeModelAssetUpdate(asset(), { ...asset(), unitScaleToMeters: 2 }), /单位/);
});

test('rejects number and vector values outside new ranges without clamping', () => {
  assert.throws(() => mergeModelAssetUpdate(asset([number()], { length: 20 }), asset([{ ...number(), type: 'number', max: 10 }])), /length/);
  const vector: ModelParameterDefinition = { key: 'offset', label: 'Offset', type: 'vector3', defaultValue: { x: 0, y: 0, z: 0 } };
  assert.throws(() => mergeModelAssetUpdate(asset([vector], { offset: { x: 0, y: -5, z: 0 } }), asset([{ ...vector, min: 0 }])), /offset/);
});

test('rejects removed enum choices but permits added choices and changed labels', () => {
  const definition: ModelParameterDefinition = { key: 'choice', label: 'Choice', type: 'enum', defaultValue: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] };
  assert.throws(() => mergeModelAssetUpdate(asset([definition], { choice: 'b' }), asset([{ ...definition, options: [{ value: 'a', label: 'A' }] }])), /choice/);
  assert.equal(mergeModelAssetUpdate(asset([definition], { choice: 'a' }), asset([{ ...definition, options: [...definition.options, { value: 'c', label: 'C' }] }])).parameterValues.choice, 'a');
});

test('rejects binding and rule semantic changes while accepting object key reordering', () => {
  const previous = asset();
  previous.parameterConfig!.bindings = [{ target: { kind: 'node', name: 'part' }, property: 'alpha', value: { param: 'length' } }];
  const next = structuredClone(previous);
  next.parameterConfig!.bindings[0].target.name = 'renamed';
  assert.throws(() => mergeModelAssetUpdate(previous, next), /length.*绑定/);
  next.parameterConfig!.bindings[0] = { value: { param: 'length' }, property: 'alpha', target: { name: 'part', kind: 'node' } };
  assert.doesNotThrow(() => mergeModelAssetUpdate(previous, next));
  previous.parameterConfig!.rules = [{ when: { param: 'length' }, set: previous.parameterConfig!.bindings }];
  assert.throws(() => mergeModelAssetUpdate(previous, next), /length.*绑定/);
});

test('permits bindings for newly introduced parameters', () => {
  const next = asset([number(), number('new')]);
  next.parameterConfig!.bindings = [{ target: { kind: 'mesh', name: 'part' }, property: 'alpha', value: { param: 'new' } }];
  assert.doesNotThrow(() => mergeModelAssetUpdate(asset(), next));
});

test('rejects changed constant bindings even when they do not mention a parameter', () => {
  const previous = asset();
  previous.parameterConfig!.bindings = [{ target: { kind: 'node', name: 'part' }, property: 'alpha', value: 0.5 }];
  const next = structuredClone(previous);
  next.parameterConfig!.bindings[0].value = 1;
  assert.throws(() => mergeModelAssetUpdate(previous, next), /绑定/);
});

test('keeps independent instances independent and adopts only the new resource identity', () => {
  const next = { ...asset(), dataPlatformModel: { sourceKey: 'server', kind: 'model' as const, resourceId: '999', modelPath: 'model.glb' } };
  const first = { ...asset([number()], { length: 1 }), dataPlatformModel: { sourceKey: 'old', kind: 'model' as const, resourceId: '999', modelPath: 'old.glb' } };
  const second = asset([number()], { length: 2 });
  assert.equal(mergeModelAssetUpdate(first, next).parameterValues.length, 1);
  assert.equal(mergeModelAssetUpdate(second, next).parameterValues.length, 2);
  assert.deepEqual(mergeModelAssetUpdate(first, next).dataPlatformModel, next.dataPlatformModel);
  assert.equal('dataPlatformModel' in mergeModelAssetUpdate(first, asset()), false);
});

test('rejects invalid texture extensions and removed declared package texture choices', () => {
  const texture: ModelParameterDefinition = { key: 'texture', label: 'Texture', type: 'texture', defaultValue: 'textures/a.png', options: [{ value: 'textures/a.png', label: 'A' }] };
  assert.throws(() => mergeModelAssetUpdate(asset([texture]), asset([{ ...texture, allowedExtensions: ['.jpg'] }])), /texture/);
  assert.throws(() => mergeModelAssetUpdate(asset([texture]), asset([{ ...texture, options: [{ value: 'textures/b.png', label: 'B' }] }])), /texture/);
});

test('rejects invalid retained values and invalid new defaults instead of silently replacing them', () => {
  assert.throws(() => mergeModelAssetUpdate(asset([number()], { length: 'bad' }), asset()), /length/);
  assert.throws(() => mergeModelAssetUpdate(asset([]), asset([{ ...number(), defaultValue: Number.NaN }])), /length/);
  assert.throws(() => mergeModelAssetUpdate(asset([]), asset([number(), number()])), /重复/);
});
