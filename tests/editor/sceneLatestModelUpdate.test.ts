import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { build } from 'vite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 预编译同一模块图，避免 Vite SSR 按需传输在大型 Store 依赖图中超时。
const temporary = await mkdtemp(path.join(os.tmpdir(), 'scene-update-ssr-'));
after(() => rm(temporary, { recursive: true, force: true }));
const entries = ['src/editor/assets/applySceneModelUpdates.ts', 'src/editor/model/SceneDocument.ts',
  'src/editor/project/SceneSerializer.ts', 'src/editor/store/editorStore.ts'];
const entryFile = path.join(temporary, 'input.ts');
await writeFile(entryFile, entries.map((entry, index) =>
  `export * as module${index} from ${JSON.stringify(path.resolve(entry).replace(/\\/g, '/'))};`).join('\n'));
await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true },
  build: { ssr: entryFile, outDir: path.join(temporary, 'out'), minify: false,
    rollupOptions: { output: { entryFileNames: 'entry.mjs' } } } }).catch(async error => {
  await rm(temporary, { recursive: true, force: true });
  throw error;
});
(globalThis as any).window ??= {};
const loaded = await import(pathToFileURL(path.join(temporary, 'out/entry.mjs')).href);
const { applySceneModelUpdates, applyAvailableSceneModelUpdates } = loaded.module0;
const { createEmptySceneDocument, createModelEntity, createModelGeneratorEntity, createClickEventBindingEntity } = loaded.module1;
const { serializeScene, deserializeScene } = loaded.module2;
const sourceKey = 'a'.repeat(64);
const url = (root: string) => `editor-asset://local/${encodeURIComponent(`C:/${root}/Model-123-rack/model.glb`)}`;
const config = { schema: 'babylon-editor.model-parameters', version: 1, parameters: [
  { key: 'width', label: '宽度', type: 'number', defaultValue: 1, min: 0, max: 20 },
], bindings: [] };
const asset = { id: 'new', kind: 'model', libraryKind: 'model', name: 'new model', path: 'C:/new/Model-123-rack/model.glb',
  sourceUrl: url('new'), lengthUnit: 'meter', packagePath: 'C:/new/Model-123-rack', assetRevision: 'new', parameterConfig: config };

function fixture() {
  const scene = createEmptySceneDocument('参数保留');
  const models = [0, 8].map(width => {
    const entity = createModelEntity('C:/old/Model-123-rack/model.glb', url('old'), `实例${width}`);
    Object.assign(entity.components.modelAsset, { parameterConfig: config, parameterValues: { width }, assetCode: `asset-${width}` });
    entity.components.transform.position.x = width + 10;
    scene.entities[entity.id] = entity; scene.entityIds.push(entity.id);
    return entity;
  });
  const generator = createModelGeneratorEntity();
  generator.components.modelGenerator.defaultTarget = { kind: 'model', assetId: 'old', displayName: '场景模板',
    modelAsset: { ...models[0].components.modelAsset, parameterValues: { width: 3 } } };
  scene.entities[generator.id] = generator; scene.entityIds.push(generator.id);
  return { scene, models, generator };
}

test('多个实例与生成器分别保留参数，保存重开后资源身份与参数仍一致', () => {
  const { scene, models, generator } = fixture();
  const before = structuredClone(scene);
  const updated = applySceneModelUpdates(scene, [{ sourceUrls: [url('old')], asset }], sourceKey).scene;
  assert.deepEqual(scene, before);
  assert.deepEqual(updated.entityIds, scene.entityIds);
  for (const model of models) {
    const actual = updated.entities[model.id];
    assert.deepEqual(actual.components.transform, model.components.transform);
    assert.equal(actual.components.modelAsset.assetCode, model.components.modelAsset.assetCode);
    assert.deepEqual(actual.components.modelAsset.parameterValues, model.components.modelAsset.parameterValues);
    assert.equal(actual.components.modelAsset.sourceUrl, asset.sourceUrl);
  }
  const restored = deserializeScene(serializeScene(updated));
  assert.deepEqual(restored.entities[models[1].id].components.modelAsset.parameterValues, { width: 8 });
  assert.equal(restored.entities[models[0].id].components.modelAsset.dataPlatformModel.sourceKey, sourceKey);
  assert.deepEqual(restored.entities[generator.id].components.modelGenerator.defaultTarget.modelAsset.parameterValues, { width: 3 });
});

test('参数类型冲突直接更新全部实例，仅日志提示且不改变原输入文档', () => {
  const { scene, models } = fixture();
  const before = structuredClone(scene);
  const incompatible = { ...asset, parameterConfig: { ...config, parameters: [{ key: 'width', label: '宽度', type: 'string', defaultValue: '' }] } };
  const updated = applySceneModelUpdates(scene, [{ sourceUrls: [url('old')], asset: incompatible }], sourceKey);
  assert.ok(updated.warnings.some((warning: string) => warning.includes('width')));
  assert.equal(updated.scene.entities[models[1].id].components.modelAsset.parameterValues.width, 8);
  assert.equal(updated.scene.entities[models[1].id].components.modelAsset.parameterConfig.parameters[0].type, 'string');
  assert.equal(updated.scene.entities[models[1].id].components.modelAsset.sourceUrl, asset.sourceUrl);
  assert.deepEqual(scene, before);
});

test('重复应用相同固定版本是幂等操作', () => {
  const { scene } = fixture();
  const first = applySceneModelUpdates(scene, [{ sourceUrls: [url('old')], asset }], sourceKey).scene;
  const second = applySceneModelUpdates(first, [{ sourceUrls: [asset.sourceUrl], asset }], sourceKey);
  assert.equal(second.scene, first);
  assert.equal(second.updatedCount, 0);
});

