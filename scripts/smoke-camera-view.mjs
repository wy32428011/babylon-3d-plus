import assert from 'node:assert/strict';
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core';
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

  const { useEditorStore } = await loadModule(server, '/src/editor/store/editorStore.ts');
  const { createEmptySceneDocument } = await loadModule(server, '/src/editor/model/SceneDocument.ts');
  const { serializeScene } = await loadModule(server, '/src/editor/project/SceneSerializer.ts');
  const { applySavedCameraPose } = await loadModule(server, '/src/runtime/babylon/createEngine.ts');
  verifySavedPoseApplication(applySavedCameraPose);
  editorStore = useEditorStore;
  editorStoreSnapshot = useEditorStore.getState();

  const scene = createEmptySceneDocument('相机视角 Smoke');
  useEditorStore.setState({
    scene,
    runtimeMode: 'edit',
    cameraOrientation: 'top',
    cameraProjection: 'orthographic',
    cameraPoseSaveRequest: null,
    cameraResetRequest: null,
    logs: [],
  });

  useEditorStore.getState().requestCameraPoseSave();
  const saveRequest = useEditorStore.getState().cameraPoseSaveRequest;
  assert.ok(saveRequest, '保存当前视角必须创建一次性请求');

  // 请求发出后切换工具栏模式，保存结果仍应使用点击按钮瞬间的完整模式快照。
  useEditorStore.getState().setCameraOrientation('orbit');
  useEditorStore.getState().setCameraProjection('perspective');
  useEditorStore.getState().consumeCameraPoseSaveRequest(saveRequest.id, SAVED_POSE);

  let state = useEditorStore.getState();
  assert.deepEqual(state.scene.sceneSettings.camera.savedPose, SAVED_POSE);
  assert.equal(state.scene.sceneSettings.camera.savedOrientation, 'top');
  assert.equal(state.scene.sceneSettings.camera.savedProjection, 'orthographic');

  const savedContent = serializeScene(state.scene);
  state.loadSceneFromContent(savedContent, '相机视角 Smoke');
  state = useEditorStore.getState();

  assert.equal(state.cameraOrientation, 'top', '加载场景必须恢复已保存朝向状态');
  assert.equal(state.cameraProjection, 'orthographic', '加载场景必须恢复已保存投影状态');
  assert.ok(state.cameraResetRequest, '加载场景必须发出一次相机恢复请求');

  useEditorStore.getState().setCameraOrientation('orbit');
  useEditorStore.getState().setCameraProjection('perspective');
  useEditorStore.getState().requestCameraReset();
  state = useEditorStore.getState();

  assert.equal(state.cameraOrientation, 'top', '复位视角必须恢复已保存朝向');
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
