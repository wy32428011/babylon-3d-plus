import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { MeshBuilder, Node, NullEngine, Scene, TransformNode } from '@babylonjs/core';

const project = new URL('../../', import.meta.url);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href) && !context.parentURL.includes('/node_modules/')) {
    const target = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
    if (existsSync(target)) return next(target.href, context);
  }
  return next(specifier, context);
} });
const { collectLightingRuntimeSources } = await import('../../src/runtime/babylon/lightingClassificationRuntime.ts');
hooks.deregister();
type Context = Parameters<typeof collectLightingRuntimeSources>[0];

function fixture(count = 48, animated = false) {
  const engine = new NullEngine(), scene = new Scene(engine);
  const root = new TransformNode('model', scene), drive = new TransformNode('drive', scene); drive.parent = root;
  const meshes = Array.from({ length: count }, (_, i) => {
    const mesh = MeshBuilder.CreateBox('part' + String(i).padStart(2, '0'), {}, scene); mesh.parent = root; return mesh;
  });
  const entity = { id: 'machine', parentId: null, components: { modelAsset: { scriptAssets: [{}] } } };
  const target = { target: drive as Node }, groups = animated ? [{ targetedAnimations: [target] }] : [];
  const model = { root, contentRoot: root, meshes, assetRevision: 'r1', parameterSignature: '',
    entitySnapshot: entity, assetHandle: { animationGroups: groups }, externalScriptRuntime: null as { getDataDrivenConfigs: () => readonly unknown[] } | null };
  const motion = { moving: [drive] as Node[], fixed: [root] as Node[], known: true };
  let calls = 0;
  const context = { scene, document: { entities: { machine: entity }, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined) } },
    models: [['machine', model]], primitiveMeshes: new Map(), environment: [], batches: [],
    getMotionTargets: () => { calls++; return motion; }, readEntityId: () => null };
  const collect = () => collectLightingRuntimeSources(context as unknown as Context);
  const dispose = () => { for (const mesh of meshes) { mesh.skeleton = null; if (Object.hasOwn(mesh, 'morphTargetManager')) delete (mesh as unknown as { morphTargetManager?: unknown }).morphTargetManager; }
    scene.dispose(); engine.dispose(); };
  return { root, drive, meshes, entity, model, motion, target, groups, context, collect, dispose, motionCalls: () => calls };
}

function observeRoleSets(f: ReturnType<typeof fixture>, run: () => unknown) {
  const sets = new Set<Set<Node>>(), original = Set.prototype.has;
  Set.prototype.has = function(value) {
    if (value instanceof Node && (original.call(this, f.drive) || original.call(this, f.root))) sets.add(this as Set<Node>);
    return original.call(this, value);
  };
  try { run(); } finally { Set.prototype.has = original; }
  return sets;
}

test('同轮脚本修改moving/fixed数组的push、重排和缩短立即影响下一来源', () => {
  const f = fixture(5);
  try {
    f.motion.moving.length = 0; let calls = 0;
    f.model.externalScriptRuntime = { getDataDrivenConfigs() {
      calls++;
      if (calls === 1) f.motion.moving.push(f.root, f.drive);
      if (calls === 2) f.motion.moving.reverse();
      if (calls === 3) { f.motion.moving.length = 0; f.motion.fixed.length = 0; }
      if (calls === 4) f.motion.fixed = [f.root];
      return [{}];
    } };
    const entries = f.collect().map(source => source.entry);
    assert.deepEqual(entries.map(entry => entry.motionRole), ['fixed', 'moving', 'moving', 'fixed', 'fixed']);
    assert.match(entries[3].automaticReason!, /未移动/);
    assert.match(entries[4].automaticReason!, /固定轨道/);
    assert.equal(calls, 5);
  } finally { f.dispose(); }
});

test('动画目标替换、group增删以及同轮重新挂父级即时生效', () => {
  const f = fixture(5, true);
  try {
    f.target.target = f.root; let calls = 0;
    f.model.externalScriptRuntime = { getDataDrivenConfigs() {
      calls++;
      if (calls === 1) f.target.target = f.drive;
      if (calls === 2) f.groups.push({ targetedAnimations: [{ target: f.root }] });
      if (calls === 3) { f.groups.length = 0; f.meshes[3].parent = f.drive; }
      if (calls === 4) f.meshes[4].parent = f.root;
      return [{}];
    } };
    assert.deepEqual(f.collect().map(source => source.entry.motionRole), ['moving', 'fixed', 'moving', 'moving', 'fixed']);
    assert.equal(calls, 5);
  } finally { f.dispose(); }
});

