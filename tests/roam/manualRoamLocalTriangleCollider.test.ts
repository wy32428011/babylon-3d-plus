import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { ManualRoamLocalTriangleCollider } from '../../src/runtime/roam/ManualRoamLocalTriangleCollider.ts';

test('高模地面只把人物邻域三角交给碰撞代理，原网格不开启全场景三角碰撞', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const floor = MeshBuilder.CreateGround('factory-floor', {
    width: 80,
    height: 80,
    subdivisions: 64,
  }, scene);
  floor.checkCollisions = false;
  const collider = new ManualRoamLocalTriangleCollider(scene, {
    cellSizeMeters: 4,
    maxColliderMeshes: 8,
    refreshIntervalMs: 0,
    refreshDistanceMeters: 0,
  });

  collider.captureScene(scene.meshes);
  assert.equal(collider.indexedCount, 1);
  assert.equal(collider.sync({ x: 0, y: 0, z: 0 }, 8, 0, true), true);
  assert.ok(collider.activeCount > 0);
  assert.equal(floor.checkCollisions, false);
  assert.ok(collider.getActiveMeshes().every((mesh) => mesh.checkCollisions && mesh.isEnabled()));
  assert.equal(collider.has(collider.getActiveMeshes()[0]), true);

  const nearbyPositions = collider.getActiveMeshes()[0].getVerticesData('position');
  assert.ok(nearbyPositions);
  for (let index = 0; index + 2 < nearbyPositions.length; index += 3) {
    assert.ok(Math.hypot(nearbyPositions[index], nearbyPositions[index + 2]) < 20);
  }

  collider.dispose();
  scene.dispose();
  engine.dispose();
});

test('跨越多格的超大地面三角仍能在远离重心处生成邻域碰撞', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const floor = MeshBuilder.CreateGround('huge-floor', {
    width: 80,
    height: 80,
    subdivisions: 64,
  }, scene);
  const collider = new ManualRoamLocalTriangleCollider(scene, {
    cellSizeMeters: 4,
    refreshIntervalMs: 0,
    refreshDistanceMeters: 0,
  });
  collider.captureScene(scene.meshes);
  collider.sync({ x: 30, y: 0, z: 30 }, 8, 0, true);
  assert.ok(collider.activeCount > 0);
  const positions = collider.getActiveMeshes()[0].getVerticesData('position');
  assert.ok(positions);
  let nearQuery = false;
  for (let index = 0; index + 2 < positions.length; index += 3) {
    if (Math.hypot(positions[index] - 30, positions[index + 2] - 30) < 16) nearQuery = true;
  }
  assert.equal(nearQuery, true);
  assert.equal(floor.checkCollisions, false);

  collider.dispose();
  scene.dispose();
  engine.dispose();
});

test('远离人物的高模格子不会生成碰撞代理，廉价网格不会被索引', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  MeshBuilder.CreateGround('far-floor', {
    width: 80,
    height: 80,
    subdivisions: 64,
  }, scene);
  const box = MeshBuilder.CreateBox('cheap-box', { size: 1 }, scene);
  box.position = new Vector3(0, 0.5, 0);
  const collider = new ManualRoamLocalTriangleCollider(scene, {
    refreshIntervalMs: 0,
    refreshDistanceMeters: 0,
  });

  collider.captureScene(scene.meshes);
  assert.equal(collider.indexedCount, 1);
  collider.sync({ x: 400, y: 0, z: 400 }, 8, 0, true);
  assert.equal(collider.activeCount, 0);

  collider.dispose();
  scene.dispose();
  engine.dispose();
});
