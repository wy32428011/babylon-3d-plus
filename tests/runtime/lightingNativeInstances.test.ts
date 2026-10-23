import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix, MeshBuilder, NullEngine, Scene } from '@babylonjs/core';
import { getNativeLightingInstances } from '../../src/runtime/babylon/lightingNativeInstances.ts';

test('原生薄实例完整导出与隐藏不改变业务矩阵和数量，业务更新仍可读取', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const mesh = MeshBuilder.CreateBox('native-rack', {}, scene);
    const data = new Float32Array([...Matrix.Translation(2, 0, 0).asArray(), ...Matrix.Translation(9, 0, 0).asArray()]);
    mesh.thinInstanceSetBuffer('matrix', data, 16, false);
    mesh.position.y = 3; mesh.computeWorldMatrix(true);
    const adapter = getNativeLightingInstances(mesh, 'rack');
    assert.equal(adapter.getLightingInstances().length, 2);
    assert.equal(adapter.getLightingInstanceWorldMatrix(mesh, 1)?.m[12], 9);
    const originalLayer = mesh.layerMask;
    assert.throws(() => adapter.setLightingHiddenInstances(new Map([[mesh.uniqueId, new Set([0])]])), /完整接管/);
    adapter.setLightingHiddenInstances(new Map([[mesh.uniqueId, new Set([0, 1])]]));
    assert.equal(mesh.layerMask, 0);
    assert.equal(mesh.thinInstanceCount, 2);
    assert.equal(mesh._thinInstanceDataStorage.matrixData, data);
    mesh.thinInstanceSetMatrixAt(1, Matrix.Translation(12, 0, 0), true);
    assert.equal(adapter.getLightingInstanceWorldMatrix(mesh, 1)?.m[12], 12);
    adapter.setLightingHiddenInstances(new Map());
    assert.equal(mesh.layerMask, originalLayer);
  } finally { scene.dispose(); engine.dispose(); }
});
