import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(process.env.OPENING_PACKAGE_OUTPUT ?? 'output/opening-packages');
const output = path.resolve('output/playwright/opening-packages');
await mkdir(output, { recursive: true });
const sourceMode = process.argv.includes('--source');
const remainingOnly = process.argv.includes('--remaining');
const sourceRoot = path.join(output, 'source-viewer-template');
if (sourceMode) await (await import('vite')).build({ configFile: path.resolve('vite.viewer.config.ts'), build: { outDir: sourceRoot } });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const packageResult = JSON.parse(await readFile(path.join(root, 'packages-result.json'), 'utf8'));
const viewerRoots = Object.fromEntries(['viewer-reference', 'viewer-campus', 'viewer-legacy'].map((key, at) => [key, packageResult.distRoots[at]]));
const requests = new Map();
const hostHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{margin:0;background:#06111e;color:white;font:16px system-ui}header{height:46px;display:flex;gap:12px;align-items:center;padding:0 16px}button{padding:5px 14px}iframe{display:block;width:100vw;height:calc(100vh - 46px);border:0;visibility:hidden}</style></head><body><header><button id="show">显示 Viewer</button><button id="hide">隐藏 Viewer</button><span id="status">等待宿主</span></header><iframe id="viewer"></iframe><script>
const frame=document.querySelector('#viewer'),sessionId='opening-package-smoke',events=[];let visible=false;
const send=(type,extra={})=>frame.contentWindow.postMessage({channel:type==='host.hello'?'zending.digital-twin.bridge':'zending.opening.v1',version:1,sessionId,type,...extra},location.origin);
const visibility=value=>{visible=value;frame.style.visibility=value?'visible':'hidden';send('host.visibility',{visible});};
const hello=()=>{send('host.hello');send('host.visibility',{visible});};
const timer=setInterval(hello,250);frame.addEventListener('load',hello);
window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!==location.origin)return;events.push(event.data);if(event.data.type==='bridge.ready')clearInterval(timer);if(event.data.type==='viewer.state'){document.querySelector('#status').textContent=event.data.phase;send('host.visibility',{visible});}});
document.querySelector('#show').onclick=()=>visibility(true);document.querySelector('#hide').onclick=()=>visibility(false);
window.__openingPackageHost={events};frame.src='/viewer-campus/';
</script></body></html>`;
const server = createServer((request, response) => { void (async () => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
    if (pathname === '/api/v1/digital-twin/runtime-config/detail') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true } })); return;
    }
    if (pathname === '/opening-host.html') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(hostHtml); return; }
    let file = path.resolve(root, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
    const route = /^\/(viewer-(?:reference|campus|legacy))\/(.*)$/.exec(pathname);
    let safeRoot = root;
    if (route) { safeRoot = viewerRoots[route[1]]; file = path.resolve(safeRoot, route[2] || 'index.html'); }
    const relative = path.relative(safeRoot, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
    if (sourceMode && /^\/viewer-[^/]+\/(?:index.html|assets\/|$)/.test(pathname)) {
      const sourceFile = path.resolve(sourceRoot, pathname.replace(/^\/viewer-[^/]+\//, '') || 'index.html');
      const within = path.relative(sourceRoot, sourceFile);
      if (within && !within.startsWith('..') && !path.isAbsolute(within) && await stat(sourceFile).then(value => value.isFile(), () => false)) file = sourceFile;
    }
    const bytes = await readFile(file);
    response.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); response.end(bytes);
  } catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(); }
})(); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = { ok: false, base, sourceMode, remainingOnly, checks: [], screenshots: [], pageErrors: [], diagnosticErrors: [],
  boundary: sourceMode ? '新源码的临时静态Viewer + 实际DIST资源，用于最终导出前预检；场景为标准Cube及自动巡检fixture。'
    : '本地实际导出DIST Viewer + Chrome；业务场景为标准Cube及自动巡检fixture，不代表线上部署、真实业务模型或真实MQTT验收。' };
let activePage;
const log = message => { report.checks.push(message); console.log(message); };
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const screenshot = async (page, name) => {
  const file = path.join(output, `${name}.png`); await page.screenshot({ path: file }); report.screenshots.push(file); return file;
};
async function sceneOpening(name) {
  const config = JSON.parse(await readFile(path.join(viewerRoots[name], 'runtime-config.json'), 'utf8'));
  const scene = JSON.parse(await readFile(path.resolve(viewerRoots[name], config.paths.scene), 'utf8'));
  return (scene.scene ?? scene).sceneSettings.openingAnimation;
}
async function pageFor(name) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage(); activePage = page;
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => { report.pageErrors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') { report.diagnosticErrors.push(message.text()); console.error(message.text()); } });
  return { page, context, url: `${base}/${name}/` };
}
async function ready(page, url, reference) {
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.locator(reference ? '.geographic-opening-host .zd-intro .zd-range' : '.geographic-opening-host input[type="range"]').waitFor({ state: 'visible', timeout: 45000 });
  await page.waitForFunction(() => document.querySelector('.opening-animation-overlay')?.classList.contains('is-ready'), null, { timeout: 45000 });
}
async function seek(page, seconds) {
  const range = page.locator('.geographic-opening-host input[type="range"]');
  await range.evaluate((element, value) => { element.value = String(value); element.dispatchEvent(new Event('input', { bubbles: true })); }, seconds);
  await frames(page);
}
async function captureCanvas(page, reference) {
  return page.locator(reference ? 'canvas.zd-effects' : '.geographic-opening-host canvas').evaluate(canvas => canvas.toDataURL());
}
async function exerciseCameraGesture(page) {
  const canvas = page.locator('canvas.player-canvas');
  const box = await canvas.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 8 }); await page.mouse.up();
  await page.mouse.wheel(0, 120); await frames(page);
  assert.equal(await canvas.isVisible(), true);
}

try {
  for (const [directory, reference, samples] of (remainingOnly ? [] : [['viewer-reference', true, [20, 38, 59, 61.6]], ['viewer-campus', false, [2, 8, 13, 14.6]]])) {
    const opening = await sceneOpening(directory);
    assert.equal(opening.template, 'package');
    const fixture = await pageFor(directory), { page, context, url } = fixture;
    await ready(page, url, reference);
    const host = page.locator('.geographic-opening-host');
    if (!reference) {
      const moduleFile = (await readdir(path.join(viewerRoots[directory], 'assets'))).find(name => name.startsWith('engineStore-') && name.endsWith('.js'));
      assert.ok(moduleFile);
      await page.evaluate(async name => {
        const module = await import(new URL('assets/' + name, location.href).href);
        const store = Object.values(module).find(value => Array.isArray(value?.Instances));
        window.__openingIsolationScene = store.Instances.flatMap(engine => engine.scenes).find(scene => scene.activeCamera);
      }, moduleFile);
      const before = await page.evaluate(() => ({ alpha: window.__openingIsolationScene.activeCamera.alpha, frame: window.__openingIsolationScene.getFrameId() }));
      await page.waitForTimeout(450);
      const after = await page.evaluate(() => ({ alpha: window.__openingIsolationScene.activeCamera.alpha, frame: window.__openingIsolationScene.getFrameId() }));
      assert.ok(after.frame > before.frame + 2, '开场中业务场景必须持续渲染');
      assert.ok(Math.abs(after.alpha - before.alpha) > 1e-5, '已配置自动巡检必须在开场中运行，不等开场结束');
      report.businessDuringOpening = { before, after }; log('开场中真实业务帧循环与自动巡检相机继续运行');
    }

    await (reference ? host.locator('[data-action="play"]') : host.getByRole('button', { name: '暂停', exact: true })).click();
    for (const seconds of samples) {
      await seek(page, seconds);
      await screenshot(page, `${directory}-${seconds}s`);
      const value = Number(await host.locator('input[type="range"]').inputValue());
      assert.ok(Math.abs(value - seconds) < .03);
    }
    await seek(page, samples[1]);
    const frozen = await captureCanvas(page, reference);
    await page.waitForTimeout(350);
    assert.equal(await captureCanvas(page, reference), frozen, '暂停后画布应冻结');
    await (reference ? host.locator('[data-action="play"]') : host.getByRole('button', { name: '播放', exact: true })).click();
    await page.waitForTimeout(450);
    assert.notEqual(await captureCanvas(page, reference), frozen, '恢复播放后飞线必须改变真实像素');
    await (reference ? host.locator('[data-action="skip"]').filter({ visible: true }).first() : host.getByRole('button', { name: '进入场景', exact: true })).click();
    await host.waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await page.locator('.opening-animation-overlay').count(), 0);
    await exerciseCameraGesture(page);
    await screenshot(page, `${directory}-skipped-to-scene`);
    assert.equal(await page.locator('canvas.player-canvas').count(), 1);
    log(`${directory}：三个中间帧及半透明交接帧、暂停像素冻结、恢复动态飞线、跳过归还业务场景`);
    if (!reference) {
      const assetCounts = () => [...requests.entries()].filter(([file]) => file.startsWith('/viewer-campus/') && /\/openings\/.*\.(svg|webp|png)$/.test(file)).reduce((sum, [, count]) => sum + count, 0);
      await page.waitForTimeout(500);
      const before = assetCounts();
      await ready(page, url, false);
      assert.equal(assetCounts(), before, '已就绪的包图片刷新应经发布资源缓存读取，不重复网络请求');
      await page.locator('.geographic-opening-host').getByRole('button', { name: '进入场景', exact: true }).click();
      await page.locator('.geographic-opening-host').waitFor({ state: 'detached' });
      report.warmCache = { before, after: assetCounts() };
      log('同一发布版本warm刷新：开场图片网络读取次数不增长');
    }
    await context.close();
  }

  if (!remainingOnly) {
    const { page, context, url } = await pageFor('viewer-campus');
    await ready(page, url, false);
    await page.locator('.geographic-opening-host').waitFor({ state: 'detached', timeout: 30000 });
    assert.equal(await page.locator('.opening-animation-overlay').count(), 0);
    await screenshot(page, 'viewer-campus-natural-completion');
    log('三段包从零自然播放完成并交接，没有人为寻帧');
    await context.close();
  }

  {
    const { page, context, url } = await pageFor('viewer-campus');
    const config = JSON.parse(await readFile(path.join(viewerRoots['viewer-campus'], 'runtime-config.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(path.resolve(viewerRoots['viewer-campus'], config.paths.assetManifest), 'utf8'));
    const asset = manifest.assets.find(item => item.path.endsWith('/assets/campus.svg'));
    assert.ok(asset);
    const assetUrl = new URL(asset.path, new URL(config.paths.assetBase, url)).href;
    let failures = 0;
    await page.route(assetUrl, async route => { failures++; await route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing opening fixture asset' }); });
    const diagnostic = page.waitForEvent('console', { predicate: message => ['error', 'warning'].includes(message.type()) && message.text().includes('开场素材 campus'), timeout: 30000 });
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await diagnostic;
    await page.locator('.geographic-opening-host').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.opening-animation-overlay').count(), 0);
    assert.ok(failures > 0, '必须实际命中损坏的开场资源请求');
    await exerciseCameraGesture(page);
    await screenshot(page, 'viewer-campus-missing-asset-fallback');
    log('必需素材404：记录具体诊断、清除开场遮罩、保留业务canvas');
    await context.close();
  }
  {
    const { page, context } = await pageFor('viewer-campus');
    await page.goto(`${base}/opening-host.html`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__openingPackageHost.events.some(event => event.type === 'viewer.initialLoadState' && event.payload.phase === 'complete'), null, { timeout: 45000 });
    const frame = page.frameLocator('#viewer');
    assert.equal(await frame.locator('.geographic-opening-host').count(), 0, '宿主未显示前不创建动画');
    await page.evaluate(() => { const document = window.document.querySelector('#viewer').contentDocument; window.__openingBusinessCanvas = document.querySelector('canvas.player-canvas'); });
    await page.getByRole('button', { name: '显示 Viewer', exact: true }).click();
    await frame.locator('.opening-animation-overlay.is-ready').waitFor();
    await page.evaluate(() => { window.__openingSameHost = document.querySelector('#viewer').contentDocument.querySelector('.geographic-opening-host'); });
    const range = frame.locator('.geographic-opening-host input[type="range"]');
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '隐藏 Viewer', exact: true }).click();
    await page.waitForTimeout(100);
    const hiddenTime = Number(await range.inputValue());
    await page.waitForTimeout(500);
    assert.equal(Number(await range.inputValue()), hiddenTime, '父宿主隐藏应冻结播放时钟');
    await page.getByRole('button', { name: '显示 Viewer', exact: true }).click();
    await page.waitForTimeout(400);
    assert.ok(Number(await range.inputValue()) > hiddenTime);
    assert.equal(await page.evaluate(() => document.querySelector('#viewer').contentDocument.querySelector('.geographic-opening-host') === window.__openingSameHost), true);
    await screenshot(page, 'viewer-campus-embedded-visible');
    await frame.getByRole('button', { name: '进入场景', exact: true }).click();
    await frame.locator('.geographic-opening-host').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.querySelector('#viewer').contentDocument.querySelector('canvas.player-canvas') === window.__openingBusinessCanvas), true);
    report.embeddedEvents = await page.evaluate(() => window.__openingPackageHost.events.filter(event => event.channel === 'zending.opening.v1'));
    log('真实DIST iframe：宿主等待、显示后播放、隐藏暂停、再显示同实例继续、跳过保留同一业务canvas');
    await context.close();
  }
  {
    const { page, context, url } = await pageFor('viewer-legacy');
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('canvas.player-canvas') && !document.querySelector('#scene-loading-mask-detail'));
    assert.equal(await page.locator('.geographic-opening-host,.opening-animation-overlay').count(), 0);
    assert.equal([...requests.keys()].some(file => /^\/viewer-legacy\/assets\/asset-\d+.*\.webp$/.test(file)), false);
    await exerciseCameraGesture(page); await screenshot(page, 'viewer-no-opening');
    log('未绑定开场：三维正常加载和操作，无开场DOM及无关参考图片请求'); await context.close();
  }
  assert.deepEqual(report.pageErrors, []);
  report.ok = true;
} catch (error) {
  report.failure = error.stack ?? String(error);
  if (activePage && !activePage.isClosed()) await screenshot(activePage, 'failure').catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'runtime-smoke-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  console.log(JSON.stringify(report, null, 2));
}
