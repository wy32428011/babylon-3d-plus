import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh, NullEngine, Scene, TransformNode } from '@babylonjs/core';
import { getModelTransformNodes } from '../../src/runtime/babylon/runtimeNodeGeometry.ts';

test('模型节点查询只访问自身子树，并保留子节点顺序与临时脱离场景的节点', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const root = new TransformNode('model', scene);
    const contentRoot = new TransformNode('content', scene);
    contentRoot.parent = root;
    const mesh = new Mesh('mesh', scene);
    mesh.parent = contentRoot;
    const generated = new TransformNode('script-generated', scene);
    generated.parent = mesh;
    const attached = new Mesh('attached-slot', scene);
    attached.parent = root;
    const detached = new Mesh('removed-from-scene', scene);
    detached.parent = generated;
    scene.removeMesh(detached);
    const model = { root, contentRoot, meshes: [mesh, detached, mesh] };
    const expected = [contentRoot, mesh, generated, detached, attached];
    let unrelatedChecks = 0;
    for (let index = 0; index < 1_000; index++) {
      const unrelated = new TransformNode(`other-${index}`, scene);
      const original = unrelated.isDescendantOf.bind(unrelated);
      unrelated.isDescendantOf = (ancestor) => { unrelatedChecks++; return original(ancestor); };
    }
    assert.deepEqual(getModelTransformNodes(model, scene), expected);
    assert.equal(unrelatedChecks, 0, '加载单个模型不应对其它模型逐一查询祖先关系');

    const added = new TransformNode('new-script-node', scene);
    added.parent = generated;
    assert.deepEqual(getModelTransformNodes(model, scene), [contentRoot, mesh, generated, detached, added, attached]);
    attached.parent = null;
    detached.dispose();
    assert.deepEqual(getModelTransformNodes(model, scene), [contentRoot, mesh, generated, added]);
    contentRoot.parent = null;
    assert.deepEqual(getModelTransformNodes(model, scene), [], '已移出模型的子树不能因旧 meshes 快照继续被查询到');
    attached.parent = root;
    assert.deepEqual(getModelTransformNodes({ root, contentRoot: root, meshes: [root, attached] }, scene), [attached]);
  } finally { scene.dispose(); engine.dispose(); }
});
