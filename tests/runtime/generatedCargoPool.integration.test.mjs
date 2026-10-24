import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Animation, AnimationGroup, AssetContainer, FreeCamera, Mesh, MeshBuilder, NullEngine, Ray, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
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
const { createEmptySceneDocument, createMeshEntity, createModelGeneratorEntity } = await import('../../src/editor/model/SceneDocument.ts');
const { readGeneratedUnitClickTarget } = await import('../../src/runtime/babylon/scene-runtime/sceneRuntimeTypes.ts');
const { parseDeviceTelemetryMessage } = await import('../../src/runtime/mqtt/deviceTelemetry.ts');
const { getLightingGeometrySignature } = await import('../../src/runtime/babylon/lightingRuntimeCapture.ts');
const { lightingGeometrySignatureCache } = await import('../../src/runtime/babylon/lightingGeometrySignatureCache.ts');
const { isTargetModelEffectSuspended, registerTargetModelEffectSuspension } = await import('../../src/runtime/babylon/effects/TargetModelEffects.ts');
hooks.deregister();

const flush = async () => { for (let index = 0; index < 5; index++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const document = entities => ({ ...createEmptySceneDocument(), entityIds: entities.map(entity => entity.id), entities: Object.fromEntries(entities.map(entity => [entity.id, entity])) });
const target = (name, extra = {}) => ({ kind: 'model', assetId: name, displayName: name,
  modelAsset: { sourceUrl: 'editor-asset://local/' + name + '.glb', sourcePath: name + '.glb', assetRevision: 'r1', lengthUnit: 'meter', unitScaleToMeters: 1, ...extra } });
function generator(defaultTarget) {
  const entity = createModelGeneratorEntity();
  entity.components.modelGenerator = { defaultTarget, rules: [] };
  return entity;
}
function telemetry(fields = {}) {
  const snapshot = parseDeviceTelemetryMessage('dt/factory/logistics/conveyor/device/twindatadriven/joint', JSON.stringify({ seq: 1,
    data: Object.entries(fields).map(([p, v]) => ({ e: 'device', p, v })) }));
  assert.ok(snapshot, '使用真实MQTT EPV解析入口产生设备快照');
  return snapshot;
}
async function until(predicate, message) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

function setup(t, { animated = false, wrapped = false, sourceMetadata } = {}) {
  const engine = new NullEngine(), scene = new Scene(engine);
  new FreeCamera('camera', new Vector3(0, 5, -10), scene);
  const logs = [], sources = [], cargos = new Set(), refreshes = [], dirtyReasons = [];
  const runtime = new SceneRuntime(scene, message => logs.push(message));
  let disposed = false, nextCargo = 0;
  // 仅替换资产获取。控制器、资源句柄、实例化、缓存和退役/提交均运行生产代码。
  runtime.assets.loadAssetContainer = async () => {
    const source = new AssetContainer(scene);
    const mesh = MeshBuilder.CreateBox('cargo-source', {}, scene);
    const material = new StandardMaterial('cargo-material', scene);
    mesh.material = material;
    mesh.metadata = sourceMetadata ? sourceMetadata() : { fixtureSource: 'cargo-source' };
    source.meshes.push(mesh); source.geometries.push(mesh.geometry); source.materials.push(material);
    if (wrapped) {
      const wrapper = wrapped === 'mesh' ? new Mesh('cargo-empty-mesh-wrapper', scene) : new TransformNode('cargo-wrapper', scene);
      mesh.parent = wrapper;
      if (wrapper instanceof Mesh) source.meshes.push(wrapper); else source.transformNodes.push(wrapper);
      source.rootNodes.push(wrapper);
    } else source.rootNodes.push(mesh);
    if (animated) {
      const animation = new Animation('cargo-position', 'position.x', 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
      animation.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: 1 }]);
      const group = new AnimationGroup('cargo-animation', scene);
      group.addTargetedAnimation(animation, mesh);
      source.animationGroups.push(group);
    }
    source.removeAllFromScene(); sources.push(source);
    return source;
  };
  const refresh = runtime.assets.refreshModelMeshes.bind(runtime.assets);
  runtime.assets.refreshModelMeshes = (model, ...args) => {
    const result = refresh(model, ...args);
    refreshes.push({ model, meshes: [...model.meshes] });
    return result;
  };
  const markDirty = runtime.environment.lightingRuntime.markDirty.bind(runtime.environment.lightingRuntime);
  runtime.environment.lightingRuntime.markDirty = reason => { dirtyReasons.push(reason); return markDirty(reason); };
  const retire = cargo => {
    runtime.outputs.disposeGeneratedCargo(cargo);
    cargos.delete(cargo);
  };
  const disposeRuntime = () => { runtime.dispose(); disposed = true; };
  t.after(() => {
    if (!disposed) {
      for (const cargo of cargos) if (!cargo.root.isDisposed()) runtime.outputs.disposeGeneratedCargo(cargo);
      disposeRuntime();
    }
    scene.dispose(); engine.dispose();
  });
  return { runtime, scene, logs, sources, refreshes, dirtyReasons, retire, disposeRuntime,
    spawn(entity, { host = 'host-A', container = 'cargo-' + ++nextCargo, fields = {} } = {}) {
      const cargo = { assetCode: 'device', containerCode: container, task: '', root: new TransformNode('cargo', scene), outputOwner: null,
        fallback: null, generatorEntityId: null, handoff: null, axialLengthCache: null, lockedWorldRotation: null };
      cargos.add(cargo);
      runtime.outputs.syncGeneratedCargoVisual(cargo, 'conveyor', telemetry(fields), runtime.outputs.modelGenerators.get(entity.id), host);
      return cargo;
    },
  };
}
function enable(f, value = true) {
  assert.equal(typeof f.runtime.outputs.setGeneratedCargoPoolingEnabled, 'function', '缺少资源池内部 A/B 开关');
  assert.equal(typeof f.runtime.outputs.getGeneratedCargoPoolMetrics, 'function', '缺少资源池真实指标入口');
  f.runtime.outputs.setGeneratedCargoPoolingEnabled(value);
}
const pool = f => f.runtime.outputs.getGeneratedCargoPoolMetrics();
const cache = f => f.runtime.assets.sharedModelAssetCache.getMetrics();
async function sync(f, entity) {
  f.runtime.sync(document(Array.isArray(entity) ? entity : [entity]));
  await until(() => !f.runtime.getInitialLoadSnapshot().progress.loading, '生成器预取未结算：' + f.logs.join('; '));
  await flush();
}
async function loaded(f, cargo) {
  await until(() => cargo.outputOwner?.output?.kind === 'model' && cargo.outputOwner.output.model.assetHandle, '货物实例未就绪：' + f.logs.join('; '));
  const model = cargo.outputOwner.output.model;
  assert.ok(model.meshes.length > 0, '就绪实例必须含真实导入网格');
  return model;
}
const physical = model => model.meshes.find(mesh => mesh.getTotalVertices() > 0);
const businessMetadata = mesh => Object.fromEntries(Object.entries(mesh.metadata ?? {}).filter(([key]) => key !== 'generatedUnitEntityId'));
function pick(f, mesh) {
  mesh.computeWorldMatrix(true);
  const center = mesh.getBoundingInfo().boundingBox.centerWorld;
  // Babylon自定义predicate会替代默认资格检查；限定目标时仍保留原enabled/visible/pickable合同。
  return f.scene.pickWithRay(new Ray(center.add(new Vector3(0, 0, -10)), Vector3.Forward()),
    candidate => candidate === mesh && candidate.isEnabled() && candidate.isVisible && candidate.isPickable);
}

