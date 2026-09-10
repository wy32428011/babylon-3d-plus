import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({ appType: 'custom', configFile: false, root: process.cwd(),
  server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, ssr: { noExternal: ['@linkiez/dxf-renew'] } });
after(() => vite.close());
const { applySceneModelUpdates, applyAvailableSceneModelUpdates } = await vite.ssrLoadModule('/src/editor/assets/applySceneModelUpdates.ts');
const { createEmptySceneDocument, createModelEntity, createModelGeneratorEntity, createClickEventBindingEntity } = await vite.ssrLoadModule('/src/editor/model/SceneDocument.ts');
const { serializeScene, deserializeScene } = await vite.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
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

test('任一实例参数冲突时整批失败，不修改其它实例或环境', () => {
  const { scene } = fixture();
  const before = structuredClone(scene);
  const incompatible = { ...asset, parameterConfig: { ...config, parameters: [{ ...config.parameters[0], max: 5 }] } };
  assert.throws(() => applySceneModelUpdates(scene, [{ sourceUrls: [url('old')], asset: incompatible }], sourceKey), /width|宽度/);
  assert.deepEqual(scene, before);
});

test('重复应用相同固定版本是幂等操作', () => {
  const { scene } = fixture();
  const first = applySceneModelUpdates(scene, [{ sourceUrls: [url('old')], asset }], sourceKey).scene;
  const second = applySceneModelUpdates(first, [{ sourceUrls: [asset.sourceUrl], asset }], sourceKey);
  assert.equal(second.scene, first);
  assert.equal(second.updatedCount, 0);
});

test('局部参数冲突保留整个模型组，其他资源继续更新，保存重开后参数与绑定仍在', () => {
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
  const incompatible = { ...asset, parameterConfig: { ...config, parameters: [{ ...config.parameters[0], max: 5 }] } };
  const otherAsset = { ...asset, id: 'new456', path: asset.path.replace('Model-123-', 'Model-456-'), sourceUrl: asset.sourceUrl.replace('Model-123-', 'Model-456-') };
  const updated = applyAvailableSceneModelUpdates(scene, [
    { sourceUrls: [url('old')], asset: incompatible }, { sourceUrls: [otherUrl], asset: otherAsset },
  ], sourceKey);
  assert.equal(updated.issues.length, 1);
  assert.equal(updated.issues[0].resourceId, '123');
  for (const entity of [...models, generator, binding]) assert.deepEqual(updated.scene.entities[entity.id], before.entities[entity.id]);
  assert.equal(updated.scene.entities[other.id].components.modelAsset.sourceUrl, otherAsset.sourceUrl);
  assert.deepEqual(updated.scene.entities[other.id].components.modelAsset.parameterValues, { width: 4 });
  assert.deepEqual(scene, before);
  const restored = deserializeScene(serializeScene(updated.scene));
  assert.deepEqual(restored.entities[models[1].id].components.modelAsset.parameterValues, { width: 8 });
  assert.deepEqual(restored.entities[other.id].components.modelAsset.parameterValues, { width: 4 });
  assert.equal(restored.entities[binding.id].components.clickEventBinding.deviceSlots[0].deviceType.sourceUrl, url('old'));
});

test('所有模型组失败仍返回原场景而不是抛错或清空配置', () => {
  const { scene } = fixture();
  const incompatible = { ...asset, parameterConfig: { ...config, parameters: [] } };
  const result = applyAvailableSceneModelUpdates(scene, [{ sourceUrls: [url('old')], asset: incompatible }], sourceKey);
  assert.equal(result.scene, scene); assert.equal(result.updatedCount, 0); assert.equal(result.issues.length, 1);
});

test('局部失败保留成功更新且阻止发布，成功重试清除问题，旧事务不能修改新场景', async () => {
  (globalThis as any).window ??= {};
  const { useEditorStore } = await vite.ssrLoadModule('/src/editor/store/editorStore.ts');
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
