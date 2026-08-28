import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AssetContainer,
  MeshBuilder,
  NullEngine,
  Scene,
  StandardMaterial,
} from '@babylonjs/core';

import { EnvironmentAssetContainerCache } from '../../src/runtime/babylon/environmentAssetContainerCache.ts';

function createBoxContainer(scene: Scene, name: string): AssetContainer {
  const container = new AssetContainer(scene);
  const mesh = MeshBuilder.CreateBox(name, { width: 4, height: 2, depth: 3 }, scene);
  const material = new StandardMaterial(`${name}-material`, scene);
  mesh.material = material;
  scene.removeMesh(mesh);
  scene.removeMaterial(material);
  container.meshes.push(mesh);
  container.materials.push(material);
  container.rootNodes.push(mesh);
  return container;
}

test('同源环境只解析一次，工作副本互不影响且释放时保留源容器', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const cache = new EnvironmentAssetContainerCache();
  let loadCount = 0;

  try {
    const first = await cache.acquireWorkingContainer({
      cacheKey: 'editor-asset://local/factory.glb',
      scene,
      loadSource: async () => {
        loadCount += 1;
        return createBoxContainer(scene, 'factory-source');
      },
    });
    const second = await cache.acquireWorkingContainer({
      cacheKey: 'editor-asset://local/factory.glb',
      scene,
      loadSource: async () => {
        loadCount += 1;
        return createBoxContainer(scene, 'factory-source-again');
      },
    });

    assert.equal(loadCount, 1);
    assert.notEqual(first, second);
    const firstMesh = first.meshes[0];
    const secondMesh = second.meshes[0];
    assert.ok(firstMesh);
    assert.ok(secondMesh);
    assert.equal(firstMesh.isDisposed(), false);
    assert.equal(secondMesh.isDisposed(), false);
    assert.notEqual(firstMesh, secondMesh);

    const firstMaterial = firstMesh.material as StandardMaterial;
    firstMaterial.alpha = 0.2;
    const secondMaterial = secondMesh.material as StandardMaterial;
    assert.equal(secondMaterial.alpha, 1);

    first.dispose();
    assert.equal(firstMesh.isDisposed(), true);
    assert.equal(secondMesh.isDisposed(), false);

    second.dispose();
    const third = await cache.acquireWorkingContainer({
      cacheKey: 'editor-asset://local/factory.glb',
      scene,
      loadSource: async () => {
        loadCount += 1;
        return createBoxContainer(scene, 'should-not-reload');
      },
    });
    assert.equal(loadCount, 1);
    assert.equal(third.meshes[0].isDisposed(), false);
    third.dispose();
  } finally {
    cache.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test('源加载失败后允许按同一键重新加载', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const cache = new EnvironmentAssetContainerCache();
  let loadCount = 0;

  try {
    await assert.rejects(
      cache.acquireWorkingContainer({
        cacheKey: 'editor-asset://local/broken.glb',
        scene,
        loadSource: async () => {
          loadCount += 1;
          throw new Error('第一次解析失败');
        },
      }),
      /第一次解析失败/,
    );

    const recovered = await cache.acquireWorkingContainer({
      cacheKey: 'editor-asset://local/broken.glb',
      scene,
      loadSource: async () => {
        loadCount += 1;
        return createBoxContainer(scene, 'recovered');
      },
    });
    assert.equal(loadCount, 2);
    assert.equal(recovered.meshes.length, 1);
    recovered.dispose();
  } finally {
    cache.dispose();
    scene.dispose();
    engine.dispose();
  }
});
