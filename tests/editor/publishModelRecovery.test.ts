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
        identity: 'electron/shared/publishResourceIdentityMigration.ts', snapshot: 'electron/ipc/publishSceneSnapshots.ts', plan: 'electron/shared/sceneModelUpdatePlan.ts',
        serializer: 'src/editor/project/SceneSerializer.ts', click: 'src/editor/model/clickEventBinding.ts' },
      output: { entryFileNames: '[name].mjs' },
    },
  } });
  modules = await Promise.all(['repair', 'document', 'serializer', 'click', 'identity', 'snapshot', 'plan'].map(name => import(pathToFileURL(path.join(moduleRoot, name + '.mjs')).href)));
} finally {
  if (path.dirname(moduleRoot) !== path.resolve('node_modules') || !path.basename(moduleRoot).startsWith('.publish-model-recovery-')) throw new Error('测试目录无效');
  await rm(moduleRoot, { recursive: true, force: true });
}
const [{ repairPublishSceneModels }, document, { serializeScene, deserializeScene }, click] = modules;
const { applyPublishModelIdentityReplacements } = modules[4];
const { assertPublishSceneParameterTemplates, assertPublishSceneInstanceStatePreserved } = modules[5];
const { planSceneModelUpdates } = modules[6];
const url = (root: string, file = 'model.glb') => `editor-asset://local/${encodeURIComponent(`C:/${root}/Model-12-堆垛机/${file}`)}`;
const asset = { id: 'asset', name: '堆垛机', kind: 'model' as const, libraryKind: 'model' as const, path: 'C:/shared/Model-12-堆垛机/model.glb', sourceUrl: url('shared'), assetRevision: 'new' };

const unclampedConfig = { schema: 'babylon-editor.model-parameters', version: 1, parameters: [
  { key: 'height', type: 'number', defaultValue: 20, min: 0, max: 10 },
  { key: 'offset', type: 'vector3', defaultValue: { x: -5, y: 30, z: 1 }, min: 0, max: 10 },
], bindings: [] };
const configForValues = (values: Record<string, string | number>) => ({ schema: 'babylon-editor.model-parameters', version: 1,
  parameters: Object.entries(values).map(([key, defaultValue]) => ({ key, type: typeof defaultValue, defaultValue })), bindings: [] });

test('点击恢复新增真实实体采用新版原始默认值并通过权威模板校验', () => {
  const { scene } = fixture();
  const latest = { ...asset, parameterConfig: unclampedConfig };
  const result = repairPublishSceneModels(scene, { replacements: [{ sourceUrls: [url('old')], asset: latest }] });
  const model = Object.values(result.scene.entities).find((entity: any) => entity.components.modelAsset) as any;
  assert.equal(result.addedCount, 1);
  assert.deepEqual(model.components.modelAsset.parameterValues, { height: 20, offset: { x: -5, y: 30, z: 1 } });
  const previous = serializeScene(scene), next = serializeScene(result.scene);
  assert.doesNotThrow(() => assertPublishSceneParameterTemplates(previous, next, new Map([[latest.sourceUrl, latest]])));
  assert.doesNotThrow(() => assertPublishSceneInstanceStatePreserved(previous, next));
});

test('已有实例同版恢复也采用新配置，保同key显式值并删除旧key', () => {
  const { scene, model } = fixture(true);
  const revision = 'd'.repeat(64);
  Object.assign(model.components.modelAsset, { assetRevision: revision,
    parameterConfig: { ...unclampedConfig, parameters: [{ key: 'height', type: 'number', defaultValue: 1 },
      { key: 'removed', type: 'string', defaultValue: 'old' }] }, parameterValues: { height: 99, removed: 'saved' } });
  const result = repairPublishSceneModels(scene, { replacements: [{ sourceUrls: [url('project')],
    asset: { ...asset, assetRevision: revision, parameterConfig: unclampedConfig } }] });
  const actual = result.scene.entities[model.id].components.modelAsset;
  assert.deepEqual(actual.parameterValues, { height: 99, offset: { x: -5, y: 30, z: 1 } });
  assert.deepEqual(actual.parameterConfig.parameters.map((value: any) => value.key), ['height', 'offset']);
  assert.ok(result.warnings.length > 0);
});

