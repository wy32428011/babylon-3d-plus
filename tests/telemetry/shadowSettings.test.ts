import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SCENE_SHADOW_SETTINGS,
  createEmptySceneDocument,
  sanitizeSceneShadowSettings,
  sceneShadowConcentrationPercentToDarkness,
  sceneShadowDarknessToConcentrationPercent,
} from '../../src/editor/model/SceneDocument.ts';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer.ts';

test('阴影设置可随场景文件序列化往返', () => {
  const scene = createEmptySceneDocument('阴影设置');
  scene.sceneSettings.shadows = {
    enabled: false,
    quality: 'quality',
    darkness: 0.18,
    catcherEnabled: false,
  };

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

test('阴影设置清洗非法值并限制 darkness 范围', () => {
  assert.deepEqual(sanitizeSceneShadowSettings({
    enabled: true,
    quality: 'invalid' as 'balanced',
    darkness: 2,
    catcherEnabled: true,
  }), {
    enabled: true,
    quality: DEFAULT_SCENE_SHADOW_SETTINGS.quality,
    darkness: 0.85,
    catcherEnabled: true,
  });
});

test('Inspector 阴影浓度与 Babylon darkness 双向换算', () => {
  assert.equal(sceneShadowDarknessToConcentrationPercent(0.32), 68);
  assert.equal(sceneShadowConcentrationPercentToDarkness(68), 0.32);
  assert.equal(sceneShadowConcentrationPercentToDarkness(100), 0);
  assert.equal(sceneShadowConcentrationPercentToDarkness(0), 0.85);
});
