import assert from 'node:assert/strict';
import test from 'node:test';

import { Matrix, MeshBuilder, NullEngine, Scene } from '@babylonjs/core';

import { EntityArrayThinInstanceBatch } from '../../src/runtime/babylon/EntityArrayThinInstanceBatch';

// Babylon 9 已移除 VertexBuffer.World0Kind 常量，thin instance 矩阵缓冲仍注册为 'world0'..'world3'。
const WORLD0_KIND = 'world0';

test('共享 geometry：thinInstanceSetBuffer 的 world0 顶点缓冲落在 geometry 上，同源 InstancedMesh 静默受污染', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const meshA = MeshBuilder.CreateBox('a', { size: 1 }, scene);
    meshA.createInstance('a_inst');
    const meshB = meshA.clone('b');
    assert.equal(meshB.geometry, meshA.geometry, 'clone 默认共享 geometry');
    assert.ok(!meshA.geometry!.getVertexBuffer(WORLD0_KIND));

    meshB.thinInstanceSetBuffer('matrix', new Float32Array(Matrix.Identity().m), 16);

    assert.ok(meshB.hasThinInstances);
    assert.equal(meshA.hasThinInstances, false, 'mesh 级标记不传染，污染是静默的');
    assert.ok(
      meshA.geometry!.getVertexBuffer(WORLD0_KIND),
      'world0 缓冲落在共享 geometry 上，meshA 及其 instance 的实例渲染都会读到该属性——这是顶点错位的根源',
    );
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('EntityArrayThinInstanceBatch 以 InstancedMesh 为源建批：thin buffer 只落在独立批次几何上，不污染源', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const source = MeshBuilder.CreateBox('src', { size: 1 }, scene);
    const instance = source.createInstance('src_inst');

    const batch = EntityArrayThinInstanceBatch.create('e1', [instance]);
    assert.ok(batch);
    assert.ok(batch.update(2, { x: 1, y: 0, z: 0 }, 1));

    assert.ok(batch.meshes[0].hasThinInstances, '批次 mesh 自身持有 thin instances');
    assert.notEqual(batch.meshes[0].geometry, source.geometry, '批次几何必须独立于源');
    assert.ok(
      !source.geometry!.getVertexBuffer(WORLD0_KIND),
      '源 geometry 不得残留 thin buffer，否则同源 InstancedMesh 全部串扰',
    );
    assert.equal(source.instances.length, 1, '源 mesh 的 instance 关系不得被破坏');
    batch.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
