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

const { EnvironmentAssetContainerCache } = await import('../../src/runtime/babylon/environmentAssetContainerCache.ts');
const { SceneEnvironmentRuntime } = await import('../../src/runtime/babylon/SceneEnvironmentRuntime.ts');
hooks.deregister();
const { NullEngine, Scene, SceneLoader, VertexBuffer, MeshBuilder, AssetContainer, StandardMaterial,
  Skeleton, MorphTargetManager, BakedVertexAnimationManager } = await import('@babylonjs/core');
await import('@babylonjs/loaders/glTF/index.js');
const cachedPositions = mesh => mesh._internalAbstractMeshDataInfo._positions;
const activeObservers = mesh => mesh.onClonedObservable.observers.filter(observer => !observer._willBeUnregistered).length;
const environment = { packagePath: 'C:/fixture/environment', lengthUnit: 'meter', unitScaleToMeters: 1, placementMode: 'scene-base', visible: true, opacity: 1,
  transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 }, activeVariantUrl: 'editor-asset://local/shared.glb',
  variants: [{ name: 'shared', sourcePath: 'C:/fixture/environment/shared.glb', sourceUrl: 'editor-asset://local/shared.glb' }] };

async function sharedGltf(scene, primitiveCount = 24, vertexCount = 4096) {
  const bytes = vertexCount * 24, data = Buffer.alloc(bytes + 12), floats = new Float32Array(data.buffer, data.byteOffset, vertexCount * 6);
  for (let i = 0; i < vertexCount; i++) floats.set([i % 64, Math.floor(i / 64), 0, 0, 0, 1], i * 6);
  new Uint32Array(data.buffer, data.byteOffset + bytes, 3).set([0, 1, 2]);
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: Array.from({ length: primitiveCount }, () => ({ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 })) }],
    buffers: [{ uri: 'data:application/octet-stream;base64,' + data.toString('base64'), byteLength: data.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes, byteStride: 24 }, { buffer: 0, byteOffset: bytes, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: vertexCount, type: 'VEC3', min: [0, 0, 0], max: [63, 63, 0] },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: vertexCount, type: 'VEC3' },
      { bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR' }] };
  return SceneLoader.LoadAssetContainerAsync('', 'data:' + JSON.stringify(gltf), scene, undefined, '.gltf');
}

test('真实环境glTF逐clone释放静态Vector3缓存，峰值仅一个clone且bounds与幽灵材质不变', async t => {
  const engine = new NullEngine(), scene = new Scene(engine), cache = new EnvironmentAssetContainerCache();
  let runtime;
  try {
    const source = await sharedGltf(scene), parts = source.meshes.filter(mesh => mesh.getTotalVertices() > 0), clones = [];
    parts[0].refreshBoundingInfo(true, true); const sourcePositions = cachedPositions(parts[0]);
    let peakCachedVectors = 0;
    for (const mesh of parts) mesh.onClonedObservable.add(clone => {
      clones.push(clone);
      peakCachedVectors = Math.max(peakCachedVectors, clones.reduce((sum, item) => sum + (cachedPositions(item)?.length ?? 0), 0));
    });
    const observers = new Map(parts.map(mesh => [mesh, activeObservers(mesh)]));
    const working = await cache.acquireWorkingContainer({ cacheKey: 'shared', scene, loadSource: async () => source });
    const workingParts = working.meshes.filter(mesh => mesh.getTotalVertices() > 0);
    assert.equal(workingParts.length, 24);
    assert.equal(peakCachedVectors, 4096, '此前clone的Vector3缓存不能积累到全部primitive结束');
    assert.equal(workingParts.reduce((sum, mesh) => sum + (cachedPositions(mesh)?.length ?? 0), 0), 0);
    assert.equal(cachedPositions(parts[0]), sourcePositions, '不得清理源容器已有缓存');
    for (const mesh of parts) assert.equal(activeObservers(mesh), observers.get(mesh), '临时observer必须释放');
    for (let i = 0; i < parts.length; i++) {
      const original = parts[i], clone = workingParts[i];
      assert.equal(clone.geometry, original.geometry); assert.notEqual(clone.material, original.material);
      assert.deepEqual(clone.getVerticesData(VertexBuffer.PositionKind), original.getVerticesData(VertexBuffer.PositionKind));
      assert.deepEqual(clone.getBoundingInfo().boundingBox.minimum.asArray(), original.getBoundingInfo().boundingBox.minimum.asArray());
      assert.deepEqual(clone.getBoundingInfo().boundingBox.maximum.asArray(), original.getBoundingInfo().boundingBox.maximum.asArray());
    }
    runtime = new SceneEnvironmentRuntime(scene, { resolveAssetUrl: value => value, loadAssetContainer: async () => working });
    await runtime.apply(environment, { requestId: null, autoAlign: false });
    const surface = runtime.getLightingSurfaces()[0], bounds = surface.mesh.getBoundingInfo().boundingBox.extendSize.asArray();
    await runtime.apply({ ...environment, opacity: .35 }, { requestId: null, autoAlign: false });
    assert.equal(surface.mesh.material.alpha, .35); assert.equal(parts[0].material.alpha, 1);
    assert.deepEqual(surface.mesh.getBoundingInfo().boundingBox.extendSize.asArray(), bounds);
    t.diagnostic(JSON.stringify({ primitiveCount: parts.length, verticesPerClone: 4096, peakCachedVectors,
      retainedWorkingCachedVectors: workingParts.reduce((sum, mesh) => sum + (cachedPositions(mesh)?.length ?? 0), 0) }));
  } finally { runtime?.dispose(); cache.dispose(); scene.dispose(); engine.dispose(); }
});

