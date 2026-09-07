import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertSceneOpenReady } from './lib/sceneOpenAcceptance.mjs';

// 每轮启动独立 Electron 与 userData，资源文件保持只读；操作系统文件缓存不清空。
const workspace = process.cwd();
const require = createRequire(path.join(workspace, 'package.json'));
const { _electron: electron } = require('playwright');
assert.ok(process.argv[2], '用法：node scripts/smoke-scene-open-performance.mjs <scene.json> [report.json] [runs]');
const sourceScene = path.resolve(process.argv[2]);
const reportPath = path.resolve(process.argv[3] ?? path.join(tmpdir(), 'zending-scene-open-evidence', `${Date.now()}-open.json`));
const runCount = Number(process.argv[4] ?? 1);
const verifyCancel = process.env.ZENDING_TEST_CANCEL_LOADING === '1';
assert.ok(Number.isInteger(runCount) && runCount >= 1 && runCount <= 20, 'runs 必须为 1–20 的整数。');
const timeoutMs = Number(process.env.ZENDING_OPEN_TIMEOUT_MS ?? 600_000);
assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 3_600_000, '加载超时必须为 1,000–3,600,000 ms。');
const sourceBytes = await readFile(sourceScene);
const sourceHash = digest(sourceBytes);
const scene = JSON.parse(sourceBytes.toString('utf8')).scene;
assert.ok(scene?.entities && Array.isArray(scene.entityIds), '输入不是有效 SceneDocument。');
const buildFiles = await Promise.all(['dist/index.html', 'dist-electron/main.js'].map(async (file) => {
  const info = await stat(path.join(workspace, file));
  return { file, modifiedAt: info.mtime.toISOString(), sha256: digest(await readFile(path.join(workspace, file))) };
}));
await mkdir(path.dirname(reportPath), { recursive: true });
const result = {
  status: 'RUNNING', generatedAt: new Date().toISOString(), sourceScene, sourceSha256: sourceHash,
  measurement: 'new-electron-process-with-fresh-userData; operating-system-file-cache-not-cleared',
  verifyCancel,
  buildFiles,
  scene: {
    entityCount: scene.entityIds.length,
    modelEntityCount: Object.values(scene.entities).filter((entity) => entity.components?.modelAsset).length,
    hasEnvironment: Boolean(scene.sceneSettings?.environment?.activeVariantUrl),
  },
  runs: [],
};
try {
  for (let index = 0; index < runCount; index += 1) {
    const run = await measureOpen(index + 1);
    result.runs.push(run);
    await writeReport();
    console.log(JSON.stringify({ run: index + 1, status: run.status, openToReadyMs: run.openToReadyMs, screenshotPath: run.screenshotPath }));
  }
  result.status = result.runs.every((run) => run.status === 'PASS') ? 'PASS' : 'FAIL';
  if (result.status === 'FAIL') process.exitCode = 1;
} catch (error) {
  result.status = 'FAIL';
  result.error = redact(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  result.sourceUnchanged = digest(await readFile(sourceScene)) === sourceHash;
  if (!result.sourceUnchanged) {
    result.status = 'FAIL';
    result.error = '验收期间源场景发生变化。';
    process.exitCode = 1;
  }
  await writeReport();
  console.log(JSON.stringify({ status: result.status, reportPath, sourceUnchanged: result.sourceUnchanged, error: result.error }));
}

async function measureOpen(index) {
  const runRoot = await mkdtemp(path.join(tmpdir(), 'zending-scene-open-'));
  const userDataRoot = path.join(runRoot, 'userdata');
  const fixturePath = path.join(runRoot, 'scene.scene.json');
  const run = { status: 'RUNNING', index, requestFailures: [], pageErrors: [], consoleErrors: [],
    assetTransfers: [] };
  let app;
  let window;
  try {
    await mkdir(userDataRoot);
    await copyFile(sourceScene, fixturePath);
    await writeFile(path.join(userDataRoot, 'recent-workspaces.json'), JSON.stringify({
      version: 1, projects: [], scenes: [{ filePath: fixturePath, lastOpenedAt: new Date().toISOString() }],
    }));
    app = await electron.launch({
      args: [workspace, `--user-data-dir=${userDataRoot}`], cwd: workspace,
      env: { ...process.env, OPEN_DEVTOOLS: 'false', VITE_DEV_SERVER_URL: '' }, timeout: 120_000,
    });
    window = await app.firstWindow({ timeout: 120_000 });
    window.setDefaultTimeout(30_000);
    window.on('pageerror', (error) => appendBounded(run.pageErrors, redact(error.message)));
    window.on('requestfailed', (request) => appendBounded(run.requestFailures, {
      resource: resourceLabel(request.url()), error: redact(request.failure()?.errorText ?? 'unknown'),
    }));
    window.on('requestfinished', (request) => {
      const fileName = resourceLabel(request.url());
      if (!/\.glb$/i.test(fileName)) return;
      const transfer = { fileName, ...request.timing() };
      run.assetTransfers.push(transfer);
      run.assetTransfers.sort((left, right) => right.responseEnd - left.responseEnd);
      run.assetTransfers.length = Math.min(run.assetTransfers.length, 32);
      if (request.url().split(/[?#]/)[0] === scene.sceneSettings?.environment?.activeVariantUrl?.split(/[?#]/)[0]) {
        run.environmentAssetTransfer = transfer;
      }
    });
    window.on('console', (message) => {
      if (message.type() === 'error') appendBounded(run.consoleErrors, redact(message.text()));
    });
    await window.bringToFront();
    const card = window.locator('.home-recent-card').filter({ hasText: path.basename(fixturePath) });
    await card.getByRole('button', { name: '打开', exact: true }).waitFor({ state: 'visible', timeout: 120_000 });
    await installLoadingObserver(window);
    await card.getByRole('button', { name: '打开', exact: true }).click();
    if (verifyCancel) {
      window.on('dialog', (dialog) => void dialog.accept());
      const cancel = window.getByRole('button', { name: '取消加载并返回首页', exact: true });
      await cancel.waitFor({ state: 'visible', timeout: 30000 });
      await cancel.focus();
      await cancel.press('Enter');
      await window.locator('.home-recent-card').first().waitFor({ state: 'visible', timeout: 30000 });
      run.cancelVerified = true;
      run.status = 'PASS';
      return run;
    }
    await window.waitForFunction(() => window.__sceneOpenMeasurement?.maskHiddenAt != null, null, { timeout: timeoutMs });
    run.loading = sanitizeObject(await window.evaluate(() => window.__sceneOpenMeasurement));
    run.maskHiddenMs = run.loading.maskHiddenAt - run.loading.startedAt;
    run.canvasVisibleAtMs = run.loading.canvasAt == null ? null : run.loading.canvasAt - run.loading.startedAt;
    run.loadingConsoleWarnings = [...new Set([
      ...(run.loading.loadingWarnings ?? []).map(redact), ...await readLoadingFailures(window),
    ])];
    run.openToReadyMs = run.loadingConsoleWarnings.length === 0 ? run.maskHiddenMs : null;

    const performanceToggle = window.getByRole('checkbox', { name: '性能监控', exact: true });
    if (await performanceToggle.count()) await performanceToggle.check();
    const copyButton = window.locator('button.scene-performance-copy');
    if (!await copyButton.isVisible()) await window.locator('.scene-performance-summary').click();
    await window.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true, value: async (text) => { window.__sceneOpenReport = String(text); },
      });
    });
    await window.waitForTimeout(1_100);
    await copyButton.click();
    await window.waitForFunction(() => typeof window.__sceneOpenReport === 'string', null, { timeout: 30_000 });
    const report = await window.evaluate(() => JSON.parse(window.__sceneOpenReport));
    assert.ok(report.samples?.length, '性能报告没有有效样本。');
    run.renderer = report.renderer;
    run.performanceSummary = report.summary;
    run.scenePreparation = report.scenePreparation;
    run.runtime = sanitizeObject(report.samples.at(-1)?.runtime);
    run.lastSample = sanitizeObject(report.samples.at(-1));
    run.loading = sanitizeObject(await window.evaluate(() => window.__sceneOpenMeasurement));
    run.loadingConsoleWarnings = [...new Set([
      ...run.loadingConsoleWarnings, ...(run.loading.loadingWarnings ?? []), ...await readLoadingFailures(window),
    ])];
    run.openToReadyMs = null;
    assertSceneOpenReady(report.scenePreparation, run.runtime?.loading);
    run.openToReadyMs = run.maskHiddenMs;
    assert.deepEqual(run.loadingConsoleWarnings.filter((warning) => /加载失败|合批失败|初始化失败/.test(warning)), [], '存在实际加载错误。');
    assert.ok(run.renderer?.renderer, '性能报告缺少 WebGL renderer。');
    assert.doesNotMatch(run.renderer.renderer, /swiftshader|llvmpipe|software/i, '当前不是硬件 WebGL 渲染。');
    assert.deepEqual(run.pageErrors, [], '打开期间出现 pageerror。');
    assert.deepEqual(run.consoleErrors, [], '打开期间出现 console error。');
    run.resources = sanitizeObject(await window.evaluate(() => performance.getEntriesByType('resource')
      .map((entry) => {
        let pathname;
        try { pathname = decodeURIComponent(new URL(entry.name).pathname); } catch { return null; }
        if (!/\.glb$/i.test(pathname)) return null;
        return { fileName: pathname.split(/[\\/]/).pop(), durationMs: entry.duration,
          responseMs: entry.responseEnd - entry.responseStart, bytes: entry.decodedBodySize };
      }).filter(Boolean).sort((a, b) => b.durationMs - a.durationMs).slice(0, 16)));
    assert.deepEqual(run.requestFailures.filter((failure) => /\.glb$|\.gltf$|\.ktx2$|\.png$|\.jpe?g$/i.test(failure.resource)), [], '存在模型或纹理请求失败。');
    run.status = 'PASS';
  } catch (error) {
    run.status = 'FAIL';
    run.openToReadyMs = null;
    run.error = redact(error instanceof Error ? error.message : String(error));
    if (window && !window.isClosed()) {
      run.loading = sanitizeObject(await window.evaluate(() => window.__sceneOpenMeasurement ?? null).catch(() => null));
      run.loadingConsoleWarnings = [...new Set([
        ...(run.loadingConsoleWarnings ?? []), ...(run.loading?.loadingWarnings ?? []),
        ...await readLoadingFailures(window).catch(() => []),
      ])];
      if (run.loadingConsoleWarnings.length) run.openToReadyMs = null;
    }
  } finally {
    try {
      if (window && !window.isClosed()) {
        run.screenshotPath = reportPath.replace(/\.json$/i, '') + `-run-${index}.png`;
        await window.screenshot({ path: run.screenshotPath, timeout: 30_000 }).catch((error) => {
          run.screenshotError = redact(error.message);
          run.status = 'FAIL';
          run.openToReadyMs = null;
          run.error = '截图失败，缺少视觉验收证据';
        });
      } else if (run.status === 'PASS') {
        run.status = 'FAIL';
        run.openToReadyMs = null;
        run.error = '窗口已关闭，缺少视觉验收证据';
      }
    } finally {
      try { await app?.close(); }
      finally {
        // 只删除本脚本 mkdtemp 创建的目录，并再次核对绝对路径边界。
        const relative = path.relative(path.resolve(tmpdir()), path.resolve(runRoot));
        assert.ok(relative.startsWith('zending-scene-open-') && !relative.includes(path.sep), '临时目录超出清理范围。');
        await rm(runRoot, { recursive: true, force: true });
      }
    }
  }
  return run;
}

