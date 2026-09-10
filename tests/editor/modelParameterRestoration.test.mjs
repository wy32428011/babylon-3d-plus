import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { NullEngine, Scene, TransformNode, MeshBuilder, StandardMaterial } from '@babylonjs/core';

const output = await mkdtemp(path.resolve('node_modules/.parameter-restore-'));
const cleanup = async () => {
  if (path.dirname(output) !== path.resolve('node_modules') || !path.basename(output).startsWith('.parameter-restore-')) throw Error('invalid fixture output');
  await rm(output, { recursive: true, force: true });
};
after(cleanup);
await build({ configFile: false, publicDir: false, logLevel: 'silent', ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] }, build: { ssr: true, outDir: output,
  rollupOptions: { input: {
    parameters: 'src/editor/model/modelParameters.ts', serializer: 'src/editor/project/SceneSerializer.ts',
    generator: 'src/editor/model/modelGenerator.ts', document: 'src/editor/model/SceneDocument.ts',
    runtime: 'src/runtime/babylon/SceneRuntime.ts',
    store: 'src/editor/store/editorStore.ts',
  }, output: { entryFileNames: '[name].mjs' } } } }).catch(async error => { await cleanup(); throw error; });
const [parameters, serializer, generator, document, { SceneRuntime }, { useEditorStore }] = await Promise.all(
  ['parameters', 'serializer', 'generator', 'document', 'runtime', 'store'].map(name => import(pathToFileURL(path.join(output, name + '.mjs')))),
).catch(async error => { await cleanup(); throw error; });
const config = { schema: 'babylon-editor.model-parameters', version: 1, parameters: [
  { key: 'width', label: '宽度', type: 'number', defaultValue: 1, min: 1, max: 5 },
  { key: 'changedType', label: '类型改变', type: 'number', defaultValue: 2 },
  { key: 'choice', label: '选项', type: 'enum', defaultValue: 'new', options: [{ value: 'new', label: '新版' }] },
  { key: 'enabled', label: '开关', type: 'boolean', defaultValue: true },
  { key: 'label', label: '文字', type: 'string', defaultValue: 'default' },
  { key: 'added', label: '新增', type: 'number', defaultValue: 9 },
], bindings: [] };
const saved = { width: 0, changedType: 'previous-string', choice: 'removed-option', enabled: false, label: '', deleted: 123 };
const expected = { width: 0, changedType: 'previous-string', choice: 'removed-option', enabled: false, label: '', added: 9 };

test('重载按新定义补删key，同key保存值原样保留，用户输入校验仍有效', () => {
  assert.equal(typeof parameters.restoreModelParameterValues, 'function');
  assert.deepEqual(parameters.restoreModelParameterValues(config, saved), expected);
  assert.equal(parameters.sanitizeModelParameterValue(config.parameters[0], 0), 1);
  assert.equal(parameters.sanitizeModelParameterValue(config.parameters[1], 'previous-string'), 2);
  assert.equal(parameters.sanitizeModelParameterValue(config.parameters[2], 'removed-option'), 'new');
});

test('修改单个字段只校验该字段，其他旧值和撤销基线不会被顺便重写', () => {
  const result = parameters.sanitizeEditedModelParameterValues(config, expected, { ...expected, added: 11 });
  assert.deepEqual(result, { ...expected, added: 11 });
  assert.deepEqual(parameters.sanitizeEditedModelParameterValues(config, expected, { ...expected, width: 20 }), { ...expected, width: 5 });
  assert.deepEqual(parameters.sanitizeEditedModelParameterValues(config, expected, { added: 11 }), { ...expected, added: 11 },
    '部分字段更新不能把其他已保存字段恢复默认值');
  assert.deepEqual(parameters.restoreModelParameterValues(config, expected), expected);
});

test('场景序列化重开不再次clamp，不把旧类型或已删除枚举值变成default', () => {
  const scene = document.createEmptySceneDocument('保留参数');
  const model = document.createModelEntity('C:/Model-1/device.glb', 'editor-asset://local/C%3A%2FModel-1%2Fdevice.glb', '实例');
  Object.assign(model.components.modelAsset, { parameterConfig: config, parameterValues: saved });
  scene.entityIds.push(model.id); scene.entities[model.id] = model;
  const reloaded = serializer.deserializeScene(serializer.serializeScene(scene));
  assert.deepEqual(reloaded.entities[model.id].components.modelAsset.parameterValues, expected);
});

