import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { MeshBuilder, NullEngine, Scene } from '@babylonjs/core';
import { createServer } from 'vite';
import {
  createAutoPatrolWaypointFromWorldPose,
  createDefaultAutoPatrolComponent,
  createSceneCameraPose,
} from '../../src/editor/model/autoPatrolInspection.ts';

const viteServer = await createServer({
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  ssr: { noExternal: ['@linkiez/dxf-renew'] },
});
const {
  getAutoPatrolRouteGeometryError,
  inspectAutoPatrolRouteSegment,
  isAutoPatrolRouteObstacleMesh,
} = await viteServer.ssrLoadModule(
  '/src/runtime/patrol/AutoPatrolRouteGeometryValidator.ts',
) as typeof import('../../src/runtime/patrol/AutoPatrolRouteGeometryValidator.ts');

after(async () => {
  await viteServer.close();
});

const IDENTITY_TRANSFORM = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

function createScene(): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine();
  return { engine, scene: new Scene(engine) };
}

test('路线几何校验可检测穿过实体墙体的相邻节点', () => {
  const { engine, scene } = createScene();
  const wall = MeshBuilder.CreateBox('wall', { width: 0.2, height: 3, depth: 4 }, scene);
  wall.position.set(2, 1.5, 0);
  wall.computeWorldMatrix(true);

  const result = inspectAutoPatrolRouteSegment(
    scene,
    { x: 0, y: 1.7, z: 0 },
    { x: 4, y: 1.7, z: 0 },
    { groundCheck: 'off' },
  );

  assert.equal(result.reachable, false);
  assert.equal(result.reason, 'blocked');
  assert.equal(result.blockingMeshName, 'wall');
  scene.dispose();
  engine.dispose();
});

test('路线几何校验忽略自动巡检标记与编辑辅助网格', () => {
  const { engine, scene } = createScene();
  const marker = MeshBuilder.CreateBox('route-marker', { width: 0.2, height: 3, depth: 4 }, scene);
  marker.position.set(2, 1.5, 0);
  marker.metadata = { editorAutoPatrolMarker: true };
  marker.computeWorldMatrix(true);

  assert.equal(isAutoPatrolRouteObstacleMesh(marker), false);
  assert.deepEqual(
    inspectAutoPatrolRouteSegment(
      scene,
      { x: 0, y: 1.7, z: 0 },
      { x: 4, y: 1.7, z: 0 },
      { groundCheck: 'off' },
    ),
    { reachable: true, reason: 'clear', blockingMeshName: null },
  );
  scene.dispose();
  engine.dispose();
});

test('自动地面校验在空场景中保持兼容，不误判为不可达', () => {
  const { engine, scene } = createScene();
  const result = inspectAutoPatrolRouteSegment(
    scene,
    { x: 0, y: 1.7, z: 0 },
    { x: 4, y: 1.7, z: 0 },
  );

  assert.equal(result.reachable, true);
  assert.equal(result.reason, 'clear');
  scene.dispose();
  engine.dispose();
});

test('存在可行走地面时，路线几何校验可检测中途不可达缺口', () => {
  const { engine, scene } = createScene();
  const leftFloor = MeshBuilder.CreateBox('left-floor', { width: 3, height: 0.2, depth: 4 }, scene);
  leftFloor.position.set(0.5, -0.1, 0);
  leftFloor.computeWorldMatrix(true);
  const rightFloor = MeshBuilder.CreateBox('right-floor', { width: 3, height: 0.2, depth: 4 }, scene);
  rightFloor.position.set(5.5, -0.1, 0);
  rightFloor.computeWorldMatrix(true);

  const result = inspectAutoPatrolRouteSegment(
    scene,
    { x: 0, y: 1.7, z: 0 },
    { x: 6, y: 1.7, z: 0 },
    { groundCheck: 'required', groundSampleSpacingMeters: 0.5 },
  );

  assert.equal(result.reachable, false);
  assert.equal(result.reason, 'missing-ground');
  scene.dispose();
  engine.dispose();
});

test('连续可行走地面不会被下方射线误判为路线障碍', () => {
  const { engine, scene } = createScene();
  const floor = MeshBuilder.CreateBox('floor', { width: 8, height: 0.2, depth: 4 }, scene);
  floor.position.set(3, -0.1, 0);
  floor.computeWorldMatrix(true);

  const result = inspectAutoPatrolRouteSegment(
    scene,
    { x: 0, y: 1.7, z: 0 },
    { x: 6, y: 1.7, z: 0 },
    { groundCheck: 'required' },
  );

  assert.equal(result.reachable, true);
  assert.equal(result.reason, 'clear');
  scene.dispose();
  engine.dispose();
});

test('整条路线校验将 Babylon 几何结果转换为可展示的节点错误', () => {
  const { engine, scene } = createScene();
  const wall = MeshBuilder.CreateBox('route-wall', { width: 0.2, height: 3, depth: 4 }, scene);
  wall.position.set(2, 1.5, 0);
  wall.computeWorldMatrix(true);
  const component = createDefaultAutoPatrolComponent();
  component.waypoints = [
    createAutoPatrolWaypointFromWorldPose(
      createSceneCameraPose({ x: 0, y: 1.7, z: 0 }, { x: 1, y: 1.7, z: 0 }),
      IDENTITY_TRANSFORM,
      'route-start',
    ),
    createAutoPatrolWaypointFromWorldPose(
      createSceneCameraPose({ x: 4, y: 1.7, z: 0 }, { x: 5, y: 1.7, z: 0 }),
      IDENTITY_TRANSFORM,
      'route-end',
    ),
  ];

  assert.equal(
    getAutoPatrolRouteGeometryError(scene, { component, transform: IDENTITY_TRANSFORM }, { groundCheck: 'off' }),
    '节点 1 到节点 2 的路径被阻挡或不可达。',
  );
  scene.dispose();
  engine.dispose();
});

