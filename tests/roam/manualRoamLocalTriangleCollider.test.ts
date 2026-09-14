import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshBuilder, NullEngine, Scene, Vector3, VertexBuffer } from '@babylonjs/core';
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

test('静止场景反复登记不重读环境顶点，也不重建相同邻域代理几何', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const floor = MeshBuilder.CreateGround('static-floor', { width: 80, height: 80, subdivisions: 64 }, scene);
  const collider = new ManualRoamLocalTriangleCollider(scene, { refreshIntervalMs: 0 });
  try {
    collider.captureScene(scene.meshes);
    collider.sync({ x: 0, y: 0, z: 0 }, 8, 0, true);
    const proxies = collider.getActiveMeshes();
    const buffers = proxies.map(mesh => mesh.getVertexBuffer(VertexBuffer.PositionKind));
    let positionReads = 0;
    const getVerticesData = floor.getVerticesData.bind(floor);
    floor.getVerticesData = (...args) => {
      if (args[0] === VertexBuffer.PositionKind) positionReads += 1;
      return getVerticesData(...args);
    };
    for (let index = 1; index <= 10; index += 1) {
      collider.captureScene(scene.meshes);
      collider.sync({ x: 0, y: 0, z: 0 }, 8, index * 180);
    }
    assert.equal(positionReads, 0, '静态环境不应按 180ms 重读整份顶点并重新建索引');
    assert.deepEqual(collider.getActiveMeshes(), proxies);
    assert.deepEqual(proxies.map(mesh => mesh.getVertexBuffer(VertexBuffer.PositionKind)), buffers);
  } finally {
    collider.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test('同顶点数的几何更新必须刷新碰撞高度，不能只比较数量和矩阵', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const floor = MeshBuilder.CreateGround('mutable-floor', {
    width: 80, height: 80, subdivisions: 64, updatable: true,
  }, scene);
  const collider = new ManualRoamLocalTriangleCollider(scene, { refreshIntervalMs: 0 });
  try {
    collider.captureScene(scene.meshes);
    collider.sync({ x: 0, y: 0, z: 0 }, 8, 0, true);
    const positions = floor.getVerticesData(VertexBuffer.PositionKind)!;
    for (let index = 1; index < positions.length; index += 3) positions[index] = 2;
    floor.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    collider.sync({ x: 0, y: 0, z: 0 }, 8, 180);
    assert.ok(collider.activeCount > 0);
    for (const proxy of collider.getActiveMeshes()) {
      const updated = proxy.getVerticesData(VertexBuffer.PositionKind)!;
      for (let index = 1; index < updated.length; index += 3) assert.equal(updated[index], 2);
    }
  } finally {
    collider.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test('索引替换、变换和显隐变化使相同位置的邻域正确失效', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const floor = MeshBuilder.CreateGround('changing-floor', { width: 80, height: 80, subdivisions: 64, updatable: true }, scene);
  const collider = new ManualRoamLocalTriangleCollider(scene, { refreshIntervalMs: 0 });
  try {
    collider.captureScene(scene.meshes);
    collider.sync({ x: 0, y: 0, z: 0 }, 8, 0, true);
    const initialBuilds = collider.getPerformanceMetrics().indexBuildCount;
    const indices = floor.getIndices()!.slice();
    for (let index = 0; index < indices.length; index += 3) [indices[index], indices[index + 1]] = [indices[index + 1], indices[index]];
    floor.updateIndices(indices);
    collider.sync({ x: 0, y: 0, z: 0 }, 8, 180);
    assert.equal(collider.getPerformanceMetrics().indexBuildCount, initialBuilds + 1);
    floor.position.y = 3;
    floor.scaling.x = -1;
    collider.sync({ x: 0, y: 0, z: 0 }, 8, 360);
    const positions = collider.getActiveMeshes()[0].getVerticesData(VertexBuffer.PositionKind)!;
    for (let index = 1; index < positions.length; index += 3) assert.equal(positions[index], 3);
    floor.isVisible = false;
    collider.sync({ x: 0, y: 0, z: 0 }, 8, 540);
    assert.equal(collider.activeCount, 0);
    floor.isVisible = true;
    collider.sync({ x: 0, y: 0, z: 0 }, 8, 720);
    assert.ok(collider.activeCount > 0);
    floor.dispose();
    collider.captureScene(scene.meshes);
    collider.sync({ x: 0, y: 0, z: 0 }, 8, 900);
    assert.equal(collider.activeCount, 0);
    assert.equal(collider.indexedCount, 0);
  } finally {
    collider.dispose(); scene.dispose(); engine.dispose();
  }
});

test('共享几何的变更监听保留外部回调，多个碰撞世界按各自生命周期释放', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const floor = MeshBuilder.CreateGround('shared-floor', { width: 80, height: 80, subdivisions: 64, updatable: true }, scene);
  const geometry = floor.geometry!;
  let externalUpdates = 0;
  const external = () => { externalUpdates += 1; };
  geometry.onGeometryUpdated = external;
  const first = new ManualRoamLocalTriangleCollider(scene, { refreshIntervalMs: 0 });
  const second = new ManualRoamLocalTriangleCollider(scene, { refreshIntervalMs: 0 });
  try {
    first.captureScene(scene.meshes);
    second.captureScene(scene.meshes);
    first.dispose();
    const previous = geometry.onGeometryUpdated;
    // 模拟应用在已登记的回调外继续包装，不能因此丢更新或形成递归。
    geometry.onGeometryUpdated = (updated, kind) => previous(updated, kind);
    second.captureScene(scene.meshes);
    const positions = floor.getVerticesData(VertexBuffer.PositionKind)!;
    for (let index = 1; index < positions.length; index += 3) positions[index] = 1;
    floor.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    second.sync({ x: 0, y: 0, z: 0 }, 8, 0, true);
    assert.equal(externalUpdates, 1);
    assert.equal(second.getActiveMeshes()[0].getVerticesData(VertexBuffer.PositionKind)![1], 1);
    const applicationCallback = () => {};
    geometry.onGeometryUpdated = applicationCallback;
    second.dispose();
    assert.equal(geometry.onGeometryUpdated, applicationCallback);
  } finally {
    second.dispose(); scene.dispose(); engine.dispose();
  }
});

test('人物轻微移动而有序邻域未变时复用三角代理，禁用后仍能重新启用', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  MeshBuilder.CreateGround('nearby-floor', { width: 80, height: 80, subdivisions: 64 }, scene);
  const collider = new ManualRoamLocalTriangleCollider(scene, { refreshIntervalMs: 0 });
  try {
    collider.captureScene(scene.meshes);
    const position = { x: 1.234, y: 0.17, z: 2.789 };
    collider.sync(position, 8, 0, true);
    const before = collider.getActiveMeshes().map(mesh => mesh.getVerticesData(VertexBuffer.PositionKind));
    assert.equal(collider.sync({ ...position, x: position.x + 0.00001 }, 8, 180), false);
    assert.deepEqual(collider.getActiveMeshes().map(mesh => mesh.getVerticesData(VertexBuffer.PositionKind)), before);
    collider.deactivate();
    collider.sync(position, 8, 360);
    assert.ok(collider.activeCount > 0);
    assert.ok(collider.getActiveMeshes().every(mesh => mesh.isEnabled()));
  } finally {
    collider.dispose(); scene.dispose(); engine.dispose();
  }
});

test('切换场景在尚未再次开启漫游时就释放旧环境索引与几何监听', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const floor = MeshBuilder.CreateGround('old-scene-floor', { width: 80, height: 80, subdivisions: 64 }, scene);
  const previous = floor.geometry!.onGeometryUpdated;
  const collider = new ManualRoamLocalTriangleCollider(scene);
  try {
    collider.captureScene(scene.meshes);
    collider.sync({ x: 0, y: 0, z: 0 }, 8, 0, true);
    assert.notEqual(floor.geometry!.onGeometryUpdated, previous);
    collider.clearScene();
    assert.equal(collider.indexedCount, 0);
    assert.equal(collider.activeCount, 0);
    assert.equal(floor.geometry!.onGeometryUpdated, previous);
    collider.captureScene(scene.meshes);
    assert.equal(collider.indexedCount, 1);
  } finally {
    collider.dispose(); scene.dispose(); engine.dispose();
  }
});

test('缓存不得吞掉原 Float32 碰撞矩阵可表达的微小变换', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const floor = MeshBuilder.CreateGround('precise-floor', { width: 80, height: 80, subdivisions: 64 }, scene);
  const collider = new ManualRoamLocalTriangleCollider(scene, { refreshIntervalMs: 0 });
  try {
    collider.captureScene(scene.meshes);
    collider.sync({ x: 0, y: 0, z: 0 }, 8, 0, true);
    floor.position.y = 0.000005;
    collider.captureScene(scene.meshes);
    collider.sync({ x: 0, y: 0, z: 0 }, 8, 180);
    assert.equal(collider.getActiveMeshes()[0].getVerticesData(VertexBuffer.PositionKind)![1], Math.fround(floor.position.y));
  } finally {
    collider.dispose(); scene.dispose(); engine.dispose();
  }
});
