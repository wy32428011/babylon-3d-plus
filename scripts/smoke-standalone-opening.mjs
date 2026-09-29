import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import unzipper from 'unzipper';
import { chromium } from 'playwright';

// 只验收实际 ZIP 解包产物；不引用源码、不启动产品开发服务、不修改包内文件。
const zipArgument = process.argv.slice(2).find(argument => !argument.startsWith('--'));
assert.ok(zipArgument, '用法：node scripts/smoke-standalone-opening.mjs <最终插件包.zip> [--quick]');
const zipPath = path.resolve(zipArgument);
const quick = process.argv.includes('--quick');
const integrationOnly = process.argv.includes('--integration-only');
const outputBase = path.resolve('output/standalone-opening');
await mkdir(outputBase, { recursive: true });
const output = await mkdtemp(path.join(outputBase, 'smoke-'));
const extracted = path.join(output, 'extracted');
await mkdir(extracted);
const archive = await unzipper.Open.file(zipPath);
for (const entry of archive.files) {
  const target = path.resolve(extracted, entry.path);
  const relative = path.relative(extracted, target);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `ZIP 路径越界：${entry.path}`);
  if (entry.type === 'Directory') { await mkdir(target, { recursive: true }); continue; }
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(entry.stream(), createWriteStream(target));
}
const demos = archive.files.filter(entry => /(?:^|\/)demo\.html$/.test(entry.path));
assert.equal(demos.length, 1, '插件包必须有唯一 demo.html 入口');
const packageRoot = path.dirname(path.resolve(extracted, demos[0].path));
for (const relative of ['demo.html', 'iframe-demo.html', 'dist/zending-opening.js', 'dist/zending-opening.mjs', 'dist/zending-opening.css']) {
  assert.ok((await readFile(path.join(packageRoot, relative))).length > 0, `包内缺少 ${relative}`);
}
const report = { ok: false, zipPath, output, packageRoot, quick, integrationOnly, checks: [], results: {}, errors: [], externalRequests: [],
  boundaries: '从最终ZIP解包后验收；file:// IIFE与iframe为真实离线文件，HTTP ESM引用包内产物；并发/销毁使用本地API夹具。document.visibilityState分支为显式API fixture，hostVisible及真实iframe显隐独立验证，不代表OS后台页签实测。' };
const esmFixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/dist/zending-opening.css"><style>body{margin:0;background:#07131d;color:#dceef5;font-family:sans-serif}.grid{display:flex;gap:24px;padding:24px}.tile{width:600px;height:400px;position:relative;border:1px solid #244b5f}h1{font-size:20px;font-weight:500;margin:24px 24px 0}</style></head><body><h1>ESM · 并发实例验收</h1><div class="grid"><div id="instanceA" class="tile"></div><div id="instanceB" class="tile"></div></div><script type="module">
import {createOpening,defaultSettings,VERSION} from '/dist/zending-opening.mjs';
window.sdk={createOpening,defaultSettings,VERSION};window.eventsA=[];window.eventsB=[];window.completedA=[];window.completedB=[];
const settings=brandName=>({reference:{brandName,stageDurations:[4,2,2,2,2,2,2,2,2]},allowSkip:true});
window.a=createOpening(document.getElementById('instanceA'),{settings:settings('并发实例 A'),autoplay:false,onProgress:state=>window.eventsA.push(state),onComplete:event=>window.completedA.push(event)});
window.b=createOpening(document.getElementById('instanceB'),{settings:settings('并发实例 B'),onProgress:state=>window.eventsB.push(state),onComplete:event=>window.completedB.push(event)});
await Promise.all([a.ready,b.ready]);window.esmReady=true;
</script></body></html>`;
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml' };
const server = createServer((request, response) => { void (async () => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/__esm-fixture__') { response.writeHead(200, { 'Content-Type':mime['.html'] }).end(esmFixture); return; }
    const file = path.resolve(packageRoot, '.' + (pathname === '/' ? '/demo.html' : pathname));
    const relative = path.relative(packageRoot, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'application/octet-stream' }).end(body);
  } catch (error) { if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(); }
})(); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, context, page;
const observe = target => { target.setDefaultTimeout(45_000); target.on('pageerror', error => report.errors.push(error.message)); };
const state = frame => frame.evaluate(() => window.openingDemo.instance.getState());
async function waitDemo(frame, status = 'playing') {
  await frame.waitForFunction(status => {
    const actual = window.openingDemo?.instance?.getState().status;
    return actual === status || actual === 'failed';
  }, status);
  const actual = await state(frame);
  assert.equal(actual.status, status, actual.error || `期望 ${status}，实际 ${actual.status}`);
  await frame.evaluate(async () => { await window.openingDemo.instance.ready; });
}
async function frozen(frame, read, milliseconds = 800) {
  const before = await frame.evaluate(read);
  await new Promise(resolve => setTimeout(resolve, milliseconds));
  const after = await frame.evaluate(read);
  assert.ok(Math.abs(after - before) < 0.08, `暂停期间时钟变化：${before} -> ${after}`);
  return { before, after };
}
async function visibleOpening(target, name) {
  const mount = target.locator('#openingMount');
  assert.equal(await mount.locator('canvas').count(), 3, '开场应挂载三层实际画布');
  const screenshot = await mount.screenshot({ path:path.join(output, `${name}.png`) });
  const blue = await target.evaluate(async data => {
    const image = new Image(); image.src='data:image/png;base64,'+data; await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d');context.drawImage(image,0,0);
    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let count=0;
    for(let index=0;index<pixels.length;index+=4)if(pixels[index]<100&&pixels[index+2]>110&&pixels[index+2]>pixels[index]*1.5)count++;
    return count;
  }, screenshot.toString('base64'));
  assert.ok(blue > 1500, `开场需要实际蓝色画面像素，得到 ${blue}`);
  return blue;
}
async function openingLayout(target, selector) {
  return target.locator(selector).evaluate(root => {
    const title = root.querySelector('[data-role="hero-title"]');
    const route = root.querySelector('.zd-hero-route');
    const player = root.querySelector('.zd-player');
    const titleBox = title.getBoundingClientRect();
    const routeBox = route.getBoundingClientRect();
    const playerBox = player.getBoundingClientRect();
    const containerBox = root.getBoundingClientRect();
    return { width:containerBox.width, height:containerBox.height,
      titleLines:titleBox.height / parseFloat(getComputedStyle(title).lineHeight),
      routeVisible:getComputedStyle(route).display !== 'none', routeBottom:routeBox.bottom, playerTop:playerBox.top };
  });
}
try {
  browser = await chromium.launch({ channel:'chrome', headless:true });
  context = await browser.newContext({ viewport:{ width:1440, height:1000 } });
  await context.route(/^https?:\/\//, route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    report.externalRequests.push(route.request().url());
    return route.abort('blockedbyclient');
  });

  if (!integrationOnly) {
    page = await context.newPage(); observe(page);
    const fileUrl = pathToFileURL(path.join(packageRoot, 'demo.html')).href;
    await page.goto(fileUrl + (quick ? '?duration=6' : ''));
    await waitDemo(page);
    const initial = await state(page);
    assert.ok(Math.abs(initial.totalDurationSeconds - (quick ? 6 : 62)) < 0.05);
    await page.waitForFunction(() => window.openingDemo.instance.getState().elapsedSeconds >= 0.9);
    const bluePixels = await visibleOpening(page, 'file-iife-first-frame');
    const desktopLayout = await openingLayout(page, '#openingMount');
    assert.ok(desktopLayout.titleLines >= 1.9 && desktopLayout.titleLines <= 2.1, `约1052px容器默认主标题应保持两行：${JSON.stringify(desktopLayout)}`);
    assert.ok(!desktopLayout.routeVisible || desktopLayout.routeBottom <= desktopLayout.playerTop, '路线文案不得压入底部控制条');
    await page.screenshot({ path:path.join(output, 'file-iife-desktop-page.png') });
    console.log(`START file IIFE: ${initial.totalDurationSeconds}s; bluePixels=${bluePixels}; output=${output}`);
    await page.getByRole('button', { name:'暂停播放', exact:true }).click();
    await waitDemo(page, 'paused');
    const pause = await frozen(page, () => window.openingDemo.instance.getState().elapsedSeconds);
    await page.getByRole('button', { name:'继续播放', exact:true }).click();
    await waitDemo(page);
    await page.evaluate(() => window.openingDemo.instance.setHostVisible(false));
    await waitDemo(page, 'paused');
    const hostHidden = await frozen(page, () => window.openingDemo.instance.getState().elapsedSeconds);
    await page.evaluate(() => window.openingDemo.instance.setHostVisible(true));
    await waitDemo(page);
    await page.waitForFunction(target => {
      const state = window.openingDemo.instance.getState(); return state.status === 'failed' || state.elapsedSeconds >= target;
    }, initial.totalDurationSeconds * 0.53);
    assert.notEqual((await state(page)).status, 'failed', (await state(page)).error || '开场中途失败');
    await page.screenshot({ path:path.join(output, 'file-iife-middle.png') });
    console.log('FRAME file IIFE: middle captured');
    if (!quick) {
      await page.waitForFunction(() => window.openingDemo.instance.getState().stageIndex === 8, null, { timeout:60_000 });
      await page.screenshot({ path:path.join(output, 'file-iife-finale.png') });
    }
    await page.waitForFunction(() => window.openingDemo.instance.getState().status === 'completed', null, { timeout:70_000 });
    assert.equal(await page.locator('#openingMount canvas').count(), 0);
    await page.getByRole('button', { name:'重新体验开场', exact:true }).waitFor({ state:'visible' });
    const finished = await page.evaluate(() => ({ state:window.openingDemo.instance.getState(), history:window.openingDemo.history }));
    assert.equal(finished.history.filter(event => event.type === 'complete' && event.reason === 'completed').length, 1);
    if (!quick) assert.deepEqual([...new Set(finished.history.filter(event => event.type === 'state').map(event => event.stageIndex).filter(index => index >= 0 && index <= 8))].sort((a,b)=>a-b), [0,1,2,3,4,5,6,7,8]);
    await page.screenshot({ path:path.join(output, 'file-iife-completed.png') });
    report.results.file = { initial, bluePixels, desktopLayout, pause, hostHidden, finished };
    report.checks.push(`file:// IIFE离线首播、实际画面、${quick ? '6秒' : '默认62秒九段'}自然结束、完成回调一次、手动与hostVisible暂停及恢复`);
    console.log('PASS file IIFE natural playback');

    await page.evaluate(() => {
      document.getElementById('settingsForm').requestSubmit();
      document.getElementById('settingsForm').requestSubmit();
      document.getElementById('replay').click();
    });
    await waitDemo(page);
    assert.equal(await page.locator('#errorText').isHidden(), true, '快速重建与restart取消旧ready不得显示迟到AbortError');
    assert.equal(await page.locator('#openingMount').evaluate(element => getComputedStyle(element).pointerEvents), 'auto');
    report.checks.push('快速连续应用设置和restart期间，旧轮ready取消不污染当前UI');
    await page.getByLabel('品牌名称', { exact:true }).fill('独立插件 · 自定义品牌');
    await page.getByLabel('开场主标题', { exact:true }).fill('从网页出发\n抵达业务现场');
    await page.locator('#duration').fill('4');
    await page.locator('#allowSkip').uncheck();
    await page.getByRole('button', { name:'应用并重播', exact:true }).click();
    await waitDemo(page);
    assert.equal(await page.locator('#openingMount [data-role="brand-name"]').textContent(), '独立插件 · 自定义品牌');
    assert.ok(Math.abs((await state(page)).totalDurationSeconds - 4) < 0.05);
    await page.evaluate(() => window.openingDemo.instance.pause());
    const beforeBlockedSkip = await state(page);
    await page.evaluate(() => { window.openingDemo.instance.skip(); window.openingDemo.instance.seek(3.8); });
    await page.keyboard.press('Escape');
    const afterBlockedSkip = await state(page);
    assert.equal(afterBlockedSkip.status, 'paused');
    assert.equal(afterBlockedSkip.elapsedSeconds, beforeBlockedSkip.elapsedSeconds);
    assert.equal(await page.locator('#skip').isDisabled(), true);
    await page.getByRole('button', { name:'继续播放', exact:true }).click();
    await waitDemo(page, 'completed');
    report.checks.push('真实设置表单应用自定义品牌/标题/4秒时长；allowSkip=false同时禁止按钮、API skip/seek与Escape；短自然结束');
    await page.locator('#allowSkip').check();
    await page.locator('#duration').fill('12');
    await page.getByRole('button', { name:'应用并重播', exact:true }).click();
    await waitDemo(page);
    await page.getByRole('button', { name:'跳过开场', exact:true }).click();
    await waitDemo(page, 'skipped');
    await page.getByRole('button', { name:'重新体验开场', exact:true }).click();
    await waitDemo(page);
    assert.ok((await state(page)).elapsedSeconds < 2);
    report.checks.push('allowSkip=true允许跳过并释放动画；业务占位按钮重新播放成功');
    await page.setViewportSize({ width:390, height:844 });
    await page.goto(fileUrl + '?duration=12'); await waitDemo(page);
    await page.waitForFunction(() => window.openingDemo.instance.getState().elapsedSeconds > 0.4);
    await page.screenshot({ path:path.join(output, 'file-iife-narrow-page.png'), fullPage:true });
    const narrowLayout = await openingLayout(page, '#openingMount');
    assert.ok(narrowLayout.titleLines <= 2.1, `窄视口默认标题不应产生额外断行：${JSON.stringify(narrowLayout)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, '窄视口不得横向溢出');
    report.results.narrowLayout = narrowLayout;
    report.checks.push('约1052px容器默认标题两行且路线不压控制条；390px窄视口无横向溢出并留截图');
    await page.close();
    console.log('PASS demo settings, skip policy and replay');
  }

  page = await context.newPage(); observe(page);
  await page.goto(pathToFileURL(path.join(packageRoot, 'iframe-demo.html')).href + '?duration=16');
  const frame = await (await page.locator('#openingFrame').elementHandle()).contentFrame();
  assert.ok(frame); await waitDemo(frame);
  await page.waitForFunction(() => window.iframeDemoState?.status === 'playing');
  await page.screenshot({ path:path.join(output, 'iframe-file-playing.png') });
  await page.getByRole('button', { name:'暂停', exact:true }).click(); await waitDemo(frame, 'paused');
  const iframePause = await frozen(frame, () => window.openingDemo.instance.getState().elapsedSeconds);
  await page.getByRole('button', { name:'继续', exact:true }).click(); await waitDemo(frame);
  await page.getByRole('button', { name:'隐藏动画', exact:true }).click(); await waitDemo(frame, 'paused');
  assert.equal(await page.locator('#openingFrame').evaluate(element => getComputedStyle(element).visibility), 'hidden');
  const iframeHidden = await frozen(frame, () => window.openingDemo.instance.getState().elapsedSeconds);
  await page.screenshot({ path:path.join(output, 'iframe-file-hidden.png') });
  await page.getByRole('button', { name:'显示动画', exact:true }).click(); await waitDemo(frame);
  await page.getByRole('button', { name:'重新播放', exact:true }).click(); await waitDemo(frame);
  assert.ok((await state(frame)).elapsedSeconds < 2);
  report.results.iframe = { pause:iframePause, hostHidden:iframeHidden };
  report.checks.push('file://独立iframe演示：postMessage暂停/恢复，真实隐藏后hostVisible暂停，显示继续及重播');
  await page.close();
  console.log('PASS offline iframe integration');

  page = await context.newPage(); observe(page);
  await page.goto(`${origin}/__esm-fixture__`);
  await page.waitForFunction(() => window.esmReady === true);
  assert.equal(await page.evaluate(() => typeof window.sdk.VERSION), 'string');
  assert.equal(await page.locator('#instanceA canvas').count(), 3);
  assert.equal(await page.locator('#instanceB canvas').count(), 3);
  const initialA = await page.evaluate(() => window.a.getState());
  assert.equal(initialA.elapsedSeconds, 0, 'autoplay=false准备完成后不得自动计时');
  await page.evaluate(() => window.a.play());
  await page.waitForFunction(() => window.a.getState().elapsedSeconds > 0.5 && window.b.getState().elapsedSeconds > 0.5);
  await page.screenshot({ path:path.join(output, 'esm-two-instances.png') });
  const compactLayout = await openingLayout(page, '#instanceA');
  assert.ok(compactLayout.titleLines <= 2.1, `600px实例标题不应额外断行：${JSON.stringify(compactLayout)}`);
  await page.evaluate(() => window.a.pause());
  const bBefore = await page.evaluate(() => window.b.getState().elapsedSeconds);
  const isolatedPause = await frozen(page, () => window.a.getState().elapsedSeconds);
  assert.ok(await page.evaluate(previous => window.b.getState().elapsedSeconds > previous + 0.4, bBefore), '暂停A不得影响B');
  await page.evaluate(() => { window.a.resume(); window.b.setHostVisible(false); });
  const aBefore = await page.evaluate(() => window.a.getState().elapsedSeconds);
  const isolatedHidden = await frozen(page, () => window.b.getState().elapsedSeconds);
  assert.ok(await page.evaluate(previous => window.a.getState().elapsedSeconds > previous + 0.4, aBefore), '隐藏B不得影响A');
  await page.evaluate(() => { window.b.setHostVisible(true); window.a.destroy(); window.a.destroy(); });
  assert.equal(await page.locator('#instanceA').evaluate(element => element.childElementCount), 0);
  assert.equal(await page.locator('#instanceB canvas').count(), 3);
  const destroyedEvents = await page.evaluate(() => window.eventsA.length);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.eventsA.length), destroyedEvents, 'destroy后不得继续回调');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable:true, get:()=>'hidden' });
    Object.defineProperty(document, 'hidden', { configurable:true, get:()=>true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.b.getState().documentVisible === false && window.b.getState().isPaused);
  const documentHidden = await frozen(page, () => window.b.getState().elapsedSeconds);
  await page.evaluate(() => { delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => window.b.getState().status === 'playing');
  await page.evaluate(() => { window.b.skip(); window.b.skip(); });
  await page.waitForFunction(() => window.b.getState().status === 'skipped');
  assert.equal(await page.locator('#instanceB').evaluate(element => element.childElementCount), 0);
  assert.deepEqual(await page.evaluate(() => window.completedB), [{ reason:'skipped' }]);
  const cancellation = await page.evaluate(async () => {
    const instance = window.sdk.createOpening(document.getElementById('instanceA'));
    const pending = instance.ready.then(() => 'resolved', error => error.name);
    instance.destroy();
    return { result:await pending, state:instance.getState(), children:document.getElementById('instanceA').childElementCount };
  });
  assert.equal(cancellation.result, 'AbortError');
  assert.equal(cancellation.state.status, 'destroyed');
  assert.equal(cancellation.children, 0);
  report.results.esm = { initialA, compactLayout, isolatedPause, isolatedHidden, documentHidden, cancellation };
  report.checks.push('HTTP加载真实ESM：autoplay=false、并发实例独立暂停/hostVisible、document可见性fixture、destroy幂等并清理DOM/回调、加载中销毁AbortError、完成回调恰好一次');
  await page.screenshot({ path:path.join(output, 'esm-destroyed.png') });
  await page.close();
  console.log('PASS ESM, instance isolation and cleanup');

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.externalRequests, [], '离线插件不得发出外部HTTP请求');
  report.ok = true;
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok:true, output, checks:report.checks, errors:report.errors }));
} catch (error) {
  report.failure = String(error?.stack || error);
  report.state = await page?.evaluate(() => window.openingDemo?.instance?.getState()).catch(() => null);
  report.body = await page?.locator('body').innerText().catch(() => null);
  await page?.screenshot({ path:path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify(report, null, 2));
  console.error(`Standalone opening smoke failed; output=${output}`);
  throw error;
} finally {
  await context?.close(); await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
