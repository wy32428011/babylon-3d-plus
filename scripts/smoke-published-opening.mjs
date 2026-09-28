import assert from 'node:assert/strict';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { chromium } from 'playwright';

// 真实 React Preview/Published + 真实解包 DIST。接口数据为本地 fixture，无后端写操作。
const workspace = path.resolve('.');
const standaloneOnly = process.argv.includes('--standalone-only');
const visibilityOnly = process.argv.includes('--visibility-only');
const continuationOnly = process.argv.includes('--continuation-only');
const viewerPaths = { enabled: '/digital-twin/releases/123/1/', skip: '/digital-twin/releases/123/2/', disabled: '/digital-twin/releases/123/3/' };
const frontend = path.resolve(process.env.OPENING_CDP_FRONTEND || 'C:/projects/CentralDataPlatform/frontend');
const packages = JSON.parse(await readFile(path.join(workspace, 'output/geographic-opening/packages-result.json'), 'utf8'));
const viewerRoot = path.resolve(process.env.OPENING_VIEWER_ROOT || packages.viewerRoot);
const disabledRoot = packages.disabledViewerRoot ? path.resolve(packages.disabledViewerRoot) : null;
const skipRootValue = process.env.OPENING_SKIP_VIEWER_ROOT || packages.skippableViewerRoot;
const skipRoot = skipRootValue ? path.resolve(skipRootValue) : null;
const scene = JSON.parse(await readFile(path.join(viewerRoot, 'project/scene.json'), 'utf8'));
const opening = scene.scene.sceneSettings.openingAnimation;
assert.equal(opening.enabled, true);
assert.equal(opening.template, 'reference-huishan');
await mkdir(path.join(workspace, 'output/geographic-opening'), { recursive: true });
const output = await mkdtemp(path.join(workspace, 'output/geographic-opening/published-host-'));
const cdpRequire = createRequire(path.join(frontend, 'package.json'));
const { build } = cdpRequire('esbuild');
const fixtureRoot = path.join(workspace, 'tests/fixtures');
const bundle = await build({
  absWorkingDir: frontend,
  entryPoints: [path.join(fixtureRoot, 'publishedOpeningHost.tsx')],
  bundle: true, write: false, outfile: path.join(output, 'host.js'), format: 'iife', jsx: 'automatic',
  logLevel: 'error', loader: { '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'published-opening-fixture', setup(builder) {
    builder.onResolve({ filter: /^@umijs\/max$/ }, () => ({ path: path.join(fixtureRoot, 'publishedOpeningUmi.ts') }));
    builder.onResolve({ filter: /^@published-opening\// }, args => ({ path: path.join(frontend, 'src/pages/BigscreenDesigner', args.path.split('/')[1], 'index.tsx') }));
    builder.onResolve({ filter: /^@\// }, args => builder.resolve(path.join(frontend, 'src', args.path.slice(2)), { kind: args.kind, resolveDir: frontend }));
    builder.onResolve({ filter: /^(react|react-dom|antd)(\/.*)?$/ }, args => ({ path: cdpRequire.resolve(args.path) }));
    // 本机受保护源码需要由 Node 读取，再交给编译器。
    builder.onLoad({ filter: /\.[jt]sx?$/ }, args => args.path.includes('node_modules') ? undefined : ({
      contents: readFileSync(args.path, 'utf8'), loader: args.path.endsWith('tsx') ? 'tsx' : args.path.endsWith('ts') ? 'ts' : 'jsx',
    }));
  } }],
});
if (process.argv.includes('--prepare-only')) {
  console.log(JSON.stringify({ ok: true, prepared: true, output, hostBundleBytes: bundle.outputFiles.reduce((sum, file) => sum + file.contents.length, 0) }));
  process.exit(0);
}
assert.ok(skipRoot, '请先生成带 skippableViewerRoot 的最新三份 DIST 验收包');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.wasm': 'application/wasm', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
const report = { ok: false, output, viewerRoot, frontend, checks: [], scenarios: [], errors: [], requests: [],
  boundaries: '真实中台 Preview/Published、BigscreenWidgetRenderer、BabylonRuntimeWidget 和三份实际 DIST；Umi 路由/request 与后端响应为本地 fixture；后台通过 visibility API fixture 和真实 CSS 隐藏验证，不代表现场 OS 页签行为。' };
const hostContent = variant => ({
  version: 1, projectId: '123', canvas: { width: 1440, height: 900, backgroundColor: '#061928' },
  widgets: [
    { id: 'runtime', type: 'BABYLON_RUNTIME', name: '数字孪生', x: 0, y: 0, w: 1440, h: 900, zIndex: 1, visible: true,
      style: { showTitle: false }, data: { sourceType: 'externalRuntime', digitalTwinBinding: { mode: 'manualUrl', runtimeUrl: `${origin}${viewerPaths[variant] || viewerPaths.enabled}index.html` } } },
    { id: 'opening-control', type: 'TEXT', name: '业务面板', x: 1050, y: 70, w: 340, h: 150, zIndex: 10, visible: true,
      style: { showTitle: false, fontSize: 28, color: '#ffffff', backgroundColor: '#075069' }, data: { text: '开场结束：业务控件已恢复' } },
  ],
});
const server = createServer((req, res) => { void (async () => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/api/')) {
      report.requests.push(pathname);
      const content = hostContent(url.searchParams.get('fixture') || 'enabled');
      let data;
      if (pathname === '/api/v1/screens/detail') data = { id: '1', projectId: '123', screenName: '发布开场真实页面验收', jsonContent: JSON.stringify(content) };
      else if (pathname === '/api/v1/screens/1/published') data = { id: '10', screenId: '1', versionNumber: 1, publishNumber: 1, versionStatus: 'PUBLISHED', snapshotJson: JSON.stringify({ jsonContent: JSON.stringify(content) }) };
      else if (pathname === '/api/v1/digital-twin/runtime-config/detail') data = { projectId: '123', runtimeEnabled: true };
      else if (pathname.endsWith('/options')) data = [];
      else { res.writeHead(404).end(JSON.stringify({ message: '未预期的接口 ' + pathname })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 200, success: true, data }));
      return;
    }
    for (const [prefix, root] of [[viewerPaths.enabled, viewerRoot], [viewerPaths.skip, skipRoot], [viewerPaths.disabled, disabledRoot]]) {
      if (!root || !pathname.startsWith(prefix)) continue;
      const file = path.resolve(root, pathname.slice(prefix.length) || 'index.html');
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      await pipeline(createReadStream(file), res);
      return;
    }
    if (pathname === '/host.js' || pathname === '/host.css') {
      const extension = path.extname(pathname);
      res.writeHead(200, { 'Content-Type': mime[extension] }).end(bundle.outputFiles.find(file => file.path.endsWith(extension))?.contents || '');
    } else if (pathname === '/published' || pathname === '/preview') {
      res.writeHead(200, { 'Content-Type': mime['.html'] }).end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/host.css"><style>body{margin:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="/host.js"></script></body></html>');
    } else res.writeHead(404).end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500);
    res.end();
  }
})(); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, context, page;

