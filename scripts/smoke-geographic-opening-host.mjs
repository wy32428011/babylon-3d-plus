import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const workspace = path.resolve('.');
const cdpFrontend = path.resolve(process.env.OPENING_HOST_CDP_FRONTEND || 'C:/projects/CentralDataPlatform/frontend');
const output = path.join(workspace, 'output/geographic-opening');
const legacyOnly = process.argv.includes('--legacy-only');
await mkdir(output, { recursive: true });
let viewerRoot, disabledViewerRoot, opening;
if (!legacyOnly) {
  const result = process.env.OPENING_HOST_VIEWER_ROOT ? null : JSON.parse(await readFile(path.join(output, 'packages-result.json'), 'utf8'));
  viewerRoot = path.resolve(process.env.OPENING_HOST_VIEWER_ROOT || result.viewerRoot);
  disabledViewerRoot = process.env.OPENING_HOST_DISABLED_VIEWER_ROOT || result?.disabledViewerRoot;
  if (disabledViewerRoot) disabledViewerRoot = path.resolve(disabledViewerRoot);
  opening = JSON.parse(await readFile(path.join(viewerRoot, 'project/scene.json'), 'utf8')).scene.sceneSettings.openingAnimation;
  assert.equal(opening.template, 'reference-huishan', '必须使用重新构建的参考模板DIST');
  assert.equal(opening.reference.stageDurations.length, 9);
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.wasm': 'application/wasm', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
const probe = createNetServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = await createServer({
  configFile: false, root: workspace, cacheDir: path.join(output, 'host-vite-cache'),
  optimizeDeps: { noDiscovery: true, include: [], entries: ['tests/fixtures/geographicOpeningHost.html'] },
  resolve: { alias: {
    '@opening-host/bridge': path.join(cdpFrontend, 'src/pages/BigscreenDesigner/utils/digitalTwinRuntimeHostBridge.ts'),
    '@opening-host/visibility': path.join(cdpFrontend, 'src/pages/BigscreenDesigner/utils/runtimeInitialLoadVisibility.ts'),
  } },
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/output/**'] }, fs: { allow: [workspace, cdpFrontend] } },
  plugins: [{ name: 'reference-opening-published-viewer', configureServer(vite) {
    for (const [prefix, root] of [['/published-viewer', viewerRoot], ['/disabled-viewer', disabledViewerRoot]]) {
      if (!root) continue;
      vite.middlewares.use(prefix, (request, response) => { void (async () => {
        try {
          const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
          const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
          const relative = path.relative(root, file);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
          response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
          await pipeline(createReadStream(file), response);
        } catch (error) { if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(); }
      })(); });
    }
  } }],
});
let browser, page;
const report = { ok: false, viewerRoot, template: 'reference-huishan', checks: [], stages: [], errors: [],
  boundaries: '真实CDP桥接/显示工具+实际DIST Viewer；宿主DOM为独立harness，业务配置为本地fixture；旧Viewer为既有协议fixture。' };
const labels = ['旋转地球', '地球展开', '全球业务', '中国全景', '江苏高亮', '国内业务', '江苏全景', '无锡全景', '抵达惠山'];
const starts = [0, 9, 16, 24, 30, 34, 42, 48, 54], ends = [9, 16, 24, 30, 34, 42, 48, 54, 62];
const samples = [4, 12, 20, 28, 32, 38, 45, 51, 59];
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => { report.errors.push(error.message); console.error(error.message); });
  await page.route('**/api/v1/digital-twin/runtime-config/detail*', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true } }),
  }));
  const host = '/tests/fixtures/geographicOpeningHost.html';
  await page.goto(`${base}${host}?viewer=${encodeURIComponent('/tests/fixtures/geographicOpeningHostLegacyViewer.html')}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__openingHost?.getState().panelVisible, null, { timeout: 30000 });
  const legacy = await page.evaluate(() => window.__openingHost.getState());
  assert.equal(legacy.iframeVisible, true); assert.equal(legacy.state.openingPhase, undefined);
  assert.equal(legacy.events.some(event => event.kind === 'opening-message'), false);
  await page.screenshot({ path: path.join(output, 'host-legacy-viewer.png') });
  report.checks.push('旧Viewer协议fixture正常展示，不等待参考开场扩展');

  if (!legacyOnly) {
    const reference = opening.reference;
    const total = reference.stageDurations.reduce((sum, value) => sum + value, 0);
    assert.equal(total, 62, '启用包应覆盖参考HTML的62秒九段完整流程');
    report.referenceDuration = total;
    await page.goto(`${base}${host}`, { waitUntil: 'commit', timeout: 120000 });
    await page.waitForFunction(() => window.__openingHost?.getState().state.phase === 'viewerReady', null, { timeout: 120000 });
    const viewer = page.frames().find(frame => frame.url().startsWith(`${base}/published-viewer/`));
    assert.ok(viewer);
    await viewer.waitForSelector('.opening-animation-overlay[aria-busy="true"]', { state: 'visible', timeout: 120000 });
    const preparation = await viewer.locator('.opening-animation-overlay').evaluate(element => ({
      busy: element.getAttribute('aria-busy'), background: getComputedStyle(element).backgroundColor,
    }));
    assert.equal(preparation.busy, 'true'); assert.equal(preparation.background, 'rgb(2, 8, 21)');
    const preparationImage = await page.screenshot({ path: path.join(output, 'host-opening-preparing.png') });
    const preparationPixels = await page.evaluate(async data => {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      // 避开居中的准备文字，取原业务方块前侧所在区域验证不透明遮挡。
      const pixels = context.getImageData(Math.round(canvas.width * 0.38), Math.round(canvas.height * 0.65), Math.round(canvas.width * 0.24), Math.round(canvas.height * 0.10)).data;
      let solid = 0;
      for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - 2) <= 2 && Math.abs(pixels[i + 1] - 8) <= 2 && Math.abs(pixels[i + 2] - 21) <= 2) solid++;
      return { solid, total: pixels.length / 4, ratio: solid / (pixels.length / 4) };
    }, preparationImage.toString('base64'));
    assert.ok(preparationPixels.ratio > 0.98, `准备层不得漏出业务方块：${JSON.stringify(preparationPixels)}`);
    report.preparation = { ...preparation, ...preparationPixels };
    report.checks.push('冷启动准备层保持不透明，实际像素无业务方块漏出');
    await page.waitForFunction(() => window.__openingHost?.getState().state.openingPhase === 'playing', null, { timeout: 120000 });
    const intro = viewer.locator('.geographic-opening-host');
    await intro.waitFor({ state: 'visible' });
    assert.equal(await intro.locator('canvas').count(), 3);
    const overlay = await viewer.locator('.opening-animation-overlay').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, pointerEvents: getComputedStyle(element).pointerEvents }));
    assert.equal(overlay.background, 'rgba(0, 0, 0, 0)'); assert.equal(overlay.pointerEvents, 'none');
    const engineModule = (await readdir(path.join(viewerRoot, 'assets'))).find(name => name.startsWith('engineStore-'));
    assert.ok(engineModule);
    await viewer.evaluate(async name => {
      const module = await import('/published-viewer/assets/' + name);
      window.__hostViewerEngineStore = Object.values(module).find(value => Array.isArray(value?.Instances));
    }, engineModule);
    const readBusiness = () => viewer.evaluate(() => {
      const engine = window.__hostViewerEngineStore.Instances.find(candidate => candidate.scenes.length), scene = engine.scenes[0];
      return { camera: Array.from(scene.activeCamera.getViewMatrix(true).m), projection: Array.from(scene.activeCamera.getProjectionMatrix(true).m), scenes: engine.scenes.length, renderer: engine.getGlInfo().renderer };
    });
    const before = await readBusiness();
    assert.equal(before.scenes, 1, '参考DOM开场不新增Babylon Scene');
    assert.doesNotMatch(before.renderer, /swiftshader|llvmpipe|software/i);
    assert.equal(await viewer.getByRole('button', { name: /跳过开场/ }).count(), 0);
    assert.equal(await intro.locator('[data-role="progress"]').isDisabled(), true);
    assert.ok(await intro.locator('[data-stage]').evaluateAll(buttons => buttons.every(button => button.disabled)));
    await intro.locator('.zd-intro').click({ position: { x: 300, y: 230 } });
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
    assert.equal((await page.evaluate(() => window.__openingHost.getState())).state.openingPhase, 'playing');
    report.checks.push('allowSkip=false时按钮、章节、进度和Escape均不能绕过播放');

    let actualStart = 0;
    for (let index = 0; index < labels.length; index++) {
      const duration = reference.stageDurations[index];
      if (duration === 0) continue;
      const target = actualStart + duration * (samples[index] - starts[index]) / (ends[index] - starts[index]);
      await viewer.waitForFunction(({ label, target }) => {
        const accessible = document.querySelector('.opening-animation-accessible-progress');
        const progress = document.querySelector('.geographic-opening-host [data-role="progress"]');
        return accessible?.getAttribute('aria-label') === label && Number(progress?.value) >= target;
      }, { label: labels[index], target }, { timeout: 120000 });
      const state = await page.evaluate(() => window.__openingHost.getState());
      assert.equal(state.iframeVisible, true); assert.equal(state.panelVisible, false);
      const sceneState = await readBusiness();
      assert.equal(sceneState.scenes, 1); assert.deepEqual(sceneState.camera, before.camera); assert.deepEqual(sceneState.projection, before.projection);
      const ui = await intro.evaluate(element => ({ title: element.querySelector('[data-role="stage-title"]')?.textContent,
        brand: element.querySelector('[data-role="brand-name"]')?.textContent, readout: element.querySelector('[data-role="readout-value"]')?.textContent,
        elapsed: Number(element.querySelector('[data-role="progress"]')?.value), total: Number(element.querySelector('[data-role="progress"]')?.max) }));
      assert.equal(ui.total, total); assert.equal(ui.brand, reference.brandName);
      if (index === 2) assert.ok(ui.readout.includes(`${reference.worldDestinations.length} 条演示路线`));
      if (index === 5) assert.ok(ui.readout.includes(`${reference.chinaDestinations.length} 条演示路线`));
      if (index === 8) assert.equal(ui.title, reference.finaleTitle);
      const filename = `host-reference-${String(index + 1).padStart(2, '0')}.png`;
      const pixels = await intro.screenshot({ path: path.join(output, filename) });
      if (index === 0) {
        const blue = await page.evaluate(async data => {
          const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let count = 0;
          for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 2] > 110 && pixels[i + 2] > pixels[i] * 1.5) count++;
          return count;
        }, pixels.toString('base64'));
        assert.ok(blue > 1500, '参考地球必须真实绘制，不能只产生DOM状态'); report.visibleBluePixels = blue;
        await writeFile(path.join(output, 'host-opening-playing.png'), pixels);
      }
      report.stages.push({ index, label: labels[index], targetTime: target, file: filename, ...ui });
      actualStart += duration;
      console.log(`REFERENCE STAGE ${index + 1}/9 ${labels[index]}`);
    }
    await page.waitForFunction(() => window.__openingHost.getState().state.openingPhase === 'completed', null, { timeout: 90000 });
    const complete = await page.evaluate(() => window.__openingHost.getState());
    assert.equal(complete.iframeVisible, true); assert.equal(complete.panelVisible, true);
    assert.equal(await viewer.locator('.geographic-opening-host').count(), 0);
    assert.equal(await viewer.locator('.opening-animation-overlay').count(), 0);
    const after = await readBusiness();
    assert.deepEqual(after.camera, before.camera); assert.deepEqual(after.projection, before.projection); assert.equal(after.scenes, 1);
    const active = complete.events.filter(event => event.kind === 'state' && ['playing', 'handoff'].includes(event.state.openingPhase));
    assert.ok(active.length && active.every(event => event.iframeVisible && !event.panelVisible));
    const ack = complete.events.find(event => event.kind === 'host-message' && event.type === 'host.visible');
    const playing = complete.events.find(event => event.kind === 'opening-message' && event.phase === 'playing');
    assert.ok(ack && playing && ack.at <= playing.at);
    await page.screenshot({ path: path.join(output, 'host-opening-completed.png') });
    report.newViewer = { before, after, stateEvents: complete.events };
    report.checks.push('实际DIST完整经过62秒九段参考画面，品牌和UV路线数量取自发布配置',
      '播放和交接期间iframe可见、面板隐藏，结束后面板显示', '业务Scene与相机保持，结束释放参考DOM及三个画布');

    await page.goto(`${base}${host}?mode=legacy-host`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__openingHost?.getState().events.some(event => event.kind === 'opening-message' && event.phase === 'skipped'), null, { timeout: 120000 });
    const old = await page.evaluate(() => window.__openingHost.getState());
    assert.equal(old.iframeVisible, true); assert.equal(old.panelVisible, true);
    assert.equal(old.events.some(event => event.kind === 'opening-message' && ['playing', 'handoff'].includes(event.phase)), false);
    const fallback = page.frames().find(frame => frame.url().startsWith(`${base}/published-viewer/`));
    assert.equal(await fallback.locator('.geographic-opening-host').count(), 0);
    await page.screenshot({ path: path.join(output, 'host-legacy-host-fallback.png') });
    report.checks.push('新版参考DIST接旧宿主有界降级，不在隐藏iframe播放');
    if (disabledViewerRoot) {
      await page.goto(`${base}${host}?viewer=${encodeURIComponent('/disabled-viewer/')}`, { waitUntil: 'load', timeout: 120000 });
      await page.waitForFunction(() => window.__openingHost?.getState().panelVisible, null, { timeout: 120000 });
      const disabled = await page.evaluate(() => window.__openingHost.getState());
      assert.equal(disabled.iframeVisible, true); assert.equal(disabled.state.openingPhase, 'disabled');
      const frame = page.frames().find(candidate => candidate.url().startsWith(`${base}/disabled-viewer/`));
      assert.ok(frame); assert.equal(await frame.locator('.geographic-opening-host,.opening-animation-overlay').count(), 0);
      const name = (await readdir(path.join(disabledViewerRoot, 'assets'))).find(name => name.startsWith('engineStore-')); assert.ok(name);
      report.disabledResources = await frame.evaluate(async name => {
        const module = await import('/disabled-viewer/assets/' + name);
        const store = Object.values(module).find(value => Array.isArray(value?.Instances));
        return { scenes: store.Instances.flatMap(engine => engine.scenes).length, canvases: document.querySelectorAll('canvas').length };
      }, name);
      assert.equal(report.disabledResources.scenes, 1); assert.equal(report.disabledResources.canvases, 1);
      await page.screenshot({ path: path.join(output, 'host-opening-disabled.png') });
      report.checks.push('禁用参考开场仅保留业务Scene/Canvas，业务直接显示');
    }
  }
  assert.deepEqual(report.errors, []); report.ok = true;
  await writeFile(path.join(output, legacyOnly ? 'host-legacy-fixture-result.json' : 'host-acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, viewerRoot, stages: report.stages.length, checks: report.checks, output, errors: report.errors }));
} catch (error) {
  report.failure = String(error?.stack || error);
  report.lastState = await page?.evaluate(() => window.__openingHost?.getState()).catch(() => null);
  await page?.screenshot({ path: path.join(output, 'host-acceptance-failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'host-acceptance-failure.json'), JSON.stringify(report, null, 2)); throw error;
} finally { await browser?.close(); await server.close(); }
