import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { AssetContainer, Matrix, MeshBuilder, NullEngine, Scene, StandardMaterial, VertexBuffer } from '@babylonjs/core';
import ts from 'typescript';

const projectRoot = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('lodash/') && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(projectRoot.href)) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(url) && existsSync(new URL(url.href.replace(/\.js$/, '') + '.ts'))) return next(url.href.replace(/\.js$/, '') + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(projectRoot.href) && /\.(png|jpg|webp|bin)(\?.*)?$/.test(url)) return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) + ';' };
    if (url.startsWith(projectRoot.href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { SceneEnvironmentRuntime } = await import('../../src/runtime/babylon/SceneEnvironmentRuntime.ts');
hooks.deregister();

async function setup(t, mutate = () => {}, patch = {}) {
  const engine = new NullEngine(), scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const container = new AssetContainer(scene);
  const mesh = MeshBuilder.CreateBox('warehouse', { size: 2 }, scene);
  mesh.material = new StandardMaterial('warehouse', scene);
  mutate(mesh, container);
  container.meshes.unshift(mesh);
  container.materials.push(mesh.material);
  const runtime = new SceneEnvironmentRuntime(scene, {
    resolveAssetUrl: value => value, loadAssetContainer: async () => container,
    waitForRenderReady: async () => {},
  });
  const sourceUrl = 'editor-asset://local/warehouse.glb';
  const config = { packagePath: 'C:/warehouse', lengthUnit: 'centimeter', unitScaleToMeters: 0.01,
    placementMode: 'scene-base', displayName: '环境', activeVariantUrl: sourceUrl,
    variants: [{ name: '默认', sourcePath: 'C:/warehouse.glb', sourceUrl }], visible: true, opacity: 1,
    transform: { position: { x: 10, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 600 }, ...patch };
  await runtime.apply(config, { requestId: null, autoAlign: false });
  return { runtime, mesh, scene, config };
}

test('snapshot preserves geometry, actual placement and source state without reloading', async t => {
  const { runtime, mesh } = await setup(t);
  const material = mesh.material, camera = mesh.getScene().activeCamera, original = mesh.getVerticesData(VertexBuffer.PositionKind)[0];
  const snapshot = runtime.getOpeningEnvironmentSnapshot();
  assert.equal(snapshot.parts.length, 1);
  assert.deepEqual(snapshot.bounds, { minimum: { x: 4, y: -6, z: -6 }, maximum: { x: 16, y: 6, z: 6 } });
  assert.equal(snapshot.parts[0].worldMatrix[12], 10);
  assert.equal(snapshot.parts[0].worldMatrix[0], 6);
  assert.equal(snapshot.parts[0].indices.length, 36);
  snapshot.parts[0].positions[0] = 987;
  assert.equal(mesh.getVerticesData(VertexBuffer.PositionKind)[0], original);
  assert.equal(mesh.material, material);
  assert.equal(mesh.getScene().activeCamera, camera);
  assert.equal(mesh.isEnabled(), true);
});

test('ordinary and thin instances share copied geometry and retain distinct transforms', async t => {
  const regular = await setup(t, (mesh, container) => { const instance = mesh.createInstance('warehouse2'); instance.position.x = 5; container.meshes.push(instance); });
  const snapshot = regular.runtime.getOpeningEnvironmentSnapshot();
  assert.equal(snapshot.parts.length, 2);
  assert.equal(snapshot.parts[0].positions, snapshot.parts[1].positions);
  assert.equal(snapshot.parts[0].indices, snapshot.parts[1].indices);
  assert.equal(snapshot.parts[0].sourceMeshId, snapshot.parts[1].sourceMeshId);
  assert.equal(snapshot.parts[1].worldMatrix[12], 40);
  const thin = await setup(t, mesh => mesh.thinInstanceSetBuffer('matrix', new Float32Array([...Matrix.Identity().asArray(), ...Matrix.Translation(5, 0, 0).asArray()]), 16));
  const parts = thin.runtime.getOpeningEnvironmentSnapshot().parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].positions, parts[1].positions);
  assert.equal(parts[1].worldMatrix[12], 40);
  assert.equal(thin.runtime.getOpeningEnvironmentSnapshot().bounds.maximum.x, 46);
});

test('missing, hidden, proxy-only and oversized environment fail visibly', async t => {
  const { runtime, mesh, scene, config } = await setup(t);
  const idle = new SceneEnvironmentRuntime(scene, { loadAssetContainer: async () => { throw new Error('unused'); } });
  assert.throws(() => idle.getOpeningEnvironmentSnapshot(), /加载并显示/);
  await runtime.apply({ ...config, visible: false }, { requestId: null, autoAlign: false });
  assert.throws(() => runtime.getOpeningEnvironmentSnapshot(), /加载并显示/);
  await runtime.apply(config, { requestId: null, autoAlign: false });
  mesh.metadata = { ...mesh.metadata, digitalTwinEffectProxy: true };
  assert.throws(() => runtime.getOpeningEnvironmentSnapshot(), /没有可见/);
  mesh.metadata.digitalTwinEffectProxy = false;
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(8193 * 16), 16);
  assert.throws(() => runtime.getOpeningEnvironmentSnapshot(), /8192/);
});
