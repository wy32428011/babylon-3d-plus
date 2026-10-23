import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix, MeshBuilder, NullEngine, Ray, Scene, TransformNode, Vector3, VertexBuffer } from '@babylonjs/core';
import { LightingProbeOcclusionQuery, type LightingProbeOccluder } from '../../src/runtime/babylon/lightingProbeOcclusion.ts';

function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine);
  const wall = MeshBuilder.CreateBox('wall', { width: 0.2, height: 10, depth: 10, updatable: true }, scene);
  const floor = MeshBuilder.CreateBox('floor', { width: 20, height: 0.2, depth: 20 }, scene); floor.position.y = 3;
  const distant = MeshBuilder.CreateBox('distant', { size: 1 }, scene); distant.position.set(100, 0, 0);
  let matrixReads = 0;
  const sources: LightingProbeOccluder[] = [wall, floor, distant].map(mesh => ({ key: mesh.name, mesh, getWorldMatrix: () => { matrixReads++; return mesh.computeWorldMatrix(true); } }));
  return { engine, scene, wall, floor, sources, get matrixReads() { return matrixReads; }, dispose() { scene.dispose(); engine.dispose(); } };
}
function legacyVisible(position: Vector3, point: readonly [number, number, number], sources: LightingProbeOccluder[], receiverKey = '') {
  const offset = Vector3.FromArray(point).subtract(position), distance = offset.length();
  if (distance < 0.001) return true;
  const direction = offset.scale(1 / distance), ray = new Ray(position.add(direction.scale(0.005)), direction, Math.max(0, distance - 0.01));
  for (const source of sources) {
    if (source.key === receiverKey) continue;
    const world = source.getWorldMatrix(); if (!world) continue;
    const hit = source.mesh.intersects(Ray.Transform(ray, Matrix.Invert(world)), true, undefined, false, world);
    if (hit.hit && hit.distance < distance - 0.01) return false;
  }
  return true;
}

test('遮挡查询与原算法一致，墙体、楼板、镜像父节点、接收者自遮挡均保留', () => {
  const f = fixture();
  try {
    const parent = new TransformNode('mirrored', f.scene); parent.scaling.set(-1.5, 0.7, 2); parent.rotation.y = 0.4; f.wall.parent = parent;
    const query = new LightingProbeOcclusionQuery(f.sources);
    for (const from of [new Vector3(-3, 0, 0), new Vector3(3, 0, 0), new Vector3(1, 5, 1)]) {
      for (const to of [[3, 0, 0], [-3, 0, 0], [1, 5, 1], [2, 1, 1], [-4, -1, -4]] as const) {
        for (const receiverKey of ['', 'wall', 'floor']) assert.equal(query.visible(from, to, receiverKey), legacyVisible(from, to, f.sources, receiverKey));
      }
    }
    assert.equal(query.visible(new Vector3(-3, 0, 0), [3, 0, 0]), false);
    assert.equal(query.visible(new Vector3(2, 0, 0), [2, 5, 0]), false);
  } finally { f.dispose(); }
});

test('同一次查询边界只读取和求逆一次矩阵，远端包围盒避免三角形检测', () => {
  const f = fixture();
  try {
    const query = new LightingProbeOcclusionQuery(f.sources);
    for (let i = 0; i < 20; i++) assert.equal(query.visible(new Vector3(2, 0, 0), [2, 0, 1 + i * 0.01]), true);
    assert.equal(f.matrixReads, 3);
    assert.deepEqual(query.stats, { matrixReads: 3, matrixInversions: 3, boundsTests: 60, triangleTests: 0 });
  } finally { f.dispose(); }
});

test('查询边界之间同帧移动和原地几何更新读取新矩阵及新包围盒', () => {
  const f = fixture();
  try {
    const from = new Vector3(-3, 0, 0), to = [3, 0, 0] as const;
    assert.equal(new LightingProbeOcclusionQuery(f.sources).visible(from, to), false);
    f.wall.position.z = 50;
    assert.equal(new LightingProbeOcclusionQuery(f.sources).visible(from, to), true);
    f.wall.position.z = 0;
    const positions = f.wall.getVerticesData(VertexBuffer.PositionKind)!;
    for (let i = 2; i < positions.length; i += 3) positions[i] += 50;
    f.wall.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    const next = new LightingProbeOcclusionQuery(f.sources);
    assert.equal(next.visible(from, to), true);
    assert.equal(next.visible(from, to), legacyVisible(from, to, f.sources));
  } finally { f.dispose(); }
});
