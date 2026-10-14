import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const outputDir = path.resolve('output/playwright/local-shadow-priority');
const harness = `
import {
  Camera, Color3, Engine, FreeCamera, Matrix, MeshBuilder, PBRMaterial,
  PointLight, Scene, SpotLight, StandardMaterial, Vector3,
} from '@babylonjs/core';
import { SceneShadowRuntime, SCENE_SHADOW_SUN_NAME } from '/src/runtime/babylon/SceneShadowRuntime.ts';
import { EnvironmentShadowMaterialPlugin } from '/src/runtime/babylon/EnvironmentShadowMaterialPlugin.ts';
const engine = new Engine(document.querySelector('canvas'), false, { preserveDrawingBuffer: true });
window.runPriorityCheck = async (kind, lightKind) => {
  const scene = new Scene(engine);
  const camera = new FreeCamera('camera', new Vector3(0, 10, -0.001), scene);
  camera.setTarget(Vector3.Zero()); camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = camera.orthoBottom = -20;
  camera.orthoRight = camera.orthoTop = 20;
  const runtime = new SceneShadowRuntime(scene);
  const settings = {
    enabled: true, mode: 'realtime', quality: 'balanced', darkness: 0.35, catcherEnabled: false,
    sunAzimuthDegrees: 0, sunElevationDegrees: 90, sunIntensity: 1, distanceMeters: 120,
    bias: 0.002, normalBias: 0.03, fillIntensity: 0.2, iblIntensityMax: 0.45,
  };
  runtime.applySettings(settings);
  const floor = MeshBuilder.CreateGround('floor', { width: 64, height: 64 }, scene);
  floor.metadata = { editorEnvironmentMesh: true };
  const material = kind === 'pbr' ? new PBRMaterial('floor', scene) : new StandardMaterial('floor', scene);
  material.disableLighting = true;
  if (kind === 'pbr') { material.unlit = true; material.albedoColor.set(0.6, 0.6, 0.6); }
  else { material.diffuseColor.set(0.6, 0.6, 0.6); material.emissiveColor.copyFrom(material.diffuseColor); }
  floor.material = material;
  new EnvironmentShadowMaterialPlugin(material); material.freeze();
  // 相机位于屋顶下方，屋顶只遮挡主方向光，不遮挡下方的局部灯。
  const roof = MeshBuilder.CreateBox('roof', { width: 96, depth: 96, height: 0.2 }, scene);
  roof.position.y = 12;
  const box = MeshBuilder.CreateBox('equipment', { size: 2 }, scene); box.position.set(2, 1, 0);
  const boxMaterial = new StandardMaterial('equipment', scene);
  boxMaterial.disableLighting = true; boxMaterial.emissiveColor = Color3.Black(); box.material = boxMaterial;
  const local = lightKind === 'point'
    ? new PointLight('local', new Vector3(0, 5, 0), scene)
    : new SpotLight('local', new Vector3(0, 5, 0), Vector3.Down(), Math.PI / 2, 2, scene);
  local.range = 15; local.setEnabled(false); runtime.syncLight('local', local);
  const capture = async () => {
    for (let frame = 0; frame < 12; frame++) {
      engine.beginFrame(); scene.render(); engine.endFrame();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return Array.from(await engine.readPixels(0, 0, 256, 256));
  };
  const receive = async enabled => {
    material.unfreeze(); floor.receiveShadows = enabled; material.freeze(); material.markDirty(true);
    return capture();
  };
  const at = (pixels, x, z) => {
    const position = Vector3.Project(new Vector3(x, 0, z), Matrix.Identity(), scene.getTransformMatrix(), camera.viewport.toGlobal(256, 256));
    const index = (Math.min(255, Math.max(0, 255 - Math.round(position.y))) * 256
      + Math.min(255, Math.max(0, Math.round(position.x)))) * 4;
    return pixels[index];
  };
  const compare = (a, b, reference) => {
    let darker = 0, brighter = 0, aboveOriginal = 0;
    for (let i = 0; i < a.length; i += 4) {
      // 只统计原色截图中与地面颜色相同的像素，排除设备表面。
      if (Math.abs(reference[i] - reference[0]) > 1) continue;
      if (b[i] < a[i] - 3) darker++;
      if (b[i] > a[i] + 3) brighter++;
      if (b[i] > reference[i] + 3) aboveOriginal++;
    }
    return { darker, brighter, aboveOriginal };
  };
  try {
    await capture();
    const original = await receive(false);
    window.priorityImages = { original: document.querySelector('canvas').toDataURL('image/png') };
    const primary = await receive(true);
    window.priorityImages.primary = document.querySelector('canvas').toDataURL('image/png');
    local.setEnabled(true); runtime.syncLight('local', local);
    const priority = await capture();
    const free = lightKind === 'point' ? -5 : -3;
    const edgePositions = lightKind === 'point' ? [-12.7, -13.3, -13.9] : [-4.3, -4.55, -4.8];
    const result = {
      kind, lightKind, frozen: material.isFrozen, ...compare(primary, priority, original),
      free: { original: at(original, free, 0), primary: at(primary, free, 0), priority: at(priority, free, 0) },
      occluded: { original: at(original, 3.5, 0), priority: at(priority, 3.5, 0) },
      outside: { primary: at(primary, -18, 0), priority: at(priority, -18, 0) },
      edge: edgePositions.map(x => at(priority, x, 0)),
    };
    window.priorityImages.priority = document.querySelector('canvas').toDataURL('image/png');
    const duplicate = lightKind === 'point'
      ? new PointLight('duplicate', local.position.clone(), scene)
      : new SpotLight('duplicate', local.position.clone(), Vector3.Down(), Math.PI / 2, 2, scene);
    duplicate.range = local.range; runtime.syncLight('duplicate', duplicate);
    result.overlap = compare(priority, await capture(), original);
    runtime.removeLight('duplicate'); duplicate.dispose();
    local.position.x -= 4; runtime.syncLight('local', local);
    result.moved = compare(priority, await capture(), original);
    local.position.x += 4;
    local.setEnabled(false); runtime.syncLight('local', local);
    result.hidden = compare(primary, await capture(), original);
    local.setEnabled(true); local.intensity = 0; runtime.syncLight('local', local);
    result.zero = compare(primary, await capture(), original);
    local.intensity = 1; runtime.syncLight('local', local); await capture();
    runtime.removeLight('local'); local.dispose();
    result.removed = compare(primary, await capture(), original);
    return result;
  } finally { runtime.dispose(); scene.dispose(); }
};
window.disposePriorityCheck = () => engine.dispose();
`;

