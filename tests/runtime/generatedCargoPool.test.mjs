import assert from 'node:assert/strict';
import test from 'node:test';
import { Animation } from '@babylonjs/core/Animations/animation.js';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup.js';
import { AssetContainer } from '@babylonjs/core/assetContainer.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';

const entries = ['/src/runtime/babylon/scene-runtime/GeneratedCargoInstancePool.ts',
  '/src/runtime/babylon/SharedModelAssetCache.ts', '/src/runtime/babylon/effects/TargetModelEffects.ts'];
const modules = await createP4SsrTestModules(entries);
const { GeneratedCargoInstancePool } = await modules.ssrLoadModule(entries[0]);
const { SharedModelAssetCache } = await modules.ssrLoadModule(entries[1]);
const { suspendTargetModelEffects, isTargetModelEffectSuspended, registerTargetModelEffectSuspension, hasTargetModelEffectSuspensionCallbacks } = await modules.ssrLoadModule(entries[2]);
test.after(() => modules.close());

function setup(t, options = {}) {
  const engine = new NullEngine(), scene = new Scene(engine);
  const cache = new SharedModelAssetCache({ maxIdleEntries: 0 });
  const pool = new GeneratedCargoInstancePool(scene, options), handles = [];
  t.after(() => { pool.clear(); for (const item of handles) if (!item.disposed()) item.assets.handle.dispose(); cache.dispose(); scene.dispose(); engine.dispose(); });
  const sources = new Map();
  return { scene, cache, pool,
    async create(generator = 'generator', key = 'asset', { animated = false, sourceMetadata, emptyMeshWrapper = false, beforeCapture } = {}) {
      const shared = await cache.instantiate(key, async () => {
        const source = new AssetContainer(scene), root = emptyMeshWrapper ? new Mesh('source-root', scene) : new TransformNode('source-root', scene);
        const a = CreateBox('same-name', {}, scene), b = CreateBox('same-name', {}, scene);
        a.parent = root; b.parent = root; b.position.x = 2;
        const material = new StandardMaterial('source-material', scene); a.material = material; b.material = material;
        a.metadata = sourceMetadata ?? { fixtureSource: 'a' }; b.metadata = { fixtureSource: 'b' };
        source.rootNodes.push(root);
        if (root instanceof Mesh) source.meshes.push(root); else source.transformNodes.push(root);
        source.meshes.push(a, b);
        source.geometries.push(a.geometry, b.geometry); source.materials.push(material);
        if (animated) {
          const animation = new Animation('source-animation', 'position.x', 30, Animation.ANIMATIONTYPE_FLOAT);
          animation.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: 1 }]);
          const group = new AnimationGroup('source-group', scene); group.addTargetedAnimation(animation, a); source.animationGroups.push(group);
        }
        source.removeAllFromScene(); sources.set(key, { source, sourceMesh: a }); return source;
      }, name => name);
      let disposeCalls = 0, disposed = false;
      const assets = { kind: 'shared-instance', rootNodes: shared.entries.rootNodes,
        handle: { kind: 'shared-instance', animationGroups: shared.entries.animationGroups, dispose() { disposeCalls++; disposed = true; shared.dispose(); } } };
      const item = { assets, disposed: () => disposed }; handles.push(item);
      beforeCapture?.({ assets, ...sources.get(key) });
      const entry = pool.capture(generator, key, assets), parent = new TransformNode('old-content-root', scene);
      for (const root of assets.rootNodes) root.parent = parent;
      if (entry) pool.activate(entry, parent);
      // 原生createInstance不承诺复制source.metadata；以实际新实例的基线为准，不为测试改变产品合同。
      const mesh = assets.rootNodes[0].getChildMeshes(false)[0];
      return { assets, entry, parent, mesh, root: assets.rootNodes[0], ...sources.get(key), disposeCalls: () => disposeCalls };
    },
  };
}

