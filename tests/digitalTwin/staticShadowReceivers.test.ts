import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBuilder, NullEngine, PBRMaterial, RawTexture, Scene, StandardMaterial, Vector3, VertexBuffer } from '@babylonjs/core';
import { cloneEnvironmentMaterial } from '../../src/runtime/babylon/cloneEnvironmentMaterial.ts';
import { groundReceiversOverlapXZ, inspectGroundReceiver, partitionGroundShadowLayers, selectGroundShadowReceivers, type GroundShadowReceiver } from '../../src/runtime/babylon/staticShadowReceivers.ts';

test('环境副本保留 Detail Map、原纹理引用和平铺参数，不遗留重复纹理', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const material = new PBRMaterial('ground', scene);
    const texture = RawTexture.CreateRGBATexture(new Uint8Array([180,180,180,255]), 1, 1, scene);
    texture.uScale = 128; texture.vScale = 64;
    material.albedoTexture = texture;
    material.detailMap.isEnabled = true; material.detailMap.texture = texture; material.detailMap.diffuseBlendLevel = 0.3;
    const textureCount = scene.textures.length;
    const clone = cloneEnvironmentMaterial(material, 'copy') as PBRMaterial;
    assert.equal(clone.albedoTexture, texture);
    assert.equal(clone.detailMap.isEnabled, true);
    assert.equal(clone.detailMap.texture, texture);
    assert.equal(clone.detailMap.diffuseBlendLevel, 0.3);
    assert.equal((clone.albedoTexture as RawTexture).uScale, 128);
    clone.dispose(false, false);
    assert.equal(scene.textures.length, textureCount);
    assert.equal(material.detailMap.isEnabled, true);
  } finally { scene.dispose(); engine.dispose(); }
});

test('地面包围盒只使用 primitive 索引，忽略共享缓冲区内其它材质顶点', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const floor = MeshBuilder.CreateGround('floor', { width: 4, height: 4 }, scene);
    floor.material = new StandardMaterial('floor', scene);
    floor.setVerticesData(VertexBuffer.PositionKind, [...floor.getVerticesData(VertexBuffer.PositionKind)!, 1000, 1000, 1000]);
    const receiver = inspectGroundReceiver({ key: 'floor', mesh: floor, material: floor.material });
    assert.ok(receiver);
    assert.equal(receiver.max.y, 0);
    assert.equal(receiver.max.x, 2);
    assert.equal(receiver.area, 16);
  } finally { scene.dispose(); engine.dispose(); }
});

test('选择设备下方地面，不把屋顶和深埋底板纳入烘焙', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const material = new StandardMaterial('ground', scene);
    const surfaces = [-30, 0, 10].map(y => {
      const mesh = MeshBuilder.CreateGround(`floor-${y}`, { width: 20, height: 20 }, scene);
      mesh.position.y = y; mesh.material = material;
      return { key: mesh.name, mesh, material };
    });
    const cube = MeshBuilder.CreateBox('device', { size: 2 }, scene); cube.position.y = 1;
    assert.deepEqual(selectGroundShadowReceivers(surfaces, [cube]).map(receiver => receiver.surface.key), ['floor-0']);
  } finally { scene.dispose(); engine.dispose(); }
});

function receiverWithTriangles(points: number[][][], height: number): GroundShadowReceiver {
  const triangles = points.map(triangle => triangle.map(([x, z]) => new Vector3(x, height, z)));
  const vertices = triangles.flat();
  return {
    surface: {} as GroundShadowReceiver['surface'],
    min: new Vector3(Math.min(...vertices.map(point => point.x)), height, Math.min(...vertices.map(point => point.z))),
    max: new Vector3(Math.max(...vertices.map(point => point.x)), height, Math.max(...vertices.map(point => point.z))),
    area: 1,
    triangles,
  };
}

test('重叠楼层自动分组，同层和不相交表面继续合并，无需人工拆分', () => {
  const lower = receiverWithTriangles([[[0,0],[4,0],[0,4]]], 0);
  const upper = receiverWithTriangles([[[0,0],[4,0],[0,4]]], 4);
  const sameFloor = receiverWithTriangles([[[2,2],[6,2],[2,6]]], 0);
  const remote = receiverWithTriangles([[[20,20],[24,20],[20,24]]], 10);
  const layers = partitionGroundShadowLayers([upper, lower, sameFloor, remote]);
  assert.equal(layers.length, 2);
  assert.ok(layers[0].includes(lower) && layers[0].includes(sameFloor) && layers[0].includes(remote));
  assert.ok(layers[1].includes(upper));
  assert.deepEqual(partitionGroundShadowLayers([]), []);
});

test('地面包围盒相交但真实三角形投影分离时不误判为重叠楼层', () => {
  const first = receiverWithTriangles([[[0, 0], [4, 0], [0, 4]]], 0);
  const second = receiverWithTriangles([[[3, 3], [4, 3], [3, 4]]], 3);
  assert.ok(first.max.x > second.min.x && first.max.z > second.min.z);
  assert.equal(groundReceiversOverlapXZ(first, second), false);
  assert.equal(groundReceiversOverlapXZ(second, first), false);
});

test('空间桶找到首组三角形之外的真实XZ投影交集', () => {
  const first = receiverWithTriangles([[[0, 0], [4, 0], [0, 4]]], 0);
  const second = receiverWithTriangles([
    [[3, 3], [4, 3], [3, 4]],
    [[1, 1], [2, 1], [1, 2]],
  ], 3);
  assert.equal(groundReceiversOverlapXZ(first, second), true);
  assert.equal(groundReceiversOverlapXZ(second, first), true);
});
