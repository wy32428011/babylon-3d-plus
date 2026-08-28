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
} from '../../src/editor/model/autoPatrolInspection.ts';
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
const {
  AutoPatrolPlaybackController,
  collectAutoPatrolPlaybackRoutes,
  findFirstPlayablePatrolRoute,
} = await viteServer.ssrLoadModule(
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
  routeValidationException: Error | null = null;
  routeValidationCalls = 0;
  pose: SceneCameraPose = createSceneCameraPose({ x: -10, y: 5, z: 0 }, { x: -10, y: 5, z: 10 });
  private frameCallback: (() => void) | null = null;
  events: unknown[] = [];
  screenshots: Array<{ event: unknown; screenshot: unknown }> = [];
  inspectionStarts: unknown[] = [];
  trajectoryBatches: Array<{ taskId: string; samples: unknown[] }> = [];
  records: unknown[] = [];

  readPose = (): SceneCameraPose => structuredClone(this.pose);
  writePose = (pose: SceneCameraPose): void => {
    this.pose = structuredClone(pose);
  };
  now = (): number => this.nowMs;
  wallNow = (): number => this.nowMs;
  captureScreenshot = async (): Promise<string> => 'data:image/png;base64,inspection';
  onInspectionEvent = (event: unknown): void => {
    this.events.push(structuredClone(event));
  };
  onInspectionScreenshot = (event: unknown, screenshot: unknown): void => {
    this.screenshots.push({
      event: structuredClone(event),
      screenshot: structuredClone(screenshot),
    });
  };
  onInspectionStart = (record: unknown): void => {
    this.inspectionStarts.push(structuredClone(record));
  };
  onInspectionTrajectory = (taskId: string, samples: readonly unknown[]): void => {
    this.trajectoryBatches.push({ taskId, samples: structuredClone(samples) });
  };
  onInspectionRecord = (record: unknown): void => {
    this.records.push(structuredClone(record));
  };
  validateRoute = (): string | null => {
    this.routeValidationCalls += 1;
    if (this.routeValidationException) throw this.routeValidationException;
    return null;
  };
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
  component.useRouteSpeed = false;
  component.automaticViewSwitching = false;
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

test('按 Hierarchy 顺序选择第一条可播放巡检路线', () => {
  const disabled = createRoute('once');
  disabled.entityId = 'route-disabled';
  disabled.component.enabled = false;
  const incomplete = createRoute('once');
  incomplete.entityId = 'route-incomplete';
  incomplete.component.waypoints = incomplete.component.waypoints.slice(0, 1);
  const firstPlayable = createRoute('once');
  firstPlayable.entityId = 'route-first-playable';
  const secondPlayable = createRoute('loop');

  assert.equal(
    findFirstPlayablePatrolRoute([disabled, incomplete, firstPlayable, secondPlayable]),
    firstPlayable,
  );
  assert.equal(findFirstPlayablePatrolRoute([disabled, incomplete]), null);
});

test('启动自动巡检不执行场景几何校验，路线可直接穿过模型', () => {
  const adapter = new FakePlaybackAdapter();
  const controller = new AutoPatrolPlaybackController(adapter);
  const route = createRoute('once');
  adapter.routeValidationException = new Error('不应调用场景几何校验');
  controller.setRoutes([route]);

  assert.deepEqual(controller.start(route.entityId), { ok: true });
  assert.equal(adapter.routeValidationCalls, 0);
  assert.equal(controller.getSnapshot().phase, 'moving');
  controller.dispose();
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
  component.useRouteSpeed = false;
  component.automaticViewSwitching = false;
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

test('手动接管后恢复不会把暂停期间的相机位移误判为空间事件', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once', [2, 5]);
  route.component.pathType = 'linear';
  route.component.events = [{
    id: 'distance-after-resume',
    name: '恢复后接近末点',
    enabled: true,
    trigger: { kind: 'distance', waypointId: 'node-2', radiusMeters: 1 },
    responses: ['report'],
    targetEntityId: null,
    cooldownSeconds: 0,
    oncePerPatrol: true,
    businessData: {},
  }];
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);

  adapter.advance(2_000);
  adapter.advance(1_000);
  controller.notifyManualInput();
  adapter.pose = createSceneCameraPose({ x: 100, y: 5, z: 0 }, { x: 100, y: 5, z: 10 });
  controller.notifyCameraChangedWhilePaused();

  assert.deepEqual(controller.resume(), { ok: true });
  assert.equal(adapter.events.length, 0, '恢复首帧不应扫掠用户手动位移路径');
  adapter.advance(5_000);
  assert.equal(
    (adapter.events[0] as { eventId: string } | undefined)?.eventId,
    'distance-after-resume',
    '自动巡检真正接近节点时仍应触发事件',
  );
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

test('路线速度与 0.5x/1x/2x/4x 播放倍率共同驱动唯一虚拟时间轴', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once');
  route.component.useRouteSpeed = true;
  route.component.speedMetersPerSecond = 5;
  route.component.automaticViewSwitching = false;
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);

  adapter.advance(1000);
  assert.ok(positionX(adapter) > -10 && positionX(adapter) < 0, '10m 首段按 5m/s 应在 1 秒时位于中点');
  adapter.advance(1000);
  assert.ok(Math.abs(positionX(adapter)) < 1e-6);
  assert.deepEqual(controller.setPlaybackRate(2), { ok: true });
  assert.equal(controller.getSnapshot().playbackRate, 2);
  adapter.advance(1000);
  assert.ok(positionX(adapter) > 0 && positionX(adapter) < 20, '20m 次段在 2x 下 1 秒应完成一半');
  adapter.advance(1000);
  assert.equal(Math.round(positionX(adapter)), 20);
  assert.equal(controller.getSnapshot().phase, 'completed');

  assert.equal(controller.setPlaybackRate(3).ok, false);
  controller.dispose();
});

test('跳过当前点直接转向下一点，紧急停止保留当前位置并生成异常任务记录', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once', [2, 4]);
  route.component.automaticViewSwitching = false;
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);
  adapter.advance(500);

  assert.deepEqual(controller.skipCurrentWaypoint(), { ok: true });
  assert.equal(controller.getSnapshot().currentWaypointIndex, 1);
  adapter.advance(1000);
  const emergencyPose = structuredClone(adapter.pose);
  controller.emergencyStop();
  assert.deepEqual(adapter.pose, emergencyPose);
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.equal(adapter.records.length, 1);
  assert.equal((adapter.records[0] as { status: string }).status, 'emergency-stopped');
  controller.dispose();
});

