import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DirectionalLight, FreeCamera, MeshBuilder, NullEngine, PBRMaterial, PointLight, Scene,
  SpotLight, StandardMaterial, TransformNode, Vector3,
} from '@babylonjs/core';
import { EnvironmentShadowMaterialPlugin } from '../../src/runtime/babylon/EnvironmentShadowMaterialPlugin.ts';
import { SceneShadowRuntime } from '../../src/runtime/babylon/SceneShadowRuntime.ts';

const REALTIME_SETTINGS = {
  enabled: true, mode: 'realtime' as const, quality: 'balanced' as const, darkness: 0.32, catcherEnabled: true,
  sunAzimuthDegrees: 56, sunElevationDegrees: 63, sunIntensity: 1.05, distanceMeters: 0,
  bias: 0.002, normalBias: 0.03, fillIntensity: 0.2, iblIntensityMax: 0.45,
};

for (const kind of ['pbr', 'standard']) {
  test(`${kind} 无光照环境登记阴影采样且冻结材质每次绘制重新绑定`, async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera('camera', new Vector3(0, 8, -12), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    const runtime = new SceneShadowRuntime(scene);
    runtime.applySettings(REALTIME_SETTINGS);
    const floor = MeshBuilder.CreateGround('floor', { width: 20, height: 20 }, scene);
    floor.metadata = { editorEnvironmentMesh: true };
    const material = kind === 'pbr' ? new PBRMaterial('floor', scene) : new StandardMaterial('floor', scene);
    material.disableLighting = true;
    if (material instanceof PBRMaterial) material.unlit = true;
    floor.material = material;
    const plugin = new EnvironmentShadowMaterialPlugin(material);
    let binds = 0;
    const originalBind = plugin.hardBindForSubMesh.bind(plugin);
    plugin.hardBindForSubMesh = (...args) => { binds++; originalBind(...args); };
    material.freeze();
    try {
      scene.render();
      await scene.whenReadyAsync();
      scene.render();
      const defines = floor.subMeshes[0].materialDefines;
      assert.ok(defines);
      assert.match(defines.toString(), /^#define SHADOWS$/m, '无普通光源时也必须编译内置阴影采样函数');
      assert.match(defines.toString(), /^#define ENVIRONMENT_SHADOW$/m);
      assert.ok(binds > 0, '插件必须注册冻结材质的每次绘制绑定事件');
      const previousBinds = binds;
      scene.render();
      assert.ok(binds > previousBinds);
      assert.equal(material.isFrozen, true);
      assert.equal(material.disableLighting, true);
      assert.equal(material.serialize().plugins?.EnvironmentShadow, undefined, '运行时插件不能污染源材质序列化');
      const userSun = new DirectionalLight('replacement', new Vector3(-1, -1, -1), scene);
      runtime.syncLight('sun', userSun);
      scene.render();
      assert.equal(material.isFrozen, true);
      runtime.dispose();
      scene.render();
      assert.doesNotMatch(floor.subMeshes[0].materialDefines!.toString(), /^#define ENVIRONMENT_SHADOW$/m);
    } finally { runtime.dispose(); scene.dispose(); engine.dispose(); }
  });
}

test('销毁环境材质后重建阴影不会再通知已释放的插件', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.activeCamera = new FreeCamera('camera', Vector3.Zero(), scene);
  const runtime = new SceneShadowRuntime(scene);
  runtime.applySettings(REALTIME_SETTINGS);
  const material = new StandardMaterial('environment', scene);
  const plugin = new EnvironmentShadowMaterialPlugin(material);
  material.dispose();
  plugin.refreshShadowDefines = () => { throw new Error('已释放插件仍被场景引用'); };
  try {
    runtime.syncLight('sun', new DirectionalLight('sun', Vector3.Down(), scene));
    runtime.syncLight('point', new PointLight('point', new Vector3(0, 4, 0), scene));
    runtime.applySettings({ ...REALTIME_SETTINGS, quality: 'quality' });
    runtime.removeLight('point');
    runtime.dispose();
  } finally { scene.dispose(); engine.dispose(); }
});

async function renderReady(scene: Scene): Promise<void> {
  scene.render();
  await scene.whenReadyAsync();
  scene.render();
}

function createEnvironment(kind: 'pbr' | 'standard') {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera('camera', new Vector3(0, 8, -12), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  const runtime = new SceneShadowRuntime(scene);
  runtime.applySettings(REALTIME_SETTINGS);
  const floor = MeshBuilder.CreateGround('environment', { width: 20, height: 20 }, scene);
  floor.metadata = { editorEnvironmentMesh: true };
  const material = kind === 'pbr' ? new PBRMaterial('environment', scene) : new StandardMaterial('environment', scene);
  material.disableLighting = true;
  if (material instanceof PBRMaterial) material.unlit = true;
  floor.material = material;
  const plugin = new EnvironmentShadowMaterialPlugin(material);
  material.freeze();
  return { engine, scene, runtime, floor, material, plugin,
    dispose: () => { runtime.dispose(); scene.dispose(); engine.dispose(); } };
}

for (const kind of ['pbr', 'standard'] as const) {
  test(kind + ' 冻结环境同时接收点光和聚光，质量与模式切换后解除旧绑定', async () => {
    const h = createEnvironment(kind);
    const point = new PointLight('point', new Vector3(-2, 4, 0), h.scene);
    const spot = new SpotLight('spot', new Vector3(2, 4, 0), Vector3.Down(), Math.PI / 3, 2, h.scene);
    point.range = spot.range = 20;
    const defines = () => h.floor.subMeshes[0].materialDefines!.toString();
    try {
      await renderReady(h.scene);
      h.runtime.syncLight('point', point);
      h.runtime.syncLight('spot', spot);
      await renderReady(h.scene);
      assert.match(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW0$/m, '环境需要消费第一盏局部光阴影');
      assert.match(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW1$/m, '第二盏局部光不能覆盖第一盏');
      assert.match(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW_CUBE0$/m);
      assert.doesNotMatch(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW_CUBE1$/m);
      const firstPoint = point.getShadowGenerator();
      h.runtime.applySettings({ ...REALTIME_SETTINGS, quality: 'quality' });
      await renderReady(h.scene);
      assert.notEqual(point.getShadowGenerator(), firstPoint);
      assert.match(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW1$/m);
      h.runtime.removeLight('point');
      await renderReady(h.scene);
      assert.equal(point.getShadowGenerator(), null);
      assert.match(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW0$/m);
      assert.doesNotMatch(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW_CUBE0$/m, '聚光移入旧点光槽后必须换为二维采样');
      assert.doesNotMatch(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW1$/m);
      h.runtime.applySettings({ ...REALTIME_SETTINGS, mode: 'baked' });
      await renderReady(h.scene);
      assert.doesNotMatch(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW\d+$/m);
      h.runtime.applySettings(REALTIME_SETTINGS);
      await renderReady(h.scene);
      assert.match(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW0$/m);
      assert.equal(h.material.isFrozen, true);
      assert.equal(h.material.disableLighting, true);
      if (h.material instanceof PBRMaterial) assert.equal(h.material.unlit, true);
      h.runtime.dispose();
      await renderReady(h.scene);
      assert.doesNotMatch(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW\d+$/m);
    } finally { h.dispose(); }
  });
}

for (const kind of ['point', 'spot'] as const) {
  test(kind + ' 局部阴影绑定世界位置、范围和深度，冻结材质移动后继续更新', async () => {
    const h = createEnvironment('pbr');
    const parent = new TransformNode('parent', h.scene);
    parent.position.set(3, 0, 1);
    parent.rotation.y = Math.PI / 2;
    const light = kind === 'point'
      ? new PointLight(kind, new Vector3(1, 4, 2), h.scene)
      : new SpotLight(kind, new Vector3(1, 4, 2), new Vector3(0, -1, 1), Math.PI / 3, 2, h.scene);
    light.parent = parent;
    light.range = 20;
    try {
      h.runtime.syncLight('local', light);
      await renderReady(h.scene);
      const subMesh = h.floor.subMeshes[0];
      const effect = subMesh.effect!;
      const values = new Map<string, number[]>();
      const setFloat = effect.setFloat;
      const setFloat2 = effect.setFloat2;
      const setFloat4 = effect.setFloat4;
      effect.setFloat = function (name, value) { values.set(name, [value]); return setFloat.call(this, name, value); };
      effect.setFloat2 = function (name, x, y) { values.set(name, [x, y]); return setFloat2.call(this, name, x, y); };
      effect.setFloat4 = function (name, x, y, z, w) { values.set(name, [x, y, z, w]); return setFloat4.call(this, name, x, y, z, w); };
      const approximately = (actual: number[] | undefined, expected: number[]) => {
        assert.ok(actual, '局部阴影 uniform 必须被写入');
        assert.equal(actual.length, expected.length);
        expected.forEach((value, index) => assert.ok(Math.abs(actual[index] - value) < 1e-5, 'uniform 世界坐标/范围错误'));
      };
      try {
        h.plugin.hardBindForSubMesh(h.material._uniformBuffer, h.scene, h.engine, subMesh);
        approximately(values.get('environmentLocalShadowActive0'), [1]);
        approximately(values.get('environmentLocalShadowPosition0'), [5, 4, 0, 20]);
        approximately(values.get('environmentLocalShadowDepth0'), [0.05, 20.05]);
        if (kind === 'spot') approximately(values.get('environmentLocalShadowDirection0'), [Math.SQRT1_2, -Math.SQRT1_2, 0, Math.cos(Math.PI / 6)]);
        parent.position.x += 2;
        parent.computeWorldMatrix(true);
        light.range = 7;
        h.runtime.syncLight('local', light);
        h.plugin.hardBindForSubMesh(h.material._uniformBuffer, h.scene, h.engine, subMesh);
        approximately(values.get('environmentLocalShadowPosition0'), [7, 4, 0, 7]);
        approximately(values.get('environmentLocalShadowDepth0'), [0.05, 7.05]);
        const compiledDefines = effect.defines;
        const setTexture = effect.setTexture;
        const setDepthStencilTexture = effect.setDepthStencilTexture;
        let textureBindings = 0;
        effect.setTexture = function (...args) {
          if (args[0].startsWith('shadowTextureEnvLocal')) textureBindings++;
          return setTexture.apply(this, args);
        };
        effect.setDepthStencilTexture = function (...args) {
          if (args[0].startsWith('shadowTextureEnvLocal')) textureBindings++;
          return setDepthStencilTexture.apply(this, args);
        };
        try {
          // 模拟异步编译尚未结束时仍在绘制相反采样器类型的旧 effect。
          effect.defines = kind === 'point'
            ? compiledDefines.replace('#define ENVIRONMENT_LOCAL_SHADOW_CUBE0\n', '')
            : compiledDefines + '#define ENVIRONMENT_LOCAL_SHADOW_CUBE0\n';
          h.plugin.hardBindForSubMesh(h.material._uniformBuffer, h.scene, h.engine, subMesh);
          approximately(values.get('environmentLocalShadowActive0'), [0]);
          // 主方向阴影仍可正常绑定，仅禁止不兼容的局部纹理。
          assert.equal(textureBindings, 0, '不兼容局部采样器不能绑定纹理');
        } finally {
          effect.defines = compiledDefines;
          effect.setTexture = setTexture;
          effect.setDepthStencilTexture = setDepthStencilTexture;
        }
        assert.equal(h.material.isFrozen, true);
      } finally {
        effect.setFloat = setFloat; effect.setFloat2 = setFloat2; effect.setFloat4 = setFloat4;
      }
    } finally { h.dispose(); }
  });
}

test('局部阴影槽有界，删除灯光后候补灯补入且不保留旧采样类型', async () => {
  const h = createEnvironment('standard');
  const lights = Array.from({ length: 5 }, (_, index) => new PointLight('point-' + index, new Vector3(index, 4, 0), h.scene));
  try {
    lights.forEach((light, index) => h.runtime.syncLight('light-' + index, light));
    await renderReady(h.scene);
    const defines = () => h.floor.subMeshes[0].materialDefines!.toString();
    for (let index = 0; index < 4; index++) {
      assert.ok(defines().includes('#define ENVIRONMENT_LOCAL_SHADOW' + index + '\n'));
    }
    assert.doesNotMatch(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW4$/m, '不得超出四个局部采样槽');
    const previousEffects = lights.map(light => light._uniformBuffer.currentEffect);
    h.plugin.hardBindForSubMesh(h.material._uniformBuffer, h.scene, h.engine, h.floor.subMeshes[0]);
    lights.forEach((light, index) => assert.equal(light._uniformBuffer.currentEffect, previousEffects[index],
      '无 UBO 引擎的环境阴影绑定不能改变普通材质使用的灯光 effect'));

    h.runtime.removeLight('light-0');
    await renderReady(h.scene);
    assert.match(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW3$/m, '候补灯补入后仍有四盏局部投影');
    for (let index = 1; index < lights.length; index++) h.runtime.removeLight('light-' + index);
    await renderReady(h.scene);
    assert.doesNotMatch(defines(), /^#define ENVIRONMENT_LOCAL_SHADOW\d+$/m);
    assert.match(defines(), /^#define ENVIRONMENT_SHADOW$/m, '清空局部灯仍保留主方向光');
  } finally { h.dispose(); }
});
