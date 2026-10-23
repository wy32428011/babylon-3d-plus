import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FreeCamera, Matrix, MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

const output = await mkdtemp(path.resolve('node_modules/.scene-model-statistics-'));
after(async () => {
  assert.equal(path.dirname(output), path.resolve('node_modules'));
  assert.ok(path.basename(output).startsWith('.scene-model-statistics-'));
  await rm(output, { recursive: true, force: true });
});
await build({ configFile: false, logLevel: 'error', ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: true, outDir: output, rollupOptions: { input: {
    runtime: 'src/runtime/babylon/SceneRuntime.ts',
    document: 'src/editor/model/SceneDocument.ts',
    effects: 'src/runtime/babylon/effects/TargetModelEffects.ts',
  }, output: { entryFileNames: '[name].mjs' } } } });
const [{ SceneRuntime }, documentModel, { TargetModelEffects }] = await Promise.all(['runtime', 'document', 'effects'].map(name =>
  import(pathToFileURL(path.join(output, name + '.mjs')).href)));
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  new FreeCamera('camera', new Vector3(0, 0, -10), scene);
  const runtime = new SceneRuntime(scene);
  const document = documentModel.createEmptySceneDocument();
  runtime.sync(document);
  return { scene, runtime, document, dispose() {
    // 手工登记的几何夹具不含业务遥测状态；清除登记后由 Scene 统一释放真实网格。
    runtime.assets.models.clear(); runtime.outputs.generatedOutputOwners.clear(); runtime.outputs.spawnedDeviceModels.clear();
    runtime.variants.modelArrayParameterVariants.clear(); runtime.fetch.locatorFetchRuntimes.clear();
    runtime.dispose(); scene.dispose(); engine.dispose();
  } };
}

function model(scene: Scene, name: string, triangles = 12) {
  const root = new TransformNode(name, scene);
  const contentRoot = new TransformNode(name + '-content', scene); contentRoot.parent = root;
  const mesh = triangles === 2 ? MeshBuilder.CreatePlane(name + '-mesh', {}, scene) : MeshBuilder.CreateBox(name + '-mesh', {}, scene);
  mesh.parent = contentRoot;
  return { root, contentRoot, meshes: [mesh], measurementReady: true, assetHandle: {}, modelArraySuspendedMeshes: new Set(),
    externalScriptRuntime: null, entitySnapshot: { id: name, components: {} }, mesh };
}

test('真实运行时同步内置模型后推送统计，根隐藏、相机和选区变化保持面数', async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.runtime.getModelStatistics(), { sceneId: f.document.id, phase: 'ready', modelTriangleCount: 0, environmentTriangleCount: 0 });
    const entity = documentModel.createMeshEntity('cube');
    f.document.entityIds.push(entity.id); f.document.entities[entity.id] = entity;
    const snapshots: any[] = []; f.runtime.readiness.onModelStatisticsChanged = (value: any) => snapshots.push(value);
    f.runtime.sync(f.document); await flush();
    assert.equal(snapshots.at(-1).modelTriangleCount, 12);
    f.runtime.presentation.meshes.get(entity.id).setEnabled(false);
    f.scene.activeCamera!.position.x = 100;
    f.runtime.syncSelection(f.document, [entity.id]);
    assert.equal(f.runtime.getModelStatistics().modelTriangleCount, 12);
    assert.equal(snapshots.length, 1);
  } finally { f.dispose(); }
});

