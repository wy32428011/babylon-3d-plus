import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import type { AutoPatrolComponent, TransformComponent } from '../../src/editor/model/components.ts';
import type { SceneCameraPose } from '../../src/editor/model/SceneDocument.ts';
import {
  createAutoPatrolWaypointFromWorldPose,
  createDefaultAutoPatrolComponent,
  createSceneCameraPose,
  getSceneCameraPosition,
  interpolateAutoPatrolPose,
} from '../../src/editor/model/autoPatrol.ts';
import type {
  AutoPatrolPlaybackAdapter,
  AutoPatrolPlaybackRoute,
} from '../../src/runtime/babylon/AutoPatrolPlaybackController.ts';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  ssr: { noExternal: ['@linkiez/dxf-renew'] },
});
const { AutoPatrolPlaybackController, collectAutoPatrolPlaybackRoutes } = await viteServer.ssrLoadModule(
  '/src/runtime/babylon/AutoPatrolPlaybackController.ts',
) as typeof import('../../src/runtime/babylon/AutoPatrolPlaybackController.ts');
const { createAutoPatrolEntity, createEmptySceneDocument } = await viteServer.ssrLoadModule(
  '/src/editor/model/SceneDocument.ts',
) as typeof import('../../src/editor/model/SceneDocument.ts');
after(async () => {
  await viteServer.close();
});

const IDENTITY_TRANSFORM: TransformComponent = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

class FakePlaybackAdapter implements AutoPatrolPlaybackAdapter {
  nowMs = 0;
  pose: SceneCameraPose = createSceneCameraPose({ x: -10, y: 5, z: 0 }, { x: -10, y: 5, z: 10 });
  private frameCallback: (() => void) | null = null;

  readPose = (): SceneCameraPose => structuredClone(this.pose);
  writePose = (pose: SceneCameraPose): void => {
    this.pose = structuredClone(pose);
  };
  now = (): number => this.nowMs;
  subscribeFrame = (callback: () => void): (() => void) => {
    this.frameCallback = callback;
    return () => {
      if (this.frameCallback === callback) this.frameCallback = null;
    };
  };

  advance(milliseconds: number): void {
    this.nowMs += milliseconds;
    this.frameCallback?.();
  }
}

function createRoute(
  playbackMode: AutoPatrolComponent['playbackMode'],
  travelSeconds = [1, 2],
  dwellSeconds = [0, 0],
): AutoPatrolPlaybackRoute {
  const component = createDefaultAutoPatrolComponent();
  component.playbackMode = playbackMode;
  component.waypoints = [
    createAutoPatrolWaypointFromWorldPose(
      createSceneCameraPose({ x: 0, y: 5, z: 0 }, { x: 0, y: 5, z: 10 }),
      IDENTITY_TRANSFORM,
      'node-1',
    ),
    createAutoPatrolWaypointFromWorldPose(
      createSceneCameraPose({ x: 20, y: 8, z: 0 }, { x: 20, y: 8, z: 10 }),
      IDENTITY_TRANSFORM,
      'node-2',
    ),
  ];
  component.waypoints.forEach((waypoint, index) => {
    waypoint.travelDurationSeconds = travelSeconds[index];
    waypoint.dwellSeconds = dwellSeconds[index];
  });
  return {
    entityId: `route-${playbackMode}`,
    name: `路线-${playbackMode}`,
    transform: IDENTITY_TRANSFORM,
    component,
  };
}

function positionX(adapter: FakePlaybackAdapter): number {
  return getSceneCameraPosition(adapter.pose).x;
}

test('从场景文档按 Hierarchy 顺序收集自动巡检路线', () => {
  const scene = createEmptySceneDocument();
  const first = createAutoPatrolEntity({ x: 1, y: 2, z: 3 });
  const second = createAutoPatrolEntity({ x: 4, y: 5, z: 6 });
  first.name = '路线 A';
  second.name = '路线 B';
  scene.entities[first.id] = first;
  scene.entities[second.id] = second;
  scene.entityIds = [second.id, first.id];

  const routes = collectAutoPatrolPlaybackRoutes(scene);
  assert.deepEqual(routes.map((route) => route.entityId), [second.id, first.id]);
  assert.equal(routes[0].name, '路线 B');
  assert.equal(routes[0].component, second.components.autoPatrol);
  assert.equal(routes[0].transform, second.components.transform);
});

test('单次播放从当前视角进入节点 1，并按目标节点时间停在末节点', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once');
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);

  assert.deepEqual(controller.start(route.entityId), { ok: true });
  assert.equal(controller.getSnapshot().phase, 'moving');
  assert.equal(controller.getSnapshot().currentWaypointIndex, 0);

  adapter.advance(500);
  assert.ok(positionX(adapter) > -10 && positionX(adapter) < 0);
  adapter.advance(500);
  assert.ok(Math.abs(positionX(adapter)) < 1e-6);
  assert.equal(controller.getSnapshot().currentWaypointIndex, 1);

  adapter.advance(1000);
  assert.ok(positionX(adapter) > 0 && positionX(adapter) < 20);
  adapter.advance(1000);
  assert.equal(Math.round(positionX(adapter)), 20);
  assert.equal(controller.getSnapshot().phase, 'completed');
  controller.dispose();
});

test('闭环循环在末节点后使用节点 1 的时间移动回起点', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('loop', [3, 1]);
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);

  adapter.advance(3000);
  adapter.advance(1000);
  assert.equal(Math.round(positionX(adapter)), 20);
  assert.equal(controller.getSnapshot().currentWaypointIndex, 0);

  adapter.advance(1500);
  assert.ok(positionX(adapter) > 0 && positionX(adapter) < 20);
  adapter.advance(1500);
  assert.ok(Math.abs(positionX(adapter)) < 1e-6);
  assert.equal(controller.getSnapshot().phase, 'moving');
  controller.dispose();
});