test('场景未保存parameterValues时使用新版原始默认值，不按range二次清洗', () => {
  const scene = document.createEmptySceneDocument('新版默认值');
  const model = document.createModelEntity('C:/Model-1/device.glb', 'editor-asset://local/C%3A%2FModel-1%2Fdevice.glb', '实例');
  model.components.modelAsset.parameterConfig = { schema: 'babylon-editor.model-parameters', version: 1,
    parameters: [{ key: 'width', label: '宽度', type: 'number', defaultValue: 20, max: 10 }], bindings: [] };
  delete model.components.modelAsset.parameterValues;
  scene.entityIds.push(model.id); scene.entities[model.id] = model;
  const reloaded = serializer.deserializeScene(serializer.serializeScene(scene));
  assert.equal(reloaded.entities[model.id].components.modelAsset.parameterValues.width, 20);
});

test('生成器模型模板重载遵循同一保存值规则', () => {
  const model = document.createModelEntity('C:/Model-1/device.glb', 'editor-asset://local/C%3A%2FModel-1%2Fdevice.glb', '模板');
  Object.assign(model.components.modelAsset, { parameterConfig: config, parameterValues: saved });
  const restored = generator.sanitizeModelGeneratorTarget({ kind: 'model', assetId: 'asset', displayName: '模板', modelAsset: model.components.modelAsset });
  assert.deepEqual(restored.modelAsset.parameterValues, expected);
});

test('编辑器提交另一个参数及撤销均保留尚未编辑的历史参数值', () => {
  const beforeState = useEditorStore.getState();
  const scene = document.createEmptySceneDocument('编辑参数');
  const model = document.createModelEntity('C:/Model-1/device.glb', 'editor-asset://local/C%3A%2FModel-1%2Fdevice.glb', '实例');
  Object.assign(model.components.modelAsset, { parameterConfig: config, parameterValues: expected });
  scene.entityIds.push(model.id); scene.entities[model.id] = model; scene.selectedEntityId = model.id;
  try {
    useEditorStore.setState({ scene, runtimeMode: 'edit', hierarchySelectionIds: [model.id] });
    useEditorStore.getState().commitSelectedModelParameterValues(expected, { ...expected, added: 11 });
    assert.deepEqual(useEditorStore.getState().scene.entities[model.id].components.modelAsset.parameterValues, { ...expected, added: 11 });
    useEditorStore.getState().undo();
    assert.deepEqual(useEditorStore.getState().scene.entities[model.id].components.modelAsset.parameterValues, expected);
  } finally { useEditorStore.setState(beforeState); }
});

test('真实Runtime遇到旧类型/缺失节点/非法纹理仅隔离该绑定，后续显隐继续且不写回保存值', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const logs = [];
  const runtime = new SceneRuntime(scene, message => logs.push(message));
  try {
    const root = new TransformNode('root', scene);
    const mesh = MeshBuilder.CreateBox('device', {}, scene); mesh.parent = root;
    const material = new StandardMaterial('device-material', scene); mesh.material = material;
    const values = { wrongType: 'old-string', enabled: false, texture: 'javascript:alert(1)' };
    const asset = { assetCode: 'DEVICE-OLD', sourcePath: 'C:/Model-1/device.glb', sourceUrl: 'editor-asset://local/C%3A%2FModel-1%2Fdevice.glb',
      parameterValues: values, parameterConfig: { ...config, bindings: [
        { target: { kind: 'mesh', name: 'missing-node' }, property: 'visible', value: true },
        { target: { kind: 'mesh', name: 'device' }, property: 'position', value: { vector3: [{ op: 'add', args: [{ param: 'wrongType' }, 1] }, 0, 0] } },
        { target: { kind: 'material', name: 'device-material' }, property: 'baseTexture', value: { param: 'texture' } },
        { target: { kind: 'mesh', name: 'device' }, property: 'visible', value: { param: 'enabled' } },
      ] } };
    const savedValues = structuredClone(values);
    const entry = { root, meshes: [mesh], assetHandle: {}, parameterBaseline: new Map(), textureCache: new Map(), parameterSignature: null };
    assert.doesNotThrow(() => runtime.applyModelAssetParameters(asset, entry));
    assert.equal(mesh.isVisible, false);
    assert.equal(mesh.position.x, 0);
    assert.equal(entry.textureCache.size, 0);
    assert.equal(entry.readinessError, undefined);
    assert.deepEqual(values, savedValues);
    assert.equal(logs.filter(message => message.includes('暂时无法执行')).length, 3);
    runtime.applyModelAssetParameters(asset, entry);
    assert.equal(logs.length, 3, '相同参数快照不重复刷日志');
  } finally { runtime.dispose(); scene.dispose(); engine.dispose(); }
});