test('逻辑阵列全量及参数变体不受渲染可见实例数与根隐藏影响，内部关闭部件排除', () => {
  const f = fixture();
  try {
    const base = model(f.scene, 'source'), variant = model(f.scene, 'variant', 2);
    const source = { id: 'source', components: { modelAsset: {}, modelArray: { items: [{}, {}] } } };
    base.entitySnapshot = source;
    f.runtime.assets.models.set('source', base);
    for (const id of ['copy-a', 'copy-b', 'copy-c']) f.runtime.arrays.modelArrayInstanceEntities.set(id, { id, components: { modelArrayInstance: { sourceEntityId: 'source' } } });
    const v = { sourceEntityId: 'source', entities: [{ id: 'copy-b' }, { id: 'copy-c' }], model: variant };
    f.runtime.variants.modelArrayParameterVariants.set('variant', v);
    f.runtime.variants.modelArrayParameterVariantByEntityId.set('copy-b', v);
    base.root.setEnabled(false); variant.root.setEnabled(false);
    base.modelArrayBatch = { meshes: [MeshBuilder.CreateBox('render-batch', {}, f.scene)] };
    base.modelArrayBatch.meshes[0].thinInstanceSetBuffer('matrix', Matrix.Identity().toArray(), 16, true);
    base.modelArrayBatch.meshes[0].thinInstanceCount = 0;
    assert.equal(f.runtime.getModelStatistics().modelTriangleCount, 52); // (source + copy-a + 2 legacy) * 12 + 2 * 2
    variant.mesh.setEnabled(false); f.runtime.readiness.invalidateModelStatistics();
    assert.equal(f.runtime.getModelStatistics().modelTriangleCount, 48);
    f.runtime.assets.models.clear(); f.runtime.variants.modelArrayParameterVariants.clear();
  } finally { f.dispose(); }
});

test('生成物按真实输出及回退货箱计数，组合阵列源宿主和辅助对象不重复', () => {
  const f = fixture();
  try {
    const generated = model(f.scene, 'generated');
    f.runtime.outputs.generatedOutputOwners.set('cargo', { entityId: 'cargo', output: { kind: 'model', model: generated } });
    const source = model(f.scene, 'composition-source');
    const batch = MeshBuilder.CreatePlane('composition-batch', {}, f.scene);
    batch.thinInstanceSetBuffer('matrix', Float32Array.from([...Matrix.Identity().toArray(), ...Matrix.Identity().toArray()]), 16, true);
    f.runtime.outputs.generatedOutputOwners.set('composition', { entityId: 'composition', output: { kind: 'composition', members: [{ model: source, arrayBatch: { meshes: [batch] } }] } });
    const cargo: any = { root: new TransformNode('fallback', f.scene), assetCode: 'device', containerCode: 'box', fallback: null };
    f.runtime.outputs.ensureGeneratedCargoFallback(cargo, 'conveyor');
    MeshBuilder.CreateBox('unregistered-editor-helper', {}, f.scene);
    assert.equal(f.runtime.getModelStatistics().modelTriangleCount, 28);
    f.runtime.outputs.disposeGeneratedCargoFallback(cargo);
    assert.equal(f.runtime.getModelStatistics().modelTriangleCount, 16);
    f.runtime.outputs.generatedOutputOwners.clear();
  } finally { f.dispose(); }
});

test('加载与失败状态独立于面数，并聚合环境模型、动态设备及Fetch真实货物', () => {
  const f = fixture();
  try {
    const device = model(f.scene, 'spawned'); f.runtime.outputs.spawnedDeviceModels.set('device', device);
    const fetchRuntime = { getTriangleStatistics: () => ({ triangleCount: 24, phase: 'ready' }) };
    f.runtime.fetch.locatorFetchRuntimes.set('fetch', fetchRuntime);
    const environment = { phase: 'ready', statistics: { triangleCount: 100 } };
    f.runtime.environment.environmentRuntime.getSnapshot = () => environment;
    assert.deepEqual(f.runtime.getModelStatistics(), { sceneId: f.document.id, phase: 'ready', modelTriangleCount: 36, environmentTriangleCount: 100 });
    device.measurementReady = false; f.runtime.readiness.invalidateModelStatistics();
    assert.equal(f.runtime.getModelStatistics().phase, 'loading');
    device.readinessError = 'broken script'; f.runtime.readiness.invalidateModelStatistics();
    assert.equal(f.runtime.getModelStatistics().phase, 'error');
    delete device.readinessError; device.measurementReady = true; environment.phase = 'loading'; f.runtime.readiness.invalidateModelStatistics();
    assert.equal(f.runtime.getModelStatistics().phase, 'loading');
    environment.phase = 'error'; f.runtime.readiness.invalidateModelStatistics();
    assert.equal(f.runtime.getModelStatistics().phase, 'error');
    f.runtime.outputs.spawnedDeviceModels.clear(); f.runtime.fetch.locatorFetchRuntimes.clear();
  } finally { f.dispose(); }
});

