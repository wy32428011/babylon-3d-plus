import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBuilder, MultiMaterial, NullEngine, PBRMaterial, Scene, SubMesh, TransformNode } from '@babylonjs/core';
import { createLightingNodeKey, exportLightingMesh } from '../../src/runtime/babylon/lightingGeometry.ts';

test('稳定部件键区分同名兄弟节点，重建后保持不变', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const root = new TransformNode('root', scene);
    const a = new TransformNode('rail', scene), b = new TransformNode('rail', scene);
    a.parent = root; b.parent = root;
    assert.notEqual(createLightingNodeKey(a, root), createLightingNodeKey(b, root));
    assert.equal(createLightingNodeKey(a, root), 'rail[0]');
    assert.equal(createLightingNodeKey(b, root), 'rail[1]');
  } finally { scene.dispose(); engine.dispose(); }
});

test('多材质快照逐 primitive 保留原索引、UV 与世界矩阵，不修改源几何', async () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const mesh = MeshBuilder.CreateBox('box', {}, scene);
    const material = new MultiMaterial('two', scene);
    material.subMaterials = [new PBRMaterial('red', scene), new PBRMaterial('blue', scene)];
    mesh.material = material;
    mesh.subMeshes = [];
    new SubMesh(0, 0, 24, 0, 18, mesh);
    new SubMesh(1, 0, 24, 18, 18, mesh);
    mesh.position.x = 5; mesh.computeWorldMatrix(true);
    const original = Array.from(mesh.getIndices()!);
    const parts = await exportLightingMesh(mesh, { key: 'a/box', entityId: 'a', nodeKey: 'box', receiver: true });
    assert.equal(parts.length, 2);
    assert.equal(parts[0].key, 'a/box/primitive:0');
    assert.equal(parts[1].indices.length, 18);
    assert.equal(parts[0].worldMatrix[12], 5);
    assert.deepEqual(Array.from(mesh.getIndices()!), original);
    assert.equal(parts[0].uvs!.length, 48);
  } finally { scene.dispose(); engine.dispose(); }
});
