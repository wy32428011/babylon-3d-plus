import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { FreeCamera, Matrix, MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';

const hooks = registerHooks({
  load(url, context, next) {
    if (url.endsWith('/EntityArrayThinInstanceBatch.ts')) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { EntityArrayThinInstanceBatch } = await import('../../src/runtime/babylon/EntityArrayThinInstanceBatch.ts');
hooks.deregister();

function fixture(twoLeaves = false) {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new FreeCamera('camera', new Vector3(0, 0, -12), scene);
  camera.setTarget(Vector3.Zero()); camera.maxZ = 100;
  const rail = MeshBuilder.CreateBox('rail', { size: 1 }, scene);
  const fork = twoLeaves ? MeshBuilder.CreateBox('fork', { size: 0.5 }, scene) : null;
  if (fork) fork.position.y = 2;
  const source = [rail, ...(fork ? [fork] : [])];
  const batch = EntityArrayThinInstanceBatch.create('source', source, { interactive: true });
  const instance = (entityId, x, scale = 1) => ({ entityId, pickable: true, transform: {
    position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: scale, y: 1, z: 1 } } });
  const update = instances => { assert.equal(batch.updateEntityTransforms(Matrix.Identity(), instances), true); scene.render(); };
  return { engine, scene, camera, rail, fork, batch, instance, update,
    dispose() { batch.dispose(); scene.dispose(); engine.dispose(); } };
}

test('lighting export includes every source instance outside the camera and preserves mirror carriers', () => {
  const f = fixture();
  try {
    f.update([f.instance('a', 0), f.instance('b', 1, -1), f.instance('offscreen', 5000)]);
    const entries = f.batch.getLightingInstances();
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map(entry => entry.entityId).sort(), ['a', 'b', 'offscreen']);
    assert.ok(f.batch.meshes.reduce((sum, mesh) => sum + mesh.thinInstanceCount, 0) < entries.length);
    for (const entry of entries) {
      assert.equal(entry.sourceMesh, f.rail);
      assert.equal(entry.worldMatrix.getTranslation().x, { a: 0, b: 1, offscreen: 5000 }[entry.entityId]);
      assert.equal(Math.sign(entry.worldMatrix.determinant()), entry.entityId === 'b' ? -1 : 1);
      assert.deepEqual(Array.from(f.batch.getLightingInstanceWorldMatrix(entry.mesh, entry.sourceIndex).m), Array.from(entry.worldMatrix.m));
    }
    assert.equal(f.batch.getLightingInstanceWorldMatrix(f.rail, 0), null);
    assert.equal(f.batch.getLightingInstanceWorldMatrix(entries[0].mesh, -1), null);
    assert.equal(f.batch.getLightingInstanceWorldMatrix(entries[0].mesh, 100000), null);
    entries[0].worldMatrix.setTranslationFromFloats(100, 100, 100);
    assert.equal(f.batch.getLightingInstances().find(entry => entry.entityId === 'a').worldMatrix.getTranslation().x, 0, '导出矩阵不能修改权威源数据');
  } finally { f.dispose(); }
});

test('lighting replacement hides only the selected leaf instance and preserves picking and selection', () => {
  const f = fixture(true);
  try {
    f.update([f.instance('a', 0), f.instance('b', 1)]);
    const before = f.batch.getLightingInstances();
    const hidden = before.find(entry => entry.sourceMesh === f.rail && entry.entityId === 'a');
    f.batch.setSelectionMask(new Set(['b']), 7);
    f.batch.setLightingHiddenInstances(new Map([[hidden.mesh.uniqueId, new Set([hidden.sourceIndex])]]));
    assert.equal(f.batch.getLightingInstanceWorldMatrix(hidden.mesh, hidden.sourceIndex).getTranslation().x, 0);
    assert.equal(hidden.mesh.thinInstanceCount, 1);
    assert.equal(f.batch.getEntityIdForThinInstance(hidden.mesh, 0), 'b');
    assert.equal(hidden.mesh.getVertexBuffer('instanceSelectionId').getData()[0], 7);
    assert.equal(before.find(entry => entry.sourceMesh === f.fork).mesh.thinInstanceCount, 2);
    const after = f.batch.getLightingInstances();
    assert.equal(after.length, 4);
    assert.deepEqual(after.map(entry => Array.from(entry.worldMatrix.m)), before.map(entry => Array.from(entry.worldMatrix.m)));
    f.update([f.instance('a', 2), f.instance('b', 3)]);
    assert.equal(hidden.mesh.thinInstanceCount, 1, '逻辑矩阵更新不得重新显示已被接管的叶实例');
    assert.equal(f.batch.getLightingInstanceWorldMatrix(hidden.mesh, hidden.sourceIndex).getTranslation().x, 2);
    f.batch.setLightingHiddenInstances(new Map());
    assert.equal(hidden.mesh.thinInstanceCount, 2);
    assert.equal(f.batch.getEntityIdForThinInstance(hidden.mesh, 0), 'a');
    assert.equal(f.batch.getEntityIdForThinInstance(hidden.mesh, 1), 'b');
  } finally { f.dispose(); }
});

test('hiding all then restoring works without an active camera and never removes the full source set', () => {
  const f = fixture();
  try {
    f.update([f.instance('a', 0), f.instance('b', 1)]);
    f.scene.activeCamera = null;
    const entries = f.batch.getLightingInstances(), mesh = entries[0].mesh;
    f.batch.setLightingHiddenInstances(new Map([[mesh.uniqueId, new Set(entries.map(entry => entry.sourceIndex))]]));
    assert.equal(mesh.thinInstanceCount, 0);
    assert.equal(mesh.isEnabled(), false);
    assert.equal(f.batch.getLightingInstances().length, 2);
    f.batch.setLightingHiddenInstances(new Map());
    assert.equal(mesh.thinInstanceCount, 2);
    assert.equal(mesh.isEnabled(), true);
  } finally { f.dispose(); }
});

test('lighting revision tracks authoritative transforms but ignores camera and rendering masks', () => {
  const f = fixture();
  try {
    f.update([f.instance('a', 0), f.instance('b', 1)]);
    const initial = f.batch.getLightingRevision(), entries = f.batch.getLightingInstances();
    f.batch.setSelectionMask(new Set(['a']), 3);
    f.batch.setLightingHiddenInstances(new Map([[entries[0].mesh.uniqueId, new Set([entries[0].sourceIndex])]]));
    f.camera.position.x = 30; f.scene.render();
    assert.equal(f.batch.getLightingRevision(), initial);
    assert.equal(f.batch.isLightingInstanceVisible(entries[0].mesh, entries[0].sourceIndex), true);
    f.update([f.instance('a', 0), f.instance('b', 1)]);
    assert.equal(f.batch.getLightingRevision(), initial);
    f.update([f.instance('a', 0), f.instance('b', 2)]);
    assert.ok(f.batch.getLightingRevision() > initial);
    const moved = f.batch.getLightingRevision();
    assert.equal(f.batch.beginEntityTranslationPreview(new Set(['a'])), true);
    f.batch.updateEntityTranslationPreview({ x: 5, y: 0, z: 0 });
    assert.ok(f.batch.getLightingRevision() > moved);
    const previewed = f.batch.getLightingRevision();
    f.batch.endEntityTranslationPreview(true);
    assert.ok(f.batch.getLightingRevision() > previewed);
  } finally { f.dispose(); }
});
