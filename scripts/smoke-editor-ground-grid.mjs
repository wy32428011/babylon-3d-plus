import assert from 'node:assert/strict';
import { ArcRotateCamera, Camera, NullEngine, Scene, ShaderMaterial, Vector3 } from '@babylonjs/core';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

const MODULE_LOAD_TIMEOUT_MS = 30_000;
const CREATE_ENGINE_PATH = 'src/runtime/babylon/createEngine.ts';
const EDITOR_GROUND_GRID_PATH = 'src/runtime/babylon/EditorGroundGrid.ts';

/** 在限定时间内加载地面网格模块，避免 Vite SSR 异常时 smoke 长时间挂起。 */
async function loadEditorGroundGridModule(server) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule('/src/runtime/babylon/EditorGroundGrid.ts'),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('加载 EditorGroundGrid 模块超时。')), MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

let server;
const engine = new NullEngine({ renderWidth: 1920, renderHeight: 1080, deterministicLockstep: true });
const scene = new Scene(engine);
const camera = new ArcRotateCamera('grid-smoke-camera', Math.PI / 4, Math.PI * 0.43, 28, Vector3.Zero(), scene);
scene.activeCamera = camera;

try {
  server = await createServer({
    appType: 'custom',
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });

  const module = await loadEditorGroundGridModule(server);
  const {
    DEFAULT_EDITOR_GRID_SETTINGS,
    calculateEditorGridAnchorCoordinate,
    calculateEditorGridOriginModulo,
    createEditorGroundGrid,
  } = module;

  assert.equal(calculateEditorGridAnchorCoordinate(74, 5), 50, '网格中心应吸附到 10 个基础格的整数倍');
  assert.equal(calculateEditorGridAnchorCoordinate(76, 5), 100, '越过主格中点后应吸附到下一个主格');
  assert.equal(calculateEditorGridAnchorCoordinate(-76, 5), -100, '负坐标必须保持对称吸附');
  assert.equal(calculateEditorGridOriginModulo(-50, 500), 450, '负世界坐标取模必须转换为稳定正余数');
  assert.equal(calculateEditorGridOriginModulo(550, 500), 50, '原点取模不得随粗网格周期无限增长');

  const controller = createEditorGroundGrid(scene, camera, engine, DEFAULT_EDITOR_GRID_SETTINGS);
  camera.getViewMatrix(true);
  scene.render();

  const gridMeshes = scene.meshes.filter((mesh) => mesh.name === 'EditorGroundGrid');
  assert.equal(gridMeshes.length, 1, '编辑器地面网格必须只创建一个 Mesh');
  assert.equal(scene.effectLayers.length, 0, '编辑器地面网格不得创建 GlowLayer 或其它 EffectLayer');

  const gridMesh = gridMeshes[0];
  assert.equal(gridMesh.isPickable, false, '地面网格不得参与拾取');
  assert.equal(gridMesh.alwaysSelectAsActiveMesh, false, '有限网格必须恢复正常视锥裁剪');
  assert.ok(gridMesh.material instanceof ShaderMaterial, '地面网格必须使用单个 ShaderMaterial');
  assert.equal(gridMesh.material.disableDepthWrite, true, '网格必须只做深度测试而不写深度');
  assert.equal(gridMesh.material.isFrozen, true, '静态网格材质编译参数设置后应冻结');
  assert.equal(gridMesh.metadata?.cellSizeLabel, '5 m', '默认网格标签必须保持米制语义');

  const initialSyncCount = gridMesh.metadata?.syncCount;
  scene.render();
  assert.equal(gridMesh.metadata?.syncCount, initialSyncCount, '相机和视口未变化时不得重复同步网格资源');

  camera.setTarget(new Vector3(60, 0, 0), false, false, true);
  camera.getViewMatrix(true);
  scene.render();
  assert.equal(gridMesh.position.x, 50, '相机跨越主格后网格载体应按主格吸附移动');
  assert.ok(gridMesh.metadata?.syncCount > initialSyncCount, '相机跨越吸附边界后必须同步一次网格');

  const movedSyncCount = gridMesh.metadata?.syncCount;
  camera.setTarget(new Vector3(61, 0, 0), false, false, true);
  camera.getViewMatrix(true);
  scene.render();
  assert.equal(gridMesh.position.x, 50, '主格内部的小幅移动不得改变网格载体位置');
  assert.equal(gridMesh.metadata?.syncCount, movedSyncCount, '主格内部移动不得重复改写 Mesh 或 Uniform');

  controller.setSettings({ visible: true, cellSizeMeters: 2 });
  assert.equal(gridMesh.metadata?.cellSizeLabel, '2 m', '切换格子尺寸后必须立即刷新米制标签');
  assert.equal(gridMesh.material.isFrozen, true, '修改网格静态参数后材质必须重新冻结');

  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -40;
  camera.orthoRight = 40;
  camera.orthoTop = 20;
  camera.orthoBottom = -20;
  camera.getProjectionMatrix(true);
  scene.render();
  assert.ok(gridMesh.metadata?.coverageRadiusMeters >= 40, '正交视图网格必须覆盖当前视口半径');

  controller.setSettings({ visible: false, cellSizeMeters: 2 });
  assert.equal(gridMesh.isEnabled(), false, '隐藏网格时必须禁用唯一 Mesh');

  const material = gridMesh.material;
  controller.dispose();
  assert.equal(gridMesh.isDisposed(), true, '释放控制器时必须释放网格 Mesh');
  assert.equal(scene.materials.includes(material), false, '释放控制器时必须从 Scene 移除 ShaderMaterial');

  const [createEngineSource, editorGroundGridSource] = await Promise.all([
    readFile(CREATE_ENGINE_PATH, 'utf8'),
    readFile(EDITOR_GROUND_GRID_PATH, 'utf8'),
  ]);
  assert.match(
    editorGroundGridSource,
    /clipPosition\.z = min\(clipPosition\.z, clipPosition\.w \* GRID_FAR_CLIP_NDC\)/,
    '网格顶点必须在相机最大缩放时压入远裁剪面内，避免正交俯视只显示半幅',
  );
  assert.doesNotMatch(editorGroundGridSource, /\.unfreeze\(/, '相机或格子变化不得反复解冻材质并触发重新就绪检查');
  assert.doesNotMatch(createEngineSource, /GlowLayer|EditorGroundLineGlow|BREATHING_SPEED/, '视口入口不得残留旧 GlowLayer 呼吸网格');
  assert.doesNotMatch(createEngineSource, /performance\.now\(\).*GRID/s, '地面网格不得继续执行每帧呼吸动画');
  assert.match(createEngineSource, /createEditorGroundGrid\(/, 'BabylonViewport 必须接入新的地面网格模块');

  console.log(JSON.stringify({
    ok: true,
    resources: { meshes: 1, shaderMaterials: 1, effectLayers: 0 },
    eventDriven: true,
    cameraAnchored: true,
    orthographicCoverage: true,
    depthWriteDisabled: true,
  }, null, 2));
} finally {
  scene.dispose();
  engine.dispose();
  await server?.close();
}
