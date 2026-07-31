import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptySceneDocument,
  type SceneCameraPose,
} from '../../src/editor/model/SceneDocument';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';
import { applySavedSceneCameraView } from '../../src/runtime/babylon/sceneCameraView';

const SAVED_POSE: SceneCameraPose = {
  alpha: 1.2,
  beta: 0.01,
  radius: 42,
  target: { x: 10, y: 5, z: -3 },
};

test('完整相机视角可随场景文件序列化往返', () => {
  const scene = createEmptySceneDocument('完整相机视角');
  scene.sceneSettings.camera.savedPose = SAVED_POSE;
  scene.sceneSettings.camera.savedOrientation = 'top';
  scene.sceneSettings.camera.savedProjection = 'orthographic';

  const restored = deserializeScene(serializeScene(scene));

  assert.deepEqual(restored.sceneSettings.camera, {
    savedPose: SAVED_POSE,
    savedOrientation: 'top',
    savedProjection: 'orthographic',
    viewDistance: scene.sceneSettings.camera.viewDistance,
  });
});

test('旧场景缺少朝向和投影字段时回退为轨道透视且保留旧位姿', () => {
  const scene = createEmptySceneDocument('旧相机视角');
  scene.sceneSettings.camera.savedPose = SAVED_POSE;
  const legacyFile = JSON.parse(serializeScene(scene)) as {
    scene: { sceneSettings: { camera: Record<string, unknown> } };
  };
  delete legacyFile.scene.sceneSettings.camera.savedOrientation;
  delete legacyFile.scene.sceneSettings.camera.savedProjection;

  const restored = deserializeScene(JSON.stringify(legacyFile));

  assert.deepEqual(restored.sceneSettings.camera.savedPose, SAVED_POSE);
  assert.equal(restored.sceneSettings.camera.savedOrientation, 'orbit');
  assert.equal(restored.sceneSettings.camera.savedProjection, 'perspective');
});

test('未保存位姿时忽略孤立模式字段并回退默认视角', () => {
  const sceneFile = JSON.parse(serializeScene(createEmptySceneDocument('未保存相机视角'))) as {
    scene: { sceneSettings: { camera: Record<string, unknown> } };
  };
  sceneFile.scene.sceneSettings.camera.savedPose = null;
  sceneFile.scene.sceneSettings.camera.savedOrientation = 'top';
  sceneFile.scene.sceneSettings.camera.savedProjection = 'orthographic';

  const restored = deserializeScene(JSON.stringify(sceneFile));

  assert.equal(restored.sceneSettings.camera.savedPose, null);
  assert.equal(restored.sceneSettings.camera.savedOrientation, 'orbit');
  assert.equal(restored.sceneSettings.camera.savedProjection, 'perspective');
});

test('场景文件显式携带非法相机模式时拒绝加载', () => {
  const sceneFile = JSON.parse(serializeScene(createEmptySceneDocument('非法相机视角'))) as {
    scene: { sceneSettings: { camera: Record<string, unknown> } };
  };
  sceneFile.scene.sceneSettings.camera.savedOrientation = 'side';

  assert.throws(
    () => deserializeScene(JSON.stringify(sceneFile)),
    /场景文件格式不受支持/,
  );
});

test('应用已保存视角时先解除旧俯视锁，再恢复位姿、投影和最终朝向', () => {
  const calls: Array<[string, unknown]> = [];

  applySavedSceneCameraView({
    applyCameraPose: (pose) => calls.push(['pose', pose]),
    setCameraOrientation: (orientation) => calls.push(['orientation', orientation]),
    setCameraProjection: (projection) => calls.push(['projection', projection]),
  }, {
    savedPose: SAVED_POSE,
    savedOrientation: 'top',
    savedProjection: 'orthographic',
    viewDistance: 5000,
  });

  assert.deepEqual(calls, [
    ['orientation', 'orbit'],
    ['pose', SAVED_POSE],
    ['projection', 'orthographic'],
    ['orientation', 'top'],
  ]);
});
