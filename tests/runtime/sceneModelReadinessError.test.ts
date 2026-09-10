import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NullEngine, Scene, TransformNode } from '@babylonjs/core';

// 预编译大模块图，避免按需SSR传输超时掩盖真实运行时断言。
const output = await mkdtemp(path.resolve('node_modules/.scene-readiness-'));
const cleanup = async () => {
  assert.equal(path.dirname(output), path.resolve('node_modules'));
  assert.ok(path.basename(output).startsWith('.scene-readiness-'));
  await rm(output, { recursive: true, force: true });
};
after(cleanup);
await build({ configFile: false, logLevel: 'error', ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: true, outDir: output, rollupOptions: { input: {
    runtime: 'src/runtime/babylon/SceneRuntime.ts',
    external: 'src/runtime/babylon/ExternalModelScriptRuntime.ts',
    telemetry: 'src/runtime/babylon/telemetry/specialized/specializedModelAssets.ts',
  }, output: { entryFileNames: '[name].mjs' } } } }).catch(async error => { await cleanup(); throw error; });
const [{ SceneRuntime }, { ExternalModelScriptRuntime }, telemetry] = await Promise.all(
  ['runtime', 'external', 'telemetry'].map(name => import(pathToFileURL(path.join(output, name + '.mjs')).href)),
).catch(async error => { await cleanup(); throw error; });
const engine = new NullEngine();
const scene = new Scene(engine);
after(() => { scene.dispose(); engine.dispose(); });
const flush = () => new Promise(resolve => setImmediate(resolve));

function runtimeFixture() {
  const runtime = Object.create(SceneRuntime.prototype);
  Object.assign(runtime, { scene, models: new Map(), modelReadinessErrors: new Map(), modelArrayParameterVariants: new Map(),
    generatedOutputOwners: new Map(), selectedEntityIds: new Set(), modelLoadSequence: 0,
    loadDiagnostics: { measure: (_label: string, action: () => unknown) => action() },
    applyTransform: () => {}, applyModelUnitScale: () => {}, applyModelSelection: () => {}, applyModelInteractivity: () => {},
    restoreModelArrayHostMeshes: () => {}, syncModelScriptMetadata: () => {}, updateModelExternalScriptRuntimeContext: () => {},
    endModelArrayHostRenderSuppression: () => {}, pushLog: () => {},
    refreshModelEntityMeshes: () => {}, normalizeModelContentOrigin: () => {}, applyModelParameters: () => {},
    syncConveyorTrajectory: () => {}, scheduleModelPresentationRefresh: () => {},
    disposeModel: (id: string, model: any) => { runtime.models.delete(id); model.root.dispose(); },
  });
  return runtime;
}
function asset(revision = 'one') {
  return { assetCode: 'test', sourcePath: 'model.glb', sourceUrl: 'editor-asset://local/model.glb', assetRevision: revision,
    lengthUnit: 'm', unitScaleToMeters: 1, scriptAssets: [{ path: 'parameters.ts', sourceUrl: 'editor-asset://local/parameters.ts', name: 'parameters.ts' }] };
}
function modelFixture() {
  const root = new TransformNode('fixture', scene);
  return { root, contentRoot: root, loadToken: 1, assetHandle: {}, externalScriptRuntime: null, externalScriptSignature: '',
    externalScriptStarting: false, measurementReady: false, modelArraySuspendedMeshes: new Set(),
    stackerTelemetry: telemetry.createStackerTelemetryState(root), conveyorTelemetry: telemetry.createConveyorTelemetryState(),
    rgvTelemetry: telemetry.createRgvTelemetryState(root) };
}

