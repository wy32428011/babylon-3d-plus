import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { NullEngine, Scene, TransformNode } from '@babylonjs/core';

const server = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true }, ssr: { noExternal: ['@linkiez/dxf-renew'] } });
after(() => server.close());
const { SceneRuntime } = await server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
const { ExternalModelScriptRuntime } = await server.ssrLoadModule('/src/runtime/babylon/ExternalModelScriptRuntime.ts');
const telemetry = await server.ssrLoadModule('/src/runtime/babylon/telemetry/specialized/specializedModelAssets.ts');
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
