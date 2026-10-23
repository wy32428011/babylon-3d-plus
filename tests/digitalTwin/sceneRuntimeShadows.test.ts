import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import '../../src/runtime/babylon/babylonSideEffects.ts';
import { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture.js';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { Scene } from '@babylonjs/core/scene.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
// strip-only 入口只转换真实 rig 的参数属性；不替换类实现，也不改变生产构建。
const rigUrl = new URL('../../src/runtime/babylon/SceneLightRigRuntime.ts', import.meta.url);
const rigHooks = registerHooks({ load(url, context, nextLoad) {
  if (url === rigUrl.href) return { format: 'module', shortCircuit: true,
    source: stripTypeScriptTypes(readFileSync(rigUrl, 'utf8'), { mode: 'transform', sourceUrl: url }) };
  return nextLoad(url, context);
} });
const { SceneLightRigRuntime } = await import(rigUrl.href);
rigHooks.deregister();
import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';

import {
  EDITOR_FILL_LIGHT_NAME,
  EDITOR_FILL_LIGHT_INTENSITY,
  SCENE_SHADOW_CATCHER_NAME,
  SCENE_SHADOW_SUN_NAME,
  SceneShadowRuntime,
} from '../../src/runtime/babylon/SceneShadowRuntime.ts';

const DEFAULT_SHADOW_SETTINGS = {
  enabled: true,
  mode: 'realtime' as const,
  quality: 'balanced' as const,
  darkness: 0.32,
  catcherEnabled: true,
  sunAzimuthDegrees: 56,
  sunElevationDegrees: 63,
  sunIntensity: 1.05,
  distanceMeters: 0,
  bias: 0.002,
  normalBias: 0.03,
  fillIntensity: 0.2,
  iblIntensityMax: 0.45,
};

function createRuntimeFixture(withDirectional = false): { engine: NullEngine; scene: Scene; runtime: SceneShadowRuntime } {
  const engine = new NullEngine({ renderWidth: 640, renderHeight: 360 });
  const scene = new Scene(engine);
  const camera = new FreeCamera('ShadowTestCamera', new Vector3(0, 8, -12), scene);
  scene.activeCamera = camera;
  const runtime = new SceneShadowRuntime(scene);
  runtime.applySettings(DEFAULT_SHADOW_SETTINGS);
  if (withDirectional) {
    const light = new DirectionalLight('ExplicitShadowFixtureLight', new Vector3(-1, -2, 1), scene);
    runtime.syncLight('explicit-shadow-fixture-light', light);
  }
  return { engine, scene, runtime };
}

function disposeRuntimeFixture(fixture: ReturnType<typeof createRuntimeFixture>): void {
  fixture.runtime.dispose();
  fixture.scene.dispose();
  fixture.engine.dispose();
}

function flushScene(scene: Scene): void {
  scene.onBeforeRenderObservable.notifyObservers(scene);
}

function getActiveShadowGenerator(scene: Scene) {
  for (const light of scene.lights) {
    const generator = light.getShadowGenerator(scene.activeCamera) ?? light.getShadowGenerator();
    if (generator) return generator;
  }
  return null;
}

function assertPrimaryShadowGenerator(generator: unknown, message: string): asserts generator is ShadowGenerator {
  assert.ok(generator instanceof ShadowGenerator, message);
  if (CascadedShadowGenerator.IsSupported) {
    assert.ok(generator instanceof CascadedShadowGenerator, message);
  }
}

function assertAnyShadowGenerator(generator: unknown, message: string): asserts generator is ShadowGenerator {
  assert.ok(generator instanceof ShadowGenerator, message);
}

test('只有图表立标时不生成可见阴影地面，立标不影响普通模型的地面边界', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture();
  try {
    const marker = MeshBuilder.CreatePlane('ChartMarker', { size: 4 }, fixture.scene);
    const stem = MeshBuilder.CreateCylinder('ChartMarkerIndicator', { height: 2 }, fixture.scene);
    const base = MeshBuilder.CreateTorus('ChartMarkerBase', { diameter: 1 }, fixture.scene);
    for (const mesh of [marker, stem, base]) {
      mesh.metadata = { editorChartMarker: true };
      mesh.position.set(100, 30, 100);
    }
    flushScene(fixture.scene);
    const catcher = fixture.scene.getMeshByName(SCENE_SHADOW_CATCHER_NAME)!;
    assert.equal(catcher.isEnabled(), false, '拖入立标及指示器不能出现一块阴影地面');
    for (const quality of ['balanced', 'quality'] as const) {
      fixture.runtime.applySettings({ ...DEFAULT_SHADOW_SETTINGS, quality });
      const list = getActiveShadowGenerator(fixture.scene)?.getShadowMap()?.renderList ?? [];
      for (const mesh of [marker, stem, base]) {
        assert.equal(list.includes(mesh), false, '立标不是物理阴影投射物');
        assert.equal(mesh.receiveShadows, false);
      }
      assert.equal(catcher.isEnabled(), false);
    }
    const model = MeshBuilder.CreateBox('Equipment', { size: 2 }, fixture.scene);
    model.position.y = 1;
    flushScene(fixture.scene);
    assert.equal(catcher.isEnabled(), true, '普通模型的阴影地面继续按场景配置显示');
    assert.deepEqual(catcher.position.asArray(), [0, -0.03, 0], '远处悬浮立标不能抬高或移走地面');
    assert.equal(catcher.scaling.x, 60, '立标不能扩大模型的地面');
    fixture.runtime.applySettings({ ...DEFAULT_SHADOW_SETTINGS, catcherEnabled: false });
    assert.equal(catcher.isEnabled(), false);
    fixture.runtime.applySettings(DEFAULT_SHADOW_SETTINGS);
    assert.equal(catcher.isEnabled(), true);
    model.dispose();
    flushScene(fixture.scene);
    assert.equal(catcher.isEnabled(), false, '删除最后一个模型后仅有立标，不应残留地面');
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('统一光照显式创建主光，模型投射并接收而阴影管理器不创建太阳', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture();
  const rig = new SceneLightRigRuntime(fixture.scene);
  try {
    assert.equal(fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME), null);
    assert.equal(getActiveShadowGenerator(fixture.scene), null, '无实际光源时阴影管理器不能自行创建太阳');
    const cube = MeshBuilder.CreateBox('Cube', { size: 1 }, fixture.scene); cube.position.y = 0.5;
    fixture.runtime.setHybridMeshRoles(new Map([[cube, { mobility: 'static', castShadows: true, receiveShadows: true }]]));
    fixture.runtime.applySettings({ ...DEFAULT_SHADOW_SETTINGS, mode: 'hybrid', catcherEnabled: false });
    rig.sync(normalizeSceneLightingConfig({ main: { enabled: true }, bake: { enabled: false } }));
    fixture.runtime.setManagedLight(rig.mainLight); flushScene(fixture.scene);
    const main = rig.mainLight; assert.ok(main instanceof DirectionalLight);
    const generator = main.getShadowGenerator(); assertAnyShadowGenerator(generator, '显式主光必须创建投影');
    assert.equal(cube.receiveShadows, true); assert.ok(generator.getShadowMap()?.renderList?.includes(cube));
    const catcher = fixture.scene.getMeshByName(SCENE_SHADOW_CATCHER_NAME)!;
    assert.equal(catcher.isEnabled(), false, 'canonical 产品入口不启用代理接收地面');
    assert.equal(catcher.receiveShadows, true); assert.equal(catcher.isPickable, false);
    assert.equal(generator.getShadowMap()?.renderList?.includes(catcher), false);
    assert.equal(fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME), null);
  } finally { fixture.runtime.dispose(); rig.dispose(); disposeRuntimeFixture(fixture); }
});

