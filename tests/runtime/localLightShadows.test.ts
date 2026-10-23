import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DirectionalLight, FreeCamera, Material, MeshBuilder, MultiMaterial, NullEngine, PBRMaterial,
  PointLight, Scene, SpotLight, StandardMaterial, Vector3,
} from '@babylonjs/core';
import { SceneShadowRuntime } from '../../src/runtime/babylon/SceneShadowRuntime.ts';

const settings = {
  enabled: true, mode: 'hybrid' as const, quality: 'balanced' as const,
  darkness: 0.32, catcherEnabled: true, sunAzimuthDegrees: 56, sunElevationDegrees: 63,
  sunIntensity: 1.05, distanceMeters: 0, bias: 0.002, normalBias: 0.03, fillIntensity: 0.2, iblIntensityMax: 0.45,
};

async function renderReady(scene: Scene): Promise<void> {
  scene.render();
  await scene.whenReadyAsync();
  scene.render();
}

for (const MaterialClass of [PBRMaterial, StandardMaterial]) {
  for (const kind of ['point', 'spot'] as const) {
    test(`${MaterialClass.name} 冻结接收面首次渲染后新增 ${kind} 必须编译实际阴影定义`, async () => {
      const engine = new NullEngine(), scene = new Scene(engine);
      const camera = new FreeCamera('camera', new Vector3(0, 8, -12), scene);
      camera.setTarget(Vector3.Zero());
      const runtime = new SceneShadowRuntime(scene);
      const floor = MeshBuilder.CreateGround('floor', { width: 20, height: 20 }, scene);
      floor.metadata = { editorEnvironmentMesh: true };
      const material = new MaterialClass('floor', scene);
      floor.material = material;
      runtime.applySettings(settings);
      material.freeze();
      const hasShadow = (light: PointLight | SpotLight) => {
        const index = floor.lightSources.indexOf(light);
        return index >= 0 && new RegExp('^#define SHADOW' + index + '$', 'm').test(floor.subMeshes[0].effect?.defines ?? '');
      };
      try {
        await renderReady(scene);
        assert.equal(floor.receiveShadows, true);
        const light = kind === 'point'
          ? new PointLight('local', new Vector3(0, 4, 0), scene)
          : new SpotLight('local', new Vector3(0, 4, 0), Vector3.Down(), Math.PI / 3, 2, scene);
        light.range = 20;
        runtime.syncLight('local', light);
        await renderReady(scene);
        assert.ok(hasShadow(light), '已冻结材质必须加入新局部灯的 SHADOW 定义');
        const first = light.getShadowGenerator();
        runtime.applySettings({ ...settings, quality: 'quality' });
        await renderReady(scene);
        assert.notEqual(light.getShadowGenerator(), first);
        assert.ok(hasShadow(light));
        for (const toggle of ['hidden', 'zero'] as const) {
          if (toggle === 'hidden') light.setEnabled(false); else light.intensity = 0;
          runtime.syncLight('local', light);
          await renderReady(scene);
          assert.equal(hasShadow(light), false, '停用局部灯必须移除阴影采样');
          light.setEnabled(true); light.intensity = 1;
          runtime.syncLight('local', light);
          await renderReady(scene);
          assert.ok(hasShadow(light), '恢复局部灯必须重新编译阴影采样');
        }
        const second = new PointLight('second', new Vector3(3, 4, 0), scene);
        runtime.syncLight('second', second);
        await renderReady(scene);
        runtime.removeLight('local');
        await renderReady(scene);
        assert.equal(hasShadow(light), false, '还有其他局部灯时删除也必须刷新');
        assert.ok(hasShadow(second));
        light.dispose();
        const replacement = kind === 'point'
          ? new SpotLight('replacement', new Vector3(0, 4, 0), Vector3.Down(), Math.PI / 3, 2, scene)
          : new PointLight('replacement', new Vector3(0, 4, 0), scene);
        runtime.syncLight('second', replacement);
        second.dispose();
        await renderReady(scene);
        assert.ok(hasShadow(replacement));
        const index = floor.lightSources.indexOf(replacement);
        const lightDefine = replacement instanceof PointLight ? 'POINTLIGHT' : 'SPOTLIGHT';
        assert.match(floor.subMeshes[0].effect!.defines, new RegExp('^#define ' + lightDefine + index + '$', 'm'));
        runtime.applySettings({ ...settings, enabled: false });
        await renderReady(scene);
        assert.equal(hasShadow(replacement), false);
        runtime.applySettings(settings);
        await renderReady(scene);
        assert.ok(hasShadow(replacement), '重新开启混合投影后恢复实际阴影 shader');
        assert.equal(material.isFrozen, true, '灯光变化不得丢失原冻结状态');
      } finally { runtime.dispose(); scene.dispose(); engine.dispose(); }
    });
  }
}

