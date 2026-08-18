import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptySceneDocument } from '../../src/editor/model/SceneDocument';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';

test('场景默认模型生成器随序列化往返保留', () => {
  const scene = createEmptySceneDocument('默认生成器');
  scene.sceneSettings.defaultCargoGeneratorId = 'entity_generator_1';

  const restored = deserializeScene(serializeScene(scene));

  assert.equal(restored.sceneSettings.defaultCargoGeneratorId, 'entity_generator_1');
});

test('旧场景文件缺少默认模型生成器字段时回退 null', () => {
  const scene = createEmptySceneDocument('旧场景');
  const legacyFile = JSON.parse(serializeScene(scene)) as {
    scene: { sceneSettings: Record<string, unknown> };
  };
  delete legacyFile.scene.sceneSettings.defaultCargoGeneratorId;

  const restored = deserializeScene(JSON.stringify(legacyFile));

  assert.equal(restored.sceneSettings.defaultCargoGeneratorId, null);
});

test('默认模型生成器字段非法值归一化为 null，空白 trim，超长截断', () => {
  const scene = createEmptySceneDocument('非法值');
  const sceneFile = JSON.parse(serializeScene(scene)) as {
    scene: { sceneSettings: Record<string, unknown> };
  };

  sceneFile.scene.sceneSettings.defaultCargoGeneratorId = 42;
  assert.equal(deserializeScene(JSON.stringify(sceneFile)).sceneSettings.defaultCargoGeneratorId, null);

  sceneFile.scene.sceneSettings.defaultCargoGeneratorId = '   ';
  assert.equal(deserializeScene(JSON.stringify(sceneFile)).sceneSettings.defaultCargoGeneratorId, null);

  sceneFile.scene.sceneSettings.defaultCargoGeneratorId = '  entity_gen  ';
  assert.equal(deserializeScene(JSON.stringify(sceneFile)).sceneSettings.defaultCargoGeneratorId, 'entity_gen');

  sceneFile.scene.sceneSettings.defaultCargoGeneratorId = 'x'.repeat(200);
  assert.equal(
    deserializeScene(JSON.stringify(sceneFile)).sceneSettings.defaultCargoGeneratorId,
    'x'.repeat(128),
  );
});
