/* global document, window, location, Element, MutationObserver, getComputedStyle */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// 使用实际导出的 DIST 包；不在验收过程中构建或替换 Viewer 源码。
const packageRoot = path.resolve(process.env.OPENING_PACKAGE_OUTPUT ?? 'output/opening-packages');
const output = path.resolve(process.env.OPENING_REPLAY_OUTPUT ?? 'output/playwright/opening-replay');
const selection = process.argv.find(argument => argument.startsWith('--only='))?.slice(7).split(',');
const requested = selection ?? ['campus', 'reference', 'prismatic', 'no-opening'];
const requests = new Map(), consoleStates = new WeakMap();
const report = {
  ok: false, checks: [], screenshots: [], fixtures: {}, pageErrors: [], diagnosticErrors: [],
  warnings: [], openingWarnings: [], openingTerminals: [],
  boundary: '本地真实导出 DIST Viewer、Chrome/WebGL；业务 API 使用本地配置桩。场景来自发布夹具，不代表线上部署、真实 MQTT 或现场验收。',
};
const replayLabel = '返回开场动画';
const hostSelector = '.geographic-opening-host';
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};
const fixtures = {};
let browser, activePage, server;
const check = message => { report.checks.push(message); console.log(message); };
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};
const hostHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
body{margin:0;background:#07111b;color:white;font:14px system-ui}header{height:44px;display:flex;align-items:center;gap:12px;padding:0 14px}
button{padding:4px 10px}iframe{display:block;width:100vw;height:calc(100vh - 44px);border:0;visibility:hidden}
</style><header><button id="show">显示 Viewer</button><button id="hide">隐藏 Viewer</button><span id="state">等待宿主</span></header><iframe id="viewer"></iframe><script>
const frame=document.querySelector('#viewer'),sessionId='opening-replay-smoke',events=[];let visible=false;
const send=(type,extra={})=>frame.contentWindow.postMessage({channel:type==='host.hello'?'zending.digital-twin.bridge':'zending.opening.v1',version:1,sessionId,type,...extra},location.origin);
const setVisible=value=>{visible=value;frame.style.visibility=value?'visible':'hidden';send('host.visibility',{visible});};
const hello=()=>{send('host.hello');send('host.visibility',{visible});};
const timer=setInterval(hello,250);frame.addEventListener('load',hello);
window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!==location.origin)return;events.push(event.data);if(['bridge.ready','viewer.ready'].includes(event.data.type))clearInterval(timer);if(event.data.channel==='zending.opening.v1'&&event.data.type==='viewer.state'){document.querySelector('#state').textContent=event.data.phase;send('host.visibility',{visible});}});
document.querySelector('#show').onclick=()=>setVisible(true);document.querySelector('#hide').onclick=()=>setVisible(false);
window.__openingReplayHost={events,sessionId,setVisible};frame.src='/campus/';
</script></html>`;

async function loadFixtures() {
  const manifest = await readFile(path.join(packageRoot, 'packages-result.json'), 'utf8').then(JSON.parse, () => ({}));
  const definitions = {
    campus: process.env.OPENING_REPLAY_CAMPUS ?? manifest.distRoots?.[1] ?? path.join(packageRoot, 'viewer-campus'),
    reference: process.env.OPENING_REPLAY_REFERENCE ?? manifest.distRoots?.[0] ?? path.join(packageRoot, 'viewer-reference'),
    'no-opening': process.env.OPENING_REPLAY_NO_OPENING ?? manifest.distRoots?.[2] ?? path.join(packageRoot, 'viewer-legacy'),
    prismatic: process.env.OPENING_REPLAY_PRISMATIC ?? 'output/playwright/prismatic-opening/published-viewer',
  };
  for (const name of requested) {
    assert.ok(Object.hasOwn(definitions, name), `未知夹具 ${name}`);
    const root = path.resolve(definitions[name]);
    assert.ok(await stat(path.join(root, 'index.html')).then(value => value.isFile(), () => false), `缺少 DIST Viewer：${root}`);
    const config = JSON.parse(await readFile(path.join(root, 'runtime-config.json'), 'utf8'));
    const sceneFile = path.resolve(root, config.paths.scene);
    assert.ok(inside(root, sceneFile), `场景路径超出发布目录：${sceneFile}`);
    const document = JSON.parse(await readFile(sceneFile, 'utf8'));
    const scene = document.scene ?? document;
    fixtures[name] = { name, root, config, scene, patrol: Object.values(scene.entities ?? {}).some(entity => entity.components?.autoPatrol?.enabled && entity.components.autoPatrol.autoStart) };
    report.fixtures[name] = { root, patrol: fixtures[name].patrol, rounds: [], cameraAcceptance: fixtures[name].patrol
      ? '依据 AutoPatrolPlaybackController.resolveAutomaticViewMode/createViewPose：巡检会在 orbit/third-person 间切换，半径与视角允许正常变化；验证同实例、有效姿态、相机自身限制及业务帧和巡检运动持续推进。'
      : '实际手势改变相机并等惯性收敛后，重播全程相机姿态保持不变。' };
  }
}

function serve(request, response) {
  void (async () => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
      if (pathname === '/api/v1/digital-twin/runtime-config/detail') {
        response.writeHead(200, { 'content-type': mime['.json'] }).end(JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true } })); return;
      }
      if (pathname === '/opening-replay-host.html') { response.writeHead(200, { 'content-type': mime['.html'] }).end(hostHtml); return; }
      const route = /^\/([^/]+)\/(.*)$/.exec(pathname), fixture = fixtures[route?.[1]];
      if (!fixture) { response.writeHead(404).end(); return; }
      const file = path.resolve(fixture.root, route[2] || 'index.html');
      if (!inside(fixture.root, file)) { response.writeHead(403).end(); return; }
      response.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(await readFile(file));
    } catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(); }
  })();
}

async function screenshot(page, name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file }); report.screenshots.push(file);
}

async function newPage(name) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  const page = await context.newPage(); activePage = page; page.setDefaultTimeout(45000);
  const capture = { terminals: [], openingWarnings: [] }; consoleStates.set(page, capture);
  page.on('pageerror', error => report.pageErrors.push({ fixture: name, message: error.message }));
  page.on('console', message => {
    const text = message.text(), type = message.type();
    if (type === 'error') report.diagnosticErrors.push({ fixture: name, message: text });
    if (type === 'warning') {
      const warning = { fixture: name, message: text }; report.warnings.push(warning);
      if (/开场|\[Viewer opening\]/i.test(text)) { report.openingWarnings.push(warning); capture.openingWarnings.push(warning); }
    }
    if (type === 'info' && text.includes('[Viewer opening] 开场结束')) {
      const terminal = { fixture: name, message: text, settled: false };
      capture.terminals.push(terminal); report.openingTerminals.push(terminal);
      // 读取日志的结构化终态，避免把 failed/cancelled 的 DOM 移除误判成自然完成。
      const detail = message.args()[1];
      if (!detail) { terminal.parseError = '终态日志缺少结构化对象'; terminal.settled = true; return; }
      void detail.jsonValue().then(value => { terminal.result = value?.result; terminal.template = value?.template; },
        error => { terminal.parseError = String(error); }).finally(() => { terminal.settled = true; });
    }
  });
  return { context, page };
}

const terminalCount = page => consoleStates.get(page).terminals.length;
async function assertTerminal(page, start, expected) {
  const capture = consoleStates.get(page), deadline = Date.now() + 5000;
  while ((capture.terminals.length <= start || capture.terminals.slice(start).some(terminal => !terminal.settled)) && Date.now() < deadline) await page.waitForTimeout(25);
  const terminals = capture.terminals.slice(start);
  assert.equal(terminals.length, 1, '每一轮必须且只能收到一次开场终态日志');
  assert.equal(terminals[0].parseError, undefined, '必须能够读取结构化开场终态');
  assert.equal(terminals[0].result, expected, `本轮开场必须以 ${expected} 结束`);
  assert.deepEqual(capture.openingWarnings, [], '正常重播路径不可出现开场失败或可见性超时警告');
  return terminals[0];
}

async function openingReady(surface) {
  await surface.locator('.opening-animation-overlay.is-ready').waitFor({ timeout: 60000 });
  await surface.locator(`${hostSelector} input[type="range"]`).waitFor();
  assert.equal(await surface.locator(hostSelector).count(), 1, '同时只能存在一个开场视觉实例');
  assert.equal(await surface.locator('.opening-animation-overlay').count(), 1, '同时只能存在一个开场遮罩');
}

async function skipOpening(surface) {
  const referenceSkip = surface.locator(`${hostSelector} [data-action="skip"]:visible`).first();
  if (await referenceSkip.count()) await referenceSkip.click();
  // 参考包窄屏会按原有响应式规则隐藏文字跳过按钮，沿用 Viewer 的 Esc 跳过入口。
  else if (await surface.locator(`${hostSelector} .zd-intro`).count()) await surface.locator('body').press('Escape');
  else await surface.locator(hostSelector).getByRole('button', { name: '进入场景', exact: true }).click();
  await surface.locator(hostSelector).waitFor({ state: 'detached' });
  await surface.getByRole('button', { name: replayLabel, exact: true }).waitFor();
}

async function naturalCompletion(surface, { full = false } = {}) {
  const host = surface.locator(hostSelector), range = host.locator('input[type="range"]');
  if (full) {
    await host.waitFor({ state: 'detached', timeout: 30000 });
    await surface.getByRole('button', { name: replayLabel, exact: true }).waitFor();
    return;
  }
  const referencePlay = host.locator('[data-action="play"]');
  const reference = await referencePlay.count() > 0;
  await (reference ? referencePlay : host.getByRole('button', { name: '暂停', exact: true })).click();
  const end = await range.evaluate(element => {
    const end = Number(element.max) - 0.3;
    element.value = String(end); element.dispatchEvent(new Event('input', { bubbles: true })); return end;
  });
  assert.ok(end > 0, '开场时长必须有效');
  await (reference ? referencePlay : host.getByRole('button', { name: '播放', exact: true })).click();
  await host.waitFor({ state: 'detached', timeout: 15000 });
  await surface.getByRole('button', { name: replayLabel, exact: true }).waitFor();
}

async function installSceneProbe(surface, fixture) {
  const storeFile = (await readdir(path.join(fixture.root, 'assets'))).find(name => /^engineStore-.*\.js$/.test(name));
  assert.ok(storeFile, 'DIST 必须包含可定位业务引擎的 engineStore 模块');
  const gpu = await surface.evaluate(async name => {
    const module = await import(new URL(`assets/${name}`, location.href).href);
    const store = Object.values(module).find(value => Array.isArray(value?.Instances));
    const canvas = document.querySelector('canvas.player-canvas');
    const engine = store?.Instances.find(candidate => candidate.getRenderingCanvas() === canvas);
    const scene = engine?.scenes.find(candidate => candidate.activeCamera);
    if (!scene) throw new Error('无法定位真实业务场景');
    const probe = window.__openingReplaySmoke = { store, engine, scene, camera: scene.activeCamera, canvas, maxOverlays: 0, maxHosts: 0, overlayMounts: 0, hostMounts: 0, loadingMasks: 0 };
    const inspect = (records = []) => {
      const overlays = document.querySelectorAll('.opening-animation-overlay').length;
      probe.maxOverlays = Math.max(probe.maxOverlays, overlays);
      probe.maxHosts = Math.max(probe.maxHosts, document.querySelectorAll('.geographic-opening-host').length);
      probe.loadingMasks += Number(Boolean(document.querySelector('#scene-loading-mask-detail')));
      // 统计实际新增节点，连同同一微任务中又被移除的重复实例一起检测。
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        probe.overlayMounts += Number(node.matches('.opening-animation-overlay')) + node.querySelectorAll('.opening-animation-overlay').length;
        probe.hostMounts += Number(node.matches('.geographic-opening-host')) + node.querySelectorAll('.geographic-opening-host').length;
      }
    };
    probe.observer = new MutationObserver(inspect); probe.observer.observe(document.documentElement, { childList: true, subtree: true }); inspect();
    const gl = engine._gl, extension = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), version: gl.getParameter(gl.VERSION) };
  }, storeFile);
  report.fixtures[fixture.name].gpu = gpu;
}

function sceneState(surface) {
  return surface.evaluate(() => {
    const probe = window.__openingReplaySmoke, camera = probe.scene.activeCamera;
    return {
      sameCanvas: document.querySelector('canvas.player-canvas') === probe.canvas,
      sameScene: probe.engine.scenes.includes(probe.scene) && probe.store.Instances.includes(probe.engine),
      sameCamera: camera === probe.camera, frame: probe.scene.getFrameId(), time: performance.now(),
      alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.asArray(),
      limits: { lowerRadius: camera.lowerRadiusLimit, upperRadius: camera.upperRadiusLimit, lowerBeta: camera.lowerBetaLimit, upperBeta: camera.upperBetaLimit },
      maxOverlays: probe.maxOverlays, maxHosts: probe.maxHosts, overlayMounts: probe.overlayMounts, hostMounts: probe.hostMounts, loadingMasks: probe.loadingMasks,
    };
  });
}

function assertContinuity(before, after, patrol) {
  assert.ok(after.sameCanvas && after.sameScene && after.sameCamera, '业务 canvas、Scene 和相机必须保留同一实例');
  assert.ok(after.frame > before.frame + 1, '重播期间业务帧必须继续运行');
  assert.ok(after.maxOverlays <= 1 && after.maxHosts <= 1, '重播不可重入或遗留旧视觉实例');
  assert.equal(after.loadingMasks, 0, '重播不可重新挂载首次加载遮罩');
  const alphaDelta = Math.abs(after.alpha - before.alpha);
  const betaDelta = Math.abs(after.beta - before.beta), radiusDelta = Math.abs(after.radius - before.radius);
  const targetDelta = Math.hypot(...after.target.map((value, index) => value - before.target[index]));
  if (patrol) {
    // 自动视角接近航点时从第三人称切回 orbit；第三人称半径由后退距离和高度反算，不能要求整轮距离不变。
    assert.ok([after.alpha, after.beta, after.radius, ...after.target].every(Number.isFinite) && after.radius > 0, '巡检相机必须保持有效有限姿态');
    for (const [value, lower, upper] of [[after.radius, after.limits.lowerRadius, after.limits.upperRadius], [after.beta, after.limits.lowerBeta, after.limits.upperBeta]]) {
      if (Number.isFinite(lower)) assert.ok(value >= lower - 1e-6, '巡检相机不可越过运行时配置的下限');
      if (Number.isFinite(upper)) assert.ok(value <= upper + 1e-6, '巡检相机不可越过运行时配置的上限');
    }
    assert.ok(alphaDelta > 1e-5 || betaDelta > 1e-5 || radiusDelta > 1e-5 || targetDelta > 1e-5, '自动巡检在重播期间必须继续推进');
  } else {
    assert.ok(alphaDelta < 0.005 && betaDelta < 0.005 && radiusDelta < 0.005 && targetDelta < 0.005, '静止业务相机不可被开场重置');
  }
}

function resourceCounts(name) {
  return [...requests.entries()].filter(([url]) => url.startsWith(`/${name}/`) && (/\/scene\.json$/.test(url) || /\.glb$/i.test(url))).sort(([left], [right]) => left.localeCompare(right));
}

async function checkButton(page, name) {
  const button = page.getByRole('button', { name: replayLabel, exact: true });
  await page.mouse.move(10, 850); await button.evaluate(element => element.blur());
  await page.waitForTimeout(180);
  const styles = await button.evaluate(element => {
    const box = element.getBoundingClientRect(), icon = element.querySelector('svg'), style = getComputedStyle(element);
    const iconBox = icon.getBoundingClientRect(), tooltip = element.querySelector('.player-opening-replay-tooltip');
    return { width: box.width, height: box.height, iconWidth: iconBox.width, iconHeight: iconBox.height,
      iconOpacity: Number(getComputedStyle(icon).opacity), background: style.backgroundColor, borderWidth: style.borderWidth,
      tooltipVisible: tooltip ? getComputedStyle(tooltip).visibility : null };
  });
  assert.deepEqual([styles.width, styles.height, styles.iconWidth, styles.iconHeight], [28, 28, 12, 12]);
  assert.ok(Math.abs(styles.iconOpacity - 0.28) < 0.005);
  assert.equal(styles.background, 'rgba(0, 0, 0, 0)'); assert.equal(styles.borderWidth, '0px'); assert.equal(styles.tooltipVisible, 'hidden');
  await screenshot(page, `${name}-desktop-idle`);
  await button.hover(); await page.waitForTimeout(180);
  assert.ok(await button.locator('svg').evaluate(element => Number(getComputedStyle(element).opacity) > 0.7));
  await button.locator('.player-opening-replay-tooltip').waitFor({ state: 'visible' });
  await screenshot(page, `${name}-desktop-hover`);
  await page.mouse.move(10, 850); await page.keyboard.press('Tab'); await button.focus(); await page.waitForTimeout(180);
  assert.equal(await button.evaluate(element => element.matches(':focus-visible')), true);
  assert.ok(await button.locator('svg').evaluate(element => Number(getComputedStyle(element).opacity) > 0.7));
  await screenshot(page, `${name}-desktop-keyboard-focus`);
  await button.evaluate(element => element.blur());
  report.fixtures[name].button = styles;
}

async function exerciseStandalone(base, fixture) {
  const { page, context } = await newPage(fixture.name);
  try {
    await page.goto(`${base}/${fixture.name}/`, { waitUntil: 'load', timeout: 120000 });
    await openingReady(page);
    const initialTerminal = terminalCount(page); await skipOpening(page);
    report.fixtures[fixture.name].initialTerminal = await assertTerminal(page, initialTerminal, 'skipped');
    await page.locator('#scene-loading-mask-detail').waitFor({ state: 'detached' });
    await installSceneProbe(page, fixture);
    if (!fixture.patrol) {
      const canvas = page.locator('canvas.player-canvas'), box = await canvas.boundingBox(); assert.ok(box);
      const before = await sceneState(page);
      await page.mouse.move(box.width / 2, box.height / 2); await page.mouse.down({ button: 'right' });
      await page.mouse.move(box.width / 2 + 100, box.height / 2 + 25, { steps: 6 }); await page.mouse.up({ button: 'right' });
      await page.waitForFunction(() => ['inertialAlphaOffset', 'inertialBetaOffset', 'inertialRadiusOffset', 'inertialPanningX', 'inertialPanningY']
        .every(key => Math.abs(window.__openingReplaySmoke.camera[key] ?? 0) < 1e-7), null, { timeout: 10000 });
      assert.notEqual((await sceneState(page)).alpha, before.alpha, '实际相机手势必须生效后再验证保留');
    }
    await checkButton(page, fixture.name);
    const resources = resourceCounts(fixture.name); assert.ok(resources.length > 0);
    for (let round = 1; round <= 3; round++) {
      const before = await sceneState(page), button = page.locator('.player-opening-replay');
      const terminalStart = terminalCount(page);
      const fullNatural = round === 3 && fixture.name === 'campus';
      const observation = { round, expectedTerminal: round === 3 ? 'completed' : 'skipped',
        playbackMode: round === 3 ? (fullNatural ? 'full-natural-playback' : 'seek-to-end') : 'skip', before };
      report.fixtures[fixture.name].rounds.push(observation);
      // 同一事件任务连续触发两次，覆盖 React 提交前的同步防重入保护。
      if (round === 2) await button.evaluate(element => { element.click(); element.click(); });
      else if (round === 1) {
        await page.keyboard.press('Tab'); await button.focus();
        await button.evaluate(element => { window.__openingReplayFocusButton = element; });
        await page.keyboard.press('Enter');
      }
      else await button.click();
      await openingReady(page);
      const start = Number(await page.locator(`${hostSelector} input[type="range"]`).inputValue());
      observation.start = start;
      assert.ok(start < 1.5, '每次返回开场必须从头播放');
      assert.equal(await button.isHidden(), true, '播放期间返回开场入口应隐藏');
      await page.waitForTimeout(400);
      const during = await sceneState(page); observation.during = during; assertContinuity(before, during, fixture.patrol);
      assert.equal(during.overlayMounts - before.overlayMounts, 1, '一次重播只能创建一个遮罩');
      assert.equal(during.hostMounts - before.hostMounts, 1, '一次重播只能创建一个开场视觉实例');
      if (round === 3) await naturalCompletion(page, { full: fullNatural }); else await skipOpening(page);
      const after = await sceneState(page); observation.after = after;
      observation.terminal = await assertTerminal(page, terminalStart, observation.expectedTerminal);
      assertContinuity(before, after, fixture.patrol);
      if (round === 1) assert.equal(await page.evaluate(() => document.activeElement === window.__openingReplayFocusButton), true, '键盘进入开场后，结束应把焦点归还原按钮');
      assert.deepEqual(resourceCounts(fixture.name), resources, '重播不可额外读取场景 JSON 或环境/模型 GLB');
    }
    await screenshot(page, `${fixture.name}-after-natural-completion`);
    await page.setViewportSize({ width: 390, height: 844 }); await page.mouse.move(100, 700); await page.waitForTimeout(200);
    const box = await page.getByRole('button', { name: replayLabel, exact: true }).boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, '窄屏入口必须位于可视区域');
    await screenshot(page, `${fixture.name}-mobile-idle`);
    const mobileTerminal = terminalCount(page);
    await page.getByRole('button', { name: replayLabel, exact: true }).click(); await openingReady(page);
    await screenshot(page, `${fixture.name}-mobile-opening`); await skipOpening(page);
    report.fixtures[fixture.name].mobileTerminal = await assertTerminal(page, mobileTerminal, 'skipped');
    check(`${fixture.name}：28px/12px/0.28 入口、悬停/键盘提示、两轮跳过及自然结束、双触发防重入、同场景持续运行、资源复用、桌面与窄屏`);
  } catch (error) {
    await screenshot(page, `${fixture.name}-failure`).catch(() => {}); throw error;
  } finally { await context.close(); }
}

async function exerciseEmbedded(base, fixture) {
  const { page, context } = await newPage('embedded-campus');
  try {
    await page.goto(`${base}/opening-replay-host.html`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__openingReplayHost.events.some(event => event.type === 'viewer.initialLoadState' && event.payload.phase === 'complete'), null, { timeout: 60000 });
    const frame = page.frames().find(candidate => candidate.url().includes('/campus/')); assert.ok(frame);
    assert.equal(await frame.locator(hostSelector).count(), 0, '宿主隐藏时首播应等待');
    await page.getByRole('button', { name: '显示 Viewer', exact: true }).click();
    await openingReady(frame); await skipOpening(frame); await installSceneProbe(frame, fixture);
    // 用真实宿主命令打开业务面板，再验证折叠状态跨开场保留。
    await page.evaluate(() => document.querySelector('#viewer').contentWindow.postMessage({
      channel: 'zending.digital-twin.bridge', version: 1, sessionId: window.__openingReplayHost.sessionId,
      type: 'command.startAutoPatrol', requestId: 'opening-replay-patrol-panel',
    }, location.origin));
    const panel = frame.locator('.auto-patrol-controls');
    await panel.waitFor({ state: 'visible' });
    await panel.getByTitle('收起自动巡检控制器', { exact: true }).click();
    await panel.evaluate(element => { window.__openingReplayPanel = element; });
    const resources = resourceCounts('campus');
    for (const terminal of ['completed', 'skipped']) {
      const eventStart = await page.evaluate(() => window.__openingReplayHost.events.length);
      await page.getByRole('button', { name: '隐藏 Viewer', exact: true }).click();
      await page.waitForTimeout(100);
      const before = await sceneState(frame);
      await frame.locator('.player-opening-replay').evaluate(element => element.click());
      await page.waitForFunction(start => window.__openingReplayHost.events.slice(start).some(event => event.phase === 'waiting'), eventStart);
      await page.waitForTimeout(350);
      assert.equal(await frame.locator(hostSelector).count(), 0, '重播处于宿主隐藏状态时不得提前创建视觉或消耗播放时间');
      await page.getByRole('button', { name: '显示 Viewer', exact: true }).click(); await openingReady(frame);
      assert.equal(await panel.isHidden(), true, '开场期间业务面板应隐藏');
      assert.equal(await panel.evaluate(element => element === window.__openingReplayPanel && element.isConnected), true, '业务面板不得卸载重建');
      assert.ok(Number(await frame.locator(`${hostSelector} input[type="range"]`).inputValue()) < 1.5);
      await page.waitForTimeout(350);
      assertContinuity(before, await sceneState(frame), fixture.patrol);
      await page.getByRole('button', { name: '隐藏 Viewer', exact: true }).click(); await page.waitForTimeout(100);
      const range = frame.locator(`${hostSelector} input[type="range"]`), frozen = Number(await range.inputValue());
      await page.waitForTimeout(350); assert.equal(Number(await range.inputValue()), frozen, '宿主隐藏后同一轮开场时钟应暂停');
      await page.getByRole('button', { name: '显示 Viewer', exact: true }).click(); await page.waitForTimeout(300);
      assert.ok(Number(await range.inputValue()) > frozen, '恢复显示应继续同一轮开场');
      if (terminal === 'completed') await naturalCompletion(frame); else await skipOpening(frame);
      assert.equal(await panel.isVisible(), true, '开场终态应恢复业务面板');
      assert.equal(await panel.evaluate(element => element === window.__openingReplayPanel), true);
      assert.equal(await panel.getByTitle('展开自动巡检控制器', { exact: true }).getAttribute('aria-expanded'), 'false', '重播后应保留用户折叠状态');
      const events = await page.evaluate(start => window.__openingReplayHost.events.slice(start).filter(event => event.channel === 'zending.opening.v1' && event.type === 'viewer.state'), eventStart);
      assert.ok(events.some(event => event.phase === 'waiting') && events.some(event => event.phase === 'playing') && events.some(event => event.phase === terminal));
      assert.ok(events.every(event => event.sessionId === 'opening-replay-smoke'), '每轮重播必须复用同一宿主会话');
      assert.deepEqual(resourceCounts('campus'), resources);
      (report.embeddedRounds ??= []).push({ terminal, frozen, events });
    }
    await screenshot(page, 'embedded-campus-after-replay');
    check('同一 iframe 会话两轮重播：waiting → playing → completed/skipped；隐藏等待、播放中隐藏暂停、恢复继续、无业务重载、已打开业务面板实例和折叠状态保留');
  } catch (error) {
    await screenshot(page, 'embedded-campus-failure').catch(() => {}); throw error;
  } finally { await context.close(); }
}

async function exerciseDisabled(base) {
  const { page, context } = await newPage('no-opening');
  try {
    await page.goto(`${base}/no-opening/`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('canvas.player-canvas') && !document.querySelector('#scene-loading-mask-detail'), null, { timeout: 60000 });
    assert.equal(await page.locator('.player-status-blocked').count(), 0, '无开场场景不可处于加载阻断状态');
    await installSceneProbe(page, fixtures['no-opening']);
    const before = await sceneState(page); await page.waitForTimeout(200); const after = await sceneState(page);
    assert.ok(after.sameCanvas && after.sameScene && after.sameCamera && after.frame > before.frame + 1, '无开场场景必须有真实业务引擎与持续渲染的 Scene');
    report.fixtures['no-opening'].business = { before, after };
    assert.equal(await page.getByRole('button', { name: replayLabel, exact: true }).count(), 0);
    assert.equal(await page.locator(`${hostSelector},.opening-animation-overlay`).count(), 0);
    await screenshot(page, 'no-opening-no-replay-button');
    check('未绑定/未启用开场的实际 DIST：业务场景正常进入，不显示返回开场按钮');
  } catch (error) {
    await screenshot(page, 'no-opening-failure').catch(() => {}); throw error;
  } finally { await context.close(); }
}

await mkdir(output, { recursive: true });
try {
  await loadFixtures(); server = createServer(serve);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`; report.base = base;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: !process.argv.includes('--headed') });
  report.browser = browser.version();
  for (const name of requested.filter(value => value !== 'no-opening')) await exerciseStandalone(base, fixtures[name]);
  if (fixtures.campus) await exerciseEmbedded(base, fixtures.campus);
  if (fixtures['no-opening']) await exerciseDisabled(base);
  assert.deepEqual(report.pageErrors, [], '浏览器不可出现未捕获脚本异常');
  assert.deepEqual(report.diagnosticErrors, [], '正常验收路径不可出现控制台错误');
  assert.deepEqual(report.openingWarnings, [], '正常验收路径不可出现开场失败警告');
  report.ok = true;
} catch (error) {
  report.failure = error.stack ?? String(error);
  if (activePage && !activePage.isClosed()) await screenshot(activePage, 'failure').catch(() => {});
  console.error(report.failure); process.exitCode = 1;
} finally {
  report.resourceRequests = [...requests.entries()].filter(([url]) => /\/scene\.json$/.test(url) || /\.glb$/i.test(url));
  const cleanupError = (stage, error) => {
    report.ok = false; process.exitCode = 1;
    (report.cleanupErrors ??= []).push({ stage, error: error.stack ?? String(error) });
    console.error(`${stage}:`, error);
  };
  let reportWritten = false;
  try { await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); reportWritten = true; }
  catch (error) { cleanupError('write-report', error); }
  finally {
    try { await browser?.close(); }
    catch (error) { cleanupError('close-browser', error); }
    finally {
      try { if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      catch (error) { cleanupError('close-server', error); }
    }
  }
  if (reportWritten && report.cleanupErrors?.length) {
    try { await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); }
    catch (error) { cleanupError('write-cleanup-diagnostics', error); }
  }
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks, report: path.join(output, 'result.json'), failure: report.failure }, null, 2));
}
