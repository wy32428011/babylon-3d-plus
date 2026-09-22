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
const { createEnvironmentColorBakeMaterial } = await import('../../src/runtime/babylon/EnvironmentShadowBake.ts');
const { TargetModelEffects } = await import('../../src/runtime/babylon/effects/TargetModelEffects.ts');
const { ENVIRONMENT_EFFECT_TARGET_ID } = await import('../../src/editor/model/environmentBuildingEffect.ts');
const { createDefaultPoiEffectComponent } = await import('../../src/editor/model/poiEffect.ts');
hooks.deregister();
const { NullEngine, Scene, AssetContainer, MeshBuilder, PBRMaterial, StandardMaterial, Color3, VertexBuffer } = await import('@babylonjs/core');

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

function bakeFor(h, kind) {
  return { version: 1, signature: kind, createdAt: '2026-09-22T00:00:00Z', surfaces: h.runtime.getShadowBakeSurfaces().map(surface => ({
    key: surface.key, kind, dataUrl: `data:image/png;base64,${kind}`, width: 1, height: 1, uvBounds: [-1, -1, 1, 1],
  })) };
}

test('默认环境保持隔离，主题启用真实受光并可无损切回，切换不重载资源', async t => {
  const h = setup(t); await h.apply();
  const [pbr, standard] = h.imported[0].materials;
  assert.equal(pbr.unlit, true); assert.equal(standard.disableLighting, true);
  assert.deepEqual(standard.emissiveColor.asArray(), standard.diffuseColor.asArray());
  await h.runtime.setLightingMode('scene');
  for (const material of [pbr, standard]) assertLit(material);
  assert.deepEqual(standard.emissiveColor.asArray(), [0.03, 0.04, 0.05]);
  assert.equal(standard.useEmissiveAsIllumination, true);
  assert.equal(standard.linkEmissiveWithDiffuse, true);
  await h.apply({ ...environment, opacity: 0.5 });
  assert.equal(standard.alpha, 0.4);
  await h.runtime.setLightingMode('original');
  assert.equal(pbr.unlit, true); assert.equal(pbr.disableLighting, true);
  assert.deepEqual(standard.emissiveColor.asArray(), standard.diffuseColor.asArray());
  assert.equal(standard.alpha, 0.4);
  await h.runtime.setLightingMode('scene');
  assert.deepEqual(standard.emissiveColor.asArray(), [0.03, 0.04, 0.05]);
  assert.equal(h.external.disableLighting, false);
  assert.equal(h.loads, 1);
});

test('加载过程中切换主题，提交环境使用最新受光模式', async t => {
  let unblock; const wait = new Promise(resolve => { unblock = resolve; });
  const h = setup(t, () => wait), pending = h.apply();
  await h.runtime.setLightingMode('scene'); unblock(); await pending;
  for (const material of h.imported[0].materials) assertLit(material);
  assert.equal(h.loads, 1);
});

test('实时阴影随受光模式切换：隔离模式插件与受光模式内置阴影不重复采样', async t => {
  const h = setup(t); await h.apply();
  await h.runtime.syncShadows({ enabled: true, mode: 'realtime', bake: null });
  const meshes = h.imported[0].meshes;
  assert.ok(meshes[0].material.pluginManager.getPlugin('EnvironmentShadow'));
  const isolated = meshes[0].material;
  await h.runtime.setLightingMode('scene');
  for (const mesh of meshes) {
    assertLit(mesh.material); assert.equal(mesh.receiveShadows, true);
    assert.equal(mesh.material.pluginManager?.getPlugin('EnvironmentShadow') ?? null, null);
  }
  assert.notEqual(meshes[0].material, isolated);
  await h.runtime.setLightingMode('original');
  assert.ok(meshes[0].material.pluginManager.getPlugin('EnvironmentShadow'));
  assert.equal(meshes[0].material.unlit, true);
  assert.equal(h.loads, 1);
});