test('真实共享句柄退池隐藏、恢复基线并在新parent下激活，不在idle释放源', async t => {
  const f = setup(t), value = await f.create(); assert.ok(value.entry);
  const name = value.mesh.name, id = value.mesh.id, metadata = value.mesh.metadata;
  value.mesh.position.set(7, 8, 9); value.mesh.scaling.set(2, 3, 4); value.mesh.name = 'old-cargo-prefix'; value.mesh.id = 'old-cargo-id';
  value.mesh.metadata = { ...metadata, generatedUnitEntityId: 'old-owner', hostEntityId: 'old-host' };
  value.mesh.isVisible = false;
  assert.equal(f.pool.put(value.entry, value.parent), true);
  assert.equal(value.disposeCalls(), 0); assert.equal(value.root.parent, null); assert.equal(value.root.isEnabled(), false);
  assert.equal(value.mesh.isPickable, false); assert.equal(value.mesh.name, name); assert.equal(value.mesh.id, id);
  assert.equal(value.mesh.metadata, metadata); assert.equal(value.mesh.metadata?.generatedUnitEntityId, undefined);
  assert.equal(f.pool.getMetrics().idleEntries, 1);
  const taken = f.pool.take('generator', 'asset'); assert.equal(taken, value.entry); assert.equal(value.root.isEnabled(), false);
  const next = new TransformNode('new-content-root', f.scene); for (const root of taken.assets.rootNodes) root.parent = next;
  f.pool.activate(taken, next);
  assert.equal(value.root.parent, next); assert.equal(value.mesh.isEnabled(), true); assert.equal(value.mesh.isVisible, true);
  assert.deepEqual(value.mesh.position.asArray(), [0, 0, 0]); assert.deepEqual(value.mesh.scaling.asArray(), [1, 1, 1]);
  assert.equal(f.pool.getMetrics().hits, 1); assert.equal(f.cache.getMetrics().instantiationCount, 1);
});

test('实际AnimationGroup即使shared handle也拒绝，不接管原调用方句柄', async t => {
  const f = setup(t), value = await f.create('generator', 'animated', { animated: true });
  assert.ok(value.assets.handle.animationGroups.length > 0); assert.equal(value.entry, null);
  assert.equal(value.disposeCalls(), 0); assert.equal(value.mesh.isDisposed(), false);
});

test('有序同名兄弟被重排、父链异常都不能假装重置成功', async t => {
  const f = setup(t), reordered = await f.create(); assert.ok(reordered.entry);
  const originalParent = reordered.mesh.parent; reordered.mesh.parent = null; reordered.mesh.parent = originalParent;
  assert.equal(f.pool.put(reordered.entry, reordered.parent), false); assert.equal(reordered.disposeCalls(), 0);
  const foreign = await f.create('generator', 'foreign'); assert.ok(foreign.entry);
  foreign.root.parent = new TransformNode('foreign-owner', f.scene);
  assert.equal(f.pool.put(foreign.entry, foreign.parent), false); assert.equal(foreign.disposeCalls(), 0);
});

test('geometry/source material替换保守退原dispose，不改写共享源或释放外部材质', async t => {
  const f = setup(t), geometry = await f.create('generator', 'geometry'); assert.ok(geometry.entry);
  const oldGeometry = geometry.sourceMesh.geometry; oldGeometry.copy('replacement-geometry').applyToMesh(geometry.sourceMesh);
  assert.notEqual(geometry.sourceMesh.geometry, oldGeometry);
  assert.equal(f.pool.put(geometry.entry, geometry.parent), false); assert.equal(geometry.disposeCalls(), 0);
  const material = await f.create('generator', 'material'); assert.ok(material.entry);
  const replacement = new StandardMaterial('external-owner-material', f.scene); material.sourceMesh.material = replacement;
  assert.equal(f.pool.put(material.entry, material.parent), false); assert.equal(material.sourceMesh.material, replacement);
  assert.equal(material.disposeCalls(), 0);
});

test('已有effect lease或新增未知observer保持原释放路径', async t => {
  const f = setup(t), leased = await f.create('generator', 'lease'); assert.ok(leased.entry);
  const release = suspendTargetModelEffects(leased.mesh);
  assert.equal(f.pool.put(leased.entry, leased.parent), false); assert.equal(leased.disposeCalls(), 0); release();
  const observed = await f.create('generator', 'observer'); assert.ok(observed.entry);
  observed.mesh.onDisposeObservable.add(() => {});
  assert.equal(f.pool.put(observed.entry, observed.parent), false); assert.equal(observed.disposeCalls(), 0);
});

