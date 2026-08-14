import assert from 'node:assert/strict';
import test from 'node:test';

import { Matrix, MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import { computeRootRelativeWorldMatrix, getMeshWorldBounds } from '../../src/runtime/babylon/runtimeNodeGeometry';

test('getMeshWorldBounds 排除 thin instances 扩展，只返回 mesh 自身几何包围盒', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const mesh = MeshBuilder.CreateBox('box', { size: 2 }, scene);
    mesh.position.x = 10;
    // 远处挂一个实例：thinInstanceSetBuffer 会把 boundingInfo 重建为全部实例的并集（视锥剔除需要）。
    mesh.thinInstanceSetBuffer('matrix', new Float32Array(Matrix.Translation(1000, 0, 0).m), 16);
    assert.ok(mesh.thinInstanceCount > 0);

    const bounds = getMeshWorldBounds(mesh);
    assert.ok(bounds);
    assert.ok(
      Math.abs(bounds.minimum.x - 9) < 1e-6 && Math.abs(bounds.maximum.x - 11) < 1e-6,
      `包围盒必须只含 mesh 自身（[9, 11]），实际 [${bounds.minimum.x}, ${bounds.maximum.x}]`,
    );
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('getMeshWorldBounds 对无 thin instances 的 mesh 保持原 boundingInfo 语义', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const mesh = MeshBuilder.CreateBox('box', { size: 2 }, scene);
    mesh.position.x = 10;
    const bounds = getMeshWorldBounds(mesh);
    assert.ok(bounds);
    assert.ok(Math.abs(bounds.minimum.x - 9) < 1e-6 && Math.abs(bounds.maximum.x - 11) < 1e-6);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('computeRootRelativeWorldMatrix 在双方均旋转时把源本地点映射到目标对应本地点', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const host = new TransformNode('host', scene);
    host.position = new Vector3(-0.01, 0, -7.24);
    host.rotation = new Vector3(0, -Math.PI / 2, 0);
    const proxy = new TransformNode('proxy', scene);
    proxy.position = new Vector3(-0.01, 0, -5.4);
    proxy.rotation = new Vector3(0, -Math.PI / 2, 0);

    const relative = computeRootRelativeWorldMatrix(host, proxy);
    assert.ok(relative);

    const localPoint = new Vector3(0, 0, 1);
    const hostWorldPoint = Vector3.TransformCoordinates(localPoint, host.getWorldMatrix());
    const mapped = Vector3.TransformCoordinates(hostWorldPoint, relative);
    const expected = Vector3.TransformCoordinates(localPoint, proxy.getWorldMatrix());
    assert.ok(
      Vector3.Distance(mapped, expected) < 1e-6,
      `映射结果必须命中代理对应本地点 (${expected})，实际 (${mapped})`,
    );
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
