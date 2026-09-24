import assert from 'node:assert/strict';
import test from 'node:test';
import { FreeCamera, MeshBuilder, NullEngine, PointLight, Scene, SpotLight, Vector3 } from '@babylonjs/core';
import { SceneShadowRuntime } from '../../src/runtime/babylon/SceneShadowRuntime.ts';

const settings = {
  enabled: true, mode: 'realtime' as const, quality: 'balanced' as const,
  darkness: 0.32, catcherEnabled: true, sunAzimuthDegrees: 56, sunElevationDegrees: 63,
  sunIntensity: 1.05, distanceMeters: 0, bias: 0.002, normalBias: 0.03, fillIntensity: 0.2, iblIntensityMax: 0.45,
};

for (const kind of ['point', 'spot'] as const) {
  test(`${kind} 局部阴影跟随质量、变换、显隐和场景开关释放及恢复`, () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    new FreeCamera('camera', new Vector3(0, 4, -10), scene);
    const runtime = new SceneShadowRuntime(scene);
    const light = kind === 'point'
      ? new PointLight(kind, new Vector3(0, 4, 0), scene)
      : new SpotLight(kind, new Vector3(0, 4, 0), Vector3.Down(), Math.PI / 3, 2, scene);
    try {
      light.range = 20;
      const caster = MeshBuilder.CreateBox('equipment', {}, scene);
      runtime.applySettings(settings);
      runtime.syncLight('local', light);
      scene.onBeforeRenderObservable.notifyObservers(scene);
      const first = light.getShadowGenerator();
      assert.ok(first, 'Point/Spot 必须建立自己的投影');
      assert.equal(light.needCube(), kind === 'point', '点光覆盖六个方向，聚光灯使用锥体投影');
      assert.ok(first.getShadowMap()!.renderList!.includes(caster));
      assert.equal(caster.receiveShadows, true, '局部光需要普通受光表面接收阴影');
      const shadowMap = first.getShadowMap()!;
      shadowMap.resetRefreshCounter();
      assert.equal(shadowMap._shouldRender(), true);
      assert.equal(shadowMap._shouldRender(), false);
      caster.position.x = 3;
      caster.computeWorldMatrix(true);
      assert.equal(shadowMap._shouldRender(), true, '模型移动后缓存阴影必须刷新');
      light.position.x = 2;
      runtime.syncLight('local', light);
      assert.equal(shadowMap._shouldRender(), true, '灯光移动后缓存阴影必须刷新');
      runtime.applySettings({ ...settings, quality: 'quality' });
      assert.notEqual(light.getShadowGenerator(), first);
      assert.equal(light.getShadowGenerator()!.getShadowMap()!.refreshRate, 1);
      light.setEnabled(false);
      runtime.syncLight('local', light);
      assert.equal(light.getShadowGenerator(), null);
      light.setEnabled(true);
      runtime.syncLight('local', light);
      assert.ok(light.getShadowGenerator());
      runtime.applySettings({ ...settings, enabled: false });
      assert.equal(light.getShadowGenerator(), null);
      runtime.applySettings(settings);
      assert.ok(light.getShadowGenerator(), '重新启用阴影不应要求重新同步灯光实体');
      runtime.applySettings({ ...settings, mode: 'baked' });
      assert.equal(light.getShadowGenerator(), null, '静态烘焙模式不得创建局部实时阴影');
      runtime.applySettings(settings);
      runtime.removeLight('local');
      assert.equal(light.getShadowGenerator(), null);
    } finally {
      runtime.dispose(); scene.dispose(); engine.dispose();
    }
  });
}
