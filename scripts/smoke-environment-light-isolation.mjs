import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const outputDir = path.resolve('output/playwright/environment-light-isolation');
const harness = `
import {
  AssetContainer, Color3, Engine, FreeCamera, MeshBuilder, PBRMaterial,
  Scene, StandardMaterial, Vector3, PointLight, DirectionalLight, HemisphericLight,
} from '@babylonjs/core';
import { SceneEnvironmentRuntime } from '/src/runtime/babylon/SceneEnvironmentRuntime.ts';
import { SceneShadowRuntime } from '/src/runtime/babylon/SceneShadowRuntime.ts';
import { DEFAULT_SCENE_SHADOW_SETTINGS } from '/src/editor/model/SceneDocument.ts';

const engine = new Engine(document.querySelector('canvas'), false, { preserveDrawingBuffer: true, stencil: true });
window.checkEnvironment = async (materialKind) => {
  const scene = new Scene(engine);
  scene.clearColor.set(0.1, 0.2, 0.3, 1);
  const camera = new FreeCamera('camera', new Vector3(0, 0, -8), scene);
  const initialLight = new HemisphericLight('initial', new Vector3(0, 0, -1), scene);
  initialLight.groundColor = Color3.White();
  const shadows = new SceneShadowRuntime(scene);
  // 原色隔离在关闭阴影时验证；开启后的遮挡变化由 smoke-environment-shadows 验证。
  shadows.applySettings({ ...DEFAULT_SCENE_SHADOW_SETTINGS, enabled: false });
  const container = new AssetContainer(scene);
  const mesh = MeshBuilder.CreateBox('environment', { size: 2 }, scene);
  const material = materialKind === 'pbr'
    ? new PBRMaterial('environment-material', scene)
    : new StandardMaterial('environment-material', scene);
  if (materialKind === 'pbr') material.albedoColor = new Color3(0.8, 0.4, 0.2);
  else material.diffuseColor = new Color3(0.8, 0.4, 0.2);
  mesh.material = material;
  container.meshes.push(mesh);
  container.materials.push(material);
  container.rootNodes.push(mesh);
  container.removeAllFromScene();
  let loadCount = 0;
  const runtime = new SceneEnvironmentRuntime(scene, {
    loadAssetContainer: async () => { loadCount += 1; return container; },
    resolveAssetUrl: (url) => url,
  });
  const environment = {
    packagePath: 'C:/fixture/environment', lengthUnit: 'meter', unitScaleToMeters: 1,
    placementMode: 'scene-base', visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 },
    activeVariantUrl: 'editor-asset://local/environment.glb',
    variants: [{ name: 'environment', sourcePath: 'C:/fixture/environment.glb', sourceUrl: 'editor-asset://local/environment.glb' }],
  };
  const results = [];
  const capture = async (label) => {
    // 材质热切换可能异步编译；等待真实渲染帧后采样，避免只验证显隐字段。
    for (let frame = 0; frame < 20; frame += 1) {
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const pixel = Array.from(await engine.readPixels(128, 128, 1, 1));
    results.push({ label, pixel, enabled: mesh.isEnabled(), visible: mesh.isVisible, ready: material.isReadyForSubMesh(mesh, mesh.subMeshes[0]) });
  };
  try {
    const applied = await runtime.apply(environment, { requestId: 'initial', autoAlign: false });
    const center = applied.snapshot.bounds.center;
    camera.position.set(center.x, center.y, center.z - 8);
    camera.setTarget(new Vector3(center.x, center.y, center.z));
    await capture('initial');
    initialLight.intensity = 0;
    await capture('intensity-zero');
    initialLight.setEnabled(false);
    await capture('light-hidden');
    initialLight.dispose();
    await capture('light-deleted');
    for (const kind of ['point', 'directional', 'hemispheric']) {
      const light = kind === 'point'
        ? new PointLight(kind, new Vector3(center.x, center.y + 4, center.z - 4), scene)
        : kind === 'directional'
          ? new DirectionalLight(kind, new Vector3(0, -1, 1), scene)
          : new HemisphericLight(kind, new Vector3(0, 0, -1), scene);
      light.intensity = 5;
      shadows.syncLight(kind, light);
      await capture(kind + '-created');
      if (kind === 'point') light.position.set(center.x + 10, center.y, center.z + 4);
      else light.direction.set(1, 0, 0);
      shadows.syncLight(kind, light);
      await capture(kind + '-transformed');
      light.setEnabled(false);
      shadows.syncLight(kind, light);
      await capture(kind + '-hidden');
      shadows.removeLight(kind);
      light.dispose();
      await capture(kind + '-deleted');
    }
    await runtime.apply({ ...environment, visible: false }, { requestId: null, autoAlign: false });
    await capture('environment-hidden');
    await runtime.apply({ ...environment, opacity: 0.4 }, { requestId: null, autoAlign: false });
    await capture('environment-transparent');
    await runtime.apply(environment, { requestId: null, autoAlign: false });
    await capture('environment-restored');
    return { results, loadCount };
  } finally {
    runtime.dispose();
    shadows.dispose();
    scene.dispose();
  }
};
window.disposeFixture = () => engine.dispose();
`;

await mkdir(outputDir, { recursive: true });
const server = await createServer({
  configFile: false,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{
    name: 'environment-light-isolation-fixture',
    resolveId(id) { if (id === '/__environment_light__.js') return '\0environment-light'; },
    load(id) { if (id === '\0environment-light') return harness; },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/__environment_light__') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><canvas width="256" height="256"></canvas><script type="module" src="/__environment_light__.js"></script>');
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
  page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + '__environment_light__', { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.checkEnvironment === 'function', null, { timeout: 180_000 });
  for (const kind of ['pbr', 'standard']) {
    const { results, loadCount } = await page.evaluate(kind => window.checkEnvironment(kind), kind);
    const baseline = results[0].pixel;
    assert.ok(baseline[0] > 60 && baseline[0] > baseline[1], `${kind}: 环境原始颜色必须实际渲染`);
    for (const result of results.filter(result => !['environment-hidden', 'environment-transparent'].includes(result.label))) {
      assert.equal(result.enabled, true, `${kind}/${result.label}: 环境必须保持启用`);
      assert.equal(result.visible, true, `${kind}/${result.label}: 环境必须保持可见`);
      assert.equal(result.ready, true, `${kind}/${result.label}: 环境材质必须保持可渲染`);
      assert.deepEqual(result.pixel, baseline, `${kind}/${result.label}: 光源编辑不得改变环境表面`);
    }
    const hidden = results.find(result => result.label === 'environment-hidden');
    const transparent = results.find(result => result.label === 'environment-transparent');
    assert.equal(hidden.enabled, false, '环境自己的隐藏设置必须生效');
    assert.notDeepEqual(hidden.pixel, baseline, '隐藏环境后必须实际露出背景');
    assert.notDeepEqual(transparent.pixel, baseline, '环境自己的透明度必须生效');
    assert.notDeepEqual(transparent.pixel, hidden.pixel, '半透明环境仍应可见');
    assert.equal(loadCount, 1, '编辑光源和环境显示属性不得重载环境资源');
    console.log(`${kind}: ${results.length} 个渲染状态通过，环境资源仅加载一次。`);
  }
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.disposeFixture());
} catch (error) {
  if (page) await page.screenshot({ path: path.join(outputDir, 'failure.png') });
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