test('尚未通过业务等价与净收益验收的货物池默认关闭，保留原生创建和释放', async t => {
  const f = setup(t), entity = generator(target('default-original-lifecycle'));
  assert.equal(pool(f).enabled, false);
  await sync(f, entity);
  const first = f.spawn(entity), oldMesh = physical(await loaded(f, first));
  f.retire(first);
  assert.equal(oldMesh.isDisposed(), true);
  const second = f.spawn(entity), nextMesh = physical(await loaded(f, second));
  assert.notEqual(nextMesh, oldMesh);
  assert.equal(cache(f).instantiationCount, 2);
  assert.equal(pool(f).hits, 0);
  assert.equal(pool(f).retained, 0);
  assert.equal(pool(f).idleEntries, 0);
  f.retire(second);
});

test('连续退役复用真实物理网格，但新 cargo/root/model/逻辑身份与点击宿主全部重建', async t => {
  const f = setup(t), entity = generator(target('reuse'));
  // 旧路径的真实InstancedMesh不会复制source.metadata；池不得另造一套metadata合同。
  const baseline = setup(t); enable(baseline, false); await sync(baseline, entity);
  const baselineCargo = baseline.spawn(entity, { host: 'host-new', container: 'container-new' });
  const baselineMesh = physical(await loaded(baseline, baselineCargo));
  enable(f); await sync(f, entity);
  const first = f.spawn(entity, { host: 'host-old', container: 'container-old' });
  const oldOwner = first.outputOwner, oldRoot = first.root, oldModel = await loaded(f, first), mesh = physical(oldModel);
  const oldLogicalId = oldOwner.entityId, cloneCount = cache(f).instantiationCount;
  assert.equal(pick(f, mesh).pickedMesh, mesh, '实际Scene拾取先命中活动物理网格');
  const dirtyBeforeRetire = f.dirtyReasons.length;
  f.retire(first);
  assert.equal(pool(f).idleEntries, 1, '真实已加载 shared 实例应退入池');
  assert.equal(mesh.isDisposed(), false);
  assert.equal(mesh.isEnabled(), false, '闲置资源必须不可见');
  assert.equal(mesh.isPickable, false, '闲置资源必须不可拾取');
  assert.equal(pick(f, mesh).hit, false, '闲置期间实际Scene拾取不得命中');
  assert.equal(oldRoot.isDisposed(), true); assert.equal(oldModel.root.isDisposed(), true);
  assert.equal(oldModel.contentRoot.isDisposed(), true);
  assert.ok(f.refreshes.some(record => record.model === oldModel && record.meshes.length === 0), '退池后须走真实空网格刷新');
  assert.ok(f.dirtyReasons.length > dirtyBeforeRetire, '退池需要明确通知光照结构失效');
  const second = f.spawn(entity, { host: 'host-new', container: 'container-new' });
  const next = await loaded(f, second), nextOwner = second.outputOwner;
  assert.notEqual(second, first); assert.notEqual(second.root, oldRoot); assert.notEqual(nextOwner, oldOwner);
  assert.notEqual(next, oldModel); assert.notEqual(next.root, oldModel.root); assert.notEqual(next.contentRoot, oldModel.contentRoot);
  assert.notEqual(nextOwner.entityId, oldLogicalId);
  assert.equal(physical(next), mesh, '只复用导入子树物理 mesh');
  assert.equal(mesh.parent, next.contentRoot);
  assert.equal(cache(f).instantiationCount, cloneCount, '命中池不得再调用 SharedModelAssetCache.instantiate');
  assert.equal(pool(f).hits, 1); assert.equal(pool(f).idleEntries, 0);
  assert.equal(mesh.metadata.generatedUnitEntityId, nextOwner.entityId);
  assert.equal(mesh.metadata.containerCode, 'container-new'); assert.equal(mesh.metadata.hostEntityId, 'host-new');
  assert.deepEqual(businessMetadata(mesh), businessMetadata(baselineMesh), '复用后的metadata与禁用池的真实新实例一致');
  assert.equal(mesh.metadata.fixtureSource, baselineMesh.metadata.fixtureSource);
  assert.equal(mesh.sourceMesh.metadata.fixtureSource, 'cargo-source', '源metadata仍属于源，不能制造原生实例不存在的复制');
  assert.deepEqual(readGeneratedUnitClickTarget(pick(f, mesh).pickedMesh), readGeneratedUnitClickTarget(mesh));
  assert.deepEqual(readGeneratedUnitClickTarget(mesh), { bindingEntityId: entity.id, assetCode: 'device', highlightEntityId: nextOwner.entityId,
    unitKind: 'cargo', containerCode: 'container-new', hostEntityId: 'host-new' });
  const third = f.spawn(entity), parallel = await loaded(f, third);
  assert.notEqual(physical(parallel), mesh, '同时活动的两个 cargo 不得分享同一物理节点');
  assert.equal(cache(f).instantiationCount, cloneCount + 1);
  assert.ok(pool(f).resets >= 1); assert.ok(Number.isFinite(pool(f).resetMs));
  t.diagnostic(JSON.stringify({ cache: cache(f), pool: pool(f), dirtyCount: f.dirtyReasons.length }));
  f.retire(second); f.retire(third); baseline.retire(baselineCargo);
});

