import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const { values } = parseArgs({ options: {
  'baseline-module': { type: 'string' }, output: { type: 'string' },
} });
const output = path.resolve(values.output ?? 'output/playwright/screen-overlay-performance');
const currentModule = path.resolve('src/runtime/babylon/DataPlatformScreenOverlay.tsx');
const baselineModule = values['baseline-module'] ? path.resolve(values['baseline-module']) : currentModule;
const fixtureRoot = path.join(output, 'fixture');
await mkdir(fixtureRoot, { recursive: true });

// 单独编译真实 Overlay 组件，保持生产 React 和 Babylon；不接入外部服务或用户场景。
async function browserFixture() {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Engine, Scene, FreeCamera, Vector3, MeshBuilder, StandardMaterial } = await import('@babylonjs/core');
  const { SceneInstrumentation } = await import('@babylonjs/core/Instrumentation/sceneInstrumentation');
  const { EngineInstrumentation } = await import('@babylonjs/core/Instrumentation/engineInstrumentation');
  const original = new URLSearchParams(location.search).get('version') === 'baseline';
  const { DataPlatformScreenOverlay } = original ? await import('@baseline') : await import('@current');
  const canvas = document.querySelector('canvas');
  const engine = new Engine(canvas, true, { powerPreference: 'high-performance', preserveDrawingBuffer: false, stencil: true });
  const scene = new Scene(engine);
  scene.clearColor.set(.04, .06, .09, 1);
  const camera = new FreeCamera('camera', new Vector3(0, 0, 20), scene);
  camera.setTarget(Vector3.Zero());
  const material = new StandardMaterial('screen', scene);
  material.disableLighting = true;
  material.emissiveColor.set(.15, .4, .6);
  material.backFaceCulling = false;
  const items = [];
  for (let i = 0; i < 36; i++) {
    const mesh = MeshBuilder.CreateGround('screen-' + i, { width: 2, height: 2 }, scene);
    mesh.position.set((i % 6 - 2.5) * 2.3, (Math.floor(i / 6) - 2.5) * 1.7, 0);
    mesh.scaling.set(.9, 1, .65);
    mesh.rotation.x = Math.PI / 2;
    mesh.rotation.y = Math.PI;
    mesh.material = material;
    items.push({ entityId: 'screen-' + i, name: '设备 ' + i, mesh, screenUrl: new URL('screen.html', location.href).href });
  }
  const runtime = { getDataPlatformScreenOverlayItems: () => items.filter(item => item.mesh.isEnabled()) };
  const metrics = { calls: 0, rectReads: 0, durations: [], frameIntervals: [] };
  let recording = false, previousFrame = 0, moving = false, frameIndex = 0;
  const originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (...args) {
    if (recording) metrics.rectReads++;
    return originalRect.apply(this, args);
  };
  // 只计本组件注册的相机回调；不把整帧或定时器错误地归到 Overlay。
  const originalAdd = scene.onBeforeCameraRenderObservable.add.bind(scene.onBeforeCameraRenderObservable);
  scene.onBeforeCameraRenderObservable.add = (callback, ...args) => originalAdd((...data) => {
    if (!recording) return callback(...data);
    const start = performance.now();
    try { return callback(...data); }
    finally { metrics.calls++; metrics.durations.push(performance.now() - start); }
  }, ...args);
  const si = new SceneInstrumentation(scene);
  si.captureFrameTime = si.captureRenderTime = si.captureActiveMeshesEvaluationTime = true;
  const ei = new EngineInstrumentation(engine);
  ei.captureGPUFrameTime = true;
  const root = createRoot(document.querySelector('#react'));
  root.render(React.createElement(DataPlatformScreenOverlay, { scene, runtime, canvas, interactive: true }));
  scene.onBeforeRenderObservable.add(() => {
    if (moving) {
      camera.position.x = Math.sin(frameIndex++ / 40) * 3;
      camera.setTarget(Vector3.Zero());
    }
  });
  scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    if (recording && previousFrame) metrics.frameIntervals.push(now - previousFrame);
    previousFrame = now;
  });
  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());
  const percentile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  };
  window.fixture = {
    engine, scene, camera, items, root,
    async measure(mode) {
      moving = mode === 'moving'; frameIndex = 0;
      metrics.calls = metrics.rectReads = 0; metrics.durations = []; metrics.frameIntervals = [];
      previousFrame = 0; recording = true;
      await new Promise(resolve => setTimeout(resolve, 5000));
      recording = false; moving = false;
      const intervals = metrics.frameIntervals;
      return { mode, frames: metrics.calls, rectReadsPerFrame: metrics.rectReads / metrics.calls,
        overlayAverageMs: metrics.durations.reduce((a, b) => a + b, 0) / metrics.calls,
        overlayP95Ms: percentile(metrics.durations, .95),
        fps: intervals.length * 1000 / intervals.reduce((a, b) => a + b, 0),
        frameP95Ms: percentile(intervals, .95), cpuFrameMs: si.frameTimeCounter.lastSecAverage,
        renderMs: si.renderTimeCounter.lastSecAverage, activeMeshesMs: si.activeMeshesEvaluationTimeCounter.lastSecAverage,
        gpuFrameMs: ei.gpuFrameTimeCounter.lastSecAverage > 0 ? ei.gpuFrameTimeCounter.lastSecAverage * 1e-6 : null,
        drawCalls: si.drawCallsCounter.current, activeMeshes: scene.getActiveMeshes().length };
    },
    pose(name) {
      camera.position.set(name === 'angled' ? 3 : 0, 0, 20); camera.setTarget(Vector3.Zero());
      camera.mode = name === 'orthographic' ? 1 : 0;
      camera.orthoLeft = -14; camera.orthoRight = 14; camera.orthoTop = 10; camera.orthoBottom = -10;
    },
    async settle() {
      await new Promise(resolve => { let frames = 0; const observer = scene.onAfterRenderObservable.add(() => {
        if (++frames === 4) { scene.onAfterRenderObservable.remove(observer); resolve(); }
      }); });
    },
    dispose() { root.unmount(); si.dispose(); ei.dispose(); scene.dispose(); engine.dispose(); },
  };
}

