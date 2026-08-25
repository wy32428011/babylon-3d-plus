import assert from 'node:assert/strict';
import test from 'node:test';

import { NullEngine, Scene } from '@babylonjs/core';
import { ManualRoamCollisionProxyPool } from '../../src/runtime/roam/ManualRoamCollisionProxyPool.ts';

test('碰撞代理池复用固定数量 Mesh，并按邻域查询启停代理', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const pool = new ManualRoamCollisionProxyPool(scene, () => [
    { id: 'rack-a', minimum: { x: 1, y: 0, z: 1 }, maximum: { x: 3, y: 2, z: 5 } },
    { id: 'rack-b', minimum: { x: -4, y: 0, z: -2 }, maximum: { x: -2, y: 3, z: 0 } },
  ], { maxColliders: 4, refreshIntervalMs: 100, refreshDistanceMeters: 0.5 });

  assert.equal(pool.sync({ x: 0, y: 0, z: 0 }, 12, 0, true), true);
  assert.equal(pool.activeCount, 2);
  assert.equal(pool.has(scene.meshes[0]), true);
  assert.equal(scene.meshes[0].checkCollisions, true);
  assert.equal(scene.meshes[0].isPickable, true);

  pool.setDebugVisible(true);
  assert.ok(scene.meshes.slice(0, 2).every((mesh) => mesh.visibility > 0));

  pool.deactivate();
  assert.equal(pool.activeCount, 0);
  assert.ok(scene.meshes.every((mesh) => !mesh.isEnabled()));

  pool.dispose();
  assert.equal(scene.meshes.length, 0);
  scene.dispose();
  engine.dispose();
});

test('代理池在节流时间和位移阈值内不会重复查询', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  let queryCount = 0;
  const pool = new ManualRoamCollisionProxyPool(scene, () => {
    queryCount += 1;
    return [];
  }, { maxColliders: 1, refreshIntervalMs: 100, refreshDistanceMeters: 1 });

  assert.equal(pool.sync({ x: 0, y: 0, z: 0 }, 12, 0, true), true);
  assert.equal(pool.sync({ x: 0.2, y: 0, z: 0 }, 12, 50), false);
  assert.equal(pool.sync({ x: 2, y: 0, z: 0 }, 12, 50), true);
  assert.equal(pool.sync({ x: 2, y: 0, z: 0 }, 12, 151), true);
  assert.equal(pool.sync({ x: Number.NaN, y: 0, z: 0 }, 12, 200), false);

  assert.equal(queryCount, 3);
  pool.dispose();
  scene.dispose();
  engine.dispose();
});