test('script failure remains visible to strict readiness while local fallback stays usable; new script revision recovers', async () => {
  const runtime = runtimeFixture(), model = modelFixture();
  runtime.models.set('entity', model);
  const original = ExternalModelScriptRuntime.prototype.start;
  try {
    ExternalModelScriptRuntime.prototype.start = async () => { throw new Error('bad script'); };
    runtime.syncModelAssetExternalScripts(asset(), model, () => {});
    await flush();
    assert.equal(runtime.isModelReady('entity'), true);
    assert.match(runtime.getModelReadinessError('entity'), /bad script/);
    ExternalModelScriptRuntime.prototype.start = async () => {};
    runtime.syncModelAssetExternalScripts(asset('two'), model, () => {});
    await flush();
    assert.equal(runtime.getModelReadinessError('entity'), null);
    assert.equal(runtime.isModelReady('entity'), true);
  } finally { ExternalModelScriptRuntime.prototype.start = original; model.root.dispose(); }
});

test('explicit recovery retries the same script signature on a fresh model host without changing source or parameters', async () => {
  const runtime = runtimeFixture();
  runtime.syncedEntities = new Map(); runtime.modelArrayIdentityMode = 'render';
  const modelAsset = { ...asset('unchanged'), parameterValues: { height: 12 } };
  const entity = { id: 'entity', name: 'Model', components: { modelAsset, transform: {} } };
  const document = { entities: { entity }, entityIds: ['entity'] };
  const serialized = JSON.stringify(document);
  let attempts = 0;
  runtime.loadModelRuntimeAssets = async () => ({ kind: 'shared-instance', rootNodes: [], handle: { dispose() {} } });
  runtime.syncExternalModelScripts = (currentEntity: any, model: any) =>
    runtime.syncModelAssetExternalScripts(currentEntity.components.modelAsset, model, () => {});
  runtime.sync = () => runtime.syncModelEntity(entity, false);
  runtime.disposeModel = (id: string, model: any) => {
    model.externalScriptRuntime?.dispose(); model.root.dispose(); runtime.models.delete(id);
  };
  const original = ExternalModelScriptRuntime.prototype.start;
  try {
    ExternalModelScriptRuntime.prototype.start = async () => { if (++attempts === 1) throw new Error('temporary script read failure'); };
    runtime.syncModelEntity(entity, false);
    await flush(); await flush();
    assert.match(runtime.getModelReadinessError('entity'), /temporary script/);
    const first = runtime.models.get('entity');
    assert.equal(runtime.retryFailedSceneResources(document, []), 1);
    await flush(); await flush();
    assert.equal(attempts, 2);
    assert.notEqual(runtime.models.get('entity'), first);
    assert.equal(runtime.getModelReadinessError('entity'), null);
    assert.equal(runtime.isModelReady('entity'), true);
    assert.equal(JSON.stringify(document), serialized);
    assert.equal(runtime.retryFailedSceneResources(document, []), 0);
    assert.equal(attempts, 2);
  } finally {
    ExternalModelScriptRuntime.prototype.start = original;
    for (const model of runtime.models.values()) { model.externalScriptRuntime?.dispose(); model.root.dispose(); }
  }
});

test('failed model acquisition survives entry disposal and resets on the next version attempt', async () => {
  const runtime = runtimeFixture();
  const entity = { id: 'entity', name: 'Model', components: { modelAsset: { ...asset(), scriptAssets: [] }, transform: {} } };
  runtime.loadModelRuntimeAssets = async () => { throw new Error('missing GLB'); };
  runtime.syncModelEntity(entity, false);
  await flush();
  assert.equal(runtime.isModelReady('entity'), false);
  assert.match(runtime.getModelReadinessError('entity'), /missing GLB/);
  runtime.loadModelRuntimeAssets = async () => ({ kind: 'shared-instance', rootNodes: [], handle: { dispose() {} } });
  runtime.syncExternalModelScripts = (_entity: unknown, model: any) => { model.measurementReady = true; };
  entity.components.modelAsset.assetRevision = 'two';
  runtime.syncModelEntity(entity, false);
  await flush();
  assert.equal(runtime.getModelReadinessError('entity'), null);
  assert.equal(runtime.isModelReady('entity'), true);
  runtime.models.get('entity').root.dispose();
});

