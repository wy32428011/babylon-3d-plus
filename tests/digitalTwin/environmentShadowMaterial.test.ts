import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DirectionalLight, FreeCamera, MeshBuilder, NullEngine, PBRMaterial, Scene,
  StandardMaterial, Vector3,
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
    runtime.dispose();
  } finally { scene.dispose(); engine.dispose(); }
});