test('骨骼和morph状态不进入角色缓存', () => {
  const f = fixture(3); let calls = 0;
  try {
    f.model.externalScriptRuntime = { getDataDrivenConfigs() {
      calls++;
      if (calls === 1) f.meshes[1].skeleton = {} as unknown as NonNullable<(typeof f.meshes)[number]['skeleton']>;
      if (calls === 2) Object.defineProperty(f.meshes[2], 'morphTargetManager', { configurable: true, value: { numTargets: 1 } });
      return [{}];
    } };
    assert.deepEqual(f.collect().map(source => source.entry.motionRole), ['fixed', 'moving', 'moving']);
  } finally { f.dispose(); }
});

test('getter和自定义iterator保留每来源原读取次序，target命中时读取两次', () => {
  const f = fixture(2, true), log: string[] = [];
  try {
    const values = [f.drive];
    Object.defineProperty(values, Symbol.iterator, { configurable: true, get() {
      log.push('iterator'); return function* () { log.push('yield'); yield f.drive; log.push('end'); };
    } });
    Object.defineProperties(f.motion, {
      moving: { get() { log.push('moving'); return values; } },
      fixed: { get() { log.push('fixed'); return [f.root]; } },
    });
    Object.defineProperty(f.target, 'target', { get() { log.push('target'); return f.drive; } });
    f.model.externalScriptRuntime = { getDataDrivenConfigs() { log.push('configs'); return [{}]; } };
    assert.deepEqual(f.collect().map(source => source.entry.motionRole), ['fixed', 'fixed']);
    assert.deepEqual(log, Array(2).fill(['moving', 'iterator', 'yield', 'end', 'fixed', 'target', 'target', 'configs']).flat());
  } finally { f.dispose(); }
});

test('未知iterator和target getter抛出的原错误保持传播', () => {
  for (const mode of ['iterator', 'target']) {
    const f = fixture(1, true), failure = new Error(mode); let reads = 0;
    try {
      if (mode === 'iterator') Object.defineProperty(f.motion.moving, Symbol.iterator, { get() { reads++; throw failure; } });
      else Object.defineProperty(f.target, 'target', { get() { reads++; if (reads === 2) throw failure; return f.drive; } });
      assert.throws(f.collect, error => error === failure);
      assert.equal(reads, mode === 'iterator' ? 1 : 2);
    } finally { f.dispose(); }
  }
});

test('跨collect重新读取目标，不持有前轮分类Set', () => {
  const f = fixture(3);
  try {
    const first = observeRoleSets(f, f.collect);
    f.motion.moving = [f.root];
    const second = observeRoleSets(f, () => assert.ok(f.collect().every(source => source.entry.motionRole === 'moving')));
    assert.equal([...first].some(value => second.has(value)), false);
    assert.equal(f.motionCalls(), 2);
  } finally { f.dispose(); }
});

test('Set.prototype.add预先接管时保持逐来源构造与动画add副作用', () => {
  const f = fixture(4, true), original = Set.prototype.add; let calls = 0;
  try {
    Set.prototype.add = function(value) { if (value === f.drive || value === f.root) calls++; return original.call(this, value); };
    assert.equal(f.collect().length, 4);
    assert.equal(calls, 12);
  } finally { Set.prototype.add = original; f.dispose(); }
});

test('moving构造期间换adder沿用起始adder，动画target期间换adder立即采用', () => {
  for (const mode of ['moving', 'animation']) {
    const f = fixture(3, true), original = Set.prototype.add; let calls = 0;
    const replacement = function<T>(this: Set<T>, value: T) {
      if (value === f.drive || value === f.root) calls++; return original.call(this, value);
    };
    try {
      if (mode === 'moving') Object.defineProperty(f.motion.moving, Symbol.iterator, { value: function* () {
        Set.prototype.add = replacement; yield f.drive;
      } });
      else Object.defineProperty(f.target, 'target', { get() { Set.prototype.add = replacement; return f.drive; } });
      assert.equal(f.collect().length, 3);
      assert.equal(calls, mode === 'moving' ? 8 : 7);
    } finally { Set.prototype.add = original; f.dispose(); }
  }
});

test('moving getter更换Set构造器不改变当前new表达式已读取的构造器', () => {
  const f = fixture(2, true), Original = globalThis.Set; let roles = 0;
  class Replacement<T> extends Original<T> {
    constructor(values?: Iterable<T> | null) { super(values); if (values === f.motion.fixed || values === f.motion.moving) roles++; }
  }
  try {
    const moving = f.motion.moving;
    Object.defineProperty(f.motion, 'moving', { get() { globalThis.Set = Replacement as SetConstructor; return moving; } });
    assert.equal(f.collect().length, 2);
    assert.equal(roles, 3);
  } finally { globalThis.Set = Original; f.dispose(); }
});