test('平滑路线按实际 Catmull-Rom 曲线检测偏离节点连线的障碍', () => {
  const { engine, scene } = createScene();
  const wall = MeshBuilder.CreateBox('curve-wall', { width: 0.3, height: 3, depth: 0.3 }, scene);
  wall.position.set(2.25, 1.5, -0.5);
  wall.computeWorldMatrix(true);
  const component = createDefaultAutoPatrolComponent();
  component.pathType = 'smooth';
  component.waypoints = [
    { x: -4, z: 0 },
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 8 },
  ].map((position, index) => createAutoPatrolWaypointFromWorldPose(
    createSceneCameraPose(
      { x: position.x, y: 1.7, z: position.z },
      { x: position.x + 1, y: 1.7, z: position.z },
    ),
    IDENTITY_TRANSFORM,
    `curve-${index}`,
  ));

  assert.equal(
    getAutoPatrolRouteGeometryError(scene, { component, transform: IDENTITY_TRANSFORM }, { groundCheck: 'off' }),
    '节点 2 到节点 3 的路径被阻挡或不可达。',
  );
  scene.dispose();
  engine.dispose();
});

test('平滑闭环路线的首段使用末节点作为 Catmull-Rom 前控制点', () => {
  const { engine, scene } = createScene();
  const wall = MeshBuilder.CreateSphere('loop-first-curve-wall', { diameter: 0.12 }, scene);
  wall.position.set(1.57, 1.7, -0.52);
  wall.computeWorldMatrix(true);
  const component = createDefaultAutoPatrolComponent();
  component.pathType = 'smooth';
  component.playbackMode = 'loop';
  component.waypoints = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 8 },
    { x: -4, z: 8 },
  ].map((position, index) => createAutoPatrolWaypointFromWorldPose(
    createSceneCameraPose(
      { x: position.x, y: 1.7, z: position.z },
      { x: position.x + 1, y: 1.7, z: position.z },
    ),
    IDENTITY_TRANSFORM,
    `loop-first-curve-${index}`,
  ));

  assert.equal(
    getAutoPatrolRouteGeometryError(scene, { component, transform: IDENTITY_TRANSFORM }, {
      clearanceRadiusMeters: 0,
      groundCheck: 'off',
    }),
    '节点 1 到节点 2 的路径被阻挡或不可达。',
  );
  scene.dispose();
  engine.dispose();
});

test('循环路线补充校验末节点返回首节点的闭环段', () => {
  const { engine, scene } = createScene();
  const wall = MeshBuilder.CreateBox('loop-wall', { width: 0.3, height: 3, depth: 0.3 }, scene);
  wall.position.set(2, 1.5, 2);
  wall.computeWorldMatrix(true);
  const component = createDefaultAutoPatrolComponent();
  component.pathType = 'linear';
  component.playbackMode = 'loop';
  component.waypoints = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 4 },
  ].map((position, index) => createAutoPatrolWaypointFromWorldPose(
    createSceneCameraPose(
      { x: position.x, y: 1.7, z: position.z },
      { x: position.x + 1, y: 1.7, z: position.z },
    ),
    IDENTITY_TRANSFORM,
    `loop-${index}`,
  ));

  assert.equal(
    getAutoPatrolRouteGeometryError(scene, { component, transform: IDENTITY_TRANSFORM }, { groundCheck: 'off' }),
    '节点 3 到节点 1 的路径被阻挡或不可达。',
  );
  scene.dispose();
  engine.dispose();
});

test('启动巡检前校验当前相机到首节点的实际进入段', () => {
  const { engine, scene } = createScene();
  const wall = MeshBuilder.CreateBox('start-wall', { width: 0.3, height: 3, depth: 3 }, scene);
  wall.position.set(2, 1.5, 0);
  wall.computeWorldMatrix(true);
  const component = createDefaultAutoPatrolComponent();
  component.pathType = 'linear';
  component.waypoints = [
    createAutoPatrolWaypointFromWorldPose(
      createSceneCameraPose({ x: 4, y: 1.7, z: 0 }, { x: 5, y: 1.7, z: 0 }),
      IDENTITY_TRANSFORM,
      'start-first',
    ),
    createAutoPatrolWaypointFromWorldPose(
      createSceneCameraPose({ x: 8, y: 1.7, z: 0 }, { x: 9, y: 1.7, z: 0 }),
      IDENTITY_TRANSFORM,
      'start-second',
    ),
  ];

  assert.equal(
    getAutoPatrolRouteGeometryError(scene, { component, transform: IDENTITY_TRANSFORM }, {
      groundCheck: 'off',
      initialPose: createSceneCameraPose({ x: 0, y: 1.7, z: 0 }, { x: 1, y: 1.7, z: 0 }),
    }),
    '当前位置到节点 1 的路径被阻挡或不可达。',
  );
  scene.dispose();
  engine.dispose();
});