test('节点、距离、区域和手动事件按一次性与冷却规则触发，并记录异步截图', async () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once', [1, 2]);
  route.component.automaticViewSwitching = false;
  route.component.triggerRegions = [{
    id: 'region-entry',
    name: '入口电子围栏',
    enabled: true,
    center: { x: 0, y: 5, z: 0 },
    size: { x: 4, y: 4, z: 4 },
    color: '#ff5a5a',
    alert: false,
  }];
  route.component.events = [
    {
      id: 'waypoint-event',
      name: '到达首点',
      enabled: true,
      anomaly: true,
      trigger: { kind: 'waypoint', waypointId: 'node-1' },
      responses: ['panel', 'screenshot', 'report'],
      targetEntityId: 'device-1',
      cooldownSeconds: 5,
      oncePerPatrol: true,
      businessData: { temperature: 80 },
    },
    {
      id: 'distance-event',
      name: '接近末点',
      enabled: true,
      trigger: { kind: 'distance', waypointId: 'node-2', radiusMeters: 11 },
      responses: ['report'],
      targetEntityId: null,
      cooldownSeconds: 5,
      oncePerPatrol: true,
      businessData: {},
    },
    {
      id: 'region-event',
      name: '进入围栏',
      enabled: true,
      trigger: { kind: 'region-enter', regionId: 'region-entry' },
      responses: ['panel'],
      targetEntityId: null,
      cooldownSeconds: 5,
      oncePerPatrol: false,
      businessData: {},
    },
    {
      id: 'manual-event',
      name: '人工复核',
      enabled: true,
      trigger: { kind: 'manual' },
      responses: ['panel', 'pause'],
      targetEntityId: null,
      cooldownSeconds: 0,
      oncePerPatrol: false,
      businessData: {},
    },
  ];
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);
  adapter.advance(1000);
  await Promise.resolve();

  assert.ok(adapter.events.some((event) => (event as { eventId: string }).eventId === 'waypoint-event'));
  assert.equal(
    (adapter.events.find((event) => (event as { eventId: string }).eventId === 'waypoint-event') as { anomaly: boolean }).anomaly,
    true,
  );
  assert.ok(adapter.events.some((event) => (event as { eventId: string }).eventId === 'region-event'));
  assert.deepEqual(controller.triggerManualEvent('manual-event'), { ok: true });
  assert.equal(controller.getSnapshot().phase, 'paused');
  assert.equal(controller.getSnapshot().eventCount, 3);

  controller.resume();
  adapter.advance(1000);
  assert.ok(adapter.events.some((event) => (event as { eventId: string }).eventId === 'distance-event'));
  adapter.advance(1000);
  assert.equal(controller.getSnapshot().phase, 'completed');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(adapter.records.length, 1);
  const record = adapter.records[0] as { events: unknown[]; screenshots: unknown[]; trajectory: unknown[] };
  assert.equal(record.events.length, 4);
  assert.equal(record.screenshots.length, 1);
  assert.equal(adapter.screenshots.length, 1);
  assert.equal(
    (adapter.screenshots[0].screenshot as { dataUrl: string }).dataUrl,
    'data:image/png;base64,inspection',
  );
  assert.ok(record.trajectory.length >= 5, '应至少每 500ms 记录一次轨迹');
  controller.dispose();
});

