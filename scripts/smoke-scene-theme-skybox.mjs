import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/scene-theme-skybox');
const hdrHeader = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4 +X 8\n');
const hdrRows = Buffer.from(Array.from({ length: 4 }, () => [2, 2, 0, 8, 136, 128, 136, 64, 136, 32, 136, 129]).flat());
const hdr = Buffer.concat([hdrHeader, hdrRows]);
let hdrRequests = 0;

const harness = `
import { Engine, Scene, FreeCamera, Vector3, HemisphericLight, MeshBuilder, PBRMaterial } from '@babylonjs/core';
import { SceneRuntime } from '/src/runtime/babylon/SceneRuntime.ts';
import { createEmptySceneDocument } from '/src/editor/model/SceneDocument.ts';
import { createTechBlueNightTheme, TECH_BLUE_NIGHT_SHADOWS } from '/src/editor/model/sceneTheme.ts';
import { installDeploymentAssetManifest } from '/src/runtime/assets/editorAssetUrl.ts';

const engine = new Engine(document.querySelector('canvas'), false, { preserveDrawingBuffer: true, stencil: true });
window.runThemeSkybox = async () => {
  const scene = new Scene(engine);
  scene.clearColor.set(0.04, 0.05, 0.06, 1);
  const camera = new FreeCamera('camera', new Vector3(0, 0, -6), scene);
  camera.setTarget(Vector3.Zero()); camera.maxZ = 20000;
  const fill = new HemisphericLight('EditorLight', Vector3.Up(), scene); fill.intensity = 0.8;
  const logs = [], runtime = new SceneRuntime(scene, message => logs.push(message));
  installDeploymentAssetManifest({ 'editor-asset://local/theme-fixture.hdr': new URL('/fixture.hdr', location.href).href });
  const source = createEmptySceneDocument('theme-skybox');
  source.sceneSettings.shadows = { ...source.sceneSettings.shadows, enabled: false, mode: 'baked', bake: null };
  source.sceneSettings.skybox = {
    packagePath: 'C:/fixture', sourcePath: 'C:/fixture/theme-fixture.hdr', sourceUrl: 'editor-asset://local/theme-fixture.hdr',
    format: 'hdr', rotationDegrees: 0, intensity: 1.7, resolution: 256,
  };
  const sphere = MeshBuilder.CreateSphere('ibl-probe', { diameter: 2, segments: 32 }, scene);
  const material = new PBRMaterial('ibl-probe', scene);
  material.metallic = 1; material.roughness = 0.2; material.albedoColor.set(0.9, 0.9, 0.9);
  sphere.material = material;
  const draw = () => { engine.beginFrame(); scene.render(); engine.endFrame(); };
  const settle = async (frames = 20) => {
    for (let i = 0; i < frames; i++) { draw(); await new Promise(resolve => setTimeout(resolve, 16)); }
  };
  const capture = async () => {
    await settle();
    const deadline = performance.now() + 30000;
    while ((!scene.isReady(true) || !material.isReadyForSubMesh(sphere, sphere.subMeshes[0])) && performance.now() < deadline) await settle(2);
    if (!scene.isReady(true) || !material.isReadyForSubMesh(sphere, sphere.subMeshes[0])) throw new Error('PBR probe did not become render ready');
    await scene.whenReadyAsync(true);
    await settle(4);
    return { center: Array.from(await engine.readPixels(128, 128, 1, 1)), corner: Array.from(await engine.readPixels(5, 5, 1, 1)) };
  };
  const themed = structuredClone(source);
  themed.sceneSettings.theme = createTechBlueNightTheme();
  themed.sceneSettings.shadows = { ...themed.sceneSettings.shadows, ...TECH_BLUE_NIGHT_SHADOWS };
  const renderingState = () => {
    const image = scene.imageProcessingConfiguration;
    return {
      environmentIntensity: scene.environmentIntensity,
      lights: scene.lights.map(light => ({ name: light.name, enabled: light.isEnabled(), intensity: light.intensity,
        diffuse: light.diffuse.asArray(), specular: light.specular.asArray(),
        ...(light instanceof HemisphericLight ? { groundColor: light.groundColor.asArray() } : {}),
      })),
      imageProcessing: { exposure: image.exposure, contrast: image.contrast, toneMappingEnabled: image.toneMappingEnabled,
        toneMappingType: image.toneMappingType, applyByPostProcess: image.applyByPostProcess },
    };
  };
  try {
    runtime.sync(source);
    const deadline = performance.now() + 120000;
    while (!scene.environmentTexture && performance.now() < deadline) await settle(2);
    if (!scene.environmentTexture) throw new Error('HDR fixture failed to become ready: ' + logs.join(' | '));
    const texture = scene.environmentTexture;
    const skybox = scene.meshes.find(mesh => mesh.metadata?.editorSkyboxSphere);
    const baseline = await capture();
    const baselineRendering = renderingState();
    const baselineIntensity = scene.environmentIntensity;
    runtime.sync(themed);
    const hidden = await capture();
    const hiddenState = { visible: skybox.isEnabled(), sameTexture: scene.environmentTexture === texture, intensity: scene.environmentIntensity };
    const themeMain = scene.getLightByName('__SceneThemeMain');
    // 仅在测量期间关闭 IBL，像素差证明背景隐藏后材质仍使用同一份环境照明。
    const themeIntensity = scene.environmentIntensity;
    scene.environmentIntensity = 0;
    const withoutIbl = await capture();
    scene.environmentIntensity = themeIntensity;
    await settle();
    const shadowStates = [];
    for (const mode of ['realtime', 'baked', 'realtime', 'baked', 'realtime']) {
      themed.sceneSettings.shadows = { ...themed.sceneSettings.shadows, mode, enabled: true };
      runtime.sync(themed); await settle();
      shadowStates.push({ mode, mainSame: scene.getLightByName('__SceneThemeMain') === themeMain,
        themeLights: scene.lights.filter(light => light.metadata?.sceneThemeOwned).length,
        directionals: scene.lights.filter(light => light.getClassName() === 'DirectionalLight').map(light => light.name),
        generators: scene.lights.filter(light => light.getShadowGenerator()).map(light => light.name),
        intensity: scene.environmentIntensity,
      });
    }
    runtime.sync(source);
    const restored = await capture();
    const restoredRendering = renderingState();
    const restoredState = { visible: skybox.isEnabled(), sameTexture: scene.environmentTexture === texture,
      intensity: scene.environmentIntensity, themeLights: scene.lights.filter(light => light.metadata?.sceneThemeOwned).length,
      generators: scene.lights.filter(light => light.getShadowGenerator()).length };
    window.themeSkyboxImage = document.querySelector('canvas').toDataURL('image/png');
    return { baseline, hidden, withoutIbl, restored, baselineRendering, restoredRendering, baselineIntensity, hiddenState, restoredState, shadowStates, logs };
  } finally { runtime.dispose(); scene.dispose(); engine.dispose(); }
};
`;