test('关闭 A/B 开关保持原释放路径，不能靠模板命中伪造实例池收益', async t => {
  const f = setup(t), entity = generator(target('disabled'));
  enable(f, false); await sync(f, entity);
  const first = f.spawn(entity), old = await loaded(f, first), oldMesh = physical(old);
  t.diagnostic(JSON.stringify({ calibration: 'pool-disabled-native-metadata', meshClass: oldMesh.getClassName(),
    metadata: oldMesh.metadata, sourceMetadata: oldMesh.sourceMesh?.metadata }));
  f.retire(first); assert.equal(oldMesh.isDisposed(), true); assert.equal(pool(f).idleEntries, 0);
  const second = f.spawn(entity), next = await loaded(f, second);
  assert.notEqual(physical(next), oldMesh); assert.equal(cache(f).instantiationCount, 2);
  assert.equal(pool(f).hits, 0); f.retire(second);
});

test('同件货物跨 host/container 更新沿用原 owner/物理 mesh，不提前退池或重复 checkout', async t => {
  const f = setup(t), entity = generator(target('handoff'));
  enable(f); await sync(f, entity);
  const cargo = f.spawn(entity, { host: 'host-A', container: 'before' }), model = await loaded(f, cargo);
  const owner = cargo.outputOwner, cargoRoot = cargo.root, mesh = physical(model), before = { ...pool(f) };
  cargo.containerCode = 'after';
  f.runtime.outputs.syncGeneratedCargoVisual(cargo, 'conveyor', telemetry({ containerCode: 'after' }), f.runtime.outputs.modelGenerators.get(entity.id), 'host-B');
  await flush();
  assert.equal(cargo.outputOwner, owner); assert.equal(cargo.root, cargoRoot); assert.equal(cargo.outputOwner.output.model, model);
  assert.equal(physical(model), mesh); assert.equal(cache(f).instantiationCount, 1);
  assert.equal(pool(f).hits, before.hits); assert.equal(pool(f).retained, before.retained); assert.equal(pool(f).idleEntries, 0);
  assert.deepEqual(readGeneratedUnitClickTarget(mesh), { bindingEntityId: entity.id, assetCode: 'device', highlightEntityId: owner.entityId,
    unitKind: 'cargo', containerCode: 'after', hostEntityId: 'host-B' });
  f.retire(cargo);
});

