import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { AssetContainer, MeshBuilder, NullEngine, PBRMaterial, RawTexture, Scene, StandardMaterial } from '@babylonjs/core';
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
const { SceneRuntime } = await import('../../src/runtime/babylon/SceneRuntime.ts');
const { normalizeSceneModelEntranceSettings: normalize } = await import('../../src/editor/model/sceneModelEntrance.ts');
const { ENVIRONMENT_EFFECT_TARGET_ID: environmentId } = await import('../../src/editor/model/environmentBuildingEffect.ts');
hooks.deregister();

function environment() {
  const sourceUrl = 'editor-asset://local/environment.glb';
  return { packagePath: 'C:/environment', lengthUnit: 'meter', unitScaleToMeters: 1, placementMode: 'scene-base', displayName: '环境', activeVariantUrl: sourceUrl,
    variants: [{ name: '默认', sourcePath: 'C:/environment.glb', sourceUrl }], visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 } };
}
async function setup(t, business = false) {
  const engine = new NullEngine(), scene = new Scene(engine), runtime = new SceneRuntime(scene);
  const config = environment(), imported = [];
  runtime.waitForEnvironmentRenderReady = async () => {};
  runtime.environmentRuntime.options.resolveAssetUrl = value => value;
  runtime.loadEnvironmentAssetContainer = async () => {
    const container = new AssetContainer(scene);
    for (const Material of [PBRMaterial, StandardMaterial]) {
      const mesh = MeshBuilder.CreateBox(Material.name, {}, scene), material = new Material(Material.name, scene);
      const texture = RawTexture.CreateRGBTexture(new Uint8Array([30, 90, 150]), 1, 1, scene);
      if (material instanceof PBRMaterial) material.albedoTexture = texture;
      else material.diffuseTexture = texture;
      mesh.material = material;
      container.meshes.push(mesh); container.materials.push(material); container.textures.push(texture);
      scene.removeMesh(mesh); scene.removeMaterial(material);
      imported.push({ mesh, material, texture });
    }
    return container;
  };
  let device;
  if (business) {
    device = MeshBuilder.CreateBox('device', {}, scene); device.material = new StandardMaterial('device', scene);
    runtime.syncedEntities.set('device', { id: 'device', components: { meshRenderer: {}, visibility: { visible: true } } });
    runtime.meshes.set('device', device);
  }
  await runtime.environmentRuntime.apply(config, { requestId: null, autoAlign: false });
  const prepare = patch => runtime.prepareModelEntrance(normalize({ enabled: true, effect: 'scan', durationSeconds: .2, ...patch }));
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  return { runtime, scene, config, imported, device, prepare };
}

test('全部范围包含环境和业务模型，环境独占可播放；结束和取消恢复隔离原材质及纹理', async t => {
  const { runtime, imported, prepare } = await setup(t);
  for (const effect of ['fade', 'scan', 'dissolve', 'hologram', 'particles', 'assembly', 'radial', 'stagger']) {
    await prepare({ effect }); assert.equal(runtime.getModelEntranceSnapshot().targetCount, 1);
    for (const { mesh, material } of imported) { assert.notEqual(mesh.material, material); assert.equal(material.disableLighting, true); assert.equal(material.isFrozen, true); }
    runtime.startModelEntrance(); runtime.modelEntranceRuntime.tick(2);
    assert.equal(runtime.getModelEntranceSnapshot().status, 'completed');
    for (const { mesh, material, texture } of imported) { assert.equal(mesh.material, material); assert.equal(material.disableLighting, true); if (material instanceof PBRMaterial) { assert.equal(material.unlit, true); assert.equal(material.albedoTexture, texture); } else assert.equal(material.diffuseTexture, texture); }
    await prepare({ effect }); runtime.cancelModelEntrance();
    for (const { mesh, material } of imported) assert.equal(mesh.material, material);
  }
  const both = await setup(t, true); await both.prepare(); assert.equal(both.runtime.getModelEntranceSnapshot().targetCount, 2);
});

test('指定环境仅覆盖环境；隐藏、完全透明、加载中的环境排除', async t => {
  const { runtime, device, imported, prepare, config } = await setup(t, true);
  const original = device.material;
  await prepare({ scope: 'selected', targetEntityIds: [environmentId] });
  assert.equal(runtime.getModelEntranceSnapshot().targetCount, 1); assert.equal(device.material, original);
  runtime.cancelModelEntrance();
  for (const patch of [{ visible: false }, { opacity: 0 }]) {
    await runtime.environmentRuntime.apply({ ...config, ...patch }, { requestId: null, autoAlign: false });
    await prepare(); assert.equal(runtime.getModelEntranceSnapshot().targetCount, 1);
    for (const { mesh, material } of imported) assert.equal(mesh.material, material);
    runtime.cancelModelEntrance();
  }
  await runtime.environmentRuntime.apply(config, { requestId: null, autoAlign: false });
  runtime.environmentRuntime.snapshot = { ...runtime.environmentRuntime.getSnapshot(), phase: 'loading' };
  await prepare(); assert.equal(runtime.getModelEntranceSnapshot().targetCount, 1);
});

test('环境透明度及阴影换材质先取消环境入场，业务指定范围保持播放', async t => {
  const { runtime, scene, imported, prepare, config } = await setup(t, true);
  await prepare(); runtime.startModelEntrance(); const clone = imported[0].mesh.material;
  await runtime.environmentRuntime.apply({ ...config, opacity: .4 }, { requestId: null, autoAlign: false });
  assert.equal(runtime.getModelEntranceSnapshot().status, 'cancelled'); assert.equal(scene.materials.includes(clone), false);
  for (const { mesh, material } of imported) { assert.equal(mesh.material, material); assert.equal(material.alpha, .4); }
  await prepare(); runtime.startModelEntrance();
  await runtime.environmentRuntime.setLightingMode('scene');
  assert.equal(runtime.getModelEntranceSnapshot().status, 'cancelled');
  for (const { mesh, material } of imported) { assert.equal(mesh.material, material); assert.equal(material.disableLighting, false); }
  await prepare({ scope: 'selected', targetEntityIds: ['device'] }); runtime.startModelEntrance();
  await runtime.environmentRuntime.apply(config, { requestId: null, autoAlign: false });
  assert.equal(runtime.getModelEntranceSnapshot().status, 'playing');
});