test('脚本新增与销毁几何通过场景事件刷新，实例特效替身保留原模型面数', async () => {
  const f = fixture();
  const effects = new TargetModelEffects(f.scene, () => f.runtime.assets.models.get('scripted')?.root ?? null);
  try {
    const imported = model(f.scene, 'scripted'); f.runtime.assets.models.set('scripted', imported);
    assert.equal(f.runtime.getModelStatistics().modelTriangleCount, 12);
    const snapshots: any[] = []; f.runtime.readiness.onModelStatisticsChanged = (value: any) => snapshots.push(value);
    const added = MeshBuilder.CreatePlane('script-added-part', {}, f.scene); added.parent = imported.contentRoot;
    await flush(); assert.equal(snapshots.at(-1).modelTriangleCount, 14);
    added.dispose(); await flush(); assert.equal(snapshots.at(-1).modelTriangleCount, 12);
    const instance = imported.mesh.createInstance('instance'); instance.parent = imported.contentRoot;
    imported.mesh.isVisible = false;
    const duplicate = imported.mesh.createInstance('instance'); duplicate.parent = imported.contentRoot; duplicate.setEnabled(false);
    effects.sync('effect', { effectKind: 'model-color', enabled: true, primaryColor: '#ff0000', intensity: 1, speed: 1,
      visual: { targetEntityId: 'scripted', opacity: 1 } }, true);
    const proxy = imported.contentRoot.getChildMeshes(false).find((mesh: any) => mesh.metadata?.digitalTwinEffectSourceMeshUniqueId === instance.uniqueId)!;
    assert.ok(proxy); assert.equal(instance.isEnabled(false), false);
    await flush(); assert.equal(snapshots.at(-1).modelTriangleCount, 12);
    assert.equal(f.runtime.getModelStatistics().modelTriangleCount, 12);
    const disabledGroup = new TransformNode('parameter-disabled-group', f.scene); disabledGroup.parent = imported.contentRoot;
    instance.parent = disabledGroup; proxy.parent = disabledGroup; disabledGroup.setEnabled(false);
    f.runtime.readiness.invalidateModelStatistics();
    assert.equal(f.runtime.getModelStatistics().modelTriangleCount, 0);
  } finally { effects.dispose(); f.dispose(); }
});

test('移除最后一个参数变体后清除不再适用的失败状态', () => {
  const f = fixture();
  try {
    const imported = model(f.scene, 'source');
    const entity = { id: 'source', components: { modelAsset: {} } }; imported.entitySnapshot = entity;
    f.runtime.assets.models.set('source', imported);
    f.runtime.readiness.modelReadinessErrors.set('variant:old', { entityIds: ['source', 'removed-copy'], error: 'old variant failure' });
    f.runtime.arrays.syncModelArrayBatch(entity, imported);
    assert.equal(f.runtime.readiness.modelReadinessErrors.size, 0);
    assert.equal(f.runtime.getModelStatistics().phase, 'ready');
    assert.equal(f.runtime.getModelStatistics().modelTriangleCount, 12);
  } finally { f.dispose(); }
});

test('参数变体尚未加载成功时不把源模型面数冒充该变体的已加载面数', () => {
  const f = fixture();
  try {
    const imported = model(f.scene, 'source');
    imported.entitySnapshot.components.modelAsset = { sourceUrl: 'model.glb', parameterValues: { height: 1 } };
    f.runtime.assets.models.set('source', imported);
    f.runtime.arrays.modelArrayInstanceEntities.set('copy', { id: 'copy', components: {
      modelArrayInstance: { sourceEntityId: 'source' }, modelAsset: { sourceUrl: 'model.glb', parameterValues: { height: 2 } },
    } });
    f.runtime.readiness.modelReadinessErrors.set('variant:failed', { entityIds: ['source', 'copy'], error: 'missing parameter variant' });
    assert.equal(f.runtime.getModelStatistics().phase, 'error');
    assert.equal(f.runtime.getModelStatistics().modelTriangleCount, 12);
  } finally { f.dispose(); }
});

