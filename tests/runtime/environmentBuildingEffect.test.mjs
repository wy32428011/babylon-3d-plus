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
const { TargetModelEffects } = await import('../../src/runtime/babylon/effects/TargetModelEffects.ts');
const { ENVIRONMENT_EFFECT_TARGET_ID } = await import('../../src/editor/model/environmentBuildingEffect.ts');
const { createDefaultPoiEffectComponent } = await import('../../src/editor/model/poiEffect.ts');
hooks.deregister();
const { NullEngine, Scene, AssetContainer, MeshBuilder, PBRMaterial, StandardMaterial, RawTexture, HemisphericLight, Vector3 } = await import('@babylonjs/core');

function environment(sourceUrl = 'environment.glb') {
  sourceUrl = `editor-asset://local/${sourceUrl}`;
  return {
    packagePath: 'C:/environment', lengthUnit: 'meter', unitScaleToMeters: 1,
    placementMode: 'scene-base', displayName: '环境', activeVariantUrl: sourceUrl,
    variants: [{ name: '默认', sourcePath: `C:/${sourceUrl}`, sourceUrl }],
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 },
    visible: true, opacity: 1,
  };
}
function setup(t, prepare) {
  const engine = new NullEngine(), scene = new Scene(engine);
  void scene.defaultMaterial;
  const baselineMaterials = scene.materials.length;
  engine.getDeltaTime = () => 100;
  const baseObservers = scene.onBeforeRenderObservable.observers.length;
  const imported = [];
  let loads = 0, effects;
  const runtime = new SceneEnvironmentRuntime(scene, {
    resolveAssetUrl: value => value,
    withBuildingEffectMutation: mutate => effects.withTargetMutation(ENVIRONMENT_EFFECT_TARGET_ID, mutate),
    loadAssetContainer: async (_root, fileName) => {
      loads++;
      await prepare?.(fileName);
      const container = new AssetContainer(scene);
      for (const Material of [PBRMaterial, StandardMaterial]) {
        const mesh = MeshBuilder.CreateBox(`${fileName}-${Material.name}`, { height: 8 }, scene);
        mesh.position.y = 4;
        const material = new Material(`${mesh.name}-original`, scene);
        mesh.material = material;
        container.meshes.push(mesh); container.materials.push(material);
        scene.removeMesh(mesh); scene.removeMaterial(material);
      }
      imported.push(container);
      return container;
    },
  });
  effects = new TargetModelEffects(scene, id => id === ENVIRONMENT_EFFECT_TARGET_ID ? runtime.getBuildingEffectTarget() : null);
  const bind = (kind = 'model-scan') => {
    const component = typeof kind === 'string' ? createDefaultPoiEffectComponent(kind) : kind;
    component.visual.targetEntityId = ENVIRONMENT_EFFECT_TARGET_ID;
    effects.sync('environment-effect', component, true);
    return component;
  };
  const apply = value => runtime.apply(value, { requestId: null, autoAlign: false });
  const tick = () => effects.tick(0.1);
  t.after(() => { runtime.dispose(); effects.dispose(); scene.dispose(); engine.dispose(); });
  return { engine, scene, runtime, effects, bind, apply, tick, imported, baseObservers, baselineMaterials, get loads() { return loads; } };
}
const surfacePlugin = mesh => mesh.material.pluginManager.getPlugin('DigitalTwinModelSurface');

test('环境建筑特效独立覆盖材质，参数编辑不重载，清除后恢复无光照原材质', async t => {
  const h = setup(t), config = environment(), component = h.bind();
  const external = new PBRMaterial('普通设备材质', h.scene);
  const device = MeshBuilder.CreateBox('普通设备', {}, h.scene); device.material = external;
  await h.apply(config);
  const [mesh] = h.imported[0].meshes, original = h.imported[0].materials[0];
  assert.notEqual(mesh.material, original);
  assert.equal(original.unlit, true);
  assert.equal(mesh.material.isFrozen, false);
  assert.equal(mesh.isWorldMatrixFrozen, true);
  h.tick(); h.tick();
  const firstPhase = surfacePlugin(mesh).phase;
  component.speed = 0; component.primaryColor = '#ff1100';
  h.bind(component); h.tick();
  assert.equal(surfacePlugin(mesh).phase, firstPhase);
  assert.equal(h.loads, 1);
  assert.equal(device.material, external);
  assert.equal(external.unlit, false);
  h.effects.disposeMissing(new Set());
  assert.equal(mesh.material, original);
  assert.equal(original.isFrozen, true);
  assert.equal(h.scene.materials.filter(material => material.name.endsWith('_effect')).length, 0);
});

