import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ProjectOpenTraceRecorder } from '../../electron/shared/projectOpenTrace.ts';
import { SceneLoadDiagnostics } from '../../src/runtime/babylon/SceneLoadDiagnostics.ts';

const openId = '12345678-1234-4123-8123-123456789abc';
const nextId = '22345678-1234-4123-8123-123456789abc';
const recorder = (id = openId, detail: 'assets' | 'phases' = 'assets', now = () => performance.now()) =>
  new ProjectOpenTraceRecorder({ version: 1, openId: id, detail }, { clockDomain: 'renderer', now });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };

test('phase6/7 使用真实重叠边界；ready解除后续新任务绑定，已有token结束原ID', async () => {
  let now = 0;
  const diagnostics = new SceneLoadDiagnostics(() => now), trace = recorder(openId, 'assets', () => now);
  diagnostics.beginProjectOpenTrace(trace);
  const gate = deferred();
  const pending = diagnostics.measureAsync('assetReadDecode', async () => { now = 10; await gate.promise; now = 40; });
  now = 12; diagnostics.measure('modelArrayBatch', () => { now = 20; });
  now = 25; diagnostics.markProjectOpenAssetsSettled();
  now = 30; diagnostics.completeProjectOpenRuntime();
  diagnostics.measure('modelInitialize', () => { now = 31; });
  assert.equal(trace.snapshot().spans.filter(span => span.stage === 'modelInitialize').length, 0);
  gate.resolve(); await pending;
  const snapshot = trace.snapshot();
  const acquire = snapshot.spans.find(span => span.kind === 'phase' && span.phase === 'runtimeAcquireInitialize')!;
  const first = snapshot.spans.find(span => span.kind === 'phase' && span.phase === 'batchFirstReady')!;
  assert.equal(acquire.endMs, 25); assert.equal(first.startMs, 12); assert.equal(first.endMs, 30);
  assert.equal(snapshot.spans.find(span => span.stage === 'assetReadDecode')!.endMs, 40);
  assert.equal(snapshot.recording.activeSpans, 0);
  assert.equal(diagnostics.captureTrace(), null);
});

test('取消/过期保留真实收束与原异常，显式null不会回落新current；phase-only不记录asset细节', async () => {
  const diagnostics = new SceneLoadDiagnostics(), first = recorder(), second = recorder(nextId);
  diagnostics.beginProjectOpenTrace(first);
  const scope = diagnostics.captureTrace(), gate = deferred(), failure = new Error('original load failure');
  const pending = diagnostics.measureAsync('assetReadDecode', async () => { await gate.promise; throw failure; }, undefined, scope);
  diagnostics.beginProjectOpenTrace(second);
  diagnostics.measure('modelInitialize', () => 1, undefined, null);
  gate.resolve(); await assert.rejects(pending, error => error === failure);
  assert.equal(first.snapshot().spans.find(span => span.stage === 'assetReadDecode')!.status, 'stale');
  assert.equal(second.snapshot().spans.filter(span => span.kind === 'task').length, 0);
  diagnostics.completeProjectOpenRuntime('cancelled', 'aborted');
  assert.equal(second.snapshot().phases.find(phase => phase.phase === 'runtimeAcquireInitialize')!.state, 'cancelled');
  const phases = recorder(nextId, 'phases'); diagnostics.beginProjectOpenTrace(phases);
  diagnostics.measure('modelClone', () => 1);
  assert.equal(diagnostics.createAssetTrace(), undefined);
  diagnostics.markProjectOpenAssetsSettled(); diagnostics.completeProjectOpenRuntime();
  assert.equal(phases.snapshot().spans.filter(span => span.kind === 'task').length, 0);
  assert.equal(phases.snapshot().recording.activeSpans, 0);
});

