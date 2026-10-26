/* global window, document */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import unzipper from 'unzipper';
import { _electron, chromium } from 'playwright';
import { createBusinessGiViewerServer } from '../tests/helpers/phase2GiViewer.mjs';
import { normalizeSceneLightingConfig } from '../dist-electron/shared/sceneLightingConfig.js';

const { values } = parseArgs({ options: { scene: { type: 'string' }, output: { type: 'string' } } });
assert.ok(values.scene && values.output);
const output = path.resolve(values.output), original = await fs.readFile(path.resolve(values.scene));
await fs.mkdir(output, { recursive: true });
const input = JSON.parse(original);
input.scene.sceneSettings ??= {};
assert.ok(!input.scene.sceneSettings.lighting?.result, '本工具使用无GI结果的双模型功能夹具，真实业务GI使用独立验收入口。');
input.scene.sceneSettings.lighting = normalizeSceneLightingConfig(input.scene.sceneSettings.lighting);
input.scene.sceneSettings.lighting.bake.enabled = false;
input.scene.sceneSettings.camera = { savedPose: { alpha: .8, beta: 1.1, radius: 6, target: { x: 0, y: .2, z: 0 } },
  savedOrientation: 'orbit', savedProjection: 'perspective', viewDistance: 1000 };
const userData = path.join(output, 'userdata'), published = path.join(output, 'published');
await fs.mkdir(userData, { recursive: true }); await fs.mkdir(published, { recursive: true });
const inputPath = path.join(output, 'input-functional.scene.json');
await fs.writeFile(path.join(userData, 'recent-workspaces.json'), JSON.stringify({ version: 1, projects: [],
  scenes: [{ filePath: inputPath, lastOpenedAt: new Date().toISOString() }] }));
await fs.writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: '', workspaceRoot: process.cwd() }));
const report = { status: 'RUNNING', scope: 'actual DIST PlayerApp, standalone/iframe canvas options; no external deployment',
  fixtureConditions: 'non-GI two-model functional fixture, saved camera only; original scene file unchanged',
  cases: [], errors: [], requests: [] };
