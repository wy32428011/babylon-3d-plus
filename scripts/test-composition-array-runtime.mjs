import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

const project = new URL('../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.includes('?') && specifier.startsWith('.')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    if (specifier.startsWith('@babylonjs/') && specifier.split('/').length > 2 && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('lodash/') && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href)) {
      const candidate = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(project.href) && (/\.(png|jpe?g|webp|gif|svg|glb|gltf|bin)(\?.*)?$/i.test(url) || url.includes('?url'))) return {
      format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};`,
    };
    if (url.startsWith(project.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
const { SceneRuntime } = await import('../src/runtime/babylon/SceneRuntime.ts');
const { TransformGizmoController } = await import('../src/runtime/babylon/TransformGizmoController.ts');
hooks.deregister();

function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine);
  const runtime = new SceneRuntime(scene);
  // 本夹具只计数组预览几何；释放真实构造时附带的投影接收面，保持原来的隔离范围。
  runtime.environment.shadowRuntime.dispose();
  const transform = (x = 0) => ({ position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
  const entities = {
    group: { id: 'group', name: '组合', isFolder: true, parentId: null, childrenIds: ['a', 'b'], components: { transform: transform() }, composition: { schemaVersion: 1, instanceId: 'i', libraryId: 'l', revision: 'r' } },
    a: { id: 'a', name: 'a', parentId: 'group', childrenIds: [], components: { transform: transform(), meshRenderer: { type: 'box' } } },
    b: { id: 'b', name: 'b', parentId: 'group', childrenIds: [], components: { transform: transform(5), meshRenderer: { type: 'box' } } },
  };
  const a = MeshBuilder.CreateBox('a', { width: 2, height: 2, depth: 2 }, scene);
  const b = MeshBuilder.CreateBox('b', { width: 4, height: 2, depth: 2 }, scene); b.position.x = 5;
  Object.assign(runtime, { scene });
  Object.assign(runtime.document, { shadowDocument: { entities, entityIds: Object.keys(entities) } });
  Object.assign(runtime.presentation, { meshes: new Map([['a', a], ['b', b]]) });
  Object.assign(runtime.assets, { models: new Map() });
  Object.assign(runtime.locators, { locators: new Map() });
  Object.assign(runtime.cad, { cadReferences: new Map() });
  Object.assign(runtime.arrays, { modelArrayInstanceEntities: new Map() });
  Object.assign(runtime.variants, { modelArrayParameterVariantByEntityId: new Map() });
  Object.assign(runtime.effects, { poiEffectRuntime: { getEntityArraySource: () => null } });
  Object.assign(runtime.transforms, { entityArrayPreview: null, compositionArrayPreview: null });
  return { runtime, scene, engine, a, b, entities, transform, dispose() { runtime.clearEntityArrayPreview(); scene.dispose(); engine.dispose(); } };
}

test('whole composition span covers all independent world transforms and all six axes', () => {
  const f = fixture();
  try {
    for (const sign of [-1, 1]) {
      assert.equal(f.runtime.getEntityArrayGeometry('group', { x: sign, y: 0, z: 0 })?.spanMeters, 8);
      assert.equal(f.runtime.getEntityArrayGeometry('group', { x: 0, y: sign, z: 0 })?.spanMeters, 2);
      assert.equal(f.runtime.getEntityArrayGeometry('group', { x: 0, y: 0, z: sign })?.spanMeters, 2);
    }
    f.a.scaling.x = -1;
    f.b.rotation.y = Math.PI / 2; f.b.scaling.x = 2;
    assert.ok(Math.abs(f.runtime.getEntityArrayGeometry('group', { x: 1, y: 0, z: 0 }).spanMeters - 7) < 1e-6);
    assert.ok(Math.abs(f.runtime.getEntityArrayGeometry('group', { x: 0, y: 0, z: 1 }).spanMeters - 8) < 1e-6);
    f.runtime.presentation.meshes.delete('b');
    assert.equal(f.runtime.getEntityArrayGeometry('group', { x: 1, y: 0, z: 0 }), null);
  } finally { f.dispose(); }
});

test('composition matrix preview places both members at whole-group offsets without changing source geometry', () => {
  const f = fixture();
  try {
    const geometry = f.a.geometry;
    assert.equal(f.runtime.updateEntityArrayPreview('group', { x: 1, y: 0, z: 0 }, 2, 1), true);
    const previews = f.scene.meshes.filter(mesh => mesh !== f.a && mesh !== f.b);
    assert.equal(previews.length, 2);
    assert.ok(previews.every(mesh => !mesh.isPickable));
    const placements = previews.flatMap(mesh => mesh.thinInstanceGetWorldMatrices().map(m => m.getTranslation().x)).sort((a, b) => a - b);
    assert.deepEqual(placements, [9, 14, 18, 23]);
    assert.equal(f.a.position.x, 0); assert.equal(f.b.position.x, 5);
    f.runtime.clearEntityArrayPreview();
    assert.equal(f.scene.meshes.length, 2); assert.equal(f.a.geometry, geometry); assert.equal(f.a.getTotalVertices(), 24);
  } finally { f.dispose(); }
});

test('signed net spacing preserves positive, zero and reverse preview steps for ordinary and composition sources', () => {
  const f = fixture();
  try {
    const cases = [
      { sourceId: 'a', spacing: -1, expected: [1, 2] },
      { sourceId: 'a', spacing: -2, expected: [0, 0] },
      { sourceId: 'a', spacing: -3, expected: [-2, -1] },
      { sourceId: 'group', spacing: -2, expected: [6, 11, 12, 17] },
      { sourceId: 'group', spacing: -8, expected: [0, 0, 5, 5] },
      { sourceId: 'group', spacing: -10, expected: [-4, -2, 1, 3] },
    ];
    for (const { sourceId, spacing, expected } of cases) {
      assert.equal(f.runtime.updateEntityArrayPreview(sourceId, { x: 1, y: 0, z: 0 }, 2, spacing), true, `${sourceId}: ${spacing}`);
      const placements = f.scene.meshes.filter(mesh => mesh !== f.a && mesh !== f.b)
        .flatMap(mesh => mesh.thinInstanceCount > 0
          ? mesh.thinInstanceGetWorldMatrices().map(matrix => matrix.getTranslation().x)
          : [mesh.getAbsolutePosition().x])
        .sort((a, b) => a - b);
      assert.deepEqual(placements, expected, `${sourceId}: ${spacing}`);
      assert.equal(f.a.position.x, 0);
      assert.equal(f.b.position.x, 5);
      f.runtime.clearEntityArrayPreview();
      assert.equal(f.scene.meshes.length, 2);
    }
  } finally { f.dispose(); }
});

test('composition includes existing matrix model instance at its own world transform', () => {
  const f = fixture();
  try {
    f.runtime.presentation.meshes.delete('b'); f.b.dispose();
    const sourceRoot = new TransformNode('source', f.scene);
    const contentRoot = new TransformNode('content', f.scene); contentRoot.parent = sourceRoot;
    const mesh = MeshBuilder.CreateBox('model', { width: 4, height: 2, depth: 2 }, f.scene); mesh.parent = contentRoot;
    f.entities.b.components = { transform: f.transform(5), modelAsset: {}, modelArrayInstance: { sourceEntityId: 'outside' } };
    f.entities.outside = { id: 'outside', name: 'outside', parentId: null, childrenIds: [], components: { transform: f.transform(), modelAsset: {} } };
    f.runtime.arrays.modelArrayInstanceEntities.set('b', f.entities.b);
    f.runtime.assets.models.set('outside', { root: sourceRoot, contentRoot, meshes: [mesh], assetHandle: {}, measurementReady: true, modelArraySuspendedMeshes: new Set() });
    assert.equal(f.runtime.getEntityArrayGeometry('group', { x: 1, y: 0, z: 0 })?.spanMeters, 8);
    assert.equal(f.runtime.updateEntityArrayPreview('group', { x: -1, y: 0, z: 0 }, 1, 0), true);
    const batch = f.scene.meshes.find(m => m !== f.a && m !== mesh && m.thinInstanceCount > 0 && m.thinInstanceGetWorldMatrices()[0].getTranslation().x === -3);
    assert.ok(batch);
  } finally { f.dispose(); }
});

test('bound locator fill and wire frame participate in preview without releasing shared materials', () => {
  const f = fixture();
  try {
    const root = new TransformNode('locator', f.scene);
    const fillMesh = MeshBuilder.CreateBox('fill', {}, f.scene); fillMesh.parent = root;
    const edgeLines = MeshBuilder.CreateLines('edge', { points: [new Vector3(-1, 0, 0), new Vector3(1, 0, 0)] }, f.scene); edgeLines.parent = root;
    f.entities.group.childrenIds.push('locator');
    f.entities.locator = { id: 'locator', name: 'locator', parentId: 'group', childrenIds: [], components: { transform: f.transform(), locator: {} } };
    f.runtime.document.shadowDocument.entityIds.push('locator');
    f.runtime.locators.locators.set('locator', { root, fillMesh, edgeLines });
    const material = edgeLines.material;
    assert.equal(f.runtime.updateEntityArrayPreview('group', { x: 1, y: 0, z: 0 }, 1, 0), true);
    assert.equal(f.scene.meshes.filter(m => m.thinInstanceCount > 0).length, 4);
    f.runtime.clearEntityArrayPreview(); assert.equal(edgeLines.material, material); assert.equal(edgeLines.isDisposed(), false);
  } finally { f.dispose(); }
});

test('composition gizmo Shift starts an array session and preserves group source', () => {
  const engine = new NullEngine(), scene = new Scene(engine), target = new TransformNode('group', scene);
  const controller = Object.create(TransformGizmoController.prototype);
  let context;
  Object.assign(controller, { scene, attachedTarget: target, attachedEntityId: null, attachedGroupId: 'group', attachedEntityArraySourceId: 'group', transformSpace: 'global', callbacks: { beginEntityArrayDrag: value => { context = value; return { spanMeters: 8 }; } }, gizmoManager: { gizmos: {} }, attachGizmo() {}, blockCanvasSelectionBriefly() {} });
  try {
    controller.beginEntityArrayDrag('x', {});
    assert.equal(context?.entityId, 'group'); assert.deepEqual(context?.positiveDirection, { x: 1, y: 0, z: 0 });
    controller.entityArrayDragSession?.proxyTarget.dispose(); assert.equal(target.position.x, 0);
    assert.equal(controller.activeTransformDrag, false);
  } finally { scene.dispose(); engine.dispose(); }
});