await writeFile(path.join(fixtureRoot, 'index.html'), '<!doctype html><html><meta charset="utf-8"><body style="margin:0"><main style="position:relative;width:100vw;height:100vh"><canvas style="display:block;width:100%;height:100%"></canvas><div id="react"></div></main><script type="module" src="./entry.js"></script></body></html>');
await writeFile(path.join(fixtureRoot, 'entry.js'), '(' + browserFixture.toString() + ')();');
await mkdir(path.join(fixtureRoot, 'public'), { recursive: true });
await writeFile(path.join(fixtureRoot, 'public/screen.html'), '<!doctype html><html><meta charset="utf-8"><body style="margin:0;background:#164c68;color:white;font:80px sans-serif;text-align:center"><h1>设备运行</h1><p>状态正常</p><button style="font:60px sans-serif" onclick="this.textContent=\'已查看\'">查看</button></body></html>');
const config = { configFile: false, root: fixtureRoot, base: './', plugins: [react()],
  resolve: { alias: { '@current': currentModule, '@baseline': baselineModule } },
  build: { outDir: path.join(output, 'dist'), emptyOutDir: true }, logLevel: 'warn' };
await build(config);
let server, browser;
const report = { passed: false, scope: 'production-overlay-fixture-36-live-screens',
  sourceHashes: await Promise.all([baselineModule, currentModule].map(async file => ({ file,
    sha256: createHash('sha256').update(await readFile(file)).digest('hex') }))), runs: [], errors: [] };
try {
  server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const origin = server.resolvedUrls.local[0];
  // A/B 交错，避免把首次着色器编译或单向温度漂移当成优化收益。
  for (const version of values['baseline-module'] ? ['baseline', 'optimized', 'optimized', 'baseline'] : ['optimized']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(origin + '?version=' + version);
    await page.waitForFunction(() => window.fixture && document.querySelectorAll('iframe').length === 36, null, { timeout: 90000 });
    await page.waitForFunction(() => [...document.querySelectorAll('iframe')].every(frame => frame.style.visibility === 'visible'));
    await page.evaluate(() => window.fixture.settle());
    await page.waitForTimeout(5000);
    const conditions = await page.evaluate(() => ({ renderer: window.fixture.engine.getGlInfo(),
      width: window.fixture.engine.getRenderWidth(), height: window.fixture.engine.getRenderHeight(), dpr: devicePixelRatio }));
    assert.doesNotMatch(conditions.renderer.renderer, /swiftshader|llvmpipe|software|basic render/i, '必须使用硬件 WebGL');
    const samples = [];
    for (const mode of ['still', 'moving']) samples.push(await page.evaluate(mode => window.fixture.measure(mode), mode));
    const screenshots = [];
    for (const pose of ['front', 'angled', 'orthographic']) {
      await page.evaluate(pose => window.fixture.pose(pose), pose);
      await page.evaluate(() => window.fixture.settle());
      const file = path.join(output, version + '-' + report.runs.length + '-' + pose + '.png');
      const pixels = await page.screenshot({ path: file });
      screenshots.push({ pose, file, sha256: createHash('sha256').update(pixels).digest('hex') });
    }
    const button = page.frameLocator('[data-screen-entity-id="screen-0"] iframe').getByRole('button', { name: '查看', exact: true });
    await button.click();
    assert.equal(await page.frameLocator('[data-screen-entity-id="screen-0"] iframe').getByRole('button', { name: '已查看', exact: true }).count(), 1);
    await page.setViewportSize({ width: 900, height: 650 });
    await page.evaluate(() => window.fixture.settle());
    assert.equal(await page.evaluate(() => window.fixture.engine.getRenderWidth()), 900);
    await page.evaluate(() => { window.fixture.items[0].mesh.setEnabled(false); });
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 35);
    await page.evaluate(() => { window.fixture.items[0].mesh.setEnabled(true); });
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 36);
    await page.evaluate(() => window.fixture.dispose());
    assert.equal(await page.locator('iframe').count(), 0);
    report.runs.push({ version, conditions, samples, screenshots, checks: ['screen click', 'resize', 'hide', 'restore', 'dispose'] });
    await page.close();
  }
  if (values['baseline-module']) {
    const before = report.runs.find(run => run.version === 'baseline');
    const after = report.runs.find(run => run.version === 'optimized');
    assert.deepEqual(before.conditions, after.conditions);
    report.pixelIdentical = before.screenshots.every((shot, i) => shot.sha256 === after.screenshots[i].sha256);
    assert.equal(report.pixelIdentical, true, '固定视角截图必须逐字节一致');
    assert.ok(after.samples.every(sample => sample.rectReadsPerFrame <= 2.1), '每帧只读取 canvas/root 两次尺寸');
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve());
}
console.log(JSON.stringify({ passed: report.passed, pixelIdentical: report.pixelIdentical,
  runs: report.runs.map(({ version, samples }) => ({ version, samples })), output }, null, 2));