test('中台范围收窄采用新版范围并保留原数值，同步保存重开不丢值', () => {
  const { scene, models } = fixture();
  const next = { ...asset, parameterConfig: { ...config, parameters: [{ ...config.parameters[0], max: 5 }] } };
  const applied = applyAvailableSceneModelUpdates(scene, [{ sourceUrls: [url('old')], asset: next }], sourceKey);
  assert.equal(applied.issues.length, 0);
  const reopened = deserializeScene(serializeScene(applied.scene));
  assert.equal(reopened.entities[models[1].id].components.modelAsset.parameterValues.width, 8);
  assert.equal(reopened.entities[models[1].id].components.modelAsset.parameterConfig.parameters[0].max, 5);
  assert.equal(reopened.entities[models[1].id].components.modelAsset.sourceUrl, asset.sourceUrl);
});

test('真实资源身份无效保留该组，其他资源继续更新，保存重开业务绑定仍在', () => {
  const { scene, models, generator } = fixture();
  const otherUrl = url('old').replace('Model-123-', 'Model-456-');
  const other = createModelEntity('C:/old/Model-456-rack/model.glb', otherUrl, '独立设备');
  Object.assign(other.components.modelAsset, { parameterConfig: config, parameterValues: { width: 4 }, assetCode: 'KEEP-456' });
  scene.entities[other.id] = other; scene.entityIds.push(other.id);
  const binding = createClickEventBindingEntity();
  binding.components.clickEventBinding.deviceSlots = [{ id: 'slot', deviceType: {
    id: 'rack-type', displayName: '货架', sourceUrl: url('old'), sourcePath: 'old', assetId: 'old',
  } }];
  scene.entities[binding.id] = binding; scene.entityIds.push(binding.id);
  const before = structuredClone(scene);
  const incompatible = { ...asset, sourceUrl: 'editor-asset://local/unidentified.glb' };
  const otherAsset = { ...asset, id: 'new456', path: asset.path.replace('Model-123-', 'Model-456-'), sourceUrl: asset.sourceUrl.replace('Model-123-', 'Model-456-') };
  const updated = applyAvailableSceneModelUpdates(scene, [
    { sourceUrls: [url('old')], asset: incompatible }, { sourceUrls: [otherUrl], asset: otherAsset },
  ], sourceKey);
  assert.equal(updated.issues.length, 1);
  for (const entity of [...models, generator, binding]) assert.deepEqual(updated.scene.entities[entity.id], before.entities[entity.id]);
  assert.equal(updated.scene.entities[other.id].components.modelAsset.sourceUrl, otherAsset.sourceUrl);
  assert.deepEqual(updated.scene.entities[other.id].components.modelAsset.parameterValues, { width: 4 });
  assert.deepEqual(scene, before);
  const restored = deserializeScene(serializeScene(updated.scene));
  assert.deepEqual(restored.entities[models[1].id].components.modelAsset.parameterValues, { width: 8 });
  assert.deepEqual(restored.entities[other.id].components.modelAsset.parameterValues, { width: 4 });
  assert.equal(restored.entities[binding.id].components.clickEventBinding.deviceSlots[0].deviceType.sourceUrl, url('old'));
});

test('新版删除全部参数仍替换模型，全部实例和生成器旧值被移除', () => {
  const { scene, models, generator } = fixture();
  const incompatible = { ...asset, parameterConfig: { ...config, parameters: [] } };
  const result = applyAvailableSceneModelUpdates(scene, [{ sourceUrls: [url('old')], asset: incompatible }], sourceKey);
  assert.notEqual(result.scene, scene); assert.ok(result.updatedCount > 0); assert.equal(result.issues.length, 0);
  for (const model of models) assert.deepEqual(result.scene.entities[model.id].components.modelAsset.parameterValues, {});
  assert.deepEqual(result.scene.entities[generator.id].components.modelGenerator.defaultTarget.modelAsset.parameterValues, {});
});

test('局部失败保留成功更新且阻止发布，成功重试清除问题，旧事务不能修改新场景', async () => {
  (globalThis as any).window ??= {};
  const { useEditorStore } = loaded.module3;
  const { scene } = fixture();
  useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'latest-transaction');
  const before = useEditorStore.getState();
  const updated = applySceneModelUpdates(before.scene, [{ sourceUrls: [url('old')], asset }], sourceKey).scene;
  assert.equal(before.commitLatestSceneResources('old-session', before.scene, updated), false);
  assert.equal(before.commitLatestSceneResources(before.sceneSessionId, before.scene, updated), true);
  const transaction = useEditorStore.getState().latestSceneResourceTransaction;
  before.finishLatestSceneResources(before.sceneSessionId, structuredClone(updated));
  assert.equal(useEditorStore.getState().latestSceneResourceTransaction, transaction, '旧渲染回调不能认领新事务');
  before.finishLatestSceneResources(before.sceneSessionId, updated, '测试渲染失败');
  assert.equal(useEditorStore.getState().scene, updated, '无法定位的局部错误不能回滚全部成功资源');
  assert.ok(useEditorStore.getState().sceneResourceIssues.includes('测试渲染失败'));
  assert.equal(useEditorStore.getState().latestSceneResourceTransaction, null);
  assert.equal(before.commitLatestSceneResources(before.sceneSessionId, updated, updated, []), true);
  assert.ok(useEditorStore.getState().sceneResourceIssues.includes('测试渲染失败'), '重试尚未完成首帧时不能清除发布保护');
  before.finishLatestSceneResources(before.sceneSessionId, updated);
  assert.deepEqual(useEditorStore.getState().sceneResourceIssues, []);
  useEditorStore.getState().undo();
  assert.deepEqual(useEditorStore.getState().scene.entities, before.scene.entities);
});
