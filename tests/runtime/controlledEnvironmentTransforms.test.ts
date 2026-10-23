import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionManager, Animation, AnimationGroup, AssetContainer, MeshBuilder, MorphTargetManager, NullEngine, Scene, Skeleton, TransformNode, Vector3 } from '@babylonjs/core';
import { ControlledEnvironmentTransforms } from '../../src/runtime/babylon/ControlledEnvironmentTransforms.ts';

test('静态环境只冻结叶网格，父级更新后解冻重算，连续读取不重复求值', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const root = new TransformNode('environment', scene);
    root.position.set(5, 2, -3);
    root.rotation.y = 0.5;
    const parent = MeshBuilder.CreateBox('parent', { size: 1 }, scene);
    parent.parent = root;
    const leaves = Array.from({ length: 100 }, (_, index) => {
      const mesh = MeshBuilder.CreateBox(`leaf-${index}`, { size: 1 }, scene);
      mesh.position.x = index;
      mesh.parent = parent;
      return mesh;
    });
    const container = new AssetContainer(scene);
    container.meshes.push(parent, ...leaves);
    const controlled = new ControlledEnvironmentTransforms(container);
    let preparationUpdates = 0;
    for (const node of [root, parent, ...leaves]) node.onAfterWorldMatrixUpdateObservable.add(() => preparationUpdates++);
    controlled.freeze();
    assert.equal(preparationUpdates, 102, '首次准备父链和叶网格各求值一次');
    assert.equal(root.isWorldMatrixFrozen, false);
    assert.equal(parent.isWorldMatrixFrozen, false);
    assert.ok(leaves.every(mesh => mesh.isWorldMatrixFrozen));
    let updates = 0;
    for (const mesh of leaves) mesh.onAfterWorldMatrixUpdateObservable.add(() => updates++);
    for (let frame = 0; frame < 100; frame++) {
      scene.incrementRenderId();
      leaves.forEach(mesh => mesh.computeWorldMatrix());
    }
    assert.equal(updates, 0, '100 帧共 10000 次读取无叶网格矩阵重新计算');
    controlled.unfreeze();
    root.position.x += 9;
    parent.rotation.z = 0.2;
    const expected = leaves.map(mesh => Array.from(mesh.computeWorldMatrix(true).m));
    controlled.freeze();
    leaves.forEach((mesh, index) => assert.deepEqual(Array.from(mesh.getWorldMatrix().m), expected[index]));
    assert.equal(Vector3.TransformCoordinates(Vector3.Zero(), leaves[0].getWorldMatrix()).x, 14);
    controlled.unfreeze();
    assert.ok(leaves.every(mesh => !mesh.isWorldMatrixFrozen));
  } finally { scene.dispose(); engine.dispose(); }
});

test('动画目标、动态祖先、action、蒙皮、Morph、billboard 均保留动态矩阵', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const container = new AssetContainer(scene);
    const animatedParent = new TransformNode('animated-parent', scene);
    const animatedChild = MeshBuilder.CreateBox('animated-child', {}, scene);
    animatedChild.parent = animatedParent;
    const animation = new Animation('move', 'position.x', 30, Animation.ANIMATIONTYPE_FLOAT);
    animation.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: 1 }]);
    const group = new AnimationGroup('imported-animation', scene);
    group.addTargetedAnimation(animation, animatedParent);
    container.animationGroups.push(group);
    const directAnimation = MeshBuilder.CreateBox('direct-animation', {}, scene);
    directAnimation.animations.push(animation);
    const action = MeshBuilder.CreateBox('action', {}, scene);
    action.actionManager = new ActionManager(scene);
    const skin = MeshBuilder.CreateBox('skin', {}, scene);
    skin.skeleton = new Skeleton('bones', 'bones', scene);
    const morph = MeshBuilder.CreateBox('morph', {}, scene);
    morph.morphTargetManager = new MorphTargetManager(scene);
    const billboard = MeshBuilder.CreateBox('billboard', {}, scene);
    billboard.billboardMode = TransformNode.BILLBOARDMODE_ALL;
    const dynamicParent = new TransformNode('dynamic-parent', scene);
    dynamicParent.metadata = { runtimeDynamic: true };
    const dynamicChild = MeshBuilder.CreateBox('dynamic-child', {}, scene);
    dynamicChild.parent = dynamicParent;
    const staticLeaf = MeshBuilder.CreateBox('static', {}, scene);
    container.meshes.push(animatedChild, directAnimation, action, skin, morph, billboard, dynamicChild, staticLeaf);
    const controlled = new ControlledEnvironmentTransforms(container);
    controlled.freeze();
    assert.ok(container.meshes.slice(0, -1).every(mesh => !mesh.isWorldMatrixFrozen));
    assert.equal(staticLeaf.isWorldMatrixFrozen, true);
    animatedParent.position.x = 6;
    assert.equal(animatedChild.computeWorldMatrix(true).getTranslation().x, 6);
    controlled.unfreeze();
    staticLeaf.dispose();
    controlled.freeze();
    controlled.unfreeze();
  } finally { scene.dispose(); engine.dispose(); }
});