async function observe(target, hidden = false) {
  target.setDefaultTimeout(90_000);
  target.on('pageerror', error => report.errors.push(error.message));
  await target.addInitScript(({ hidden }) => {
    window.__openingMessages = [];
    window.addEventListener('message', event => {
      if (event.data?.channel === 'zending.opening.v1' || event.data?.type === 'viewer.ready') {
        window.__openingMessages.push({ ...event.data, at: performance.now() });
      }
    });
    if (hidden) {
      // 自动化 Chrome 不报告切页后的真实隐藏状态；显式注入 API 边界，并真实隐藏 iframe。
      window.__openingHidden = true;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__openingHidden ? 'hidden' : 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__openingHidden });
      if (window === window.top) document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style'); style.id = 'opening-hidden-fixture'; style.textContent = 'iframe{visibility:hidden!important}'; document.head.append(style);
      });
    }
  }, { hidden });
}
async function getViewer() {
  const iframe = page.locator('iframe[src*="/digital-twin/releases/"]');
  await iframe.waitFor({ state: 'attached' });
  const viewer = await (await iframe.elementHandle()).contentFrame();
  assert.ok(viewer);
  return { iframe, viewer };
}
async function phase(expected) {
  await page.waitForFunction(expected => window.__openingMessages.some(message => message.type === 'viewer.state' && message.phase === expected), expected);
}
async function readReleaseCache(viewer) {
  return viewer.evaluate(async () => {
    const name = 'zending-published-release-catalog-v1';
    if (!(await indexedDB.databases()).some(database => database.name === name)) return [];
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction('values', 'readonly').objectStore('values').getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  });
}
async function verifyWarmRefresh(viewer, previousToken) {
  await viewer.waitForFunction(() => ['ready', 'partial'].includes(window.__ZENDING_RELEASE_CACHE__?.phase));
  const cacheState = await viewer.evaluate(() => window.__ZENDING_RELEASE_CACHE__);
  const cacheBefore = await readReleaseCache(viewer);
  report.cacheDiagnostics = { cacheState, cacheBefore };
  assert.equal(cacheState.phase, 'ready', `完整缓存前提：${JSON.stringify(cacheState)}`);
  assert.ok(cacheBefore.some(record => record.baseUrl === `${origin}${viewerPaths.enabled}` && record.complete === true), '刷新前实际 DIST 发布缓存应完整写入');
  await page.reload();
  const refreshed = await getViewer();
  const replay = await recordPlaying('published-warm-refresh', refreshed.viewer, refreshed.iframe);
  assert.notEqual(replay.token, previousToken, '刷新建立新页面会话');
  report.scenarios.push({ mode: 'published-warm-refresh', ...replay, cacheBefore, cacheAfter: await readReleaseCache(refreshed.viewer) });
  report.checks.push('published: IndexedDB 发布缓存完整写入后，同一浏览器上下文刷新重新播放一次');
  console.log('PASS published warm refresh: opening visible');
}
async function recordPlaying(name, viewer, iframe) {
  await phase('playing');
  await viewer.locator('.geographic-opening-host').waitFor({ state: 'visible' });
  assert.equal(await viewer.locator('.geographic-opening-host canvas').count(), 3, '参考动画的三层画布需要实际挂载');
  await viewer.waitForFunction(() => Number(document.querySelector('.geographic-opening-host [data-role="progress"]')?.value) > 1.2);
  assert.equal(await page.getByText('开场结束：业务控件已恢复', { exact: true }).isVisible(), false);
  assert.equal(await iframe.evaluate(node => getComputedStyle(node).visibility), 'visible');
  const token = await viewer.evaluate(() => {
    window.__openingElement = document.querySelector('.geographic-opening-host');
    return window.__openingInstance = crypto.randomUUID();
  });
  const screenshot = await page.screenshot({ path: path.join(output, `${name}-playing.png`) });
  const coloredPixels = await page.evaluate(async png => {
    const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const draw = canvas.getContext('2d'); draw.drawImage(image, 0, 0);
    const pixels = draw.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 2] > 110 && pixels[i + 2] > pixels[i] * 1.5) colored++;
    return colored;
  }, screenshot.toString('base64'));
  assert.ok(coloredPixels > 1500, `开场需要实际画面像素：${coloredPixels}`);
  const brand = await viewer.locator('.geographic-opening-host [data-role="brand-name"]').textContent();
  assert.equal(brand, opening.reference.brandName);
  return { token, coloredPixels, brand };
}
async function complete(name, viewer, token, expectedPhase = 'completed') {
  await phase(expectedPhase);
  console.log(`STATE ${name}: ${expectedPhase}`);
  await page.getByText('开场结束：业务控件已恢复', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await viewer.locator('.opening-animation-overlay,.geographic-opening-host').count(), 0);
  assert.equal(await viewer.evaluate(() => window.__openingInstance), token, '业务恢复不得重建 iframe');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await viewer.evaluate(() => window.__openingInstance), token, 'resize 不得重建 iframe');
  // 内嵌模式不展示 Viewer 工具条，使用浏览器原生全屏入口触发真实 fullscreenchange。
  await page.evaluate(() => document.documentElement.requestFullscreen());
  await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
  assert.equal(await viewer.evaluate(() => window.__openingInstance), token, '全屏不得重建 iframe');
  assert.equal(await page.getByText('开场结束：业务控件已恢复', { exact: true }).isVisible(), true);
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => document.fullscreenElement === null);
  const messages = await page.evaluate(() => window.__openingMessages);
  const transitions = messages.filter(message => message.type === 'viewer.state').map(message => message.phase)
    .filter((value, index, values) => index === 0 || value !== values[index - 1]);
  assert.equal(transitions.filter(value => value === 'playing').length, 1, '交接阶段不得重新报告 playing');
  assert.equal(await viewer.evaluate(() => window.__openingElement.isConnected), false, '开场结束必须卸载实际参考DOM');
  await page.screenshot({ path: path.join(output, `${name}-${expectedPhase}.png`) });
  return { transitions, messages };
}
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  for (const mode of standaloneOnly || visibilityOnly || continuationOnly ? [] : ['preview', 'published']) {
    page = await context.newPage(); await observe(page);
    await page.goto(`${origin}/${mode}`);
    const { viewer, iframe } = await getViewer();
    const playing = await recordPlaying(mode, viewer, iframe);
    assert.equal(await viewer.getByRole('button', { name: /跳过开场/ }).count(), 0, '原始包禁止跳过时不显示跳过按钮');
    await page.keyboard.press('Escape');
    assert.equal(await viewer.locator('.geographic-opening-host').count(), 1);
    const total = opening.reference.stageDurations.reduce((sum, duration) => sum + duration, 0);
    await viewer.waitForFunction(target => Number(document.querySelector('.geographic-opening-host [data-role="progress"]')?.value) >= target, total / 2);
    await page.screenshot({ path: path.join(output, `${mode}-middle.png`) });
    const completed = await complete(mode, viewer, playing.token);
    report.scenarios.push({ mode, ...playing, ...completed });
    report.checks.push(`${mode}: 真实页面首播像素、中间帧、禁止跳过、自然结束、业务恢复、resize/全屏保留 iframe`);
    console.log(`PASS ${mode}: opening completed; output=${output}`);
    if (mode === 'published') {
      await verifyWarmRefresh(viewer, playing.token);
    }
    await page.close();
  }

  if (continuationOnly) {
    page = await context.newPage(); await observe(page);
    await page.goto(`${origin}/published`);
    const warmup = await getViewer();
    const playing = await recordPlaying('published-cache-warmup', warmup.viewer, warmup.iframe);
    await verifyWarmRefresh(warmup.viewer, playing.token);
    await page.close();
  }

  if (!standaloneOnly && !visibilityOnly) {
    page = await context.newPage(); await observe(page, true);
    await page.goto(`${origin}/published?fixture=skip`);
    const delayed = await getViewer();
    await page.waitForFunction(() => window.__openingMessages.some(message => message.type === 'viewer.ready'));
    // 超过旧逻辑的 2.5 秒超时，检查隐藏状态不会消耗或永久跳过开场。
    await page.waitForTimeout(3500);
    const before = await page.evaluate(() => window.__openingMessages);
    assert.equal(before.some(message => ['playing', 'skipped', 'completed'].includes(message.phase)), false);
    assert.equal(await delayed.iframe.evaluate(node => getComputedStyle(node).visibility), 'hidden');
    for (const frame of page.frames()) await frame.evaluate(() => {
      window.__openingHidden = false;
      document.querySelector('#opening-hidden-fixture')?.remove();
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('resize'));
    });
    const resumed = await recordPlaying('published-hidden-resume', delayed.viewer, delayed.iframe);
    const beforePause = await delayed.viewer.locator('.geographic-opening-host [data-role="progress"]').inputValue();
    for (const frame of page.frames()) await frame.evaluate(() => {
      window.__openingHidden = true;
      if (window === window.top) {
        const style = document.createElement('style'); style.id = 'opening-hidden-fixture'; style.textContent = 'iframe{visibility:hidden!important}'; document.head.append(style);
      }
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(1500);
    const afterPause = await delayed.viewer.locator('.geographic-opening-host [data-role="progress"]').inputValue();
    assert.ok(Number(afterPause) - Number(beforePause) < 0.3, `隐藏时开场时钟应暂停：${beforePause} -> ${afterPause}`);
    for (const frame of page.frames()) await frame.evaluate(() => {
      window.__openingHidden = false;
      document.querySelector('#opening-hidden-fixture')?.remove();
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('resize'));
    });
    await delayed.viewer.waitForFunction(previous => Number(document.querySelector('.geographic-opening-host [data-role="progress"]')?.value) > previous + 0.4, Number(afterPause));
    await delayed.viewer.getByRole('button', { name: /跳过开场/ }).click();
    const skipped = await complete('published-hidden-resume', delayed.viewer, resumed.token, 'skipped');
    report.scenarios.push({ mode: 'published-hidden-resume-skip', ...resumed, ...skipped, beforePause, afterPause, skipRoot });
    report.checks.push('published: visibility API fixture + 真实 iframe 隐藏超过 2.5 秒后恢复首播；播放中隐藏暂停并恢复；真实允许跳过 DIST 点击跳过恢复业务且 iframe 保持');
    console.log('PASS delayed visibility and skip');
    await page.close();

    if (disabledRoot) {
      page = await context.newPage(); await observe(page);
      await page.goto(`${origin}/published?fixture=disabled`);
      const disabled = await getViewer();
      await page.getByText('开场结束：业务控件已恢复', { exact: true }).waitFor({ state: 'visible' });
      assert.equal(await disabled.viewer.locator('.geographic-opening-host,.opening-animation-overlay').count(), 0);
      await page.screenshot({ path: path.join(output, 'published-disabled.png') });
      report.checks.push('published: 禁用开场的实际 DIST 直接恢复业务');
      await page.close();
    }
  }

  if (!standaloneOnly) {
    page = await context.newPage(); await observe(page);
    await page.goto(`${origin}/published?fixture=skip`);
    const css = await getViewer();
    const started = await recordPlaying('published-css-hide', css.viewer, css.iframe);
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
    assert.equal(await css.viewer.evaluate(() => document.visibilityState), 'visible');
    await css.viewer.evaluate(() => { window.__openingMessages = []; });
    await css.iframe.evaluate(node => { node.style.opacity = '0'; });
    await css.viewer.waitForFunction(() => window.__openingMessages.some(message => message.type === 'host.visibility' && message.visible === false));
    const pausedAt = await css.viewer.locator('.geographic-opening-host [data-role="progress"]').inputValue();
    await page.waitForTimeout(1500);
    const stillPausedAt = await css.viewer.locator('.geographic-opening-host [data-role="progress"]').inputValue();
    assert.ok(Number(stillPausedAt) - Number(pausedAt) < 0.3, `纯CSS隐藏通过宿主bridge暂停：${pausedAt} -> ${stillPausedAt}`);
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
    assert.equal(await css.viewer.evaluate(() => document.visibilityState), 'visible');
    await css.iframe.evaluate(node => { node.style.opacity = ''; });
    await css.viewer.waitForFunction(() => window.__openingMessages.some(message => message.type === 'host.visibility' && message.visible === true));
    await css.viewer.waitForFunction(previous => Number(document.querySelector('.geographic-opening-host [data-role="progress"]')?.value) > previous + 0.4, Number(stillPausedAt));
    await css.viewer.getByRole('button', { name: /跳过开场/ }).click();
    const completed = await complete('published-css-hide', css.viewer, started.token, 'skipped');
    report.scenarios.push({ mode: 'published-css-hide', pausedAt, stillPausedAt, ...started, ...completed,
      visibilityMessages: await css.viewer.evaluate(() => window.__openingMessages) });
    report.checks.push('published: 父子document均保持visible，单独设置iframe opacity=0由真实宿主bridge发送hidden并暂停，恢复CSS后继续且跳过正常');
    console.log('PASS pure CSS iframe visibility pause/resume');
    await page.close();
  }

  if (!visibilityOnly) {
    page = await context.newPage(); await observe(page);
    await page.goto(`${origin}${viewerPaths.skip}index.html`);
    await page.locator('.geographic-opening-host').waitFor({ state: 'visible' });
    await page.waitForFunction(() => Number(document.querySelector('.geographic-opening-host [data-role="progress"]')?.value) > 1.2);
    assert.equal(await page.locator('.geographic-opening-host canvas').count(), 3);
    await page.screenshot({ path: path.join(output, 'standalone-playing.png') });
    await page.getByRole('button', { name: /跳过开场/ }).click();
    await page.locator('.opening-animation-overlay').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.geographic-opening-host').count(), 0);
    assert.equal(await page.locator('canvas').count(), 1, '独立 Viewer 跳过后保留业务画布并释放开场画布');
    await page.screenshot({ path: path.join(output, 'standalone-skipped.png') });
    report.checks.push('独立 Viewer: 无宿主握手直接可见首播，跳过释放开场 DOM/画布并保留业务 canvas');
    console.log('PASS standalone Viewer and skip');
    await page.close();
  }
  assert.deepEqual(report.errors, []);
  report.ok = true;
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, output, checks: report.checks }));
} catch (error) {
  report.failure = String(error?.stack || error);
  report.lastMessages = await page?.evaluate(() => window.__openingMessages).catch(() => null);
  report.body = await page?.locator('body').innerText().catch(() => null);
  report.frameBodies = page ? await Promise.all(page.frames().map(async frame => ({ url: frame.url(), body: (await frame.locator('body').innerText().catch(() => ''))?.slice(0, 5000) }))) : [];
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify(report, null, 2));
  console.error(`Published opening smoke failed; output=${output}`);
  throw error;
} finally {
  await context?.close(); await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