test('恢复结果缺少新sourceKey时保留同资源可信身份，改名后保存重开仍可定向同步', () => {
  const { scene, model } = fixture(true);
  const sourceKey = 'b'.repeat(64);
  model.components.modelAsset.dataPlatformModel = { sourceKey, kind: 'model', resourceId: '12', modelPath: 'model.glb' };
  const result = repairPublishSceneModels(scene, { replacements: [{ sourceUrls: [url('project')], asset: {
    ...asset, sourceUrl: url('shared', 'renamed.glb'), path: 'C:/shared/Model-12-堆垛机/renamed.glb',
  } }] });
  const loaded = deserializeScene(serializeScene(result.scene));
  assert.deepEqual(loaded.entities[model.id].components.modelAsset.dataPlatformModel,
    { sourceKey, kind: 'model', resourceId: '12', modelPath: 'renamed.glb' });
  assert.equal(planSceneModelUpdates(loaded, sourceKey, { requireSourceIdentity: true }).length, 1);
});

test('跨ID身份迁移后的完整实例继续采用新版参数与脚本，同时保留迁移身份及业务字段', () => {
  const { scene, recovery, current, replacement } = identityFixture();
  Object.assign(current, { lengthUnit: 'meter', unitScaleToMeters: 1, parameterConfig: configForValues({ width: 1, pathText: '' }) });
  current.scriptPaths = ['C:/old/Model-12-old/removed.ts'];
  current.scriptAssets = [{ name: 'removed.ts', path: current.scriptPaths[0], sourceUrl: url('old', 'removed.ts'), enabled: false }];
  replacement.parameterConfig = configForValues({ width: 20, added: 3 });
  const result = repairPublishSceneModels(scene, recovery);
  const actual = result.scene.entities.model.components.modelAsset;
  assert.deepEqual(actual.parameterValues, { width: 7, added: 3 });
  assert.deepEqual(actual.dataPlatformModel, { sourceKey: 'd'.repeat(64), kind: 'model', resourceId: '34', modelPath: 'model.glb' });
  assert.equal(result.scene.entities.model.id, scene.entities.model.id);
  assert.deepEqual(result.scene.entities.model.components.transform, scene.entities.model.components.transform);
  assert.deepEqual(actual.scriptAssets, replacement.scriptAssets);
  assert.equal(result.restoredCount, 1);
});

function identityFixture() {
  const oldRoot = 'C:/old/Model-12-old', nextRoot = 'C:/new/Model-34-new';
  const toUrl = (p: string) => 'editor-asset://local/' + encodeURIComponent(p);
  const revision = 'a'.repeat(64);
  const current = { sourcePath: oldRoot + '/model.glb', sourceUrl: toUrl(oldRoot + '/model.glb'), assetRevision: revision,
    sourceSnapshot: { contentSha256: 'b'.repeat(64) }, dataPlatformModel: { resourceId: '12', sourceKey: 'old' },
    parameterValues: { pathText: oldRoot + '/model.glb', width: 7 }, parameterScriptMetadata: [{ custom: 5 }],
    animationScriptMetadata: [{ speed: 4 }], scriptPaths: [oldRoot + '/logic/run.js'],
    scriptAssets: [{ name: 'run', path: oldRoot + '/logic/run.js', sourceUrl: toUrl(oldRoot + '/logic/run.js'), enabled: false }] };
  const scene: any = { id: 'scene', entityIds: ['model', 'click'], entities: {
    model: { id: 'model', components: { modelAsset: current, transform: { x: 7 }, modelArray: { count: 12 } } },
    click: { id: 'click', components: { clickEventBinding: { deviceSlots: [{ deviceType: {
      sourcePath: 'C:/snapshot/Model-12-copy/model.glb', sourceUrl: toUrl('C:/snapshot/Model-12-copy/model.glb'), displayName: 'original device' } }] } } },
  } };
  const replacement: any = { ...asset, id: nextRoot + '/model.glb', path: nextRoot + '/model.glb', sourceUrl: toUrl(nextRoot + '/model.glb'),
    packagePath: nextRoot, assetRevision: revision, dataPlatformSourceKey: 'd'.repeat(64), dataPlatformResourceId: '34', scriptPaths: [nextRoot + '/logic/run.js'],
    scriptAssets: [{ name: 'run', path: nextRoot + '/logic/run.js', sourceUrl: toUrl(nextRoot + '/logic/run.js') }] };
  return { scene, replacement, recovery: { replacements: [{ sourceUrls: [current.sourceUrl], asset: replacement }] }, current, nextRoot };
}

