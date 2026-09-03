import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
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
  await page.route('**/__chart_background__.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#17627a"/></svg>' }));
  page.on('pageerror', (error) => errors.push(error.message));
  const source = { id: 'fixture-screen', chartType: 'SCREEN', projectId: '1', screenId: '2', name: '产线实时监控', screenName: '产线实时监控', screenUrl: `${url}__chart_marker_fixture__` };
  const themeSource = { id: 'fixture-theme', chartType: 'SCREEN', projectId: '1', screenId: '3', name: '工站信息', screenName: '工站信息', screenUrl: 'https://theme.example.test/screen-fixture' };
  const themeHtml = fixtureHtml.replaceAll('产线实时监控', '工站信息').replace('window.instanceId=', "window.addEventListener('message', event => { window.themeSelection = event.data; });window.instanceId=");
  await page.route(themeSource.screenUrl, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: themeHtml }));
  await page.addInitScript(({ screen, theme }) => {
    window.editorApi = {
      listProjectAssets: async () => ({ projectRoot: 'fixture', assets: [], skyboxes: [], skyboxSyncContextKey: 'fixture:1' }),
      listSyncedImages: async () => [{ id: 'background-fixture', name: '背景拖拽验证', reference: 'editor-image://platform/chart_bg', sourceUrl: new URL('__chart_background__.svg', screen.screenUrl).href, iconKey: 'chart_bg', fileName: 'chart_bg.svg', filePath: 'fixture/chart_bg.svg', updatedAt: '' }],
      listDataPlatformCharts: async () => ({ contextKey: 'fixture:1', projectId: '1', charts: [screen, theme] }),
      syncDataPlatformCharts: async () => false,
      getRecentWorkspaces: async () => ({ projects: [], scenes: [] }),
      getDataPlatformConfig: async () => ({ baseUrl: '', workspaceRoot: '', usesDefaultWorkspace: true }),
      listDataPlatformProjects: async () => ({ records: [], total: 0 }),
    };
  }, { screen: source, theme: themeSource });
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
  const builtin = page.locator('[data-chart-marker-builtin]');
  await builtin.waitFor();
  await page.getByLabel('文本内容', { exact: true }).fill('一次注液');
  await page.getByLabel('文本大小', { exact: true }).fill('42');
  await page.getByLabel('文本大小', { exact: true }).press('Tab');
  await page.getByLabel('尺寸 X（px）', { exact: true }).fill('400');
  await page.getByLabel('尺寸 X（px）', { exact: true }).press('Tab');
  await page.getByLabel('悬浮高度（m）', { exact: true }).fill('2');
  await page.getByLabel('悬浮高度（m）', { exact: true }).press('Tab');
  await page.waitForFunction(() => document.querySelector('[data-chart-marker-text]')?.textContent === '一次注液');
  assert.equal(await builtin.locator('[data-chart-marker-text]').evaluate(el => el.style.fontSize), '42px');
  await page.getByLabel('开启跑马灯', { exact: true }).check();
  await page.waitForFunction(() => document.querySelector('[data-chart-marker-text]')?.getAnimations().length === 1);
  await page.waitForFunction(() => document.querySelector('[data-chart-marker-text]')?.getAnimations()[0]?.currentTime > 200);
  const marqueeTime = await page.locator('[data-chart-marker-text]').evaluate(el => el.getAnimations()[0].currentTime);
  await page.getByLabel('文本内容', { exact: true }).fill('二次注液');
  assert.ok(await page.locator('[data-chart-marker-text]').evaluate(el => el.getAnimations()[0].currentTime) >= marqueeTime, '实时文本变化必须保留跑马灯进度');
  await page.getByLabel('文本内容', { exact: true }).fill('一次注液');
  await page.getByLabel('开启跑马灯', { exact: true }).uncheck();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
  await page.getByLabel('选择背景图片', { exact: true }).setInputFiles({ name: 'background.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction((id) => window.chartSmokeStore.getState().scene.entities[id].components.chartMarker.backgroundImage.startsWith('data:image/png;base64,'), markerId);
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await page.getByRole('button', { name: '图片库', exact: true }).click();
  const backgroundSlot = page.getByLabel('图表立标背景图片槽位');
  await page.getByRole('button', { name: /方向箭头发光贴图/ }).first().dragTo(backgroundSlot);
  await page.waitForFunction((id) => window.chartSmokeStore.getState().scene.entities[id].components.chartMarker.backgroundImage.startsWith('data:image/png;base64,'), markerId);
  const builtinBackground = await page.evaluate((id) => window.chartSmokeStore.getState().scene.entities[id].components.chartMarker.backgroundImage, markerId);
  await page.evaluate(() => window.chartSmokeStore.getState().undo());
  assert.equal(await page.evaluate((id) => window.chartSmokeStore.getState().scene.entities[id].components.chartMarker.backgroundImage, markerId), '');
  await page.evaluate(() => window.chartSmokeStore.getState().redo());
  assert.equal(await page.evaluate((id) => window.chartSmokeStore.getState().scene.entities[id].components.chartMarker.backgroundImage, markerId), builtinBackground);
  await backgroundSlot.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData('application/x-babylon-editor-image-asset', JSON.stringify({ id: 'fake', name: 'fake', reference: 'fake', sourceUrl: 'https://invalid.example/bg.png' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  await page.getByRole('alert').filter({ hasText: '请从编辑器图片库拖入有效图片' }).waitFor();
  assert.equal(await page.evaluate((id) => window.chartSmokeStore.getState().scene.entities[id].components.chartMarker.backgroundImage, markerId), builtinBackground);
  await page.getByRole('button', { name: /背景拖拽验证/ }).first().dragTo(backgroundSlot);
  await page.waitForFunction((previous) => {
    const marker = window.chartSmokeStore.getState().scene.entities[window.chartSmokeStore.getState().scene.selectedEntityId];
    return marker.components.chartMarker.backgroundImage.startsWith('data:image/png;base64,') && marker.components.chartMarker.backgroundImage !== previous;
  }, builtinBackground);
  await page.evaluate(async (id) => {
    const { serializeScene, deserializeScene } = await import('/src/editor/project/SceneSerializer.ts');
    const state = window.chartSmokeStore.getState();
    window.chartBackgroundForExport = state.scene.entities[id].components.chartMarker.backgroundImage;
    if (deserializeScene(serializeScene(state.scene)).entities[id].components.chartMarker.backgroundImage !== window.chartBackgroundForExport) throw new Error('背景图片保存重开不一致');
  }, markerId);
  await page.evaluate((id) => window.chartSmokeStore.getState().requestSceneFocusForSelection([id]), markerId);
  await canvas.hover();
  await page.mouse.wheel(0, 700);
  await page.getByLabel('文本内容', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, 'properties.png') });
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
  await page.getByLabel('背景颜色', { exact: true }).fill('#123456');
  await page.getByLabel('尺寸 Y（px）', { exact: true }).fill('200');
  await page.getByLabel('尺寸 Y（px）', { exact: true }).press('Tab');
  assert.equal(await frame.evaluate(() => window.instanceId), instanceId, '调整外观和尺寸不得重载已绑定大屏');
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

  // 新建第二块内置面板，验证运行点击及独立 Viewer 的属性恢复。
  const builtinId = await page.evaluate((id) => {
    const store = window.chartSmokeStore;
    const p = store.getState().scene.entities[id].components.transform.position;
    store.getState().createChartMarker({ x: p.x + 5, y: 0, z: p.z });
    const nextId = store.getState().scene.selectedEntityId;
    store.getState().updateChartMarker(nextId, { text: '内置面板导出验证', fontSize: 32, clickAction: 'focus', width: 360, backgroundColor: '#1285aa', backgroundImage: window.chartBackgroundForExport });
    store.getState().requestSceneFocusForSelection([nextId]);
    return nextId;
  }, markerId);
  const bodyPoint = async (browserPage, id) => browserPage.locator('[data-screen-entity-id="' + id + '"] [data-chart-marker-text]').evaluate(el => {
    const box = el.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  await page.locator('[data-screen-entity-id="' + builtinId + '"] [data-chart-marker-text]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-chart-marker-action]').count(), 0, '立标不应显示事件按钮');
  await canvas.hover();
  await page.mouse.wheel(0, 500);
  await page.evaluate(() => window.chartSmokeStore.getState().startRuntimePreview());
  const firstClick = await bodyPoint(page, builtinId);
  await page.mouse.click(firstClick.x, firstClick.y);
  await page.waitForFunction((id) => {
    const text = document.querySelector('[data-screen-entity-id="' + id + '"] [data-chart-marker-text]');
    const rect = text.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === document.querySelector('canvas.scene-canvas');
  }, builtinId);
  await page.evaluate(() => window.chartSmokeStore.getState().stopRuntimePreview());
  // 从旧单动作配置进入事件列表，添加不同目标并验证增删不会误改前项。
  await page.evaluate(id => window.chartSmokeStore.getState().selectEntity(id), builtinId);
  await page.getByLabel('点击事件 1 添加动作', { exact: true }).click();
  await page.getByLabel('点击事件 1 动作 2 类型', { exact: true }).selectOption('select');
  await page.getByLabel('点击事件 1 动作 2 目标对象', { exact: true }).selectOption(markerId);
  await page.getByLabel('添加点击事件', { exact: true }).click();
  await page.getByLabel('删除点击事件 2', { exact: true }).click();
  await page.getByLabel('点击事件 1 添加动作', { exact: true }).click();
  await page.getByLabel('删除点击事件 1 动作 3', { exact: true }).click();
  assert.deepEqual(await page.evaluate(id => window.chartSmokeStore.getState().scene.entities[id].components.chartMarker.clickEvents, builtinId), [
    { type: 'left-click', actions: [{ type: 'focus', targetEntityId: builtinId }, { type: 'select', targetEntityId: markerId }] },
  ]);
  await page.getByLabel('点击事件 1 类型', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, 'click-events.png') });
  await page.evaluate(() => window.chartSmokeStore.getState().startRuntimePreview());
  let point = await bodyPoint(page, builtinId);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  assert.equal(await page.evaluate(() => window.chartSmokeStore.getState().scene.selectedEntityId), null, '右键不能执行左键动作');
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(id => window.chartSmokeStore.getState().scene.selectedEntityId === id, markerId);
  // 聚焦动作与选中动作具有独立目标，正文点击不依赖角落按钮。
  await page.evaluate(() => window.chartSmokeStore.getState().selectEntity(null));
  point = await bodyPoint(page, builtinId);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 28, point.y + 15, { steps: 5 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.chartSmokeStore.getState().scene.selectedEntityId), null, '相机拖拽不能误触动作');
  await page.evaluate(() => window.chartSmokeStore.getState().stopRuntimePreview());
  // 主题动作使用独立的大屏引用，拖放只修改当前动作。
  await page.evaluate(id => window.chartSmokeStore.getState().selectEntity(id), builtinId);
  await page.getByLabel('点击事件 1 添加动作', { exact: true }).click();
  await page.getByLabel('点击事件 1 动作 3 类型', { exact: true }).selectOption('theme');
  const themeSlot = page.getByLabel('点击事件 1 动作 3 目标主题槽位', { exact: true });
  const themeCard = page.getByRole('button', { name: /工站信息/ }).first();
  await chart.dragTo(themeSlot);
  assert.ok(await themeSlot.textContent().then(text => text.includes('产线实时监控')));
  await themeCard.dragTo(themeSlot);
  assert.ok(await themeSlot.textContent().then(text => text.includes('工站信息')));
  await themeSlot.evaluate(el => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-babylon-editor-data-platform-screen', JSON.stringify({ chartType: 'SCREEN', projectId: 'x', screenId: 'x', name: '无效', screenUrl: 'javascript:alert(1)' }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
  });
  await page.getByRole('alert').filter({ hasText: '请拖入图表库中具有有效页面地址的完整大屏' }).waitFor();
  assert.ok(await themeSlot.textContent().then(text => text.includes('工站信息')), '非法拖入应保留原主题');
  await page.getByLabel('清空点击事件 1 动作 3 目标主题', { exact: true }).click();
  assert.equal(await page.evaluate(id => window.chartSmokeStore.getState().scene.entities[id].components.chartMarker.clickEvents[0].actions[2].screen, builtinId), undefined);
  await page.evaluate(() => window.chartSmokeStore.getState().undo());
  assert.ok(await themeSlot.textContent().then(text => text.includes('工站信息')));
  await page.evaluate(() => window.chartSmokeStore.getState().redo());
  await themeCard.dragTo(themeSlot);
  await page.evaluate(id => {
    const state = window.chartSmokeStore.getState();
    if (state.scene.entities[id].components.dataPlatformScreen) throw Error('主题拖入不应修改立标面板内容');
    if (state.scene.sceneSettings.viewportScreen) throw Error('主题绑定不应直接修改场景大屏');
    state.requestSceneFocusForSelection([id]);
  }, builtinId);
  await page.screenshot({ path: path.join(outputDir, 'theme-action.png') });
  await page.evaluate(() => window.chartSmokeStore.getState().startRuntimePreview());
  const themeClick = await bodyPoint(page, builtinId);
  await page.mouse.click(themeClick.x, themeClick.y);
  await page.waitForFunction(() => window.chartSmokeStore.getState().logs.some(log => JSON.stringify(log).includes('编辑器预览未连接大屏宿主')));
  assert.equal(await page.locator('iframe[src="' + themeSource.screenUrl + '"]').count(), 0, '编辑器预览不能在立标或 Viewer 中加载主题');
  await page.evaluate(() => window.chartSmokeStore.getState().stopRuntimePreview());
  // 读取真实序列化输出，交给构建后的独立 Viewer 启动链路。
  const sceneContent = await page.evaluate(async (id) => {
    const { serializeScene } = await import('/src/editor/project/SceneSerializer.ts');
    const scene = structuredClone(window.chartSmokeStore.getState().scene);
    scene.sceneSettings.camera.savedPose = { alpha: Math.PI / 2, beta: Math.PI / 2, radius: 14, target: { ...scene.entities[id].components.transform.position, x: scene.entities[id].components.transform.position.x + 2.5 } };
    return serializeScene(scene);
  }, markerId);
  await writeFile(path.join(outputDir, 'scene.json'), sceneContent, 'utf8');
  await writeFile(path.join(outputDir, 'fixture.json'), JSON.stringify({ markerId, builtinId }), 'utf8');
  const scene = JSON.parse(sceneContent).scene;
  viewerServer = await preview({ configFile: 'vite.viewer.config.ts', preview: { host: '127.0.0.1', port: 5189, strictPort: false } });
  const viewer = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  viewer.on('pageerror', (error) => errors.push(error.message));
  await viewer.route(themeSource.screenUrl, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: themeHtml }));
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
  assert.equal(await viewer.locator('[data-screen-entity-id="' + builtinId + '"] [data-chart-marker-text]').textContent(), '内置面板导出验证');
  await viewerFrame.locator('#action').click();
  assert.equal(await viewerFrame.locator('#action').innerText(), '已查看');
  assert.ok(await viewer.locator('[data-screen-entity-id="' + builtinId + '"] [data-chart-marker-builtin] > div').first().evaluate(el => el.style.backgroundImage.includes('data:image/png;base64,')), 'Viewer 必须恢复图片库背景且不依赖编辑器资源URL');
  await viewerFrame.evaluate(() => { window.markerSelections = []; window.addEventListener('message', event => window.markerSelections.push(event.data)); });
  const viewerBody = await bodyPoint(viewer, builtinId);
  await viewer.mouse.click(viewerBody.x, viewerBody.y);
  await viewerFrame.waitForFunction(id => window.markerSelections.some(message => JSON.stringify(message).includes(id)), markerId);
  assert.equal(await viewer.locator('[data-chart-marker-action]').count(), 0, 'Viewer 立标不应显示事件按钮');
  await viewer.getByText('主题展示未发送：请从数据中台大屏中打开当前数字孪生，并确认主题与当前项目一致。', { exact: true }).waitFor();
  assert.equal(await viewer.locator('iframe[src="' + themeSource.screenUrl + '"]').count(), 0, '独立 Viewer 不应自行展示主题大屏');
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
