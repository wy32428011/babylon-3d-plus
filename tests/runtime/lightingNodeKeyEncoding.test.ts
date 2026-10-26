import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { Node } from '@babylonjs/core/node.js';
import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';

const project = new URL('../../', import.meta.url);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href) && !context.parentURL.includes('/node_modules/')) {
    const target = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
    if (existsSync(target)) return next(target.href, context);
  }
  return next(specifier, context);
} });
const { createLightingNodeKey, createLightingNodeKeyPass } = await import('../../src/runtime/babylon/lightingGeometry.ts');
const { collectLightingRuntimeSources } = await import('../../src/runtime/babylon/lightingClassificationRuntime.ts');
hooks.deregister();

function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine), root = new TransformNode('root', scene);
  const parent = new TransformNode('父层/100%', scene); parent.parent = root;
  const first = new TransformNode('组件 #1', scene), second = new TransformNode('组件 #1', scene);
  first.parent = parent; second.parent = parent;
  return { root, parent, first, second, dispose() { scene.dispose(); engine.dispose(); } };
}

test('本轮编码pass保持中文、同名兄弟、URI字符及根节点格式', () => {
  const f = fixture();
  try {
    assert.equal(typeof createLightingNodeKeyPass, 'function');
    const read = createLightingNodeKeyPass();
    assert.equal(read(f.first, f.root), '%E7%88%B6%E5%B1%82%2F100%25[0]/%E7%BB%84%E4%BB%B6%20%231[0]');
    assert.equal(read(f.second, f.root), '%E7%88%B6%E5%B1%82%2F100%25[0]/%E7%BB%84%E4%BB%B6%20%231[1]');
    assert.equal(read(f.root, f.root), '$root');
    f.first.name = ''; assert.equal(read(f.first, f.root), createLightingNodeKey(f.first, f.root));
  } finally { f.dispose(); }
});

test('同轮rename与reparent不复用整条路径或兄弟序号', () => {
  const f = fixture();
  try {
    const read = createLightingNodeKeyPass(); const before = read(f.first, f.root);
    f.parent.name = '新父层'; assert.notEqual(read(f.first, f.root), before);
    assert.equal(read(f.first, f.root), '%E6%96%B0%E7%88%B6%E5%B1%82[0]/%E7%BB%84%E4%BB%B6%20%231[0]');
    f.first.parent = f.root; assert.equal(read(f.first, f.root), '%E7%BB%84%E4%BB%B6%20%231[0]');
    assert.equal(read(f.second, f.root), createLightingNodeKey(f.second, f.root));
  } finally { f.dispose(); }
});

test('parent/name/getChildren/filter/indexOf读取与调用次序保持原路径', () => {
  function run(optimized: boolean) {
    const f = fixture(), events: string[] = [];
    try {
      const parent = f.first.parent;
      Object.defineProperty(f.first, 'parent', { configurable: true, get() { events.push('parent'); return parent; } });
      Object.defineProperty(f.first, 'name', { configurable: true, get() { events.push('name:first'); return '组件 #1'; } });
      Object.defineProperty(f.second, 'name', { configurable: true, get() { events.push('name:second'); return '组件 #1'; } });
      const children = f.parent.getChildren;
      f.parent.getChildren = function(...args) {
        events.push('children'); const result = children.apply(this, args), filter = result.filter;
        result.filter = function(...filterArgs) {
          events.push('filter'); const peers = filter.apply(this, filterArgs), indexOf = peers.indexOf;
          peers.indexOf = function(...indexArgs) { events.push('indexOf'); return indexOf.apply(this, indexArgs); };
          return peers;
        };
        return result;
      };
      const read = optimized ? createLightingNodeKeyPass() : createLightingNodeKey;
      return { key: read(f.first, f.root), events };
    } finally { delete (f.first as unknown as { parent?: Node }).parent; f.dispose(); }
  }
  assert.deepEqual(run(true), run(false));
});

test('callee在label getter之前捕获，getter换encoder只影响下一次调用', () => {
  const f = fixture(), original = globalThis.encodeURIComponent; let reads = 0, calls = 0;
  try {
    f.first.parent = f.root;
    // 根下仅保留一个子节点，使每次路径读取为item.name/current.name/label三次。
    f.parent.parent = null;
    const replacement = (value: string | number | boolean) => { calls++; return 'changed:' + String(value); };
    Object.defineProperty(f.first, 'name', { configurable: true, get() {
      if (++reads === 3) globalThis.encodeURIComponent = replacement;
      return '新/节点';
    } });
    const read = createLightingNodeKeyPass();
    assert.equal(read(f.first, f.root), '%E6%96%B0%2F%E8%8A%82%E7%82%B9[0]');
    assert.equal(calls, 0); assert.equal(reads, 3);
    assert.equal(read(f.first, f.root), 'changed:新/节点[0]'); assert.equal(calls, 1); assert.equal(reads, 6);
  } finally { globalThis.encodeURIComponent = original; f.dispose(); }
});

