import assert from 'node:assert/strict';
import test from 'node:test';

import { Matrix, MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import {
  MANUAL_ROAM_CHEAP_TRIANGLE_VERTEX_LIMIT,
  isManualRoamPointNearWorldAabb,
  resolveManualRoamCollisionStyle,
} from '../../src/runtime/roam/manualRoamCollisionPolicy.ts';

test('廉价小网格保留原生三角碰撞，紧凑高模走 AABB，大范围高模走局部三角', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const box = MeshBuilder.CreateBox('cheap-box', { size: 1 }, scene);
  const compactHighPoly = MeshBuilder.CreateSphere('compact-machine', { diameter: 2, segments: 48 }, scene);
  const walkableHighPoly = MeshBuilder.CreateGround('factory-floor', {
    width: 80,
    height: 80,
    subdivisions: 64,
  }, scene);
  walkableHighPoly.computeWorldMatrix(true);

  assert.ok(box.getTotalVertices() <= MANUAL_ROAM_CHEAP_TRIANGLE_VERTEX_LIMIT);
  assert.equal(resolveManualRoamCollisionStyle(box), 'native-triangle');
  assert.ok(compactHighPoly.getTotalVertices() > MANUAL_ROAM_CHEAP_TRIANGLE_VERTEX_LIMIT);
  assert.equal(resolveManualRoamCollisionStyle(compactHighPoly), 'aabb-proxy');
  assert.ok(walkableHighPoly.getTotalVertices() > MANUAL_ROAM_CHEAP_TRIANGLE_VERTEX_LIMIT);
  assert.equal(resolveManualRoamCollisionStyle(walkableHighPoly), 'local-triangle');

  scene.dispose();
  engine.dispose();
});

test('辅助网格、人物和 thin instance 不进入普通碰撞分类', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const avatar = MeshBuilder.CreateBox('avatar', { size: 1 }, scene);
  avatar.metadata = { manualRoamAvatar: true };
  const lines = MeshBuilder.CreateLines('cad', {
    points: [Vector3.Zero(), new Vector3(2, 0, 0)],
  }, scene);
  const instanced = MeshBuilder.CreateBox('thin', { size: 2 }, scene);
  instanced.thinInstanceSetBuffer('matrix', new Float32Array(Matrix.Identity().m), 16, true);

  assert.equal(resolveManualRoamCollisionStyle(avatar), 'ignore');
  assert.equal(resolveManualRoamCollisionStyle(lines), 'ignore');
  assert.equal(resolveManualRoamCollisionStyle(instanced), 'ignore');
  assert.equal(isManualRoamPointNearWorldAabb({ x: 0, y: 1, z: 0 }, { x: 40, y: 0, z: 40 }, { x: 42, y: 2, z: 42 }, 24), false);
  assert.equal(isManualRoamPointNearWorldAabb({ x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: -1 }, { x: 1, y: 2, z: 1 }, 24), true);

  scene.dispose();
  engine.dispose();
});
