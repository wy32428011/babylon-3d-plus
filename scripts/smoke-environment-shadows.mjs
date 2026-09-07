import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const outputDir = path.resolve('output/playwright/environment-shadows');
const harness = `
import {
  AssetContainer, Color3, Engine, FreeCamera, MeshBuilder, PBRMaterial,
  Scene, StandardMaterial, Vector3, HemisphericLight, PointLight, DirectionalLight,
} from '@babylonjs/core';
import { SceneEnvironmentRuntime } from '/src/runtime/babylon/SceneEnvironmentRuntime.ts';
import { SceneShadowRuntime } from '/src/runtime/babylon/SceneShadowRuntime.ts';
import { DEFAULT_SCENE_SHADOW_SETTINGS, createEmptySceneDocument } from '/src/editor/model/SceneDocument.ts';
import { serializeScene, deserializeScene } from '/src/editor/project/SceneSerializer.ts';
const engine = new Engine(document.querySelector('canvas'), false, { preserveDrawingBuffer: true, stencil: true });
window.checkEnvironmentShadows = async (kind) => {
  const scene = new Scene(engine);
  const camera = new FreeCamera('camera', new Vector3(10, 12, -15), scene);
  camera.setTarget(Vector3.Zero());
  new HemisphericLight('EditorLight', Vector3.Up(), scene);
  const shadows = new SceneShadowRuntime(scene);
  const container = new AssetContainer(scene);
  const floor = MeshBuilder.CreateGround('environment-floor', { width: 20, height: 20 }, scene);
  const material = kind === 'pbr' ? new PBRMaterial('floor', scene) : new StandardMaterial('floor', scene);
  if (kind === 'pbr') { material.albedoColor.set(0.6, 0.6, 0.6); material.metallic = 0; material.roughness = 1; }
  else material.diffuseColor.set(0.6, 0.6, 0.6);
  floor.material = material;
  container.meshes.push(floor); container.materials.push(material); container.rootNodes.push(floor);
  container.removeAllFromScene();
  let loadCount = 0;
  const runtime = new SceneEnvironmentRuntime(scene, {
    loadAssetContainer: async () => { loadCount++; return container; }, resolveAssetUrl: url => url,
  });
  const environment = {
    packagePath: 'C:/fixture/environment', lengthUnit: 'meter', unitScaleToMeters: 1,
    placementMode: 'scene-base', visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 },
    activeVariantUrl: 'editor-asset://local/environment.glb',
    variants: [{ name: 'environment', sourcePath: 'C:/fixture/environment.glb', sourceUrl: 'editor-asset://local/environment.glb' }],
  };
  const capture = async () => {
    for (let frame = 0; frame < 16; frame++) {
      engine.beginFrame(); scene.render(); engine.endFrame();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return Array.from(await engine.readPixels(0, 0, 256, 256));
  };
  // 比较同一帧构图的接收开关，排除灯光增减引起的设备颜色变化。
  const receiving = async (enabled) => {
    const activeMaterial = floor.material;
    const frozen = activeMaterial.isFrozen;
    activeMaterial.unfreeze(); floor.receiveShadows = enabled;
    if (frozen) activeMaterial.freeze();
    activeMaterial.markDirty(true);
    return capture();
  };
  const difference = (off, on) => {
    let darker = 0, brighter = 0, unchanged = 0, darkening = 0;
    for (let i = 0; i < off.length; i += 4) {
      const delta = on[i] - off[i];
      darkening += Math.max(0, -delta);
      if (delta < -3) darker++; else if (delta > 3) brighter++; else unchanged++;
    }
    return { darker, brighter, unchanged, darkening };
  };
  const results = [];
  try {
    await runtime.apply(environment, { requestId: 'initial', autoAlign: false });
    const cube = MeshBuilder.CreateBox('equipment', { size: 2 }, scene); cube.position.y = 1;
    for (const quality of ['performance', 'balanced', 'quality', 'balanced']) {
      const settings = { ...DEFAULT_SCENE_SHADOW_SETTINGS, mode: 'realtime', catcherEnabled: false, sunElevationDegrees: 45, quality };
      shadows.applySettings(settings);
      await runtime.syncShadows(settings);
      const off = await receiving(false), on = await receiving(true);
      console.log('shadow-check', kind, quality, JSON.stringify(difference(off, on)));
      results.push({ label: quality, ...difference(off, on), frozen: material.isFrozen });
      if (quality === 'balanced') {
        window.shadowImage = document.querySelector('canvas').toDataURL('image/png');
        shadows.applySettings({ ...settings, enabled: false });
        await runtime.syncShadows({ ...settings, enabled: false });
        const disabled = await receiving(true);
        const disabledOff = await receiving(false);
        results.push({ label: 'disabled', ...difference(disabledOff, disabled) });
        shadows.applySettings(settings);
        await runtime.syncShadows(settings);
        await receiving(true);
      }
    }
    const settings = { ...DEFAULT_SCENE_SHADOW_SETTINGS, mode: 'realtime', catcherEnabled: false, sunElevationDegrees: 45 };
    shadows.applySettings(settings);
    const baseline = await receiving(false);
    const point = new PointLight('user-point', new Vector3(1, 5, 1), scene); point.intensity = 10;
    shadows.syncLight('point', point);
    const edited = await capture();
    // 地面四角不被设备遮挡，编辑灯光不得改变这些位置的环境原色。
    const untouched = [128 + 70 * 256, 60 + 100 * 256, 190 + 100 * 256];
    const stableColor = untouched.every(pixel => baseline.slice(pixel * 4, pixel * 4 + 3).every((v, i) => v === edited[pixel * 4 + i]));
    point.dispose(); shadows.removeLight('point');
    const sun = new DirectionalLight('user-sun', new Vector3(-1, -2, -1), scene);
    sun.position.set(10, 20, 10); shadows.syncLight('sun', sun);
    results.push({ label: 'replacement-sun', ...difference(await receiving(false), await receiving(true)) });
    shadows.removeLight('sun'); sun.dispose();
    results.push({ label: 'fallback-sun', ...difference(await receiving(false), await receiving(true)) });
    cube.position.x = 3;
    results.push({ label: 'moved-caster', ...difference(await receiving(false), await receiving(true)) });
    const opaque = await receiving(false);
    await runtime.apply({ ...environment, opacity: 0.4 }, { requestId: null, autoAlign: false });
    const transparent = await receiving(false);
    const opacityWorks = untouched.some(pixel => Math.abs(opaque[pixel * 4] - transparent[pixel * 4]) > 3);
    results.push({ label: 'transparent', ...difference(await receiving(false), await receiving(true)) });
    await runtime.apply(environment, { requestId: null, autoAlign: false });
    results.push({ label: 'opacity-restored', ...difference(await receiving(false), await receiving(true)) });
    const sceneDocument = createEmptySceneDocument('shadow-roundtrip');
    sceneDocument.sceneSettings.environment = environment;
    sceneDocument.sceneSettings.shadows = settings;
    const restored = deserializeScene(serializeScene(sceneDocument));
    await runtime.apply(restored.sceneSettings.environment, { requestId: 'restored', autoAlign: false });
    shadows.applySettings(restored.sceneSettings.shadows);
    results.push({ label: 'serialized-settings-restored', ...difference(await receiving(false), await receiving(true)) });
    shadows.applySettings({ ...settings, darkness: 0.8 });
    const weakShadow = difference(await receiving(false), await receiving(true));
    shadows.applySettings({ ...settings, darkness: 0.1 });
    const strongShadow = difference(await receiving(false), await receiving(true));
    const concentrationWorks = strongShadow.darkening > weakShadow.darkening * 2;
    return { results, stableColor, opacityWorks, concentrationWorks, loadCount, unlit: material.unlit, disableLighting: material.disableLighting };
  } finally { runtime.dispose(); shadows.dispose(); scene.dispose(); }
};
window.disposeFixture = () => engine.dispose();
`;

