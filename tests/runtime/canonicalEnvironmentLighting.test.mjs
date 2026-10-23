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
    if (/\.(png|jpg|svg)$/.test(url)) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)}` };
    if (url.startsWith(root.href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { SceneEnvironmentRuntime } = await import('../../src/runtime/babylon/SceneEnvironmentRuntime.ts');
const { SceneSkyboxRuntime } = await import('../../src/runtime/babylon/SceneSkyboxRuntime.ts');
const { TargetModelEffects } = await import('../../src/runtime/babylon/effects/TargetModelEffects.ts');
const { ENVIRONMENT_EFFECT_TARGET_ID } = await import('../../src/editor/model/environmentBuildingEffect.ts');
const { createDefaultPoiEffectComponent } = await import('../../src/editor/model/poiEffect.ts');
hooks.deregister();
const { NullEngine, Scene, AssetContainer, MeshBuilder, PBRMaterial, StandardMaterial, Color3, VertexBuffer, Texture } = await import('@babylonjs/core');

const environment = {
  packagePath: 'C:/fixture/environment', lengthUnit: 'meter', unitScaleToMeters: 1,
  placementMode: 'scene-base', visible: true, opacity: 1,
  transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  activeVariantUrl: 'editor-asset://local/environment.glb',
  variants: [{ name: 'environment', sourcePath: 'C:/fixture/environment.glb', sourceUrl: 'editor-asset://local/environment.glb' }],
};

function setup(t, beforeLoad) {
  const engine = new NullEngine(), scene = new Scene(engine);
  void scene.defaultMaterial;
  const external = new StandardMaterial('ordinary-device', scene);
  const imported = [];
  let loads = 0, effects;
  const runtime = new SceneEnvironmentRuntime(scene, {
    resolveAssetUrl: value => value,
    withBuildingEffectMutation: mutate => effects.withTargetMutation(ENVIRONMENT_EFFECT_TARGET_ID, mutate),
    loadAssetContainer: async () => {
      loads++;
      await beforeLoad?.();
      const container = new AssetContainer(scene);
      for (const Material of [PBRMaterial, StandardMaterial]) {
        const material = new Material(Material.name, scene);
        material.emissiveColor = new Color3(0.03, 0.04, 0.05);
        material.alpha = 0.8;
        if (material instanceof StandardMaterial) {
          material.diffuseColor = new Color3(0.5, 0.6, 0.7);
          material.useEmissiveAsIllumination = true;
          material.linkEmissiveWithDiffuse = true;
        }
        const mesh = MeshBuilder.CreateGround(Material.name, { width: 2, height: 2 }, scene);
        mesh.material = material;
        container.meshes.push(mesh); container.materials.push(material);
        scene.removeMesh(mesh); scene.removeMaterial(material);
      }
      imported.push(container);
      return container;
    },
  });
  effects = new TargetModelEffects(scene, id => id === ENVIRONMENT_EFFECT_TARGET_ID ? runtime.getBuildingEffectTarget() : null);
  t.after(() => { runtime.dispose(); effects.dispose(); scene.dispose(); engine.dispose(); });
  return { scene, runtime, effects, imported, external, get loads() { return loads; }, apply: value => runtime.apply(value ?? environment, { requestId: null, autoAlign: false }) };
}

function assertLit(material) {
  assert.equal(material.disableLighting, false);
  if (material instanceof PBRMaterial) assert.equal(material.unlit, false);
  assert.equal(material.isFrozen, true);
}

test('环境默认接受统一场景照明，保留自发光与透明度且不重载资源', async t => {
  const h = setup(t); await h.apply();
  const [pbr, standard] = h.imported[0].meshes.map(mesh => mesh.material);
  for (const material of [pbr, standard]) assertLit(material);
  assert.deepEqual(standard.emissiveColor.asArray(), [0.03, 0.04, 0.05]);
  assert.equal(standard.useEmissiveAsIllumination, true); assert.equal(standard.linkEmissiveWithDiffuse, true);
  await h.apply({ ...environment, opacity: .5 });
  assert.equal(standard.alpha, .4); assert.equal(h.external.disableLighting, false); assert.equal(h.loads, 1);
});

test('加载过程中关闭投影，提交的环境仍受光且不接收阴影', async t => {
  let unblock; const wait = new Promise(resolve => { unblock = resolve; });
  const h = setup(t, () => wait), pending = h.apply();
  await h.runtime.syncLighting({ enabled: false }); unblock(); await pending;
  for (const mesh of h.imported[0].meshes) { assertLit(mesh.material); assert.equal(mesh.receiveShadows, false); }
  assert.equal(h.loads, 1);
});

test('投影开关不切换材质或重复创建资源，间接光工作材质保持稳定', async t => {
  const h = setup(t); await h.apply();
  const meshes = h.imported[0].meshes, materials = meshes.map(mesh => mesh.material);
  const materialCount = h.scene.materials.length, textureCount = h.scene.textures.length;
  for (let i = 0; i < 6; i++) await h.runtime.syncLighting({ enabled: i % 2 === 0 });
  meshes.forEach((mesh, index) => { assert.equal(mesh.material, materials[index]); assertLit(mesh.material);
    assert.equal(mesh.material.pluginManager?.getPlugin('EnvironmentShadow') ?? null, null); });
  assert.equal(h.scene.materials.length, materialCount); assert.equal(h.scene.textures.length, textureCount);
});

test('旧太阳PNG参数无法重新进入环境正式显示路径', async t => {
  const h = setup(t); await h.apply({ ...environment, opacity: .5 });
  const textures = h.scene.textures.length;
  await h.runtime.syncLighting({ enabled: true, mode: 'baked', bake: { version: 1, signature: 'old', surfaces:
    h.runtime.getLightingSurfaces().map(surface => ({ key: surface.key, kind: 'shadow-mask', dataUrl: 'data:image/png;base64,unused', width: 1, height: 1, uvBounds: [-1, -1, 1, 1] })) } });
  for (const mesh of h.imported[0].meshes) { assertLit(mesh.material); assert.equal(mesh.material.alpha, .4);
    assert.equal(mesh.material.lightmapTexture, null); assert.equal(mesh.getVerticesData(VertexBuffer.UV3Kind), null); }
  assert.equal(h.scene.textures.length, textures);
});

test('建筑特效覆盖和环境透明度在投影开关后保持，释放特效恢复统一受光材质', async t => {
  const h = setup(t); await h.apply({ ...environment, opacity: .5 });
  const mesh = h.imported[0].meshes[0], working = mesh.material;
  const effect = createDefaultPoiEffectComponent('xray');
  effect.visual.targetEntityId = ENVIRONMENT_EFFECT_TARGET_ID; effect.visual.opacity = .4;
  h.effects.sync('effect', effect, true);
  assert.ok(Math.abs(mesh.material.alpha - .16) < .000001);
  await h.runtime.syncLighting({ enabled: false });
  assert.equal(mesh.material.backFaceCulling, false); assert.ok(Math.abs(mesh.material.alpha - .16) < .000001);
  h.effects.disposeMissing(new Set());
  assertLit(mesh.material); assert.equal(mesh.material.alpha, .4); assert.equal(mesh.material, working);
});

test('只切换天空显示不会重置昼夜有效IBL强度，显式照明强度更改仍生效', t => {
  const engine = new NullEngine(), scene = new Scene(engine), runtime = new SceneSkyboxRuntime(scene);
  const mesh = MeshBuilder.CreateSphere('skybox', {}, scene), material = new PBRMaterial('skybox-material', scene);
  const texture = new Texture(null, scene); texture.rotationY = 0;
  mesh.material = material;
  runtime.active = { entityKey: 'skybox', signature: null, mesh, material, texture };
  runtime.desired = { entityId: null, visible: true, pickable: false, selected: false,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    skybox: { rotationDegrees: 0, intensity: 1 } };
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  runtime.setLightingOverrides({ visible: true, intensity: .8 });
  scene.environmentIntensity = .24;
  runtime.setLightingOverrides({ visible: false, intensity: .8 });
  assert.equal(mesh.isEnabled(), false); assert.equal(scene.environmentTexture, texture);
  assert.equal(scene.environmentIntensity, .24);
  runtime.setLightingOverrides({ visible: false, intensity: .6 });
  assert.equal(scene.environmentIntensity, .6);
});
