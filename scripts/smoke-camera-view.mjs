import assert from 'node:assert/strict';
import { ArcRotateCamera, Axis, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { createServer } from 'vite';

const SSR_MODULE_LOAD_TIMEOUT_MS = 180_000;
const SAVED_POSE = {
  alpha: 1.2,
  beta: 0.01,
  radius: 42,
  target: { x: 10, y: 5, z: -3 },
};

function verifySavedPoseApplication(applySavedCameraPose) {
  assert.equal(typeof applySavedCameraPose, 'function', 'Babylon 相机位姿应用函数必须可用于回归验证');

  const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720 });
  const scene = new Scene(engine);
  try {
    const camera = new ArcRotateCamera(
      'PublishedViewerCameraPoseSmoke',
      Math.PI / 4,
      Math.PI * 0.43,
      28,
      Vector3.Zero(),
      scene,
    );
    scene.activeCamera = camera;
    camera.getViewMatrix(true);

    applySavedCameraPose(camera, SAVED_POSE);

    const restoredPose = {
      alpha: camera.alpha,
      beta: camera.beta,
      radius: camera.radius,
      target: { x: camera.target.x, y: camera.target.y, z: camera.target.z },
    };
    assert.deepEqual(
      restoredPose,
      SAVED_POSE,
      '发布 Viewer 恢复非原点 target 时不得让 ArcRotateCamera.setTarget 覆盖已保存的角度和距离',
    );
  } finally {
    scene.dispose();
    engine.dispose();
  }
}