function manualFixture(kind) {
  const engine = new NullEngine(), scene = new Scene(engine), cache = new EnvironmentAssetContainerCache(), source = new AssetContainer(scene);
  const mesh = MeshBuilder.CreateBox('source-' + kind, {}, scene); mesh.material = new StandardMaterial('material', scene);
  if (kind === 'skeleton') mesh.skeleton = new Skeleton('skeleton', 'skeleton', scene);
  if (kind === 'morph') mesh.morphTargetManager = new MorphTargetManager(scene);
  if (kind === 'baked') mesh.bakedVertexAnimationManager = new BakedVertexAnimationManager(scene);
  source.meshes.push(mesh); source.materials.push(mesh.material); source.rootNodes.push(mesh); source.removeAllFromScene();
  return { engine, scene, cache, source, mesh, dispose() { cache.dispose(); scene.dispose(); engine.dispose(); } };
}

for (const kind of ['skeleton', 'morph', 'baked']) test(kind + '环境clone保留形变位置缓存', async () => {
  const f = manualFixture(kind);
  try {
    const working = await f.cache.acquireWorkingContainer({ cacheKey: kind, scene: f.scene, loadSource: async () => f.source });
    const clone = working.meshes.find(mesh => mesh.getTotalVertices() > 0);
    assert.ok(cachedPositions(clone)?.length > 0, '形变模型不能套用静态缓存释放');
    working.dispose();
  } finally { f.dispose(); }
});

test('回退逐网格clone也释放静态缓存，成功和异常均归还临时observer', async () => {
  const f = manualFixture('static');
  const observer = f.mesh.onClonedObservable.add(() => {}), count = activeObservers(f.mesh);
  const originalClone = f.mesh.clone;
  try {
    f.source.instantiateModelsToScene = () => { throw new Error('force fallback'); };
    const working = await f.cache.acquireWorkingContainer({ cacheKey: 'fallback', scene: f.scene, loadSource: async () => f.source });
    assert.equal(cachedPositions(working.meshes[0]), null); assert.equal(activeObservers(f.mesh), count);
    working.dispose();
    f.mesh.clone = () => { throw new Error('clone failed'); };
    await assert.rejects(f.cache.acquireWorkingContainer({ cacheKey: 'fallback', scene: f.scene, loadSource: async () => f.source }), /clone failed/);
    assert.equal(activeObservers(f.mesh), count);
    f.mesh.clone = originalClone;
    const outside = f.mesh.clone('outside', null, true);
    assert.ok(cachedPositions(outside)?.length > 0, '请求结束后不影响外部普通clone'); outside.dispose();
  } finally { f.mesh.clone = originalClone; f.mesh.onClonedObservable.remove(observer); f.dispose(); }
});
