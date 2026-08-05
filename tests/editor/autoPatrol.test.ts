import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransformComponent } from '../../src/editor/model/components.ts';
import {
  AUTO_PATROL_MAX_WAYPOINTS,
  AUTO_PATROL_MIN_WAYPOINTS,
  cloneAutoPatrolComponent,
  createAutoPatrolWaypointFromWorldPose,
  createDefaultAutoPatrolComponent,
  duplicateAutoPatrolWaypoint,
  createSceneCameraPose,
  getAutoPatrolWaypointView,
  getAutoPatrolWaypointWorldPose,
  getSceneCameraPosition,
  moveAutoPatrolWaypoint,
  sampleAutoPatrolWorldPath,
  sanitizeAutoPatrolComponent,
  updateAutoPatrolWaypointView,
} from '../../src/editor/model/autoPatrol.ts';

const ROUTE_TRANSFORM: TransformComponent = {
  position: { x: 12, y: 3, z: -8 },
  rotation: { x: 0.12, y: Math.PI / 3, z: -0.08 },
  scale: { x: 1, y: 1, z: 1 },
};

function assertClose(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} != ${expected}`);
}

function assertVectorClose(
  actual: { x: number; y: number; z: number },
  expected: { x: number; y: number; z: number },
  message: string,
): void {
  assertClose(actual.x, expected.x, `${message}.x`);
  assertClose(actual.y, expected.y, `${message}.y`);
  assertClose(actual.z, expected.z, `${message}.z`);
}

test('自动巡检默认配置符合已确认的产品规则', () => {
  const component = createDefaultAutoPatrolComponent();
  assert.equal(component.enabled, true);
  assert.equal(component.autoStart, false);
  assert.equal(component.pathType, 'smooth');
  assert.equal(component.playbackMode, 'loop');
  assert.deepEqual(component.waypoints, []);
  assert.equal(AUTO_PATROL_MIN_WAYPOINTS, 2);
});

test('F1 捕获的世界相机姿态可在路线局部坐标中无损往返', () => {
  const worldPose = createSceneCameraPose(
    { x: 35, y: 18, z: -22 },
    { x: 8, y: 4, z: 11 },
  );
  const waypoint = createAutoPatrolWaypointFromWorldPose(worldPose, ROUTE_TRANSFORM, 'waypoint_capture');
  const restored = getAutoPatrolWaypointWorldPose(waypoint, ROUTE_TRANSFORM);

  assertVectorClose(getSceneCameraPosition(restored), getSceneCameraPosition(worldPose), '相机位置');
  assertVectorClose(restored.target, worldPose.target, '观察目标');
  assertClose(restored.radius, worldPose.radius, '观察距离');
  assert.deepEqual(waypoint.arrivalActions, []);
  assert.equal(waypoint.travelDurationSeconds, 1);
  assert.equal(waypoint.dwellSeconds, 0);
});

test('Inspector 视图参数更新保持相机位置、方向和观察距离可逆', () => {
  const waypoint = createAutoPatrolWaypointFromWorldPose(
    createSceneCameraPose({ x: 20, y: 9, z: -15 }, { x: 0, y: 2, z: 0 }),
    ROUTE_TRANSFORM,
    'waypoint_edit',
  );
  const updated = updateAutoPatrolWaypointView(waypoint, ROUTE_TRANSFORM, {
    position: { x: 42, y: 16, z: -30 },
    headingDegrees: 215,
    pitchDegrees: -18,
    viewDistance: 26,
  });
  const view = getAutoPatrolWaypointView(updated, ROUTE_TRANSFORM);

  assertVectorClose(view.position, { x: 42, y: 16, z: -30 }, 'Inspector 相机位置');
  assertClose(view.headingDegrees, 215, '水平角度');
  assertClose(view.pitchDegrees, -18, '俯仰角度');
  assertClose(view.viewDistance, 26, '观察距离');
});

test('节点排序只改变数组顺序，不修改节点 ID 或相机数据', () => {
  const component = createDefaultAutoPatrolComponent();
  component.waypoints = ['1', '2', '3'].map((id, index) => createAutoPatrolWaypointFromWorldPose(
    createSceneCameraPose({ x: index * 10, y: 5, z: 0 }, { x: index * 10, y: 0, z: 10 }),
    { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    id,
  ));

  const moved = moveAutoPatrolWaypoint(component, '3', 0);
  assert.deepEqual(moved.waypoints.map((item) => item.id), ['3', '1', '2']);
  assert.deepEqual(component.waypoints.map((item) => item.id), ['1', '2', '3']);
});

test('复制节点生成新 ID、保留相机和时间，并插入源节点之后', () => {
  const component = createDefaultAutoPatrolComponent();
  component.waypoints = [createAutoPatrolWaypointFromWorldPose(
    createSceneCameraPose({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }),
    ROUTE_TRANSFORM,
    'copy-waypoint-source',
  )];
  component.waypoints[0].travelDurationSeconds = 3;
  component.waypoints[0].dwellSeconds = 2;

  const duplicated = duplicateAutoPatrolWaypoint(component, 'copy-waypoint-source', 'copy-waypoint-target');
  assert.deepEqual(duplicated.waypoints.map((waypoint) => waypoint.id), [
    'copy-waypoint-source',
    'copy-waypoint-target',
  ]);
  assert.deepEqual(duplicated.waypoints[1].pose, duplicated.waypoints[0].pose);
  assert.notEqual(duplicated.waypoints[1].pose, duplicated.waypoints[0].pose);
  assert.equal(duplicated.waypoints[1].travelDurationSeconds, 3);
  assert.equal(duplicated.waypoints[1].dwellSeconds, 2);
  assert.deepEqual(duplicated.waypoints[1].arrivalActions, []);
  assert.equal(component.waypoints.length, 1);
});

test('达到节点上限后复制节点保持有界', () => {
  const component = createDefaultAutoPatrolComponent();
  component.waypoints = Array.from({ length: AUTO_PATROL_MAX_WAYPOINTS }, (_, index) => (
    createAutoPatrolWaypointFromWorldPose(
      createSceneCameraPose({ x: index, y: 2, z: 3 }, { x: index, y: 2, z: 4 }),
      ROUTE_TRANSFORM,
      `limit-${index}`,
    )
  ));

  const duplicated = duplicateAutoPatrolWaypoint(component, component.waypoints[0].id, 'overflow');
  assert.equal(duplicated.waypoints.length, AUTO_PATROL_MAX_WAYPOINTS);
  assert.equal(duplicated.waypoints.some((waypoint) => waypoint.id === 'overflow'), false);
});

test('复制路线关闭自动启动并深拷贝节点', () => {
  const component = createDefaultAutoPatrolComponent();
  component.autoStart = true;
  component.waypoints = [createAutoPatrolWaypointFromWorldPose(
    createSceneCameraPose({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }),
    ROUTE_TRANSFORM,
    'copy-source',
  )];

  const cloned = cloneAutoPatrolComponent(component, { disableAutoStart: true });
  assert.equal(cloned.autoStart, false);
  assert.notEqual(cloned.waypoints, component.waypoints);
  assert.notEqual(cloned.waypoints[0], component.waypoints[0]);
  assert.deepEqual(cloned.waypoints, component.waypoints);
});

test('序列化边界拒绝重复节点 ID，并归一化时间与空事件列表', () => {
  const invalid = {
    enabled: true,
    autoStart: false,
    pathType: 'smooth',
    playbackMode: 'loop',
    waypoints: [
      {
        id: 'duplicate',
        pose: { alpha: 0, beta: 1, radius: 10, target: { x: 0, y: 0, z: 0 } },
        travelDurationSeconds: 1,
        dwellSeconds: 0,
        arrivalActions: [],
      },
      {
        id: 'duplicate',
        pose: { alpha: 1, beta: 1, radius: 10, target: { x: 1, y: 0, z: 0 } },
        travelDurationSeconds: 1,
        dwellSeconds: 0,
        arrivalActions: [],
      },
    ],
  };
  assert.equal(sanitizeAutoPatrolComponent(invalid), null);

  const valid = structuredClone(invalid);
  valid.waypoints[1].id = 'unique';
  valid.waypoints[0].travelDurationSeconds = -5;
  valid.waypoints[0].dwellSeconds = Number.POSITIVE_INFINITY;
  const normalized = sanitizeAutoPatrolComponent(valid);
  assert.ok(normalized);
  assert.equal(normalized.waypoints[0].travelDurationSeconds, 0);
  assert.equal(normalized.waypoints[0].dwellSeconds, 0);
});

test('路径采样区分直线、平滑和闭环模式', () => {
  const transform: TransformComponent = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
  const component = createDefaultAutoPatrolComponent();
  component.waypoints = [
    createAutoPatrolWaypointFromWorldPose(createSceneCameraPose({ x: 0, y: 5, z: 0 }, { x: 0, y: 5, z: 10 }), transform, 'p1'),
    createAutoPatrolWaypointFromWorldPose(createSceneCameraPose({ x: 10, y: 5, z: 0 }, { x: 10, y: 5, z: 10 }), transform, 'p2'),
    createAutoPatrolWaypointFromWorldPose(createSceneCameraPose({ x: 10, y: 5, z: 10 }, { x: 10, y: 5, z: 20 }), transform, 'p3'),
  ];

  component.pathType = 'linear';
  component.playbackMode = 'once';
  const linear = sampleAutoPatrolWorldPath(component, transform, 4);
  assert.equal(linear.length, 3);
  assertVectorClose(linear[0], { x: 0, y: 5, z: 0 }, '直线路径节点 1');
  assertVectorClose(linear[1], { x: 10, y: 5, z: 0 }, '直线路径节点 2');
  assertVectorClose(linear[2], { x: 10, y: 5, z: 10 }, '直线路径节点 3');

  component.pathType = 'smooth';
  component.playbackMode = 'loop';
  const closed = sampleAutoPatrolWorldPath(component, transform, 4);
  assert.ok(closed.length > component.waypoints.length);
  assertVectorClose(closed[0], closed.at(-1)!, '闭环首尾');
});