test('未知encoder调用次数、this与原异常不被编码缓存遮蔽', () => {
  const f = fixture(), original = globalThis.encodeURIComponent, failure = new Error('custom encoder'); let calls = 0;
  try {
    const read = createLightingNodeKeyPass(); read(f.first, f.root);
    globalThis.encodeURIComponent = function(value) {
      assert.equal(this, undefined); calls++; if (calls === 3) throw failure; return original(value);
    };
    assert.equal(read(f.first, f.root), '%E7%88%B6%E5%B1%82%2F100%25[0]/%E7%BB%84%E4%BB%B6%20%231[0]');
    assert.throws(() => read(f.first, f.root), error => error === failure);
  } finally { globalThis.encodeURIComponent = original; f.dispose(); }
});

test('非法surrogate的原URIError不缓存，非string每次仍执行toString', () => {
  const f = fixture(); let coercions = 0;
  try {
    const read = createLightingNodeKeyPass(); f.first.parent = f.root; f.parent.parent = null;
    f.first.name = '\uD800';
    assert.throws(() => read(f.first, f.root), URIError); assert.throws(() => read(f.first, f.root), URIError);
    (f.first as unknown as { name: unknown }).name = { toString() { coercions++; return '对象/节点'; } };
    assert.equal(read(f.first, f.root), '%E5%AF%B9%E8%B1%A1%2F%E8%8A%82%E7%82%B9[0]');
    assert.equal(read(f.first, f.root), '%E5%AF%B9%E8%B1%A1%2F%E8%8A%82%E7%82%B9[0]'); assert.equal(coercions, 2);
  } finally { f.dispose(); }
});

test('缓存Map不向脚本覆盖的constructor/get/set泄漏原生label', () => {
  const f = fixture(), Original = globalThis.Map, get = Map.prototype.get, set = Map.prototype.set; let calls = 0;
  try {
    class Replacement<K, V> extends Original<K, V> { constructor() { super(); calls++; } }
    globalThis.Map = Replacement as MapConstructor;
    Original.prototype.get = function(key) { if (key === '组件 #1' || key === '父层/100%') calls++; return get.call(this, key); };
    Original.prototype.set = function(key, value) { if (key === '组件 #1' || key === '父层/100%') calls++; return set.call(this, key, value); };
    const read = createLightingNodeKeyPass(); read(f.first, f.root); read(f.second, f.root);
    assert.equal(calls, 0);
  } finally { globalThis.Map = Original; Original.prototype.get = get; Original.prototype.set = set; f.dispose(); }
});

test('业务name/getChildren抛出错误时保持原异常，不为缓存预读属性', () => {
  for (const mode of ['name', 'children']) {
    const f = fixture(), failure = new Error(mode), children = f.parent.getChildren; let reads = 0;
    try {
      const read = createLightingNodeKeyPass();
      if (mode === 'name') Object.defineProperty(f.first, 'name', { configurable: true, get() { reads++; throw failure; } });
      else f.parent.getChildren = () => { reads++; throw failure; };
      assert.throws(() => read(f.first, f.root), error => error === failure); assert.equal(reads, 1);
    } finally { f.parent.getChildren = children; f.dispose(); }
  }
});

test('真实collect同轮配置脚本rename/reparent后下一来源仍使用当前节点路径', () => {
  const engine = new NullEngine(), scene = new Scene(engine), root = new TransformNode('root', scene);
  const parent = new TransformNode('原父层', scene); parent.parent = root;
  const first = MeshBuilder.CreateBox('组件', {}, scene), second = MeshBuilder.CreateBox('组件', {}, scene);
  first.parent = parent; second.parent = parent; let calls = 0;
  const entity = { id: 'machine', parentId: null, components: { modelAsset: { scriptAssets: [{}] } } };
  const model = { root, contentRoot: root, meshes: [first, second], assetRevision: 'r1', parameterSignature: '',
    entitySnapshot: entity, assetHandle: { animationGroups: [] }, externalScriptRuntime: { getDataDrivenConfigs() {
      if (++calls === 1) { parent.name = '新父层'; second.parent = root; } return [{}];
    } } };
  const context = { scene, document: { entities: { machine: entity }, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined) } },
    models: [['machine', model]], primitiveMeshes: new Map(), environment: [], batches: [],
    getMotionTargets: () => ({ moving: [], fixed: [], known: true }), readEntityId: () => null };
  try {
    const sources = collectLightingRuntimeSources(context as unknown as Parameters<typeof collectLightingRuntimeSources>[0]);
    assert.deepEqual(sources.map(source => source.entry.nodeKey), ['%E5%8E%9F%E7%88%B6%E5%B1%82[0]/%E7%BB%84%E4%BB%B6[0]', '%E7%BB%84%E4%BB%B6[0]']);
    assert.equal(calls, 2);
    assert.ok(sources.every(source => source.entry.resourceIdentity === sources[0].entry.resourceIdentity));
  } finally { scene.dispose(); engine.dispose(); }
});