test('stale script rejection cannot poison a newer model entry', async () => {
  const runtime = runtimeFixture(), old = modelFixture(), current = modelFixture();
  runtime.models.set('entity', old);
  const original = ExternalModelScriptRuntime.prototype.start;
  let reject!: (error: Error) => void;
  try {
    ExternalModelScriptRuntime.prototype.start = () => new Promise((_resolve: unknown, rejectPromise: typeof reject) => { reject = rejectPromise; });
    runtime.syncModelAssetExternalScripts(asset(), old, () => {});
    runtime.models.set('entity', current);
    reject(new Error('stale'));
    await flush();
    assert.equal(runtime.getModelReadinessError('entity'), null);
  } finally { ExternalModelScriptRuntime.prototype.start = original; old.root.dispose(); current.root.dispose(); }
});

test('generator and array variant script errors are observable from their owning scene entity', async () => {
  const runtime = runtimeFixture(), generated = modelFixture(), variant = modelFixture();
  runtime.generatedOutputOwners.set('generated', { entityId: 'generated', editorEntityId: 'generator', output: { kind: 'model', model: generated } });
  runtime.modelArrayParameterVariants.set('variant', { sourceEntityId: 'source', representativeEntityId: 'copy', entities: [{ id: 'copy' }], model: variant });
  const original = ExternalModelScriptRuntime.prototype.start;
  try {
    ExternalModelScriptRuntime.prototype.start = async () => { throw new Error('template script'); };
    runtime.syncModelAssetExternalScripts(asset(), generated, () => {});
    runtime.syncModelAssetExternalScripts(asset(), variant, () => {});
    await flush();
    assert.match(runtime.getModelReadinessError('generator'), /template script/);
    assert.match(runtime.getModelReadinessError('source'), /template script/);
    assert.match(runtime.getModelReadinessError('copy'), /template script/);
  } finally { ExternalModelScriptRuntime.prototype.start = original; generated.root.dispose(); variant.root.dispose(); }
});

test('generator acquisition failure is exposed even after output disposal and clears for a new target', () => {
  const runtime = runtimeFixture();
  const owner = { entityId: 'generator', editorEntityId: null, entityName: 'Generator', output: null,
    loadToken: 0, failedTargetSignatures: new Set(), reportedLoadFailureKeys: new Set(), component: { defaultTarget: null } };
  runtime.generatedOutputOwners.set('generator', owner);
  runtime.applyGeneratedOutputPresentation = () => {};
  runtime.disposeModelGeneratorOutput = () => {};
  runtime.loadModelGeneratorModelOutput = () => {};
  runtime.handleModelGeneratorLoadFailure(owner, 'old', { role: 'default' }, new Error('missing template'));
  assert.match(runtime.getModelReadinessError('generator'), /missing template/);
  runtime.syncModelGeneratorResolvedTarget(owner, {
    target: { kind: 'model', assetId: 'new', displayName: 'New', modelAsset: asset('two') }, role: 'default', snapshot: null,
  });
  assert.equal(runtime.getModelReadinessError('generator'), null);
});

test('stale model acquisition rejection does not replace the current version error state', async () => {
  const runtime = runtimeFixture();
  const entity = { id: 'entity', name: 'Model', components: { modelAsset: { ...asset(), scriptAssets: [] }, transform: {} } };
  let reject!: (error: Error) => void;
  runtime.loadModelRuntimeAssets = () => new Promise((_resolve: unknown, rejectPromise: typeof reject) => { reject = rejectPromise; });
  runtime.syncModelEntity(entity, false);
  runtime.loadModelRuntimeAssets = async () => ({ kind: 'shared-instance', rootNodes: [], handle: { dispose() {} } });
  runtime.syncExternalModelScripts = (_entity: unknown, model: any) => { model.measurementReady = true; };
  entity.components.modelAsset.assetRevision = 'two';
  runtime.syncModelEntity(entity, false);
  reject(new Error('old download'));
  await flush();
  assert.equal(runtime.getModelReadinessError('entity'), null);
  assert.equal(runtime.isModelReady('entity'), true);
  runtime.models.get('entity').root.dispose();
});

