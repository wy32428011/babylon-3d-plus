import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { MeshBuilder, NullEngine, Scene } from '@babylonjs/core';

const project = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href) && !specifier.endsWith('.ts')) {
      const file = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
      if (existsSync(file)) return { url: file.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(project.href) && /\.(png|jpg|webp|bin)(\?.*)?$/.test(url)) return {
      format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) + ';',
    };
    if (url.startsWith(project.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText,
    };
    return next(url, context);
  },
});
const { collectLightingRuntimeSources } = await import('../../src/runtime/babylon/lightingClassificationRuntime.ts');
const { normalizeSceneLightingConfig } = await import('../../electron/shared/sceneLightingConfig.ts');
hooks.deregister();

function fixture({ ownerValues = ['first-owner', 'second-owner'], throwOwner = 0, throwValue } = {}) {
  const engine = new NullEngine(), scene = new Scene(engine), trace = [];
  let ownerReads = 0, phase = false, symbolReads = 0, entityReads = 0;
  const parent = { id: 'folder', components: {}, get parentId() { if (phase) trace.push('parent.parentId'); return null; } };
  const entity = { id: 'machine', components: { meshRenderer: { meshKind: 'box' } },
    get parentId() { if (phase) trace.push('entity.parentId'); return 'folder'; } };
  const moving = { id: 'moving', parentId: null, components: { meshRenderer: { meshKind: 'box' }, deviceSpawner: {} } };
  const mesh = MeshBuilder.CreateBox('fixed-box', {}, scene), dynamicMesh = MeshBuilder.CreateBox('moving-box', {}, scene);
  mesh.position.set(1, 2, 3); dynamicMesh.position.set(-2, .5, 1);
  const ownership = { get ownerEntityId() {
    phase = true; ownerReads++; trace.push('owner:' + ownerReads);
    if (ownerReads === throwOwner) throw throwValue === undefined ? new Error('owner getter ' + ownerReads) : throwValue;
    return ownerValues[Math.min(ownerReads - 1, ownerValues.length - 1)];
  }, get deviceType() { trace.push('deviceType'); return 'fixture-device'; } };
  const symbol = Symbol('must-not-copy');
  Object.defineProperty(ownership, symbol, { enumerable: true, get() { symbolReads++; throw new Error('ownership symbol must not be read'); } });
  const document = { entities: { folder: parent, machine: entity, moving }, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined) } };
  const context = { scene, document, models: [], primitiveMeshes: new Map([['machine', mesh], ['moving', dynamicMesh]]),
    environment: [], batches: [], sourceOwners: new Map([['machine', ownership]]),
    getMotionTargets: () => { throw new Error('primitive must not resolve model motion'); },
    readEntityId: () => { entityReads++; return null; } };
  return { scene, mesh, dynamicMesh, context, symbol, trace,
    collect(options) { return collectLightingRuntimeSources(context, options); },
    reset() { ownerReads = 0; phase = false; trace.length = 0; },
    counts: () => ({ ownerReads, symbolReads, entityReads }),
    dispose() { scene.dispose(); engine.dispose(); } };
}

const baseKeys = ['entityId', 'ancestorIds', 'modelAsset', 'deviceType', 'nodeKey', 'partKey', 'resourceIdentity',
  'motionRole', 'automatic', 'parentDynamic', 'entityLighting'];
function checkContext(source, hasOwner, ownerValue) {
  const context = source.entry.policyContext;
  assert.ok(context); assert.equal(Object.getPrototypeOf(context), Object.prototype);
  assert.equal(Object.hasOwn(context, 'ownerEntityId'), hasOwner);
  if (hasOwner) assert.equal(context.ownerEntityId, ownerValue);
  assert.deepEqual(Reflect.ownKeys(context), hasOwner ? ['entityId', 'ownerEntityId', ...baseKeys.slice(1)] : baseKeys);
  for (const key of Reflect.ownKeys(context)) {
    const descriptor = Object.getOwnPropertyDescriptor(context, key);
    assert.deepEqual({ enumerable: descriptor.enumerable, writable: descriptor.writable, configurable: descriptor.configurable,
      accessor: 'get' in descriptor || 'set' in descriptor }, { enumerable: true, writable: true, configurable: true, accessor: false });
  }
}
function snapshot(sources) {
  return sources.map(source => ({ mesh: source.mesh.name, entry: source.entry, entryKeys: Reflect.ownKeys(source.entry),
    contextKeys: Reflect.ownKeys(source.entry.policyContext), world: Array.from(source.getWorldMatrix().m),
    role: { mobility: source.entry.mobility, motionRole: source.entry.motionRole, castShadows: source.entry.castShadows,
      receiveShadows: source.entry.receiveShadows, bakeIndirect: source.entry.bakeIndirect } }));
}