test('独占参数资产和实际 AnimationGroup 即使外层 handle 为 shared 也不进池', async t => {
  for (const kind of ['owned', 'animated']) await t.test(kind, async child => {
    const f = setup(child, { animated: kind === 'animated' });
    const entity = generator(target(kind, kind === 'owned' ? { parameterConfig: { parameters: [] } } : {}));
    enable(f); await sync(f, entity);
    const first = f.spawn(entity), model = await loaded(f, first), mesh = physical(model);
    if (kind === 'owned') assert.equal(model.assetHandle.kind, 'owned-container');
    else {
      assert.equal(model.assetHandle.kind, 'shared-instance');
      assert.ok(model.assetHandle.animationGroups.length > 0, '必须是实际 Blender/glTF 类动画组对象，不能只写 script 元数据');
    }
    f.retire(first); assert.equal(pool(f).idleEntries, 0); assert.equal(mesh.isDisposed(), true);
    const second = f.spawn(entity), next = await loaded(f, second);
    assert.notEqual(physical(next), mesh); assert.equal(pool(f).hits, 0);
    f.retire(second);
  });
});

test('仍被选择集合引用的旧 owner 保守释放，不把 selection 物理节点借给新货物', async t => {
  const f = setup(t), entity = generator(target('selection'));
  enable(f); await sync(f, entity);
  const cargo = f.spawn(entity), model = await loaded(f, cargo), mesh = physical(model), id = cargo.outputOwner.entityId;
  f.runtime.selection.selectedEntityIds.add(id);
  f.retire(cargo);
  assert.equal(mesh.isDisposed(), true); assert.equal(pool(f).idleEntries, 0);
  f.runtime.selection.selectedEntityIds.delete(id);
  const nextCargo = f.spawn(entity), next = await loaded(f, nextCargo);
  assert.notEqual(physical(next), mesh); f.retire(nextCargo);
});

