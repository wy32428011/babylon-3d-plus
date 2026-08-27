import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { CreateSphereVertexData } from '@babylonjs/core/Meshes/Builders/sphereBuilder.pure.js';
import { createServer } from 'vite';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
const {
  createEmptySceneDocument,
  createFolderEntity,
  createSkyboxEntity,
  SKYBOX_SPHERE_SEGMENTS,
} = await viteServer.ssrLoadModule('/src/editor/model/SceneDocument.ts') as typeof import(
  '../../src/editor/model/SceneDocument.ts'
);
const {
  createPublishedSkyboxCameraBoundsController,
  createPublishedSkyboxCameraBoundsControllerForDocument,
} = await viteServer.ssrLoadModule('/src/player/publishedSkyboxCameraBounds.ts') as typeof import(
  '../../src/player/publishedSkyboxCameraBounds.ts'
);
after(async () => {
  await viteServer.close();
});

function createCamera(): {
  engine: NullEngine;
  scene: Scene;
  camera: ArcRotateCamera;
} {
  const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720 });
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('PublishedSkyboxCameraBoundsTest', 0, Math.PI / 2, 10, Vector3.Zero(), scene);
  camera.getViewMatrix(true);
  return { engine, scene, camera };
}

function assertCameraInsideSphere(
  camera: ArcRotateCamera,
  center: Vector3,
  radiusMeters: number,
): void {
  camera.getViewMatrix(true);
  const distance = Vector3.Distance(camera.position, center);
  assert.ok(distance < radiusMeters, `相机距离 ${distance} 必须小于天空盒半径 ${radiusMeters}`);
}

function getMinimumUnitSphereFaceDistance(segments: number): number {
  const sphere = CreateSphereVertexData({ diameter: 2, segments });
  let minimumDistance = Number.POSITIVE_INFINITY;

  for (let offset = 0; offset < sphere.indices.length; offset += 3) {
    const points = [0, 1, 2].map((indexOffset) => {
      const vertexIndex = sphere.indices[offset + indexOffset];
      const positionOffset = vertexIndex * 3;
      return new Vector3(
        sphere.positions[positionOffset],
        sphere.positions[positionOffset + 1],
        sphere.positions[positionOffset + 2],
      );
    });
    const normal = Vector3.Cross(points[1].subtract(points[0]), points[2].subtract(points[0]));
    const normalLength = normal.length();
    if (normalLength <= 1e-12) continue;
    minimumDistance = Math.min(
      minimumDistance,
      Math.abs(Vector3.Dot(normal, points[0])) / normalLength,
    );
  }

  return minimumDistance;
}

test('发布 Viewer 的滚轮距离调节不能把相机带出天空盒球体', () => {
  const fixture = createCamera();
  try {
    fixture.camera.maxZ = 12_000;
    fixture.camera.upperRadiusLimit = 12_000;
    const controller = createPublishedSkyboxCameraBoundsController(
      fixture.scene,
      fixture.camera,
      { center: { x: 0, y: 0, z: 0 }, radiusMeters: 50 },
    );

    fixture.camera.radius = 80;
    fixture.camera.getViewMatrix(true);
    fixture.camera.onAfterCheckInputsObservable.notifyObservers(fixture.camera);

    assertCameraInsideSphere(fixture.camera, Vector3.Zero(), 50);
    assert.ok(fixture.camera.radius < 50, '从球心向外缩放时，半径必须停在天空盒内侧');
    assert.equal(fixture.camera.maxZ, 12_000, '天空盒远侧渲染所需的远裁剪距离不能被缩放边界改小');
    controller.dispose();
    assert.equal(fixture.camera.upperRadiusLimit, 12_000, '释放发布态边界时恢复原有缩放上限');
  } finally {
    fixture.scene.dispose();
    fixture.engine.dispose();
  }
});

test('发布 Viewer 的边界位于实际天空盒三角网格内侧', () => {
  const fixture = createCamera();
  try {
    const radiusMeters = 50;
    const controller = createPublishedSkyboxCameraBoundsController(
      fixture.scene,
      fixture.camera,
      { center: { x: 0, y: 0, z: 0 }, radiusMeters },
    );

    fixture.camera.radius = 80;
    fixture.camera.getViewMatrix(true);
    fixture.camera.onAfterCheckInputsObservable.notifyObservers(fixture.camera);

    const minimumMeshRadius = getMinimumUnitSphereFaceDistance(SKYBOX_SPHERE_SEGMENTS)
      * radiusMeters;
    assert.ok(
      fixture.camera.radius < minimumMeshRadius,
      `相机半径 ${fixture.camera.radius} 必须小于实际网格内接半径 ${minimumMeshRadius}`,
    );
    controller.dispose();
  } finally {
    fixture.scene.dispose();
    fixture.engine.dispose();
  }
});