test('oracle: 原collector的owner真值二读及第二值undefined、祖先与deviceType观察顺序', () => {
  for (const values of [['first', 'second'], ['first', undefined]]) {
    const f = fixture({ ownerValues: values });
    try {
      const sources = f.collect({ contextAssembly: 'legacy' });
      checkContext(sources[0], true, values[1]);
      assert.deepEqual(f.trace, ['owner:1', 'owner:2', 'entity.parentId', 'parent.parentId', 'deviceType']);
      assert.deepEqual(f.counts(), { ownerReads: 2, symbolReads: 0, entityReads: 0 });
      assert.equal(sources[0].entry.mobility, 'static'); assert.equal(sources[1].entry.mobility, 'dynamic');
    } finally { f.dispose(); }
  }
});

test('oracle: 原collector的false/null/undefined/空字符串owner只读一次且不建立own字段', () => {
  for (const value of [false, null, undefined, '', 0]) {
    const f = fixture({ ownerValues: [value] });
    try {
      const sources = f.collect({ contextAssembly: 'legacy' }); checkContext(sources[0], false);
      assert.deepEqual(f.trace, ['owner:1', 'entity.parentId', 'parent.parentId', 'deviceType']);
      assert.equal(f.counts().ownerReads, 1); assert.equal(f.counts().symbolReads, 0);
    } finally { f.dispose(); }
  }
});

test('oracle: 原collector的owner首次/第二次错误在祖先及deviceType之前原样传播', () => {
  for (const throwOwner of [1, 2]) {
    const f = fixture({ throwOwner });
    try {
      assert.throws(() => f.collect({ contextAssembly: 'legacy' }), new RegExp('owner getter ' + throwOwner));
      assert.deepEqual(f.trace, throwOwner === 1 ? ['owner:1'] : ['owner:1', 'owner:2']);
    } finally { f.dispose(); }
  }
});

test('oracle: 只复制明确owner字段，symbols不读且所有模式不触发继承owner setter', () => {
  for (const contextAssembly of ['legacy', 'direct', undefined]) {
    const f = fixture(); let sets = 0;
    Object.defineProperty(Object.prototype, 'ownerEntityId', { configurable: true, set() { sets++; } });
    try {
      const sources = contextAssembly === undefined ? f.collect() : f.collect({ contextAssembly });
      checkContext(sources[0], true, 'second-owner');
      assert.equal(Object.hasOwn(sources[0].entry.policyContext, f.symbol), false);
      assert.equal(sets, 0); assert.equal(f.counts().symbolReads, 0);
    } finally { delete Object.prototype.ownerEntityId; f.dispose(); }
  }
});

test('oracle: 原collector每轮policyContext/祖先/资源容器fresh且全entry/角色/world一致', () => {
  for (const contextAssembly of ['legacy', 'direct', undefined]) {
    const f = fixture();
    try {
      const collect = () => contextAssembly === undefined ? f.collect() : f.collect({ contextAssembly });
      const first = collect(); f.reset(); const second = collect();
      assert.deepEqual(snapshot(second), snapshot(first));
      for (let index = 0; index < first.length; index++) {
        assert.notEqual(first[index].entry.policyContext, second[index].entry.policyContext);
        assert.notEqual(first[index].entry.policyContext.ancestorIds, second[index].entry.policyContext.ancestorIds);
        assert.notEqual(first[index].entry.policyContext.modelAsset, second[index].entry.policyContext.modelAsset);
      }
      assert.notEqual(first[0].entry.policyContext, first[1].entry.policyContext);
    } finally { f.dispose(); }
  }
});

