import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransformComponent } from '../../src/editor/model/components.ts';
import {
  AUTO_PATROL_DEFAULT_CAMERA_CONFIG,
  AUTO_PATROL_DEFAULT_SPEED_METERS_PER_SECOND,
  AUTO_PATROL_BUSINESS_DATA_MAX_STRING_LENGTH,
  AUTO_PATROL_EYE_HEIGHT_METERS,
  AUTO_PATROL_MAX_WAYPOINTS,
  AUTO_PATROL_MIN_WAYPOINTS,
  AUTO_PATROL_ROUTE_JSON_MAX_CHARACTERS,
  cloneAutoPatrolComponent,
  createAutoPatrolWaypointFromWorldPose,
  createDefaultAutoPatrolComponent,
  createDefaultAutoPatrolEvent,
  duplicateAutoPatrolWaypoint,
  createSceneCameraPose,
  getAutoPatrolWaypointView,
  getAutoPatrolWaypointWorldPose,
  getSceneCameraPosition,
  importAutoPatrolRouteJson,
  isWorldPointInsideAutoPatrolRegion,
  moveAutoPatrolWaypoint,
  sampleAutoPatrolWorldPath,
  serializeAutoPatrolRouteJson,
  sanitizeAutoPatrolComponent,
  updateAutoPatrolWaypointView,
  validateAutoPatrolRoute,
} from '../../src/editor/model/autoPatrolInspection.ts';

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
  assert.equal(component.isDefault, false);
  assert.deepEqual(component.tags, []);
  assert.equal(component.pathType, 'smooth');
  assert.equal(component.playbackMode, 'loop');
  assert.equal(component.useRouteSpeed, true);
  assert.equal(component.speedMetersPerSecond, AUTO_PATROL_DEFAULT_SPEED_METERS_PER_SECOND);
  assert.equal(component.automaticViewSwitching, true);
  assert.deepEqual(component.camera, AUTO_PATROL_DEFAULT_CAMERA_CONFIG);
  assert.deepEqual(component.triggerRegions, []);
  assert.deepEqual(component.events, []);
  assert.deepEqual(component.waypoints, []);
  assert.equal(AUTO_PATROL_MIN_WAYPOINTS, 2);
});

test('F1 可按路线原点固定 1.7m 人眼高度并保持观察方向', () => {
  const worldPose = createSceneCameraPose({ x: 4, y: 12, z: 8 }, { x: 4, y: 12, z: 18 });
  const waypoint = createAutoPatrolWaypointFromWorldPose(worldPose, ROUTE_TRANSFORM, 'eye-height', {
    eyeHeightMeters: AUTO_PATROL_EYE_HEIGHT_METERS,
  });
  const view = getAutoPatrolWaypointView(waypoint, ROUTE_TRANSFORM);

  assertClose(view.position.y, ROUTE_TRANSFORM.position.y + AUTO_PATROL_EYE_HEIGHT_METERS, '人眼高度');
  assertClose(view.headingDegrees, 0, '水平朝向');
  assertClose(view.pitchDegrees, 0, '俯仰朝向');
});