test('真实 begin/end preview、配置换代、删除与 SceneRuntime.dispose 均 drain 闲置句柄', async t => {
  const f = setup(t), entity = generator(target('lifecycle'));
  enable(f); await sync(f, entity);
  const fill = async current => {
    const cargo = f.spawn(current), model = await loaded(f, cargo), mesh = physical(model);
    f.retire(cargo); assert.equal(pool(f).idleEntries, 1); return mesh;
  };
  const beforeBegin = await fill(entity);
  f.runtime.beginTelemetryPreview();
  assert.equal(pool(f).idleEntries, 0); assert.equal(beforeBegin.isDisposed(), true);
  const beforeEnd = await fill(entity);
  f.runtime.endTelemetryPreview();
  assert.equal(pool(f).idleEntries, 0); assert.equal(pool(f).idleNodes, 0); assert.equal(beforeEnd.isDisposed(), true);
  const beforeConfig = await fill(entity);
  const next = structuredClone(entity); next.components.modelGenerator.defaultTarget = target('lifecycle', { assetRevision: 'r2' });
  await sync(f, next);
  assert.equal(pool(f).idleEntries, 0); assert.equal(beforeConfig.isDisposed(), true);
  const beforeDelete = await fill(next);
  f.runtime.sync(document([])); await flush();
  assert.equal(pool(f).idleEntries, 0); assert.equal(beforeDelete.isDisposed(), true);
  await sync(f, next);
  const beforeDispose = await fill(next);
  f.disposeRuntime();
  assert.equal(pool(f).idleEntries, 0); assert.equal(pool(f).idleNodes, 0); assert.equal(beforeDispose.isDisposed(), true);
});

test('真实 load 已返回但提交前 cargo 过期时，迟到 shared 句柄释放一次且不进入池', async t => {
  const f = setup(t), entity = generator(target('stale'));
  enable(f); await sync(f, entity);
  const original = f.runtime.assets.loadModelRuntimeAssets.bind(f.runtime.assets), gate = deferred();
  let actual, disposeCalls = 0;
  f.runtime.assets.loadModelRuntimeAssets = async (...args) => {
    actual = await original(...args);
    const dispose = actual.handle.dispose;
    actual.handle.dispose = () => { disposeCalls++; return dispose(); };
    await gate.promise;
    return actual;
  };
  const cargo = f.spawn(entity);
  await until(() => actual, '必须先取得真实共享实例，而非伪造句柄');
  const roots = [...actual.rootNodes], id = cargo.outputOwner.entityId;
  assert.ok(roots.length > 0); assert.equal(cache(f).instantiationCount, 1);
  f.retire(cargo); gate.resolve(); await flush();
  assert.equal(f.runtime.outputs.generatedOutputOwners.has(id), false);
  assert.equal(disposeCalls, 1, '迟到结果仅调用原 shared dispose 一次');
  assert.ok(roots.every(node => node.isDisposed()));
  assert.equal(pool(f).idleEntries, 0); assert.equal(pool(f).hits, 0);
});

