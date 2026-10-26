/* global document, window */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { _electron } from 'playwright';
import { installClassificationAudit, measureClassificationWindow } from './lib/phase2LightingClassificationAudit.mjs';

const { values } = parseArgs({ options: { scene: { type: 'string' }, output: { type: 'string' },
  seconds: { type: 'string', default: '60' }, width: { type: 'string', default: '2560' }, height: { type: 'string', default: '1440' },
  adaptive: { type: 'boolean', default: false }, pixels: { type: 'boolean', default: false }, classification: { type: 'boolean', default: false },
  'scene-in-place': { type: 'boolean', default: false }, 'runtime-root': { type: 'string' }, 'startup-profile': { type: 'boolean', default: false },
  'preparation-defer': { type: 'boolean', default: false } } });
assert.ok([values.adaptive, values.pixels, values.classification, values['startup-profile']].filter(Boolean).length <= 1, '运动分辨率、像素、CPU分类与启动profile必须分开运行。');
assert.ok(values.scene && values.output, '--scene 和 --output 必填。');
const seconds = Number(values.seconds), width = Number(values.width), height = Number(values.height);
assert.ok(Number.isFinite(seconds) && seconds >= 1 && seconds <= 120);
assert.ok(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0);
const output = path.resolve(values.output), source = path.resolve(values.scene);
const runtimeRoot = path.resolve(values['runtime-root'] ?? process.cwd());
const original = await readFile(source), sha = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'phase2-runtime-audit-'));
const userData = path.join(temporary, 'userdata'), fixture = values['scene-in-place'] ? source : path.join(temporary, 'audit.scene.json');
if (values['scene-in-place']) {
  const relative = path.relative(path.resolve('output'), source);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '原位模式只允许本任务output内的独立副本。');
  assert.equal(path.basename(path.dirname(source)).toLowerCase(), 'scenes', '必须从真实副本Scenes位置打开，保留同项目Assets授权链。');
}
await mkdir(userData); if (!values['scene-in-place']) await writeFile(fixture, original);
await writeFile(path.join(userData, 'recent-workspaces.json'), JSON.stringify({ version: 1, projects: [],
  scenes: [{ filePath: fixture, lastOpenedAt: new Date().toISOString() }] }));
await writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: '', workspaceRoot: process.cwd() }));
const report = { status: 'RUNNING', scope: values['startup-profile']
  ? 'actual Editor startup CPU profile; instrumentation perturbs timing, not a performance comparison'
  : values.classification ? 'actual Editor current/default classification CPU diagnostics; no A/B claim'
  : 'read-only actual Editor engine-frame GPU diagnostics; no FPS A/B claim',
  sourceSha256: sha(original), seconds, errors: [], requestFailures: [] };
