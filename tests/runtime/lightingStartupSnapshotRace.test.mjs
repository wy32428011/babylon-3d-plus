import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { ArcRotateCamera, Constants, NullEngine, RawTexture, Scene, Vector3 } from '@babylonjs/core';

const root = new URL('../../', import.meta.url);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(specifier + '.js', context);
  if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
    const target = new URL(specifier, context.parentURL);
    if (!existsSync(target) && existsSync(new URL(target.href.replace(/\.js$/, '') + '.ts'))) return next(target.href.replace(/\.js$/, '') + '.ts', context);
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (url.startsWith(root.href) && /\.(png|jpg|webp|bin)(\?.*)?$/.test(url)) return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) + ';' };
  if (url.startsWith(root.href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8')
    .replaceAll('import.meta.env', '({ DEV: false, BASE_URL: \'/\' })'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
  return next(url, context);
} });
const { SceneRuntime } = await import('../../src/runtime/babylon/SceneRuntime.ts');
const { createEmptySceneDocument, createMeshEntity } = await import('../../src/editor/model/SceneDocument.ts');
const { normalizeSceneLightingConfig } = await import('../../electron/shared/sceneLightingConfig.ts');
const { LightingProbeSampler } = await import('../../src/runtime/babylon/lightingProbes.ts');
const { getLightingGeometrySignature } = await import('../../src/runtime/babylon/lightingRuntimeCapture.ts');
hooks.deregister();

function sceneRuntime(logs = []) {
  const engine = new NullEngine(), scene = new Scene(engine);
  new ArcRotateCamera('camera', 0, 1, 12, Vector3.Zero(), scene);
  const runtime = new SceneRuntime(scene, message => logs.push(message));
  return { engine, scene, runtime, dispose() { runtime.dispose(); scene.dispose(); engine.dispose(); } };
}

async function fixture() {
  const host = sceneRuntime();
  try {
    const document = createEmptySceneDocument('startup snapshot fixture'), cube = createMeshEntity('cube');
    cube.id = 'startup-cube'; cube.components.lighting = { mobility: 'static', castShadows: true, receiveShadows: true, bakeIndirect: true };
    document.entityIds = [cube.id]; document.entities = { [cube.id]: cube }; document.selectedEntityId = null;
    document.sceneSettings.environment = null; document.sceneSettings.skybox = null;
    document.sceneSettings.lighting = normalizeSceneLightingConfig({ environment: { source: 'scene', rotationDegrees: 0 }, bake: { enabled: true } });
    host.runtime.sync(document);
    for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
    const input = await host.runtime.environment.lightingRuntime.captureBakeInput('startup-fixture');
    const canonical = structuredClone(host.runtime.document.shadowDocument), source = input.meshes[0];
    const geometry = { version: 2, positions: source.positions, normals: source.normals, indices: source.indices, uvs: source.uvs, bakeUvs: source.uvs };
    canonical.sceneSettings.lighting.result = { version: 1, signature: input.signature, geometrySignature: input.geometrySignature,
      createdAt: '2026-10-24T00:00:00Z', engineVersion: 'cached-resource-fixture', assets: [
        { id: 'g', kind: 'geometry', url: 'memory://geometry', byteLength: 1, geometryVersion: 2 },
        { id: 'l', kind: 'lightmap', url: 'memory://lightmap', byteLength: 1, rgbmRange: 1 },
        { id: 'p', kind: 'probes', url: 'memory://probes', byteLength: 1 }],
      surfaces: [{ key: source.key, entityId: source.entityId, nodeKey: source.nodeKey, geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
      statistics: { meshCount: 1, triangleCount: source.indices.length / 3, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 0 } };
    return { document: canonical, geometry };
  } finally { host.dispose(); }
}

for (const cached of [true, false]) test('启动同步的旧同key失败不能覆盖新成功：' + (cached ? '立即可用缓存资源' : '异步资源'), async t => {
  const { document, geometry } = await fixture(), host = sceneRuntime(), lighting = host.runtime.environment.lightingRuntime;
  t.after(() => host.dispose());
  let loads = 0;
  // 模拟资源已在缓存/异步读取的两种合法完成时序；SceneRuntime源图构建与sync/apply全部生产执行。
  lighting.options.loadResources = async () => {
    loads++;
    const texture = new RawTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, Constants.TEXTUREFORMAT_RGBA, host.scene, false, false);
    const resources = { geometries: new Map([['g', geometry]]), textures: new Map([['l', texture]]),
      probes: new LightingProbeSampler({ version: 1, encoding: 'ambient-cube', spacing: 1, probes: [{ position: [0, 0, 0], irradiance: Array(18).fill(.5) }] }), dispose() { texture.dispose(); } };
    if (!cached) await new Promise(setImmediate);
    return resources;
  };
  host.runtime.sync(document); host.runtime.registerHostSceneObservers();
  for (let frame = 0; frame < 6; frame++) { host.scene.render(); await new Promise(setImmediate); }
  await lighting.whenReady(); await new Promise(setImmediate);
  assert.equal(loads, 1); assert.equal(host.scene.meshes.filter(mesh => mesh.metadata?.lightingDerived).length, 1);
  assert.equal(getLightingGeometrySignature(lighting.sources), document.sceneSettings.lighting.result.geometrySignature);
  assert.equal(lighting.getError(), null, '成功代理/签名仍被旧同key async reject写回错误');
});

test('真正当前几何失配仍明确失败，不能以旧任务guard掩盖', async t => {
  const { document } = await fixture(), host = sceneRuntime(), lighting = host.runtime.environment.lightingRuntime;
  t.after(() => host.dispose());
  document.sceneSettings.lighting.result.geometrySignature = 'geometry-v1-real-mismatch';
  host.runtime.sync(document); await lighting.whenReady(); await new Promise(setImmediate);
  assert.match(lighting.getError(), /模型几何或实际姿态/);
  assert.equal(host.scene.meshes.some(mesh => mesh.metadata?.lightingDerived), false);
});