test('纯内置组合异步提交后结束loading并推送完整面数', async () => {
  const f = fixture();
  try {
    const owner = { entityId: 'composition-owner', loadToken: 1, activeTargetSignature: 'target', root: new TransformNode('owner', f.scene), metadata: {}, output: null };
    f.runtime.outputs.generatedOutputOwners.set(owner.entityId, owner);
    f.runtime.outputs.buildCompositionGeneratorOutput = async () => {
      const mesh = MeshBuilder.CreateBox('async-generated', {}, f.scene); mesh.parent = owner.root;
      await flush();
      return { kind: 'composition', tree: { root: owner.root }, members: [{ mesh }] };
    };
    const snapshots: any[] = []; f.runtime.readiness.onModelStatisticsChanged = (value: any) => snapshots.push(value);
    f.runtime.outputs.loadModelGeneratorCompositionOutput(owner, {}, 'target', {});
    await flush(); await flush();
    assert.equal(snapshots.at(-1).phase, 'ready');
    assert.equal(snapshots.at(-1).modelTriangleCount, 12);
    assert.ok(snapshots.some(snapshot => snapshot.phase === 'loading'));
  } finally { f.dispose(); }
});

test('配置环境尚未同步或快照仍是旧资源时不能将部分面数标成ready', () => {
  const f = fixture();
  try {
    f.document.sceneSettings.environment = { activeVariantUrl: 'new.glb' };
    f.runtime.readiness.invalidateModelStatistics();
    assert.equal(f.runtime.getModelStatistics().phase, 'loading');
    f.runtime.environment.environmentRuntime.getSnapshot = () => ({ phase: 'ready', sourceUrl: 'old.glb', statistics: { triangleCount: 100 } });
    f.runtime.readiness.invalidateModelStatistics(); assert.equal(f.runtime.getModelStatistics().phase, 'loading');
    f.runtime.environment.environmentRuntime.getSnapshot = () => ({ phase: 'ready', sourceUrl: 'new.glb', statistics: { triangleCount: 200 } });
    f.runtime.readiness.invalidateModelStatistics(); assert.equal(f.runtime.getModelStatistics().phase, 'ready');
    assert.equal(f.runtime.getModelStatistics().environmentTriangleCount, 200);
  } finally { f.dispose(); }
});

test('模型异步获取失败后主动推送error，保留已加载模型面数', async () => {
  const f = fixture();
  try {
    const entity = documentModel.createModelEntity('missing.glb', 'editor-asset://missing.glb', 'Missing');
    f.document.entityIds.push(entity.id); f.document.entities[entity.id] = entity;
    f.runtime.assets.loadModelRuntimeAssets = async () => { throw new Error('missing GLB'); };
    const snapshots: any[] = []; f.runtime.readiness.onModelStatisticsChanged = (value: any) => snapshots.push(value);
    f.runtime.sync(f.document); await flush(); await flush();
    assert.equal(snapshots.at(-1).phase, 'error');
    assert.equal(snapshots.at(-1).modelTriangleCount, 0);
    assert.ok(snapshots.some(snapshot => snapshot.phase === 'loading'));
  } finally { f.dispose(); }
});

test('无订阅不主动计算，同一批变化合并推送，读取复用缓存，销毁后不推送', async () => {
  const f = fixture();
  try {
    let computes = 0;
    const original = f.runtime.readiness.collectModelStatistics.bind(f.runtime.readiness);
    f.runtime.readiness.collectModelStatistics = () => { computes += 1; return original(); };
    f.runtime.readiness.invalidateModelStatistics(); f.runtime.readiness.invalidateModelStatistics(); await flush();
    assert.equal(computes, 0);
    const snapshots: any[] = []; f.runtime.readiness.onModelStatisticsChanged = (value: any) => snapshots.push(value);
    f.runtime.readiness.invalidateModelStatistics(); f.runtime.readiness.invalidateModelStatistics(); await flush();
    assert.equal(computes, 1); assert.equal(snapshots.length, 1);
    f.runtime.getModelStatistics(); f.runtime.getModelStatistics(); assert.equal(computes, 1);
    f.runtime.readiness.invalidateModelStatistics(); f.runtime.dispose(); await flush(); assert.equal(snapshots.length, 1);
  } finally { f.dispose(); }
});
