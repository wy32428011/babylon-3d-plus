import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultAgvMapComponent,
  createDefaultAgvRouteHighlightConfig,
  findAgvMapNodeWithinRadius,
  findAgvMapShortestRoute,
  mapAgvPointToScene,
  projectAgvPointToRoute,
  resolveAgvMapNodeId,
  resolveAgvMapTrackPoints,
  sanitizeAgvMapComponent,
  sanitizeAgvMapDefinition,
} from '../../src/editor/model/agvMap.ts';
import { BUILT_IN_AGV_MAPS } from '../../src/editor/model/agvMapLibrary.ts';

test('内置地图符合第一版业务节点与轨迹数据契约', () => {
  assert.ok(BUILT_IN_AGV_MAPS.length >= 2);
  for (const map of BUILT_IN_AGV_MAPS) {
    assert.deepEqual(sanitizeAgvMapDefinition(map), map);
    for (const track of map.tracks) {
      assert.ok(resolveAgvMapTrackPoints(map, track).length >= 2);
    }
  }
});

test('地图定义拒绝重复节点、非法坐标和悬空轨迹引用', () => {
  const valid = BUILT_IN_AGV_MAPS[0];
  assert.equal(sanitizeAgvMapDefinition({ ...valid, nodes: [valid.nodes[0], valid.nodes[0]] }), null);
  assert.equal(sanitizeAgvMapDefinition({ ...valid, nodes: [{ ...valid.nodes[0], x: Number.NaN }] }), null);
  assert.equal(sanitizeAgvMapDefinition({
    ...valid,
    tracks: [{ id: 'broken', fromNodeId: 'P01', toNodeId: 'missing' }],
  }), null);
  assert.equal(sanitizeAgvMapDefinition({
    ...valid,
    tracks: [{ id: 'broken', fromNodeId: 'P01', toNodeId: 'P02', points: [{ x: 0, y: 0 }] }],
  }), null);
});

test('显示配置限制比例尺并阻止两个地图轴映射到同一场景轴', () => {
  assert.deepEqual(createDefaultAgvMapComponent(), {
    mapId: null,
    showTrajectories: true,
    showBaseMap: true,
    nodeRadius: 0.2,
    routeHighlight: createDefaultAgvRouteHighlightConfig(),
    xAxis: 'x',
    yAxis: 'z',
    scale: 1,
  });
  assert.deepEqual(sanitizeAgvMapComponent({
    mapId: ' demo-production-line ',
    showTrajectories: false,
    xAxis: '-y',
    yAxis: 'y',
    scale: 5000,
  }), {
    mapId: 'demo-production-line',
    showTrajectories: false,
    showBaseMap: true,
    nodeRadius: 0.2,
    routeHighlight: createDefaultAgvRouteHighlightConfig(),
    xAxis: 'x',
    yAxis: 'z',
    scale: 1000,
  });
  assert.equal(sanitizeAgvMapComponent(null), null);
  const customized = sanitizeAgvMapComponent({
    ...createDefaultAgvMapComponent(),
    showBaseMap: false,
    nodeRadius: 0,
    routeHighlight: {
      enabled: false,
      style: 'flow-arrows',
      remainingColor: 'invalid',
      width: 20,
      opacity: -1,
      speed: -1,
      amount: 3.6,
    },
  });
  assert.equal(customized?.showBaseMap, false);
  assert.equal(customized?.nodeRadius, 0.01);
  assert.deepEqual(customized?.routeHighlight, {
    enabled: false,
    style: 'flow-arrows',
    remainingColor: '#20d9ff',
    width: 5,
    opacity: 0,
    speed: 0,
    amount: 4,
  });
  const legacy = sanitizeAgvMapComponent({
    ...createDefaultAgvMapComponent(),
    routeHighlight: { ...createDefaultAgvRouteHighlightConfig(), speed: undefined, duration: 30 },
  });
  assert.equal(legacy?.routeHighlight.speed, 1.5);
  assert.equal('duration' in legacy!.routeHighlight, false);
});

