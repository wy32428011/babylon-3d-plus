/* global document, window, Image */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startSkyboxViteServer } from '../helpers/skyboxViteServer.mjs';

// 真实 Chrome + GPU 打开已构建的生产 Viewer 模板，验证 DIST 形态（只有 ENV、无原图）的天空盒。
const output = path.resolve('output/native-skybox-implementation-20261025/viewer');
const template = path.resolve(process.env.VIEWER_TEMPLATE_DIR ?? 'dist-viewer-template');
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile('public/builtin-skybox-environments/manifest.json', 'utf8'));
const resource = manifest.resources.find(item => item.faceSize === 512);
const envBytes = await readFile(path.join('public/builtin-skybox-environments', resource.file));
assert.equal(createHash('sha256').update(envBytes).digest('hex'), resource.sha256);
const directory = `skyboxes/Env-${resource.sha256.slice(0, 16)}`;
const logicalFile = `editor-asset://local/${encodeURIComponent(`project/assets/${directory}/${resource.sha256}.env`)}`;
const logicalPackage = `editor-asset://local/${encodeURIComponent(`project/assets/${directory}/`)}`;

const vite = await startSkyboxViteServer();
let scene;
try {
  globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
  const { createEmptySceneDocument, createSkyboxEntity } = await vite.server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
  const document = createEmptySceneDocument('原生天空 Viewer 验证');
  const sky = createSkyboxEntity({ packagePath: 'F:/fixture', sourcePath: 'F:/fixture/sky.hdr', sourceUrl: 'editor-asset://local/F%3A%2Ffixture%2Fsky.hdr',
    format: 'hdr', assetRevision: resource.sourceSha256, rotationDegrees: 0, intensity: 1, resolution: 512 });
  // 与 DIST 导出的场景形态一致：原图字段清空并标记不可用，只保留 ENV 描述。
  Object.assign(sky.components.skybox, { packagePath: '', sourcePath: '', sourceUrl: '', sourceAvailable: false,
    environment: { version: 1, format: 'env', sourceSha256: resource.sourceSha256, sourceRevision: resource.sourceRevision, recipeKey: resource.recipeKey,
      sha256: resource.sha256, byteLength: resource.byteLength, faceSize: 512, sourceUrl: logicalFile, sourcePath: logicalFile, packagePath: logicalPackage } });
  const box = { id: 'ground-box', name: '参照方块', visible: true, locked: false, parentId: null, childrenIds: [], components: {
    transform: { position: { x: 0, y: 0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    meshRenderer: { meshKind: 'cube', materialColor: '#c8c8c8' } } };
  document.entityIds.push(sky.id, box.id);
  document.entities[sky.id] = sky; document.entities[box.id] = box;
  document.sceneSettings.camera = { ...document.sceneSettings.camera, savedPose: { alpha: -Math.PI / 3, beta: Math.PI / 2.4, radius: 8, target: { x: 0, y: 0.5, z: 0 } },
    savedOrientation: 'orbit', savedProjection: 'perspective' };
  scene = { version: 7, scene: document };
} finally { await vite.close(); }

const requests = [];
const mqtt = { enabled: false, ip: '', address: '', topic: '', subscriptions: [], simulatorEnabled: false, simulatorAssetCode: '', simulatorScenario: 'cycle', simulatorIntervalMs: 500 };
scene.scene.mqttConfig = mqtt;
const config = { version: 2, page: { title: '原生天空验证', loadingText: '场景加载中...', backgroundColor: '#141414' },
  paths: { scene: './project/scene.json', assetManifest: './project/asset-manifest.json', assetBase: './project/assets/' },
  viewer: { showGrid: false, allowCameraControl: true, showStatusOverlay: false }, mqtt,
  digitalTwin: { projectId: '9001', runtimeConfigEndpoint: '/api/runtime-config' } };
const server = createServer((request, response) => {
  void (async () => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://fixture').pathname);
    requests.push(pathname);
    response.setHeader('Cache-Control', 'no-store');
    const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
    if (pathname === '/api/runtime-config') return json({ success: true, data: { projectId: '9001', runtimeEnabled: true, mqttBrokerUrl: null, apiBaseUrl: null, configJson: '{}' } });
    if (!pathname.startsWith('/published/')) { response.statusCode = 404; response.end(); return; }
    const relative = pathname.slice('/published/'.length) || 'index.html';
    if (relative === 'runtime-config.json') return json(config);
    if (relative === 'project/scene.json') return json(scene);
    if (relative === 'project/asset-manifest.json') return json({ version: 1, assets: [{ logicalUrl: logicalFile, path: `${directory}/${resource.sha256}.env`,
      kind: 'texture', size: envBytes.length, sha256: resource.sha256 }] });
    if (relative === `project/assets/${directory}/${resource.sha256}.env`) { response.setHeader('Content-Type', 'application/octet-stream'); response.end(envBytes); return; }
    const file = path.resolve(template, relative);
    assert.ok(file.startsWith(template + path.sep));
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };
    response.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  })().catch(error => { response.statusCode = 500; response.end(String(error)); });
});

