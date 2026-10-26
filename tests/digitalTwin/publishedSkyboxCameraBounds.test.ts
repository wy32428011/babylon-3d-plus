import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ArcRotateCamera, CubeTexture, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import '@babylonjs/core/Helpers/sceneHelpers.js';

test('原生天空不钳制相机位置、轨道半径或已有上限', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0, Math.PI / 2, 25000, new Vector3(30000, 100, 30000), scene);
  camera.maxZ = 600; camera.upperRadiusLimit = 50000;
  const environment = new CubeTexture('', scene);
  try {
    const sky = scene.createDefaultSkybox(environment, true, 1000, 0, false)!;
    const before = { radius: camera.radius, upper: camera.upperRadiusLimit, maxZ: camera.maxZ, target: camera.target.asArray() };
    camera.getViewMatrix(true);
    assert.equal(sky.infiniteDistance, true);
    assert.equal(sky.ignoreCameraMaxZ, true);
    assert.equal(sky.isPickable, false);
    assert.deepEqual({ radius: camera.radius, upper: camera.upperRadiusLimit, maxZ: camera.maxZ, target: camera.target.asArray() }, before);
    assert.equal(scene.environmentTexture, null, 'helper 不接管统一 IBL');
  } finally { scene.dispose(); engine.dispose(); }
});

test('Viewer 已移除有限球体边界，仍应用保存的视角和可视距离', async () => {
  const source = await readFile(new URL('../../src/player/PlayerApp.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /publishedSkyboxCameraBounds|skyboxCameraBounds|createPublishedSkyboxCameraBoundsController/);
  assert.match(source, /setViewDistance\(sceneDocument\.sceneSettings\.camera\.viewDistance\)/);
  assert.match(source, /applySavedSceneCameraView\(viewport, sceneDocument\.sceneSettings\.camera/);
});

test('天空不进入聚焦和 Gizmo，普通模型/环境处理保留', async () => {
  const root = '../../src/runtime/babylon/scene-runtime/';
  const bounds = await readFile(new URL(root + 'SceneWorldBoundsController.ts', import.meta.url), 'utf8');
  const transforms = await readFile(new URL(root + 'SceneTransformPreviewController.ts', import.meta.url), 'utf8');
  const focus = await readFile(new URL('../../src/editor/panels/scene-view/useSceneFocusTransition.ts', import.meta.url), 'utf8');
  assert.match(bounds, /skyboxRuntime\.hasEntity\(entityId\)\) return null/);
  assert.doesNotMatch(transforms, /skyboxRuntime\.getMesh/);
  assert.doesNotMatch(focus, /SKYBOX_FOCUS_VIEW_DISTANCE_METERS|containsSkybox/);
  assert.match(focus, /getEnvironmentWorldBounds/);
});