let app, page, bootstrap, cpuSession, profiling = false;
try {
  if (values['scene-in-place']) {
    bootstrap = path.join(runtimeRoot, '.tmp-phase2-audit-' + randomUUID() + '.mjs');
    const url = file => pathToFileURL(path.join(runtimeRoot, 'dist-electron', file)).href;
    await writeFile(bootstrap, "import {app} from 'electron';\napp.setPath('userData'," + JSON.stringify(userData) + ');\n'
      + 'globalThis.phase2AuditProject={assets:await import(' + JSON.stringify(url('ipc/projectAssetStore.js'))
      + '),registry:await import(' + JSON.stringify(url('ipc/assetRegistry.js')) + ')};\nawait import('
      + JSON.stringify(url('main.js')) + ');\n', { flag: 'wx' });
  }
  // 正式 file:// 启动必须取消开发地址，空字符串仍会被安全校验当成一个非法 URL。
  const env = { ...process.env, OPEN_DEVTOOLS: 'false' };
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: [bootstrap ?? runtimeRoot, `--user-data-dir=${userData}`], cwd: runtimeRoot,
    env, timeout: 120000 });
  report.runtimeRoot = runtimeRoot;
  if (values['scene-in-place']) {
    const project = path.dirname(path.dirname(source));
    await app.evaluate(async (_electron, root) => {
      await globalThis.phase2AuditProject.assets.activateProjectRoot(root);
      globalThis.phase2AuditProject.registry.authorizeAssetRoot(root);
    }, project);
    report.authorization = { scope: 'only the owned copied project; same project setup as real GI acceptance', project };
  }
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.errors.push({ type: 'page', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ type: 'console', message: message.text() }); });
  page.on('requestfailed', request => {
    const url = new URL(request.url()); url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    report.requestFailures.push({ url: url.href, error: request.failure()?.errorText });
  });
  const card = page.locator('.home-recent-card').filter({ hasText: path.basename(fixture) });
  await card.getByRole('button', { name: '打开', exact: true }).waitFor({ state: 'visible', timeout: 120000 });
  await page.evaluate(() => document.addEventListener('click', () => { window.__phase2OpenStartedAt = performance.now(); }, { capture: true, once: true }));
  if (values['startup-profile']) {
    cpuSession = await page.context().newCDPSession(page);
    await cpuSession.send('Profiler.enable'); await cpuSession.send('Profiler.start'); profiling = true;
  }
  await card.getByRole('button', { name: '打开', exact: true }).click();
  await page.locator('canvas.scene-canvas').waitFor({ state: 'visible', timeout: 120000 });
  await page.evaluate(installReferences);
  if (values['preparation-defer']) await page.evaluate(() => {
    if (typeof window.__phase2Audit.runtime.setPreparationClassificationEnabled !== 'function') throw new Error('当前构建没有准备期分类候选');
    window.__phase2Audit.runtime.setPreparationClassificationEnabled(true);
  });
  await page.waitForFunction(() => {
    const loading = window.__phase2Audit.runtime.getPerformanceMetrics().loading;
    const snapshot = window.__phase2Audit.runtime.getInitialLoadSnapshot();
    if (snapshot.error) throw new Error(String(snapshot.error));
    const failed = document.querySelector('[data-scene-preparation-phase] [aria-label="场景资源加载失败"]');
    if (failed) throw new Error(failed.textContent);
    return loading.pendingModelCount === 0 && loading.active.length === 0 && ['idle', 'ready'].includes(loading.environmentPhase)
      && !document.querySelector('[data-scene-preparation-phase]');
  }, null, { timeout: 600000, polling: 1000 });
  report.localOpen = await page.evaluate(() => ({ elapsedMs: typeof window.__phase2OpenStartedAt === 'number'
    ? performance.now() - window.__phase2OpenStartedAt : null, endpoint: 'actual click to observed full-ready; 1000ms polling; not remote project-open' }));
  if (profiling) {
    const { profile } = await cpuSession.send('Profiler.stop'); profiling = false;
    await writeFile(path.join(output, 'startup.cpuprofile'), JSON.stringify(profile));
    report.startupProfile = { file: 'startup.cpuprofile', nodes: profile.nodes.length, samples: profile.samples?.length ?? 0,
      durationUs: profile.endTime - profile.startTime, complete: true };
  }
  const toggle = page.getByRole('checkbox', { name: '性能监控', exact: true });
  if (await toggle.count()) await toggle.check();
  if (!await page.locator('.scene-performance-copy').isVisible()) await page.locator('.scene-performance-summary').click();
  await page.bringToFront(); await page.waitForTimeout(3000);
  if (!values.adaptive) await page.evaluate(({ width, height }) => { window.__phase2Audit.runtime.scene.getEngine().setSize(width, height); }, { width, height });
  await page.waitForTimeout(500);
  report.before = await page.evaluate(readRuntimeState);
  if (values.pixels) {
    const pixels = await page.evaluate(captureStaticPixels);
    const bytes = Buffer.from(pixels.base64, 'base64'); delete pixels.base64;
    report.pixels = { ...pixels, byteLength: bytes.length, sha256: sha(bytes) };
    await writeFile(path.join(output, 'frame.rgba'), bytes);
  } else if (values.adaptive) {
    const option = page.getByRole('checkbox', { name: '移动时降低分辨率（本次会话）', exact: true });
    assert.equal(await option.isChecked(), false, 'R8默认必须关闭');
    await page.evaluate(prepareAdaptiveBaseline);
    await option.check();
    report.adaptive = await page.evaluate(exerciseAdaptiveMotion);
    await option.uncheck();
    report.adaptive.levelAfterDisable = await page.evaluate(() => window.__phase2Audit.runtime.scene.getEngine().getHardwareScalingLevel());
    assert.equal(report.adaptive.motionLevel, report.adaptive.baselineLevel * 1.5);
    assert.equal(report.adaptive.restoredLevel, report.adaptive.baselineLevel);
    assert.equal(report.adaptive.changedPixels, 0, '静止恢复后完整buffer必须一致');
    assert.equal(report.adaptive.levelAfterDisable, report.adaptive.baselineLevel);
  } else if (values.classification) {
    report.classification = await page.evaluate(installClassificationAudit, { arm: 'B' });
    try { report.cpu = await page.evaluate(measureClassificationWindow, { durationMs: seconds * 1000 }); }
    finally { await page.evaluate(() => window.__phase2ClassificationAudit?.restore()); }
  } else if (!values['startup-profile']) report.gpu = await page.evaluate(captureGpuWindow, seconds * 1000);
  report.after = await page.evaluate(readRuntimeState);
  const freeze = await import('./lib/phase2FreezeAudit.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  });
  if (freeze) report.freezeAudit = await page.evaluate(`(${freeze.collectPhase2FreezeAudit.toString()})({scene:window.__phase2Audit.runtime.scene,runtime:window.__phase2Audit.runtime})`);
  report.functionalPass = report.errors.length === 0 && report.requestFailures.length === 0;
  report.measurementValid = values.adaptive || values.pixels || values['startup-profile'] ? null : values.classification
    ? report.cpu.measurementValid : report.gpu.valid && report.gpu.samples.length > 0;
  report.status = values['startup-profile'] ? (report.functionalPass ? 'CAPTURED_STARTUP_PROFILE' : 'FAIL_FUNCTIONAL')
    : values.pixels ? (report.functionalPass ? 'PASS_STATIC_PIXELS' : 'FAIL_FUNCTIONAL')
    : values.adaptive ? (report.functionalPass ? 'PASS_ADAPTIVE_FUNCTIONAL' : 'FAIL_FUNCTIONAL')
    : report.measurementValid ? (values.classification ? 'PASS_CPU_MEASUREMENT' : 'PASS_GPU_MEASUREMENT') : 'UNAVAILABLE_OR_INVALID';
  await page.screenshot({ path: path.join(output, 'editor.png') });
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack ?? String(error); process.exitCode = 1;
} finally {
  if (profiling) {
    try {
      const { profile } = await cpuSession.send('Profiler.stop');
      await writeFile(path.join(output, 'startup-partial.cpuprofile'), JSON.stringify(profile));
      report.startupProfile = { file: 'startup-partial.cpuprofile', complete: false };
    } catch (error) { report.profileCleanupError = String(error); }
  }
  await cpuSession?.detach().catch(error => { report.profileDetachError = String(error); });
  report.sourceUnchanged = sha(await readFile(source)) === sha(original);
  if (!report.sourceUnchanged) { report.status = 'FAIL'; process.exitCode = 1; }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await app?.close();
  if (bootstrap) await rm(bootstrap, { force: true });
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('phase2-runtime-audit-'));
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, measurementValid: report.measurementValid,
    functionalPass: report.functionalPass, samples: report.gpu?.samples.length, output, error: report.error }));
}