test('bucket/全局/节点预算均有界，逐出与drain只归还本池持有句柄一次', async t => {
  const f = setup(t, { maxIdlePerKey: 1, maxIdleEntries: 2, maxIdleNodes: 6 });
  const first = await f.create(), second = await f.create(); assert.ok(first.entry && second.entry);
  assert.equal(f.pool.put(first.entry, first.parent), true); assert.equal(f.pool.put(second.entry, second.parent), true);
  assert.equal(first.disposeCalls(), 1); assert.equal(first.root.isDisposed(), true); assert.equal(second.disposeCalls(), 0);
  const other = await f.create('other', 'asset-two'); assert.ok(other.entry); assert.equal(f.pool.put(other.entry, other.parent), true);
  assert.equal(f.pool.getMetrics().idleEntries, 2); assert.equal(f.pool.getMetrics().idleNodes, 6);
  f.pool.clearGenerator('generator'); assert.equal(second.disposeCalls(), 1); assert.equal(other.disposeCalls(), 0);
  f.pool.clear(); f.pool.clear(); assert.equal(other.disposeCalls(), 1); assert.equal(f.pool.getMetrics().idleEntries, 0);
  assert.equal(f.pool.getMetrics().idleNodes, 0);
});

test('禁用清空idle、active不被提前释放；同entry不能同时被两次checkout', async t => {
  const f = setup(t), value = await f.create(); assert.ok(value.entry);
  assert.equal(f.pool.put(value.entry, value.parent), true);
  const taken = f.pool.take('generator', 'asset'); assert.equal(taken, value.entry);
  assert.equal(Boolean(f.pool.take('generator', 'asset')), false);
  f.pool.setEnabled(false); assert.equal(value.disposeCalls(), 0);
  assert.equal(f.pool.put(taken, value.parent), false, '禁用后active仍交原调用方dispose');
  assert.equal(f.pool.getMetrics().enabled, false); assert.equal(f.pool.getMetrics().idleEntries, 0);
});

test('闲置资源被外部改写时逐出；迟到checkout释放自己的lease与原句柄恰好一次', async t => {
  const f = setup(t), changed = await f.create('generator', 'changed'); assert.ok(changed.entry);
  assert.equal(f.pool.put(changed.entry, changed.parent), true);
  changed.mesh.metadata = { foreign: true };
  assert.equal(Boolean(f.pool.take('generator', 'changed')), false);
  assert.equal(changed.disposeCalls(), 1); assert.equal(changed.root.isDisposed(), true);
  const stale = await f.create('generator', 'stale'); assert.ok(stale.entry);
  assert.equal(f.pool.put(stale.entry, stale.parent), true);
  const taken = f.pool.take('generator', 'stale'); assert.equal(taken, stale.entry);
  assert.equal(isTargetModelEffectSuspended(stale.mesh), true);
  f.pool.discard(taken); f.pool.discard(taken);
  assert.equal(stale.disposeCalls(), 1); assert.equal(stale.root.isDisposed(), true);
  assert.equal(isTargetModelEffectSuspended(stale.mesh), false, '迟到checkout不能泄漏自身effect lease');
  assert.equal(f.pool.getMetrics().idleEntries, 0);
});

test('旧cargo仍active时同步checkout只计miss且新克隆隔离；退役之后才可命中', async t => {
  const f = setup(t), active = await f.create(); assert.ok(active.entry);
  assert.equal(Boolean(f.pool.take('generator', 'asset')), false);
  const parallel = await f.create(); assert.ok(parallel.entry);
  assert.notEqual(parallel.mesh, active.mesh); assert.equal(f.cache.getMetrics().instantiationCount, 2);
  assert.equal(f.pool.getMetrics().hits, 0); assert.equal(f.pool.getMetrics().misses, 1);
  assert.equal(f.pool.put(active.entry, active.parent), true);
  assert.equal(f.pool.take('generator', 'asset'), active.entry);
  assert.equal(parallel.mesh.isDisposed(), false); assert.equal(parallel.disposeCalls(), 0);
  assert.equal(f.pool.getMetrics().hits, 1); assert.equal(f.pool.getMetrics().misses, 1);
});

test('未知已注册effect callback不能在可选退池时触发或遗留租约', async t => {
  const f = setup(t), value = await f.create(); assert.ok(value.entry);
  const sentinel = new Error('foreign-effect-owner'); let calls = 0;
  const unregister = registerTargetModelEffectSuspension(value.mesh, () => { calls++; throw sentinel; });
  try {
    assert.equal(f.pool.put(value.entry, value.parent), false);
    assert.equal(calls, 0, '未知绑定保持原dispose，池不得执行其它所有者callback');
    assert.equal(isTargetModelEffectSuspended(value.mesh), false);
    assert.equal(value.disposeCalls(), 0);
    f.pool.discard(value.entry);
    assert.equal(value.disposeCalls(), 1, '拒绝后原句柄依然按原生命周期释放一次');
    assert.equal(calls, 0);
  } finally { unregister(); }
});

