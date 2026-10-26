import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine, Scene, MeshBuilder, PBRMaterial, Color3, RawTexture } from '@babylonjs/core';
import { cloneDetachedModelMaterial } from '../../src/runtime/babylon/cloneDetachedModelMaterial.ts';
import { canBatchDetachedMaterialInitialization } from '../../src/runtime/babylon/SceneShaderWarmup.ts';

function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine);
  const source = new PBRMaterial('source', scene);
  source.albedoColor = new Color3(.2, .4, .7); source.roughness = .35; source.metallic = .6; source.alpha = .8;
  const other = new PBRMaterial('other', scene), mesh = MeshBuilder.CreateBox('unrelated', {}, scene); mesh.material = other;
  const submesh = mesh.subMeshes[0], original = submesh.getMaterial;
  let reads = 0;
  submesh.getMaterial = function (...args) { reads++; return Reflect.apply(original, this, args); };
  return { engine, scene, source, other, reads: () => reads, reset: () => { reads = 0; }, dispose() { scene.dispose(); engine.dispose(); } };
}

test('原生未绑定PBR克隆值不变，避免每个属性都遍历无关SubMesh', () => {
  const f = fixture();
  try {
    assert.equal(canBatchDetachedMaterialInitialization(f.source, f.scene), true);
    f.reset(); const baseline = f.source.clone('copy'); const baselineReads = f.reads();
    f.reset(); const candidate = cloneDetachedModelMaterial(f.source, f.source.clone,'copy') as PBRMaterial; const candidateReads = f.reads();
    const originalValues = baseline.serialize(), candidateValues = candidate.serialize();
    assert.notEqual(candidateValues.uniqueId, originalValues.uniqueId, '两次克隆仍创建独立材质身份');
    delete candidateValues.uniqueId; delete originalValues.uniqueId;
    assert.deepEqual(candidateValues, originalValues);
    assert.ok(baselineReads > 0); assert.ok(candidateReads < baselineReads, `${candidateReads}/${baselineReads}`);
    assert.equal(f.scene.blockMaterialDirtyMechanism, false);
    assert.equal(f.other.alpha, 1);
    candidate.dispose(); baseline.dispose();
  } finally { f.dispose(); }
});

test('新建材质监听、RawTexture与自定义clone保留原路径', async () => {
  const f = fixture();
  try {
    let seen: boolean | undefined;
    const observer = f.scene.onNewMaterialAddedObservable.add(material => { if (material.name === 'observed') seen = f.scene.blockMaterialDirtyMechanism; });
    assert.equal(canBatchDetachedMaterialInitialization(f.source, f.scene), false);
    const observed = cloneDetachedModelMaterial(f.source, f.source.clone,'observed')!;
    // Scene.addMaterial 通过 TimingTools.SetImmediate 分派通知，不能在 clone 返回时假定已经触发。
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(seen, false); observed.dispose();
    f.scene.onNewMaterialAddedObservable.remove(observer);
    f.source.albedoTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, f.scene);
    assert.equal(canBatchDetachedMaterialInitialization(f.source, f.scene), false);
    f.source.clone = function () { assert.equal(this, f.source); assert.equal(f.scene.blockMaterialDirtyMechanism, false); f.other.alpha = .25; return null as never; };
    assert.equal(cloneDetachedModelMaterial(f.source, f.source.clone,'custom'), null); assert.equal(f.other.alpha, .25);
  } finally { f.dispose(); }
});

test('嵌套阻断状态不被克隆入口清除', () => {
  const f = fixture();
  try {
    f.scene.blockMaterialDirtyMechanism = true;
    cloneDetachedModelMaterial(f.source, f.source.clone,'nested')!.dispose();
    assert.equal(f.scene.blockMaterialDirtyMechanism, true);
  } finally { f.scene.blockMaterialDirtyMechanism = false; f.dispose(); }
});