test('原生共享源name或transform换代后，enabled与disabled的新实例语义一致', async t => {
  for (const wrapped of [false, 'transform', 'mesh']) await t.test(wrapped ? 'canonical-parent-' + wrapped : 'flat-canonical-mesh', async child => {
    const results = [];
    for (const enabled of [false, true]) {
      const f = setup(child, { wrapped }), entity = generator(target('source-change'));
      enable(f, enabled); await sync(f, entity);
      if (wrapped === 'mesh') {
        assert.equal(f.sources[0].rootNodes[0].getTotalVertices(), 0);
        assert.equal(f.sources[0].rootNodes[0].subMeshes, undefined, '真实空Mesh wrapper未初始化subMeshes');
      }
      const first = f.spawn(entity), old = await loaded(f, first), oldMesh = physical(old);
      const source = wrapped ? oldMesh.sourceMesh.parent : oldMesh.sourceMesh;
      assert.ok(source, '包装夹具使用真实source父节点'); f.retire(first);
      source.name = 'revised-cargo-source'; source.position.x = .25;
      const second = f.spawn(entity), next = await loaded(f, second), mesh = physical(next);
      const importedRoot = next.contentRoot.getChildren(undefined, true)[0];
      results.push({ name: importedRoot.name, localPosition: importedRoot.position.asArray(), sourceName: source.name });
      assert.equal(importedRoot.name, source.name, '原生新实例使用当前source root name，不能复用旧名字');
      assert.equal(importedRoot.position.x, source.position.x, '当前source root局部transform必须与原生新实例一致');
      if (enabled) assert.equal(mesh === oldMesh, false, '源快照换代时旧物理实例不得复用');
      f.retire(second);
    }
    assert.deepEqual(results[1], results[0]);
  });
});

