import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/chart-marker-ring');
await mkdir(output, { recursive: true });
let server, viewerServer, browser, page;
const errors = [];
const checks = [];
const entry = path.join(output, 'harness-entry.ts');
await writeFile(entry, `
import '/src/main.tsx';
import { EngineStore, Vector3, Ray, VertexBuffer } from '@babylonjs/core';
import { useEditorStore } from '/src/editor/store/editorStore.ts';
import * as serializer from '/src/editor/project/SceneSerializer.ts';
import * as preparation from '/src/editor/loading/scenePreparationProgress.ts';
Object.assign(window, { ringStore: useEditorStore, ringSerializer: serializer, ringPreparation: preparation,
  ringCore: { EngineStore, Vector3, Ray, VertexBuffer },
  ringScene: () => EngineStore.Instances.flatMap(engine => engine.scenes).find(scene => !!scene.activeCamera) });
`);
await writeFile(path.join(output, 'harness.html'), (await readFile('index.html', 'utf8'))
  .replace('/src/main.tsx', '/output/playwright/chart-marker-ring/harness-entry.ts'));
const viewerEntry = path.join(output, 'viewer-entry.ts');
await writeFile(viewerEntry, `
import { EngineStore, Vector3, Ray, VertexBuffer } from '@babylonjs/core';
Object.assign(window, { ringCore: { EngineStore, Vector3, Ray, VertexBuffer },
  ringScene: () => EngineStore.Instances.flatMap(engine => engine.scenes).find(scene => !!scene.activeCamera) });
`);

