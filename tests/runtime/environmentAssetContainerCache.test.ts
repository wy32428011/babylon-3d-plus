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

test('环境克隆阶段记录真实工作副本与失败，加载失败不计入克隆', async () => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  const cache = new EnvironmentAssetContainerCache();
  const observations: { duration: number; failed: boolean }[] = [];
  const onClone = (duration: number, failed: boolean) => { observations.push({ duration, failed }); };
  try {
    const copy = await cache.acquireWorkingContainer({ cacheKey: 'good', scene,
      loadSource: async () => createBoxContainer(scene, 'factory'), onClone });
    assert.equal(copy.meshes.length, 1);
    assert.equal(copy.meshes[0].isDisposed(), false);
    assert.equal(observations[0].failed, false);
    assert.ok(observations[0].duration >= 0);
    copy.dispose();
    await assert.rejects(cache.acquireWorkingContainer({ cacheKey: 'empty', scene,
      loadSource: async () => new AssetContainer(scene), onClone }), /没有可渲染网格/);
    assert.equal(observations[1].failed, true);
    await assert.rejects(cache.acquireWorkingContainer({ cacheKey: 'read-failure', scene,
      loadSource: async () => { throw new Error('read failure'); }, onClone }), /read failure/);
    assert.equal(observations.length, 2);
    assert.equal(cache.getMetrics().cloneCount, 1);
  } finally { cache.dispose(); scene.dispose(); engine.dispose(); }
});