const readinessSource = await readFile(new URL('../../src/runtime/babylon/scene-runtime/SceneTriangleAndReadinessController.ts', import.meta.url), 'utf8');
const readinessAst = ts.createSourceFile('readiness.ts', readinessSource, ts.ScriptTarget.Latest, true);
const readinessClass = readinessAst.statements.find(ts.isClassDeclaration)!;
const waitMethod = readinessClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(readinessAst) === 'waitForInitialRenderReady')!;
const readinessCode = ts.transpileModule(`class Harness { ${waitMethod.getText(readinessAst)} }\nHarness;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('真实readiness方法在首个await前捕获scope；后续cargo/GPU/首帧不串到新openId（CPU依赖桩）', async () => {
  const gate = deferred(), diagnostics = new SceneLoadDiagnostics(), first = recorder(), second = recorder(nextId);
  const Harness = runInNewContext(readinessCode, { DOMException, prepareGpuCapabilityProfile: async () => {}, waitForSceneRenderReady: async () => {} });
  const harness = new Harness();
  Object.assign(harness, { loadDiagnostics: diagnostics, context: { scene: { getEngine: () => ({}) } }, dependencies: {
    outputs: { generatorAssetPreloader: { waitForReady: () => gate.promise, getMetrics: () => ({ pendingCount: 0 }) } },
    document: { disposed: false }, assets: { shaderWarmup: { getMetrics: () => ({ enabled: false }) } },
  } });
  diagnostics.beginProjectOpenTrace(first);
  const pending = harness.waitForInitialRenderReady(); diagnostics.beginProjectOpenTrace(second); gate.resolve(); await pending;
  assert.deepEqual(first.snapshot().spans.filter(span => span.kind === 'task').map(span => span.stage), ['cargoReady', 'gpuCapabilityProbe', 'firstFrameValidation']);
  assert.ok(first.snapshot().spans.filter(span => span.kind === 'task').every(span => span.status === 'stale'));
  assert.equal(second.snapshot().spans.filter(span => span.kind === 'task').length, 0);
  diagnostics.completeProjectOpenRuntime('error', 'diagnostic-incomplete');
});

const scriptSource = await readFile(new URL('../../src/runtime/babylon/ExternalModelScriptRuntime.ts', import.meta.url), 'utf8');
const scriptAst = ts.createSourceFile('script.ts', scriptSource, ts.ScriptTarget.Latest, true);
const scriptClass = scriptAst.statements.find(ts.isClassDeclaration)!;
const selectedMethods = ['callLifecycle', 'beginInitializationStage', 'reportInitializationTiming'].map(name =>
  scriptClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(scriptAst) === name)!.getText(scriptAst));
const scriptCode = ts.transpileModule(`class Harness { ${selectedMethods.join('\n')} }\nHarness;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('真实脚本dispatch hook围住getter与调用，保留receiver、未完成Promise及旧callback；hook异常隔离', () => {
  const diagnostics = new SceneLoadDiagnostics(), trace = recorder(); diagnostics.beginProjectOpenTrace(trace);
  const Harness = runInNewContext(scriptCode, { performance, console: { warn() {} }, scriptLoadDiagnostics: { diagnosticFailures: 0 } });
  const events: string[] = [], unresolved = new Promise<void>(() => {}), instance = { value: 0,
    get onStart() { events.push('getter'); return function(this: { value: number }) { this.value++; events.push('invoke'); return unresolved; }; } };
  const harness = new Harness();
  harness.options = {
    onInitializationStageStart(stage: 'scriptOnStart') { events.push('begin'); const token = diagnostics.beginTraceTask(stage); return () => { events.push('end'); token?.end(); }; },
    onInitializationTiming() { events.push('legacy-timing'); },
  };
  harness.callLifecycle(instance, 'onStart', { scriptAsset: { name: 'script.ts' }, className: 'Script' });
  assert.deepEqual(events, ['begin', 'getter', 'invoke', 'end', 'legacy-timing']); assert.equal(instance.value, 1);
  assert.equal(trace.snapshot().spans.find(span => span.stage === 'scriptOnStart')!.status, 'ok');
  harness.options.onInitializationStageStart = () => { throw new Error('observer'); };
  assert.doesNotThrow(() => harness.callLifecycle(instance, 'onStart', { scriptAsset: {}, className: 'Script' }));
  harness.options.onInitializationStageStart = () => () => { throw new Error('observer end'); };
  assert.doesNotThrow(() => harness.callLifecycle(instance, 'onStart', { scriptAsset: {}, className: 'Script' }));
  assert.equal(instance.value, 3);
});

test('runtime仅依赖shared trace，公共facade保留一参兼容且dispose结束绑定', async () => {
  const source = await readFile(new URL('../../src/runtime/babylon/SceneRuntime.ts', import.meta.url), 'utf8');
  assert.match(source, /beginSceneSession\(sessionId: string, recorder\?: ProjectOpenTraceRecorder \| null\)/);
  assert.match(source, /markProjectOpenAssetsSettled\(\)/);
  assert.match(source, /completeProjectOpenRuntime\('cancelled', 'aborted'\)/);
  for (const name of ['SceneRuntime.ts', 'SceneLoadDiagnostics.ts', 'SharedModelAssetCache.ts', 'environmentAssetContainerCache.ts']) {
    const content = await readFile(new URL('../../src/runtime/babylon/' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(content, /from ['"][^'"]*editor\/loading\/projectOpenTrace/);
  }
});

test('真实skybox观察方法只绑定sync入口；切换current不抢旧异步任务，取消无事件时也结算wait（CPU依赖桩）', async () => {
  const source = await readFile(new URL('../../src/runtime/babylon/scene-runtime/EnvironmentAndSkyboxController.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('environment.ts', source, ts.ScriptTarget.Latest, true), declaration = ast.statements.find(ts.isClassDeclaration)!;
  const methods = ['syncSkyboxTarget', 'endProjectOpenSkyboxTrace', 'observeSkyboxTrace'].map(name =>
    declaration.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name)!.getText(ast));
  const Harness = runInNewContext(ts.transpileModule(`class Harness { ${methods.join('\n')} }\nHarness;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {});
  const harness = new Harness(), diagnostics = new SceneLoadDiagnostics(), first = recorder(), second = recorder(nextId);
  const loading = { phase: 'loading', sourceUrl: 'private-url' }, ready = { phase: 'ready', sourceUrl: 'private-url' };
  Object.assign(harness, { skyboxTrace: null, skyboxOperationScope: null, dependencies: { readiness: { loadDiagnostics: diagnostics } },
    skyboxRuntime: { sync() {}, getReadiness: () => loading } });
  diagnostics.beginProjectOpenTrace(first); harness.syncSkyboxTarget({});
  diagnostics.beginProjectOpenTrace(second);
  harness.observeSkyboxTrace(loading);
  assert.equal(second.snapshot().spans.filter(span => span.kind === 'task').length, 0);
  harness.observeSkyboxTrace(ready);
  assert.equal(first.snapshot().spans.find(span => span.stage === 'skyboxReady')!.status, 'stale');
  harness.syncSkyboxTarget({});
  harness.endProjectOpenSkyboxTrace('cancelled', 'aborted');
  assert.equal(second.snapshot().spans.find(span => span.stage === 'skyboxReady')!.status, 'cancelled');
  assert.equal(second.snapshot().spans.filter(span => span.kind === 'task' && !span.ended).length, 0);
  assert.equal(JSON.stringify(first.snapshot()).includes('private-url'), false);
});

const [assetControllerSource, runtimeFacadeSource] = await Promise.all([
  readFile(new URL('../../src/runtime/babylon/scene-runtime/ModelAssetRuntimeController.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../src/runtime/babylon/SceneRuntime.ts', import.meta.url), 'utf8'),
]);
function selectedClassMethods(source: string, names: string[]): string[] {
  const ast = ts.createSourceFile('methods.ts', source, ts.ScriptTarget.Latest, true), declaration = ast.statements.find(ts.isClassDeclaration)!;
  return names.map(name => declaration.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name)!.getText(ast));
}
const acquireMethods = [
  ...selectedClassMethods(assetControllerSource, ['loadModelRuntimeAssets']),
  ...selectedClassMethods(runtimeFacadeSource, ['beginSceneSession', 'getProjectOpenModelAcquisitionFailures', 'completeProjectOpenRuntime']),
];
const acquisitionCode = ts.transpileModule(`class Harness { ${acquireMethods.join('\n')} }\nHarness;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function acquisitionFixture() {
  const Harness = runInNewContext(acquisitionCode, { Error, resolveModelAssetSharedInstancingPolicy: () => ({ mode: 'shared-instance' }), createModelAssetTemplateKey: () => 'key' });
  const runtime = new Harness(), diagnostics = new SceneLoadDiagnostics();
  const readiness = { loadDiagnostics: diagnostics, failedModelAcquisitions: 0, beginModelLoadProgressUnit: () => 1, settleModelLoadProgressUnit() {} };
  let acquire = async (): Promise<unknown> => ({ entries: { animationGroups: [], rootNodes: [] }, dispose() {} });
  Object.assign(runtime, { readiness, dependencies: { readiness }, environment: { endProjectOpenSkyboxTrace() {} }, telemetry: { beginSceneSession() {} },
    resolveVersionedRuntimeAssetUrl: (source: string) => source, splitAssetUrl: () => ({ rootUrl: '', fileName: 'model.glb' }),
    sharedModelAssetCache: { instantiate: () => acquire() } });
  return { runtime, diagnostics, readiness, setAcquire: (next: typeof acquire) => { acquire = next; },
    load: () => runtime.loadModelRuntimeAssets({ sourceUrl: 'model.glb' }, 'signature') };
}

test('同runtime A失败后B成功只读取B的captured open计数，旧lifetime失败数保持累计', async () => {
  const f = acquisitionFixture(), first = recorder(), second = recorder(nextId);
  assert.equal(f.runtime.getProjectOpenModelAcquisitionFailures('A'), null);
  f.runtime.beginSceneSession('A', first);
  let reads = 0;
  const failure = new Error('original A failure');
  Object.defineProperty(failure, 'name', { get() { reads++; return 'AssetError'; } });
  f.setAcquire(async () => { throw failure; });
  await assert.rejects(f.load(), error => error === failure);
  assert.equal(reads, 1, '复用原nonAbort判定，不为新counter再次读取error.name getter');
  assert.equal(f.runtime.getProjectOpenModelAcquisitionFailures('A'), 1);
  assert.equal(f.readiness.failedModelAcquisitions, 1);
  f.runtime.beginSceneSession('B', second);
  f.setAcquire(async () => ({ entries: { animationGroups: [], rootNodes: [] }, dispose() {} }));
  await f.load();
  Object.defineProperty(second, 'snapshot', { value() { throw new Error('getter must not build a snapshot'); } });
  assert.equal(f.runtime.getProjectOpenModelAcquisitionFailures('B'), 0);
  assert.equal(f.runtime.getProjectOpenModelAcquisitionFailures('A'), null);
  assert.equal(f.runtime.getProjectOpenModelAcquisitionFailures('unknown'), null);
  assert.equal(f.readiness.failedModelAcquisitions, 1);
  f.runtime.completeProjectOpenRuntime();
  assert.equal(f.runtime.getProjectOpenModelAcquisitionFailures('B'), null);
});

test('A晚到非Abort失败只写旧captured scope；B自己的失败才使B计数增加', async () => {
  const f = acquisitionFixture(), first = recorder(), second = recorder(nextId), gate = deferred();
  f.runtime.beginSceneSession('A', first);
  const aScope = f.diagnostics.captureTrace()!;
  const oldFailure = new Error('late A failure');
  f.setAcquire(async () => { await gate.promise; throw oldFailure; });
  const late = f.load();
  f.runtime.beginSceneSession('B', second);
  f.setAcquire(async () => ({ entries: { animationGroups: [], rootNodes: [] }, dispose() {} }));
  await f.load();
  gate.resolve(); await assert.rejects(late, error => error === oldFailure);
  assert.equal(aScope.modelAcquisitionFailures, 1);
  assert.equal(f.runtime.getProjectOpenModelAcquisitionFailures('B'), 0);
  assert.equal(f.readiness.failedModelAcquisitions, 1);
  const ownFailure = new Error('B failure'); f.setAcquire(async () => { throw ownFailure; });
  await assert.rejects(f.load(), error => error === ownFailure);
  assert.equal(f.runtime.getProjectOpenModelAcquisitionFailures('B'), 1);
  assert.equal(f.readiness.failedModelAcquisitions, 2);
});

test('AbortError保留原异常且不增加两个counter；无open/null不伪造零值也不丢累计失败', async () => {
  const f = acquisitionFixture(); f.runtime.beginSceneSession('A', recorder());
  let reads = 0;
  const aborted = new Error('original abort'); Object.defineProperty(aborted, 'name', { get() { reads++; return 'AbortError'; } });
  f.setAcquire(async () => { throw aborted; });
  await assert.rejects(f.load(), error => error === aborted);
  assert.equal(reads, 1); assert.equal(f.runtime.getProjectOpenModelAcquisitionFailures('A'), 0);
  assert.equal(f.readiness.failedModelAcquisitions, 0);
  f.runtime.beginSceneSession('B', null);
  const failure = new Error('untraced failure'); f.setAcquire(async () => { throw failure; });
  await assert.rejects(f.load(), error => error === failure);
  assert.equal(f.runtime.getProjectOpenModelAcquisitionFailures('B'), null);
  assert.equal(f.readiness.failedModelAcquisitions, 1);
});