test('发布 Viewer 按偏心观察目标和当前方向动态缩短滚轮上限', () => {
  const fixture = createCamera();
  try {
    fixture.camera.target.set(20, 0, 0);
    fixture.camera.radius = 10;
    fixture.camera.getViewMatrix(true);
    const controller = createPublishedSkyboxCameraBoundsController(
      fixture.scene,
      fixture.camera,
      { center: { x: 0, y: 0, z: 0 }, radiusMeters: 50 },
    );

    fixture.camera.radius = 40;
    fixture.camera.getViewMatrix(true);
    fixture.camera.onAfterCheckInputsObservable.notifyObservers(fixture.camera);

    assertCameraInsideSphere(fixture.camera, Vector3.Zero(), 50);
    assert.ok(fixture.camera.radius < 30, '偏心 target 朝球面外侧观察时，上限必须小于天空盒半径');
    controller.dispose();
  } finally {
    fixture.scene.dispose();
    fixture.engine.dispose();
  }
});

test('发布 Viewer 平移或巡检后，相机实际位置仍被限制在偏移天空盒内', () => {
  const fixture = createCamera();
  try {
    const center = new Vector3(100, 20, -40);
    fixture.camera.setTarget(center);
    fixture.camera.setPosition(new Vector3(110, 20, -40));
    const controller = createPublishedSkyboxCameraBoundsController(
      fixture.scene,
      fixture.camera,
      { center: { x: center.x, y: center.y, z: center.z }, radiusMeters: 30 },
    );
    let transformMatrixUpdateCount = 0;
    fixture.scene.updateTransformMatrix = () => {
      transformMatrixUpdateCount += 1;
    };

    fixture.camera.target.addInPlaceFromFloats(50, 0, 0);
    fixture.camera.getViewMatrix(true);
    fixture.scene.onBeforeCameraRenderObservable.notifyObservers(fixture.camera);

    assertCameraInsideSphere(fixture.camera, center, 30);
    assert.ok(Math.abs(fixture.camera.radius - 10) < 1e-10, '纯平移撞到球面时不应改变观察距离');
    assert.equal(transformMatrixUpdateCount, 1, '渲染前发生边界校正时必须刷新场景相机矩阵');
    controller.dispose();
  } finally {
    fixture.scene.dispose();
    fixture.engine.dispose();
  }
});

test('发布 Viewer 启动时纠正球外保存视角，且父级隐藏时不安装边界', () => {
  const fixture = createCamera();
  try {
    const document = createEmptySceneDocument();
    const folder = createFolderEntity('隐藏天空盒');
    const skybox = createSkyboxEntity({
      packagePath: 'Assets/Skyboxes/Test',
      sourcePath: 'Assets/Skyboxes/Test/skybox.hdr',
      sourceUrl: 'editor-asset://local/Assets%2FSkyboxes%2FTest%2Fskybox.hdr',
      format: 'hdr',
      rotationDegrees: 0,
      intensity: 1,
      resolution: 512,
    });
    folder.visible = false;
    folder.childrenIds = [skybox.id];
    skybox.parentId = folder.id;
    document.entityIds = [folder.id, skybox.id];
    document.entities = { [folder.id]: folder, [skybox.id]: skybox };
    fixture.camera.radius = 6_000;
    fixture.camera.getViewMatrix(true);

    const hiddenController = createPublishedSkyboxCameraBoundsControllerForDocument(
      fixture.scene,
      fixture.camera,
      document,
    );
    assert.equal(hiddenController, null, '父级隐藏时天空盒不渲染，不应安装发布态边界');
    assert.ok(fixture.camera.radius > 5_000, '未安装边界时不能改写保存视角');

    folder.visible = true;
    const visibleController = createPublishedSkyboxCameraBoundsControllerForDocument(
      fixture.scene,
      fixture.camera,
      document,
    );
    assert.ok(visibleController, '有效可见天空盒必须安装发布态边界');
    assertCameraInsideSphere(fixture.camera, Vector3.Zero(), 5_000);
    visibleController.dispose();
  } finally {
    fixture.scene.dispose();
    fixture.engine.dispose();
  }
});

test('发布态边界只接入 Viewer，并在启动失败和卸载时释放', async () => {
  const [playerSource, sceneViewSource] = await Promise.all([
    readFile(new URL('../../src/player/PlayerApp.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(playerSource, /createPublishedSkyboxCameraBoundsControllerForDocument\(/);
  assert.equal(
    playerSource.match(/skyboxCameraBounds\?\.dispose\(\)/g)?.length,
    2,
    '启动失败和 Viewer 卸载都必须释放相机边界观察者',
  );
  assert.doesNotMatch(
    sceneViewSource,
    /publishedSkyboxCameraBounds|createPublishedSkyboxCameraBoundsController/,
    '编辑器 Scene View 不应安装发布态边界',
  );
});