test('缺省和direct与legacy的完整entry/角色/world及getter观察差分', () => {
  for (const contextAssembly of ['legacy', 'direct', undefined]) {
    const f = fixture();
    try {
      const reference = f.collect({ contextAssembly: 'legacy' }); f.reset();
      const actual = contextAssembly === undefined ? f.collect() : f.collect({ contextAssembly });
      assert.deepEqual(snapshot(actual), snapshot(reference));
      assert.deepEqual(f.trace, ['owner:1', 'owner:2', 'entity.parentId', 'parent.parentId', 'deviceType']);
    } finally { f.dispose(); }
  }
});

test('direct/default与legacy在owner变值、false及抛错时保持完整观察差分', () => {
  for (const config of [{ ownerValues: ['first', undefined] }, { ownerValues: [null] }, { ownerValues: [false] }, { throwOwner: 1 }, { throwOwner: 2 }]) {
    const f = fixture(config);
    try {
      let reference, expectedError;
      try { reference = snapshot(f.collect({ contextAssembly: 'legacy' })); } catch (error) { expectedError = error.message; }
      const trace = [...f.trace]; f.reset();
      if (expectedError) assert.throws(() => f.collect({ contextAssembly: 'direct' }), new RegExp(expectedError));
      else assert.deepEqual(snapshot(f.collect({ contextAssembly: 'direct' })), reference);
      assert.deepEqual(f.trace, trace);
    } finally { f.dispose(); }
  }
});

test('ownership Proxy的get键序/receiver及零新增探测在三模式与第二次falsy值均一致', () => {
  for (const second of ['second', undefined, null, false, 0]) {
    let expectedSnapshot, expectedGets;
    for (const contextAssembly of ['legacy', 'direct', undefined]) {
      const f = fixture({ ownerValues: ['first', second] }), gets = [], probes = { ownKeys: 0, descriptor: 0, prototype: 0 };
      const target = f.context.sourceOwners.get('machine'); let proxy;
      proxy = new Proxy(target, {
        get(value, key, receiver) { gets.push({ key, receiverIsProxy: receiver === proxy }); return Reflect.get(value, key, receiver); },
        ownKeys(value) { probes.ownKeys++; return Reflect.ownKeys(value); },
        getOwnPropertyDescriptor(value, key) { probes.descriptor++; return Reflect.getOwnPropertyDescriptor(value, key); },
        getPrototypeOf(value) { probes.prototype++; return Reflect.getPrototypeOf(value); },
      });
      f.context.sourceOwners.set('machine', proxy);
      try {
        const sources = contextAssembly === undefined ? f.collect() : f.collect({ contextAssembly });
        checkContext(sources[0], true, second);
        assert.deepEqual(gets.map(item => item.key), ['parentDynamic', 'ownerEntityId', 'ownerEntityId', 'deviceType']);
        assert.ok(gets.every(item => item.receiverIsProxy));
        assert.deepEqual(probes, { ownKeys: 0, descriptor: 0, prototype: 0 });
        assert.equal(f.counts().ownerReads, 2); assert.equal(f.counts().symbolReads, 0);
        if (contextAssembly === 'legacy') { expectedSnapshot = snapshot(sources); expectedGets = gets; }
        else { assert.deepEqual(snapshot(sources), expectedSnapshot); assert.deepEqual(gets, expectedGets); }
      } finally { f.dispose(); }
    }
  }
});

test('首次/第二次owner getter抛出的sentinel对象在legacy/direct/default保持原身份和异常前缀', () => {
  for (const throwOwner of [1, 2]) {
    const sentinel = Object.freeze({ sentinel: 'owner-' + throwOwner });
    for (const contextAssembly of ['legacy', 'direct', undefined]) {
      const f = fixture({ throwOwner, throwValue: sentinel });
      try {
        assert.throws(() => contextAssembly === undefined ? f.collect() : f.collect({ contextAssembly }), error => error === sentinel);
        assert.deepEqual(f.trace, throwOwner === 1 ? ['owner:1'] : ['owner:1', 'owner:2']);
        assert.equal(f.counts().ownerReads, throwOwner); assert.equal(f.counts().symbolReads, 0);
      } finally { f.dispose(); }
    }
  }
});
