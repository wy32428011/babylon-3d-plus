/* global window */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/render-optimization-q1-20261024/b3/ui');
await fs.mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(output, 'vite-cache'), appType: 'custom',
  // 验收目录含历史HTML；限定依赖，不能让默认扫描遍历整个output树。
  optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'zustand'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
server.middlewares.use('/__b3__', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__b3__', `<!doctype html><meta charset="utf-8"><title>B3 新场景自动设备</title>
  <style>body{margin:0;background:#171a20;color:#eee;font-family:Segoe UI,sans-serif}</style><div id="root"></div>
  <script type="module">
    import {createElement} from 'react';
    import {createRoot} from 'react-dom/client';
    import {LightingBakeManager} from '/src/editor/panels/LightingBakeManager.tsx';
    import {useEditorStore} from '/src/editor/store/editorStore.ts';
    import {createEmptySceneDocument} from '/src/editor/model/SceneDocument.ts';
    import {serializeScene,deserializeScene} from '/src/editor/project/SceneSerializer.ts';
    window.b3={store:useEditorStore,createEmptySceneDocument,serializeScene,deserializeScene};
    useEditorStore.getState().resetSceneToBlank(); useEditorStore.getState().openLightingManager();
    createRoot(document.getElementById('root')).render(createElement(LightingBakeManager));
    window.b3.ready=true;
  </script>`));
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.B3_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors = [];
  const pageError = new Promise((_, reject) => page.once('pageerror', reject));
  // 监听早于goto；导航期间已失败时也由下面race处理，避免未捕获拒绝中断finally。
  void pageError.catch(() => {});
  page.on('pageerror', error => { errors.push(error.message); console.error('B3_PAGE_ERROR ' + error.message); });
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__b3__');
  await Promise.race([page.waitForFunction(() => window.b3?.ready, undefined, { timeout: 90000 }), pageError]);
  const device = page.getByLabel('烘焙计算设备', { exact: true });
  await device.waitFor({ state: 'visible', timeout: 90000 });
  assert.equal(await device.inputValue(), 'auto');
  const labels = await device.locator('option').allTextContents();
  assert.ok(labels.includes('自动选择可用设备（新场景默认）')); assert.ok(labels.includes('CPU')); assert.ok(!labels.includes('CPU（默认）'));
  await page.screenshot({ path: path.join(output, 'new-auto.png') });
  const fresh = await page.evaluate(() => {
    const scene = window.b3.store.getState().scene, serialized = window.b3.serializeScene(scene);
    return { device: scene.sceneSettings.lighting.bake.device, serialized, reopened: window.b3.deserializeScene(serialized).sceneSettings.lighting.bake.device };
  });
  assert.equal(fresh.device, 'auto'); assert.equal(fresh.reopened, 'auto');
  const load = async mode => {
    await page.evaluate(mode => {
      const scene = window.b3.createEmptySceneDocument('B3 ' + mode);
      if (mode === 'old') delete scene.sceneSettings.lighting.bake.device;
      else scene.sceneSettings.lighting.bake.device = mode;
      const content = window.b3.serializeScene(scene);
      if (!window.b3.store.getState().loadSceneFromContent(content)) throw new Error('Actual scene load failed');
      window.b3.store.getState().openLightingManager();
    }, mode);
    await device.waitFor({ state: 'visible' });
  };
  await load('old'); assert.equal(await device.inputValue(), 'cpu');
  const old = await page.evaluate(() => {
    const scene = window.b3.store.getState().scene, serialized = window.b3.serializeScene(scene);
    return { hasDevice: Object.hasOwn(scene.sceneSettings.lighting.bake, 'device'), serialized };
  });
  assert.equal(old.hasDevice, false);
  await page.screenshot({ path: path.join(output, 'old-cpu.png') });
  await load('gpu'); assert.equal(await device.inputValue(), 'gpu');
  await device.selectOption('auto');
  await page.getByRole('button', { name: '应用配置', exact: true }).click();
  await page.waitForFunction(() => window.b3.store.getState().scene.sceneSettings.lighting.bake.device === 'auto');
  const applied = await page.evaluate(() => {
    const serialized = window.b3.serializeScene(window.b3.store.getState().scene);
    return { device: window.b3.deserializeScene(serialized).sceneSettings.lighting.bake.device, serialized };
  });
  assert.equal(applied.device, 'auto'); assert.deepEqual(errors, []);
  const report = { status: 'PASS', ui: 'actual LightingBakeManager, editorStore actions, SceneSerializer in Chrome',
    labels, newScene: fresh, oldScene: old, explicitGpuOnLoad: 'gpu', applied, errors,
    gpuExecution: 'deferred by user; no bake launched' };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('LIGHTING_NEW_SCENE_DEVICE_UI_PASS ' + JSON.stringify({ status: report.status, newDevice: fresh.device, oldDevice: 'cpu', applied: applied.device, errors }));
} finally { await browser?.close(); await server.close(); }