test('跨ID同内容身份迁移保留配置和实体，主进程与renderer一致', () => {
  const { scene, recovery, nextRoot } = identityFixture();
  const original = JSON.stringify({ version: 5, scene });
  const migrated = JSON.parse(applyPublishModelIdentityReplacements(original, recovery)).scene;
  const rendered = repairPublishSceneModels(scene, recovery).scene;
  assert.deepEqual(rendered, migrated);
  const changed = migrated.entities.model.components.modelAsset;
  assert.equal(changed.sourcePath, nextRoot + '/model.glb');
  assert.equal(changed.scriptPaths[0], nextRoot + '/logic/run.js');
  assert.equal(changed.scriptAssets[0].enabled, false);
  assert.equal(changed.parameterValues.pathText, 'C:/old/Model-12-old/model.glb');
  assert.deepEqual(changed.parameterScriptMetadata, [{ custom: 5 }]);
  assert.deepEqual(changed.animationScriptMetadata, [{ speed: 4 }]);
  assert.equal(changed.sourceSnapshot, undefined);
  assert.deepEqual(changed.dataPlatformModel, { sourceKey: 'd'.repeat(64), kind: 'model', resourceId: '34', modelPath: 'model.glb' });
  assert.deepEqual(migrated.entityIds, scene.entityIds);
  assert.equal(migrated.entities.click.components.clickEventBinding.deviceSlots[0].deviceType.sourcePath, nextRoot + '/model.glb');
  assert.equal(JSON.stringify({ version: 5, scene }), original);
});

test('身份迁移拒绝不同内容版本和没有模型映射的点击设备替换', () => {
  const { scene, recovery, replacement } = identityFixture();
  replacement.assetRevision = 'c'.repeat(64);
  assert.throws(() => applyPublishModelIdentityReplacements(JSON.stringify({ version: 5, scene }), recovery), /版本|修订/);
  const other = identityFixture();
  delete other.scene.entities.model;
  assert.throws(() => applyPublishModelIdentityReplacements(JSON.stringify({ version: 5, scene: other.scene }), other.recovery), /模型|映射/);
});

test('身份迁移按包内脚本路径匹配，同名不同目录不会误配', () => {
  const { scene, recovery, replacement, nextRoot } = identityFixture();
  replacement.scriptAssets.unshift({ name: 'run', path: nextRoot + '/other/run.js', sourceUrl: 'wrong' });
  const changed = JSON.parse(applyPublishModelIdentityReplacements(JSON.stringify({ version: 5, scene }), recovery)).scene.entities.model.components.modelAsset;
  assert.equal(changed.scriptAssets[0].path, nextRoot + '/logic/run.js');
});

test('身份迁移更新生成器target外层资源字段，保留生成规则与业务文本', () => {
  const { scene, recovery, current, nextRoot } = identityFixture();
  const target = { kind: 'model', assetId: 'old-asset', packagePath: 'C:/old/Model-12-old',
    metadataPath: 'C:/old/Model-12-old/meta.json', scriptPaths: ['C:/old/Model-12-old/logic/run.js'],
    modelAsset: structuredClone(current), businessText: 'C:/old/Model-12-old' };
  scene.entities.model.components.modelGenerator = { rules: [{ rule: { count: 4 }, target }] };
  const migrated = JSON.parse(applyPublishModelIdentityReplacements(JSON.stringify({ scene }), recovery)).scene;
  const result = migrated.entities.model.components.modelGenerator.rules[0];
  assert.equal(result.target.packagePath, nextRoot);
  assert.equal(result.target.scriptPaths[0], nextRoot + '/logic/run.js');
  assert.equal(result.target.businessText, 'C:/old/Model-12-old');
  assert.deepEqual(result.rule, { count: 4 });
});

test('点击设备保留不同内容版本时拒绝身份迁移', () => {
  const { scene, recovery } = identityFixture();
  scene.entities.click.components.clickEventBinding.deviceSlots[0].deviceType.assetRevision = 'c'.repeat(64);
  assert.throws(() => applyPublishModelIdentityReplacements(JSON.stringify({ scene }), recovery), /点击设备.*修订/);
});
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
  const result = repairPublishSceneModels(scene, { replacements: [{ sourceUrls: [url('project')], asset: {
    ...asset, sourceUrl: url('shared', 'renamed.glb'), parameterConfig: configForValues({ width: 9 }),
  } }] });
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