test('静态遮罩和旧颜色烘焙均保留阴影纹理且接受新灯光，透明度不重复叠加', async t => {
  const h = setup(t); await h.apply({ ...environment, opacity: 0.5 });
  for (const kind of ['shadow-mask', 'color']) {
    await h.runtime.syncShadows({ enabled: true, mode: 'baked', bake: bakeFor(h, kind) });
    await h.runtime.setLightingMode('scene');
    for (const mesh of h.imported[0].meshes) {
      assertLit(mesh.material); assert.equal(mesh.material.alpha, 0.4);
      assert.equal(mesh.receiveShadows, false);
      if (kind === 'shadow-mask') {
        assert.equal(mesh.material.useLightmapAsShadowmap, true);
        assert.equal(mesh.material.lightmapTexture.coordinatesIndex, 2);
        assert.ok(mesh.getVerticesData(VertexBuffer.UV3Kind));
      } else {
        assert.ok(mesh.material instanceof PBRMaterial ? mesh.material.albedoTexture : mesh.material.diffuseTexture);
        assert.deepEqual(mesh.material.emissiveColor.asArray(), [0, 0, 0]);
      }
    }
    await h.runtime.setLightingMode('original');
    assert.equal(h.imported[0].meshes[0].material.unlit, true);
  }
  await h.runtime.syncShadows({ enabled: false, mode: 'baked', bake: null });
  assert.equal(h.imported[0].meshes[0].getVerticesData(VertexBuffer.UV3Kind), null);
  assert.equal(h.loads, 1);
});

test('建筑特效覆盖和环境透明度在主题切换后恢复到最新真实材质', async t => {
  const h = setup(t); await h.apply({ ...environment, opacity: 0.5 });
  const effect = createDefaultPoiEffectComponent('xray');
  effect.visual.targetEntityId = ENVIRONMENT_EFFECT_TARGET_ID; effect.visual.opacity = 0.4;
  h.effects.sync('effect', effect, true);
  const mesh = h.imported[0].meshes[0];
  assert.ok(Math.abs(mesh.material.alpha - 0.16) < 0.000001);
  await h.runtime.setLightingMode('scene');
  assert.notEqual(mesh.material, h.imported[0].materials[0]);
  assert.equal(mesh.material.backFaceCulling, false);
  assert.ok(Math.abs(mesh.material.alpha - 0.16) < 0.000001);
  h.effects.disposeMissing(new Set());
  assertLit(mesh.material); assert.equal(mesh.material.alpha, 0.4);
  assert.equal(mesh.material, h.imported[0].materials[0]);
});

test('静态纹理异步加载期间再次切换主题，旧事务不能覆盖最新模式且释放临时资源', async t => {
  const h = setup(t); await h.apply();
  await h.runtime.syncShadows({ enabled: true, mode: 'baked', bake: bakeFor(h, 'shadow-mask') });
  const materialCount = h.scene.materials.length, textureCount = h.scene.textures.length;
  const mesh = h.imported[0].meshes[0], original = mesh.material;
  const pending = h.runtime.setLightingMode('scene');
  await h.runtime.setLightingMode('original');
  await pending;
  assert.equal(mesh.material, original);
  assert.equal(mesh.material.unlit, true);
  assert.equal(h.scene.materials.length, materialCount);
  assert.equal(h.scene.textures.length, textureCount);
  await h.runtime.setLightingMode('scene');
  assertLit(mesh.material);
  const applied = mesh.material;
  await h.runtime.setLightingMode('scene');
  assert.equal(mesh.material, applied, '重复应用不创建额外材质');
  assert.equal(h.scene.materials.length, materialCount);
  assert.equal(h.scene.textures.length, textureCount);
});

test('旧 UV 颜色烘焙只在临时副本中隔离主题灯光，避免把新灯光再次合入底色', async t => {
  const h = setup(t); await h.apply(); await h.runtime.setLightingMode('scene');
  for (const source of h.imported[0].materials) {
    const emission = source.emissiveColor.clone();
    const material = createEnvironmentColorBakeMaterial(source);
    try {
      assert.notEqual(material, source);
      assert.equal(material.disableLighting, true);
      if (material instanceof PBRMaterial) assert.equal(material.unlit, true);
      else {
        assert.deepEqual(material.emissiveColor.asArray(), material.diffuseColor.asArray());
        assert.equal(material.useEmissiveAsIllumination, false);
        assert.equal(material.linkEmissiveWithDiffuse, false);
      }
      assertLit(source);
      assert.deepEqual(source.emissiveColor.asArray(), emission.asArray());
    } finally { material.dispose(false, false); }
  }
});
