import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';

import { createDefaultAgvMapComponent } from '../../src/editor/model/agvMap.ts';
import { BUILT_IN_AGV_MAPS } from '../../src/editor/model/agvMapLibrary.ts';
import { AgvMapRuntime } from '../../src/runtime/babylon/agv/AgvMapRuntime.ts';

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