/** 与既有性能验收工具相同的只读 React ref 适配，仅连接本次专属窗口。 */
function installReferences() {
  const element = document.getElementById('root'), key = Object.keys(element ?? {}).find(key => key.startsWith('__reactContainer$'));
  const first = element?.[key], stack = first ? [first.stateNode?.current ?? first] : [], seen = new Set();
  let runtime, monitor;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    const current = value.current ?? value;
    if (current.scene?.meshes && !current.scene.isDisposed && typeof current.getPerformanceMetrics === 'function') runtime = current;
    if (current.engineInstrumentation && current.sceneInstrumentation && !current.disposed) monitor = current;
  };
  while (stack.length && seen.size < 30000) {
    const fiber = stack.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    for (const value of Object.values(fiber.memoizedProps ?? {})) visit(value);
    let hook = fiber.memoizedState;
    for (let count = 0; hook && count < 500; count++, hook = hook.next) visit(hook.memoizedState);
    stack.push(fiber.child, fiber.sibling);
  }
  if (!runtime || !monitor) throw new Error('未找到本次实际SceneRuntime/monitor。');
  window.__phase2Audit = { runtime, monitor };
}

function readRuntimeState() {
  const { runtime, monitor } = window.__phase2Audit, engine = runtime.scene.getEngine();
  const counter = monitor.engineInstrumentation.gpuFrameTimeCounter;
  return { renderer: engine.getGlInfo(), buffer: [engine.getRenderWidth(), engine.getRenderHeight()],
    visible: document.visibilityState, focused: document.hasFocus(), gpuCapture: monitor.gpuFrameTimeCaptureEnabled,
    engineCapture: engine._captureGPUFrameTime, beginObservers: engine.onBeginFrameObservable.observers.length,
    counter: counter ? { count: counter.count, current: counter.current, average: counter.lastSecAverage } : null,
    loading: runtime.getPerformanceMetrics().loading,
    materialClones: runtime.getDetachedMaterialCloneMetrics?.() ?? null,
    preparation: runtime.getPreparationClassificationMetrics?.() ?? null };
}