test('隐藏环境暂停建筑特效，恢复继续；透明度与 X-Ray 透明度相乘且 0 完全隐藏', async t => {
  const h = setup(t), config = environment(); h.bind();
  await h.apply(config);
  const [mesh] = h.imported[0].meshes;
  h.tick(); const phase = surfacePlugin(mesh).phase, material = mesh.material;
  await h.apply({ ...config, visible: false }); h.tick(); h.tick();
  assert.equal(surfacePlugin(mesh).phase, phase);
  assert.equal(mesh.material, material, '仅显隐不应重建材质');
  await h.apply(config); h.tick();
  assert.ok(surfacePlugin(mesh).phase > phase);
  const xray = h.bind('xray'); xray.visual.opacity = 0.4; h.bind(xray);
  await h.apply({ ...config, opacity: 0.5 });
  assert.equal(mesh.material.alpha, 0.2);
  await h.apply({ ...config, opacity: 0 }); h.tick();
  assert.equal(mesh.isEnabled(), false);
  assert.equal(mesh.material.alpha, 0);
  await h.apply({ ...config, opacity: 0.5 });
  h.effects.disposeMissing(new Set());
  assert.equal(mesh.material.alpha, 0.5);
  const edges = h.bind('model-edges');
  assert.equal(mesh.edgesColor.a, edges.visual.opacity * 0.5);
});

test('阴影展示切换重新绑定建筑特效，关闭恢复当前阴影材质并保持灯光隔离', async t => {
  const h = setup(t), config = environment(); h.bind('height-gradient');
  await h.apply(config);
  const [mesh] = h.imported[0].meshes, source = h.imported[0].materials[0];
  const firstEffect = mesh.material;
  await h.runtime.syncShadows({ enabled: true, mode: 'realtime', bake: null });
  assert.notEqual(mesh.material, firstEffect);
  assert.ok(surfacePlugin(mesh));
  assert.ok(mesh.material.pluginManager.getPlugin('EnvironmentShadow'));
  assert.equal(mesh.receiveShadows, true);
  h.effects.disposeMissing(new Set());
  assert.notEqual(mesh.material, source);
  assert.equal(mesh.material.pluginManager.getPlugin('DigitalTwinModelSurface'), null);
  const light = new HemisphericLight('日光', Vector3.Up(), h.scene); light.intensity = 0;
  assert.equal(mesh.material.unlit, true);
  await h.runtime.syncShadows({ enabled: false, mode: 'baked', bake: null });
  assert.equal(mesh.material, source);
  assert.equal(mesh.receiveShadows, false);
});

test('异步加载中最新绑定自动接管环境，变体替换和销毁清理覆盖', async t => {
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const h = setup(t, fileName => fileName === 'environment.glb' ? gate : undefined);
  h.bind('model-outline');
  const initial = h.apply(environment());
  h.bind('hologram');
  unblock(); await initial;
  assert.equal(h.loads, 1);
  const oldMesh = h.imported[0].meshes[0];
  assert.equal(oldMesh.material.wireframe, true);
  h.bind('model-edges');
  await h.apply(environment('variant.glb'));
  assert.equal(oldMesh.isDisposed(), true);
  assert.ok(h.imported.at(-1).meshes[0].edgesRenderer);
  h.runtime.clear();
  assert.equal(h.scene.materials.filter(material => material.name !== 'lineShader').length, h.baselineMaterials);
  assert.equal(h.runtime.getBuildingEffectTarget(), null);
  h.runtime.dispose();
  assert.equal(h.scene.onBeforeRenderObservable.observers.filter(observer => !observer._willBeUnregistered).length, h.baseObservers);
});