test('callback纯查询不读mesh getter；不改变原suspend回调次数或异常身份', async t => {
  const f = setup(t), value = await f.create();
  const sentinel = new Error('original-suspend-callback'); let getterCalls = 0, callbackCalls = 0;
  Object.defineProperty(value.mesh, 'unrelatedOwner', { get() { getterCalls++; throw new Error('must-not-read'); } });
  assert.equal(hasTargetModelEffectSuspensionCallbacks(value.mesh), false);
  const unregister = registerTargetModelEffectSuspension(value.mesh, () => { callbackCalls++; throw sentinel; });
  assert.equal(hasTargetModelEffectSuspensionCallbacks(value.mesh), true);
  assert.equal(getterCalls, 0); assert.equal(callbackCalls, 0);
  assert.throws(() => suspendTargetModelEffects(value.mesh), error => error === sentinel);
  assert.equal(callbackCalls, 1, '原函数仍执行原callback一次并抛原对象，不被查询改写');
  unregister(); assert.equal(hasTargetModelEffectSuspensionCallbacks(value.mesh), false);
});

test('canonical源或祖先包装变化使旧baseline失效，不把旧树写回当前源', async t => {
  const f = setup(t), leaf = await f.create('generator', 'leaf-change'); assert.ok(leaf.entry);
  assert.equal(f.pool.put(leaf.entry, leaf.parent), true);
  leaf.sourceMesh.name = 'revised-source'; leaf.sourceMesh.position.x = .25;
  assert.equal(Boolean(f.pool.take('generator', 'leaf-change')), false);
  assert.equal(leaf.disposeCalls(), 1); assert.equal(leaf.entry.state, 'disposed');
  const wrapper = await f.create('generator', 'wrapper-change'); assert.ok(wrapper.entry);
  assert.equal(f.pool.put(wrapper.entry, wrapper.parent), true);
  const originalParent = wrapper.sourceMesh.parent;
  originalParent.name = 'changed-canonical-wrapper'; originalParent.position.y = .75;
  assert.equal(Boolean(f.pool.take('generator', 'wrapper-change')), false);
  assert.equal(wrapper.disposeCalls(), 1); assert.equal(wrapper.entry.state, 'disposed');
});

test('canonical metadata自定义clone访问器保守拒绝，guard不得执行getter', async t => {
  const f = setup(t), value = await f.create(); assert.ok(value.entry);
  let reads = 0;
  const metadata = {}; Object.defineProperty(metadata, 'clone', { get() { reads++; throw new Error('unknown-clone'); } });
  value.sourceMesh.parent.metadata = metadata;
  assert.equal(f.pool.put(value.entry, value.parent), false);
  assert.equal(reads, 0); assert.equal(value.disposeCalls(), 0);
});

test('物理source metadata为Proxy时原实例路径与池guard都不新增trap', async t => {
  const f = setup(t), traps = [];
  const metadata = new Proxy({}, {
    get(_target, key) { traps.push('get:' + String(key)); throw new Error('metadata must stay opaque'); },
    getPrototypeOf() { traps.push('getPrototypeOf'); throw new Error('metadata must stay opaque'); },
    getOwnPropertyDescriptor(_target, key) { traps.push('getOwnPropertyDescriptor:' + String(key)); throw new Error('metadata must stay opaque'); },
  });
  const value = await f.create('generator', 'opaque', { sourceMetadata: metadata }); assert.ok(value.entry);
  assert.deepEqual(traps, [], '原生instantiate与首次capture均不读取物理source metadata内容');
  assert.equal(f.pool.put(value.entry, value.parent), true);
  const entry = f.pool.take('generator', 'opaque'); assert.equal(entry, value.entry);
  const next = new TransformNode('next-content', f.scene); for (const root of entry.assets.rootNodes) root.parent = next;
  f.pool.activate(entry, next); assert.deepEqual(traps, []);
});

test('真实GLB样式空Mesh wrapper的undefined subMeshes等价为空，不抛错或漏句柄', async t => {
  const f = setup(t), value = await f.create('generator', 'empty-mesh-wrapper', { emptyMeshWrapper: true });
  assert.ok(value.entry); assert.equal(value.sourceMesh.parent.subMeshes, undefined, '确实覆盖原生空Mesh未初始化subMeshes');
  assert.equal(f.pool.put(value.entry, value.parent), true);
  assert.equal(f.pool.take('generator', 'empty-mesh-wrapper'), value.entry);
});