test('同版生成器恢复采用新版脚本配置，保留实例参数、名称和生成器外层业务字段', () => {
  const scene = document.createEmptySceneDocument();
  const generator = document.createModelGeneratorEntity();
  const revision = 'a'.repeat(64);
  const template = document.createModelEntity('C:/old/Model-12-堆垛机/model.glb', url('old'), '原模型').components.modelAsset!;
  template.assetRevision = revision;
  template.parameterValues = { width: 0, path: 'D:/old/must-stay' };
  template.parameterScriptMetadata = [{ scriptFilename: 'model.ts', values: { width: { value: 0 } } }];
  template.animationScriptMetadata = [{ scriptFilename: 'model.ts', values: { speed: { value: 9 } } }];
  template.dataDrivenConfig = { customBusiness: 'keep' };
  (template as any).packagePath = 'D:/old/package';
  (template as any).metadataPath = 'D:/old/package/meta.json';
  generator.components.modelGenerator!.defaultTarget = { kind: 'model', assetId: 'D:/old/id', displayName: '保留名称',
    packagePath: 'D:/old/package', thumbnailUrl: url('old', 'thumbnail.png'), modelAsset: template };
  scene.entities[generator.id] = generator; scene.entityIds.push(generator.id);
  const nextAsset = { ...asset, assetRevision: revision, packagePath: 'C:/shared/Model-12-堆垛机',
    parameterConfig: configForValues({ width: 4, path: 'new default' }),
    metadataPath: 'C:/shared/Model-12-堆垛机/meta.json', thumbnailUrl: url('shared', 'thumbnail.png'),
    scriptAssets: [{ name: 'inactive.ts', path: 'C:/shared/Model-12-堆垛机/inactive.ts', sourceUrl: url('shared', 'inactive.ts') }],
    parameterScriptMetadata: [{ scriptFilename: 'model.ts', values: { width: { value: 4 } } }],
    animationScriptMetadata: [{ scriptFilename: 'model.ts', values: { speed: { value: 3 } } }],
  };
  const before = structuredClone(scene);
  const repaired = repairPublishSceneModels(scene, { replacements: [{ sourceUrls: [url('old')], asset: nextAsset }] });
  const target = repaired.scene.entities[generator.id].components.modelGenerator!.defaultTarget!;
  assert.equal(target.packagePath, nextAsset.packagePath); assert.equal(target.assetId, nextAsset.id);
  assert.equal(target.thumbnailUrl, nextAsset.thumbnailUrl); assert.equal(target.displayName, '保留名称');
  assert.equal((target.modelAsset as any).packagePath, nextAsset.packagePath);
  assert.equal((target.modelAsset as any).metadataPath, nextAsset.metadataPath);
  assert.deepEqual(target.modelAsset.parameterScriptMetadata, nextAsset.parameterScriptMetadata);
  assert.deepEqual(target.modelAsset.animationScriptMetadata, nextAsset.animationScriptMetadata);
  assert.deepEqual(target.modelAsset.parameterValues, template.parameterValues);
  assert.deepEqual(target.modelAsset.scriptAssets, nextAsset.scriptAssets, '同版恢复也采用新版脚本清单');
  assert.equal(target.modelAsset.dataDrivenConfig, undefined);
  assert.deepEqual(scene, before);
});

test('恢复脚本清单直接采用新版，不按旧脚本匹配，参数内同名路径不改变', () => {
  const { scene, model } = fixture(true);
  const revision = 'b'.repeat(64), oldScript = 'C:/project/Model-12-堆垛机/model.ts', nextScript = 'C:/shared/Model-12-堆垛机/model.ts';
  const template = model.components.modelAsset!;
  template.assetRevision = revision;
  template.scriptAssets = [{ path: oldScript, sourceUrl: url('project', 'model.ts'), name: 'model.ts' }];
  (template as any).scriptPaths = [oldScript];
  template.parameterValues = { path: oldScript, sourcePath: oldScript };
  const result = repairPublishSceneModels(scene, { replacements: [{ sourceUrls: [url('project')], asset: {
    ...asset, assetRevision: revision, scriptPaths: [nextScript, 'C:/shared/Model-12-堆垛机/inactive.ts'],
    parameterConfig: configForValues({ path: 'new default', sourcePath: 'new default' }),
    scriptAssets: [{ name: 'model.ts', path: nextScript, sourceUrl: url('shared', 'model.ts') }],
  } }] });
  const repaired = result.scene.entities[model.id].components.modelAsset!;
  assert.deepEqual((repaired as any).scriptPaths, [nextScript, 'C:/shared/Model-12-堆垛机/inactive.ts']);
  assert.equal(repaired.scriptAssets![0].path, nextScript);
  assert.deepEqual(repaired.parameterValues, template.parameterValues);
  assert.deepEqual((template as any).scriptPaths, [oldScript]);
});