await mkdir(outputDir, { recursive: true });
const server = await createServer({
  configFile: false,
  cacheDir: 'node_modules/.vite-local-shadow-priority',
  optimizeDeps: { noDiscovery: true, include: ['@babylonjs/core'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  plugins: [{
    name: 'local-shadow-priority-fixture',
    resolveId(id) { if (id === '/__local_shadow_priority__.js') return '\0local-shadow-priority'; },
    load(id) { if (id === '\0local-shadow-priority') return harness; },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
        if (request.url !== '/__local_shadow_priority__') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><canvas width="256" height="256"></canvas><script type="module" src="/__local_shadow_priority__.js"></script>');
      });
    },
  }],
});
let browser;
const errors = [];
const results = [];
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(server.resolvedUrls.local[0] + '__local_shadow_priority__', { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.runPriorityCheck === 'function', null, { timeout: 90_000 });
  for (const kind of ['pbr', 'standard']) {
    for (const lightKind of ['point', 'spot']) {
      const result = await page.evaluate(([kind, lightKind]) => window.runPriorityCheck(kind, lightKind), [kind, lightKind]);
      results.push(result); console.log(JSON.stringify(result));
      await writeFile(path.join(outputDir, 'results.json'), JSON.stringify(results, null, 2));
      const images = await page.evaluate(() => window.priorityImages);
      for (const [name, data] of Object.entries(images)) {
        await writeFile(path.join(outputDir, `${kind}-${lightKind}-${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
      }
      assert.deepEqual(errors, [], '浏览器不可出现 shader 或资源错误');
      assert.ok(result.free.priority > result.free.primary + 30, '主阴影内局部灯必须恢复未遮挡地面的原色');
      assert.ok(Math.abs(result.free.priority - result.free.original) <= 2, '覆盖内部不能改变地面原色');
      assert.ok(result.occluded.priority < result.occluded.original - 20, '设备仍必须在地面留下局部阴影');
      assert.ok(Math.abs(result.outside.priority - result.outside.primary) <= 2, '范围外必须保留主阴影');
      assert.ok(result.edge[0] > result.edge[1] && result.edge[1] > result.edge[2], '局部范围或光锥边缘必须平滑过渡');
      assert.equal(result.aboveOriginal, 0, '局部阴影不得把地面照亮到超过原色');
      assert.equal(result.overlap.darker, 0, '重叠局部阴影不能重复变黑');
      assert.ok(result.moved.darker + result.moved.brighter > 30, '移动局部灯必须改变地面阴影');
      for (const label of ['hidden', 'zero', 'removed']) {
        assert.equal(result[label].darker + result[label].brighter, 0, `${label} 后必须恢复主阴影`);
      }
      assert.equal(result.frozen, true);
    }
  }
  await page.evaluate(() => window.disposePriorityCheck());
} finally { await browser?.close(); await server.close(); }