test('触发区域使用路线局部有向包围盒判断进入和离开', () => {
  const region = {
    id: 'alert-zone',
    name: '警戒区',
    enabled: true,
    center: { x: 2, y: 1, z: -3 },
    size: { x: 4, y: 2, z: 6 },
    color: '#ff5a5a',
    alert: true,
  };
  const insideWaypoint = createAutoPatrolWaypointFromWorldPose(
    createSceneCameraPose({ x: 2, y: 1, z: -3 }, { x: 2, y: 1, z: -2 }),
    { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  );
  const insideLocal = getSceneCameraPosition(insideWaypoint.pose);
  const transform = {
    position: { x: 10, y: 5, z: -8 },
    rotation: { x: 0, y: Math.PI / 2, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
  const insideWorldPose = getAutoPatrolWaypointWorldPose({ pose: createSceneCameraPose(insideLocal, { x: 2, y: 1, z: -2 }) }, transform);
  const insideWorld = getSceneCameraPosition(insideWorldPose);

  assert.equal(isWorldPointInsideAutoPatrolRegion(insideWorld, region, transform), true);
  assert.equal(isWorldPointInsideAutoPatrolRegion({ x: 50, y: 50, z: 50 }, region, transform), false);
});

test('球形触发区域按半径判断进入和离开', () => {
  const transform: TransformComponent = {
    position: { x: 10, y: 0, z: -5 },
    rotation: { x: 0, y: Math.PI / 2, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
  const region = {
    id: 'sphere-zone',
    name: '球形警戒区',
    enabled: true,
    shape: 'sphere' as const,
    center: { x: 0, y: 1, z: 0 },
    size: { x: 4, y: 4, z: 4 },
    radiusMeters: 2,
    color: '#ff5a5a',
    alert: true,
  };

  assert.equal(isWorldPointInsideAutoPatrolRegion({ x: 10, y: 2.9, z: -5 }, region, transform), true);
  assert.equal(isWorldPointInsideAutoPatrolRegion({ x: 10, y: 3.1, z: -5 }, region, transform), false);
});

test('事件、区域、标签与速度经过清洗和深拷贝后保持独立', () => {
  const component = createDefaultAutoPatrolComponent();
  component.tags = ['仓库', '夜班'];
  component.speedMetersPerSecond = 9;
  component.triggerRegions = [{
    id: 'region-1',
    name: '设备警戒区',
    enabled: true,
    center: { x: 1, y: 2, z: 3 },
    size: { x: 4, y: 5, z: 6 },
    color: '#ff0000',
    alert: true,
  }];
  component.events = [{
    id: 'event-1',
    name: '进入警戒区',
    enabled: true,
    anomaly: true,
    trigger: { kind: 'region-enter', regionId: 'region-1' },
    responses: ['panel', 'highlight', 'screenshot', 'pause', 'report'],
    targetEntityId: 'device-1',
    cooldownSeconds: 5,
    oncePerPatrol: false,
    businessData: { temperature: 90, alarm: true },
  }];

  const normalized = sanitizeAutoPatrolComponent(component);
  assert.ok(normalized);
  assert.equal(normalized.speedMetersPerSecond, 5);
  assert.deepEqual(normalized.tags, ['仓库', '夜班']);
  assert.deepEqual(normalized.events, component.events);
  const cloned = cloneAutoPatrolComponent(normalized);
  assert.notEqual(cloned.triggerRegions, normalized.triggerRegions);
  assert.notEqual(cloned.triggerRegions[0].center, normalized.triggerRegions[0].center);
  assert.notEqual(cloned.events, normalized.events);
  assert.equal(cloned.events[0].anomaly, true);
  assert.notEqual(cloned.events[0].businessData, normalized.events[0].businessData);
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

test('路线校验报告少于两个节点和相邻节点距离小于 0.5m', () => {
  const transform: TransformComponent = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
  const component = createDefaultAutoPatrolComponent();
  component.waypoints = [
    createAutoPatrolWaypointFromWorldPose(createSceneCameraPose({ x: 0, y: 1.7, z: 0 }, { x: 0, y: 1.7, z: 1 }), transform, 'near-a'),
    createAutoPatrolWaypointFromWorldPose(createSceneCameraPose({ x: 0.3, y: 1.7, z: 0 }, { x: 0.3, y: 1.7, z: 1 }), transform, 'near-b'),
  ];

  const issues = validateAutoPatrolRoute(component, transform);
  assert.deepEqual(issues.map((issue) => issue.code), ['waypoints-too-close']);
  assert.equal(issues[0].waypointIndex, 1);

  component.waypoints.pop();
  assert.deepEqual(validateAutoPatrolRoute(component, transform).map((issue) => issue.code), ['too-few-waypoints']);
});

test('路线 JSON 导入导出保留完整配置并拒绝无效数据', () => {
  const component = createDefaultAutoPatrolComponent();
  component.tags = ['生产区', '默认'];
  component.isDefault = true;
  component.triggerRegions = [{
    id: 'sphere-import',
    name: '球形区域',
    enabled: true,
    shape: 'sphere',
    center: { x: 1, y: 2, z: 3 },
    size: { x: 6, y: 6, z: 6 },
    radiusMeters: 3,
    color: '#00ff00',
    alert: false,
  }];

  const json = serializeAutoPatrolRouteJson(component, '一号路线');
  const imported = importAutoPatrolRouteJson(json);
  assert.equal(imported.name, '一号路线');
  assert.deepEqual(imported.component, component);
  assert.throws(() => importAutoPatrolRouteJson('{"version":1,"component":{"enabled":true}}'), /无效/);
});

test('路线 JSON 导入在解析前拒绝超过 1 MB 的文本', () => {
  assert.throws(
    () => importAutoPatrolRouteJson(' '.repeat(AUTO_PATROL_ROUTE_JSON_MAX_CHARACTERS + 1)),
    /不能超过 1 MB/,
  );
});

test('巡检事件业务数据字符串最多支持 4096 个字符', () => {
  const component = createDefaultAutoPatrolComponent();
  const definition = createDefaultAutoPatrolEvent(component);
  definition.businessData = {
    detail: 'x'.repeat(AUTO_PATROL_BUSINESS_DATA_MAX_STRING_LENGTH),
  };
  component.events = [definition];

  assert.ok(sanitizeAutoPatrolComponent(component));

  definition.businessData.detail = 'x'.repeat(AUTO_PATROL_BUSINESS_DATA_MAX_STRING_LENGTH + 1);
  assert.equal(sanitizeAutoPatrolComponent(component), null);
});