async function installLoadingObserver(window) {
  await window.evaluate(() => {
    performance.clearResourceTimings();
    performance.setResourceTimingBufferSize(4000);
    const state = { startedAt: null, canvasAt: null, maskHiddenAt: null, sawMask: false, phases: [], loadingWarnings: [] };
    window.__sceneOpenMeasurement = state;
    const sample = () => {
      const latestMessage = document.querySelector('.console-dock-message')?.textContent ?? '';
      if (/模型.*失败|环境.*失败|解除蒙版|context lost|render-error/i.test(latestMessage)
        && state.loadingWarnings.length < 100 && !state.loadingWarnings.includes(latestMessage)) {
        state.loadingWarnings.push(latestMessage);
      }
      if (state.startedAt == null || state.maskHiddenAt != null) return;
      const now = performance.now();
      const canvas = document.querySelector('canvas.scene-canvas');
      if (canvas && state.canvasAt == null) state.canvasAt = now;
      const mask = document.querySelector('[data-scene-preparation-phase]');
      if (mask) {
        state.sawMask = true;
        const phase = mask.getAttribute('data-scene-preparation-phase');
        const percent = Number(mask.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'));
        const previous = state.phases.at(-1);
        if ((!previous || previous.phase !== phase || previous.percent !== percent) && state.phases.length < 500) {
          state.phases.push({ atMs: now - state.startedAt, phase, percent });
        }
      } else if (state.sawMask && canvas) {
        state.maskHiddenAt = now;
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-scene-preparation-phase', 'aria-valuenow'] });
    document.addEventListener('click', (event) => {
      if (state.startedAt == null && event.target instanceof Element && event.target.closest('.home-recent-card button')) {
        state.startedAt = performance.now();
        sample();
      }
    }, { capture: true });
  });
}

async function readLoadingFailures(window) {
  return window.locator('.console-dock-message').allTextContents().then((messages) => messages
    .filter((message) => /模型.*失败|环境.*失败|解除蒙版|context lost|render-error/i.test(message)).map(redact));
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function appendBounded(items, value) { if (items.length < 100) items.push(value); }
function resourceLabel(value) {
  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname).split(/[\\/]/).at(-1) || url.protocol;
  } catch { return '<invalid-url>'; }
}
function redact(value) {
  return String(value).replace(/(?:https?|wss?|mqtts?):\/\/[^\s"'<>]+/gi, (url) => `<${resourceLabel(url)}>`)
    .replace(/((?:password|authorization|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1<redacted>');
}
function sanitizeObject(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, /password|authorization|token|secret|api[_-]?key/i.test(key) ? '<redacted>' : sanitizeObject(item),
  ]));
  return value;
}
async function writeReport() { await writeFile(reportPath, JSON.stringify(result, null, 2), 'utf8'); }
