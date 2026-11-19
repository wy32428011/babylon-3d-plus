import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultAgvMapComponent,
  mapAgvPointToScene,
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
    xAxis: 'x',
    yAxis: 'z',
    scale: 1000,
  });
  assert.equal(sanitizeAgvMapComponent(null), null);
});

test('地图点按正负轴与米制比例尺换算，原点始终不变', () => {
  const component = { xAxis: '-z' as const, yAxis: 'x' as const, scale: 2.5 };
  assert.deepEqual(mapAgvPointToScene({ x: 4, y: -2 }, component), { x: -5, y: 0, z: -10 });
  assert.deepEqual(mapAgvPointToScene({ x: 0, y: 0 }, component), { x: 0, y: 0, z: 0 });
});