test('显式 realtime 均衡档缓存阴影贴图，稳定帧不重复提交投射物', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(true);
  try {
    MeshBuilder.CreateBox('BalancedShadowCaster', { size: 1 }, fixture.scene);
    flushScene(fixture.scene);

    const generator = getActiveShadowGenerator(fixture.scene);
    assertAnyShadowGenerator(generator, '默认状态必须存在阴影生成器');
    const shadowMap = generator.getShadowMap();
    assert.ok(shadowMap);

    assert.equal(shadowMap.refreshRate, 0, '默认均衡档必须使用只渲染一次模式');
    shadowMap.resetRefreshCounter();
    assert.equal(shadowMap._shouldRender(), true);
    assert.equal(shadowMap._shouldRender(), false, '静态场景的下一帧不得重绘阴影贴图');
    assert.equal(shadowMap._shouldRender(), false, '后续稳定帧也不得重绘阴影贴图');
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('hybrid 环境和普通模型按角色接收阴影，对象例外不影响投射', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(true);
  try {
    const environment = MeshBuilder.CreateGround('FactoryFloor', { width: 20, height: 20 }, fixture.scene);
    environment.metadata = { editorEnvironmentMesh: true };
    const cube = MeshBuilder.CreateBox('Equipment', { size: 1 }, fixture.scene); cube.position.y = 0.5;
    const role = { mobility: 'static' as const, castShadows: true, receiveShadows: true };
    fixture.runtime.setHybridMeshRoles(new Map([[environment, role], [cube, role]]));
    fixture.runtime.applySettings({ ...DEFAULT_SHADOW_SETTINGS, mode: 'hybrid', catcherEnabled: false }); flushScene(fixture.scene);
    const generator = getActiveShadowGenerator(fixture.scene); assertAnyShadowGenerator(generator, '主光必须有投影');
    assert.equal(environment.receiveShadows, true); assert.equal(cube.receiveShadows, true);
    assert.ok(generator.getShadowMap()?.renderList?.includes(cube)); assert.ok(generator.getShadowMap()?.renderList?.includes(environment));
    fixture.runtime.setHybridMeshRoles(new Map([[environment, role], [cube, { ...role, receiveShadows: false }]]));
    assert.equal(cube.receiveShadows, false); assert.equal(environment.receiveShadows, true);
    assert.ok(generator.getShadowMap()?.renderList?.includes(cube), '关闭接收不能同时关闭投射');
  } finally { disposeRuntimeFixture(fixture); }
});

test('点光建立局部立方阴影，场景继续保留显式方向光', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(true);
  try {
    const ground = MeshBuilder.CreateGround('Ground', { width: 8, height: 8 }, fixture.scene);
    const cube = MeshBuilder.CreateBox('Cube', { size: 1 }, fixture.scene);
    const point = new PointLight('Point', new Vector3(0, 4, 0), fixture.scene);

    fixture.runtime.syncLight(point.name, point);
    flushScene(fixture.scene);

    assertAnyShadowGenerator(point.getShadowGenerator(), '实时模式点光必须创建局部阴影');
    assert.equal(point.needCube(), true, '点光向六个方向投射阴影');
    const autoSun = fixture.scene.getLightByName('ExplicitShadowFixtureLight');
    assert.ok(autoSun instanceof DirectionalLight);
    const shadowGenerator = autoSun.getShadowGenerator();
    assertAnyShadowGenerator(shadowGenerator, '主阴影光必须创建阴影生成器');
    for (const mesh of [ground, cube]) {
      assert.equal(mesh.receiveShadows, true, `${mesh.name} 必须接收局部光源阴影`);
      assert.ok(shadowGenerator.getShadowMap()?.renderList?.includes(mesh), `${mesh.name} 必须加入阴影投射列表`);
    }
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('显式方向光创建主阴影，阴影管理器不生成旧太阳光', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture();
  try {
    const ground = MeshBuilder.CreateGround('Ground', { width: 8, height: 8 }, fixture.scene);
    const cube = MeshBuilder.CreateBox('Cube', { size: 1 }, fixture.scene);
    cube.position.y = 0.5;
    const light = new DirectionalLight('Directional', new Vector3(0, -1, 0), fixture.scene);

    fixture.runtime.syncLight(light.name, light);

    assert.equal(fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME), null);
    const shadowGenerator = light.getShadowGenerator();
    assertAnyShadowGenerator(shadowGenerator, '方向光必须创建主阴影生成器');
    const renderList = shadowGenerator.getShadowMap()?.renderList ?? [];
    for (const mesh of [ground, cube]) {
      assert.equal(mesh.receiveShadows, false, `${mesh.name} 在缓存档不应承担阴影采样成本`);
      assert.ok(renderList.includes(mesh), `${mesh.name} 必须加入阴影投射列表`);
    }
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('零强度方向光不接管主阴影', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(true);
  try {
    const light = new DirectionalLight('DisabledDirectional', new Vector3(0, -1, 0), fixture.scene);
    light.intensity = 0;

    fixture.runtime.syncLight(light.name, light);

    assert.equal(light.getShadowGenerator(), null);
    const autoSun = fixture.scene.getLightByName('ExplicitShadowFixtureLight');
    assert.ok(autoSun instanceof DirectionalLight);
    assertAnyShadowGenerator(autoSun.getShadowGenerator(), '零强度方向光不得替换已注册的主阴影光');
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('方向光隐藏时回退显式备用光，再次显示后重新接管', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture();
  try {
    const light = new DirectionalLight('VisibilityDirectional', new Vector3(0, -1, 0), fixture.scene);
    const fallback = new DirectionalLight('VisibilityFallback', new Vector3(-1, -2, 1), fixture.scene);
    fixture.runtime.syncLight('fallback', fallback); fixture.runtime.setManagedLight(light); fixture.runtime.syncLight(light.name, light);
    assertAnyShadowGenerator(light.getShadowGenerator(), '显示的管理主光必须有投影');
    light.setEnabled(false); fixture.runtime.syncLight(light.name, light);
    assert.equal(light.getShadowGenerator(), null); assertAnyShadowGenerator(fallback.getShadowGenerator(), '主光隐藏后使用实际备用光');
    assert.equal(fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME), null);
    light.setEnabled(true); fixture.runtime.syncLight(light.name, light);
    assertAnyShadowGenerator(light.getShadowGenerator(), '管理主光再次显示后重新接管');
    assert.equal(getActiveShadowGenerator(fixture.scene)?.getLight(), light);
  } finally { disposeRuntimeFixture(fixture); }
});

test('灯光创建后异步加入场景的 Mesh 也会自动参与阴影', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture();
  try {
    const light = new DirectionalLight('Directional', new Vector3(0, -1, 0), fixture.scene);
    fixture.runtime.syncLight(light.name, light);
    const shadowGenerator = light.getShadowGenerator();
    assert.ok(shadowGenerator);

    const lateMesh = MeshBuilder.CreateBox('AsyncLoadedMesh', { size: 1 }, fixture.scene);
    flushScene(fixture.scene);
    assert.equal(lateMesh.receiveShadows, false);
    assert.ok(shadowGenerator.getShadowMap()?.renderList?.includes(lateMesh));
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('编辑器网格和天空盒不会污染阴影贴图', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture();
  try {
    const editorGrid = MeshBuilder.CreateGround('EditorGroundGrid', { width: 8, height: 8 }, fixture.scene);
    const skybox = MeshBuilder.CreateSphere('Skybox', { diameter: 100 }, fixture.scene);
    skybox.metadata = { editorSkyboxSphere: true };
    const light = new DirectionalLight('Directional', new Vector3(0, -1, 0), fixture.scene);

    fixture.runtime.syncLight(light.name, light);

    const renderList = light.getShadowGenerator()?.getShadowMap()?.renderList ?? [];
    assert.equal(editorGrid.receiveShadows, false);
    assert.equal(skybox.receiveShadows, false);
    assert.equal(renderList.includes(editorGrid), false);
    assert.equal(renderList.includes(skybox), false);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('编辑辅助 Mesh 不会产生实心假阴影', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture();
  try {
    const helperMeshes = [
      'entity_locatorRoot',
      'entity_modelGeneratorMarkerRoot',
      'entity_poiEffectRoot',
    ].map((rootName, index) => {
      const root = new TransformNode(rootName, fixture.scene);
      const mesh = MeshBuilder.CreateBox(`EditorHelper_${index}`, { size: 1 }, fixture.scene);
      mesh.parent = root;
      return mesh;
    });
    const light = new DirectionalLight('Directional', new Vector3(0, -1, 0), fixture.scene);

    fixture.runtime.syncLight(light.name, light);

    const renderList = light.getShadowGenerator()?.getShadowMap()?.renderList ?? [];
    for (const mesh of helperMeshes) {
      assert.equal(mesh.receiveShadows, false);
      assert.equal(renderList.includes(mesh), false);
    }
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('半球光保持环境补光，不创建 Babylon 不支持的阴影生成器', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(true);
  try {
    const light = new HemisphericLight('Hemispheric', new Vector3(0, 1, 0), fixture.scene);
    fixture.runtime.syncLight(light.name, light);
    assert.equal(light.getShadowGenerator(), null);
    assertAnyShadowGenerator(getActiveShadowGenerator(fixture.scene), '主阴影光必须创建阴影生成器');
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('删除方向光后选择显式备用光并释放原生成器', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture();
  try {
    const light = new DirectionalLight('Directional', new Vector3(0, -1, 0), fixture.scene);
    const fallback = new DirectionalLight('RemainingDirectional', new Vector3(-1, -2, 1), fixture.scene);
    fixture.runtime.syncLight('entity-light', light); fixture.runtime.syncLight('fallback', fallback);
    assertAnyShadowGenerator(light.getShadowGenerator(), '方向光必须创建主阴影生成器');
    fixture.runtime.removeLight('entity-light'); assert.equal(light.getShadowGenerator(), null);
    assertAnyShadowGenerator(fallback.getShadowGenerator(), '剩余方向光继续生成投影');
    assert.equal(fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME), null);
    fixture.runtime.removeLight('fallback'); assert.equal(fallback.getShadowGenerator(), null);
    assert.equal(getActiveShadowGenerator(fixture.scene), null, '无已注册光源时释放全部投影，不创建替代太阳');
    assert.equal(light.isDisposed(), false, '阴影管理器不拥有实体灯光');
  } finally { disposeRuntimeFixture(fixture); }
});

test('主光存在时补光强度由统一 rig 控制，阴影管理器不改写', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(); const rig = new SceneLightRigRuntime(fixture.scene);
  try {
    const editorLight = new HemisphericLight(EDITOR_FILL_LIGHT_NAME, Vector3.Up(), fixture.scene);
    editorLight.intensity = EDITOR_FILL_LIGHT_INTENSITY;
    rig.sync(normalizeSceneLightingConfig({ fill: { intensity: 0.2 }, bake: { enabled: false } }));
    fixture.runtime.setManagedLight(rig.mainLight); flushScene(fixture.scene);
    assert.equal(editorLight.intensity, 0.2); assertAnyShadowGenerator(getActiveShadowGenerator(fixture.scene), '显式主光参与投影');
    fixture.runtime.applySettings({ ...DEFAULT_SHADOW_SETTINGS, enabled: false });
    assert.equal(editorLight.intensity, 0.2, '投影开关不能覆盖补光配置');
    fixture.runtime.dispose(); rig.dispose(); assert.equal(editorLight.intensity, EDITOR_FILL_LIGHT_INTENSITY, 'rig释放恢复其拥有的基线');
  } finally { fixture.runtime.dispose(); rig.dispose(); disposeRuntimeFixture(fixture); }
});

test('阴影开关不夹紧 IBL，统一 rig 更新后保留最新环境强度', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(); const rig = new SceneLightRigRuntime(fixture.scene);
  try {
    fixture.scene.environmentTexture = new BaseTexture(fixture.scene); fixture.scene.environmentIntensity = 0.9;
    const config = normalizeSceneLightingConfig({ environmentIntensity: 0.9, bake: { enabled: false } });
    rig.sync(config); fixture.runtime.setManagedLight(rig.mainLight); flushScene(fixture.scene);
    assert.equal(fixture.scene.environmentIntensity, 0.9);
    rig.sync({ ...config, environmentIntensity: 0.75 }); flushScene(fixture.scene);
    assert.equal(fixture.scene.environmentIntensity, 0.75);
    fixture.runtime.applySettings({ ...DEFAULT_SHADOW_SETTINGS, enabled: false }); assert.equal(fixture.scene.environmentIntensity, 0.75);
    fixture.runtime.dispose(); rig.dispose(); assert.equal(fixture.scene.environmentIntensity, 0.9, '只有rig释放恢复其初始环境强度');
  } finally { fixture.runtime.dispose(); rig.dispose(); disposeRuntimeFixture(fixture); }
});

test('关闭场景阴影释放生成器，保留主光和补光并允许重新开启', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(); const rig = new SceneLightRigRuntime(fixture.scene);
  try {
    const editorLight = new HemisphericLight(EDITOR_FILL_LIGHT_NAME, Vector3.Up(), fixture.scene); editorLight.intensity = EDITOR_FILL_LIGHT_INTENSITY;
    rig.sync(normalizeSceneLightingConfig({ fill: { intensity: 0.2 }, bake: { enabled: false } })); fixture.runtime.setManagedLight(rig.mainLight);
    const main = rig.mainLight!; const generator = main.getShadowGenerator(); assertAnyShadowGenerator(generator, '开启时有投影');
    flushScene(fixture.scene); assert.equal(editorLight.intensity, 0.2);
    fixture.runtime.applySettings({ ...DEFAULT_SHADOW_SETTINGS, enabled: false });
    assert.equal(getActiveShadowGenerator(fixture.scene), null); assert.equal(main.isDisposed(), false); assert.equal(main.isEnabled(), true);
    assert.equal(fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME), null); assert.equal(fixture.scene.getMeshByName(SCENE_SHADOW_CATCHER_NAME)?.isEnabled(), false);
    assert.equal(editorLight.intensity, 0.2);
    fixture.runtime.applySettings(DEFAULT_SHADOW_SETTINGS); assertAnyShadowGenerator(main.getShadowGenerator(), '重新开启创建新投影');
    assert.notEqual(main.getShadowGenerator(), generator);
    fixture.runtime.dispose(); rig.dispose(); assert.equal(editorLight.intensity, EDITOR_FILL_LIGHT_INTENSITY);
  } finally { fixture.runtime.dispose(); rig.dispose(); disposeRuntimeFixture(fixture); }
});

test('阴影接收地面可独立隐藏且不影响主阴影生成器', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(true);
  try {
    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      catcherEnabled: false,
    });

    assertAnyShadowGenerator(getActiveShadowGenerator(fixture.scene), '关闭接收地面后仍应保留阴影生成器');
    assert.equal(fixture.scene.getMeshByName(SCENE_SHADOW_CATCHER_NAME)?.isEnabled(), false);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('只修改阴影浓度时复用现有生成器', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(true);
  try {
    const generator = getActiveShadowGenerator(fixture.scene);
    assertAnyShadowGenerator(generator, '初始状态必须存在阴影生成器');

    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      darkness: 0.6,
    });

    assert.equal(getActiveShadowGenerator(fixture.scene), generator);
    assert.equal(generator.darkness, 0.6);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('冻结材质的环境 Mesh 在缓存档仍会打开 receiveShadows', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture();
  try {
    const floor = MeshBuilder.CreateGround('FrozenFactoryFloor', { width: 20, height: 20 }, fixture.scene);
    floor.metadata = { editorEnvironmentMesh: true };
    const material = new StandardMaterial('FrozenFactoryFloorMaterial', fixture.scene);
    floor.material = material;
    material.freeze();
    flushScene(fixture.scene);

    assert.equal(floor.receiveShadows, true, '冻结材质的环境地面也必须接收阴影');
    assert.equal(material.isFrozen, true, '写入阴影标志后应恢复材质冻结');
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('高质量档让模型接收实时阴影', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(true);
  try {
    const cube = MeshBuilder.CreateBox('QualityShadowReceiver', { size: 1 }, fixture.scene);
    cube.position.y = 0.5;
    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      quality: 'quality',
    });
    flushScene(fixture.scene);

    assert.equal(cube.receiveShadows, true, '高质量档必须让模型接收阴影');
    const generator = getActiveShadowGenerator(fixture.scene);
    assertPrimaryShadowGenerator(generator, '高质量档必须使用实时阴影生成器');
    assert.equal(generator.getShadowMap()?.refreshRate, 1);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('切换高质量档时重建 2048 阴影贴图', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(true);
  try {
    const original = getActiveShadowGenerator(fixture.scene);
    assertAnyShadowGenerator(original, '初始状态必须存在阴影生成器');

    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      quality: 'quality',
    });

    const upgraded = getActiveShadowGenerator(fixture.scene);
    assertPrimaryShadowGenerator(upgraded, '高质量档必须存在阴影生成器');
    assert.notEqual(upgraded, original);
    assert.equal(upgraded.mapSize, 2048);
    assert.equal(
      upgraded.getShadowMap()?.refreshRate,
      1,
      '高质量档保留逐帧实时阴影',
    );
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('缓存阴影在投射物变换后只额外刷新一帧', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(true);
  try {
    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      quality: 'performance',
    });
    const cube = MeshBuilder.CreateBox('MovingCachedCaster', { size: 1 }, fixture.scene);
    flushScene(fixture.scene);

    const generator = getActiveShadowGenerator(fixture.scene);
    assertAnyShadowGenerator(generator, '性能档必须存在阴影生成器');
    const shadowMap = generator.getShadowMap();
    assert.ok(shadowMap);

    shadowMap.resetRefreshCounter();
    assert.equal(shadowMap._shouldRender(), true);
    assert.equal(shadowMap._shouldRender(), false);

    cube.position.x = 2;
    cube.computeWorldMatrix(true);

    assert.equal(shadowMap._shouldRender(), true, '变换后必须允许刷新阴影贴图');
    assert.equal(shadowMap._shouldRender(), false, '变换后只允许新增一次阴影贴图渲染');
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('缓存阴影在主方向光变化后只额外刷新一帧', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture();
  try {
    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      quality: 'performance',
    });
    const light = new DirectionalLight('CachedDirectional', new Vector3(0, -1, 0), fixture.scene);
    fixture.runtime.syncLight('cached-light', light);
    const shadowMap = light.getShadowGenerator()?.getShadowMap();
    assert.ok(shadowMap);

    shadowMap.resetRefreshCounter();
    assert.equal(shadowMap._shouldRender(), true);
    assert.equal(shadowMap._shouldRender(), false);

    light.direction.copyFromFloats(0.4, -1, 0.2).normalize();
    fixture.runtime.syncLight('cached-light', light);

    assert.equal(shadowMap._shouldRender(), true, '主光变化后必须允许刷新阴影贴图');
    assert.equal(shadowMap._shouldRender(), false, '主光变化后只允许新增一次阴影贴图渲染');
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('统一主光方位变化由真实 rig 立即更新方向和强度', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(); const rig = new SceneLightRigRuntime(fixture.scene);
  try {
    rig.sync(normalizeSceneLightingConfig({ main: { azimuthDegrees: 0, elevationDegrees: 45, intensity: 1.8 }, bake: { enabled: false } }));
    fixture.runtime.setManagedLight(rig.mainLight);
    const main = rig.mainLight; assert.ok(main instanceof DirectionalLight);
    assert.ok(Math.abs(main.direction.x) < 1e-5); assert.ok(Math.abs(main.direction.y - (-Math.SQRT1_2)) < 1e-5);
    assert.ok(Math.abs(main.direction.z - (-Math.SQRT1_2)) < 1e-5); assert.equal(main.intensity, 1.8);
    assert.equal(fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME), null);
  } finally { fixture.runtime.dispose(); rig.dispose(); disposeRuntimeFixture(fixture); }
});

test('手动阴影距离会写入生成器 shadowMaxZ', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(true);
  try {
    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      distanceMeters: 260,
    });

    const generator = getActiveShadowGenerator(fixture.scene);
    assertAnyShadowGenerator(generator, '设置距离后必须保留阴影生成器');
    if (generator instanceof CascadedShadowGenerator) {
      assert.equal(generator.shadowMaxZ, 260);
    } else {
      const light = generator.getLight();
      assert.ok(light instanceof DirectionalLight);
      assert.equal(light.shadowMaxZ, 260);
    }
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('只修改阴影偏移时复用现有生成器并热更新 bias', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(true);
  try {
    const generator = getActiveShadowGenerator(fixture.scene);
    assertAnyShadowGenerator(generator, '初始状态必须存在阴影生成器');

    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      bias: 0.008,
      normalBias: 0.06,
    });

    assert.equal(getActiveShadowGenerator(fixture.scene), generator);
    assert.equal(generator.bias, 0.008);
    assert.equal(generator.normalBias, 0.06);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('统一补光和环境强度可在阴影开启时调节，投影开关不恢复旧值', { timeout: 15_000 }, () => {
  const fixture = createRuntimeFixture(); const rig = new SceneLightRigRuntime(fixture.scene);
  try {
    const editorLight = new HemisphericLight(EDITOR_FILL_LIGHT_NAME, Vector3.Up(), fixture.scene); editorLight.intensity = EDITOR_FILL_LIGHT_INTENSITY;
    fixture.scene.environmentTexture = new BaseTexture(fixture.scene); fixture.scene.environmentIntensity = 0.9;
    const config = normalizeSceneLightingConfig({ fill: { intensity: 0.2 }, environmentIntensity: 0.45, bake: { enabled: false } });
    rig.sync(config); fixture.runtime.setManagedLight(rig.mainLight); flushScene(fixture.scene);
    assert.equal(editorLight.intensity, 0.2); assert.equal(fixture.scene.environmentIntensity, 0.45);
    rig.sync({ ...config, fill: { ...config.fill, intensity: 0.5 }, environmentIntensity: 0.3 });
    assert.equal(editorLight.intensity, 0.5); assert.equal(fixture.scene.environmentIntensity, 0.3);
    fixture.runtime.applySettings({ ...DEFAULT_SHADOW_SETTINGS, enabled: false });
    assert.equal(editorLight.intensity, 0.5); assert.equal(fixture.scene.environmentIntensity, 0.3, '关闭投影不覆盖最新统一照明');
    fixture.runtime.dispose(); rig.dispose(); assert.equal(editorLight.intensity, EDITOR_FILL_LIGHT_INTENSITY);
    assert.equal(fixture.scene.environmentIntensity, 0.9, '释放rig才恢复原始环境基线');
  } finally { fixture.runtime.dispose(); rig.dispose(); disposeRuntimeFixture(fixture); }
});