test('低帧率跨越多个采样周期时按路线进度回填轨迹位姿', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once', [2, 2]);
  route.component.pathType = 'linear';
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);

  // 模拟一个 4 秒长帧，单帧同时跨越两段路线和多个 500ms 采样点。
  adapter.advance(4_000);

  const record = adapter.records[0] as {
    trajectory: Array<{ elapsedMs: number; pose: SceneCameraPose; phase: string; waypointIndex: number | null }>;
  };
  assert.deepEqual(record.trajectory.map((sample) => sample.elapsedMs), [
    0, 500, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000,
  ]);
  assert.deepEqual(record.trajectory.map((sample) => {
    const positionX = Math.round(getSceneCameraPosition(sample.pose).x * 10) / 10;
    return Math.abs(positionX) < 0.05 ? 0 : positionX;
  }), [-10, -8.4, -5, -1.6, 0, 5, 10, 15, 20]);
  assert.deepEqual(record.trajectory.map((sample) => sample.phase), Array(9).fill('moving'));
  assert.deepEqual(record.trajectory.map((sample) => sample.waypointIndex), [0, 0, 0, 0, 0, 1, 1, 1, 1]);
  controller.dispose();
});

test('巡检结束前会增量发布任务开始和每 500ms 轨迹批次', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once', [4, 4]);
  route.component.pathType = 'linear';
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);
  adapter.advance(1_100);

  assert.equal(adapter.inspectionStarts.length, 1);
  assert.equal((adapter.inspectionStarts[0] as { status: string }).status, 'running');
  assert.deepEqual(
    adapter.trajectoryBatches.flatMap((batch) => (
      batch.samples as Array<{ elapsedMs: number }>
    ).map((sample) => sample.elapsedMs)),
    [0, 500, 1_000],
  );
  assert.equal(adapter.records.length, 0, '运行中的轨迹不能依赖任务结束回调才持久化');
  controller.dispose();
});

test('任务开始持久化失败时不会推进巡检并恢复为空闲态', async () => {
  const adapter = new FakePlaybackAdapter();
  adapter.onInspectionStart = async () => {
    throw new Error('巡检历史容量已满');
  };
  const route = createRoute('once', [4, 4]);
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  const initialPositionX = positionX(adapter);

  assert.deepEqual(controller.start(route.entityId), { ok: true });
  adapter.advance(500);
  assert.equal(positionX(adapter), initialPositionX);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.equal(positionX(adapter), initialPositionX);
  assert.equal(adapter.records.length, 0);
  controller.dispose();
});

test('低帧率单帧穿过窄触发区域时仍依次触发进入和离开事件', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once', [1, 2]);
  route.component.pathType = 'linear';
  route.component.triggerRegions = [{
    id: 'narrow-zone',
    name: '窄电子围栏',
    enabled: true,
    center: { x: 10, y: 6.5, z: 0 },
    size: { x: 0.2, y: 10, z: 10 },
    color: '#ff5a5a',
    alert: false,
  }];
  route.component.events = [
    {
      id: 'enter-narrow-zone',
      name: '进入窄区',
      enabled: true,
      trigger: { kind: 'region-enter', regionId: 'narrow-zone' },
      responses: ['report'],
      targetEntityId: null,
      cooldownSeconds: 0,
      oncePerPatrol: false,
      businessData: {},
    },
    {
      id: 'leave-narrow-zone',
      name: '离开窄区',
      enabled: true,
      trigger: { kind: 'region-leave', regionId: 'narrow-zone' },
      responses: ['report'],
      targetEntityId: null,
      cooldownSeconds: 0,
      oncePerPatrol: false,
      businessData: {},
    },
  ];
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);

  adapter.advance(3_000);

  assert.deepEqual(
    adapter.events.map((event) => (event as { eventId: string }).eventId),
    ['enter-narrow-zone', 'leave-narrow-zone'],
  );
  controller.dispose();
});

