import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';

import { createDefaultAgvMapComponent, createDefaultAgvRouteHighlightConfig, type AgvRouteHighlightStyle } from '../../src/editor/model/agvMap.ts';
import { BUILT_IN_AGV_MAPS } from '../../src/editor/model/agvMapLibrary.ts';
import { AgvMapRuntime } from '../../src/runtime/babylon/agv/AgvMapRuntime.ts';
import { AgvTaskRouteHighlight } from '../../src/runtime/babylon/agv/AgvTaskRouteHighlight.ts';

function createFixture(t: test.TestContext) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const parent = new TransformNode('spawnerRoot', scene);
  const runtime = new AgvMapRuntime(scene, 'agv-spawner');
  runtime.root.parent = parent;
  t.after(() => {
    runtime.dispose();
    parent.dispose();
    scene.dispose();
    engine.dispose();
  });
  return { scene, parent, runtime };
}

function positions(mesh: Mesh): number[] {
  return Array.from(mesh.getVerticesData(VertexBuffer.PositionKind) ?? []);
}

test('NullEngine 实际创建业务节点和路线，比例尺调整立即重建轨迹大小', t => {
  const { scene, runtime } = createFixture(t);
  const component = { ...createDefaultAgvMapComponent(), mapId: 'demo-production-line' };
  runtime.sync(component, true);
  assert.equal(runtime.root.isEnabled(), true);
  assert.equal(scene.meshes.filter(mesh => mesh.name.endsWith('_track')).length, BUILT_IN_AGV_MAPS[0].tracks.length);
  assert.equal(scene.meshes.filter(mesh => mesh.name.endsWith('_businessNode')).length, BUILT_IN_AGV_MAPS[0].nodes.length);

  const initial = scene.meshes.find(mesh => mesh.name === 'demo-production-line_T02_track')!;
  assert.deepEqual(positions(initial), [12, 0.035, 0, 12, 0.035, 8]);

  runtime.sync({ ...component, scale: 2 }, true);
  const scaled = scene.meshes.find(mesh => mesh.name === 'demo-production-line_T02_track')!;
  assert.notEqual(scaled, initial);
  assert.equal(initial.isDisposed(), true);
  assert.deepEqual(positions(scaled), [24, 0.035, 0, 24, 0.035, 16]);
});

test('轴映射支持负轴，地图勾选和地图选择动态控制实际几何', t => {
  const { scene, runtime } = createFixture(t);
  const component = { ...createDefaultAgvMapComponent(), mapId: 'demo-production-line' };
  runtime.sync({ ...component, xAxis: '-z', yAxis: 'x', scale: 2 }, true);
  const mapped = scene.meshes.find(mesh => mesh.name === 'demo-production-line_T02_track')!;
  assert.deepEqual(positions(mapped), [0, 0.035, -24, 16, 0.035, -24]);

  runtime.sync({ ...component, showTrajectories: false }, true);
  assert.equal(runtime.root.isEnabled(), false);
  assert.equal(scene.meshes.length, 0);

  runtime.sync({ ...component, mapId: 'demo-loop-dispatch', showTrajectories: true }, true);
  assert.equal(runtime.root.isEnabled(), true);
  assert.equal(scene.meshes.filter(mesh => mesh.name.endsWith('_track')).length, BUILT_IN_AGV_MAPS[1].tracks.length);
});

test('产生器位置就是地图原点，释放地图时不遗留几何', t => {
  const { scene, parent, runtime } = createFixture(t);
  parent.position.set(4, 2, -3);
  runtime.sync({ ...createDefaultAgvMapComponent(), mapId: 'demo-production-line' }, true);
  const originNode = scene.meshes.find(mesh => mesh.name === 'demo-production-line_P01_businessNode')!;
  const world = originNode.getAbsolutePosition();
  assert.equal(world.x, 4);
  assert.ok(Math.abs(world.y - 2.07) < 1e-6);
  assert.equal(world.z, -3);
  assert.ok(scene.meshes.every(mesh => mesh.isPickable === false));

  runtime.sync({ ...createDefaultAgvMapComponent(), mapId: null }, true);
  assert.equal(runtime.root.isEnabled(), false);
  assert.equal(scene.meshes.length, 0);
});

