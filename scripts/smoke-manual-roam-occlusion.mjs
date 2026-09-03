import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const outputDir = path.resolve('output/playwright/manual-roam-occlusion');
const moduleId = '\0manual-roam-occlusion.js';
const harness = `
import { AssetContainer, Camera, Color3, Engine, FreeCamera, HemisphericLight, MeshBuilder, Scene, SceneLoader, StandardMaterial, Vector3 } from '@babylonjs/core';
import { EditorManualRoamSpawnRuntime } from '/src/runtime/babylon/EditorManualRoamSpawnRuntime.ts';
import { createManualRoamSpawnEntity } from '/src/editor/model/SceneDocument.ts';

const canvas = document.querySelector('canvas');
const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
const originalLoader = SceneLoader.LoadAssetContainerAsync;
let scene;
let runtime;
window.checkOcclusion = async (mode, selected) => {
  runtime?.dispose();
  scene?.dispose();
  scene = new Scene(engine);
  scene.clearColor.set(0.05, 0.05, 0.05, 1);
  const camera = new FreeCamera('camera', new Vector3(0, 0.85, -6), scene);
  camera.setTarget(new Vector3(0, 0.85, 0));
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -1.5; camera.orthoRight = 1.5;
  camera.orthoTop = 1.5; camera.orthoBottom = -1.5;
  new HemisphericLight('light', Vector3.Up(), scene);
  const wall = MeshBuilder.CreateBox('wall', { width: 4, height: 4, depth: 0.2 }, scene);
  wall.position.set(0, 0.85, -1);
  // 锁定、不可拾取的场景模型也必须正常遮挡人物。
  wall.isPickable = false;
  const wallMaterial = new StandardMaterial('wall-material', scene);
  wallMaterial.disableLighting = true;
  wallMaterial.emissiveColor = Color3.FromHexString('#3050c0');
  wall.material = wallMaterial;
  let finishLoading;
  const loaded = new Promise(resolve => { finishLoading = resolve; });
  SceneLoader.LoadAssetContainerAsync = async (...args) => {
    try {
      if (mode === 'placeholder') throw new Error('测试人物加载失败时的占位模型');
      if (mode === 'custom') {
        const container = new AssetContainer(scene);
        const mesh = MeshBuilder.CreateBox('custom-avatar', { width: 0.5, height: 1.7, depth: 0.3 }, scene);
        mesh.position.y = 0.85;
        container.meshes.push(mesh);
        container.rootNodes.push(mesh);
        container.removeAllFromScene();
        return container;
      }
      return await originalLoader.apply(SceneLoader, args);
    } finally {
      finishLoading();
    }
  };
  runtime = new EditorManualRoamSpawnRuntime(scene);
  const spawn = createManualRoamSpawnEntity();
  if (mode === 'custom') spawn.components.manualRoamSpawn = { avatar: { name: 'custom', sourcePath: 'custom.glb', sourceUrl: new URL('/custom.glb', location.href).href } };
  runtime.sync(spawn, selected, true, true);
  await loaded;
  await new Promise(resolve => setTimeout(resolve, 0));
  SceneLoader.LoadAssetContainerAsync = originalLoader;
  await scene.whenReadyAsync();
  const root = runtime.getTransformTarget(spawn.id);
  const capture = async () => {
    scene.render();
    return new Uint8Array(await engine.readPixels(0, 0, engine.getRenderWidth(), engine.getRenderHeight()));
  };
  const visiblePixels = async () => {
    root.setEnabled(false);
    const hidden = await capture();
    root.setEnabled(true);
    const shown = await capture();
    let count = 0;
    for (let i = 0; i < shown.length; i += 4) {
      if (Math.abs(shown[i] - hidden[i]) + Math.abs(shown[i + 1] - hidden[i + 1]) + Math.abs(shown[i + 2] - hidden[i + 2]) > 12) count++;
    }
    return count;
  };
  wall.setEnabled(false);
  const unobstructed = await visiblePixels();
  wall.setEnabled(true);
  const full = await visiblePixels();
  wall.scaling.x = 0.03;
  const partial = await visiblePixels();
  wall.scaling.x = 1;
  wall.position.z = 1;
  const behind = await visiblePixels();
  wall.position.z = -1;
  await capture();
  return { unobstructed, full, partial, behind };
};
window.disposeFixture = () => { runtime?.dispose(); scene?.dispose(); engine.dispose(); };
`;

await mkdir(outputDir, { recursive: true });
const server = await createServer({
  configFile: false,
  cacheDir: path.join(outputDir, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{
    name: 'manual-roam-occlusion-fixture',
    resolveId(id) { if (id === '/__manual_roam_occlusion__.js') return moduleId; },
    load(id) { if (id === moduleId) return harness; },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/__manual_roam_occlusion__') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body style="margin:0"><canvas width="512" height="512"></canvas><script type="module" src="/__manual_roam_occlusion__.js"></script></body></html>');
      });
    },
  }],
});

let browser;
let page;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  page.on('pageerror', error => errors.push(error.message));
  console.log('Loading manual-roam WebGL fixture');
  await page.goto(server.resolvedUrls.local[0] + '__manual_roam_occlusion__', { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.checkOcclusion === 'function', null, { timeout: 60_000 });
  for (const mode of ['default', 'custom', 'placeholder']) {
    for (const selected of [false, true]) {
      const result = await page.evaluate(({ mode, selected }) => window.checkOcclusion(mode, selected), { mode, selected });
      console.log(JSON.stringify({ mode, selected, ...result }));
      assert.ok(result.unobstructed > 100, `${mode}: 无遮挡时应显示人物`);
      assert.equal(result.full, 0, `${mode}: 不透明墙体应完全遮挡人物及出生点标记`);
      assert.ok(result.partial > 0 && result.partial < result.unobstructed, `${mode}: 窄墙应仅遮挡人物的一部分`);
      assert.ok(result.behind > 100, `${mode}: 人物后方的墙体不能遮挡人物`);
    }
  }
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.disposeFixture());
  console.log('PASS: 默认人物、自定义人物、失败占位模型在选中和未选中时均遵循场景遮挡。');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(outputDir, 'failure.png') });
  console.error(errors);
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