test('平滑闭环末点返回首点时沿正向邻点计算曲线上下文', () => {
  const adapter = new FakePlaybackAdapter();
  const component = createDefaultAutoPatrolComponent();
  component.pathType = 'smooth';
  component.playbackMode = 'loop';
  const poses = [
    createSceneCameraPose({ x: 0, y: 5, z: 0 }, { x: 0, y: 5, z: 10 }),
    createSceneCameraPose({ x: 10, y: 5, z: 0 }, { x: 10, y: 5, z: 10 }),
    createSceneCameraPose({ x: 10, y: 5, z: 10 }, { x: 10, y: 5, z: 20 }),
  ];
  component.waypoints = poses.map((pose, index) => {
    const waypoint = createAutoPatrolWaypointFromWorldPose(pose, IDENTITY_TRANSFORM, `loop-node-${index}`);
    waypoint.travelDurationSeconds = 1;
    return waypoint;
  });
  const route: AutoPatrolPlaybackRoute = {
    entityId: 'route-loop-context',
    name: '闭环上下文',
    transform: IDENTITY_TRANSFORM,
    component,
  };
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);

  adapter.advance(1000);
  adapter.advance(1000);
  adapter.advance(1000);
  assert.equal(controller.getSnapshot().currentWaypointIndex, 0);
  adapter.advance(500);

  const expected = interpolateAutoPatrolPose(
    poses[2],
    poses[0],
    poses[1],
    poses[1],
    0.5,
    'smooth',
    false,
  );
  const actualPosition = getSceneCameraPosition(adapter.pose);
  const expectedPosition = getSceneCameraPosition(expected);
  assert.ok(Math.abs(actualPosition.x - expectedPosition.x) < 1e-6);
  assert.ok(Math.abs(actualPosition.y - expectedPosition.y) < 1e-6);
  assert.ok(Math.abs(actualPosition.z - expectedPosition.z) < 1e-6);
  controller.dispose();
});

test('往返循环反向时使用目标节点时间，并在每次到达执行停留', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('ping-pong', [4, 1], [2, 3]);
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);

  adapter.advance(4000); // 到节点 1，停留 2 秒
  assert.equal(controller.getSnapshot().phase, 'dwelling');
  adapter.advance(2000);
  adapter.advance(1000); // 到节点 2，停留 3 秒
  assert.equal(controller.getSnapshot().phase, 'dwelling');
  assert.equal(controller.getSnapshot().currentWaypointIndex, 1);
  adapter.advance(3000);
  assert.equal(controller.getSnapshot().currentWaypointIndex, 0);
  adapter.advance(2000);
  assert.ok(positionX(adapter) > 0 && positionX(adapter) < 20, '反向 4 秒行程应只完成一半');
  controller.dispose();
});

test('手动接管会暂停；移动相机后继续使用当前目标节点的完整时长', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once', [2, 5]);
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);

  adapter.advance(2000); // 节点 1
  adapter.advance(1000); // 前往节点 2
  controller.notifyManualInput();
  assert.equal(controller.getSnapshot().phase, 'paused');

  adapter.pose = createSceneCameraPose({ x: 100, y: 20, z: 0 }, { x: 100, y: 20, z: 10 });
  controller.notifyCameraChangedWhilePaused();
  assert.deepEqual(controller.resume(), { ok: true });
  adapter.advance(2500);
  assert.ok(positionX(adapter) > 20 && positionX(adapter) < 100);
  adapter.advance(2500);
  assert.equal(Math.round(positionX(adapter)), 20);
  assert.equal(controller.getSnapshot().phase, 'completed');
  controller.dispose();
});

test('停止保留当前视角，并可平滑返回巡检前视角', () => {
  const adapter = new FakePlaybackAdapter();
  const initialPose = structuredClone(adapter.pose);
  const route = createRoute('once');
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);
  adapter.advance(500);
  const stoppedPose = structuredClone(adapter.pose);

  controller.stop();
  assert.deepEqual(adapter.pose, stoppedPose);
  assert.equal(controller.getSnapshot().canReturnToStart, true);
  assert.deepEqual(controller.returnToStart(), { ok: true });
  adapter.advance(250);
  assert.notDeepEqual(adapter.pose, stoppedPose);
  assert.notDeepEqual(adapter.pose, initialPose);
  adapter.advance(250);
  assert.deepEqual(adapter.pose, initialPose);
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.equal(controller.getSnapshot().canReturnToStart, false);
  controller.dispose();
});

test('显式暂停后再手动操作相机会同步发布手动接管状态', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once');
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);
  controller.pause(false);
  assert.equal(controller.getSnapshot().pausedByManualInput, false);

  controller.notifyManualInput();
  assert.equal(controller.getSnapshot().pausedByManualInput, true);
  controller.dispose();
});

test('播放中仅重命名路线不会中断，并同步最新名称', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once');
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);

  controller.setRoutes([{ ...route, name: '重命名后的路线' }]);
  assert.equal(controller.getSnapshot().phase, 'moving');
  assert.equal(controller.getSnapshot().routeName, '重命名后的路线');
  controller.dispose();
});

test('无效路线、禁用路线和运行中被移除的路线都安全停止', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once');
  const controller = new AutoPatrolPlaybackController(adapter);

  controller.setRoutes([{ ...route, component: { ...route.component, enabled: false } }]);
  assert.equal(controller.start(route.entityId).ok, false);

  controller.setRoutes([route]);
  controller.start(route.entityId);
  controller.setRoutes([]);
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.equal(controller.getSnapshot().routeId, null);
  controller.dispose();
});
