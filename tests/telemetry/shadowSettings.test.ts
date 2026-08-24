import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SCENE_SHADOW_SETTINGS,
  createEmptySceneDocument,
  sanitizeSceneShadowSettings,
  sceneShadowConcentrationPercentToDarkness,
  sceneShadowDarknessToConcentrationPercent,
  sceneShadowSunDirectionFromAngles,
} from '../../src/editor/model/SceneDocument.ts';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer.ts';

test('阴影设置可随场景文件序列化往返', () => {
  const scene = createEmptySceneDocument('阴影设置');
  scene.sceneSettings.shadows = sanitizeSceneShadowSettings({
    enabled: false,
    quality: 'quality',
    darkness: 0.18,
    catcherEnabled: false,
    sunAzimuthDegrees: 210,
    sunElevationDegrees: 40,
    sunIntensity: 1.4,
    distanceMeters: 220,
    bias: 0.004,
    normalBias: 0.05,
    fillIntensity: 0.35,
    iblIntensityMax: 0.6,
  });

  const restored = deserializeScene(serializeScene(scene));

  assert.deepEqual(restored.sceneSettings.shadows, scene.sceneSettings.shadows);
});

test('旧场景缺少阴影字段时回填默认设置', () => {
  const sceneFile = JSON.parse(serializeScene(createEmptySceneDocument('旧场景'))) as {
    scene: { sceneSettings: { shadows?: unknown } };
  };
  delete sceneFile.scene.sceneSettings.shadows;

  const restored = deserializeScene(JSON.stringify(sceneFile));

  assert.deepEqual(restored.sceneSettings.shadows, DEFAULT_SCENE_SHADOW_SETTINGS);
});

test('旧阴影设置缺少太阳和偏移字段时回填默认值', () => {
  const restored = sanitizeSceneShadowSettings({
    enabled: false,
    quality: 'quality',
    darkness: 0.18,
    catcherEnabled: false,
  });

  assert.equal(restored.enabled, false);
  assert.equal(restored.quality, 'quality');
  assert.equal(restored.darkness, 0.18);
  assert.equal(restored.catcherEnabled, false);
  assert.equal(restored.sunAzimuthDegrees, DEFAULT_SCENE_SHADOW_SETTINGS.sunAzimuthDegrees);
  assert.equal(restored.sunElevationDegrees, DEFAULT_SCENE_SHADOW_SETTINGS.sunElevationDegrees);
  assert.equal(restored.sunIntensity, DEFAULT_SCENE_SHADOW_SETTINGS.sunIntensity);
  assert.equal(restored.distanceMeters, DEFAULT_SCENE_SHADOW_SETTINGS.distanceMeters);
  assert.equal(restored.bias, DEFAULT_SCENE_SHADOW_SETTINGS.bias);
  assert.equal(restored.normalBias, DEFAULT_SCENE_SHADOW_SETTINGS.normalBias);
  assert.equal(restored.fillIntensity, DEFAULT_SCENE_SHADOW_SETTINGS.fillIntensity);
  assert.equal(restored.iblIntensityMax, DEFAULT_SCENE_SHADOW_SETTINGS.iblIntensityMax);
});

test('阴影设置清洗非法值并限制 darkness 范围', () => {
  assert.deepEqual(sanitizeSceneShadowSettings({
    enabled: true,
    quality: 'invalid' as 'balanced',
    darkness: 2,
    catcherEnabled: true,
    sunAzimuthDegrees: 400,
    sunElevationDegrees: 0,
    sunIntensity: 9,
    distanceMeters: 5000,
    bias: -1,
    normalBias: 3,
    fillIntensity: 4,
    iblIntensityMax: 2,
  }), {
    ...DEFAULT_SCENE_SHADOW_SETTINGS,
    enabled: true,
    darkness: 0.85,
    catcherEnabled: true,
    sunAzimuthDegrees: 360,
    sunElevationDegrees: 5,
    sunIntensity: 3,
    distanceMeters: 800,
    bias: 0,
    normalBias: 0.2,
    fillIntensity: 1,
    iblIntensityMax: 1,
  });
});

test('Inspector 阴影浓度与 Babylon darkness 双向换算', () => {
  assert.equal(sceneShadowDarknessToConcentrationPercent(0.32), 68);
  assert.equal(sceneShadowConcentrationPercentToDarkness(68), 0.32);
  assert.equal(sceneShadowConcentrationPercentToDarkness(100), 0);
  assert.equal(sceneShadowConcentrationPercentToDarkness(0), 0.85);
});

test('太阳方位与高度可换算为自动太阳光方向', () => {
  const north = sceneShadowSunDirectionFromAngles(0, 45);
  assert.ok(Math.abs(north.x) < 1e-6);
  assert.ok(Math.abs(north.y - (-Math.SQRT1_2)) < 1e-6);
  assert.ok(Math.abs(north.z - (-Math.SQRT1_2)) < 1e-6);

  const east = sceneShadowSunDirectionFromAngles(90, 45);
  assert.ok(Math.abs(east.x - (-Math.SQRT1_2)) < 1e-6);
  assert.ok(Math.abs(east.z) < 1e-6);
});