test('实际分类及签名后反复退役复用，scope观察者释放且签名字节有界并产生真实命中', async t => {
  const f = setup(t), entity = generator(target('lighting-cycles'));
  const staticControl = createMeshEntity('cube', { x: 10, y: 0, z: 0 });
  enable(f); await sync(f, [entity, staticControl]);
  const lighting = f.runtime.environment.lightingRuntime;
  lighting.getClassification();
  getLightingGeometrySignature(lighting.sources);
  const warmBytes = lightingGeometrySignatureCache.getMetrics().retainedSnapshotBytes;
  assert.ok(warmBytes > 0, '真实静态控制实体使签名缓存非零，不能以空签名冒充有界');
  const rows = [], physicalMeshes = new Set();
  for (let cycle = 0; cycle < 12; cycle++) {
    const cargo = f.spawn(entity, { host: 'cycle-host-' + cycle, container: 'cycle-' + cycle, fields: { cargo: cycle } });
    const model = await loaded(f, cargo), mesh = physical(model), geometry = mesh.sourceMesh.geometry;
    physicalMeshes.add(mesh);
    const callbackBeforeClassification = geometry.onGeometryUpdated;
    const entries = lighting.getClassification();
    const source = lighting.sources.find(candidate => candidate.mesh === mesh);
    assert.ok(source && entries.some(entry => entry.entityId === cargo.outputOwner.entityId), '实际provider须分类当前cargo');
    assert.equal(source.entry.mobility, 'dynamic', '测试不得篡改货物父级运动分类来制造静态缓存');
    assert.equal(source.entry.parentDynamic, true);
    const signature = getLightingGeometrySignature(lighting.sources);
    const observers = model.contentRoot.onDisposeObservable.observers.length;
    assert.ok(observers > 0, '实际model identity消费应登记scope释放观察者');
    lighting.getClassification(); getLightingGeometrySignature(lighting.sources);
    assert.equal(model.contentRoot.onDisposeObservable.observers.length, observers, '同scope重复消费不得重复登记');
    assert.equal(lightingGeometrySignatureCache.getMetrics().retainedSnapshotBytes, warmBytes);
    f.retire(cargo); await flush();
    assert.equal(model.contentRoot.isDisposed(), true);
    assert.equal(model.contentRoot.onDisposeObservable.observers.length, 0, '仅空refresh不足，真实scope必须已dispose');
    assert.equal(geometry.onGeometryUpdated, callbackBeforeClassification, '共享Geometry唯一回调应恢复到消费前基线');
    lighting.getClassification(); getLightingGeometrySignature(lighting.sources);
    assert.equal(lightingGeometrySignatureCache.getMetrics().retainedSnapshotBytes, warmBytes);
    rows.push({ cycle, signature, activeScopeObservers: observers, disposedScopeObservers: model.contentRoot.onDisposeObservable.observers.length,
      sceneMeshes: f.scene.meshes.length, sceneTransformNodes: f.scene.transformNodes.length,
      retainedSnapshotBytes: lightingGeometrySignatureCache.getMetrics().retainedSnapshotBytes, ...pool(f) });
  }
  assert.ok(pool(f).hits > 0 && cache(f).instantiationCount < rows.length, '实际分类后仍须有物理实例池命中');
  assert.ok(physicalMeshes.size < rows.length, '不能只把模板预取称作实例复用');
  const first = rows[0];
  assert.ok(rows.every(row => row.idleEntries <= 1 && row.idleNodes <= 1));
  assert.ok(rows.every(row => row.sceneMeshes <= first.sceneMeshes + 1 && row.sceneTransformNodes <= first.sceneTransformNodes + 1), '多轮空闲后的节点数量不得随轮次增长');
  t.diagnostic(JSON.stringify({ cycles: rows, instantiationCount: cache(f).instantiationCount, physicalMeshes: physicalMeshes.size,
    note: 'cargo保持动态；签名缓存字节来自真实静态控制实体，cargo modelIdentity释放由scope观察者与Geometry回调恢复证明' }));
});

test('提交初始化失败释放真实checkout一次，不把失败半成品退入池', async t => {
  for (const stage of ['capture', 'post-capture-initialize']) await t.test(stage, async child => {
    const f = setup(child), entity = generator(target('failed-commit-' + stage));
    enable(f); await sync(f, entity);
    const original = f.runtime.assets.loadModelRuntimeAssets.bind(f.runtime.assets);
    let actual, disposals = 0;
    f.runtime.assets.loadModelRuntimeAssets = async (...args) => {
      actual = await original(...args);
      const dispose = actual.handle.dispose;
      actual.handle.dispose = () => { disposals++; return dispose(); };
      return actual;
    };
    const error = new Error('fixture post-checkout ' + stage + ' failure');
    if (stage === 'capture') f.runtime.outputs.generatedCargoInstancePool.capture = () => { throw error; };
    else f.runtime.assets.normalizeModelContentOrigin = () => { throw error; };
    const cargo = f.spawn(entity);
    await until(() => actual && f.logs.some(message => message.includes(error.message)), '必须经过真实checkout后到达注入失败分支'); await flush();
    assert.equal(disposals, 1, 'capture及之后的初始化失败都必须接管并释放已返回句柄');
    assert.ok(actual.rootNodes.every(node => node.isDisposed()));
    assert.equal(pool(f).idleEntries, 0); assert.equal(pool(f).retained, 0); assert.equal(pool(f).hits, 0);
    f.retire(cargo);
  });
});

test('未知scene新增观察者保留原实例化事件，不能复用来绕过脚本观察', async t => {
  const f = setup(t), entity = generator(target('scene-observer'));
  enable(f); await sync(f, entity);
  const added = [], observer = f.scene.onNewMeshAddedObservable.add(mesh => added.push(mesh));
  t.after(() => f.scene.onNewMeshAddedObservable.remove(observer));
  const first = f.spawn(entity), old = physical(await loaded(f, first)); f.retire(first);
  const second = f.spawn(entity), next = physical(await loaded(f, second));
  assert.notEqual(next, old); assert.equal(old.isDisposed(), true);
  assert.ok(added.includes(old) && added.includes(next), '两次真实实例化都要通知未知订阅者');
  assert.equal(pool(f).hits, 0); assert.equal(pool(f).idleEntries, 0);
  f.retire(second);
});

