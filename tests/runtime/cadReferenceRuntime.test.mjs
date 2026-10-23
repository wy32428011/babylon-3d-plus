import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let output, modules;
async function getModules() {
  if (modules) return modules;
  // 与就绪测试共用预编译真实模块的方式，避免巨型模块图的 SSR 按需加载超时。
  output = await mkdtemp(path.resolve('node_modules/.cad-runtime-'));
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
    build: { ssr: true, outDir: output, rollupOptions: { input: {
      runtime: 'src/runtime/babylon/scene-runtime/SceneCadReferenceController.ts', status: 'src/editor/cad/cadReferenceLoadStatus.ts',
      bounds: 'src/runtime/babylon/scene-runtime/SceneWorldBoundsController.ts',
    }, output: { entryFileNames: '[name].mjs' } } } });
  const [runtime, status, bounds, core] = await Promise.all([
    import(pathToFileURL(path.join(output, 'runtime.mjs')).href),
    import(pathToFileURL(path.join(output, 'status.mjs')).href),
    import(pathToFileURL(path.join(output, 'bounds.mjs')).href),
    import('@babylonjs/core'),
  ]);
  return modules = { ...runtime, ...status, ...bounds, ...core };
}
function fixture(m, id) {
  const engine = new m.NullEngine(), scene = new m.Scene(engine);
  new m.FreeCamera('camera', new m.Vector3(0, 4, -4), scene);
  const entry = { sourceUrl: 'cad://fixture', unitScaleToMeters: 1, root: new m.TransformNode(id, scene), lineMeshes: [], loadToken: 1, lineColor: '#00ffff', opacity: 0.8, geometryReady: false, cancelLoad: null, abortController: new AbortController(), unregisterCancellation() {} };
  // 直接构造拥有 CAD 生命周期的真实领域对象，夹具只注入它声明的协作能力。
  const context = { scene, pushLog() {} };
  const runtime = { assets: { modelLoadSequence: 0 }, transforms: { clearEntityArrayPreviewIfSource() {}, refreshGroupTransformPreviewTargets() {} },
    presentation: { applyTransform() {}, readColor: value => m.Color3.FromHexString(value) }, document: { context, isEntityVisible: () => true } };
  runtime.cad = new m.SceneCadReferenceController(context, runtime);
  runtime.bounds = new m.SceneWorldBoundsController(context, {});
  Object.assign(runtime.cad, { cadReferences: new Map([[id, entry]]), applyCadReferenceInteractivity() {} });
  Object.assign(runtime.transforms, { clearEntityArrayPreviewIfSource() {}, refreshGroupTransformPreviewTargets() {} });
  return { engine, scene, entry, runtime };
}
function geometry() {
  const positions = new Float32Array([1000, 0, 0, 1001, 0, 1]), counts = new Uint32Array([2]);
  const matrix = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, -1000,0.01,0,1]);
  return { layers: ['A', 'B'].map((name, index) => ({ name, positions, polylinePointCounts: counts, instanceMatrices: index === 0 ? matrix : Float32Array.from(matrix, (value, offset) => offset === 12 ? -990 : value), instanceCount: 1, entityCount: 1, polylineCount: 1, pointCount: 2, isChunk: true, geometryKey: 'shared-prototype:0' })) };
}

