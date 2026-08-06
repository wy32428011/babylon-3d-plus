import assert from 'node:assert/strict';
import {
  Camera,
  FreeCamera,
  Matrix,
  NullEngine,
  PointLight,
  DirectionalLight,
  Scene,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { createServer } from 'vite';

const MODULE_LOAD_TIMEOUT_MS = 180_000;

async function loadModule(server, modulePath) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule(modulePath),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Vite SSR 灯光编辑模块加载超时：${modulePath}`)),
          MODULE_LOAD_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function createDocument(createEmptySceneDocument, entities, selectedEntityId) {
  const document = createEmptySceneDocument();
  return {
    ...document,
    entityIds: entities.map((entity) => entity.id),
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
    selectedEntityId,
  };
}

function assertVector(actual, expected, message) {
  assert.ok(Math.abs(actual.x - expected.x) <= 1e-6, `${message} x`);
  assert.ok(Math.abs(actual.y - expected.y) <= 1e-6, `${message} y`);
  assert.ok(Math.abs(actual.z - expected.z) <= 1e-6, `${message} z`);
}

let server;
let engine;
let scene;
let runtime;
let controller;
try {
  server = await createServer({
    appType: 'custom',
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });

  const { SceneRuntime } = await loadModule(server, '/src/runtime/babylon/SceneRuntime.ts');
  const { TransformGizmoController } = await loadModule(
    server,
    '/src/runtime/babylon/TransformGizmoController.ts',
  );
  const { createEmptySceneDocument, createLightEntity } = await loadModule(
    server,
    '/src/editor/model/SceneDocument.ts',
  );
  const { useEditorStore } = await loadModule(server, '/src/editor/store/editorStore.ts');

  useEditorStore.getState().newScene();
  useEditorStore.getState().setTransformTool('rotate');
  useEditorStore.getState().createLight('point');
  assert.equal(useEditorStore.getState().transformTool, 'translate', '创建点光源必须自动切回移动工具');
  useEditorStore.getState().setTransformTool('rotate');
  assert.equal(useEditorStore.getState().transformTool, 'translate', '点光源不得切换到旋转工具');
  useEditorStore.getState().updateSelectedLight({ lightKind: 'directional' });
  useEditorStore.getState().setTransformTool('rotate');
  assert.equal(useEditorStore.getState().transformTool, 'rotate', '方向光必须允许旋转工具');
  useEditorStore.getState().setTransformTool('scale');
  assert.equal(useEditorStore.getState().transformTool, 'translate', '方向光不得切换到缩放工具');
  useEditorStore.getState().setTransformTool('rotate');
  useEditorStore.getState().updateSelectedLight({ lightKind: 'hemispheric' });
  assert.equal(useEditorStore.getState().transformTool, 'translate', '切换为半球光时必须移除无效旋转工具');

  engine = new NullEngine({ renderWidth: 1280, renderHeight: 720 });
  scene = new Scene(engine);
  const camera = new FreeCamera('light-editor-camera', new Vector3(0, 4, -12), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;

  const point = createLightEntity('point', { x: 1, y: 2, z: 3 });
  const directional = createLightEntity('directional', { x: -2, y: 5, z: 4 });
  directional.components.transform.rotation = { x: 0.2, y: 0.3, z: -0.1 };
  const hemispheric = createLightEntity('hemispheric');

  runtime = new SceneRuntime(scene);
  let document = createDocument(createEmptySceneDocument, [point, directional, hemispheric], point.id);
  runtime.sync(document);

  const pointTarget = runtime.getGizmoTargetByEntityId(point.id);
  const directionalTarget = runtime.getGizmoTargetByEntityId(directional.id);
  assert.ok(pointTarget instanceof TransformNode, '点光源必须提供编辑器 Gizmo 代理根节点');
  assert.ok(directionalTarget instanceof TransformNode, '方向光必须提供编辑器 Gizmo 代理根节点');
  assert.equal(runtime.getGizmoTargetByEntityId(hemispheric.id), null, '半球光不应提供位置 Gizmo');
  assertVector(pointTarget.position, point.components.transform.position, '点光源标记位置必须同步实体 Transform');
  assertVector(
    directionalTarget.rotation,
    directional.components.transform.rotation,
    '方向光箭头朝向必须同步实体旋转',
  );
  assert.ok(pointTarget.getChildMeshes().length > 0, '点光源代理必须包含可见且可拾取的标记 Mesh');
  assert.ok(directionalTarget.getChildMeshes().length > 0, '方向光代理必须包含可见且可拾取的箭头 Mesh');
  assert.ok(pointTarget.getChildMeshes().every((mesh) => mesh.isPickable), '未锁定灯光标记必须可拾取');

  const pointLight = scene.lights.find((light) => light.name === point.id);
  const directionalLight = scene.lights.find((light) => light.name === directional.id);
  assert.ok(pointLight instanceof PointLight);
  assert.ok(directionalLight instanceof DirectionalLight);

  const nearVisualRoot = pointTarget.getChildren().find((child) => child.name.endsWith('_lightMarkerVisualRoot'));
  assert.ok(nearVisualRoot instanceof TransformNode, '标记必须使用独立视觉缩放根节点，避免污染持久化 Transform');
  scene.render();
  const nearScale = Math.abs(nearVisualRoot.scaling.x * pointTarget.scaling.x);
  const pointScreenPosition = Vector3.Project(
    pointTarget.position,
    Matrix.Identity(),
    scene.getTransformMatrix(),
    camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()),
  );
  const fakeCanvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: engine.getRenderWidth(),
      bottom: engine.getRenderHeight(),
      width: engine.getRenderWidth(),
      height: engine.getRenderHeight(),
    }),
  };
  assert.equal(
    runtime.pickEntityIdAtCanvasPoint(pointScreenPosition.x, pointScreenPosition.y, fakeCanvas),
    point.id,
    'Scene View 点击灯光标记必须还原为灯光实体 ID',
  );
  for (const markerMesh of [...pointTarget.getChildMeshes(), ...directionalTarget.getChildMeshes()]) {
    assert.ok(
      !pointLight.getShadowGenerator()?.getShadowMap()?.renderList?.includes(markerMesh),
      '点光源阴影贴图必须排除编辑器灯光标记',
    );
    assert.ok(
      !directionalLight.getShadowGenerator()?.getShadowMap()?.renderList?.includes(markerMesh),
      '方向光阴影贴图必须排除编辑器灯光标记',
    );
  }
  camera.position.copyFromFloats(0, 40, -120);
  camera.setTarget(Vector3.Zero());
  scene.render();
  const farScale = Math.abs(nearVisualRoot.scaling.x * pointTarget.scaling.x);
  assert.ok(farScale > nearScale * 5, '灯光标记应随观察距离放大以保持近似固定屏幕尺寸');

  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoTop = 10;
  camera.orthoBottom = -10;
  camera.orthoLeft = -20;
  camera.orthoRight = 20;
  scene.render();
  const orthographicNearScale = Math.abs(nearVisualRoot.scaling.x * pointTarget.scaling.x);
  camera.position.copyFromFloats(0, 400, -1200);
  camera.setTarget(Vector3.Zero());
  scene.render();
  const orthographicFarScale = Math.abs(nearVisualRoot.scaling.x * pointTarget.scaling.x);
  assert.ok(
    Math.abs(orthographicNearScale - orthographicFarScale) <= 1e-6,
    '正交投影下灯光标记尺寸不得随相机距离变化',
  );
  camera.mode = Camera.PERSPECTIVE_CAMERA;

  document = {
    ...document,
    entities: {
      ...document.entities,
      [point.id]: { ...point, locked: true },
    },
  };
  runtime.sync(document);
  assert.equal(runtime.getGizmoTargetByEntityId(point.id), null, '锁定灯光不得绑定 Gizmo');
  assert.ok(pointTarget.getChildMeshes().every((mesh) => !mesh.isPickable), '锁定灯光标记仍显示但不可拾取');

  document = {
    ...document,
    entities: {
      ...document.entities,
      [point.id]: { ...point, visible: false },
    },
  };
  runtime.sync(document);
  assert.equal(pointTarget.isEnabled(), false, '隐藏灯光时编辑器标记必须一起隐藏');
  assert.equal(pointLight.isEnabled(), false, '隐藏灯光时实际 Babylon Light 必须一起禁用');

  document = createDocument(createEmptySceneDocument, [point, directional, hemispheric], directional.id);
  runtime.sync(document);
  runtime.beginTelemetryPreview();
  assert.ok(
    [...pointTarget.getChildMeshes(), ...directionalTarget.getChildMeshes()].every((mesh) => !mesh.isVisible),
    '运行预览中不得显示编辑器灯光标记',
  );
  runtime.endTelemetryPreview();
  assert.ok(
    [...pointTarget.getChildMeshes(), ...directionalTarget.getChildMeshes()].every((mesh) => mesh.isVisible),
    '退出运行预览后必须恢复编辑器灯光标记',
  );
  runtime.beginFolderGroupTranslation(
    [point.id],
    { [point.id]: point.components.transform.position },
  );
  runtime.updateFolderGroupTranslation({ x: 4, y: -1, z: 2 });
  scene.render();
  assertVector(pointTarget.position, { x: 5, y: 1, z: 5 }, '文件夹组平移期间灯光标记必须实时移动');
  assertVector(pointLight.position, { x: 5, y: 1, z: 5 }, '文件夹组平移期间实际点光源必须实时移动');
  runtime.cancelFolderGroupTranslation();
  assertVector(pointTarget.position, point.components.transform.position, '取消文件夹组平移必须恢复灯光标记');
  assertVector(pointLight.position, point.components.transform.position, '取消文件夹组平移必须恢复实际点光源');

  const controllerTarget = new TransformNode('point-light-controller-target', scene);
  controller = new TransformGizmoController(scene, {
    previewTransform: () => undefined,
    commitTransform: () => undefined,
    previewEnvironmentTransform: () => undefined,
    commitEnvironmentTransform: () => undefined,
    beginEntityArrayDrag: () => null,
    previewEntityArrayDrag: () => undefined,
    completeEntityArrayDrag: () => undefined,
    cancelEntityArrayDrag: () => undefined,
  });
  controller.attachToTarget(controllerTarget, point.id, {
    supportedTools: ['translate'],
    entityArrayEnabled: false,
  });
  controller.setTool('rotate');
  assert.equal(controller.currentTool, 'translate', '点光源请求旋转工具时控制器必须回退移动工具');
  assert.equal(controller.gizmoManager.positionGizmoEnabled, true);
  assert.equal(controller.gizmoManager.rotationGizmoEnabled, false);
  assert.equal(controller.gizmoManager.scaleGizmoEnabled, false);
  assert.equal(controller.attachedEntityArrayEnabled, false, '点光源 Shift 拖动必须禁用阵列入口');

  controller.attachToTarget(controllerTarget, directional.id, {
    supportedTools: ['translate', 'rotate'],
    entityArrayEnabled: false,
  });
  controller.setTool('rotate');
  assert.equal(controller.currentTool, 'rotate', '方向光必须允许旋转工具');
  assert.equal(controller.gizmoManager.rotationGizmoEnabled, true);
  controller.setTool('scale');
  assert.equal(controller.currentTool, 'translate', '方向光请求缩放工具时必须回退移动工具');

  // 确认方向光旋转仍沿用实体 Transform 的 -Y 基准方向。
  const rotationMatrix = Matrix.RotationYawPitchRoll(
    directional.components.transform.rotation.y,
    directional.components.transform.rotation.x,
    directional.components.transform.rotation.z,
  );
  const expectedDirection = Vector3.TransformNormal(new Vector3(0, -1, 0), rotationMatrix).normalize();
  assertVector(directionalLight.direction, expectedDirection, '方向光实体旋转必须驱动实际照射方向');

  runtime.disableEditorLightMarkers();
  assert.equal(pointTarget.isDisposed(), true, 'Viewer 禁用入口必须释放已经存在的编辑器灯光标记');
  runtime.sync(document);
  assert.equal(runtime.getGizmoTargetByEntityId(point.id), null, 'Viewer 禁用后重新同步也不得重建点光源标记');
  assert.equal(runtime.getGizmoTargetByEntityId(directional.id), null, 'Viewer 禁用后重新同步也不得重建方向光标记');
  assert.ok(
    scene.meshes.every((mesh) => mesh.metadata?.editorLightMarker !== true),
    '发布 Viewer 场景中不得保留编辑器灯光标记 Mesh',
  );

  console.log('Light editor smoke passed.');
} finally {
  controller?.dispose();
  runtime?.dispose();
  scene?.dispose();
  engine?.dispose();
  await server?.close();
}
