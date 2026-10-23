import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
      const candidate = new URL(specifier, context.parentURL);
      if (!existsSync(candidate) && existsSync(new URL(candidate.href + '.ts'))) return next(candidate.href + '.ts', context);
      if (!existsSync(candidate) && candidate.href.endsWith('.js') && existsSync(new URL(candidate.href.replace(/\.js$/, '.ts')))) return next(candidate.href.replace(/\.js$/, '.ts'), context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (/\.(png|jpg|svg)$/.test(url)) return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) };
    if (url.startsWith(root.href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});

const { SharedModelAssetCache } = await import('../../src/runtime/babylon/SharedModelAssetCache.ts');
const { refreshDetachedInstanceSourceMaterials, refreshSceneLightingMaterialDrawCaches } = await import('../../src/runtime/babylon/refreshDetachedInstanceSourceMaterials.ts');
hooks.deregister();
const { NullEngine, Scene, AssetContainer, MeshBuilder, PBRMaterial, HemisphericLight, Vector3, MaterialDefines } = await import('@babylonjs/core');

function fixture(t) {
  const engine = new NullEngine(), scene = new Scene(engine), cache = new SharedModelAssetCache();
  const oldLight = new HemisphericLight('removed-light', Vector3.Up(), scene);
  const source = MeshBuilder.CreateBox('cached-template', {}, scene), material = new PBRMaterial('cached-material', scene);
  source.material = material;
  const container = new AssetContainer(scene); container.meshes.push(source); container.materials.push(material); container.rootNodes.push(source);
  container.removeAllFromScene();
  let resets = 0, resyncs = 0; const originalReset = source.resetDrawCache.bind(source);
  source.resetDrawCache = (...args) => { resets++; return originalReset(...args); };
  const originalResync = source._resyncLightSources.bind(source);
  source._resyncLightSources = (...args) => { resyncs++; return originalResync(...args); };
  const previousEffects = new Map();
  let effectDisposals = 0;
  const seed = () => {
    const draw = source.subMeshes[0]._getDrawWrapper(7, true); draw.defines = new MaterialDefines(); draw.defines.markAsProcessed();
    draw._wasPreviouslyReady = true; draw._wasPreviouslyUsingInstances = true;
    // 用可计数资源哨兵捕获误清空和误释放；真实 Effect/管线复用由 WebGL 回归验证。
    if (!previousEffects.has(draw)) previousEffects.set(draw, draw.effect);
    draw.effect = { dispose() { effectDisposals++; }, getEngine() { return engine; } };
    return draw;
  };
  t.after(() => {
    // 先归还真正的 Effect/null，避免 Babylon 资源释放链操作测试哨兵。
    for (const [draw, effect] of previousEffects) draw.effect = effect;
    cache.dispose(); container.dispose(); scene.dispose(); engine.dispose();
  });
  return { scene, cache, source, container, oldLight, seed, resets: () => resets, resyncs: () => resyncs, effectDisposals: () => effectDisposals };
}

test('删除最后实例后闲置模板复用刷新一次，继续增加活动实例不重复刷新', async t => {
  const h = fixture(t); let loads = 0;
  const loader = async () => { loads++; return h.container; };
  const first = await h.cache.instantiate('resource', loader, name => 'first-' + name);
  first.dispose(); assert.equal(h.cache.getMetrics().idleEntries, 1);
  const stale = h.seed(), previousEffect = stale.effect; h.oldLight.dispose();
  assert.ok(h.source.lightSources.includes(h.oldLight));
  assert.equal(refreshDetachedInstanceSourceMaterials(h.scene), 0, '空闲模板没有活动实例，实时同步不应扫描它');
  const before = h.resyncs();
  const reused = await h.cache.instantiate('resource', loader, name => 'reused-' + name);
  assert.equal(h.source.subMeshes[0]._getDrawWrapper(7), stale, '复用空闲模板应保留编译资源并刷新状态');
  assert.equal(stale.effect, previousEffect); assert.equal(h.effectDisposals(), 0);
  assert.equal(stale._wasPreviouslyReady, false); assert.equal(stale.defines.isDirty, true);
  assert.equal(stale.defines._areLightsDisposed, true, '不能继续用包含已释放灯光的旧 shader 热切换');
  assert.equal(h.source.lightSources.includes(h.oldLight), false);
  assert.equal(h.resyncs(), before + 1); assert.equal(loads, 1); assert.equal(h.scene.meshes.includes(h.source), false);
  const activeDraw = h.seed(), count = h.resyncs();
  const another = await h.cache.instantiate('resource', loader, name => 'another-' + name);
  assert.equal(h.resyncs(), count, '每次增加活动实例不能使共享源反复重编译');
  assert.equal(h.source.subMeshes[0]._getDrawWrapper(7), activeDraw);
  reused.dispose(); another.dispose();
});

test('并发首次等待中首个请求取消，后续成功请求仍刷新一次模板', async t => {
  const h = fixture(t); let resolveLoad;
  const loading = new Promise(resolve => { resolveLoad = resolve; });
  const firstController = new AbortController();
  const first = h.cache.instantiate('concurrent', async () => loading, name => name, firstController.signal);
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  const second = h.cache.instantiate('concurrent', async () => loading, name => 'second-' + name);
  await Promise.resolve(); const stale = h.seed(), previousEffect = stale.effect; h.oldLight.dispose(); firstController.abort();
  resolveLoad(h.container); await cancelled; const result = await second;
  assert.equal(h.source.subMeshes[0]._getDrawWrapper(7), stale);
  assert.equal(stale.effect, previousEffect); assert.equal(h.effectDisposals(), 0);
  assert.equal(stale._wasPreviouslyReady, false); assert.equal(stale.defines.isDirty, true);
  assert.equal(h.source.lightSources.includes(h.oldLight), false);
  assert.equal(h.resyncs(), 1); assert.equal(h.cache.getMetrics().hits, 1);
  result.dispose();
});

test('冻结环境刷新保持Effect引用且不释放资源，保留冻结状态并恢复照明检查和绑定', t => {
  const h = fixture(t); h.container.addAllToScene(); h.source.material.freeze();
  const draw = h.seed(), context = draw.drawContext, previousEffect = draw.effect;
  const before = h.resets();
  assert.equal(refreshSceneLightingMaterialDrawCaches(h.scene), 1);
  assert.equal(h.source.subMeshes[0]._getDrawWrapper(7), draw, '不能为全局照明刷新销毁绘制缓存');
  assert.equal(draw.drawContext, context);
  assert.equal(draw.effect, previousEffect); assert.equal(h.effectDisposals(), 0);
  assert.equal(draw._wasPreviouslyReady, false);
  assert.equal(draw._wasPreviouslyUsingInstances, null);
  assert.equal(draw._forceRebindOnNextCall, true);
  assert.equal(draw.defines.isDirty, true);
  assert.equal(h.source.material.isFrozen, true);
  assert.equal(h.resets(), before);
});
