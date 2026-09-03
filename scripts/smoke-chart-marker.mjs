import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright';

const outputDir = path.resolve('output/playwright/chart-marker');
await mkdir(outputDir, { recursive: true });
let browser;
let page;
let viewerServer;
const errors = [];
const fixtureHtml = `<!doctype html><html><body style="margin:0;background:#061928;color:#7de3ff;font:48px sans-serif;display:grid;place-items:center;height:100vh"><main><h1>产线实时监控</h1><p>运行设备 <strong id="value">0</strong></p><button id="action" style="font:32px sans-serif">查看设备</button></main><script>window.instanceId=crypto.randomUUID();let n=0;setInterval(()=>document.querySelector('#value').textContent=++n,250);document.querySelector('#action').onclick=()=>document.querySelector('#action').textContent='已查看';</script></body></html>`;
const server = await createServer({ server: { port: 0, strictPort: false, hmr: false } });
try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(30_000);
  await page.route('**/__chart_marker_fixture__', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml }));
  page.on('pageerror', (error) => errors.push(error.message));
  const source = { id: 'fixture-screen', chartType: 'SCREEN', projectId: '1', screenId: '2', name: '产线实时监控', screenName: '产线实时监控', screenUrl: `${url}__chart_marker_fixture__` };
  await page.addInitScript((screen) => {
    window.editorApi = {
      listProjectAssets: async () => ({ projectRoot: 'fixture', assets: [], skyboxes: [], skyboxSyncContextKey: 'fixture:1' }),
      listDataPlatformCharts: async () => ({ contextKey: 'fixture:1', projectId: '1', charts: [screen] }),
      syncDataPlatformCharts: async () => false,
      getRecentWorkspaces: async () => ({ projects: [], scenes: [] }),
      getDataPlatformConfig: async () => ({ baseUrl: '', workspaceRoot: '', usesDefaultWorkspace: true }),
      listDataPlatformProjects: async () => ({ records: [], total: 0 }),
    };
  }, source);
  await page.goto(url);
  await page.getByRole('button', { name: '进入空白编辑器' }).click();
  await page.locator('canvas.scene-canvas').waitFor({ state: 'visible' });
  await page.evaluate(async () => {
    window.chartSmokeStore = (await import('/src/editor/store/editorStore.ts')).useEditorStore;
  });
  await page.getByRole('button', { name: 'POI库', exact: true }).click();
  const canvas = page.locator('canvas.scene-canvas');
  const card = page.getByRole('button', { name: /图表立标/ }).first();
  await card.dragTo(canvas);
  await page.waitForFunction(() => Object.values(window.chartSmokeStore.getState().scene.entities).some((entity) => entity.components.chartMarker));
  const markerId = await page.evaluate(() => window.chartSmokeStore.getState().scene.selectedEntityId);
  await page.getByRole('button', { name: '图表库', exact: true }).click();
  const chart = page.getByRole('button', { name: /产线实时监控/ }).first();
  const slot = page.getByLabel('图表立标大屏槽位');
  await chart.dragTo(slot);
  await page.waitForFunction((id) => Boolean(window.chartSmokeStore.getState().scene.entities[id].components.dataPlatformScreen), markerId);
  const iframe = page.locator(`[data-screen-entity-id="${markerId}"] iframe`);
  await iframe.waitFor();
  const frame = await iframe.elementHandle().then((handle) => handle.contentFrame());
  await frame.waitForFunction(() => Number(document.querySelector('#value')?.textContent) >= 2);
  const instanceId = await frame.evaluate(() => window.instanceId);
  const value = await frame.locator('#value').innerText();
  await frame.waitForFunction((before) => Number(document.querySelector('#value').textContent) > before, Number(value));
  assert.equal(await frame.evaluate(() => window.instanceId), instanceId, '实时更新不得重载 iframe');

  await page.evaluate((id) => {
    const store = window.chartSmokeStore;
    store.getState().selectEntity(id);
    store.getState().requestSceneFocusForSelection([id]);
  }, markerId);
  await page.screenshot({ path: path.join(outputDir, 'bound.png') });
  await page.getByRole('button', { name: '清空大屏', exact: true }).click();
  await iframe.waitFor({ state: 'detached' });
  await page.evaluate(() => window.chartSmokeStore.getState().undo());
  await iframe.waitFor();
  await page.getByRole('button', { name: '清空大屏', exact: true }).click();
  await iframe.waitFor({ state: 'detached' });

  // 第二次通过场景上的真实拾取位置绑定，覆盖 Canvas drop 分支。
  const overlay = page.locator(`[data-screen-entity-id="${markerId}"]`);
  const rect = await overlay.boundingBox();
  const canvasRect = await canvas.boundingBox();
  await chart.dragTo(canvas, { targetPosition: { x: rect.x + rect.width / 2 - canvasRect.x, y: rect.y + rect.height / 2 - canvasRect.y } });
  await iframe.waitFor();
  await page.evaluate(() => {
    window.chartSmokeStore.setState(({ scene }) => ({ scene: { ...scene, mqttConfig: { ...scene.mqttConfig, enabled: true, simulatorEnabled: true } } }));
    const result = window.chartSmokeStore.getState().startRuntimePreview();
    if (!result.ok) throw new Error(result.message);
  });
  await page.waitForFunction(() => window.chartSmokeStore.getState().runtimeMode === 'preview');
  const liveFrame = await iframe.elementHandle().then((handle) => handle.contentFrame());
  await liveFrame.locator('#action').click();
  assert.equal(await liveFrame.locator('#action').innerText(), '已查看');
  await page.evaluate(() => window.chartSmokeStore.getState().stopRuntimePreview());
  // 进入预览会清空编辑选区；回到编辑态后重新选中立标才能操作 Inspector。
  await page.locator('.entity-tree-name').filter({ hasText: /^图表立标$/ }).click();
  await page.getByRole('button', { name: '刷新内容', exact: true }).click();
  await page.waitForFunction((id) => document.querySelector(`[data-screen-entity-id="${id}"] iframe`)?.contentWindow?.document.querySelector('#action')?.textContent === '查看设备', markerId);
  await page.screenshot({ path: path.join(outputDir, 'completed.png') });

  // 读取真实序列化输出，交给构建后的独立 Viewer 启动链路。
  const sceneContent = await page.evaluate(async (id) => {
    const { serializeScene } = await import('/src/editor/project/SceneSerializer.ts');
    const scene = structuredClone(window.chartSmokeStore.getState().scene);
    scene.sceneSettings.camera.savedPose = { alpha: Math.PI / 2, beta: Math.PI / 2, radius: 8, target: scene.entities[id].components.transform.position };
    return serializeScene(scene);
  }, markerId);
  const scene = JSON.parse(sceneContent).scene;
  viewerServer = await preview({ configFile: 'vite.viewer.config.ts', preview: { host: '127.0.0.1', port: 5189, strictPort: false } });
  const viewer = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  viewer.on('pageerror', (error) => errors.push(error.message));
  await viewer.route('**/__chart_marker_fixture__', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml }));
  await viewer.route('**/runtime-config.json', (route) => route.fulfill({ json: {
    version: 1,
    page: { title: '图表立标验证', loadingText: '加载中', backgroundColor: '#101827' },
    paths: { scene: './scene.json', assetManifest: './asset-manifest.json', assetBase: './' },
    viewer: { showGrid: true, allowCameraControl: true, showStatusOverlay: false },
    mqtt: { ...scene.mqttConfig, enabled: false, address: '', subscriptions: [] },
  } }));
  await viewer.route('**/scene.json', (route) => route.fulfill({ contentType: 'application/json', body: sceneContent }));
  await viewer.route('**/asset-manifest.json', (route) => route.fulfill({ json: { version: 1, assets: [] } }));
  await viewer.goto(viewerServer.resolvedUrls.local[0]);
  const viewerFrameElement = viewer.locator(`[data-screen-entity-id="${markerId}"] iframe`);
  await viewerFrameElement.waitFor({ timeout: 60_000 });
  const viewerFrame = await viewerFrameElement.elementHandle().then((handle) => handle.contentFrame());
  await viewerFrame.waitForFunction(() => Number(document.querySelector('#value')?.textContent) >= 2);
  await viewerFrame.locator('#action').click();
  assert.equal(await viewerFrame.locator('#action').innerText(), '已查看');
  await viewer.screenshot({ path: path.join(outputDir, 'viewer.png') });
  assert.deepEqual(errors, [], '不得产生 renderer 异常');
  console.log(JSON.stringify({ ok: true, markerId, liveValue: value, screenshots: outputDir }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(outputDir, 'failure.png') });
    console.error(JSON.stringify({ errors, frames: page.frames().map((frame) => frame.url()) }));
  }
  throw error;
} finally {
  await browser?.close();
  if (viewerServer) await new Promise((resolve, reject) => viewerServer.httpServer.close((error) => error ? reject(error) : resolve()));
  await server.close();
}