async function frames(target) {
  const frame = await target.evaluate(() => window.ringScene()?.getFrameId() ?? 0);
  await target.waitForFunction(value => window.ringScene()?.getFrameId() > value + 8, frame);
}
async function capture(target, filename) {
  await frames(target);
  return target.locator('canvas.scene-canvas, canvas.player-canvas, canvas').first().screenshot({ path: path.join(output, filename) });
}
async function pixelStats(target, png) {
  return target.evaluate(async encoded => {
    const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let cyan = 0, bright = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      if (bytes[i + 1] > 90 && bytes[i + 2] > 110 && bytes[i] < bytes[i + 2] * 0.65) cyan++;
      if (bytes[i] + bytes[i + 1] + bytes[i + 2] > 450) bright++;
    }
    return { cyan, bright, pixels: canvas.width * canvas.height };
  }, png.toString('base64'));
}
async function meshInfo(target, id) {
  return target.evaluate(entityId => {
    const scene = window.ringScene(), { Vector3, Ray, VertexBuffer } = window.ringCore;
    const mesh = scene.meshes.find(mesh => mesh.metadata?.entityId === entityId && mesh.metadata?.editorChartMarker)
      ?? scene.getMeshByName(entityId);
    if (!mesh) throw Error('没有找到图表立标实体网格');
    mesh.computeWorldMatrix(true);
    const bounds = mesh.getBoundingInfo().boundingBox;
    const center = bounds.centerWorld;
    const radius = Math.max(bounds.extendSizeWorld.x, bounds.extendSizeWorld.z);
    const hole = scene.pickWithRay(new Ray(center.add(new Vector3(0, 100, 0)), new Vector3(0, -1, 0), 200), candidate => candidate === mesh);
    const side = scene.pickWithRay(new Ray(center.add(new Vector3(0, 0, radius + 5)), new Vector3(0, 0, -1), radius * 2 + 10), candidate => candidate === mesh);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    return { name: mesh.name, vertices: mesh.getTotalVertices(), indices: mesh.getTotalIndices(),
      extent: bounds.extendSizeWorld.asArray(), center: center.asArray(), holeHit: !!hole?.hit, sideHit: !!side?.hit,
      seamClosed: Math.abs(positions[0] - positions[positions.length - 6]) < 1e-6
        && Math.abs(positions[2] - positions[positions.length - 4]) < 1e-6,
      materialAlpha: mesh.material?.alpha, enabled: mesh.isEnabled() };
  }, id);
}
async function setCamera(target, center, top = false) {
  await target.evaluate(({ center, top }) => {
    const { Vector3 } = window.ringCore, camera = window.ringScene().activeCamera;
    camera.setTarget(Vector3.FromArray(center));
    camera.alpha = -Math.PI / 2 - 0.45;
    camera.beta = top ? 0.07 : 1.05;
    camera.radius = 19;
    camera.inertialAlphaOffset = camera.inertialBetaOffset = camera.inertialRadiusOffset = 0;
  }, { center, top });
  await frames(target);
}
try {
  const editorBuild = path.join(output, 'editor-build');
  await build({ configFile: false, root: process.cwd(), base: '/', plugins: [react()], logLevel: 'warn',
    cacheDir: path.join(output, 'vite-cache'), build: { outDir: editorBuild, copyPublicDir: false, emptyOutDir: false,
      rollupOptions: { input: path.join(output, 'harness.html') } } });
  server = await preview({ configFile: false, root: process.cwd(), build: { outDir: editorBuild },
    preview: { host: '127.0.0.1', port: 0, strictPort: false } });
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  page.setDefaultTimeout(45000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.editorApi = {
    listProjectAssets: async () => ({ projectRoot: 'fixture', assets: [], skyboxes: [], skyboxSyncContextKey: 'ring:1' }),
    listSyncedImages: async () => [],
    listDataPlatformCharts: async () => ({ contextKey: 'ring:1', projectId: '1', charts: [] }),
    getRecentWorkspaces: async () => ({ projects: [], scenes: [] }),
    getDataPlatformConfig: async () => ({ baseUrl: '', workspaceRoot: '', usesDefaultWorkspace: true }),
    listDataPlatformProjects: async () => ({ records: [], total: 0 }),
  }; });
  await page.goto(url + 'output/playwright/chart-marker-ring/harness.html', { timeout: 180000 });
  await page.getByRole('button', { name: '进入空白编辑器' }).click({ timeout: 180000 });
  console.log('进入真实编辑器');
  const canvas = page.locator('canvas.scene-canvas');
  await canvas.waitFor();
  await page.waitForFunction(() => window.ringStore && window.ringScene() && !window.ringPreparation.isScenePreparationActive(), null, { timeout: 180000 });
  await page.getByRole('button', { name: 'POI库', exact: true }).click();
  await page.getByRole('button', { name: /图表立标/ }).first().dragTo(canvas);
  await page.waitForFunction(() => Object.values(window.ringStore.getState().scene.entities).some(entity => entity.components.chartMarker));
  const id = await page.evaluate(() => window.ringStore.getState().scene.selectedEntityId);
  assert.equal(await page.getByLabel('面板形状', { exact: true }).inputValue(), 'plane');
  await page.getByLabel('面板形状', { exact: true }).selectOption('ring');
  await page.getByLabel('内容平铺次数', { exact: true }).fill('1');
  await page.getByLabel('内容平铺次数', { exact: true }).press('Tab');
  assert.equal(await page.getByLabel('面向摄像机', { exact: true }).count(), 0);
  for (const [label, value] of [['环形半径（m）', '4'], ['尺寸 X（px）', '1600'], ['尺寸 Y（px）', '180'], ['悬浮高度（m）', '2']]) {
    await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByLabel(label, { exact: true }).press('Tab');
  }
  await page.getByLabel('文本内容', { exact: true }).fill('');
  await page.getByLabel('背景颜色', { exact: true }).fill('#061e35');
  const chart = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 180;
    const context = canvas.getContext('2d');
    context.fillStyle = '#082039'; context.fillRect(0, 0, 1600, 180);
    context.strokeStyle = '#12d3ef'; context.lineWidth = 3;
    context.strokeRect(2, 2, 1596, 176);
    context.fillStyle = '#b5f8ff'; context.font = 'bold 28px sans-serif'; context.fillText('产线设备总览 · 实时运行趋势', 32, 40);
    context.fillStyle = '#28efff'; context.font = 'bold 24px sans-serif';
    context.fillText('设备效率 98.6%     当班产量 12,680     运行状态 正常', 820, 40);
    context.strokeStyle = '#0d526b'; context.lineWidth = 1;
    for (const y of [70, 105, 140]) { context.beginPath(); context.moveTo(10, y); context.lineTo(1590, y); context.stroke(); }
    context.strokeStyle = '#20e9fa'; context.lineWidth = 3; context.beginPath();
    for (let index = 0; index <= 80; index++) {
      const y = 118 + Math.sin(index / 4) * 17 + Math.sin(index / 1.6) * 10;
      if (index) context.lineTo(index * 20, y); else context.moveTo(0, y);
    }
    context.stroke();
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('选择背景图片', { exact: true }).setInputFiles({ name: 'ring-dashboard.png', mimeType: 'image/png', buffer: Buffer.from(chart, 'base64') });
  await page.waitForFunction(entityId => window.ringStore.getState().scene.entities[entityId].components.chartMarker.backgroundImage.startsWith('data:image/png;'), id);
  await writeFile(path.join(output, 'ring-dashboard.png'), Buffer.from(chart, 'base64'));
  await page.evaluate(entityId => window.ringStore.getState().requestSceneFocusForSelection([entityId]), id);
  await frames(page);
  const geometry = await meshInfo(page, id);
  console.log('环形网格', JSON.stringify(geometry));
  assert.equal(geometry.vertices, 194);
  assert.equal(geometry.indices, 576);
  assert.equal(geometry.holeHit, false, '中心没有顶盖或填充面');
  assert.equal(geometry.sideHit, true, '真实圆周侧壁可拾取');
  assert.equal(geometry.seamClosed, true);
  await setCamera(page, geometry.center);
  const front = await capture(page, 'editor-ring.png');
  const pixels = await pixelStats(page, front);
  assert.ok(pixels.cyan > 1000, 'WebGL画布必须显示环形图表纹理与青色边框：' + JSON.stringify(pixels));
  await page.screenshot({ path: path.join(output, 'editor-properties.png') });
  const readTopology = () => page.evaluate(name => {
    const mesh = window.ringScene().getMeshByName(name);
    return { uniqueId: mesh.uniqueId, positions: Array.from(mesh.getVerticesData(window.ringCore.VertexBuffer.PositionKind)), indices: Array.from(mesh.getIndices()) };
  }, geometry.name);
  const singleTopology = await readTopology();
  await page.getByLabel('内容平铺次数', { exact: true }).fill('4');
  await page.getByLabel('内容平铺次数', { exact: true }).press('Tab');
  await frames(page);
  assert.deepEqual(await readTopology(), singleTopology, '平铺次数仅改变内容，不重建或修改环形几何');
  const repeatedImage = await capture(page, 'editor-repeat-four.png');
  const changedPixels = await page.evaluate(async images => {
    const pixels = await Promise.all(images.map(async encoded => {
      const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    }));
    let changed = 0;
    for (let index = 0; index < pixels[0].length; index += 4) {
      if (Math.abs(pixels[0][index] - pixels[1][index]) + Math.abs(pixels[0][index + 1] - pixels[1][index + 1]) + Math.abs(pixels[0][index + 2] - pixels[1][index + 2]) > 30) changed++;
    }
    return changed;
  }, [front.toString('base64'), repeatedImage.toString('base64')]);
  assert.ok(changedPixels > 300, '切换平铺次数必须改变真实内容像素：' + changedPixels);
  await page.getByLabel('内容平铺次数', { exact: true }).fill('1');
  await page.getByLabel('内容平铺次数', { exact: true }).press('Tab');
  await frames(page);
  assert.deepEqual(await readTopology(), singleTopology);
  checks.push('repeat-one-four-content-only');
  checks.push('real-poi-library-drag', 'shape-radius-height-ui', 'background-image-ui', 'webgl-chart-pixels', 'closed-ring-and-center-hole');

  const box = await canvas.boundingBox();
  const beforeOrbit = await page.evaluate(() => ({ alpha: window.ringScene().activeCamera.alpha, beta: window.ringScene().activeCamera.beta }));
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.30);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.42, { steps: 16 });
  await page.mouse.up({ button: 'right' });
  await frames(page);
  const afterOrbit = await page.evaluate(() => ({ alpha: window.ringScene().activeCamera.alpha, beta: window.ringScene().activeCamera.beta }));
  assert.ok(Math.abs(beforeOrbit.alpha - afterOrbit.alpha) + Math.abs(beforeOrbit.beta - afterOrbit.beta) > 0.1, '真实鼠标拖拽改变观察方向');
  await capture(page, 'editor-orbit.png');
  assert.equal((await meshInfo(page, id)).holeHit, false);
  await setCamera(page, geometry.center, true);
  await capture(page, 'editor-top-hole.png');
  checks.push('real-mouse-orbit', 'top-view-hole');

  await page.evaluate(entityId => window.ringStore.getState().selectEntity(entityId), id);
  await page.getByLabel('面板形状', { exact: true }).selectOption('plane');
  assert.equal(await page.getByLabel('面向摄像机', { exact: true }).isChecked(), true);
  await frames(page);
  const plane = await meshInfo(page, id);
  assert.equal(plane.indices, 6);
  await page.getByLabel('面板形状', { exact: true }).selectOption('ring');
  await frames(page);
  assert.equal((await meshInfo(page, id)).indices, 576);
  checks.push('plane-roundtrip-preserves-facing');
  await setCamera(page, geometry.center);

  const saved = await page.evaluate(() => window.ringSerializer.serializeScene(window.ringStore.getState().scene));
  await writeFile(path.join(output, 'scene.scene.json'), saved);
  const expectedMarker = JSON.parse(saved).scene.entities[id].components.chartMarker;
  await page.evaluate(content => window.ringStore.getState().loadSceneFromContent(content, 'reopened-ring.scene.json'), saved);
  await page.bringToFront();
  await page.waitForFunction(() => !window.ringPreparation.isScenePreparationActive(), null, { timeout: 20000 });
  await frames(page);
  assert.deepEqual(await page.evaluate(entityId => window.ringStore.getState().scene.entities[entityId].components.chartMarker, id), expectedMarker);
  assert.equal((await meshInfo(page, id)).indices, 576);
  await setCamera(page, geometry.center);
  await capture(page, 'editor-reopened.png');
  checks.push('serialize-save-reopen');
  console.log('编辑器UI、绕视与保存重开通过');

  const previewResult = await page.evaluate(() => {
    window.ringStore.setState(({ scene }) => ({ scene: { ...scene, mqttConfig: { ...scene.mqttConfig, enabled: true, simulatorEnabled: true } } }));
    return window.ringStore.getState().startRuntimePreview();
  });
  assert.equal(previewResult.ok, true, JSON.stringify(previewResult));
  await page.waitForFunction(() => window.ringStore.getState().runtimeMode === 'preview');
  await setCamera(page, geometry.center);
  const previewPixels = await pixelStats(page, await capture(page, 'preview-ring.png'));
  assert.ok(previewPixels.cyan > 1000);
  await page.evaluate(() => window.ringStore.getState().stopRuntimePreview());
  checks.push('editor-runtime-preview');

  const source = JSON.parse(saved);
  source.scene.sceneSettings.camera.savedPose = { alpha: -Math.PI / 2 - 0.45, beta: 1.05, radius: 19,
    target: { x: geometry.center[0], y: geometry.center[1], z: geometry.center[2] } };
  const viewerContent = JSON.stringify(source);
  await writeFile(path.join(output, 'viewer.scene.json'), viewerContent);
  const viewerHarness = path.join(output, 'viewer-harness.html');
  await writeFile(viewerHarness, (await readFile('src/player/index.html', 'utf8'))
    .replace('./main.tsx', '/src/player/main.tsx')
    .replace('</body>', '<script type="module" src="/output/playwright/chart-marker-ring/viewer-entry.ts"></script></body>'));
  const viewerBuild = path.join(output, 'viewer-build');
  await build({ configFile: false, root: process.cwd(), base: '/', plugins: [react()], logLevel: 'warn',
    cacheDir: path.join(output, 'viewer-vite-cache'), build: { outDir: viewerBuild, copyPublicDir: false, emptyOutDir: false,
      rollupOptions: { input: viewerHarness } } });
  viewerServer = await preview({ configFile: false, root: process.cwd(), build: { outDir: viewerBuild },
    preview: { host: '127.0.0.1', port: 0, strictPort: false } });
  const viewer = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  viewer.setDefaultTimeout(60000);
  viewer.on('pageerror', error => errors.push(error.message));
  await viewer.route('**/runtime-config.json', route => route.fulfill({ json: {
    version: 1, page: { title: '环形立标独立Viewer验收', loadingText: '加载中', backgroundColor: '#101827' },
    paths: { scene: './scene.json', assetManifest: './asset-manifest.json', assetBase: './' },
    viewer: { showGrid: true, allowCameraControl: true, showStatusOverlay: false },
    mqtt: { ...source.scene.mqttConfig, enabled: false, address: '', subscriptions: [] },
  } }));
  await viewer.route('**/scene.json', route => route.fulfill({ contentType: 'application/json', body: viewerContent }));
  await viewer.route('**/asset-manifest.json', route => route.fulfill({ json: { version: 1, assets: [] } }));
  console.log('启动独立Viewer');
  await viewer.goto(viewerServer.resolvedUrls.local[0] + 'output/playwright/chart-marker-ring/viewer-harness.html', { timeout: 180000 });
  await viewer.waitForFunction(() => window.ringScene?.()?.meshes.some(mesh => mesh.metadata?.editorChartMarker), null, { timeout: 180000 });
  await frames(viewer);
  const viewerGeometry = await meshInfo(viewer, id);
  assert.equal(viewerGeometry.indices, 576);
  assert.equal(viewerGeometry.holeHit, false);
  await setCamera(viewer, geometry.center);
  const viewerPixels = await pixelStats(viewer, await capture(viewer, 'viewer-ring.png'));
  assert.ok(viewerPixels.cyan > 1000, JSON.stringify(viewerPixels));
  await setCamera(viewer, geometry.center, true);
  await capture(viewer, 'viewer-top-hole.png');
  checks.push('standalone-viewer-scene-load', 'standalone-viewer-webgl-ring-and-hole');
  assert.deepEqual(errors, []);
  const result = { ok: true, id, checks, geometry, viewerGeometry, pixels, previewPixels, viewerPixels, repeatChangedPixels: changedPixels, beforeOrbit, afterOrbit, errors };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.bringToFront();
    const diagnostic = await page.evaluate(() => ({ preparation: window.ringPreparation?.getScenePreparationSnapshot(),
      sceneSessionId: window.ringStore?.getState().sceneSessionId,
      sceneStartupResourceSessionId: window.ringStore?.getState().sceneStartupResourceSessionId,
      scenes: window.ringCore?.EngineStore.Instances.flatMap(engine => engine.scenes).map(scene => ({ name: scene.name, frame: scene.getFrameId(), ready: scene.isReady(), pendingData: scene.getWaitingItemsCount(),
        meshes: scene.meshes.map(mesh => ({ name: mesh.name, ready: mesh.isReady(true), enabled: mesh.isEnabled(), material: mesh.material?.getClassName(), materialName: mesh.material?.name, visible: mesh.isVisible, materialReady: mesh.material?.isReady(mesh), vertices: mesh.getTotalVertices() })),
        textures: scene.textures.map(texture => ({ name: texture.name?.slice(0,160), type: texture.getClassName(), ready: texture.isReady() })) })),
      logs: window.ringStore?.getState().logs.slice(0, 12) })).catch(error => ({ error: String(error) }));
    await writeFile(path.join(output, 'diagnostic.json'), JSON.stringify(diagnostic, null, 2));
    console.error('FAILURE_DIAGNOSTIC', JSON.stringify(diagnostic));
  }
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: String(error), checks, errors }, null, 2));
  throw error;
} finally {
  await browser?.close();
  if (viewerServer) await new Promise((resolve, reject) => viewerServer.httpServer.close(error => error ? reject(error) : resolve()));
  if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
