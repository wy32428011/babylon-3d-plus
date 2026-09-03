import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BaseTexture,
  CascadedShadowGenerator,
  DirectionalLight,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  NullEngine,
  PointLight,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';

import {
  EDITOR_FILL_LIGHT_NAME,
  EDITOR_FILL_LIGHT_INTENSITY,
  EDITOR_FILL_LIGHT_SHADOW_INTENSITY,
  SCENE_SHADOW_CATCHER_NAME,
  SCENE_SHADOW_SUN_NAME,
  SceneShadowRuntime,
} from '../../src/runtime/babylon/SceneShadowRuntime.ts';

const DEFAULT_SHADOW_SETTINGS = {
  enabled: true,
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

function createRuntimeFixture(): { engine: NullEngine; scene: Scene; runtime: SceneShadowRuntime } {
  const engine = new NullEngine({ renderWidth: 640, renderHeight: 360 });
  const scene = new Scene(engine);
  const camera = new FreeCamera('ShadowTestCamera', new Vector3(0, 8, -12), scene);
  scene.activeCamera = camera;
  const runtime = new SceneShadowRuntime(scene);
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
    const generator = light.getShadowGenerator();
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

test('只有图表立标时不生成可见阴影地面，立标不影响普通模型的地面边界', () => {
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

test('无方向光时自动创建太阳光，模型投射、地面接收缓存阴影', () => {
  const fixture = createRuntimeFixture();
  try {
    const cube = MeshBuilder.CreateBox('Cube', { size: 1 }, fixture.scene);
    cube.position.y = 0.5;
    flushScene(fixture.scene);

    const autoSun = fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME);
    assert.ok(autoSun instanceof DirectionalLight);
    const shadowGenerator = autoSun.getShadowGenerator();
    assertAnyShadowGenerator(shadowGenerator, '主阴影光必须创建阴影生成器');
    assert.equal(cube.receiveShadows, false, '默认缓存档模型只投射不采样，避免全场材质开销');
    assert.ok(shadowGenerator.getShadowMap()?.renderList?.includes(cube));

    const catcher = fixture.scene.getMeshByName(SCENE_SHADOW_CATCHER_NAME);
    assert.ok(catcher);
    assert.equal(catcher.receiveShadows, true);
    assert.equal(catcher.isPickable, false);
    assert.equal(shadowGenerator.getShadowMap()?.renderList?.includes(catcher), false);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('默认均衡档缓存阴影贴图，稳定帧不重复提交投射物', () => {
  const fixture = createRuntimeFixture();
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

test('环境 Mesh 在缓存档接收阴影，普通模型不接收', () => {
  const fixture = createRuntimeFixture();
  try {
    const environment = MeshBuilder.CreateGround('FactoryFloor', { width: 20, height: 20 }, fixture.scene);
    environment.metadata = { editorEnvironmentMesh: true };
    const cube = MeshBuilder.CreateBox('Equipment', { size: 1 }, fixture.scene);
    cube.position.y = 0.5;
    flushScene(fixture.scene);

    const generator = getActiveShadowGenerator(fixture.scene);
    assertAnyShadowGenerator(generator, '缓存档必须存在阴影生成器');
    assert.equal(environment.receiveShadows, true, '厂房地板必须接收模型影子');
    assert.equal(cube.receiveShadows, false, '设备模型不得承担阴影采样');
    assert.ok(generator.getShadowMap()?.renderList?.includes(cube));
    assert.ok(generator.getShadowMap()?.renderList?.includes(environment));
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('点光不建立方阴影，场景继续使用自动太阳光', () => {
  const fixture = createRuntimeFixture();
  try {
    const ground = MeshBuilder.CreateGround('Ground', { width: 8, height: 8 }, fixture.scene);
    const cube = MeshBuilder.CreateBox('Cube', { size: 1 }, fixture.scene);
    const point = new PointLight('Point', new Vector3(0, 4, 0), fixture.scene);

    fixture.runtime.syncLight(point.name, point);
    flushScene(fixture.scene);

    assert.equal(point.getShadowGenerator(), null, '点光默认不得创建立方阴影');
    const autoSun = fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME);
    assert.ok(autoSun instanceof DirectionalLight);
    const shadowGenerator = autoSun.getShadowGenerator();
    assertAnyShadowGenerator(shadowGenerator, '主阴影光必须创建阴影生成器');
    for (const mesh of [ground, cube]) {
      assert.equal(mesh.receiveShadows, false, `${mesh.name} 在缓存档不应承担阴影采样成本`);
      assert.ok(shadowGenerator.getShadowMap()?.renderList?.includes(mesh), `${mesh.name} 必须加入阴影投射列表`);
    }
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('方向光会接管主阴影并释放自动太阳光', () => {
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

test('零强度方向光不接管主阴影', () => {
  const fixture = createRuntimeFixture();
  try {
    const light = new DirectionalLight('DisabledDirectional', new Vector3(0, -1, 0), fixture.scene);
    light.intensity = 0;

    fixture.runtime.syncLight(light.name, light);

    assert.equal(light.getShadowGenerator(), null);
    const autoSun = fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME);
    assert.ok(autoSun instanceof DirectionalLight);
    assertAnyShadowGenerator(autoSun.getShadowGenerator(), '零强度方向光不得替换自动主阴影光');
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('方向光隐藏时回退自动太阳光，再次显示后重新接管', () => {
  const fixture = createRuntimeFixture();
  try {
    const light = new DirectionalLight('VisibilityDirectional', new Vector3(0, -1, 0), fixture.scene);
    fixture.runtime.syncLight(light.name, light);
    assertAnyShadowGenerator(light.getShadowGenerator(), '显示的方向光必须接管主阴影');

    light.setEnabled(false);
    fixture.runtime.syncLight(light.name, light);
    assert.equal(light.getShadowGenerator(), null);
    const autoSun = fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME);
    assert.ok(autoSun instanceof DirectionalLight);
    assertAnyShadowGenerator(autoSun.getShadowGenerator(), '方向光隐藏后必须回退自动主阴影光');

    light.setEnabled(true);
    fixture.runtime.syncLight(light.name, light);
    assert.equal(fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME), null);
    assertAnyShadowGenerator(light.getShadowGenerator(), '方向光再次显示后必须重新接管主阴影');
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('灯光创建后异步加入场景的 Mesh 也会自动参与阴影', () => {
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

test('编辑器网格和天空盒不会污染阴影贴图', () => {
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

test('编辑辅助 Mesh 不会产生实心假阴影', () => {
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

test('半球光保持环境补光，不创建 Babylon 不支持的阴影生成器', () => {
  const fixture = createRuntimeFixture();
  try {
    const light = new HemisphericLight('Hemispheric', new Vector3(0, 1, 0), fixture.scene);
    fixture.runtime.syncLight(light.name, light);
    assert.equal(light.getShadowGenerator(), null);
    assertAnyShadowGenerator(getActiveShadowGenerator(fixture.scene), '主阴影光必须创建阴影生成器');
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('删除方向光后回退自动太阳光并释放原生成器', () => {
  const fixture = createRuntimeFixture();
  try {
    const light = new DirectionalLight('Directional', new Vector3(0, -1, 0), fixture.scene);
    fixture.runtime.syncLight('entity-light', light);
    assertAnyShadowGenerator(light.getShadowGenerator(), '方向光必须创建主阴影生成器');

    fixture.runtime.removeLight('entity-light');
    assert.equal(light.getShadowGenerator(), null);
    const autoSun = fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME);
    assert.ok(autoSun instanceof DirectionalLight);
    assertAnyShadowGenerator(autoSun.getShadowGenerator(), '主阴影光必须创建阴影生成器');
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('存在主阴影光时压低 EditorLight 补光强度', () => {
  const fixture = createRuntimeFixture();
  try {
    const editorLight = new HemisphericLight(EDITOR_FILL_LIGHT_NAME, new Vector3(0, 1, 0), fixture.scene);
    editorLight.intensity = EDITOR_FILL_LIGHT_INTENSITY;
    flushScene(fixture.scene);
    assert.equal(editorLight.intensity, EDITOR_FILL_LIGHT_SHADOW_INTENSITY);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('阴影启用期间压低过强 IBL，关闭时恢复最新环境强度', () => {
  const fixture = createRuntimeFixture();
  try {
    fixture.scene.environmentTexture = new BaseTexture(fixture.scene);
    fixture.scene.environmentIntensity = 0.9;
    flushScene(fixture.scene);
    assert.equal(fixture.scene.environmentIntensity, 0.45);

    fixture.scene.environmentIntensity = 0.75;
    flushScene(fixture.scene);
    assert.equal(fixture.scene.environmentIntensity, 0.45);

    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      enabled: false,
    });
    assert.equal(fixture.scene.environmentIntensity, 0.75);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('关闭场景阴影时释放生成器和自动太阳光，并恢复编辑器补光', () => {
  const fixture = createRuntimeFixture();
  try {
    const editorLight = new HemisphericLight(EDITOR_FILL_LIGHT_NAME, new Vector3(0, 1, 0), fixture.scene);
    editorLight.intensity = EDITOR_FILL_LIGHT_INTENSITY;
    flushScene(fixture.scene);
    assert.equal(editorLight.intensity, EDITOR_FILL_LIGHT_SHADOW_INTENSITY);

    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      enabled: false,
    });

    assert.equal(getActiveShadowGenerator(fixture.scene), null);
    assert.equal(fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME), null);
    assert.equal(fixture.scene.getMeshByName(SCENE_SHADOW_CATCHER_NAME)?.isEnabled(), false);
    assert.equal(editorLight.intensity, EDITOR_FILL_LIGHT_INTENSITY);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('阴影接收地面可独立隐藏且不影响主阴影生成器', () => {
  const fixture = createRuntimeFixture();
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

test('只修改阴影浓度时复用现有生成器', () => {
  const fixture = createRuntimeFixture();
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

test('冻结材质的环境 Mesh 在缓存档仍会打开 receiveShadows', () => {
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

test('高质量档让模型接收实时阴影', () => {
  const fixture = createRuntimeFixture();
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

test('切换高质量档时重建 2048 阴影贴图', () => {
  const fixture = createRuntimeFixture();
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

test('缓存阴影在投射物变换后只额外刷新一帧', () => {
  const fixture = createRuntimeFixture();
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

test('缓存阴影在主方向光变化后只额外刷新一帧', () => {
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

test('太阳方位变化会立即更新自动太阳光方向和强度', () => {
  const fixture = createRuntimeFixture();
  try {
    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      sunAzimuthDegrees: 0,
      sunElevationDegrees: 45,
      sunIntensity: 1.8,
    });

    const autoSun = fixture.scene.getLightByName(SCENE_SHADOW_SUN_NAME);
    assert.ok(autoSun instanceof DirectionalLight);
    assert.ok(Math.abs(autoSun.direction.x) < 1e-5);
    assert.ok(Math.abs(autoSun.direction.y - (-Math.SQRT1_2)) < 1e-5);
    assert.ok(Math.abs(autoSun.direction.z - (-Math.SQRT1_2)) < 1e-5);
    assert.equal(autoSun.intensity, 1.8);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('手动阴影距离会写入生成器 shadowMaxZ', () => {
  const fixture = createRuntimeFixture();
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

test('只修改阴影偏移时复用现有生成器并热更新 bias', () => {
  const fixture = createRuntimeFixture();
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

test('补光强度和环境光上限可在阴影开启时调节', () => {
  const fixture = createRuntimeFixture();
  try {
    const editorLight = new HemisphericLight(EDITOR_FILL_LIGHT_NAME, new Vector3(0, 1, 0), fixture.scene);
    editorLight.intensity = EDITOR_FILL_LIGHT_INTENSITY;
    fixture.scene.environmentTexture = new BaseTexture(fixture.scene);
    fixture.scene.environmentIntensity = 0.9;
    flushScene(fixture.scene);
    assert.equal(editorLight.intensity, EDITOR_FILL_LIGHT_SHADOW_INTENSITY);
    assert.equal(fixture.scene.environmentIntensity, DEFAULT_SHADOW_SETTINGS.iblIntensityMax);

    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      fillIntensity: 0.5,
      iblIntensityMax: 0.3,
    });

    assert.equal(editorLight.intensity, 0.5);
    assert.equal(fixture.scene.environmentIntensity, 0.3);

    fixture.runtime.applySettings({
      ...DEFAULT_SHADOW_SETTINGS,
      enabled: false,
    });
    assert.equal(fixture.scene.environmentIntensity, 0.9, '调整上限后关闭阴影仍应恢复原始环境强度');
  } finally {
    disposeRuntimeFixture(fixture);
  }
});
