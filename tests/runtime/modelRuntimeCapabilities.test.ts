import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine, Scene, Mesh } from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
import { normalizeModelRuntimeCapabilities, hashModelRuntimeConfiguration } from '../../electron/shared/modelRuntimeCapabilities.ts';
import { loadCapabilityModelTemplate } from '../../src/runtime/babylon/modelRuntimeCapabilities.ts';
import { SharedModelAssetCache, resolveModelAssetSharedInstancingPolicy } from '../../src/runtime/babylon/SharedModelAssetCache.ts';
import type { ModelAssetComponent } from '../../src/editor/model/components.ts';

async function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine);
  const asset: ModelAssetComponent = { sourcePath: 'model.glb', sourceUrl: 'model.glb', assetRevision: 'r1',
    assetCode: 'one', lengthUnit: 'meter', unitScaleToMeters: 1,
    scriptAssets: [{ path: 'move.model.ts', sourceUrl: 'move.model.ts', name: 'move.model.ts' }] };
  asset.runtimeCapabilities = { version: 1, geometry: 'shared-readonly', materials: 'owned',
    configurationSha256: await hashModelRuntimeConfiguration(asset), scripts: { 'move.model.ts': 'a'.repeat(64) } };
  const bytes = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const gltf = { asset: { version: '2.0', extras: { runtimeCapabilities: asset.runtimeCapabilities } },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'body', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ uri: 'data:application/octet-stream;base64,' + bytes.toString('base64'), byteLength: bytes.length }],
    bufferViews: [{ buffer: 0, byteLength: bytes.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] };
  let reads = 0;
  const loader = () => { reads++; return loadCapabilityModelTemplate('', 'data:' + JSON.stringify(gltf), scene); };
  const cache = new SharedModelAssetCache({ maxIdleEntries: 0, maxIdleBytes: 0 });
  return { engine, scene, asset, loader, cache, reads: () => reads, dispose() { cache.dispose(); scene.dispose(); engine.dispose(); } };
}

function body(container: Awaited<ReturnType<typeof loadCapabilityModelTemplate>>): Mesh {
  return container.meshes.find(mesh => mesh.getTotalVertices() > 0) as Mesh;
}

test('能力声明缺省/未知版本/访问器不能开启共享，键次序规范化', () => {
  let called = 0;
  assert.equal(normalizeModelRuntimeCapabilities({ get version() { called++; return 1; } }), undefined);
  assert.equal(called, 0);
  assert.equal(normalizeModelRuntimeCapabilities({ version: 2 }), undefined);
  assert.equal(normalizeModelRuntimeCapabilities(undefined), undefined);
  const asset = { sourceUrl: 'm.glb', scriptAssets: [{ name: 's.ts' }] } as ModelAssetComponent;
  assert.equal(resolveModelAssetSharedInstancingPolicy(asset).mode, 'owned-container');
});

test('真实 glTF 声明与配置核对后共享 Geometry，节点和材质独立，lease 阻止提前淘汰', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([f.cache.acquireCapabilityContainer('one', f.loader, f.asset), f.cache.acquireCapabilityContainer('one', f.loader, f.asset)]);
    assert.equal(f.reads(), 1);
    assert.ok(a.runtimeCapabilities);
    assert.notEqual(body(a.container), body(b.container));
    assert.equal(body(a.container).geometry, body(b.container).geometry);
    assert.notEqual(body(a.container).material, body(b.container).material);
    body(a.container).position.x = 9;
    assert.equal(body(b.container).position.x, 0);
    assert.equal(a.container.geometries.length, 0, '共享几何不能进入工作容器的强制释放清单');
    const geometry = body(b.container).geometry!;
    f.cache.dispose();
    assert.equal(geometry.isDisposed(), false);
    a.dispose(); a.dispose();
    assert.equal(geometry.isDisposed(), false);
    assert.equal(body(b.container).getTotalVertices(), 3);
    b.dispose();
    assert.equal(geometry.isDisposed(), true);
  } finally { f.dispose(); }
});

test('配置变化、声明与实际源不符时回退完整隔离；不把场景字段当证明', async () => {
  const f = await fixture();
  try {
    const changed = { ...f.asset, unitScaleToMeters: 2 };
    const a = await f.cache.acquireCapabilityContainer('one', f.loader, changed);
    assert.equal(a.runtimeCapabilities, undefined);
    assert.ok(a.container.geometries.length > 0);
    assert.equal(f.cache.getMetrics().capabilityFallbackCount, 1);
    a.dispose();
    const forged = { ...f.asset, runtimeCapabilities: { ...f.asset.runtimeCapabilities!, scripts: {} } };
    const b = await f.cache.acquireCapabilityContainer('two', f.loader, forged);
    assert.equal(b.runtimeCapabilities, undefined);
    b.dispose();
  } finally { f.dispose(); }
});

test('无版本声明保持独占；有效能力不绕过普通模型旧共享规则', async () => {
  const f = await fixture();
  try {
    assert.equal(resolveModelAssetSharedInstancingPolicy(f.asset).mode, 'shared-geometry-clone');
    assert.equal(resolveModelAssetSharedInstancingPolicy({ ...f.asset, scriptAssets: undefined,
      runtimeCapabilities: { ...f.asset.runtimeCapabilities!, geometry: 'owned' } }).mode, 'owned-container');
    assert.equal(resolveModelAssetSharedInstancingPolicy({ ...f.asset, assetRevision: undefined }).mode, 'owned-container');
    assert.equal(resolveModelAssetSharedInstancingPolicy({ ...f.asset, runtimeCapabilities: undefined, scriptAssets: undefined }).mode, 'shared-instance');
    const abort = new AbortController(); abort.abort();
    await assert.rejects(f.cache.acquireCapabilityContainer('one', f.loader, f.asset, abort.signal), { name: 'AbortError' });
    assert.equal(f.reads(), 0);
  } finally { f.dispose(); }
});