function captureGpuWindow(durationMs) {
  return new Promise(resolve => {
    const { runtime, monitor } = window.__phase2Audit, engine = runtime.scene.getEngine(), gl = engine._gl;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'), start = performance.now();
    const size = [engine.getRenderWidth(), engine.getRenderHeight()], samples = [], invalidReasons = [];
    let previousCount = monitor.engineInstrumentation.gpuFrameTimeCounter?.count ?? 0, disjointFrames = 0, frames = 0;
    const observer = engine.onEndFrameObservable.add(() => {
      frames++;
      if (document.visibilityState !== 'visible' || !document.hasFocus()) invalidReasons.push('not-visible-or-focused');
      if (engine.getRenderWidth() !== size[0] || engine.getRenderHeight() !== size[1]) invalidReasons.push('buffer-changed');
      const disjoint = ext ? gl.getParameter(ext.GPU_DISJOINT_EXT) : false;
      if (disjoint) disjointFrames++;
      const counter = monitor.engineInstrumentation.gpuFrameTimeCounter;
      if (counter && counter.count > previousCount) {
        if (!disjoint) samples.push({ atMs: performance.now() - start, milliseconds: counter.current / 1e6, count: counter.count });
        previousCount = counter.count;
      }
    });
    setTimeout(() => {
      engine.onEndFrameObservable.remove(observer);
      const sorted = samples.map(row => row.milliseconds).sort((a, b) => a - b), percentile = p => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
      resolve({ scope: 'actual SDK engine-frame GPU counter; unique completed query samples', extension: Boolean(ext),
        elapsedMs: performance.now() - start, frames, samples, disjointFrames, invalidReasons: [...new Set(invalidReasons)],
        valid: Boolean(ext) && invalidReasons.length === 0 && samples.length > 0, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99) });
    }, durationMs);
  });
}

function captureStaticPixels() {
  const scene = window.__phase2Audit.runtime.scene;
  return new Promise(resolve => scene.onAfterRenderObservable.addOnce(() => {
    const engine = scene.getEngine(), gl = engine._gl, width = engine.getRenderWidth(), height = engine.getRenderHeight();
    const bytes = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    let binary = ''; for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    const camera = scene.activeCamera;
    resolve({ width, height, base64: window.btoa(binary), camera: { alpha: camera.alpha, beta: camera.beta,
      radius: camera.radius, target: camera.target.asArray() }, alpha: gl.getContextAttributes().alpha });
  }));
}

async function prepareAdaptiveBaseline() {
  const { runtime } = window.__phase2Audit, camera = runtime.scene.activeCamera;
  camera.alpha = .8; camera.beta = 1.1; camera.radius = 6; camera.setTarget(camera.target.set(0, .2, 0));
  await new Promise(resolve => setTimeout(resolve, 1000));
  window.__phase2Audit.pixelBaseline = await new Promise(resolve => runtime.scene.onAfterRenderObservable.addOnce(() => {
    const engine = runtime.scene.getEngine(), gl = engine._gl, width = engine.getRenderWidth(), height = engine.getRenderHeight();
    const bytes = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    resolve({ bytes, width, height, level: engine.getHardwareScalingLevel(), alpha: camera.alpha });
  }));
}

async function exerciseAdaptiveMotion() {
  const { runtime, pixelBaseline: baseline } = window.__phase2Audit, scene = runtime.scene, engine = scene.getEngine(), camera = scene.activeCamera;
  const started = performance.now(), levels = [];
  let frames = 0;
  const motion = scene.onBeforeRenderObservable.add(() => { camera.alpha = baseline.alpha + .1 * Math.sin((performance.now() - started) / 300); });
  const record = scene.onAfterRenderObservable.add(() => { frames++; if (levels.length < 1000) levels.push(engine.getHardwareScalingLevel()); });
  await new Promise(resolve => setTimeout(resolve, 1500));
  const motionLevel = engine.getHardwareScalingLevel();
  scene.onBeforeRenderObservable.remove(motion); camera.alpha = baseline.alpha;
  await new Promise(resolve => setTimeout(resolve, 1500));
  const result = await new Promise(resolve => scene.onAfterRenderObservable.addOnce(() => {
    const gl = engine._gl, width = engine.getRenderWidth(), height = engine.getRenderHeight(), bytes = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    let changedPixels = 0, maxDifference = 0;
    if (width !== baseline.width || height !== baseline.height) changedPixels = Math.max(bytes.length, baseline.bytes.length) / 4;
    else for (let index = 0; index < bytes.length; index += 4) {
      let changed = false;
      for (let channel = 0; channel < 4; channel++) {
        const difference = Math.abs(bytes[index + channel] - baseline.bytes[index + channel]);
        if (difference) changed = true; maxDifference = Math.max(maxDifference, difference);
      }
      if (changed) changedPixels++;
    }
    resolve({ baselineLevel: baseline.level, motionLevel, restoredLevel: engine.getHardwareScalingLevel(),
      baselineSize: [baseline.width, baseline.height], restoredSize: [width, height], changedPixels, maxDifference, frames, levels });
  }));
  scene.onAfterRenderObservable.remove(record);
  return result;
}