async function loadModule(server, modulePath) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule(modulePath),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Vite SSR 相机视角模块加载超时：${modulePath}`));
        }, SSR_MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

let server;
let editorStore;
let editorStoreSnapshot;

try {
  server = await createServer({
    appType: 'custom',
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });

  // 避免 Store 异步同步访问未定义的浏览器全局，并满足 Babylon NullEngine 的释放约定。
  globalThis.window = globalThis.window ?? {
    addEventListener() {},
    removeEventListener() {},
  };
  const { useEditorStore } = await loadModule(server, '/src/editor/store/editorStore.ts');
  const { createEmptySceneDocument } = await loadModule(server, '/src/editor/model/SceneDocument.ts');
  const { serializeScene } = await loadModule(server, '/src/editor/project/SceneSerializer.ts');
  const { applySavedCameraPose, focusArcRotateCameraViewOnBounds } = await loadModule(
    server,
    '/src/runtime/babylon/createEngine.ts',
  );
  const { ArcRotateCameraViewController } = await loadModule(server, '/src/runtime/babylon/ArcRotateCameraViewController.ts');
  verifySavedPoseApplication(applySavedCameraPose);

  const controllerEngine = new NullEngine({ renderWidth: 1280, renderHeight: 720 });
  const controllerScene = new Scene(controllerEngine);
  const controllerCamera = new ArcRotateCamera(
    'ViewportCompassControllerSmoke',
    0.7,
    1.1,
    30,
    new Vector3(4, 2, -6),
    controllerScene,
  );
  controllerScene.activeCamera = controllerCamera;
  const originalPose = { alpha: controllerCamera.alpha, beta: controllerCamera.beta };
  const controller = new ArcRotateCameraViewController(controllerCamera, controllerEngine, controllerScene, {
    transitionDurationMs: 0,
  });
  try {
    const standardScreenUps = {
      top: Vector3.Forward(),
      bottom: Vector3.Forward(),
      front: Vector3.Up(),
      back: Vector3.Up(),
      right: Vector3.Up(),
      left: Vector3.Up(),
    };
    for (const [orientation, expectedUp] of Object.entries(standardScreenUps)) {
      controller.setCameraOrientation(orientation, { animate: false });
      const screenUp = controllerCamera.getDirection(Axis.Y).normalize();
      assert.ok(
        Vector3.Dot(screenUp, expectedUp) > 0.999,
        `${orientation} 标准视角必须保持约定的屏幕朝上方向`,
      );
    }
    controller.setCameraOrientation('orbit', { animate: false });

    controller.setCameraOrientation('front', { animate: false });
    assert.equal(controller.getCameraOrientation(), 'front');
    assert.equal(controllerCamera.lowerAlphaLimit, controllerCamera.alpha);
    assert.equal(controllerCamera.upperAlphaLimit, controllerCamera.alpha);
    assert.equal(controllerCamera.lowerBetaLimit, controllerCamera.beta);
    assert.equal(controllerCamera.upperBetaLimit, controllerCamera.beta);

    controllerCamera.target.addInPlace(new Vector3(3, 5, 7));
    controllerCamera.radius = 18;
    const lockedTarget = controllerCamera.target.clone();
    controller.setCameraOrientation('right', { animate: false });
    controller.setCameraOrientation('orbit', { animate: false });
    assert.ok(Math.abs(controllerCamera.alpha - originalPose.alpha) < 1e-9, '退出多面硬锁必须恢复首次进入前的 alpha');
    assert.ok(Math.abs(controllerCamera.beta - originalPose.beta) < 1e-9, '退出多面硬锁必须恢复首次进入前的 beta');
    assert.deepEqual(controllerCamera.target.asArray(), lockedTarget.asArray(), '退出硬锁必须保留锁定期间平移结果');
    assert.equal(controllerCamera.radius, 18, '退出硬锁必须保留锁定期间缩放结果');

    const savedFrontView = {
      savedPose: SAVED_POSE,
      savedOrientation: 'front',
      savedProjection: 'orthographic',
      viewDistance: 5000,
    };
    controller.applyCameraView(savedFrontView, { animate: false, lockStandardOrientation: false });
    assert.equal(controller.getCameraOrientation(), 'orbit', 'Viewer 恢复标准画面后必须保持自由轨道');
    controller.applyCameraView(savedFrontView, { animate: false, lockStandardOrientation: true });
    assert.equal(controller.getCameraOrientation(), 'front', '编辑器恢复标准画面后必须重新建立硬锁');
    assert.equal(controllerCamera.lowerAlphaLimit, controllerCamera.upperAlphaLimit);
    assert.equal(controllerCamera.lowerBetaLimit, controllerCamera.upperBetaLimit);

    const orthographicFocusAngles = {
      alpha: controllerCamera.alpha,
      beta: controllerCamera.beta,
    };
    focusArcRotateCameraViewOnBounds(
      controller,
      controllerCamera,
      controllerEngine,
      {
        center: new Vector3(20, 6, -15),
        radiusMeters: 4,
        sizeMeters: { x: 8, y: 6, z: 5 },
        geometryReady: true,
      },
    );
    assert.equal(controller.getCameraOrientation(), 'front', '正交聚焦不得退出当前标准视角硬锁');
    assert.equal(controllerCamera.alpha, orthographicFocusAngles.alpha, '正交聚焦不得改变当前 alpha');
    assert.equal(controllerCamera.beta, orthographicFocusAngles.beta, '正交聚焦不得改变当前 beta');
    assert.equal(controllerCamera.lowerAlphaLimit, controllerCamera.alpha, '正交聚焦后必须保留 alpha 硬锁');
    assert.equal(controllerCamera.upperAlphaLimit, controllerCamera.alpha, '正交聚焦后必须保留 alpha 硬锁');
    assert.equal(controllerCamera.lowerBetaLimit, controllerCamera.beta, '正交聚焦后必须保留 beta 硬锁');
    assert.equal(controllerCamera.upperBetaLimit, controllerCamera.beta, '正交聚焦后必须保留 beta 硬锁');
    assert.deepEqual(
      controllerCamera.target.asArray(),
      [20, 6, -15],
      '正交聚焦仍应移动观察中心到目标包围盒中心',
    );
  } finally {
    controller.dispose();
    controllerScene.dispose();
    controllerEngine.dispose();
  }
  editorStore = useEditorStore;
  editorStoreSnapshot = useEditorStore.getState();

  const scene = createEmptySceneDocument('相机视角 Smoke');
  useEditorStore.setState({
    scene,
    runtimeMode: 'edit',
    cameraOrientation: 'front',
    cameraProjection: 'orthographic',
    cameraPoseSaveRequest: null,
    cameraResetRequest: null,
    logs: [],
  });

  useEditorStore.getState().toggleCameraStandardView('front');
  let state = useEditorStore.getState();
  assert.equal(state.cameraOrientation, 'orbit', '再次点击当前标准面必须退出硬锁');
  assert.equal(state.cameraProjection, 'orthographic', '退出硬锁必须保留正交投影');
  useEditorStore.getState().toggleCameraStandardView('right');
  state = useEditorStore.getState();
  assert.equal(state.cameraOrientation, 'right', '点击其他面必须进入对应硬锁');
  assert.equal(state.cameraProjection, 'orthographic', '点击标准面必须强制正交投影');
  useEditorStore.getState().setCameraOrientation('front');

  useEditorStore.getState().requestCameraPoseSave();
  const saveRequest = useEditorStore.getState().cameraPoseSaveRequest;
  assert.ok(saveRequest, '保存当前视角必须创建一次性请求');

  // 请求发出后切换工具栏模式，保存结果仍应使用点击按钮瞬间的完整模式快照。
  useEditorStore.getState().setCameraOrientation('orbit');
  useEditorStore.getState().setCameraProjection('perspective');
  useEditorStore.getState().consumeCameraPoseSaveRequest(saveRequest.id, SAVED_POSE);

  state = useEditorStore.getState();
  assert.deepEqual(state.scene.sceneSettings.camera.savedPose, SAVED_POSE);
  assert.equal(state.scene.sceneSettings.camera.savedOrientation, 'front');
  assert.equal(state.scene.sceneSettings.camera.savedProjection, 'orthographic');

  const savedContent = serializeScene(state.scene);
  state.loadSceneFromContent(savedContent, '相机视角 Smoke');
  state = useEditorStore.getState();

  assert.equal(state.cameraOrientation, 'front', '加载场景必须恢复已保存朝向状态');
  assert.equal(state.cameraProjection, 'orthographic', '加载场景必须恢复已保存投影状态');
  assert.ok(state.cameraResetRequest, '加载场景必须发出一次相机恢复请求');

  useEditorStore.getState().setCameraOrientation('orbit');
  useEditorStore.getState().setCameraProjection('perspective');
  useEditorStore.getState().requestCameraReset();
  state = useEditorStore.getState();

  assert.equal(state.cameraOrientation, 'front', '复位视角必须恢复已保存朝向');
  assert.equal(state.cameraProjection, 'orthographic', '复位视角必须恢复已保存投影');
  assert.ok(state.cameraResetRequest, '复位视角必须保留一次性应用请求');

  console.log(JSON.stringify({
    ok: true,
    savedOrientation: state.scene.sceneSettings.camera.savedOrientation,
    savedProjection: state.scene.sceneSettings.camera.savedProjection,
    loadResetRequestId: state.cameraResetRequest.id,
  }, null, 2));
} finally {
  if (editorStore && editorStoreSnapshot) editorStore.setState(editorStoreSnapshot, true);
  await server?.close();
}