const server = await createServer({
  configFile: false,
  cacheDir: 'node_modules/.cache/theme-skybox-smoke',
  optimizeDeps: { include: ['@babylonjs/core', '@babylonjs/loaders', '@linkiez/dxf-renew', 'react', 'lodash/cloneDeep'] },
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{
    name: 'scene-theme-skybox-smoke',
    resolveId(id) { if (id === '/__theme_skybox__.js') return '\0theme-skybox'; },
    load(id) { if (id === '\0theme-skybox') return harness; },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
        if (pathname === '/fixture.hdr') {
          hdrRequests++;
          response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': hdr.length, 'cache-control': 'no-store' });
          response.end(hdr); return;
        }
        if (pathname !== '/__theme_skybox__') return next();
        response.setHeader('content-type', 'text/html');
        response.end('<!doctype html><canvas width="256" height="256"></canvas><script type="module" src="/__theme_skybox__.js"></script>');
      });
    },
  }],
});
let browser, page;
const errors = [], external = [];
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  await server.watcher.close();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage();
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()); });
  await page.goto(server.resolvedUrls.local[0] + '__theme_skybox__', { waitUntil: 'commit' });
  if (errors.length) throw new Error(errors.join('\n'));
  await Promise.race([
    page.waitForFunction(() => typeof window.runThemeSkybox === 'function', null, { timeout: 180000 }),
    new Promise((_, reject) => page.once('pageerror', reject)),
  ]);
  const result = await page.evaluate(() => window.runThemeSkybox());
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ...result, hdrBytes: hdr.length, hdrRequests, errors, external }, null, 2));
  console.log(JSON.stringify({ ...result, hdrRequests, errors, external }, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(hdrRequests, 1, '主题及阴影切换不应重新下载 HDR');
  assert.equal(result.baselineIntensity, 1.7);
  assert.deepEqual(result.hiddenState, { visible: false, sameTexture: true, intensity: 0.3 });
  assert.ok(result.hidden.center.slice(0, 3).some((value, index) => value > result.withoutIbl.center[index] + 10), '天空盒背景隐藏后仍提供真实 IBL');
  assert.notDeepEqual(result.hidden.corner, result.baseline.corner, '隐藏天空盒后必须显示主题背景');
  assert.deepEqual(result.restored, result.baseline, '停用主题恢复原始背景和材质像素');
  assert.deepEqual(result.restoredRendering, result.baselineRendering, '停用主题恢复灯光、曝光、对比度及色调映射');
  assert.deepEqual(result.restoredState, { visible: true, sameTexture: true, intensity: 1.7, themeLights: 0, generators: 0 });
  for (const state of result.shadowStates) {
    assert.equal(state.mainSame, true); assert.equal(state.themeLights, 1);
    assert.deepEqual(state.directionals, ['__SceneThemeMain']);
    assert.deepEqual(state.generators, state.mode === 'realtime' ? ['__SceneThemeMain'] : []);
    assert.equal(state.intensity, 0.3);
  }
  const png = await page.evaluate(() => window.themeSkyboxImage);
  await writeFile(path.join(output, 'restored.png'), Buffer.from(png.split(',')[1], 'base64'));
} catch (error) {
  await writeFile(path.join(output, 'errors.json'), JSON.stringify({ errors, external }, null, 2));
  await page?.screenshot({ path: path.join(output, 'failure.png') });
  throw error;
} finally { await browser?.close(); await server.close(); }