test('较早事件的异步截图完成后不会覆盖信息面板中的最新事件', async () => {
  const adapter = new FakePlaybackAdapter();
  let resolveScreenshot!: (dataUrl: string) => void;
  adapter.captureScreenshot = () => new Promise((resolve) => { resolveScreenshot = resolve; });
  const route = createRoute('once', [4, 4]);
  route.component.events = [
    {
      id: 'screenshot-event',
      name: '截图事件',
      enabled: true,
      trigger: { kind: 'manual' },
      responses: ['panel', 'screenshot'],
      targetEntityId: null,
      cooldownSeconds: 0,
      oncePerPatrol: false,
      businessData: {},
    },
    {
      id: 'latest-event',
      name: '最新事件',
      enabled: true,
      trigger: { kind: 'manual' },
      responses: ['panel'],
      targetEntityId: null,
      cooldownSeconds: 0,
      oncePerPatrol: false,
      businessData: {},
    },
  ];
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);
  controller.triggerManualEvent('screenshot-event');
  controller.triggerManualEvent('latest-event');

  resolveScreenshot('data:image/png;base64,late');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.getSnapshot().lastEvent?.eventId, 'latest-event');
  controller.dispose();
});

test('截图采集未完成时不会继续创建无界待处理任务', async () => {
  const adapter = new FakePlaybackAdapter();
  let captureCount = 0;
  let resolveScreenshot!: (dataUrl: string) => void;
  adapter.captureScreenshot = () => {
    captureCount += 1;
    return new Promise((resolve) => { resolveScreenshot = resolve; });
  };
  const route = createRoute('once', [4, 4]);
  route.component.events = [{
    id: 'bounded-pending-screenshot',
    name: '截图并发限制',
    enabled: true,
    trigger: { kind: 'manual' },
    responses: ['screenshot'],
    targetEntityId: null,
    cooldownSeconds: 0,
    oncePerPatrol: false,
    businessData: {},
  }];
  const controller = new AutoPatrolPlaybackController(adapter, {
    maxEvents: 10,
    maxScreenshots: 10,
    maxPendingScreenshotCaptures: 1,
    maxScreenshotDataUrlLength: 100,
  });
  controller.setRoutes([route]);
  controller.start(route.entityId);

  controller.triggerManualEvent('bounded-pending-screenshot');
  controller.triggerManualEvent('bounded-pending-screenshot');
  controller.triggerManualEvent('bounded-pending-screenshot');

  assert.equal(captureCount, 1);
  assert.equal(controller.getSnapshot().eventCount, 3, '截图限流不应吞掉事件记录');

  resolveScreenshot('data:image/png;base64,bounded');
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const record = adapter.records[0] as { events: unknown[]; screenshots: unknown[] };
  assert.equal(record.events.length, 3);
  assert.equal(record.screenshots.length, 1);
  controller.dispose();
});

test('截图采集超时后仍会完成任务记录', async () => {
  const adapter = new FakePlaybackAdapter();
  adapter.captureScreenshot = () => new Promise(() => undefined);
  const route = createRoute('once', [4, 4]);
  route.component.events = [{
    id: 'timeout-screenshot',
    name: '截图超时',
    enabled: true,
    trigger: { kind: 'manual' },
    responses: ['screenshot'],
    targetEntityId: null,
    cooldownSeconds: 0,
    oncePerPatrol: false,
    businessData: {},
  }];
  const controller = new AutoPatrolPlaybackController(adapter, {
    screenshotCaptureTimeoutMs: 10,
  });
  controller.setRoutes([route]);
  controller.start(route.entityId);
  controller.triggerManualEvent('timeout-screenshot');
  controller.stop();

  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(adapter.records.length, 1);
  const record = adapter.records[0] as { status: string; screenshots: unknown[] };
  assert.equal(record.status, 'stopped');
  assert.equal(record.screenshots.length, 0);
  controller.dispose();
});

