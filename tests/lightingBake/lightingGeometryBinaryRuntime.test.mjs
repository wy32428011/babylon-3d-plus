import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { ArcRotateCamera, Constants, MeshBuilder, NullEngine, RawTexture, Scene, StandardMaterial, Vector3, VertexBuffer } from '@babylonjs/core';

const project = new URL('../../', import.meta.url);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href) && !specifier.endsWith('.ts')) {
    const target = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
    if (existsSync(target)) return next(target.href, context);
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (url.startsWith(project.href) && /\.(png|jpg|webp|bin)(\?.*)?$/.test(url)) return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) + ';' };
  return next(url, context);
} });
const { SceneLightingRuntime } = await import('../../src/runtime/babylon/SceneLightingRuntime.ts');
const { getLightingGeometrySignature } = await import('../../src/runtime/babylon/lightingRuntimeCapture.ts');
const { LightingProbeSampler } = await import('../../src/runtime/babylon/lightingProbes.ts');
const { getSceneLightingBakeSignature, lightingContentHash } = await import('../../electron/shared/sceneLightingBakeContract.ts');
const { normalizeSceneLightingConfig, normalizeSceneAppearanceConfig } = await import('../../electron/shared/sceneLightingConfig.ts');
hooks.deregister();

test('已应用state仅改encoding仍重验资源；旧缺省snapshotKey逐字兼容', async () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  new ArcRotateCamera('camera', 0, 1, 12, Vector3.Zero(), scene);
  const mesh = MeshBuilder.CreateBox('fixed', {}, scene);
  mesh.material = new StandardMaterial('fixed-material', scene);
  const source = { mesh, entry: { key: 'a/$mesh', entityId: 'a', nodeKey: '$mesh', name: 'fixed', mobility: 'static', reason: 'test',
    castShadows: true, receiveShadows: true, bakeIndirect: true, parentDynamic: false }, getWorldMatrix: () => mesh.computeWorldMatrix(true) };
  const geometry = { version: 1, positions: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)), normals: Array.from(mesh.getVerticesData(VertexBuffer.NormalKind)),
    uvs: Array.from(mesh.getVerticesData(VertexBuffer.UVKind)), bakeUvs: Array.from(mesh.getVerticesData(VertexBuffer.UVKind)), indices: Array.from(mesh.getIndices()) };
  const document = { name: 'b6', entities: { a: { id: 'a', parentId: null, components: { meshRenderer: { type: 'box' }, lighting: { mobility: 'static' } } } },
    entityIds: ['a'], sceneSettings: { environment: null, skybox: null, appearance: normalizeSceneAppearanceConfig(undefined),
      lighting: normalizeSceneLightingConfig({ bake: { enabled: true } }) } };
  let loads = 0;
  const runtime = new SceneLightingRuntime(scene, { getSources: () => [source], setShadowRoles: () => {}, pushLog: () => {},
    loadResources: async snapshot => {
      loads++;
      if (snapshot.assets[0].encoding === 'binary-v1') throw new Error('二进制格式与实际JSON不一致。');
      const texture = new RawTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false, false);
      return { geometries: new Map([['g', geometry]]), textures: new Map([['l', texture]]),
        probes: new LightingProbeSampler({ version: 1, encoding: 'ambient-cube', spacing: 1, probes: [{ position: [0, 0, 0], irradiance: Array(18).fill(.5) }] }),
        dispose() { texture.dispose(); } };
    } });
  try {
    runtime.sync(document);
    const snapshot = { version: 1, signature: getSceneLightingBakeSignature(document), geometrySignature: getLightingGeometrySignature([source]),
      createdAt: '2026-10-24T00:00:00Z', engineVersion: 'fixture', probeAssetId: 'p',
      assets: [{ id: 'g', kind: 'geometry', url: 'memory://g', byteLength: 1 }, { id: 'l', kind: 'lightmap', url: 'memory://l', byteLength: 1, rgbmRange: 1 }, { id: 'p', kind: 'probes', url: 'memory://p', byteLength: 1 }],
      surfaces: [{ key: 'a/$mesh/primitive:0', entityId: 'a', nodeKey: '$mesh', geometryAssetId: 'g', lightmapAssetId: 'l' }],
      statistics: { meshCount: 1, triangleCount: 12, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 1 } };
    assert.equal(runtime.snapshotKey(snapshot), `${snapshot.signature}:${lightingContentHash(snapshot.assets.map(asset => [asset.id, asset.url, asset.sha256]))}`);
    document.sceneSettings.lighting.result = snapshot;
    runtime.sync(document); await runtime.whenReady(); assert.equal(loads, 1);
    runtime.sync(document); await runtime.whenReady(); assert.equal(loads, 1);
    document.sceneSettings.lighting.result = structuredClone(snapshot);
    document.sceneSettings.lighting.result.assets[0].encoding = 'binary-v1';
    runtime.sync(document); await runtime.whenReady();
    assert.equal(loads, 2); assert.match(runtime.getError(), /二进制/);
  } finally { runtime.dispose(); scene.dispose(); engine.dispose(); }
});