test('real fetched scripts expose load, compile, onStart and onUpdate errors despite local warning fallback', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const cases = [
      { source: '', status: 404, message: /404/ },
      { source: 'export default class Broken { onStart( {', status: 200, message: /.+/ },
      { source: 'export default class Broken { onStart() { throw new Error("failed onStart"); } }', status: 200, message: /failed onStart/ },
      { source: 'export default class Broken { onUpdate() { throw new Error("failed onUpdate"); } }', status: 200, message: /failed onUpdate/ },
      { source: 'export default class Healthy { onStart() {} onUpdate() {} }', status: 200, message: null },
    ];
    for (const [index, entry] of cases.entries()) {
      globalThis.fetch = async () => new Response(entry.source, { status: entry.status });
      const runtime = runtimeFixture(), model = modelFixture();
      runtime.models.set('entity', model);
      runtime.syncModelAssetExternalScripts(asset(`real-${index}`), model, () => {});
      for (let attempt = 0; attempt < 400 && model.externalScriptStarting; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(model.externalScriptStarting, false, '真实脚本应完成加载尝试');
      if (entry.message) assert.match(runtime.getModelReadinessError('entity'), entry.message, `真实脚本失败样例 ${index}`);
      else assert.equal(runtime.getModelReadinessError('entity'), null, '正常脚本不能因编译器选项弃用提示被判为失败');
      model.root.dispose();
    }
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
});


test('Viewer资源结算全部完成也必须报告模型、参数变体、生成器和环境错误', () => {
  const runtime = runtimeFixture();
  runtime.activeModelLoadProgress = new Map();
  runtime.computeModelLoadProgress = () => ({ loading: false, percent: 1, completedCount: 164, totalCount: 164 });
  runtime.skyboxRuntime = { getReadiness: () => ({ phase: 'ready' }), getLoadDiagnostics: () => ({ stage: null, receivedBytes: 1, totalBytes: 1 }) };
  runtime.environmentRuntime = { getSnapshot: () => ({ phase: 'ready' }) };
  runtime.shadowDocument = { entities: { device: { name: '设备一' } } };
  assert.equal(runtime.getInitialLoadSnapshot().error, null);
  runtime.modelReadinessErrors.set('device', { entityIds: ['device'], error: 'HTTP 404' });
  assert.match(runtime.getInitialLoadSnapshot().error, /设备一.*HTTP 404/);
  runtime.modelReadinessErrors.clear();
  runtime.models.set('device', { externalScriptRuntime: { getInitializationError: () => 'script failed' } });
  assert.match(runtime.getInitialLoadSnapshot().error, /script failed/);
  runtime.models.clear();
  runtime.modelArrayParameterVariants.set('v', { sourceEntityId: 'device', model: { readinessError: 'variant failed' } });
  assert.match(runtime.getInitialLoadSnapshot().error, /variant failed/);
  runtime.modelArrayParameterVariants.clear();
  runtime.generatedOutputOwners.set('g', { entityId: 'device', readinessError: 'generator failed' });
  assert.match(runtime.getInitialLoadSnapshot().error, /generator failed/);
  runtime.generatedOutputOwners.clear();
  runtime.environmentRuntime.getSnapshot = () => ({ phase: 'error', message: 'environment failed' });
  assert.match(runtime.getInitialLoadSnapshot().error, /environment failed/);
  runtime.environmentRuntime.getSnapshot = () => ({ phase: 'ready' });
  runtime.skyboxRuntime.getReadiness = () => ({ phase: 'error', message: 'decode failed' });
  assert.match(runtime.getInitialLoadSnapshot().error, /decode failed/);
});