test('灯光拓扑变更按共享及 MultiMaterial 子材质去重，普通变换不重编译', async () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new FreeCamera('camera', new Vector3(0, 8, -12), scene);
  camera.setTarget(Vector3.Zero());
  const runtime = new SceneShadowRuntime(scene);
  const shared = new StandardMaterial('shared', scene), other = new PBRMaterial('other', scene);
  const unfrozen = new StandardMaterial('unfrozen', scene);
  const multi = new MultiMaterial('multi', scene);
  multi.subMaterials = [shared, other, shared];
  for (const material of [shared, multi, unfrozen]) {
    const floor = MeshBuilder.CreateGround(material.name, { width: 2, height: 2 }, scene);
    floor.metadata = { editorEnvironmentMesh: true }; floor.material = material;
  }
  runtime.applySettings(settings);
  shared.freeze(); other.freeze(); multi.freeze();
  try {
    await renderReady(scene);
    const calls = new Map<Material, number>();
    for (const material of [shared, other, multi, unfrozen]) {
      const original = material.markAsDirty.bind(material);
      material.markAsDirty = (flag) => {
        if (flag === Material.LightDirtyFlag) calls.set(material, (calls.get(material) ?? 0) + 1);
        original(flag);
      };
    }
    const point = new PointLight('point', new Vector3(0, 4, 0), scene);
    runtime.syncLight('point', point);
    for (const material of [shared, other, multi]) {
      assert.equal(calls.get(material), 1, '每个共享或子材质只刷新一次灯光定义');
      assert.equal(material.isFrozen, true);
    }
    assert.equal(unfrozen.isFrozen, false, '普通受光材质不得被意外冻结');
    calls.clear();
    point.position.x = 2; point.intensity = 2;
    runtime.syncLight('point', point);
    runtime.applySettings({ ...settings, bias: 0, normalBias: 0, distanceMeters: 120 });
    assert.equal(calls.size, 0, '位置、正强度与偏移变化无需刷新 shader');
    const theme = new DirectionalLight('theme', Vector3.Down(), scene);
    runtime.setManagedLight(theme);
    for (const material of [shared, other, multi]) assert.equal(calls.get(material), 1, '主题主方向光更替需要刷新冻结材质');
  } finally { runtime.dispose(); scene.dispose(); engine.dispose(); }
});

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
      assert.equal(shadowMap._shouldRender(), true, '混合管线每帧合成动态投影，静态深度复用由独立cache管理');
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
      runtime.applySettings({ ...settings, enabled: false });
      assert.equal(light.getShadowGenerator(), null, '关闭投影后不得残留局部阴影资源');
      runtime.applySettings(settings);
      runtime.removeLight('local');
      assert.equal(light.getShadowGenerator(), null);
    } finally {
      runtime.dispose(); scene.dispose(); engine.dispose();
    }
  });
}

test('同一灯光实体从点光切到聚光时释放旧贴图，其他局部灯继续投影', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  new FreeCamera('camera', new Vector3(0, 4, -10), scene);
  const runtime = new SceneShadowRuntime(scene);
  const first = new PointLight('first', new Vector3(-2, 4, 0), scene);
  const second = new PointLight('second', new Vector3(2, 4, 0), scene);
  const replacement = new SpotLight('replacement', new Vector3(-2, 4, 0), Vector3.Down(), Math.PI / 3, 2, scene);
  try {
    runtime.applySettings(settings);
    runtime.syncLight('first', first);
    runtime.syncLight('second', second);
    const oldGenerator = first.getShadowGenerator()!;
    const secondGenerator = second.getShadowGenerator();
    assert.ok(oldGenerator.getShadowMap());
    runtime.syncLight('first', replacement);
    assert.equal(first.getShadowGenerator(), null);
    assert.equal(oldGenerator.getShadowMap(), null, '替换类型不能遗留旧 Cube 阴影图');
    assert.ok(replacement.getShadowGenerator());
    assert.equal(replacement.getShadowGenerator()!.getShadowMap()!.isCube, false);
    assert.equal(second.getShadowGenerator(), secondGenerator, '更换一盏灯不应重建其他灯贴图');
    replacement.intensity = 0;
    runtime.syncLight('first', replacement);
    assert.equal(replacement.getShadowGenerator(), null);
    assert.equal(second.getShadowGenerator(), secondGenerator);
    replacement.intensity = 1;
    runtime.syncLight('first', replacement);
    assert.ok(replacement.getShadowGenerator());
    runtime.removeLight('second');
    assert.equal(second.getShadowGenerator(), null);
    assert.ok(replacement.getShadowGenerator());
    runtime.dispose();
    assert.equal(replacement.getShadowGenerator(), null);
  } finally { runtime.dispose(); scene.dispose(); engine.dispose(); }
});