test('任务路径四种样式共用完成进度，更新进度不重建几何且释放完整', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const route = {
    nodeIds: ['P01', 'P02', 'P03'],
    trackIds: ['T01', 'T02'],
    points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 8 }],
    distance: 20,
  };
  const placement = {
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    map: { xAxis: 'x' as const, yAxis: 'z' as const, scale: 1 },
  };

  for (const style of ['flow-path', 'flow-arrows', 'path-reveal', 'pipe-flow'] as AgvRouteHighlightStyle[]) {
    const highlight = new AgvTaskRouteHighlight(`route-${style}`, scene, route, placement, {
      ...createDefaultAgvRouteHighlightConfig(),
      style,
    });
    const meshes = scene.meshes.filter(mesh => mesh.metadata?.agvTaskRouteHighlight);
    assert.equal(meshes.length, style === 'flow-arrows' ? 7 : 1);
    highlight.update(0.5, 1 / 60);
    assert.equal(highlight.getProgress(), 0.5);
    assert.deepEqual(scene.meshes.filter(mesh => mesh.metadata?.agvTaskRouteHighlight), meshes);
    highlight.update(1, 1 / 60);
    assert.equal(highlight.getProgress(), 1);
    highlight.dispose();
    assert.ok(meshes.every(mesh => mesh.isDisposed()));
    assert.equal(scene.meshes.filter(mesh => mesh.metadata?.agvTaskRouteHighlight).length, 0);
  }
});

test('车辆已驶过的方向标识直接隐藏，只保留剩余路线', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const route = {
    nodeIds: ['P01', 'P02'],
    trackIds: ['T01'],
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    distance: 10,
  };
  const placement = {
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    map: { xAxis: 'x' as const, yAxis: 'z' as const, scale: 1 },
  };
  const highlight = new AgvTaskRouteHighlight('remaining', scene, route, placement, {
    ...createDefaultAgvRouteHighlightConfig(), style: 'flow-arrows', amount: 4, speed: 0,
  });
  const arrows = Array.from({ length: 4 }, (_, index) => scene.meshes.find(mesh => mesh.name === `remaining_agvRouteArrow_${index}`)!);
  highlight.update(0.5, 0);
  assert.deepEqual(arrows.map(arrow => arrow.isEnabled()), [false, false, false, true]);
  highlight.update(0.9, 0);
  assert.deepEqual(arrows.map(arrow => arrow.isEnabled()), [false, false, false, false]);
  highlight.update(1, 0);
  assert.deepEqual(arrows.map(arrow => arrow.isEnabled()), [false, false, false, false]);
  highlight.dispose();
});

test('方向标识按场景米制速度移动，不受路线长度和地图比例尺影响', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const createPlacement = (mapScale: number) => ({
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    map: { xAxis: 'x' as const, yAxis: 'z' as const, scale: mapScale },
  });
  const createRoute = (length: number) => ({
    nodeIds: ['P01', 'P02'],
    trackIds: ['T01'],
    points: [{ x: 0, y: 0 }, { x: length, y: 0 }],
    distance: length,
  });
  const highlights = [
    new AgvTaskRouteHighlight('short', scene, createRoute(10), createPlacement(1), {
      ...createDefaultAgvRouteHighlightConfig(), style: 'flow-arrows', amount: 1, speed: 2,
    }),
    new AgvTaskRouteHighlight('long', scene, createRoute(20), createPlacement(1), {
      ...createDefaultAgvRouteHighlightConfig(), style: 'flow-arrows', amount: 1, speed: 2,
    }),
    new AgvTaskRouteHighlight('scaled', scene, createRoute(10), createPlacement(2), {
      ...createDefaultAgvRouteHighlightConfig(), style: 'flow-arrows', amount: 1, speed: 2,
    }),
  ];
  for (const highlight of highlights) highlight.update(0, 1);
  for (const id of ['short', 'long', 'scaled']) {
    const arrow = scene.meshes.find(mesh => mesh.name === `${id}_agvRouteArrow_0`)!;
    assert.ok(Math.abs(arrow.computeWorldMatrix(true).getTranslation().x - 2) < 1e-6, `${id} 应在 1 秒内移动 2 米`);
  }
  for (const highlight of highlights) highlight.update(0, 0.5);
  for (const id of ['short', 'long', 'scaled']) {
    const arrow = scene.meshes.find(mesh => mesh.name === `${id}_agvRouteArrow_0`)!;
    assert.ok(Math.abs(arrow.computeWorldMatrix(true).getTranslation().x - 3) < 1e-6, `${id} 应在 1.5 秒内移动 3 米`);
  }
  for (const highlight of highlights) highlight.dispose();

  const stopped = new AgvTaskRouteHighlight('stopped', scene, createRoute(10), createPlacement(1), {
    ...createDefaultAgvRouteHighlightConfig(), style: 'flow-arrows', amount: 1, speed: 0,
  });
  stopped.update(0, 1);
  const arrow = scene.meshes.find(mesh => mesh.name === 'stopped_agvRouteArrow_0')!;
  assert.equal(arrow.computeWorldMatrix(true).getTranslation().x, 0);
  stopped.dispose();
});
