import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/chart-marker-video');
await mkdir(output, { recursive: true });
let server, browser, page, viewerServer;
const errors = [];
try {
  // 打包测试入口与真实编辑器共用同一个 Store，避免开发依赖重优化刷新验收页面。
  await writeFile(path.join(output, 'harness-entry.ts'), `
import '/src/main.tsx';
import { useEditorStore } from '/src/editor/store/editorStore.ts';
import * as preparation from '/src/editor/loading/scenePreparationProgress.ts';
import * as serializer from '/src/editor/project/SceneSerializer.ts';
import * as videoTools from '/src/runtime/babylon/chartMarkerVideo.ts';
Object.assign(window, { videoStore: useEditorStore, videoPreparation: preparation, videoSerializer: serializer, videoTools });
`);
  const harnessPath = path.join(output, 'harness.html');
  await writeFile(harnessPath, (await readFile('index.html', 'utf8')).replace('/src/main.tsx', '/output/playwright/chart-marker-video/harness-entry.ts'));
  const editorBuild = path.join(output, 'editor-build');
  if (path.dirname(editorBuild) !== output) throw Error('测试构建目录越界');
  await build({ configFile: false, root: process.cwd(), base: '/', plugins: [react()], logLevel: 'warn',
    build: { outDir: editorBuild, emptyOutDir: true, rollupOptions: { input: harnessPath } } });
  server = await preview({ configFile: false, root: process.cwd(), build: { outDir: editorBuild },
    preview: { host: '127.0.0.1', port: 0, strictPort: false } });
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.editorApi = {
      listProjectAssets: async () => ({ projectRoot: 'fixture', assets: [], skyboxes: [], skyboxSyncContextKey: 'video:1' }),
      listSyncedImages: async () => [],
      listDataPlatformCharts: async () => ({ contextKey: 'video:1', projectId: '1', charts: [] }),
      getRecentWorkspaces: async () => ({ projects: [], scenes: [] }),
      getDataPlatformConfig: async () => ({ baseUrl: '', workspaceRoot: '', usesDefaultWorkspace: true }),
      listDataPlatformProjects: async () => ({ records: [], total: 0 }),
    };
  });
  await page.goto(url + 'output/playwright/chart-marker-video/harness.html', { timeout: 60000 });
  console.log('编辑器页面已加载');
  await page.getByRole('button', { name: '进入空白编辑器' }).click();
  await page.locator('canvas.scene-canvas').waitFor();
  await page.waitForFunction(() => !!window.videoStore);
  await page.waitForFunction(() => {
    const state = window.videoPreparation.getScenePreparationSnapshot();
    return state.sceneSessionId === window.videoStore.getState().sceneSessionId
      && window.videoPreparation.isScenePreparationSettled(state) && !window.videoPreparation.isScenePreparationActive();
  }, null, { timeout: 150000 });
  // 使用 MDN CC0 样片，缓存到忽略的 output；也可通过命令参数指定现场样片。
  const fixturePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(output, 'fixture.webm');
  let body;
  try { body = await readFile(fixturePath); } catch (error) { if (process.argv[2] || error.code !== 'ENOENT') throw error; }
  if (!body || body.length < 1000) {
    const response = await fetch('https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm', { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error('无法取得 MDN CC0 样片，请用命令参数指定本地 WebM');
    body = Buffer.from(await response.arrayBuffer());
    await writeFile(fixturePath, body);
  }
  assert.ok(body.length > 1000, '测试视频必须包含真实帧');
  let requests = 0;
  const routeVideo = async target => {
    await target.route('**/__poi_video.webm*', route => { requests++; return route.fulfill({ contentType: 'video/webm', body }); });
    await target.route('**/__missing_video.webm', route => route.fulfill({ status: 404, body: 'not found' }));
  };
  await routeVideo(page);
  const markerId = await page.evaluate(() => {
    window.videoStore.setState(({ scene }) => ({ scene: { ...scene, mqttConfig: { ...scene.mqttConfig, enabled: true, simulatorEnabled: true } } }));
    const state = window.videoStore.getState(); state.createChartMarker({ x: 0, y: 0, z: 0 });
    const id = window.videoStore.getState().scene.selectedEntityId;
    state.updateChartMarker(id, { width: 640, height: 360, faceCamera: true });
    state.requestSceneFocusForSelection([id]);
    return id;
  });
  await page.getByLabel('关联类型', { exact: true }).selectOption('video');
  await page.waitForFunction(() => !window.videoPreparation.isScenePreparationActive());
  await page.getByLabel('视频 URL', { exact: true }).fill(url + '__poi_video.webm');
  await page.getByLabel('视频 URL', { exact: true }).press('Enter');
  await page.waitForFunction(({ id, url }) => window.videoStore.getState().scene.entities[id].components.chartMarker.videoUrl === url,
    { id: markerId, url: url + '__poi_video.webm' }, { timeout: 5000 });
  const video = page.locator(`[data-screen-entity-id="${markerId}"] video`);
  await video.waitFor({ state: 'attached' });
  assert.equal(await video.getAttribute('src'), null);
  assert.equal(requests, 0, '编辑态不请求视频');
  console.log('视频配置已提交，进入运行');
  await page.evaluate(() => { const result = window.videoStore.getState().startRuntimePreview(); if (!result.ok) throw Error(result.message); });
  await page.waitForFunction(id => { const v = document.querySelector(`[data-screen-entity-id="${id}"] video`); return v && !v.paused && v.currentTime > 0.15; }, markerId);
  assert.equal(await video.evaluate(v => v.muted && v.loop && v.controls && v.videoWidth > 0), true);
  await page.screenshot({ path: path.join(output, 'editor-running.png') });
  await video.evaluate(v => v.pause());
  await page.waitForTimeout(350);
  assert.equal(await video.evaluate(v => v.paused), true, '用户暂停不应被渲染循环覆盖');
  await page.evaluate(() => { window.oldVideo = document.querySelector('video[data-chart-marker-video]'); window.videoStore.getState().stopRuntimePreview(); });
  await page.waitForFunction(() => window.oldVideo.paused && !window.oldVideo.hasAttribute('src'));
  await page.evaluate(id => window.videoStore.getState().selectEntity(id), markerId);
  await page.getByLabel('视频 URL', { exact: true }).fill('javascript:alert(1)');
  await page.getByLabel('视频 URL', { exact: true }).press('Tab');
  await page.getByRole('alert').filter({ hasText: 'HTTP(S)' }).waitFor();
  assert.equal(await page.evaluate(id => window.videoStore.getState().scene.entities[id].components.chartMarker.videoUrl, markerId), url + '__poi_video.webm');
  await page.getByLabel('视频 URL', { exact: true }).fill(url + '__missing_video.webm');
  await page.getByLabel('视频 URL', { exact: true }).press('Tab');
  await page.evaluate(() => window.videoStore.getState().startRuntimePreview());
  await page.getByRole('button', { name: '重试视频', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'video-error.png') });
  await page.evaluate(id => { const s = window.videoStore.getState(); s.stopRuntimePreview(); s.updateChartMarker(id, { videoUrl: new URL('__poi_video.webm', location.href).href }); }, markerId);
  // 单独使用真实 DOM 验证策略拦截、用户暂停、视野挂起、迟到的 play 拒绝及释放。
  const lifecycle = await page.evaluate(async url => {
    const { createChartMarkerVideo } = window.videoTools;
    const parent = document.createElement('div'); document.body.append(parent);
    const controller = createChartMarkerVideo(parent, { url, controls: false, loop: true, fit: 'contain' });
    const v = controller.video;
    const originalPlay = v.play.bind(v);
    v.play = () => Promise.reject(new DOMException('policy', 'NotAllowedError'));
    controller.setInteractive(true); controller.setPlayback(true, true);
    await new Promise(resolve => setTimeout(resolve, 30));
    const blocked = parent.textContent.includes('浏览器未允许自动播放') && controller.hasInteractiveContent();
    v.play = originalPlay;
    parent.querySelector('button').click();
    await new Promise((resolve, reject) => { if (!v.paused && v.readyState >= 3) return resolve(); v.addEventListener('playing', resolve, { once: true }); setTimeout(() => reject(Error('video did not start')), 10000); });
    controller.setPlayback(true, false);
    await new Promise(resolve => setTimeout(resolve, 40));
    const offscreenPaused = v.paused;
    controller.setPlayback(true, true);
    await new Promise(resolve => setTimeout(resolve, 250));
    const resumed = !v.paused;
    v.pause(); await new Promise(resolve => setTimeout(resolve, 40));
    controller.setPlayback(true, false); controller.setPlayback(true, true);
    await new Promise(resolve => setTimeout(resolve, 120));
    const manualPausePreserved = v.paused;
    controller.setPlayback(false, true);
    let rejectPlay; v.play = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
    controller.setPlayback(true, true); controller.setPlayback(false, true);
    rejectPlay(new DOMException('late rejection', 'NotAllowedError'));
    await new Promise(resolve => setTimeout(resolve, 30));
    const staleIgnored = parent.textContent.includes('运行后自动播放');
    controller.dispose(); parent.remove();
    return { blocked, offscreenPaused, resumed, manualPausePreserved, staleIgnored, released: !v.hasAttribute('src') && v.paused };
  }, url + '__poi_video.webm');
  for (const [key, value] of Object.entries(lifecycle)) assert.equal(value, true, key);
  const sceneContent = await page.evaluate(async id => {
    const { serializeScene, deserializeScene } = window.videoSerializer;
    const scene = structuredClone(window.videoStore.getState().scene);
    scene.entities[id].components.chartMarker.clickEvents = [{ type: 'left-click', actions: [{ type: 'refresh' }] }];
    scene.sceneSettings.camera.savedPose = { alpha: Math.PI / 2, beta: Math.PI / 2, radius: 18, target: { x: 0, y: 2, z: 0 } };
    const content = serializeScene(scene);
    if (deserializeScene(content).entities[id].components.chartMarker.videoUrl !== scene.entities[id].components.chartMarker.videoUrl) throw Error('URL lost');
    return content;
  }, markerId);
  await writeFile(path.join(output, 'scene.json'), sceneContent);
  viewerServer = await preview({ configFile: 'vite.viewer.config.ts', preview: { host: '127.0.0.1', port: 0, strictPort: false } });
  const viewer = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  let viewerSceneContent = sceneContent;
  viewer.on('pageerror', error => errors.push(error.message));
  await routeVideo(viewer);
  await viewer.route('**/runtime-config.json', route => route.fulfill({ json: { version: 1,
    page: { title: 'POI 视频验收', loadingText: '加载中', backgroundColor: '#101827' },
    paths: { scene: './project/scene.json', assetManifest: './project/asset-manifest.json', assetBase: './project/' },
    viewer: { showGrid: true, allowCameraControl: true, showStatusOverlay: false },
    mqtt: { ...JSON.parse(sceneContent).scene.mqttConfig, enabled: false, address: '', subscriptions: [] } } }));
  await viewer.route('**/project/scene.json', route => route.fulfill({ contentType: 'application/json', body: viewerSceneContent }));
  await viewer.route('**/project/asset-manifest.json', route => route.fulfill({ json: { version: 1, assets: [] } }));
  await viewer.goto(viewerServer.resolvedUrls.local[0]);
  await viewer.waitForFunction(() => { const v = document.querySelector('video[data-chart-marker-video]'); return v && !v.paused && v.currentTime > 0.1; }, null, { timeout: 60000 });
  const viewerVideo = viewer.locator('video[data-chart-marker-video]');
  await viewerVideo.hover();
  await viewer.evaluate(() => { window.initialVideo = document.querySelector('video[data-chart-marker-video]'); });
  // 读取浏览器原生控件的实际位置；不使用会被 Viewer 场景快捷键接管的空格键。
  const cdp = await viewer.context().newCDPSession(viewer);
  const { root: dom } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const findPlay = node => (node.attributes ?? []).includes('-webkit-media-controls-play-button') ? node
    : [...(node.children ?? []), ...(node.shadowRoots ?? [])].map(findPlay).find(Boolean);
  const playButton = findPlay(dom);
  assert.ok(playButton, '原生播放按钮必须存在');
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: playButton.backendNodeId });
  const point = { x: (model.border[0] + model.border[2] + model.border[4] + model.border[6]) / 4,
    y: (model.border[1] + model.border[3] + model.border[5] + model.border[7]) / 4 };
  await viewer.mouse.click(point.x, point.y);
  await viewer.waitForFunction(() => document.querySelector('video[data-chart-marker-video]').paused);
  assert.equal(await viewer.evaluate(() => window.initialVideo === document.querySelector('video[data-chart-marker-video]')), true, '控件点击不能误触立标刷新动作');
  await viewer.mouse.click(point.x, point.y);
  await viewer.waitForFunction(() => !document.querySelector('video[data-chart-marker-video]').paused);
  await cdp.detach();
  await viewer.screenshot({ path: path.join(output, 'viewer.png') });
  // 实际 Viewer 中加入前景立柱和第二块视频，校验媒体内容也遵守深度与点击遮挡。
  const occludedScene = JSON.parse(sceneContent);
  const occluder = { id: 'video-occluder', name: '前景立柱', visible: true, locked: true, parentId: null, childrenIds: [],
    components: { transform: { position: { x: 0, y: 2, z: 2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 6, z: 0.5 } },
      meshRenderer: { meshKind: 'cube', materialColor: '#d04030' } } };
  occludedScene.scene.entities[occluder.id] = occluder;
  const second = structuredClone(occludedScene.scene.entities[markerId]);
  second.id = 'second-video'; second.name = '第二块视频'; second.components.transform.position.x = 6;
  occludedScene.scene.entities[second.id] = second;
  occludedScene.scene.entityIds.push(occluder.id, second.id);
  viewerSceneContent = JSON.stringify(occludedScene);
  await viewer.reload();
  await viewer.waitForFunction(() => {
    const videos = [...document.querySelectorAll('video[data-chart-marker-video]')];
    return videos.length === 2 && videos.every(v => !v.paused && v.currentTime > 0.1);
  });
  await viewer.waitForFunction(() => {
    const r = document.querySelector('video[data-chart-marker-video]').getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height * 0.4)?.tagName === 'CANVAS'
      && document.elementFromPoint(r.x + r.width * 0.2, r.y + r.height * 0.4)?.tagName === 'VIDEO';
  });
  await viewer.screenshot({ path: path.join(output, 'viewer-occlusion.png') });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, markerId, lifecycle, requests, viewerControls: true, multipleVideos: true, videoOcclusion: true }, null, 2));
  console.log(JSON.stringify({ ok: true, markerId, lifecycle, output }, null, 2));
} catch (error) {
  if (page) console.error(await page.evaluate(() => ({ hidden: document.hidden, mode: window.videoStore?.getState().runtimeMode,
    status: [...document.querySelectorAll('[data-chart-marker-video-status]')].map(el => el.textContent),
    media: [...document.querySelectorAll('video')].map(v => ({ src: v.getAttribute('src'), paused: v.paused, time: v.currentTime, ready: v.readyState, error: v.error?.message })),
    logs: window.videoStore?.getState().logs.slice(0, 5) })).catch(() => null));
  await page?.screenshot({ path: path.join(output, 'failure.png'), timeout: 10000 }).catch(cause => console.error('无法保存失败截图:', cause.message));
  console.error({ errors }); throw error;
} finally {
  await browser?.close();
  if (viewerServer) await new Promise(resolve => viewerServer.httpServer.close(resolve));
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