test('超出长度限制的截图 Data URL 不会写入巡检记录', async () => {
  const adapter = new FakePlaybackAdapter();
  adapter.captureScreenshot = async () => 'data:image/png;base64,too-long';
  const route = createRoute('once', [4, 4]);
  route.component.events = [{
    id: 'oversized-screenshot',
    name: '超长截图',
    enabled: true,
    trigger: { kind: 'manual' },
    responses: ['screenshot'],
    targetEntityId: null,
    cooldownSeconds: 0,
    oncePerPatrol: false,
    businessData: {},
  }];
  const controller = new AutoPatrolPlaybackController(adapter, {
    maxEvents: 10,
    maxScreenshots: 10,
    maxPendingScreenshotCaptures: 1,
    maxScreenshotDataUrlLength: 16,
  });
  controller.setRoutes([route]);
  controller.start(route.entityId);
  controller.triggerManualEvent('oversized-screenshot');
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const record = adapter.records[0] as {
    events: Array<{ screenshotDataUrl?: string }>;
    screenshots: unknown[];
  };
  assert.equal(record.events.length, 1);
  assert.equal(record.events[0].screenshotDataUrl, undefined);
  assert.equal(record.screenshots.length, 0);
  assert.equal(adapter.screenshots.length, 0);
  controller.dispose();
});

test('非 PNG 的截图 Data URL 不会写入巡检记录', async () => {
  const adapter = new FakePlaybackAdapter();
  adapter.captureScreenshot = async () => 'data:image/jpeg;base64,unsupported';
  const route = createRoute('once', [4, 4]);
  route.component.events = [{
    id: 'unsupported-screenshot',
    name: '错误截图格式',
    enabled: true,
    trigger: { kind: 'manual' },
    responses: ['screenshot'],
    targetEntityId: null,
    cooldownSeconds: 0,
    oncePerPatrol: false,
    businessData: {},
  }];
  const controller = new AutoPatrolPlaybackController(adapter, {
    maxEvents: 10,
    maxScreenshots: 10,
    maxPendingScreenshotCaptures: 1,
    maxScreenshotDataUrlLength: 100,
  });
  controller.setRoutes([route]);
  controller.start(route.entityId);
  controller.triggerManualEvent('unsupported-screenshot');
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const record = adapter.records[0] as { events: Array<{ screenshotDataUrl?: string }>; screenshots: unknown[] };
  assert.equal(record.events[0].screenshotDataUrl, undefined);
  assert.equal(record.screenshots.length, 0);
  assert.equal(adapter.screenshots.length, 0);
  controller.dispose();
});

test('事件和截图达到任务上限后保持有界', async () => {
  const adapter = new FakePlaybackAdapter();
  let captureCount = 0;
  adapter.captureScreenshot = async () => {
    captureCount += 1;
    return 'data:image/png;base64,bounded';
  };
  const route = createRoute('once', [4, 4]);
  route.component.events = [{
    id: 'bounded-recording',
    name: '记录上限',
    enabled: true,
    trigger: { kind: 'manual' },
    responses: ['screenshot'],
    targetEntityId: null,
    cooldownSeconds: 0,
    oncePerPatrol: false,
    businessData: {},
  }];
  const controller = new AutoPatrolPlaybackController(adapter, {
    maxEvents: 2,
    maxScreenshots: 1,
    maxPendingScreenshotCaptures: 1,
    maxScreenshotDataUrlLength: 100,
  });
  controller.setRoutes([route]);
  controller.start(route.entityId);

  assert.equal(controller.triggerManualEvent('bounded-recording').ok, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.triggerManualEvent('bounded-recording').ok, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.triggerManualEvent('bounded-recording').ok, false);

  assert.equal(captureCount, 1);
  assert.equal(adapter.events.length, 2);
  assert.equal(controller.getSnapshot().eventCount, 2);
  controller.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const record = adapter.records[0] as { events: unknown[]; screenshots: unknown[] };
  assert.equal(record.events.length, 2);
  assert.equal(record.screenshots.length, 1);
  controller.dispose();
});

test('点击目标设备只触发绑定到该设备的手动事件', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once', [2, 2]);
  route.component.events = [
    {
      id: 'manual-device-1',
      name: '设备 1 人工复核',
      enabled: true,
      trigger: { kind: 'manual' },
      responses: ['panel'],
      targetEntityId: 'device-1',
      cooldownSeconds: 0,
      oncePerPatrol: false,
      businessData: {},
    },
    {
      id: 'manual-device-2',
      name: '设备 2 人工复核',
      enabled: true,
      trigger: { kind: 'manual' },
      responses: ['panel'],
      targetEntityId: 'device-2',
      cooldownSeconds: 0,
      oncePerPatrol: false,
      businessData: {},
    },
  ];
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);

  assert.equal(controller.triggerManualEventsForTarget('device-1'), 1);
  assert.equal(controller.triggerManualEventsForTarget('unknown-device'), 0);
  assert.deepEqual(
    adapter.events.map((event) => (event as { eventId: string }).eventId),
    ['manual-device-1'],
  );
  controller.dispose();
});

