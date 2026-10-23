import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { AssetContainer, FreeCamera, MeshBuilder, NullEngine, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(url) && existsSync(new URL(url.href.replace(/\.js$/, '') + '.ts'))) return next(url.href.replace(/\.js$/, '') + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && /\.(png|jpg|webp|bin)(\?.*)?$/.test(url)) return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) + ';' };
    if (url.startsWith(root.href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({ DEV: false, BASE_URL: \'/\' })'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { SceneRuntime } = await import('../../src/runtime/babylon/SceneRuntime.ts');
const { createEmptySceneDocument, createModelGeneratorEntity } = await import('../../src/editor/model/SceneDocument.ts');
hooks.deregister();
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const transform = (x = 0) => ({ position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
const document = entities => ({ ...createEmptySceneDocument(), entityIds: entities.map(e => e.id), entities: Object.fromEntries(entities.map(e => [e.id, e])) });
const target = (name, extra = {}) => ({ kind: 'model', assetId: name, displayName: name,
  modelAsset: { sourceUrl: 'editor-asset://local/' + name + '.glb', sourcePath: name + '.glb', assetRevision: 'r1', lengthUnit: 'meter', unitScaleToMeters: 1, ...extra } });
function generator(defaultTarget, ruleTargets = []) {
  const entity = createModelGeneratorEntity();
  entity.components.modelGenerator = { defaultTarget, rules: ruleTargets.map((value, index) => ({ id: 'rule-' + index, attributeName: 'kind', attributeValue: String(index), target: value })) };
  return entity;
}
function setup(t) {
  const engine = new NullEngine(), scene = new Scene(engine);
  new FreeCamera('camera', new Vector3(0, 5, -10), scene);
  const logs = [], reads = [], sources = [];
  const runtime = new SceneRuntime(scene, message => logs.push(message));
  let read = async () => undefined;
  runtime.assets.loadAssetContainer = (rootUrl, fileName, signal) => runtime.readiness.loadDiagnostics.measureAsync('assetReadDecode', async () => {
    reads.push(fileName.split(/[?#]/)[0]);
    await read(fileName.split(/[?#]/)[0], signal);
    const source = new AssetContainer(scene);
    const mesh = MeshBuilder.CreateBox('cargo-source', { updatable: true }, scene);
    const material = new StandardMaterial('cargo-material', scene);
    mesh.material = material;
    source.meshes.push(mesh); source.geometries.push(mesh.geometry); source.materials.push(material); source.rootNodes.push(mesh);
    source.removeAllFromScene(); sources.push(source);
    return source;
  }, fileName);
  const scriptSync = runtime.assets.syncModelGeneratorExternalScripts.bind(runtime.assets);
  let scriptStarts = 0;
  runtime.assets.syncModelGeneratorExternalScripts = (...args) => { scriptStarts++; return scriptSync(...args); };
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  return { runtime, scene, logs, reads, sources, setRead: value => { read = value; }, scriptStarts: () => scriptStarts };
}
async function until(predicate, message, scene) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message);
    if (scene) scene.render();
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
const settled = f => until(() => !f.runtime.getInitialLoadSnapshot().progress.loading, '预取未结算');
function spawn(f, entity, fields = {}) {
  const cargo = { assetCode: 'device', containerCode: 'cargo-' + f.runtime.outputs.generatedOutputOwners.size, task: '', root: new TransformNode('cargo', f.scene), outputOwner: null, fallback: null, generatorEntityId: null, handoff: null, axialLengthCache: null, lockedWorldRotation: null };
  f.runtime.outputs.syncGeneratedCargoVisual(cargo, 'conveyor', { sourceId: 'default', deviceType: 'conveyor', assetCode: 'device', fields }, f.runtime.outputs.modelGenerators.get(entity.id), 'host-device');
  return cargo;
}

test('sync 预取 default/rules 并跨生成器去重，不生成货物或启动脚本；首次出货命中模板', async t => {
  const f = setup(t);
  const a = target('box'), b = target('parametric', { parameterConfig: { parameters: [] } });
  const first = generator(a, [a, b]), second = generator(a);
  f.runtime.sync(document([first, second]));
  await flush(); await settled(f);
  assert.deepEqual(f.reads.slice().sort(), ['box.glb', 'parametric.glb'], f.logs.join('; '));
  assert.equal(f.runtime.outputs.modelGenerators.get(first.id).output, null);
  assert.equal(f.runtime.outputs.modelGenerators.get(second.id).output, null);
  assert.equal(f.scriptStarts(), 0);
  assert.equal(f.runtime.assets.sharedModelAssetCache.getMetrics().instantiationCount, 0);
  assert.equal(f.runtime.assets.sharedModelAssetCache.getMetrics().ownedCloneCount, 0);
  assert.ok(f.sources.every(source => source.meshes.every(mesh => !f.scene.meshes.includes(mesh))), '解析模板不加入渲染场景');
  const cargo = spawn(f, first);
  await until(() => cargo.outputOwner?.output?.model?.assetHandle, '首件货物未就绪');
  assert.equal(f.reads.length, 2, '首件出货不得重读预取模板');
  assert.equal(f.runtime.getPerformanceMetrics().loading.stages.assetReadDecode.count, 2);
  assert.equal(f.scriptStarts(), 1);
  f.runtime.outputs.disposeGeneratedCargo(cargo);
});

test('组合成员含阵列源复用预取模板，实际生成仍拥有相互隔离的几何', async t => {
  const f = setup(t);
  const previousWindow = globalThis.window;
  let compositionReads = 0;
  const compositionGate = deferred();
  const model = target('composition-member').modelAsset;
  const nodes = [
    { id: 'source', parentId: null, visible: true, components: { transform: transform(), modelAsset: model } },
    { id: 'copy', parentId: null, visible: true, components: { transform: transform(2), modelArrayInstance: { sourceEntityId: 'source' } } },
    { id: 'ordinary', parentId: null, visible: true, components: { transform: transform(4), modelAsset: model } },
  ];
  globalThis.window = { addEventListener() {}, removeEventListener() {}, editorApi: { loadComposition: async () => { compositionReads++; await compositionGate.promise; return { name: 'fixture', definition: { nodes } }; } } };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const entity = generator({ kind: 'composition', libraryId: 'preload-integration-array', revision: 'r1', displayName: '组合' });
  f.runtime.sync(document([entity]));
  await flush();
  assert.equal(f.runtime.getInitialLoadSnapshot().progress.loading, true, '组合定义未返回时也须参与门控');
  assert.deepEqual(f.reads, []);
  compositionGate.resolve();
  await flush(); await settled(f);
  assert.deepEqual(f.reads, ['composition-member.glb']);
  assert.equal(compositionReads, 1);
  assert.equal(f.runtime.assets.sharedModelAssetCache.getMetrics().instantiationCount, 0);
  const a = spawn(f, entity), b = spawn(f, entity);
  await until(() => a.outputOwner?.output?.kind === 'composition' && b.outputOwner?.output?.kind === 'composition', '组合未完成生成');
  const memberA = a.outputOwner.output.members.find(member => member.nodeId === 'source');
  const memberB = b.outputOwner.output.members.find(member => member.nodeId === 'source');
  assert.ok(memberA.arrayBatch && memberB.arrayBatch);
  assert.equal(memberA.model.assetHandle.kind, 'owned-container');
  assert.notEqual(memberA.model.meshes[0].geometry, memberB.model.meshes[0].geometry);
  assert.notEqual(memberA.model.meshes[0].geometry, f.sources[0].meshes[0].geometry);
  assert.equal(f.reads.length, 1, '组合阵列源不能绕开预取缓存再次读取');
  assert.equal(f.scriptStarts(), 0, '保持组合生成路径不运行成员脚本的原语义');
  f.runtime.outputs.disposeGeneratedCargo(a); f.runtime.outputs.disposeGeneratedCargo(b);
});

test('预取失败不污染首次生成重试，也不提前标记生成规则失败或阻止默认回退', async t => {
  const f = setup(t);
  let attempts = 0;
  f.setRead(async file => { if (file === 'retry.glb' && ++attempts === 1) throw new Error('temporary read failure'); });
  const entity = generator(target('retry'));
  f.runtime.sync(document([entity])); await flush(); await settled(f);
  const runtimeGenerator = f.runtime.outputs.modelGenerators.get(entity.id);
  assert.equal(attempts, 1);
  assert.equal(runtimeGenerator.failedTargetSignatures.size, 0);
  assert.equal(runtimeGenerator.readinessError, undefined);
  const retried = spawn(f, entity);
  await until(() => retried.outputOwner?.output?.model?.assetHandle, '首次生成应重试失败预取');
  assert.equal(attempts, 2);
  f.runtime.outputs.disposeGeneratedCargo(retried);
  const fallbackTarget = { kind: 'mesh', meshKind: 'cube', displayName: '默认货箱', materialColor: '#8ab4f8' };
  const fallback = generator(fallbackTarget, [target('broken')]);
  f.setRead(async file => { if (file === 'broken.glb') throw new Error('broken conditional GLB'); });
  f.runtime.sync(document([fallback])); await flush(); await settled(f);
  const cargo = spawn(f, fallback, { kind: '0' });
  await until(() => cargo.outputOwner?.output?.kind === 'mesh', '规则加载失败应使用默认目标');
  assert.equal(f.reads.filter(name => name === 'broken.glb').length, 2, '预取失败后实际生成仍有一次重试');
  f.runtime.outputs.disposeGeneratedCargo(cargo);
});

test('配置换代及删除归还旧模板 lease，旧异步结果不能污染新配置', async t => {
  const f = setup(t), oldGate = deferred();
  f.setRead(async file => { if (file === 'old.glb') await oldGate.promise; });
  const old = generator(target('old'));
  f.runtime.sync(document([old])); await flush();
  assert.deepEqual(f.reads, ['old.glb']);
  const next = structuredClone(old); next.components.modelGenerator.defaultTarget = target('new');
  f.runtime.sync(document([next])); await flush(); await settled(f);
  oldGate.resolve(); await flush();
  assert.equal(f.sources.length, 2);
  assert.equal(f.sources[0].meshes.length, 1, '新配置模板保持有效');
  assert.equal(f.sources[1].meshes.length, 0, '旧配置迟到容器应立即释放');
  assert.equal(f.runtime.assets.sharedModelAssetCache.getMetrics().entries, 1, '取消旧配置不能保留旧模板 lease');
  assert.equal(f.runtime.assets.sharedModelAssetCache.getMetrics().idleEntries, 0);
  f.runtime.sync(document([])); await flush();
  assert.equal(f.runtime.assets.sharedModelAssetCache.getMetrics().idleEntries, 1, '删除生成器应归还新模板 lease');
});

test('等待初始可渲染期间新增目标继续门控，调用方 abort 及时结束等待', async t => {
  const f = setup(t), firstGate = deferred(), secondGate = deferred();
  f.setRead(async file => { if (file === 'first.glb') await firstGate.promise; if (file === 'second.glb') await secondGate.promise; });
  const first = generator(target('first'));
  f.runtime.sync(document([first])); await flush();
  assert.equal(f.runtime.getInitialLoadSnapshot().progress.loading, true);
  let ready = false;
  const pending = f.runtime.waitForInitialRenderReady().then(() => { ready = true; });
  firstGate.resolve(); await flush();
  const second = structuredClone(first); second.components.modelGenerator.defaultTarget = target('second');
  f.runtime.sync(document([second])); await flush();
  for (let i = 0; i < 3; i++) { f.scene.render(); await flush(); }
  assert.equal(ready, false, '旧预取完成不能提前通过新目标门控');
  assert.equal(f.runtime.getInitialLoadSnapshot().progress.loading, true);
  const controller = new AbortController();
  const cancelled = f.runtime.waitForInitialRenderReady(controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  secondGate.resolve();
  await until(() => ready, '预取结算并渲染后应通过门控', f.scene);
  await pending;
  assert.equal(f.runtime.getInitialLoadSnapshot().progress.loading, false);
});

test('进度观察者抛错不取消成功预取、不泄漏模板引用或留下加载单元', async t => {
  const f = setup(t);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values);
  t.after(() => { console.warn = originalWarn; });
  f.runtime.readiness.context.onModelLoadProgress = () => { throw new Error('fixture-progress-observer'); };
  const entity = generator(target('observer'));
  f.runtime.sync(document([entity]));
  await flush();
  assert.deepEqual(f.reads, ['observer.glb'], f.logs.join('; '));
  await settled(f);
  assert.equal(f.runtime.getPerformanceMetrics().loading.cargoPreload.failedCount, 0);
  assert.equal(f.runtime.getPerformanceMetrics().loading.cargoPreload.readyAssetCount, 1);
  assert.equal(f.runtime.readiness.activeModelLoadProgress.size, 0);
  assert.ok(warnings.length > 0, '观察者异常需要显式诊断');
  f.runtime.sync(document([]));
  assert.equal(f.runtime.assets.sharedModelAssetCache.getMetrics().idleEntries, 1, '删除后模板引用必须归还');
});
