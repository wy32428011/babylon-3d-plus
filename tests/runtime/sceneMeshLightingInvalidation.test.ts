import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

const project = new URL('../../', import.meta.url);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href) && !context.parentURL.includes('/node_modules/')) {
    const target = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
    if (existsSync(target)) return next(target.href, context);
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (url.startsWith(project.href) && /\.(png|jpg|webp|bin)(\?.*)?$/.test(url)) return {
    format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) + ';',
  };
  return next(url, context);
} });
const { ModelAssetRuntimeController } = await import('../../src/runtime/babylon/scene-runtime/ModelAssetRuntimeController.ts');
const { SceneTriangleAndReadinessController } = await import('../../src/runtime/babylon/scene-runtime/SceneTriangleAndReadinessController.ts');
hooks.deregister();

const flushAdd = () => new Promise(resolve => setTimeout(resolve, 10));
type Lighting = { notifyMeshLifecycleChange?: (reason: string) => unknown; markDirty: (reason: string) => void };
async function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine), root = new TransformNode('root', scene);
  const mesh = MeshBuilder.CreateBox('host', {}, scene); mesh.parent = root;
  await flushAdd();
  const assets = Object.assign(Object.create(ModelAssetRuntimeController.prototype), { context: { scene } });
  const model = { contentRoot: root, meshes: [mesh], modelArraySuspendedMeshes: new Set() };
  return { scene, root, mesh, assets, model, dispose() { scene.dispose(); engine.dispose(); } };
}
function install(f: Awaited<ReturnType<typeof fixture>>, lighting: Lighting) {
  let statistics = 0;
  const readiness = Object.assign(Object.create(SceneTriangleAndReadinessController.prototype), {
    context: { scene: f.scene }, dependencies: { telemetry: { motionStaticBatchRuntime: { isTemporaryMeshEvent: () => false } },
      environment: { lightingRuntime: lighting } },
    invalidateModelStatistics() { statistics++; },
  });
  readiness.initializeModelStatisticsMeshAddedObserver(); readiness.initializeModelStatisticsMeshRemovedObserver();
  return { readiness, statistics: () => statistics };
}

test('生产suspend保留native缺席remove、用户广播与内部同步通知，不在producer预先抑制', async () => {
  const f = await fixture(), order: string[] = []; let legacyCalls = 0;
  try {
    const { statistics } = install(f, { notifyMeshLifecycleChange(reason) { order.push(reason); return 'full'; }, markDirty() { legacyCalls++; } });
    f.scene.onMeshRemovedObservable.add(() => order.push('user-removed'));
    f.assets.suspendModelArrayHost(f.model); order.push('first-return');
    f.assets.suspendModelArrayHost(f.model); order.push('second-return');
    assert.deepEqual(order, ['scene-mesh-removed', 'user-removed', 'first-return', 'scene-mesh-removed', 'user-removed', 'second-return']);
    assert.equal(statistics(), 2); assert.equal(legacyCalls, 0);
    assert.equal(f.model.modelArraySuspendedMeshes.has(f.mesh), true);
  } finally { f.dispose(); }
});

test('restore迟到add与foreign同mesh add分别转发，不消费任何异步ticket', async () => {
  const f = await fixture(), reasons: string[] = [];
  try {
    install(f, { notifyMeshLifecycleChange(reason) { reasons.push(reason); }, markDirty() { assert.fail('不应同时调用两个失效入口'); } });
    f.assets.suspendModelArrayHost(f.model); reasons.length = 0;
    f.assets.restoreModelArrayHostMeshes(f.model); f.assets.suspendModelArrayHost(f.model);
    f.scene.addMesh(f.mesh); f.scene.addMesh(f.mesh);
    assert.deepEqual(reasons, ['scene-mesh-removed']);
    await flushAdd(); assert.equal(reasons.filter(reason => reason === 'scene-mesh-added').length, 3);
  } finally { f.dispose(); }
});

test('legacy mock没有新API时仅fallback markDirty并保持receiver', async () => {
  const f = await fixture(), reasons: string[] = [];
  const lighting = { markDirty(reason: string) { assert.equal(this, lighting); reasons.push(reason); } };
  try {
    install(f, lighting);
    f.assets.suspendModelArrayHost(f.model); f.assets.suspendModelArrayHost(f.model);
    assert.deepEqual(reasons, ['scene-mesh-removed', 'scene-mesh-removed']);
  } finally { f.dispose(); }
});

test('派生光照mesh仍只失效统计，不通知分类', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const { statistics } = install(f, { notifyMeshLifecycleChange() { calls++; }, markDirty() { calls++; } });
    f.mesh.metadata = { lightingDerived: true };
    f.assets.suspendModelArrayHost(f.model); f.assets.suspendModelArrayHost(f.model);
    assert.equal(statistics(), 2); assert.equal(calls, 0);
  } finally { f.dispose(); }
});

test('未知metadata与分类getter不由producer许可探测额外读取或漏发', async () => {
  const f = await fixture(); let metadataReads = 0, classificationReads = 0;
  const source = { get classification() { classificationReads++; return []; } };
  try {
    install(f, { notifyMeshLifecycleChange() { void source.classification; return 'full'; }, markDirty() { assert.fail('错误入口'); } });
    Object.defineProperty(f.mesh, 'metadata', { configurable: true, get() { metadataReads++; return {}; } });
    f.assets.suspendModelArrayHost(f.model); f.assets.suspendModelArrayHost(f.model);
    assert.equal(metadataReads, 2); assert.equal(classificationReads, 2);
  } finally { Object.defineProperty(f.mesh, 'metadata', { configurable: true, writable: true, value: null }); f.dispose(); }
});

test('无变化refreshModelMeshes也保持unknown full，不凭meshref推断pose', async () => {
  const f = await fixture(), reasons: string[] = []; let statistics = 0;
  try {
    f.assets.dependencies = { readiness: { invalidateModelStatistics() { statistics++; } },
      environment: { lightingRuntime: { markDirty(reason: string) { reasons.push(reason); }, notifyMeshLifecycleChange() { assert.fail('未知脚本刷新不能走生命周期合并入口'); } } } };
    f.assets.refreshModelMeshes(f.model, { owner: 'host' }); f.assets.refreshModelMeshes(f.model, { owner: 'host' });
    assert.deepEqual(reasons, ['model-meshes-refresh-unknown', 'model-meshes-refresh-unknown']);
    assert.equal(statistics, 2); assert.deepEqual(f.model.meshes, [f.mesh]);
  } finally { f.dispose(); }
});

test('scene.removeMesh业务访问器仍每次只读一次，原生返回和广播不变', async () => {
  const f = await fixture(), native = f.scene.removeMesh; let reads = 0, calls = 0;
  try {
    install(f, { notifyMeshLifecycleChange() { calls++; }, markDirty() { assert.fail('错误入口'); } });
    Object.defineProperty(f.scene, 'removeMesh', { configurable: true, get() { reads++; return native; } });
    f.assets.suspendModelArrayHost(f.model); f.assets.suspendModelArrayHost(f.model);
    assert.equal(reads, 2); assert.equal(calls, 2);
  } finally { delete (f.scene as unknown as { removeMesh?: unknown }).removeMesh; f.dispose(); }
});