test('未知own isDisposed覆盖在调用前拒绝，不执行其它所有者方法', async t => {
  const f = setup(t), value = await f.create(); assert.ok(value.entry);
  let calls = 0; const sentinel = new Error('foreign-isDisposed');
  value.mesh.isDisposed = () => { calls++; throw sentinel; };
  try { assert.equal(f.pool.put(value.entry, value.parent), false); assert.equal(calls, 0); }
  finally { delete value.mesh.isDisposed; }
});

function overridePublic(object, key, accessor = false) {
  const original = Object.getOwnPropertyDescriptor(object, key);
  let calls = 0;
  const callback = () => { calls++; throw new Error('unknown-public-' + key); };
  Object.defineProperty(object, key, accessor
    ? { configurable: true, get: callback }
    : { configurable: true, writable: true, value: callback });
  return { calls: () => calls, restore() {
    if (original) Object.defineProperty(object, key, original); else delete object[key];
  } };
}

test('首次capture在新增public调用前拒绝own方法或访问器，不执行未知callback', async t => {
  const cases = [
    ['source getLODLevels', value => [value.sourceMesh, 'getLODLevels', true]],
    ['empty Mesh getTotalVertices', value => [value.assets.rootNodes[0], 'getTotalVertices', true], true],
    ['position clone', value => [value.assets.rootNodes[0].getChildMeshes(false)[0].position, 'clone', true]],
    ['quaternion clone', value => {
      const mesh = value.assets.rootNodes[0].getChildMeshes(false)[0]; mesh.rotationQuaternion = new Quaternion();
      return [mesh.rotationQuaternion, 'clone', true];
    }],
    ['pivot clone', value => [value.assets.rootNodes[0].getPivotMatrix(), 'clone', true]],
    ['pivot copyToArray', value => [value.assets.rootNodes[0].getPivotMatrix(), 'copyToArray']],
    ['Observable hasObservers', value => [value.assets.rootNodes[0].onDisposeObservable, 'hasObservers', true]],
    ['canonical onCloned hasObservers', value => [value.sourceMesh.onClonedObservable, 'hasObservers', true]],
    ['source hasBoundingInfo', value => [value.sourceMesh, 'hasBoundingInfo', true]],
    ['bounds minimum', value => [value.sourceMesh.getBoundingInfo(), 'minimum', true]],
    ['bounds vector asArray', value => [value.sourceMesh.getBoundingInfo().minimum, 'asArray', true]],
    ['source subMeshes', value => [value.sourceMesh, 'subMeshes', true]],
    ['node isWorldMatrixFrozen', value => [value.assets.rootNodes[0], 'isWorldMatrixFrozen', true]],
    ['node animations', value => [value.assets.rootNodes[0], 'animations', true]],
  ];
  for (const [name, locate, emptyMeshWrapper = false] of cases) await t.test(name, async t => {
    const f = setup(t); let override;
    try {
      const value = await f.create('generator', name, { emptyMeshWrapper, beforeCapture(value) {
        override = overridePublic(...locate(value));
      } });
      assert.equal(value.entry, null, '未知public调用对象保持原资源句柄路径');
      assert.equal(override.calls(), 0, '资格检查不能为拒绝资产而先执行外部callback');
      assert.equal(value.disposeCalls(), 0);
    } finally { override?.restore(); }
  });
});

test('退池和父图校验在新增public调用前拒绝后加入的own方法或访问器', async t => {
  const cases = [
    ['source vector asArray', value => [value.sourceMesh.position, 'asArray', true]],
    ['position copyFrom', value => [value.mesh.position, 'copyFrom', true]],
    ['position copyFromFloats', value => [value.mesh.position, 'copyFromFloats']],
    ['pivot copyFrom', value => [value.root.getPivotMatrix(), 'copyFrom', true]],
    ['pivot isIdentity', value => [value.root.getPivotMatrix(), 'isIdentity']],
    ['parent getChildren', value => [value.parent, 'getChildren', true]],
    ['bounds maximum vector', value => [value.sourceMesh.getBoundingInfo().maximum, 'asArray', true]],
  ];
  for (const [name, locate] of cases) await t.test(name, async t => {
    const f = setup(t), value = await f.create('generator', name); assert.ok(value.entry);
    const override = overridePublic(...locate(value));
    try {
      assert.equal(f.pool.put(value.entry, value.parent), false);
      assert.equal(override.calls(), 0, '退池必须先拒绝新覆盖，沿用原dispose而不新增callback');
      assert.equal(value.disposeCalls(), 0);
      assert.equal(isTargetModelEffectSuspended(value.mesh), false, '拒绝后本池没有残留effect租约');
    } finally { override.restore(); }
  });
});
