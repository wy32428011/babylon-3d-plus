import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/builtin-skybox');
await mkdir(output, { recursive: true });
// 元数据由真实后台 listProjectAssets(null) 输出，避免假造内置条目掩盖注册缺陷。
const assetList = JSON.parse(await readFile(process.argv[2] ?? path.join(output, 'asset-list.json'), 'utf8'));
const builtin = assetList.skyboxes.find(asset => asset.id === 'builtin-skybox:partly-cloudy-light');
assert.ok(builtin, '无项目时后台仍应返回内置天空盒');
assert.equal(builtin.source, 'builtin');
const hdr = await readFile(builtin.path);
assert.equal(hdr.length, 1441554);
const server = await createServer({ configFile: false, plugins: [react()],
  cacheDir: path.join(output, 'vite-cache'), optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'zustand', 'zustand/shallow', '@linkiez/dxf-renew', 'mqtt', 'lodash/cloneDeep'] },
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
let browser, page;
const errors = [], requests = [];
try {
  await server.listen();
  await server.watcher.close();
  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('requestfailed', request => console.error('requestfailed', request.url(), request.failure()?.errorText));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.addInitScript(list => {
    window.builtinSourceUrl = list.skyboxes.find(asset => asset.id === 'builtin-skybox:partly-cloudy-light').sourceUrl;
    window.editorApi = {
      listProjectAssets: async () => list,
      listSyncedImages: async () => [],
      listDataPlatformCharts: async () => ({ contextKey: 'builtin-smoke', projectId: null, charts: [] }),
      getDataPlatformConfig: async () => ({ baseUrl: '', workspaceRoot: '', usesDefaultWorkspace: true }),
    };
  }, assetList);
  await page.route('**/__builtin_hdr__*', async route => {
    requests.push({ url: route.request().url(), bytes: hdr.length });
    await route.fulfill({ contentType: 'application/octet-stream', body: hdr });
  });
  const html = await server.transformIndexHtml('/__builtin_skybox__', '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/builtinSkybox.harness.tsx"></script></body></html>');
  await page.route('**/__builtin_skybox__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__builtin_skybox__', { waitUntil: 'commit' });
  await page.getByRole('button', { name: '天空盒库', exact: true }).click();
  const card = page.locator('.project-panel .skybox-resource-card', { hasText: builtin.displayName });
  // 部分布局没有 project-panel 类，限定 ProjectPanel 的底部资源库容器。
  const resource = (await card.count()) ? card : page.locator('.skybox-resource-card', { hasText: builtin.displayName });
  await resource.waitFor();
  assert.match(await resource.textContent(), /内置/);
  await page.screenshot({ path: path.join(output, 'library.png') });
  await resource.click();
  await page.waitForFunction(() => window.builtinSkyboxHarness.ready(), null, { timeout: 150000 });
  assert.equal(await page.evaluate(() => window.builtinSkyboxHarness.skyboxes().length), 1);
  await page.evaluate(() => window.builtinSkyboxHarness.settings());
  await page.locator('.skybox-preview-button').click();
  const dialog = page.getByRole('dialog', { name: '选择天空盒' });
  await dialog.locator('.skybox-resource-card', { hasText: builtin.displayName }).waitFor();
  await page.screenshot({ path: path.join(output, 'selection-dialog.png') });
  await dialog.locator('.skybox-resource-card', { hasText: builtin.displayName }).click();
  await page.getByTitle('天空盒水平旋转角度（度）').fill('37');
  await page.locator('.scene-slider-row', { hasText: '环境强度' }).locator('input[type=number]').fill('0.8');
  await page.locator('.skybox-resolution-row select').selectOption('256');
  await page.waitForFunction(() => window.builtinSkyboxHarness.ready());
  const saved = await page.evaluate(() => window.builtinSkyboxHarness.save());
  await writeFile(path.join(output, 'saved.scene.json'), saved);
  await page.evaluate(content => window.builtinSkyboxHarness.reopen(content), saved);
  await page.waitForFunction(() => window.builtinSkyboxHarness.ready(), null, { timeout: 150000 });
  const params = await page.evaluate(() => window.builtinSkyboxHarness.skyboxes()[0].components.skybox);
  const rotation = await page.evaluate(() => window.builtinSkyboxHarness.skyboxes()[0].components.transform.rotation.y);
  assert.ok(Math.abs(rotation - 37 * Math.PI / 180) < 1e-8, '水平旋转保存在唯一天空盒实体Transform中');
  assert.equal(params.intensity, 0.8);
  assert.equal(params.resolution, 256);
  await resource.dragTo(page.locator('canvas.scene-canvas'));
  assert.equal(await page.evaluate(() => window.builtinSkyboxHarness.skyboxes().length), 1, '拖入场景保持唯一天空盒');
  await page.evaluate(() => window.builtinSkyboxHarness.settings());
  await resource.dragTo(page.locator('.skybox-preview-button'));
  assert.equal(await page.evaluate(() => window.builtinSkyboxHarness.skyboxes().length), 1, '拖入属性保持唯一天空盒');
  const frame = await page.evaluate(() => window.builtinSkyboxHarness.scene().getFrameId());
  await page.waitForFunction(frame => window.builtinSkyboxHarness.scene().getFrameId() > frame + 20 && window.builtinSkyboxHarness.ready(), frame);
  await page.screenshot({ path: path.join(output, 'editor.png') });
  await page.evaluate(() => { const result = window.builtinSkyboxHarness.store.getState().startRuntimePreview(); if (!result.ok) throw Error(result.message); });
  await page.waitForFunction(() => window.builtinSkyboxHarness.ready());
  await page.screenshot({ path: path.join(output, 'preview.png') });
  const canvas = await page.locator('canvas.scene-canvas').screenshot();
  const pixels = await page.evaluate(async imageData => { const image = new Image(); image.src = 'data:image/png;base64,' + imageData; await image.decode(); const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0); const p = ctx.getImageData(0, 0, c.width, c.height).data; let sky = 0; for (let i = 0; i < p.length; i += 4) if (p[i + 2] > p[i] + 8 && p[i + 2] > 80) sky++; return sky; }, canvas.toString('base64'));
  assert.ok(pixels > 10000, '真实 canvas 应有天空颜色像素');
  assert.ok(requests.length > 0, '实际请求并解码内置 HDR');
  assert.deepEqual(errors, []);
  const runtime = await page.evaluate(() => { const s = window.builtinSkyboxHarness.scene(); return { environmentReady: s.environmentTexture.isReady(), environmentIntensity: s.environmentIntensity, frames: s.getFrameId(), renderer: s.getEngine().getGlInfo().renderer }; });
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, params, rotationRadians: rotation, runtime, skyPixels: pixels, requests, errors, checks: ['backend-null-project-registration', 'library-visible', 'card-click', 'settings-dialog', 'save-reopen', 'scene-drag', 'properties-drag', 'unique-skybox', 'preview', 'ibl-ready', 'canvas-pixels'] }, null, 2));
  await page.evaluate(() => { window.builtinSkyboxHarness.store.getState().stopRuntimePreview(); window.builtinSkyboxHarness.dispose(); });
  console.log('PASS: 内置天空盒资源库、选择弹窗、拖放、保存重开、真实 WebGL 与运行预览');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
