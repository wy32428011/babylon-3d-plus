import assert from 'node:assert/strict';
import test from 'node:test';
import { Material, Matrix, Mesh, MeshBuilder, MultiMaterial, NullEngine, PBRMaterial, Scene, SubMesh, TransformNode, VertexBuffer } from '@babylonjs/core';
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

function unindexedFixture(vertexCount = 6) {
  const engine = new NullEngine(), scene = new Scene(engine), mesh = new Mesh('操作终端', scene);
  const positions = Array.from({ length: vertexCount / 3 }, (_, i) => [i * 2, 0, 0, i * 2 + 1, 0, 0, i * 2, 1, 0]).flat();
  mesh.setVerticesData(VertexBuffer.PositionKind, positions);
  mesh.setVerticesData(VertexBuffer.UVKind, Array.from({ length: vertexCount / 3 }, () => [0, 0, 1, 0, 0, 1]).flat());
  mesh.setIndices([]); mesh.isUnIndexed = true; mesh.releaseSubMeshes();
  const multi = new MultiMaterial('终端材质', scene), red = new PBRMaterial('red', scene), blue = new PBRMaterial('blue', scene);
  red.albedoColor.set(1, 0, 0); blue.albedoColor.set(0, 0, 1); multi.subMaterials = [red, blue]; mesh.material = multi;
  return { engine, scene, mesh, red, blue, dispose() { scene.dispose(); engine.dispose(); } };
}

test('实际终端198/588顶点的合法无索引triangle-list生成顺序索引且保持源不变', async () => {
  for (const count of [198, 588]) {
    const f = unindexedFixture(count);
    try {
      new SubMesh(0, 0, count, 0, count, f.mesh);
      const geometry = f.mesh.geometry, positions = Array.from(f.mesh.getVerticesData(VertexBuffer.PositionKind)!);
      const parts = await exportLightingMesh(f.mesh, { key: 'terminal/pCube/instance:0', entityId: 'terminal', nodeKey: 'pCube/instance:0', receiver: true });
      assert.equal(parts.length, 1); assert.equal(parts[0].key, 'terminal/pCube/instance:0/primitive:0');
      assert.deepEqual(parts[0].indices, Array.from({ length: count }, (_, i) => i));
      assert.deepEqual(parts[0].positions, positions); assert.equal(parts[0].normals.length, positions.length);
      assert.deepEqual(Array.from(f.mesh.getIndices()!), []); assert.equal(f.mesh.geometry, geometry);
      assert.equal(f.mesh.getVerticesData(VertexBuffer.NormalKind), null, '补算法线只写快照，不改原几何');
      assert.equal(f.mesh.isUnIndexed, true);
    } finally { f.dispose(); }
  }
});

test('无索引多材质按verticesStart/count保留分组、空槽键、逻辑实例身份与镜像矩阵', async () => {
  const f = unindexedFixture();
  try {
    new SubMesh(0, 0, 0, 0, 0, f.mesh);
    new SubMesh(1, 3, 3, 90, 0, f.mesh);
    new SubMesh(0, 0, 3, 123, 198, f.mesh);
    const instance = f.mesh.createInstance('logical-instance'), geometry = f.mesh.geometry;
    const before = f.mesh.subMeshes.map(group => [group.materialIndex, group.verticesStart, group.verticesCount, group.indexStart, group.indexCount]);
    const matrix = Matrix.Scaling(-2, 3, 1).multiply(Matrix.Translation(10, 20, 30)), identity = { key: 'logical-second/pCube/instance:4', entityId: 'logical-second', nodeKey: 'pCube/instance:4', receiver: true, worldMatrix: matrix };
    const parts = await exportLightingMesh(instance, identity);
    assert.deepEqual(parts.map(part => part.key), ['logical-second/pCube/instance:4/primitive:1', 'logical-second/pCube/instance:4/primitive:2']);
    assert.deepEqual(parts.map(part => part.indices), [[3, 4, 5], [0, 1, 2]]);
    assert.deepEqual(parts.map(part => part.material.baseColor), [[0, 0, 1], [1, 0, 0]]);
    assert.ok(parts.every(part => part.entityId === identity.entityId && part.nodeKey === identity.nodeKey));
    assert.ok(parts.every(part => JSON.stringify(part.worldMatrix) === JSON.stringify(Array.from(matrix.m))));
    assert.ok(parts.every(part => part.uvs!.length === 12 && part.normals.length === 18));
    assert.deepEqual(f.mesh.subMeshes.map(group => [group.materialIndex, group.verticesStart, group.verticesCount, group.indexStart, group.indexCount]), before);
    assert.deepEqual(Array.from(f.mesh.getIndices()!), []); assert.equal(f.mesh.geometry, geometry);
  } finally { f.dispose(); }
});

test('无索引零indexCount但非零verticesCount仍导出，残缺面、越界、线和点拒绝', async () => {
  const f = unindexedFixture();
  try {
    new SubMesh(0, 0, 6, 0, 0, f.mesh);
    const identity = { key: 'terminal/root', entityId: 'terminal', nodeKey: 'root', receiver: true };
    assert.deepEqual((await exportLightingMesh(f.mesh, identity))[0]?.indices, [0, 1, 2, 3, 4, 5]);
    f.mesh.subMeshes[0].verticesCount = 5;
    await assert.rejects(exportLightingMesh(f.mesh, identity), /三角|顶点范围/);
    f.mesh.subMeshes[0].verticesStart = 3; f.mesh.subMeshes[0].verticesCount = 6;
    await assert.rejects(exportLightingMesh(f.mesh, identity), /三角|顶点范围/);
    f.mesh.subMeshes[0].verticesStart = 0; f.mesh.subMeshes[0].verticesCount = 6;
    for (const mode of [Material.LineListDrawMode, Material.PointListDrawMode]) {
      f.red.fillMode = mode; await assert.rejects(exportLightingMesh(f.mesh, identity), /拓扑|三角/);
    }
  } finally { f.dispose(); }
});