const errors = [], consoleErrors = [], workers = [];
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/favicon/.test(message.text())) consoleErrors.push(message.text()); });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__workers = [];
    window.Worker = function (url, options) { window.__workers.push(String(url)); return new NativeWorker(url, options); };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/published/?performance=1`);
  try {
    await page.locator('.player-performance').waitFor({ state: 'visible', timeout: 60000 });
    await page.getByRole('progressbar').waitFor({ state: 'detached' });
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    console.error('Viewer 未就绪：', (await page.locator('body').innerText().catch(() => '')).slice(0, 800), JSON.stringify({ errors, consoleErrors, requests: requests.slice(-12) }));
    throw error;
  }
  assert.equal(await page.locator('.player-status-blocked').count(), 0, await page.locator('body').innerText());
  await page.waitForTimeout(2500);

  // 像素读取放在独立空白页，避免读取 WebGL 画布时受 preserveDrawingBuffer 影响。
  const reader = await context.newPage();
  await reader.goto('about:blank');
  const sample = async name => {
    const buffer = await page.screenshot({ path: path.join(output, `${name}.png`) });
    return reader.evaluate(async base64 => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context2d = canvas.getContext('2d'); context2d.drawImage(image, 0, 0);
      const mean = (x, y, w, h) => {
        const data = context2d.getImageData(x, y, w, h).data; const total = [0, 0, 0];
        for (let index = 0; index < data.length; index += 4) for (let channel = 0; channel < 3; channel++) total[channel] += data[index + channel];
        return total.map(value => value / (data.length / 4));
      };
      return { top: mean(20, 20, 160, 80), middle: mean(20, 220, 160, 60), farRight: mean(820, 20, 160, 80), all: mean(0, 0, image.width, image.height) };
    }, buffer.toString('base64'));
  };
  const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
  const background = [20, 20, 20];
  const before = await sample('initial');
  assert.ok(distance(before.top, background) > 40, `天空不应等于页面底色：${JSON.stringify(before.top)}`);
  assert.ok(distance(before.top, before.middle) > 6, '天空应有竖向渐变而不是纯色');

  // 拉远相机：无限远天空的像素不应随距离变化。
  for (let step = 0; step < 8; step++) { await page.mouse.move(500, 350); await page.mouse.wheel(0, 1200); await page.waitForTimeout(150); }
  await page.waitForTimeout(800);
  const zoomed = await sample('zoomed-out');
  assert.ok(distance(before.top, zoomed.top) < 12, `拉远不应改变天空：${JSON.stringify([before.top, zoomed.top])}`);

  // 旋转相机：天空必须随视线变化。
  await page.mouse.move(500, 350); await page.mouse.down({ button: 'right' });
  await page.mouse.move(900, 350, { steps: 12 }); await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(800);
  const rotated = await sample('rotated');
  assert.ok(distance(zoomed.all, rotated.all) > 3 || distance(zoomed.top, rotated.top) > 6, '旋转后天空应变化');

  const state = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); const gl = canvas.getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return { workers: window.__workers, renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown' };
  });
  workers.push(...state.workers);
  const envPath = `/published/project/assets/${directory}/${resource.sha256}.env`;
  const report = { renderer: state.renderer, envRequests: requests.filter(item => item === envPath).length,
    sourceRequests: requests.filter(item => /\.(hdr|exr)$/i.test(item)), workers, errors, consoleErrors,
    samples: { before, zoomed, rotated }, requests };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.envRequests, 1, 'ENV 只应下载一次');
  assert.deepEqual(report.sourceRequests, [], 'Viewer 不得请求 HDR/EXR 原图');
  assert.deepEqual(workers.filter(url => /skybox/i.test(url)), [], 'Viewer 不得创建天空盒解码 Worker');
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
  assert.doesNotMatch(state.renderer, /SwiftShader|llvmpipe|Software/i, '必须使用硬件 GPU');
  console.log('PASS', JSON.stringify({ renderer: state.renderer, envRequests: report.envRequests, workers: workers.length }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
