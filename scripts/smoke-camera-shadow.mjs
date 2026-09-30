import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium } from 'playwright';

const outputDir = path.resolve('output/playwright/camera-shadow');
const harness = `
import { Engine, FreeCamera, MeshBuilder, PBRMaterial, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { SceneShadowRuntime } from '/src/runtime/babylon/SceneShadowRuntime.ts';
import { EnvironmentShadowMaterialPlugin } from '/src/runtime/babylon/EnvironmentShadowMaterialPlugin.ts';
const DEFAULT_SCENE_SHADOW_SETTINGS = {
  enabled: true, mode: 'realtime', quality: 'balanced', darkness: 0.32, catcherEnabled: false,
  sunAzimuthDegrees: 56, sunElevationDegrees: 63, sunIntensity: 1.05, distanceMeters: 0,
  bias: 0.002, normalBias: 0.03, fillIntensity: 0.2, iblIntensityMax: 0.45,
};
const canvas = document.querySelector('canvas');
const engine = new Engine(canvas, false, { preserveDrawingBuffer: true });
window.checkCameraShadow = async kind => {
  const results = [], images = {};
  const scene = new Scene(engine);
  scene.clearColor.set(0.3, 0.3, 0.3, 1);
  const camera = new FreeCamera('camera', new Vector3(0, 2, -2), scene);
  camera.minZ = 0.025; camera.maxZ = 5000;
  camera.setTarget(Vector3.Zero());
  const floor = MeshBuilder.CreateGround('environment-floor', { width: 40, height: 40 }, scene);
  const material = kind === 'pbr' ? new PBRMaterial('floor', scene) : new StandardMaterial('floor', scene);
  if (kind === 'pbr') { material.unlit = true; material.albedoColor.set(0.7, 0.7, 0.7); }
  else { material.disableLighting = true; material.emissiveColor.set(0.7, 0.7, 0.7); }
  floor.material = material; floor.metadata = { editorEnvironmentMesh: true };
  new EnvironmentShadowMaterialPlugin(material);
  const shadows = new SceneShadowRuntime(scene);
  const render = () => scene.render();
  engine.runRenderLoop(render);
  const capture = async () => {
    for (let n = 0; n < 8; n++) {
      engine.beginFrame(); scene.render(); engine.endFrame();
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    return Array.from(await engine.readPixels(0, 0, 256, 256));
  };
  const sample = async label => {
    console.log('camera-shadow sample', label);
    await capture();
    floor.receiveShadows = false; material.markDirty(true);
    const off = await capture();
    if (floor.receiveShadows) throw new Error('阴影关闭对照被运行时覆盖');
    floor.receiveShadows = true; material.markDirty(true);
    const on = await capture();
    let darker = 0, brighter = 0;
    for (let i = 0; i < off.length; i += 4) {
      const delta = on[i] - off[i];
      if (delta < -3) darker++; else if (delta > 3) brighter++;
    }
    const result = { label, darker, brighter };
    results.push(result); images[label] = canvas.toDataURL('image/png');
    return result;
  };
  try {
    for (const quality of ['performance', 'balanced', 'quality']) {
      shadows.applySettings({ ...DEFAULT_SCENE_SHADOW_SETTINGS, mode: 'realtime', quality, catcherEnabled: false });
      for (const [view, position] of [['near', [0, 2, -2]], ['overview', [8, 12, -12]], ['moved', [6, 2, 4]]]) {
        camera.position.set(...position); camera.setTarget(Vector3.Zero());
        await sample('empty-' + quality + '-' + view);
      }
    }
    camera.position.set(0, 2, -2); camera.setTarget(Vector3.Zero());
    const equipment = MeshBuilder.CreateBox('equipment', { size: 2 }, scene);
    equipment.position.set(1, 1, 0);
    for (const quality of ['performance', 'balanced', 'quality']) {
      shadows.applySettings({ ...DEFAULT_SCENE_SHADOW_SETTINGS, mode: 'realtime', quality, catcherEnabled: false });
      await sample('equipment-' + quality);
    }
    equipment.dispose();
    return { results, images, renderer: engine.getGlInfo().renderer };
  } finally { engine.stopRenderLoop(render); shadows.dispose(); scene.dispose(); }
};
`;

const bundle = await build({
  configFile: false,
  logLevel: 'warn',
  build: { write: false, minify: false, rollupOptions: {
    input: '/__camera_shadow__.js', output: { codeSplitting: false },
  } },
  plugins: [{
    name: 'camera-shadow-fixture',
    resolveId(id) {
      if (id === '/__camera_shadow__.js') return '\0camera-shadow';
      if (id.startsWith('/src/')) return path.resolve(id.slice(1));
    },
    load(id) { if (id === '\0camera-shadow') return harness; },
  }],
});
const entry = bundle.output.find(item => item.type === 'chunk' && item.isEntry);
assert.ok(entry);
const server = createServer((request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (request.url === '/__camera_shadow__.js') {
    response.setHeader('Content-Type', 'text/javascript'); response.end(entry.code); return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><canvas width="256" height="256"></canvas><script type="module" src="/__camera_shadow__.js"></script>');
});
let browser;
const errors = [];
try {
  await mkdir(outputDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  console.log('camera-shadow server ready');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  console.log('camera-shadow Chrome launched');
  const page = await browser.newPage();
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => {
    if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); }
    else if (message.text().startsWith('camera-shadow')) console.log(message.text());
  });
  await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'commit' });
  console.log('camera-shadow page loaded');
  await page.waitForFunction(() => typeof window.checkCameraShadow === 'function', null, { timeout: 120_000 });
  console.log('camera-shadow browser ready');
  for (const kind of ['pbr', 'standard']) {
    const { images, ...result } = await page.evaluate(kind => Promise.race([
      window.checkCameraShadow(kind),
      new Promise((_, reject) => setTimeout(() => reject(new Error('camera-shadow capture timed out')), 30_000)),
    ]), kind);
    await writeFile(path.join(outputDir, kind + '.json'), JSON.stringify({ ...result, errors }, null, 2));
    for (const [name, data] of Object.entries(images)) {
      await writeFile(path.join(outputDir, kind + '-' + name + '.png'), Buffer.from(data.split(',')[1], 'base64'));
    }
    console.log(kind, JSON.stringify(result));
    assert.deepEqual(errors, [], '浏览器不能出现渲染错误');
    for (const state of result.results) {
      if (state.label.startsWith('equipment-')) assert.ok(state.darker > 30, kind + '/' + state.label + ': 真实设备必须保留阴影');
      else assert.equal(state.darker, 0, kind + '/' + state.label + ': 空地面不应出现镜头下的伪阴影');
      assert.equal(state.brighter, 0, '阴影不能照亮环境');
    }
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
