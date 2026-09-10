import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh, NullEngine, Scene, TransformNode } from '@babylonjs/core';
import { freezeEnvironmentTransforms } from '../../src/runtime/babylon/environmentTransformPreparation.ts';

test('环境按父子顺序各计算一次矩阵，深层网格保持位姿且可重新调整', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const root = new TransformNode('environment', scene);
    root.position.set(3, 4, -5);
    root.rotation.set(0.2, 0.3, 0.4);
    root.scaling.set(1.2, 2, -0.7);
    const parents: TransformNode[] = [root];
    for (let depth = 1; depth < 20; depth++) {
      const parent = new TransformNode(`level-${depth}`, scene);
      parent.parent = parents.at(-1)!;
      parent.position.set(depth / 10, 0.1, -0.2);
      parent.rotation.y = 0.02;
      parents.push(parent);
    }
    const meshes = Array.from({ length: 100 }, (_, index) => {
      const mesh = new Mesh(`part-${index}`, scene);
      mesh.parent = parents.at(-1)!;
      mesh.position.x = index;
      return mesh;
    });
    const nodes = [root, ...meshes, ...parents.slice(1)];
    const expected = nodes.map(node => Array.from(node.computeWorldMatrix(true).m));
    let matrixUpdates = 0;
    for (const node of nodes) node.onAfterWorldMatrixUpdateObservable.add(() => { matrixUpdates++; });
    freezeEnvironmentTransforms(nodes);
    assert.equal(matrixUpdates, nodes.length, '每个静态节点只应完成一次矩阵计算');
    nodes.forEach((node, index) => {
      assert.equal(node.isWorldMatrixFrozen, true);
      assert.deepEqual(Array.from(node.getWorldMatrix().m), expected[index]);
    });

    for (const node of nodes) node.unfreezeWorldMatrix();
    root.position.x += 7;
    const adjusted = nodes.map(node => Array.from(node.computeWorldMatrix(true).m));
    matrixUpdates = 0;
    freezeEnvironmentTransforms([...nodes, root]);
    assert.equal(matrixUpdates, nodes.length, '重复节点不会重复冻结');
    nodes.forEach((node, index) => assert.deepEqual(Array.from(node.getWorldMatrix().m), adjusted[index]));
  } finally { scene.dispose(); engine.dispose(); }
});

test('环境冻结忽略已释放节点，并不冻结清单外的祖先', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const external = new TransformNode('external', scene);
    external.position.x = 9;
    const child = new TransformNode('child', scene);
    child.parent = external;
    child.position.x = 4;
    const disposed = new TransformNode('disposed', scene);
    disposed.dispose();
    freezeEnvironmentTransforms([child, disposed]);
    assert.equal(external.isWorldMatrixFrozen, false);
    assert.equal(child.isWorldMatrixFrozen, true);
    assert.equal(child.getAbsolutePosition().x, 13);
    freezeEnvironmentTransforms([]);
  } finally { scene.dispose(); engine.dispose(); }
});