test('距离事件即使关闭通用一次性开关，单次巡检内仍只触发一次', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('loop', [1, 1]);
  route.component.events = [{
    id: 'distance-once',
    name: '接近首点',
    enabled: true,
    trigger: { kind: 'distance', waypointId: 'node-1', radiusMeters: 1 },
    responses: ['report'],
    targetEntityId: null,
    cooldownSeconds: 0,
    oncePerPatrol: false,
    businessData: {},
  }];
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);

  adapter.advance(1_000);
  adapter.advance(1_000);
  adapter.advance(1_000);
  assert.equal(
    adapter.events.filter((event) => (event as { eventId: string }).eventId === 'distance-once').length,
    1,
  );
  controller.dispose();
});

test('距离事件使用三维距离，不会误触发到水平重合的其他楼层', () => {
  const adapter = new FakePlaybackAdapter();
  adapter.pose = createSceneCameraPose({ x: 0, y: 100, z: 0 }, { x: 0, y: 100, z: 10 });
  const route = createRoute('once', [10, 2]);
  route.component.events = [{
    id: 'distance-three-dimensional',
    name: '三维距离检测',
    enabled: true,
    trigger: { kind: 'distance', waypointId: 'node-1', radiusMeters: 2 },
    responses: ['report'],
    targetEntityId: null,
    cooldownSeconds: 0,
    oncePerPatrol: true,
    businessData: {},
  }];
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);
  adapter.advance(100);

  assert.equal(adapter.events.length, 0);
  controller.dispose();
});

test('手动视角切换在暂停状态下按配置时长平滑过渡', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once', [2, 2]);
  route.component.automaticViewSwitching = false;
  route.component.camera.transitionSeconds = 0.5;
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);
  const initialPosition = getSceneCameraPosition(adapter.pose);

  assert.deepEqual(controller.setManualViewMode('third-person'), { ok: true });
  assert.equal(controller.getSnapshot().phase, 'paused');
  adapter.advance(250);
  const middlePosition = getSceneCameraPosition(adapter.pose);
  assert.notDeepEqual(middlePosition, initialPosition);
  adapter.advance(250);
  const finalPosition = getSceneCameraPosition(adapter.pose);
  assert.notDeepEqual(finalPosition, middlePosition);
  assert.equal(controller.getSnapshot().viewMode, 'third-person');
  assert.equal(controller.getSnapshot().phase, 'paused');
  controller.dispose();
});

test('自动视角按巡航、接近点和警戒区域切换，手动接管后可恢复自动', () => {
  const adapter = new FakePlaybackAdapter();
  const route = createRoute('once', [2, 2]);
  route.component.automaticViewSwitching = true;
  route.component.camera = {
    eyeHeightMeters: 1.7,
    thirdPersonDistanceMeters: 5,
    thirdPersonHeightMeters: 2,
    thirdPersonRotationOffsetDegrees: 0,
    approachDistanceMeters: 2,
    transitionSeconds: 0.5,
  };
  route.component.triggerRegions = [{
    id: 'alert-zone',
    name: '警戒区',
    enabled: true,
    center: { x: 0, y: 5, z: 0 },
    size: { x: 4, y: 4, z: 4 },
    color: '#ff0000',
    alert: true,
  }];
  const controller = new AutoPatrolPlaybackController(adapter);
  controller.setRoutes([route]);
  controller.start(route.entityId);
  assert.equal(controller.getSnapshot().automaticViewMode, 'third-person');

  adapter.advance(2000);
  assert.equal(controller.getSnapshot().automaticViewMode, 'first-person', '警戒区域优先第一人称');
  assert.deepEqual(controller.setManualViewMode('orbit'), { ok: true });
  assert.equal(controller.getSnapshot().phase, 'paused');
  assert.equal(controller.getSnapshot().viewMode, 'orbit');
  assert.equal(controller.getSnapshot().manualCameraOverride, true);
  assert.deepEqual(controller.resumeAutomaticView(), { ok: true });
  assert.equal(controller.getSnapshot().manualCameraOverride, false);
  assert.equal(controller.getSnapshot().phase, 'moving');
  controller.dispose();
});
