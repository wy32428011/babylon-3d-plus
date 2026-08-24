import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCENE_CAMERA_ORIENTATIONS,
  STANDARD_SCENE_CAMERA_ORIENTATIONS,
  createEmptySceneDocument,
  type SceneCameraPose,
  type StandardSceneCameraOrientation,
} from '../../src/editor/model/SceneDocument';
import {
  getShortestCameraAlphaDelta,
  getStandardCameraViewAngles,
  resolveCompassAxisOffset,
} from '../../src/editor/model/cameraOrientation';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';
import { applySavedSceneCameraView } from '../../src/runtime/babylon/sceneCameraView';

const SAVED_POSE: SceneCameraPose = {
  alpha: 1.2,
  beta: 0.01,
  radius: 42,
  target: { x: 10, y: 5, z: -3 },
};

const EXPECTED_CAMERA_SIDES: Record<StandardSceneCameraOrientation, readonly [number, number, number]> = {
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  front: [0, 0, -1],
  back: [0, 0, 1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
};

function assertApproximately(actual: number, expected: number, message: string, epsilon = 0.02): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}：expected=${expected} actual=${actual}`);
}

test('完整相机视角可随场景文件序列化往返', () => {
  const scene = createEmptySceneDocument('完整相机视角');
  scene.sceneSettings.camera.savedPose = SAVED_POSE;
  scene.sceneSettings.camera.savedOrientation = 'front';
  scene.sceneSettings.camera.savedProjection = 'orthographic';

  const restored = deserializeScene(serializeScene(scene));

  assert.deepEqual(restored.sceneSettings.camera, {
    savedPose: SAVED_POSE,
    savedOrientation: 'front',
    savedProjection: 'orthographic',
    viewDistance: scene.sceneSettings.camera.viewDistance,
  });
});

test('场景鼠标灵敏度可随场景文件序列化往返', () => {
  const scene = createEmptySceneDocument('鼠标灵敏度');
  scene.sceneSettings.sensitivity = { zoom: 6, pan: 4, rotate: 8 };

  const restored = deserializeScene(serializeScene(scene));

  assert.deepEqual(restored.sceneSettings.sensitivity, { zoom: 6, pan: 4, rotate: 8 });
});

test('旧场景缺少灵敏度字段时回填默认值', () => {
  const scene = createEmptySceneDocument('旧灵敏度');
  const sceneFile = JSON.parse(serializeScene(scene)) as {
    scene: { sceneSettings: { sensitivity?: unknown } };
  };
  delete sceneFile.scene.sceneSettings.sensitivity;

  const restored = deserializeScene(JSON.stringify(sceneFile));

  assert.deepEqual(restored.sceneSettings.sensitivity, {
    zoom: 10,
    pan: 10,
    rotate: 10,
  });
});

test('全部轨道和六面朝向都属于稳定场景枚举并可序列化', () => {
  assert.deepEqual(SCENE_CAMERA_ORIENTATIONS, ['orbit', 'top', 'bottom', 'front', 'back', 'left', 'right']);
  assert.deepEqual(STANDARD_SCENE_CAMERA_ORIENTATIONS, ['top', 'bottom', 'front', 'back', 'left', 'right']);

  for (const orientation of SCENE_CAMERA_ORIENTATIONS) {
    const scene = createEmptySceneDocument(`相机朝向 ${orientation}`);
    scene.sceneSettings.camera.savedPose = SAVED_POSE;
    scene.sceneSettings.camera.savedOrientation = orientation;
    const restored = deserializeScene(serializeScene(scene));
    assert.equal(restored.sceneSettings.camera.savedOrientation, orientation);
  }
});

test('六个标准视角映射到已确认的世界坐标相机侧', () => {
  for (const orientation of STANDARD_SCENE_CAMERA_ORIENTATIONS) {
    const { alpha, beta } = getStandardCameraViewAngles(orientation);
    const sinBeta = Math.sin(beta);
    const cameraSide = [
      Math.cos(alpha) * sinBeta,
      Math.cos(beta),
      Math.sin(alpha) * sinBeta,
    ] as const;
    const expected = EXPECTED_CAMERA_SIDES[orientation];

    assertApproximately(cameraSide[0], expected[0], `${orientation} camera side X`);
    assertApproximately(cameraSide[1], expected[1], `${orientation} camera side Y`);
    assertApproximately(cameraSide[2], expected[2], `${orientation} camera side Z`);
  }
});

test('相机 alpha 动画始终选择不超过半圈的最短路径', () => {
  const from = 170 * Math.PI / 180;
  const to = -170 * Math.PI / 180;
  const delta = getShortestCameraAlphaDelta(from, to);

  assertApproximately(delta, 20 * Math.PI / 180, '跨越正负 PI 时必须只旋转 20°', 1e-9);
  assert.ok(Math.abs(delta) <= Math.PI);
});

test('深度轴正负端点使用相反回退位置，保持两个点击目标可访问', () => {
  const front = resolveCompassAxisOffset(0, 0, -1, [0.72, 0.7], 37, 24);
  const back = resolveCompassAxisOffset(0, 0, 1, [0.72, 0.7], 37, 24);

  assertApproximately(front.x, 17.28, '前向深度端点 X', 1e-9);
  assertApproximately(front.y, 16.8, '前向深度端点 Y', 1e-9);
  assertApproximately(back.x, -17.28, '后向深度端点 X', 1e-9);
  assertApproximately(back.y, -16.8, '后向深度端点 Y', 1e-9);
  assert.notDeepEqual(front, back);
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
  sceneFile.scene.sceneSettings.camera.savedOrientation = 'front';
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

test('编辑器恢复已保存视角时默认恢复标准面硬锁', () => {
  const calls: Array<[string, unknown, unknown]> = [];
  const settings = {
    savedPose: SAVED_POSE,
    savedOrientation: 'front' as const,
    savedProjection: 'orthographic' as const,
    viewDistance: 5000,
  };

  applySavedSceneCameraView({
    applyCameraView: (cameraSettings, options) => calls.push(['view', cameraSettings, options]),
  }, settings);

  assert.deepEqual(calls, [[
    'view',
    settings,
    { animate: true, lockStandardOrientation: true },
  ]]);
});

test('发布 Viewer 只恢复保存画面而不继承标准面硬锁', () => {
  const calls: Array<[string, unknown, unknown]> = [];
  const settings = {
    savedPose: SAVED_POSE,
    savedOrientation: 'front' as const,
    savedProjection: 'orthographic' as const,
    viewDistance: 5000,
  };

  applySavedSceneCameraView({
    applyCameraView: (cameraSettings, options) => calls.push(['view', cameraSettings, options]),
  }, settings, { animate: false, lockStandardOrientation: false });

  assert.deepEqual(calls, [[
    'view',
    settings,
    { animate: false, lockStandardOrientation: false },
  ]]);
});
