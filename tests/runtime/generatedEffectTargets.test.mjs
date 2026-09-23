import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { Matrix, MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

const root = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    // 此套不覆盖 CAD 解析；其浏览器专用依赖不参与运行目标生命周期。
    if (specifier === '@linkiez/dxf-renew') return { url: 'data:text/javascript,export function parseString(){throw new Error("CAD is outside this fixture")}', shortCircuit: true };
    if (specifier.startsWith('@babylonjs/')) {
      const candidate = new URL('node_modules/' + specifier + '.js', root);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
      const candidate = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && /\.(png|jpe?g|webp|gif|svg|glb|gltf)$/i.test(url)) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
    if (url.startsWith(root.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) return {
      format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
const { LocatorFetchRuntime } = await import('../../src/runtime/babylon/LocatorFetchRuntime.ts');
const { describeGeneratedEffectTarget } = await import('../../src/runtime/babylon/GeneratedEffectTargets.ts');
const { SceneRuntime } = await import('../../src/runtime/babylon/SceneRuntime.ts');
hooks.deregister();

const target = { kind: 'model', assetId: 'template', displayName: '货物模板', modelAsset: { sourcePath: 'C:/cargo.glb', sourceUrl: 'editor-asset://local/cargo.glb', lengthUnit: 'm', unitScaleToMeters: 1 } };
const generator = { defaultTarget: target, rules: [] };
const record = (code, column = 1) => ({ containerCode: code, containerType: 'box', isEmpty: false, row: '1', column, layer: 1 });
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
function harness(t) {
  const engine = new NullEngine(), scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  return { scene, locator: { entityId: 'loc1' }, component: { rowNumber: 1, assetId: 'L1' }, load: async () => { const mesh = MeshBuilder.CreateBox('template', { size: 2 }, scene); return { meshes: [mesh], dispose: () => mesh.dispose() }; } };
}

test('生成模型目录区分货物与承载设备身份，模型加载/隐藏/失败不会冒充就绪', t => {
  const h = harness(t), root = new TransformNode('owner', h.scene), modelRoot = new TransformNode('model', h.scene);
  modelRoot.parent = root;
  const owner = { entityId: 'cargo-1', entityName: '货物', root, loadToken: 3, activeModelTarget: target, output: { kind: 'model', model: { root: modelRoot, assetHandle: null, meshes: [], externalScriptStarting: false } }, metadata: { containerCode: '000317', generatorEntityId: 'gen-1' }, activeSnapshot: { sourceId: 'source-a', deviceType: 'stacker', assetCode: '001' } };
  let entry = describeGeneratedEffectTarget(owner);
  assert.equal(entry.state, 'loading'); assert.equal(entry.identity, null); assert.equal(entry.containerCode, '000317'); assert.equal(entry.carrierIdentity.assetCode, '001'); assert.equal(entry.generatorId, 'gen-1');
  const mesh = MeshBuilder.CreateBox('cargo', {}, h.scene); mesh.parent = modelRoot;
  Object.assign(owner.output.model, { assetHandle: {}, meshes: [mesh] });
  assert.equal(describeGeneratedEffectTarget(owner).state, 'ready');
  owner.output.model.externalScriptRuntime = { getInitializationError: () => '初始化失败' };
  assert.equal(describeGeneratedEffectTarget(owner).state, 'error'); owner.output.model.externalScriptRuntime = null;
  root.setEnabled(false); assert.equal(describeGeneratedEffectTarget(owner).state, 'hidden'); root.setEnabled(true);
  owner.output = null; owner.readinessError = '模型载入失败'; assert.equal(describeGeneratedEffectTarget(owner).state, 'error');
  owner.activeModelTarget = null; assert.equal(describeGeneratedEffectTarget(owner), null);
});

test('fetch 模型类型目录与选中实例位姿复用原薄实例批次，抑制/清空释放代理', async t => {
  const h = harness(t), runtime = new LocatorFetchRuntime(h.scene, 'loc1'); t.after(() => runtime.dispose());
  await runtime.applyRecords([record('000317'), record('000318', 2)], h.locator, h.component, generator, (_l, col) => Matrix.Translation(col * 10, 2, 3), h.load, { generatorId: 'gen-1' });
  const entries = runtime.getEffectTargets(); assert.equal(entries.length, 2); assert.equal(entries[0].generatorId, 'gen-1'); assert.equal(entries[0].identity, null);
  const count = h.scene.transformNodes.length, meshCount = h.scene.meshes.length;
  const pose = runtime.resolveEffectTargetNode(entries[0].id); assert.ok(pose); assert.equal(h.scene.transformNodes.length, count + 1); assert.equal(h.scene.meshes.length, meshCount);
  assert.ok(pose.position.equalsWithEpsilon(new Vector3(10, 2, 3))); assert.equal(runtime.resolveEffectTargetNode(entries[0].id), pose);
  assert.equal(pose.metadata.effectBounds.minimum.x, 9); assert.equal(pose.metadata.effectBounds.maximum.x, 11);
  assert.equal(h.scene.meshes[0].thinInstanceCount, 2);
  h.scene.meshes[0].setEnabled(false); assert.equal(runtime.getEffectTargets()[0].state, 'hidden'); assert.equal(runtime.resolveEffectTargetNode(entries[0].id), null);
  h.scene.meshes[0].setEnabled(true); assert.equal(runtime.getEffectTargets()[0].state, 'ready');
  runtime.suppressCell(1, 1); await flush(); assert.equal(runtime.getEffectTargets().length, 1); assert.equal(runtime.resolveEffectTargetNode(entries[0].id), null); assert.equal(pose.isDisposed(), true);
  runtime.clearAllBatches(); assert.equal(runtime.getEffectTargets().length, 0);
});

test('fetch 加载中目录可见，预览停止后晚到模型被释放且不复活', async t => {
  const h = harness(t), runtime = new LocatorFetchRuntime(h.scene, 'loc1'); t.after(() => runtime.dispose());
  let release; const pending = new Promise(resolve => { release = resolve; });
  const applying = runtime.applyRecords([record('000317')], h.locator, h.component, generator, () => Matrix.Identity(), () => pending);
  assert.equal(runtime.getEffectTargets()[0].state, 'loading');
  runtime.clearAllBatches(); const mesh = MeshBuilder.CreateBox('late', {}, h.scene); release({ meshes: [mesh], dispose: () => mesh.dispose() }); await applying;
  assert.equal(mesh.isDisposed(), true); assert.equal(runtime.getEffectTargets().length, 0); assert.equal(h.scene.meshes.length, 0);
});

test('fetch 新请求替换期间旧模板不能覆盖新实例，内置占位模型不进入模型类型目录', async t => {
  const h = harness(t), runtime = new LocatorFetchRuntime(h.scene, 'loc1'); t.after(() => runtime.dispose());
  let release; const pending = new Promise(resolve => { release = resolve; });
  const applying = runtime.applyRecords([record('old')], h.locator, h.component, generator, () => Matrix.Identity(), () => pending);
  await runtime.applyRecords([record('new')], h.locator, h.component, generator, () => Matrix.Translation(7, 0, 0), h.load);
  const mesh = MeshBuilder.CreateBox('late', {}, h.scene); release({ meshes: [mesh], dispose: () => mesh.dispose() }); await applying;
  assert.equal(mesh.isDisposed(), true); assert.deepEqual(runtime.getEffectTargets().map(value => value.containerCode), ['new']);
  await runtime.applyRecords([record('fallback')], h.locator, h.component, null, () => Matrix.Identity(), h.load);
  assert.equal(runtime.getEffectTargets().length, 0);
});

test('真实 SceneRuntime 的货物加载、模板替换、移动、销毁与重建目录保持一致', async t => {
  const h = harness(t), runtime = new SceneRuntime(h.scene); t.after(() => runtime.dispose());
  runtime.beginTelemetryPreview();
  const pending = [];
  runtime.loadModelRuntimeAssets = () => new Promise(resolve => pending.push(resolve));
  const cargo = { root: new TransformNode('cargo-root', h.scene), assetCode: 'carrier-001', containerCode: '000317', outputOwner: null, generatorEntityId: null };
  const snapshot = { sourceId: 'a', deviceType: 'conveyor', assetCode: 'carrier-001', fields: {} };
  const gen = { entityId: 'gen', component: generator };
  runtime.syncGeneratedCargoVisual(cargo, 'conveyor', snapshot, gen);
  assert.equal(runtime.getRuntimeEffectTargets()[0].state, 'loading'); assert.equal(runtime.resolveGeneratedEffectTargetNode(cargo.outputOwner.entityId), null);
  const previousId = cargo.outputOwner.entityId;
  const targetB = { ...target, displayName: 'B', modelAsset: { ...target.modelAsset, sourcePath: 'C:/b.glb', sourceUrl: 'editor-asset://local/b.glb' } };
  runtime.syncGeneratedCargoVisual(cargo, 'conveyor', snapshot, { ...gen, component: { ...generator, defaultTarget: targetB } });
  const late = MeshBuilder.CreateBox('old-template', {}, h.scene); let oldDisposed = false;
  pending[0]({ kind: 'owned-container', meshes: [late], transformNodes: [], handle: { dispose: () => { oldDisposed = true; late.dispose(); } } }); await flush();
  assert.equal(oldDisposed, true); assert.equal(runtime.getRuntimeEffectTargets()[0].model.name, 'B');
  const current = MeshBuilder.CreateBox('current-template', {}, h.scene);
  pending[1]({ kind: 'owned-container', meshes: [current], transformNodes: [], handle: { dispose: () => current.dispose() } }); await flush();
  const entry = runtime.getRuntimeEffectTargets()[0]; assert.equal(entry.state, 'ready'); assert.equal(entry.generatorId, 'gen'); assert.equal(entry.containerCode, '000317'); assert.equal(entry.identity, null);
  cargo.root.position.x = 12; const pose = runtime.resolveGeneratedEffectTargetNode(entry.id); pose.computeWorldMatrix(true); assert.equal(pose.getAbsolutePosition().x, 12);
  runtime.disposeGeneratedCargoOutputOwner(cargo); assert.equal(runtime.getRuntimeEffectTargets().length, 0);
  runtime.syncGeneratedCargoVisual(cargo, 'conveyor', snapshot, gen); assert.notEqual(cargo.outputOwner.entityId, previousId);
  runtime.endTelemetryPreview(); assert.equal(runtime.getRuntimeEffectTargets().length, 0);
  runtime.disposeGeneratedCargoOutputOwner(cargo); cargo.root.dispose();
});