await fs.writeFile(inputPath, JSON.stringify(input, null, 2));
let app, browser, server, bootstrap;
try {
  // Playwright的主进程evaluate无原生动态import回调；模块必须由专属原生ESM入口加载。
  bootstrap = path.resolve('.tmp-phase2-viewer-' + randomUUID() + '.mjs');
  await fs.writeFile(bootstrap, "import {app} from 'electron';\napp.setPath('userData'," + JSON.stringify(userData) + ');\n'
    + 'globalThis.phase2ViewerHost={dist:await import(' + JSON.stringify(pathToFileURL(path.resolve('dist-electron/ipc/digitalTwinDistPackage.js')).href) + ')};\n'
    + 'await import(' + JSON.stringify(pathToFileURL(path.resolve('dist-electron/main.js')).href) + ');\n', { flag: 'wx' });
  app = await _electron.launch({ args: [bootstrap, `--user-data-dir=${userData}`], cwd: process.cwd(),
    env: { ...process.env, OPEN_DEVTOOLS: 'false', VITE_DEV_SERVER_URL: '' }, timeout: 120000 });
  const editor = await app.firstWindow();
  // 经真实场景选择/确认建立精确资产授权，不能为测试绕过发布资源权限。
  const selected = await editor.evaluate(async filePath => {
    const result = await window.editorApi.loadSceneFile({ filePath });
    if (result.canceled || !result.content || !await window.editorApi.confirmSceneOpen({ sceneOpenToken: result.sceneOpenToken })) {
      throw new Error('本次功能夹具未通过真实场景打开确认。');
    }
    return result;
  }, inputPath);
  report.selectedScenePath = selected.filePath;
  report.package = await app.evaluate(async (_electron, setup) => {
    const { buildDigitalTwinDistPackage } = globalThis.phase2ViewerHost.dist;
    return buildDigitalTwinDistPackage({ projectId: '123', publishName: '二期Viewer选项验收', sceneContent: setup.sceneContent,
      outputRoot: setup.output, signal: new AbortController().signal });
  }, { sceneContent: selected.content, output: path.join(output, 'package') });
  await app.close(); app = null;
  const archive = await unzipper.Open.file(report.package.filePath);
  for (const entry of archive.files) {
    const file = path.resolve(published, entry.path), relative = path.relative(published, file);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    if (entry.type === 'Directory') await fs.mkdir(file, { recursive: true });
    else { assert.equal(entry.type, 'File'); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, await entry.buffer()); }
  }
  await fs.writeFile(path.join(published, 'host.html'), '<!doctype html><body style="margin:0;background:#e020d0"><iframe title="实际Viewer" src="/?performance=1" style="width:960px;height:640px;border:0" sandbox="allow-scripts allow-same-origin allow-pointer-lock"></iframe>');
  const baseConfig = JSON.parse(await fs.readFile(path.join(published, 'runtime-config.json'), 'utf8'));
  const hosted = await createBusinessGiViewerServer(published, '123', report.requests); server = hosted.server;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  let baseline;
  for (const variant of [{ host: 'standalone', opaque: false }, { host: 'standalone', opaque: true },
    { host: 'iframe', opaque: false }, { host: 'iframe', opaque: true }, { host: 'standalone', opaque: true, adaptive: true },
    { host: 'iframe', opaque: true, adaptive: true }]) {
    const config = structuredClone(baseConfig);
    config.viewer.opaqueCanvas = variant.opaque; config.viewer.adaptiveResolution = variant.adaptive === true;
    await fs.writeFile(path.join(published, 'runtime-config.json'), JSON.stringify(config));
    const context = await browser.newContext({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
      await page.goto(hosted.origin + (variant.host === 'iframe' ? '/host.html' : '/?performance=1'));
      const frame = variant.host === 'iframe' ? await (await page.waitForSelector('iframe')).contentFrame() : page.mainFrame();
      await frame.waitForFunction(findViewerRuntime, null, { timeout: 180000, polling: 500 });
      await frame.waitForTimeout(1500);
      const first = await frame.evaluate(captureViewerPixels);
      assert.equal(first.alpha, !variant.opaque); assert.equal(first.width, 960); assert.equal(first.height, 640);
      assert.ok(first.colors > 5, '必须有真实三维像素，不能比较空白canvas');
      assert.equal(first.nonOpaquePixels, 0, '同条件三维画布不依赖透明清屏');
      const bytes = Buffer.from(first.base64, 'base64'), sample = { ...variant, alpha: first.alpha,
        width: first.width, height: first.height, colors: first.colors, nonOpaquePixels: first.nonOpaquePixels,
        sha256: createHash('sha256').update(bytes).digest('hex'), renderer: first.renderer };
      report.cases.push(sample);
      if (!baseline) baseline = bytes;
      assert.deepEqual(bytes, baseline, '透明/不透明/iframe的完整WebGL buffer应一致');
      if (variant.adaptive) {
        if (variant.host === 'iframe') {
          await page.evaluate(() => { window.__phase2HostRatioTimer = setTimeout(() => {
            const target = document.querySelector('iframe').contentWindow;
            const send = value => target.postMessage({ channel: 'zending.digital-twin.display', version: 1,
              type: 'host.renderPixelRatioChanged', payload: { renderPixelRatio: value } }, window.location.origin);
            send(2); setTimeout(() => send(1), 500);
          }, 400); });
        }
        sample.motion = await frame.evaluate(async () => {
          const { runtime } = window.__phase2Viewer, scene = runtime.scene, engine = scene.getEngine(), camera = scene.activeCamera;
          const alpha = camera.alpha, level = engine.getHardwareScalingLevel(), levels = []; let step = 0;
          const initialState = window.__phase2Viewer.viewport?.getAdaptiveResolutionState();
          const observer = scene.onBeforeRenderObservable.add(() => { camera.alpha = alpha + .1 * Math.sin(++step / 10); levels.push(engine.getHardwareScalingLevel()); });
          await new Promise(resolve => setTimeout(resolve, 1500)); const moving = engine.getHardwareScalingLevel();
          const movingState = window.__phase2Viewer.viewport?.getAdaptiveResolutionState();
          scene.onBeforeRenderObservable.remove(observer); camera.alpha = alpha;
          await new Promise(resolve => setTimeout(resolve, 1500)); return { baseline: level, moving, restored: engine.getHardwareScalingLevel(),
            levels: [...new Set(levels)], initialState, movingState, restoredState: window.__phase2Viewer.viewport?.getAdaptiveResolutionState() };
        });
        assert.equal(sample.motion.baseline, 1); assert.equal(sample.motion.moving, 1.5); assert.equal(sample.motion.restored, 1);
        if (variant.host === 'iframe') assert.ok(sample.motion.levels.includes(.75), '宿主DPR变更后应按新基础倍率临时降采样');
        const restored = await frame.evaluate(captureViewerPixels);
        assert.deepEqual(Buffer.from(restored.base64, 'base64'), baseline, '实际Viewer静止恢复后全buffer一致');
      }
      await page.screenshot({ path: path.join(output, variant.host + '-' + (variant.adaptive ? 'adaptive' : variant.opaque ? 'opaque' : 'alpha') + '.png') });
      sample.status = 'PASS';
    } finally { await context.close(); }
  }
  assert.deepEqual(report.errors, []); report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await app?.close(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  if (bootstrap) { assert.equal(path.dirname(bootstrap), process.cwd()); assert.match(path.basename(bootstrap), /^\.tmp-phase2-viewer-[a-f0-9-]+\.mjs$/); await fs.unlink(bootstrap); }
  report.sourceUnchanged = (await fs.readFile(path.resolve(values.scene))).equals(original);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, output, error: report.error }));
}

