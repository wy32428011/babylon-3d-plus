import assert from 'node:assert/strict';
import test from 'node:test';
import { ArcRotateCamera, Camera, Matrix, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';

function createRoute(waypointCount) {
  return {
    id: 'screen-scale-route', name: '屏幕缩放回归路线', visible: true, locked: false,
    parentId: null, childrenIds: [],
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      },
      autoPatrol: {
        enabled: true, autoStart: false, pathType: 'linear', playbackMode: 'loop',
        waypoints: Array.from({ length: waypointCount }, (_, index) => ({
          id: `point-${index}`, travelDurationSeconds: 1, dwellSeconds: 0, arrivalActions: [],
          pose: { alpha: -Math.PI / 2, beta: Math.PI / 2, radius: 2, target: { x: index % 25, y: 2, z: Math.floor(index / 25) } },
        })),
      },
    },
  };
}

function createFixture(Runtime, waypointCount = 1) {
  const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720 });
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('screen-scale-camera', -Math.PI / 2, 1, 60, Vector3.Zero(), scene);
  scene.activeCamera = camera;
  camera.getViewMatrix();
  const runtime = new Runtime(scene);
  const entity = createRoute(waypointCount);
  runtime.sync(entity, true, true, true);
  const visualRoots = scene.transformNodes.filter(node => /autoPatrol(?:Waypoint)?VisualRoot$/.test(node.name));
  assert.equal(visualRoots.length, waypointCount + 1);
  return {
    engine, scene, camera, runtime, entity, visualRoots,
    frame() {
      // 只运行真实类注册的帧回调，避免把 NullEngine 绘制成本混入矩阵重复计算计数。
      scene.incrementRenderId();
      camera.getViewMatrix();
      camera.getProjectionMatrix();
      scene.onBeforeRenderObservable.notifyObservers(scene);
    },
    dispose() { runtime.dispose(); scene.dispose(); engine.dispose(); },
  };
}

function assertMatrixClose(actual, expected, message) {
  for (let index = 0; index < 16; index++) {
    assert.ok(Math.abs(actual.m[index] - expected.m[index]) < 1e-5, `${message} matrix[${index}]`);
  }
}

function assertPresentation(fixture) {
  const { camera, engine, visualRoots } = fixture;
  for (const visual of visualRoots) {
    const root = visual.parent;
    const position = root.worldMatrixFromCache.getTranslation();
    const pixels = visual.name.includes('Waypoint') ? 38 : 34;
    let span;
    if (camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
      span = Math.abs(camera.orthoTop - camera.orthoBottom);
    } else {
      span = 2 * Vector3.Distance(camera.globalPosition, position) * Math.tan(camera.fov / 2);
      if (camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED) span *= engine.getRenderHeight(true) / engine.getRenderWidth(true);
    }
    const expectedScale = Math.max(0.02, Math.min(1000, span * pixels / engine.getRenderHeight(true)));
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(visual.scaling[axis] - expectedScale) < 1e-9, `${visual.name} scale.${axis}`);
    const rotation = visual.rotationQuaternion ?? Quaternion.FromEulerVector(visual.rotation);
    const expectedMatrix = Matrix.Compose(visual.scaling, rotation, visual.position).multiply(root.worldMatrixFromCache);
    // 使用缓存矩阵断言同帧更新，不能由 getWorldMatrix() 替待测路径补算。
    assertMatrixClose(visual.worldMatrixFromCache, expectedMatrix, visual.name);
  }
}

