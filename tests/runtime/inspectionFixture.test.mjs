import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { LoadAssetContainerAsync, NullEngine, Scene } from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';

test('分件 GLB 夹具保留零件身份、装配层级、非均匀缩放和零件动画', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const source = await readFile(new URL('../fixtures/inspection/assembly-animation.glb', import.meta.url));
    const container = await LoadAssetContainerAsync(new Uint8Array(source), scene, {
      pluginExtension: '.glb',
      pluginOptions: { gltf: { animationStartMode: 0 } },
    });
    const nodes = [...container.transformNodes, ...container.meshes];
    const parts = new Map(nodes.filter((node) => node.metadata?.gltf?.extras?.partKey)
      .map((node) => [node.metadata.gltf.extras.partKey, node]));
    assert.deepEqual([...parts.keys()].sort(), ['assembly.base', 'drive', 'drive.guard', 'drive.motor']);
    assert.equal(parts.get('drive.motor').parent, parts.get('drive'));
    const root = nodes.find((node) => node.name === 'AssemblyRoot');
    assert.ok(root);
    assert.notEqual(root.scaling.x, root.scaling.y);
    assert.notEqual(root.scaling.y, root.scaling.z);
    assert.ok(root.rotationQuaternion);
    assert.ok(container.animationGroups.some((group) => group.targetedAnimations.some(
      ({ target, animation }) => target === parts.get('drive.motor') && animation.targetProperty === 'position',
    )));
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