await mkdir(outputDir, { recursive: true });
const server = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: ['@babylonjs/core'] },
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{
    name: 'environment-shadows-fixture',
    resolveId(id) { if (id === '/__environment_shadows__.js') return '\0environment-shadows'; },
    load(id) { if (id === '\0environment-shadows') return harness; },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
        if (request.url !== '/__environment_shadows__') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><canvas width="256" height="256"></canvas><script type="module" src="/__environment_shadows__.js"></script>');
      });
    },
  }],
});
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    else if (message.text().startsWith('shadow-check')) console.log(message.text());
  });
  await page.goto(server.resolvedUrls.local[0] + '__environment_shadows__', { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.checkEnvironmentShadows === 'function', null, { timeout: 180_000 });
  for (const kind of ['pbr', 'standard']) {
    const result = await page.evaluate(kind => window.checkEnvironmentShadows(kind), kind);
    if (errors.length) {
      await writeFile(path.join(outputDir, 'browser-errors.log'), errors.join('\n'));
      throw new Error('浏览器错误：' + errors.filter(error => /SHADER ERROR|Offending line|Failed to load/.test(error)).join('\n').slice(0, 4000));
    }
    console.log(kind, JSON.stringify(result));
    await writeFile(path.join(outputDir, kind + '.json'), JSON.stringify(result, null, 2));
    const image = await page.evaluate(() => window.shadowImage);
    await writeFile(path.join(outputDir, kind + '.png'), Buffer.from(image.split(',')[1], 'base64'));
    for (const state of result.results) {
      if (state.label === 'disabled') assert.equal(state.darker, 0, kind + ': 关闭阴影后不能残留');
      else assert.ok(state.darker > 30, kind + '/' + state.label + ': 环境表面必须实际显示阴影');
      assert.equal(state.brighter, 0, kind + '/' + state.label + ': 阴影接收不能照亮环境');
      if ('frozen' in state) assert.equal(state.frozen, true);
    }
    assert.equal(result.stableColor, true, kind + ': 用户灯光不能改变环境原色');
    assert.equal(result.concentrationWorks, true, kind + ': 阴影浓度必须实际改变阴影像素');
    assert.equal(result.opacityWorks, true, kind + ': 阴影开启时环境透明度必须实际生效');
    assert.equal(result.disableLighting, true);
    if (kind === 'pbr') assert.equal(result.unlit, true);
    assert.equal(result.loadCount, 1);
  }
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.disposeFixture());
} finally {
  await browser?.close();
  await server.close();
}
