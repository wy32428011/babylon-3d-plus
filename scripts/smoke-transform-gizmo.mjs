import assert from 'node:assert/strict';
import { FreeCamera, MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { createServer } from 'vite';

const SSR_MODULE_LOAD_TIMEOUT_MS = 180_000;

async function loadModule(server, modulePath) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule(modulePath),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Vite SSR 变换 Gizmo 模块加载超时：${modulePath}`)),
          SSR_MODULE_LOAD_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function assertRotationAxisState(rotationGizmo, axis, target, enabled) {
  const axisGizmo = rotationGizmo?.[`${axis}Gizmo`];
  assert.ok(axisGizmo, `${axis.toUpperCase()} 轴旋转手柄必须存在`);
  assert.equal(axisGizmo._rootMesh.isEnabled(), enabled, `${axis.toUpperCase()} 轴旋转手柄启用状态必须正确`);
  assert.equal(axisGizmo.dragBehavior.enabled, enabled, `${axis.toUpperCase()} 轴旋转拖拽状态必须正确`);
  if (enabled) assert.equal(axisGizmo.attachedNode, target, `${axis.toUpperCase()} 轴旋转手柄必须绑定当前目标`);
}

let server;
let engine;
let scene;
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
  const { TransformGizmoController } = await loadModule(
    server,
    '/src/runtime/babylon/TransformGizmoController.ts',
  );

  engine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
  scene = new Scene(engine);
  scene.activeCamera = new FreeCamera('transform-gizmo-camera', new Vector3(0, 5, -10), scene);
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

  const transformNode = new TransformNode('transform-node-target', scene);
  controller.attachToTarget(transformNode, 'transform-node-target');
  controller.setTool('rotate');
  const transformNodeRotationGizmo = controller.gizmoManager.gizmos.rotationGizmo;
  assert.equal(transformNodeRotationGizmo?.attachedNode, transformNode);
  for (const axis of ['x', 'y', 'z']) {
    assertRotationAxisState(transformNodeRotationGizmo, axis, transformNode, true);
  }

  controller.attachToTarget(transformNode, 'transform-node-target', { rotationAxes: ['y'] });
  const restrictedRotationGizmo = controller.gizmoManager.gizmos.rotationGizmo;
  assertRotationAxisState(restrictedRotationGizmo, 'x', transformNode, false);
  assertRotationAxisState(restrictedRotationGizmo, 'y', transformNode, true);
  assertRotationAxisState(restrictedRotationGizmo, 'z', transformNode, false);

  const mesh = MeshBuilder.CreateBox('mesh-target', { size: 1 }, scene);
  controller.attachToTarget(mesh, 'mesh-target');
  controller.setTool('rotate');
  const meshRotationGizmo = controller.gizmoManager.gizmos.rotationGizmo;
  assert.equal(meshRotationGizmo?.attachedMesh, mesh);
  for (const axis of ['x', 'y', 'z']) {
    assertRotationAxisState(meshRotationGizmo, axis, mesh, true);
  }

  console.log('Transform Gizmo smoke checks passed.');
} finally {
  controller?.dispose();
  scene?.dispose();
  engine?.dispose();
  await server?.close();
}