test('Proxy数组只产生原迭代读取，不增加业务descriptor或prototype探测', () => {
  const f = fixture(2), log: string[] = [];
  try {
    f.motion.moving = new Proxy(f.motion.moving, {
      get(target, key, receiver) { log.push(String(key)); return Reflect.get(target, key, receiver); },
      getOwnPropertyDescriptor(target, key) { log.push('descriptor:' + String(key)); return Reflect.getOwnPropertyDescriptor(target, key); },
      getPrototypeOf(target) { log.push('prototype'); return Reflect.getPrototypeOf(target); },
    });
    assert.equal(f.collect().length, 2);
    assert.deepEqual(log, Array(2).fill(['Symbol(Symbol.iterator)', 'length', '0', 'length']).flat());
  } finally { f.dispose(); }
});

test('target两次读取返回不同值时使用第二次值，未命中Node则只读取一次', () => {
  const f = fixture(3, true); let reads = 0;
  try {
    Object.defineProperty(f.target, 'target', { get() {
      reads++; return reads === 1 ? f.drive : reads === 2 ? f.root : null;
    } });
    assert.deepEqual(f.collect().map(source => source.entry.motionRole), ['moving', 'fixed', 'fixed']);
    assert.equal(reads, 4);
  } finally { f.dispose(); }
});


test('Array方法覆盖时分类结果与业务角色数组的读取和修改次数保持原语义', () => {
  const f = fixture(3), slice = Array.prototype.slice, push = Array.prototype.push, iterator = Array.prototype[Symbol.iterator];
  let sliceCalls = 0, pushCalls = 0, iteratorCalls = 0, configs = 0;
  const businessArray = (value: unknown[]) => value === f.motion.moving || value === f.motion.fixed;
  try {
    f.motion.moving = [f.drive, f.root];
    f.model.externalScriptRuntime = { getDataDrivenConfigs() { if (++configs === 1) f.motion.moving[1] = f.drive; return [{}]; } };
    Array.prototype.slice = function(...args: [start?: number, end?: number]) { if (businessArray(this)) sliceCalls++; return Reflect.apply(slice, this, args); };
    Array.prototype.push = function(...args: unknown[]) { if (businessArray(this)) pushCalls++; return Reflect.apply(push, this, args); };
    Array.prototype[Symbol.iterator] = function() { if (businessArray(this)) iteratorCalls++; return iterator.call(this); };
    assert.deepEqual(f.collect().map(source => source.entry.motionRole), ['moving', 'fixed', 'fixed']);
    assert.equal(sliceCalls, 0);
    assert.equal(pushCalls, 0);
    assert.equal(iteratorCalls, 6);
  } finally { Array.prototype.slice = slice; Array.prototype.push = push; Array.prototype[Symbol.iterator] = iterator; f.dispose(); }
});

test('后续target接管adder时保留已观察前缀，不重放其副作用', () => {
  const f = fixture(3, true), original = Set.prototype.add; let armed = false, calls = 0;
  const replacement = function<T>(this: Set<T>, value: T) {
    if (value === f.drive || value === f.root) calls++;
    return value === f.root ? this : original.call(this, value);
  };
  try {
    f.groups[0].targetedAnimations.push({ target: f.root });
    Object.defineProperty(f.groups[0].targetedAnimations[1], 'target', { get() {
      if (armed) Set.prototype.add = replacement; return f.root;
    } });
    f.model.externalScriptRuntime = { getDataDrivenConfigs() { armed = true; return [{}]; } };
    assert.deepEqual(f.collect().map(source => source.entry.motionRole), ['moving', 'fixed', 'fixed']);
    assert.equal(calls, 5);
  } finally { Set.prototype.add = original; f.dispose(); }
});

test('动画adder异常关闭targetedAnimations及外层group迭代器，保持原错误', () => {
  const f = fixture(1, true), original = Set.prototype.add, error = new Error('adder'), closed: string[] = [];
  const iterable = (item: unknown, name: string) => ({ [Symbol.iterator]() {
    let yielded = false;
    return { next() { if (yielded) return { done: true }; yielded = true; return { done: false, value: item }; },
      return() { closed.push(name); return { done: true }; } };
  } });
  try {
    Object.defineProperty(f.target, 'target', { get() {
      Set.prototype.add = function(value) { if (value === f.drive) throw error; return original.call(this, value); };
      return f.drive;
    } });
    f.model.assetHandle.animationGroups = iterable({ targetedAnimations: iterable(f.target, 'targets') }, 'groups') as unknown as typeof f.groups;
    assert.throws(f.collect, value => value === error);
    assert.deepEqual(closed, ['targets', 'groups']);
  } finally { Set.prototype.add = original; f.dispose(); }
});


