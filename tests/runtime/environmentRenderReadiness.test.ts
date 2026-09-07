import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

import {
  AssetContainer,
  MeshBuilder,
  NullEngine,
  Scene,
  StandardMaterial,
} from '@babylonjs/core';

import type { SceneEnvironmentSettings } from '../../src/editor/model/SceneDocument.ts';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
const { SceneEnvironmentRuntime } = await viteServer.ssrLoadModule(
  '/src/runtime/babylon/SceneEnvironmentRuntime.ts',
) as typeof import('../../src/runtime/babylon/SceneEnvironmentRuntime.ts');

after(async () => {
  await viteServer.close();
});

function createEnvironment(): SceneEnvironmentSettings {
  return {
    packagePath: 'C:/project/Assets/Environments/factory',
    lengthUnit: 'meter',
    unitScaleToMeters: 1,
    displayName: '园区环境',
    fileSizeBytes: 1024,
    placementMode: 'scene-base',
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: 1,
    },
    visible: true,
    opacity: 1,
    activeVariantUrl: 'editor-asset://local/factory.glb',
    variants: [{
      name: '默认预设',
      sourcePath: 'C:/project/Assets/Environments/factory/factory.glb',
      sourceUrl: 'editor-asset://local/factory.glb',
    }],
  };
}

function createEnvironmentContainer(scene: Scene): AssetContainer {
  const container = new AssetContainer(scene);
  const mesh = MeshBuilder.CreateBox('factory', { size: 2 }, scene);
  const material = new StandardMaterial('factory-material', scene);
  mesh.material = material;
  scene.removeMesh(mesh);
  scene.removeMaterial(material);
  container.meshes.push(mesh);
  container.materials.push(material);
  container.rootNodes.push(mesh);
  return container;
}

test('环境已经加入场景但首个可渲染帧尚未完成时保持 loading', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const snapshots: string[] = [];
  let releaseRenderReady: (() => void) | null = null;
  let renderReadyWaitStarted = false;
  const renderReady = new Promise<void>((resolve) => {
    releaseRenderReady = resolve;
  });
  const runtime = new SceneEnvironmentRuntime(scene, {
    loadAssetContainer: async () => createEnvironmentContainer(scene),
    resolveAssetUrl: (sourceUrl) => sourceUrl,
    onSnapshot: (snapshot) => snapshots.push(snapshot.phase),
    waitForRenderReady: async () => {
      renderReadyWaitStarted = true;
      await renderReady;
    },
  });

  try {
    let applySettled = false;
    const applyPromise = runtime.apply(createEnvironment(), { requestId: 'environment-1', autoAlign: false })
      .then((result) => {
        applySettled = true;
        return result;
      });

    for (let index = 0; index < 8 && !renderReadyWaitStarted; index += 1) await Promise.resolve();

    assert.equal(renderReadyWaitStarted, true);
    assert.equal(scene.meshes.some((mesh) => mesh.name === 'factory' && mesh.isEnabled()), true);
    assert.equal(applySettled, false);
    assert.equal(runtime.getSnapshot().phase, 'loading');
    assert.deepEqual(snapshots, ['loading']);

    releaseRenderReady?.();
    const result = await applyPromise;
    assert.equal(result.snapshot.phase, 'ready');
    assert.equal(runtime.getSnapshot().phase, 'ready');
    assert.deepEqual(snapshots, ['loading', 'ready']);
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
  }
});