test('流式 CAD 合并全部显示组矩阵，GPU 属性不覆盖，首帧后就绪且删除释放几何', async () => {
  const m = await getModules(), f = fixture(m, 'cad-shared');
  try {
    const load = f.runtime.cad.applyCadReferenceGeometry('cad-shared', f.entry, geometry());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.entry.lineMeshes.length, 1);
    assert.equal(f.entry.lineMeshes[0].thinInstanceCount, 2);
    assert.equal(f.entry.geometryReady, false);
    assert.equal(m.getCadReferenceLoadStatus('cad-shared').state, 'rendering');
    assert.deepEqual(Array.from(f.entry.lineMeshes[0].getVertexBuffer('world3').getFloatData(2)), [-1000, 0.009999999776482582, 0, 1, -990, 0.009999999776482582, 0, 1]);
    const buffer = f.entry.lineMeshes[0].getVerticesData(m.VertexBuffer.PositionKind);
    assert.equal(buffer.length, 6);
    const frames = setInterval(() => f.scene.render(), 5);
    try { await load; } finally { clearInterval(frames); }
    assert.equal(f.entry.geometryReady, true);
    assert.equal(m.getCadReferenceLoadStatus('cad-shared').state, 'ready');
    const bounds = f.runtime.bounds.getCadReferenceWorldBounds(f.entry);
    assert.equal(bounds.minimum.x, 0, 'CAD 聚焦必须包含实例平移，不能使用原型坐标');
    assert.equal(bounds.maximum.x, 11);
    assert.equal(bounds.maximum.z, 1);
    f.runtime.cad.disposeCadReference('cad-shared', f.entry);
    assert.equal(f.scene.meshes.length, 0);
    assert.equal(f.scene.geometries.length, 0);
    assert.equal(m.getCadReferenceLoadStatus('cad-shared'), null);
  } finally { f.scene.dispose(); f.engine.dispose(); }
});

test('CAD 构建取消可解除暂停的 RAF，过期任务不得挂回场景', async () => {
  const m = await getModules(), f = fixture(m, 'cad-canceled');
  const previousRaf = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
  try {
    const load = f.runtime.cad.applyCadReferenceGeometry('cad-canceled', f.entry, geometry());
    f.runtime.cad.disposeCadReference('cad-canceled', f.entry);
    await assert.rejects(load, error => error.name === 'AbortError');
    assert.equal(f.scene.meshes.length, 0);
    assert.equal(f.runtime.cad.cadReferences.size, 0);
    assert.equal(f.entry.geometryReady, false);
  } finally { globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCancel; f.scene.dispose(); f.engine.dispose(); }
});

test('重开 CAD 取消后编辑其它实体不能自动重启后台解析', async () => {
  const m = await getModules(), f = fixture(m, 'cad-reopen');
  const id = 'cad-reopen';
  f.runtime.cad.cadReferences.clear();
  Object.assign(f.runtime.assets, { modelLoadSequence: 0 });
  Object.assign(f.runtime.document.context, { pushLog() {} });
  Object.assign(f.runtime.presentation, { applyTransform() {} });
  Object.assign(f.runtime.cad, { applyCadReferenceStyle() {} });
  let starts = 0, rejectLoad;
  const logs = []; f.runtime.cad.context.pushLog = message => logs.push(message);
  f.runtime.cad.loadCadReferenceGeometry = () => { starts++; return new Promise((_resolve, reject) => { rejectLoad = reject; }); };
  const entity = { id, components: { transform: {}, cadReference: { sourceUrl: 'cad://fixture', unitScaleToMeters: 1, lineColor: '#00ffff', opacity: 0.8 } } };
  try {
    f.runtime.cad.syncCadReferenceEntity(entity);
    assert.equal(starts, 1);
    m.cancelCadReferenceLoad(id);
    assert.equal(f.runtime.cad.cadReferences.has(id), true, '取消保留终止记录');
    assert.equal(m.getCadReferenceLoadStatus(id).state, 'canceled');
    const abort = new Error('已取消'); abort.name = 'AbortError'; rejectLoad(abort);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(m.getCadReferenceLoadStatus(id).state, 'canceled', '后台异步拒绝不得覆盖取消终态');
    assert.deepEqual(logs, [], '取消不能被记录为加载失败');
    f.runtime.cad.syncCadReferenceEntity(entity);
    assert.equal(starts, 1, '后续 sync 不能重新启动 1.46GB 解析');
    f.runtime.cad.disposeCadReference(id, f.runtime.cad.cadReferences.get(id));
  } finally { f.scene.dispose(); f.engine.dispose(); }
});

test.after(async () => {
  if (!output) return;
  assert.equal(path.dirname(output), path.resolve('node_modules'));
  assert.ok(path.basename(output).startsWith('.cad-runtime-'));
  await rm(output, { recursive: true, force: true });
});