test('只在第二次target getter换adder时当前节点沿用已捕获adder，后续节点才用新adder', () => {
  const f = fixture(1, true), original = Set.prototype.add; let reads = 0, calls = 0;
  const failure = new Error('second-read-adder');
  const replacement = function<T>(this: Set<T>, value: T) {
    if (value === f.drive || value === f.root) calls++;
    if (value === f.drive) throw failure;
    return original.call(this, value);
  };
  try {
    f.groups[0].targetedAnimations.push({ target: f.root });
    Object.defineProperty(f.target, 'target', { get() {
      if (++reads === 2) Set.prototype.add = replacement;
      return f.drive;
    } });
    // ECMAScript CallExpression先求值callee，再求值参数；当前drive必须沿用旧add。
    assert.equal(f.collect()[0].entry.motionRole, 'moving');
    assert.equal(reads, 2);
    assert.equal(calls, 1);
  } finally { Set.prototype.add = original; f.dispose(); }
});


test('中途接管的adder为函数Proxy时不额外读取其call属性', () => {
  const f = fixture(2, true), original = Set.prototype.add; let reads = 0, calls = 0;
  const gets: PropertyKey[] = [];
  const replacement = new Proxy(function<T>(this: Set<T>, value: T) {
    if (value === f.drive) calls++; return original.call(this, value);
  }, { get(target, key, receiver) { gets.push(key); return Reflect.get(target, key, receiver); } });
  try {
    Object.defineProperty(f.target, 'target', { get() {
      if (++reads === 3) Set.prototype.add = replacement;
      return f.drive;
    } });
    assert.deepEqual(f.collect().map(source => source.entry.motionRole), ['fixed', 'fixed']);
    assert.equal(calls, 1);
    assert.deepEqual(gets, []);
  } finally { Set.prototype.add = original; f.dispose(); }
});


test('未知has清空当前角色Set时每来源仍按原数组分类', () => {
  const f = fixture(3), original = Set.prototype.has;
  try {
    for (const mesh of f.meshes) mesh.parent = f.drive;
    Set.prototype.has = function(value) {
      const result = original.call(this, value);
      if (value === f.drive && result) this.clear();
      return result;
    };
    assert.deepEqual(f.collect().map(source => source.entry.motionRole), ['moving', 'moving', 'moving']);
  } finally { Set.prototype.has = original; f.dispose(); }
});

test('未知has恢复native并留下own has后本轮不得复用已暴露集合', () => {
  const f = fixture(3), original = Set.prototype.has; let captured = 0;
  try {
    for (const mesh of f.meshes) mesh.parent = f.drive;
    Set.prototype.has = function(value) {
      const result = original.call(this, value);
      if (value === f.drive && result) {
        captured++; Set.prototype.has = original;
        this.has = () => false;
      }
      return result;
    };
    assert.deepEqual(f.collect().map(source => source.entry.motionRole), ['moving', 'moving', 'moving']);
    assert.equal(captured, 1);
  } finally { Set.prototype.has = original; f.dispose(); }
});

test('同轮has从native变为unknown再恢复native后不复用被清空集合', () => {
  const f = fixture(4), original = Set.prototype.has; let calls = 0;
  try {
    for (const mesh of f.meshes) mesh.parent = f.drive;
    f.model.externalScriptRuntime = { getDataDrivenConfigs() {
      if (++calls === 1) Set.prototype.has = function(value) {
        const result = original.call(this, value);
        if (value === f.drive && result) { this.clear(); Set.prototype.has = original; }
        return result;
      };
      return [{}];
    } };
    assert.deepEqual(f.collect().map(source => source.entry.motionRole), ['moving', 'moving', 'moving', 'moving']);
    assert.equal(calls, 4);
  } finally { Set.prototype.has = original; f.dispose(); }
});

test('has访问器的读取次数、this及原错误保持，检测不额外调用getter', () => {
  const f = fixture(1), original = Object.getOwnPropertyDescriptor(Set.prototype, 'has')!, error = new Error('has');
  const has = original.value, events: string[] = [];
  try {
    f.meshes[0].parent = f.drive;
    Object.defineProperty(Set.prototype, 'has', { configurable: true, get() {
      const role = has.call(this, f.drive);
      if (role) events.push('get-has');
      return function(value: unknown) {
        if (role) { events.push('has:' + (value as Node).name); if (value === f.drive) throw error; }
        return has.call(this, value);
      };
    } });
    assert.throws(f.collect, value => value === error);
    assert.deepEqual(events, ['get-has', 'has:part00', 'get-has', 'has:drive']);
  } finally { Object.defineProperty(Set.prototype, 'has', original); f.dispose(); }
});
