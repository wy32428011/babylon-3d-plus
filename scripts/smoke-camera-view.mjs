import assert from 'node:assert/strict';
import { createServer } from 'vite';

const SSR_MODULE_LOAD_TIMEOUT_MS = 180_000;
const SAVED_POSE = {
  alpha: 1.2,
  beta: 0.01,
  radius: 42,
  target: { x: 10, y: 5, z: -3 },
};

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