test('地图点按正负轴与米制比例尺换算，原点始终不变', () => {
  const component = { xAxis: '-z' as const, yAxis: 'x' as const, scale: 2.5 };
  assert.deepEqual(mapAgvPointToScene({ x: 4, y: -2 }, component), { x: -5, y: 0, z: -10 });
  assert.deepEqual(mapAgvPointToScene({ x: 0, y: 0 }, component), { x: 0, y: 0, z: 0 });
});

test('AGV 当前位置投影到完整任务折线并换算完成进度', () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  assert.deepEqual(projectAgvPointToRoute(points, { x: 12, y: 4 }), {
    point: { x: 10, y: 4 },
    distance: 14,
    progress: 0.7,
  });
  assert.equal(projectAgvPointToRoute(points, { x: -2, y: 0 })?.progress, 0);
  assert.equal(projectAgvPointToRoute(points, { x: 10, y: 12 })?.progress, 1);
  assert.equal(projectAgvPointToRoute([{ x: 0, y: 0 }, { x: 0, y: 0 }], { x: 1, y: 1 }), null);
});

test('节点触达使用半径范围并选择范围内最近节点', () => {
  const map = BUILT_IN_AGV_MAPS[0];
  assert.equal(findAgvMapNodeWithinRadius(map, { x: 11.5, y: 0 }, 0.5), 'P02');
  assert.equal(findAgvMapNodeWithinRadius(map, { x: 11.49, y: 0 }, 0.5), null);
  assert.equal(findAgvMapNodeWithinRadius(map, { x: 0.5, y: 0 }, 1), 'P01');
  assert.equal(findAgvMapNodeWithinRadius(map, { x: 11.5, y: 0 }, Number.NaN), null);
});

test('MQTT 站点名称优先映射到路网节点，并兼容站点 ID 和节点 ID', () => {
  const map = {
    ...BUILT_IN_AGV_MAPS[0],
    stations: [{ id: 'P01', name: 'P02', nodeId: 'P03', x: 12, y: 8 }],
  };
  assert.equal(resolveAgvMapNodeId(map, 'P02'), 'P03');
  assert.equal(resolveAgvMapNodeId(map, 'P01'), 'P03');
  assert.equal(resolveAgvMapNodeId(map, 'P04'), 'P04');
  assert.equal(resolveAgvMapNodeId(map, 'missing'), null);
});

test('任务起终点按轨迹长度求有向最短路径并保留完整折线', () => {
  const map = {
    schemaVersion: 1 as const,
    id: 'route-test',
    name: '路线测试',
    nodes: [
      { id: 'A', name: 'A', x: 0, y: 0 },
      { id: 'B', name: 'B', x: 3, y: 0 },
      { id: 'C', name: 'C', x: 3, y: 4 },
    ],
    tracks: [
      { id: 'AB', fromNodeId: 'A', toNodeId: 'B', bidirectional: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }] },
      { id: 'BC', fromNodeId: 'B', toNodeId: 'C' },
      { id: 'AC', fromNodeId: 'A', toNodeId: 'C', points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 3, y: 4 }] },
    ],
  };
  assert.deepEqual(findAgvMapShortestRoute(map, 'A', 'C'), {
    nodeIds: ['A', 'B', 'C'],
    trackIds: ['AB', 'BC'],
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }],
    distance: 7,
  });
  assert.deepEqual(findAgvMapShortestRoute(map, 'B', 'A')?.points, [
    { x: 3, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 },
  ]);
  assert.equal(findAgvMapShortestRoute(map, 'C', 'A'), null, '未声明双向的轨迹不得反向通行');
  assert.equal(findAgvMapShortestRoute(map, '220', '72'), null, '节点缺失时不得用直线伪造路线');
  assert.deepEqual(findAgvMapShortestRoute(map, 'A', 'A'), {
    nodeIds: ['A'], trackIds: [], points: [{ x: 0, y: 0 }], distance: 0,
  });
});

