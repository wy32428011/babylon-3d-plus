import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

let server, modules;
async function getModules() {
  if (modules) return modules;
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: { port: 0 }, watch: null }, optimizeDeps: { noDiscovery: true }, ssr: { noExternal: ['@linkiez/dxf-renew'] } });
  const runtime = await server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
  const status = await server.ssrLoadModule('/src/editor/cad/cadReferenceLoadStatus.ts');
  const core = await server.ssrLoadModule('@babylonjs/core');
  return modules = { ...runtime, ...status, ...core };
}
function fixture(m, id) {
  const engine = new m.NullEngine(), scene = new m.Scene(engine);
  new m.FreeCamera('camera', new m.Vector3(0, 4, -4), scene);
  const entry = { sourceUrl: 'cad://fixture', unitScaleToMeters: 1, root: new m.TransformNode(id, scene), lineMeshes: [], loadToken: 1, lineColor: '#00ffff', opacity: 0.8, geometryReady: false, cancelLoad: null, abortController: new AbortController(), unregisterCancellation() {} };
  const runtime = Object.create(m.SceneRuntime.prototype);
  Object.assign(runtime, { scene, cadReferences: new Map([[id, entry]]), clearEntityArrayPreviewIfSource() {}, applyCadReferenceInteractivity() {}, refreshGroupTransformPreviewTargets() {} });
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
    const load = f.runtime.applyCadReferenceGeometry('cad-shared', f.entry, geometry());
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
    const bounds = f.runtime.getCadReferenceWorldBounds(f.entry);
    assert.equal(bounds.minimum.x, 0, 'CAD 聚焦必须包含实例平移，不能使用原型坐标');
    assert.equal(bounds.maximum.x, 11);
    assert.equal(bounds.maximum.z, 1);
    f.runtime.disposeCadReference('cad-shared', f.entry);
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
    const load = f.runtime.applyCadReferenceGeometry('cad-canceled', f.entry, geometry());
    f.runtime.disposeCadReference('cad-canceled', f.entry);
    await assert.rejects(load, error => error.name === 'AbortError');
    assert.equal(f.scene.meshes.length, 0);
    assert.equal(f.runtime.cadReferences.size, 0);
    assert.equal(f.entry.geometryReady, false);
  } finally { globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCancel; f.scene.dispose(); f.engine.dispose(); }
});

test('重开 CAD 取消后编辑其它实体不能自动重启后台解析', async () => {
  const m = await getModules(), f = fixture(m, 'cad-reopen');
  const id = 'cad-reopen';
  f.runtime.cadReferences.clear();
  Object.assign(f.runtime, { modelLoadSequence: 0, pushLog() {}, applyTransform() {}, applyCadReferenceStyle() {} });
  let starts = 0, rejectLoad;
  const logs = []; f.runtime.pushLog = message => logs.push(message);
  f.runtime.loadCadReferenceGeometry = () => { starts++; return new Promise((_resolve, reject) => { rejectLoad = reject; }); };
  const entity = { id, components: { transform: {}, cadReference: { sourceUrl: 'cad://fixture', unitScaleToMeters: 1, lineColor: '#00ffff', opacity: 0.8 } } };
  try {
    f.runtime.syncCadReferenceEntity(entity);
    assert.equal(starts, 1);
    m.cancelCadReferenceLoad(id);
    assert.equal(f.runtime.cadReferences.has(id), true, '取消保留终止记录');
    assert.equal(m.getCadReferenceLoadStatus(id).state, 'canceled');
    const abort = new Error('已取消'); abort.name = 'AbortError'; rejectLoad(abort);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(m.getCadReferenceLoadStatus(id).state, 'canceled', '后台异步拒绝不得覆盖取消终态');
    assert.deepEqual(logs, [], '取消不能被记录为加载失败');
    f.runtime.syncCadReferenceEntity(entity);
    assert.equal(starts, 1, '后续 sync 不能重新启动 1.46GB 解析');
    f.runtime.disposeCadReference(id, f.runtime.cadReferences.get(id));
  } finally { f.scene.dispose(); f.engine.dispose(); }
});

test.after(async () => { await server?.close(); });