function findViewerRuntime() {
  const root = document.getElementById('root'), key = Object.keys(root ?? {}).find(key => key.startsWith('__reactContainer$'));
  const first = root?.[key], stack = first ? [first.stateNode?.current ?? first] : [], seen = new Set();
  let runtime, viewport;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    const current = value.current ?? value;
    if (current.scene?.meshes && !current.scene.isDisposed && typeof current.getPerformanceMetrics === 'function') runtime = current;
    if (current.engine && typeof current.getAdaptiveResolutionState === 'function') viewport = current;
  };
  while (stack.length && seen.size < 30000) {
    const fiber = stack.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    for (const value of Object.values(fiber.memoizedProps ?? {})) visit(value);
    let hook = fiber.memoizedState;
    for (let count = 0; hook && count < 500; count++, hook = hook.next) visit(hook.memoizedState);
    stack.push(fiber.child, fiber.sibling);
  }
  if (!runtime || runtime.assets.models.size !== 2) return false;
  const loading = runtime.getPerformanceMetrics().loading;
  if (loading.pendingModelCount || loading.active.length || !runtime.scene.isReady()) return false;
  window.__phase2Viewer = { runtime, viewport }; return true;
}

function captureViewerPixels() {
  const scene = window.__phase2Viewer.runtime.scene;
  return new Promise(resolve => scene.onAfterRenderObservable.addOnce(() => {
    const engine = scene.getEngine(), gl = engine._gl, width = engine.getRenderWidth(), height = engine.getRenderHeight();
    const bytes = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    let nonOpaquePixels = 0; const colors = new Set();
    for (let index = 0; index < bytes.length; index += 4) {
      if (bytes[index + 3] !== 255) nonOpaquePixels++;
      if (index % 64 === 0) colors.add(bytes[index] + ',' + bytes[index + 1] + ',' + bytes[index + 2]);
    }
    let binary = ''; for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    resolve({ width, height, alpha: gl.getContextAttributes().alpha, base64: window.btoa(binary), renderer: engine.getGlInfo(), nonOpaquePixels, colors: colors.size });
  }));
}
