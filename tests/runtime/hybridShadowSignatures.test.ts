import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import {
  DynamicTexture, FreeCamera, Material, Matrix, MeshBuilder, MultiMaterial, NullEngine, PBRMaterial,
  Scene, SubMesh, TransformNode, Vector3, VertexBuffer,
} from '@babylonjs/core';
import { HybridShadowMeshState } from '../../src/runtime/babylon/HybridShadowCache.ts';
import { HybridShadowMatrixSnapshot } from '../../src/runtime/babylon/hybridShadowSignatures.ts';

const staticRole = { mobility: 'static' as const, castShadows: true, receiveShadows: true };

function fixture(mode: 'numeric' | 'legacy') {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new FreeCamera('camera', new Vector3(0, 4, -8), scene);
  camera.setTarget(Vector3.Zero());
  const parent = new TransformNode('parent', scene);
  const mesh = MeshBuilder.CreateBox('static', { size: 1, updatable: true }, scene);
  mesh.parent = parent;
  const material = new PBRMaterial('material', scene);
  mesh.material = material;
  const canvas = { width: 2, height: 2, getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const texture = new DynamicTexture('alpha', canvas, scene, false);
  const state = new HybridShadowMeshState();
  state.setSignatureMode(mode);
  state.setMeshes([mesh], new Map([[mesh, staticRole]]));
  return { engine, scene, parent, mesh, material, texture, state };
}

test('数值签名与旧字符串签名逐帧等价，覆盖变换、alpha、几何及subMesh拓扑', () => {
  const fixtures = [fixture('numeric'), fixture('legacy')];
  const frame = (label: string, expected: boolean, change: (f: ReturnType<typeof fixture>) => void = () => {}) => {
    const results = fixtures.map(f => {
      const before = f.state.revision;
      change(f); f.state.refresh();
      return f.state.revision !== before;
    });
    assert.deepEqual(results, [expected, expected], label);
  };
  try {
    frame('初始化', true);
    frame('静止命中', false);
    frame('同一renderId直接改本地位置', true, f => { f.mesh.position.x = 3; });
    frame('同一renderId父级变化', true, f => { f.parent.position.z = 2; });
    frame('世界矩阵重新计算但数值不变', false, f => { f.mesh.computeWorldMatrix(true); });
    frame('冻结矩阵', false, f => { f.mesh.freezeWorldMatrix(); });
    frame('直接写m且updateFlag不变', true, f => {
      const world = f.mesh.getWorldMatrix(), flag = world.updateFlag;
      (world.m as number[])[12] += 0.25;
      assert.equal(world.updateFlag, flag);
    });
    frame('直接写m后稳定', false);
    frame('解冻恢复正常变换', true, f => { f.mesh.unfreezeWorldMatrix(); f.mesh.position.x += 1; });
    frame('可见性', true, f => { f.mesh.visibility = 0.5; });
    frame('isVisible', true, f => { f.mesh.isVisible = false; });
    frame('enabled', true, f => { f.mesh.setEnabled(false); });
    frame('渲染组', true, f => { f.mesh.renderingGroupId = 1; });
    frame('恢复可见', true, f => { f.mesh.visibility = 1; f.mesh.isVisible = true; f.mesh.setEnabled(true); });
    frame('opaque动态贴图', false, f => { f.material.albedoTexture = f.texture; f.scene.render(); });
    frame('opaque动态贴图跨帧', false, f => { f.scene.render(); });
    frame('透明裁剪', true, f => { f.texture.hasAlpha = true; f.material.transparencyMode = Material.MATERIAL_ALPHATEST; });
    frame('DynamicTexture同一帧', false);
    frame('DynamicTexture跨帧', true, f => { f.scene.render(); });
    frame('alphaCutOff', true, f => { f.material.alphaCutOff = 0.3; });
    frame('alpha UV矩阵', true, f => { f.texture.uOffset = 0.25; });
    frame('alpha UV矩阵直接写m', true, f => { (f.texture.getTextureMatrix().m as number[])[12] += 0.5; });
    frame('alpha UV通道', true, f => { f.texture.coordinatesIndex = 1; });
    frame('alpha blend模式', true, f => { f.material.transparencyMode = Material.MATERIAL_ALPHABLEND; });
    frame('alpha', true, f => { f.material.alpha = 0.8; });
    frame('backFaceCulling', true, f => { f.material.backFaceCulling = false; });
    frame('cullBackFaces', true, f => { f.material.cullBackFaces = false; });
    frame('fillMode', true, f => { f.material.fillMode = Material.MATERIAL_WIREFRAMEFILLMODE; });
    frame('sideOrientation', true, f => { f.material.sideOrientation = Material.ClockWiseSideOrientation; });
    frame('稳定NaN与旧join一致', true, f => { f.material.alphaCutOff = Number.NaN; });
    frame('NaN不重复失效', false);
    frame('恢复数值', true, f => { f.material.alphaCutOff = 0; });
    frame('-0与旧join一致', false, f => { f.material.alphaCutOff = -0; });
    frame('alpha贴图ready', true, f => { f.texture.isReady = () => true; });
    frame('alpha贴图ready稳定', false);
    frame('重划subMesh', true, f => {
      const multi = new MultiMaterial('multi', f.scene);
      multi.subMaterials = [f.material, new PBRMaterial('child', f.scene)];
      f.mesh.material = multi; f.mesh.releaseSubMeshes();
      new SubMesh(0, 0, f.mesh.getTotalVertices(), 0, 18, f.mesh);
      new SubMesh(1, 0, f.mesh.getTotalVertices(), 18, 18, f.mesh);
    });
    frame('subMesh索引', true, f => { f.mesh.subMeshes![1].indexCount = 12; });
    frame('subMesh有效材质变化', true, f => {
      (f.mesh.material as MultiMaterial).subMaterials[1]!.alpha = 0.7;
    });
    frame('去掉subMesh', true, f => { f.mesh.subMeshes!.pop(); });
    frame('几何顶点原地更新', true, f => {
      const positions = f.mesh.getVerticesData(VertexBuffer.PositionKind)!;
      positions[0] += 0.5;
      f.mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
    });
    frame('同renderId几何更新已刷新世界包围盒', false, f => {
      const positions = f.mesh.getVerticesData(VertexBuffer.PositionKind)!;
      assert.equal(f.mesh.getBoundingInfo().boundingBox.vectorsWorld.length, 8);
      assert.equal(f.mesh.getBoundingInfo().boundingBox.minimum.x, Math.min(...positions.filter((_, index) => index % 3 === 0)));
    });
    frame('geometry回调替换', true, f => { f.mesh.geometry!.onGeometryUpdated = () => {}; });
    frame('稳定命中', false);
    frame('几何替换', true, f => { f.mesh.geometry!.copy('new').applyToMesh(f.mesh); });
    frame('材质为空', true, f => { f.mesh.material = null; });
    frame('空材质稳定', false);
    frame('移出静态集合', true, f => { f.state.setMeshes([], new Map()); });
    frame('重新加入静态集合', true, f => { f.state.setMeshes([f.mesh], new Map([[f.mesh, staticRole]])); });
  } finally {
    for (const f of fixtures) { f.state.dispose(); f.scene.dispose(); f.engine.dispose(); }
  }
});

test('矩阵快照保留64位精度，识别同flag直接修改并与join的NaN/-0语义一致', () => {
  const values = new Float64Array(16), snapshot = new HybridShadowMatrixSnapshot();
  const matrix = { updateFlag: 1, asArray: () => values } as unknown as Matrix;
  assert.equal(snapshot.update(null), false);
  assert.equal(snapshot.update(matrix), true);
  assert.equal(snapshot.update(matrix), false);
  values[12] = 1 + Number.EPSILON;
  assert.equal(snapshot.update(matrix), true);
  assert.equal(snapshot.update(matrix), false, '不能把快照截断为Float32后持续失效');
  values[12] = 1;
  assert.equal(snapshot.update(matrix), true, 'Float32无法区分的变化仍需失效');
  values[0] = Number.NaN;
  assert.equal(snapshot.update(matrix), true);
  assert.equal(snapshot.update(matrix), false);
  matrix.updateFlag++;
  assert.equal(snapshot.update(matrix), false, 'flag变化但数值未变保持命中');
  values[1] = -0;
  assert.equal(snapshot.update(matrix), false);
  assert.equal(snapshot.update(null), true);
  assert.equal(snapshot.update(null), false);
  assert.equal(snapshot.update(matrix), true);
});

test('内部A/B入口可切换回旧签名且保留稳定命中', () => {
  const f = fixture('numeric');
  try {
    f.state.refresh();
    for (const mode of ['legacy', 'numeric'] as const) {
      f.state.setSignatureMode(mode); f.state.refresh();
      const revision = f.state.revision;
      f.state.refresh(); assert.equal(f.state.revision, revision);
      f.mesh.position.y += 1; f.state.refresh(); assert.ok(f.state.revision > revision);
    }
  } finally { f.state.dispose(); f.scene.dispose(); f.engine.dispose(); }
});

test('S1静态签名微基准', { skip: process.env.HYBRID_SHADOW_BENCHMARK !== '1' }, () => {
  const f = fixture('numeric');
  const meshes = Array.from({ length: 2000 }, (_, index) => {
    const mesh = f.mesh.clone('bench-' + index)!;
    mesh.position.x = index * 2;
    return mesh;
  });
  const samples = { numeric: [] as number[], legacy: [] as number[] };
  try {
    f.state.setMeshes(meshes, new Map(meshes.map(mesh => [mesh, staticRole])));
    for (let round = 0; round < 7; round++) for (const mode of round % 2 ? ['numeric', 'legacy'] as const : ['legacy', 'numeric'] as const) {
      f.state.setSignatureMode(mode);
      for (let frame = 0; frame < 12; frame++) f.state.refresh();
      const beforeRevision = f.state.revision;
      const started = performance.now();
      for (let frame = 0; frame < 90; frame++) f.state.refresh();
      samples[mode].push((performance.now() - started) / 90);
      assert.equal(f.state.revision, beforeRevision, '两种实现都必须保持静态命中');
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.log(JSON.stringify({ benchmark: 'S1-static-signatures', meshes: meshes.length, framesPerSample: 90,
      samplesMsPerFrame: samples, medianMsPerFrame: { numeric: median(samples.numeric), legacy: median(samples.legacy) },
      ratio: median(samples.numeric) / median(samples.legacy) }));
  } finally { f.state.dispose(); f.scene.dispose(); f.engine.dispose(); }
});