test('八类建筑特效均支持环境，切换后无克隆累积且自发光兼容 PBR 灯光隔离', async t => {
  const h = setup(t); await h.apply(environment());
  const container = h.imported[0], [mesh] = container.meshes;
  for (const kind of ['model-outline', 'model-edges', 'model-emissive', 'model-scan', 'height-gradient', 'hologram', 'xray', 'dissolve']) {
    h.bind(kind); h.tick();
    if (kind === 'model-outline') assert.equal(mesh.renderOutline, true);
    else if (kind === 'model-edges') assert.ok(mesh.edgesRenderer);
    else assert.notEqual(mesh.material, container.materials[0]);
    if (kind === 'model-emissive') {
      assert.equal(mesh.material.unlit, false);
      assert.equal(mesh.material.disableLighting, true);
      assert.equal(container.materials[0].unlit, true);
      assert.ok(mesh.material.emissiveColor.asArray().some(value => value > 0));
    }
    h.effects.disposeMissing(new Set());
    assert.equal(mesh.material, container.materials[0]);
    assert.equal(Boolean(mesh.renderOutline), false);
    assert.equal(h.scene.materials.filter(material => material.name !== 'lineShader').length, h.baselineMaterials + container.materials.length);
    assert.equal(h.scene.effectLayers.length, 0);
  }
});

test('环境工作容器中的实例与薄实例均显示特效，实例透明度只叠加一次', async t => {
  const h = setup(t); await h.apply(environment());
  const [source, thin] = h.imported[0].meshes;
  const instance = source.createInstance('environment-instance');
  instance.parent = source.parent;
  instance.metadata = { editorEnvironmentMesh: true };
  instance.position.x = 4;
  thin.thinInstanceSetBuffer('matrix', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]), 16);
  await h.apply({ ...environment(), opacity: 0.5 });
  const originalSource = source.material, originalThin = thin.material;
  const component = h.bind('xray'); component.visual.opacity = 0.4; h.bind(component);
  const proxy = h.scene.meshes.find(mesh => mesh.metadata?.digitalTwinEffectProxy);
  assert.ok(proxy);
  assert.equal(source.material.alpha, 0.2);
  assert.equal(proxy.material.alpha, 0.2);
  assert.equal(thin.material.alpha, 0.2);
  assert.notEqual(thin.material, originalThin);
  h.effects.disposeMissing(new Set());
  assert.equal(source.material, originalSource);
  assert.equal(thin.material, originalThin);
  assert.equal(proxy.isDisposed(), true);
  assert.equal(instance.isEnabled(false), true);
});

test('环境特效共享只读纹理并保留 UV 配置，反复编辑不复制贴图或改变原资源', async t => {
  const h = setup(t); await h.apply(environment());
  const [mesh] = h.imported[0].meshes, original = mesh.material;
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 100, 0, 255]), 1, 1, h.scene);
  texture.uScale = 3; texture.vOffset = 0.25; texture.coordinatesIndex = 1;
  original.unfreeze(); original.albedoTexture = texture; original.freeze();
  const baselineTextures = h.scene.textures.length;
  const component = h.bind('height-gradient');
  for (let index = 0; index < 5; index++) {
    component.intensity = 1 + index * 0.1; h.bind(component);
    assert.equal(mesh.material.albedoTexture, texture);
    assert.equal(mesh.material.albedoTexture.uScale, 3);
    assert.equal(mesh.material.albedoTexture.coordinatesIndex, 1);
    assert.equal(h.scene.textures.length, baselineTextures);
  }
  h.effects.disposeMissing(new Set());
  assert.equal(mesh.material, original);
  assert.equal(original.albedoTexture, texture);
  assert.equal(texture.vOffset, 0.25);
  assert.equal(h.scene.textures.length, baselineTextures);
});

test('环境绑定只接纳建筑外观白名单，不执行场景结构展开', async t => {
  const h = setup(t); await h.apply(environment());
  const [mesh] = h.imported[0].meshes, original = mesh.material, position = mesh.position.clone();
  h.bind('xray'); assert.notEqual(mesh.material, original);
  h.bind('explode'); h.tick();
  assert.equal(mesh.material, original);
  assert.deepEqual(mesh.position.asArray(), position.asArray());
});