test('退役遇到未知effect callback仍走原释放，不触发callback或留下悬挂租约', async t => {
  const f = setup(t), entity = generator(target('effect-observer'));
  enable(f); await sync(f, entity);
  const cargo = f.spawn(entity), mesh = physical(await loaded(f, cargo));
  const sentinel = new Error('external effect callback must remain unobserved'); let calls = 0;
  const unregister = registerTargetModelEffectSuspension(mesh, () => { calls++; throw sentinel; });
  t.after(unregister);
  assert.doesNotThrow(() => f.retire(cargo));
  assert.equal(calls, 0); assert.equal(mesh.isDisposed(), true);
  assert.equal(isTargetModelEffectSuspended(mesh), false); assert.equal(pool(f).idleEntries, 0);
});

test('canonical source的未知metadata Proxy不比disabled原生路径增加额外观察', async t => {
  const traces = [];
  for (const enabled of [false, true]) {
    const trace = [], sourceMetadata = () => new Proxy({ fixtureSource: 'opaque-leaf' }, {
      getPrototypeOf(target) { trace.push('getPrototypeOf'); return Reflect.getPrototypeOf(target); },
      ownKeys(target) { trace.push('ownKeys'); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { trace.push('descriptor:' + String(key)); return Reflect.getOwnPropertyDescriptor(target, key); },
      get(target, key, receiver) { trace.push('get:' + String(key)); return Reflect.get(target, key, receiver); },
    });
    const f = setup(t, { sourceMetadata }), entity = generator(target('opaque-source-metadata'));
    enable(f, enabled); await sync(f, entity); trace.length = 0;
    const cargo = f.spawn(entity); await loaded(f, cargo);
    traces.push([...trace]); f.retire(cargo);
  }
  assert.deepEqual(traces[1], traces[0], '资格判定不可为未知metadata增加prototype/descriptor/getter探测');
});

test('退役时own isDisposed callback次数与disabled原路径一致，不在guard前额外调用', async t => {
  const traces = [];
  for (const enabled of [false, true]) {
    const f = setup(t), entity = generator(target('own-is-disposed'));
    enable(f, enabled); await sync(f, entity);
    const cargo = f.spawn(entity), mesh = physical(await loaded(f, cargo)), trace = [];
    const nativeIsDisposed = mesh.isDisposed.bind(mesh);
    mesh.isDisposed = (...args) => { trace.push('isDisposed'); return nativeIsDisposed(...args); };
    f.retire(cargo);
    assert.equal(nativeIsDisposed(), true, '使用捕获的native方法断言释放，测试本身不增加callback计数');
    assert.equal(pool(f).idleEntries, 0); traces.push([...trace]);
  }
  assert.deepEqual(traces[1], traces[0], 'guard必须先识别own override，再回到原释放路径');
});

test('首次checkout不比disabled原生路径额外观察source getLODLevels', async t => {
  const traces = [];
  for (const enabled of [false, true]) {
    const f = setup(t), entity = generator(target('source-lod-callback'));
    enable(f, enabled); await sync(f, entity);
    const source = f.sources[0].meshes.find(mesh => mesh.getTotalVertices() > 0), trace = [];
    const native = source.getLODLevels.bind(source);
    source.getLODLevels = (...args) => { trace.push('getLODLevels'); return native(...args); };
    const cargo = f.spawn(entity); await loaded(f, cargo);
    traces.push([...trace]); f.retire(cargo);
  }
  assert.deepEqual(traces[1], traces[0], '资格判定应先识别own方法并退回原路径，不能为审计额外调用');
});
