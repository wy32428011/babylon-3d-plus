import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Matrix, MeshBuilder, NullEngine, Plane, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import ts from 'typescript';
const root = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(url) && existsSync(new URL(url.href.replace(/\.js$/, '') + '.ts'))) return next(url.href.replace(/\.js$/, '') + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { EntityArrayThinInstanceBatch } = await import('../../src/runtime/babylon/EntityArrayThinInstanceBatch.ts');
const { isTransformedBoxInFrustum } = await import('../../src/runtime/babylon/thinInstanceFrustum.ts');
hooks.deregister();

test('独立矩阵模块保持正负缩放、实体拾取和无效更新的原子性', t => {
  const engine = new NullEngine(), scene = new Scene(engine);
  engine.getCaps().instancedArrays = true;
  const source = MeshBuilder.CreateBox('source', { width: 2, height: 1, depth: 1 }, scene);
  source.position.z = 2;
  source.material = new StandardMaterial('source-material', scene);
  const batch = EntityArrayThinInstanceBatch.create('source', [source], { interactive: true });
  assert.ok(batch);
  t.after(() => { batch.dispose(); scene.dispose(); engine.dispose(); });
  const instance = (entityId, x, sx) => ({ entityId, pickable: true, transform: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: sx, y: 1, z: 1 } } });
  assert.equal(batch.updateEntityTransforms(Matrix.Identity(), [instance('a', 3, 2), instance('b', -4, -1)]), true);
  const lighting = batch.getLightingInstances();
  assert.equal(lighting.length, 2);
  const centers = Object.fromEntries(lighting.map(item => [item.entityId, Vector3.TransformCoordinates(Vector3.Zero(), item.worldMatrix).asArray()]));
  assert.deepEqual(centers, { a: [3, 0, 2], b: [-4, 0, 2] });
  const picked = batch.meshes.flatMap(mesh => Array.from({ length: mesh.thinInstanceCount }, (_, index) => batch.getEntityIdForThinInstance(mesh, index))).sort();
  assert.deepEqual(picked, ['a', 'b']);
  batch.setSelectionMask(['b']);
  const matrices = lighting.map(item => Array.from(item.worldMatrix.m));
  assert.equal(batch.updateEntityTransforms(Matrix.Identity(), [instance('a', NaN, 2)]), false);
  assert.deepEqual(batch.getLightingInstances().map(item => Array.from(item.worldMatrix.m)), matrices, '失败不能提交半套实体或矩阵');
  assert.deepEqual(batch.getEntityIds(), ['a', 'b']);
  batch.dispose();
  assert.equal(source.isDisposed(), false);
  assert.equal(scene.meshes.length, 1);
});

test('独立视锥模块按真实盒体半轴保守裁剪，切面接触及非有限矩阵不误删', () => {
  const plane = [new Plane(1, 0, 0, 0)], center = Vector3.Zero(), extent = Vector3.One(), scratch = Vector3.Zero();
  const outside = Matrix.Scaling(2, 1, 1).multiply(Matrix.Translation(-3, 0, 0));
  assert.equal(isTransformedBoxInFrustum(center, extent, outside, plane, scratch), false);
  const tangent = Matrix.Scaling(-2, 1, 1).multiply(Matrix.Translation(-2, 0, 0));
  assert.equal(isTransformedBoxInFrustum(center, extent, tangent, plane, scratch), true);
  const shear = Matrix.Identity(); shear.m[4] = 4; shear.m[12] = -4.5;
  assert.equal(isTransformedBoxInFrustum(center, extent, shear, plane, scratch), true, '剪切后的右侧面穿过裁剪平面');
  const invalid = Matrix.Identity(); invalid.m[12] = NaN;
  assert.equal(isTransformedBoxInFrustum(center, extent, invalid, plane, scratch), true);
});