test('自动巡检编辑标记缩放使用真实运行类并保持动态变换', async context => {
  const server = await createP4SsrTestModules([
    '/src/runtime/babylon/EditorAutoPatrolRuntime.ts',
  ]);
  try {
    const { EditorAutoPatrolRuntime } = await server.ssrLoadModule('/src/runtime/babylon/EditorAutoPatrolRuntime.ts');

    await context.test('500 个节点静止 300 帧不重复写缩放或重算世界矩阵', () => {
      const fixture = createFixture(EditorAutoPatrolRuntime, 500);
      try {
        fixture.frame();
        let updates = 0;
        let scaleWrites = 0;
        for (const visual of fixture.visualRoots) {
          visual.onAfterWorldMatrixUpdateObservable.add(() => updates++);
          const setAll = visual.scaling.setAll.bind(visual.scaling);
          visual.scaling.setAll = value => { scaleWrites++; return setAll(value); };
        }
        for (let frame = 0; frame < 300; frame++) fixture.frame();
        context.diagnostic(`静止标记：501 个，300 帧，缩放写入 ${scaleWrites} 次，世界矩阵更新 ${updates} 次。`);
        assert.equal(scaleWrites, 0);
        assert.equal(updates, 0);
        assertPresentation(fixture);
      } finally { fixture.dispose(); }
    });

    await context.test('相机、分辨率、FOV 和正交范围变化在同帧保持固定像素尺寸', () => {
      const fixture = createFixture(EditorAutoPatrolRuntime);
      try {
        const { camera, engine } = fixture;
        const changes = [
          () => { camera.radius = 85; camera.alpha += 0.2; camera.target.x = 4; },
          () => { camera.fov = 1.1; },
          () => { camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED; },
          // NullEngine 没有画布；改变其尺寸输入，和 resize 后真实引擎的 getter 契约一致。
          () => { engine.getRenderWidth = () => 1920; engine.getRenderHeight = () => 1080; },
          () => { camera.mode = Camera.ORTHOGRAPHIC_CAMERA; camera.orthoTop = 20; camera.orthoBottom = -10; camera.orthoLeft = -30; camera.orthoRight = 30; },
          () => { camera.orthoTop = 40; camera.orthoBottom = -20; },
        ];
        for (const change of changes) { change(); fixture.frame(); assertPresentation(fixture); }
      } finally { fixture.dispose(); }
    });

    await context.test('缩放相同时仍更新父级、节点和辅助节点的外部变换', () => {
      const fixture = createFixture(EditorAutoPatrolRuntime);
      try {
        const { camera, scene, visualRoots } = fixture;
        camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
        camera.orthoTop = 20; camera.orthoBottom = -20;
        camera.orthoLeft = -30; camera.orthoRight = 30;
        fixture.frame();
        const parent = new TransformNode('external-parent', scene);
        for (const visual of visualRoots) visual.parent.parent = parent;
        fixture.frame();
        const before = visualRoots.map(visual => visual.worldMatrixFromCache.clone());
        parent.position.set(7, 3, -4);
        parent.rotation.y = 0.4;
        parent.scaling.set(1.2, 1.5, 0.8);
        fixture.frame();
        assertPresentation(fixture);
        for (let index = 0; index < visualRoots.length; index++) assert.notDeepEqual(Array.from(visualRoots[index].worldMatrixFromCache.m), Array.from(before[index].m));
        const waypoint = visualRoots.find(visual => visual.name.includes('Waypoint'));
        waypoint.parent.position.x += 9;
        waypoint.position.set(0.5, 0.25, 0);
        waypoint.rotationQuaternion = Quaternion.FromEulerAngles(0.2, 0.1, 0.3);
        fixture.frame();
        assertPresentation(fixture);
        // 外部修改本地比例后，下一帧仍恢复原来的固定像素缩放规则。
        waypoint.scaling.set(3, 4, 5);
        fixture.frame();
        assertPresentation(fixture);
      } finally { fixture.dispose(); }
    });

    await context.test('运行预览隐藏编辑标记并在返回编辑时恢复缩放', () => {
      const fixture = createFixture(EditorAutoPatrolRuntime);
      try {
        fixture.frame();
        const previousScales = fixture.visualRoots.map(visual => visual.scaling.clone());
        fixture.runtime.setPreviewActive(true);
        fixture.camera.radius *= 2;
        fixture.frame();
        for (let index = 0; index < fixture.visualRoots.length; index++) {
          assert.equal(fixture.visualRoots[index].isEnabled(), false);
          assert.deepEqual(fixture.visualRoots[index].scaling.asArray(), previousScales[index].asArray());
        }
        fixture.runtime.setPreviewActive(false);
        fixture.frame();
        assertPresentation(fixture);
      } finally { fixture.dispose(); }
    });

    await context.test('同一渲染帧重复同步时立即应用变换，不能等待下一帧', () => {
      const fixture = createFixture(EditorAutoPatrolRuntime);
      try {
        fixture.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
        fixture.camera.orthoTop = 20; fixture.camera.orthoBottom = -20;
        fixture.frame();
        fixture.entity.components.transform.position.x = 11;
        fixture.runtime.sync(fixture.entity, true, true, true);
        assertPresentation(fixture);
        const waypoint = fixture.visualRoots.find(visual => visual.name.includes('Waypoint'));
        waypoint.position.y += 2;
        fixture.runtime.syncPresentation(fixture.entity, true, true, true);
        assertPresentation(fixture);
      } finally { fixture.dispose(); }
    });
  } finally { await server.close(); }
});
