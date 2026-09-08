import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
const moduleRoot = await mkdtemp(path.resolve('node_modules/.publish-model-recovery-'));
let modules;
try {
  await build({ configFile: false, publicDir: false, logLevel: 'warn', build: {
    ssr: true, outDir: moduleRoot, rollupOptions: {
      input: { repair: 'src/editor/deployment/repairPublishSceneModels.ts', document: 'src/editor/model/SceneDocument.ts',
        serializer: 'src/editor/project/SceneSerializer.ts', click: 'src/editor/model/clickEventBinding.ts' },
      output: { entryFileNames: '[name].mjs' },
    },
  } });
  modules = await Promise.all(['repair', 'document', 'serializer', 'click'].map(name => import(pathToFileURL(path.join(moduleRoot, name + '.mjs')).href)));
} finally {
  if (path.dirname(moduleRoot) !== path.resolve('node_modules') || !path.basename(moduleRoot).startsWith('.publish-model-recovery-')) throw new Error('测试目录无效');
  await rm(moduleRoot, { recursive: true, force: true });
}
const [{ repairPublishSceneModels }, document, { serializeScene, deserializeScene }, click] = modules;
const url = (root: string, file = 'model.glb') => `editor-asset://local/${encodeURIComponent(`C:/${root}/Model-12-堆垛机/${file}`)}`;
const asset = { id: 'asset', name: '堆垛机', kind: 'model' as const, libraryKind: 'model' as const, path: 'C:/shared/Model-12-堆垛机/model.glb', sourceUrl: url('shared'), assetRevision: 'new' };
function fixture(withModel = false) {
  const scene = document.createEmptySceneDocument();
  const binding = document.createClickEventBindingEntity();
  binding.components.clickEventBinding!.deviceSlots = [{ id: 'slot', deviceType: { id: 'type', assetId: 'asset', displayName: '堆垛机', sourcePath: 'old', sourceUrl: url('old') } }];
  scene.entities[binding.id] = binding;
  scene.entityIds.push(binding.id);
  const model = document.createModelEntity('C:/project/Model-12-堆垛机/model.glb', url('project'), '原实例');
  if (withModel) { scene.entities[model.id] = model; scene.entityIds.push(model.id); }
  return { scene, binding, model };
}
test('无模型时补入真实模型、保留事件，保存加载后能触发，重复执行不新增', () => {
  const { scene, binding } = fixture();
  const recovery = { replacements: [{ sourceUrls: [url('old')], asset }] };
  const result = repairPublishSceneModels(scene, recovery);
  assert.equal(result.addedCount, 1);
  const added = Object.values(result.scene.entities).find((entity) => entity.components.modelAsset)!;
  const loaded = deserializeScene(serializeScene(result.scene));
  assert.equal(click.resolveClickEventBindingClick(loaded, added.id).kind, 'trigger');
  assert.deepEqual(loaded.entities[binding.id].components.clickEventBinding!.events, binding.components.clickEventBinding!.events);
  assert.equal(repairPublishSceneModels(result.scene, { replacements: [] }).scene, result.scene);
  assert.equal(scene.entityIds.length, 1, '原始文档不受可变操作影响');
});
test('同类型已有实例只重新关联，位置、资产编号、组件和参数不变', () => {
  const { scene, model } = fixture(true);
  model.components.transform!.position.x = 23;
  model.components.modelAsset!.assetCode = 'DDJ2';
  model.components.modelAsset!.parameterValues = { width: 0, label: '保留' };
  const result = repairPublishSceneModels(scene, { replacements: [] });
  assert.equal(result.addedCount, 0);
  assert.deepEqual(result.scene.entities[model.id], model);
  assert.equal(click.resolveClickEventBindingClick(result.scene, model.id).kind, 'trigger');
});
test('模型文件恢复或改名后保留实例标识，原绑定同步指向恢复资源', () => {
  const { scene, model } = fixture(true);
  model.components.modelAsset!.assetCode = 'DDJ2';
  model.components.modelAsset!.parameterValues = { width: 0 };
  model.components.modelAsset!.sourceSnapshot = { contentSha256: 'old' };
  model.components.modelAsset!.lengthUnit = 'millimeter';
  model.components.modelAsset!.unitScaleToMeters = 0.001;
  const result = repairPublishSceneModels(scene, { replacements: [{ sourceUrls: [url('project')], asset: { ...asset, sourceUrl: url('shared', 'renamed.glb') } }] });
  assert.equal(result.addedCount, 0);
  assert.equal(result.restoredCount, 1);
  const restored = result.scene.entities[model.id].components.modelAsset!;
  assert.equal(restored.assetCode, 'DDJ2');
  assert.deepEqual(restored.parameterValues, { width: 0 });
  assert.equal(restored.sourceSnapshot, undefined);
  assert.equal(restored.lengthUnit, 'meter');
  assert.equal(restored.unitScaleToMeters, 1);
  assert.equal(click.resolveClickEventBindingClick(result.scene, model.id).kind, 'trigger');
});

test('只有报警筛选模板时仍增加真实实体，失效缩略图不继续进入源工程', () => {
  const { scene, binding } = fixture();
  binding.components.clickEventBinding!.deviceSlots[0].deviceType!.thumbnailUrl = url('missing', 'thumbnail.png');
  const alarm = document.createModelEntity('placeholder', url('old'), '报警配置');
  alarm.components = { alarmManager: { targets: [{ model: { kind: 'model', modelAsset: { sourceUrl: url('old'), sourcePath: 'old' } } }] } };
  scene.entities[alarm.id] = alarm; scene.entityIds.push(alarm.id);
  const result = repairPublishSceneModels(scene, { replacements: [{ sourceUrls: [url('old')], asset }] });
  assert.equal(result.addedCount, 1);
  assert.equal(result.scene.entities[binding.id].components.clickEventBinding!.deviceSlots[0].deviceType!.thumbnailUrl, undefined);
});
test('缺失模型未成功恢复时不能清空槽位或继续发布', () => {
  const { scene } = fixture();
  const before = structuredClone(scene);
  assert.throws(() => repairPublishSceneModels(scene, { replacements: [] }), /仍无可用场景模型/);
  assert.deepEqual(scene, before);
});

test('新主文件改名且旧工程快照仍存在时，阻止只让部分实例命中事件', () => {
  const { scene } = fixture(true);
  const missing = document.createModelEntity('old', url('missing'), '缺失共享模型');
  scene.entities[missing.id] = missing; scene.entityIds.push(missing.id);
  assert.throws(() => repairPublishSceneModels(scene, { replacements: [{ sourceUrls: [url('missing')], asset: {
    ...asset, sourceUrl: url('shared', 'renamed.glb'),
  } }] }), /主文件已改名/);
});
