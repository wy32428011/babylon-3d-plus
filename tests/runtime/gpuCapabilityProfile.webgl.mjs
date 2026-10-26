/* global window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { createServer as createPortProbe } from 'node:net';
import { chromium } from 'playwright';
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? 'real-1'; assert.match(label, /^[a-zA-Z0-9_-]+$/);
const output = path.resolve('output/render-optimization-q1-20261024/r1', label); await fs.mkdir(output, { recursive: true });
const inputs = ['src/runtime/babylon/gpuCapabilityProfile.ts', 'src/runtime/babylon/ScenePerformanceMonitor.ts', 'src/runtime/babylon/SceneRuntime.ts',
  'src/runtime/babylon/scene-runtime/SceneTriangleAndReadinessController.ts', 'src/editor/panels/LightingBakeManager.tsx', 'src/editor/panels/LightingBakeManagerOverview.tsx',
  'src/editor/panels/scene-view/useSceneLightingPreview.ts', 'src/editor/store/slices/editorStoreTypes.ts', 'src/editor/store/slices/lightingManagerSlice.ts',
  'tests/fixtures/gpuCapabilityProfile.harness.tsx', 'tests/runtime/gpuCapabilityProfile.webgl.mjs'];
const hashes = () => Object.fromEntries(inputs.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const report = { status: 'RUNNING', startedAt: new Date().toISOString(), inputs: hashes(), errors: [],
  boundary: '本机独立Chrome真实WebGL2，仅验证Intel T0诊断、缓存、取消、真实SceneRuntime准备入口/manager hook/store/控件；不验证T1/T2跨机合理性、不作为整场景FPS或其它优化收益。' };
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let server, browser, page;
try {
  const probe = createPortProbe(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port; await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(output, 'vite-cache'), appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'zustand'] },
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } });
  server.middlewares.use('/__gpu_profile__', async (_request, response) => { response.setHeader('Content-Type', 'text/html');
    response.end(await server.transformIndexHtml('/__gpu_profile__', '<!doctype html><meta charset="utf-8"><title>R1 GPU能力诊断</title><style>body{margin:0;background:#171a20;color:#eee;font-family:Segoe UI,sans-serif}</style><script type="module" src="/tests/fixtures/gpuCapabilityProfile.harness.tsx"></script>')); });
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.on('pageerror', error => { report.errors.push(error.message); console.error('R1_PAGE_ERROR ' + error.message); });
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__gpu_profile__', { waitUntil: 'commit', timeout: 120000 });
  await page.waitForFunction(() => window.gpuProfileHarness?.ready, undefined, { timeout: 120000 });
  const cold = await page.evaluate(() => window.gpuProfileHarness.cold); report.cold = cold; await save();
  assert.equal(cold.status, 'measured'); assert.equal(cold.tier, 'T0'); assert.equal(cold.source, 'probe');
  assert.equal(cold.measurement.samplesMs.length, 12); assert.equal(cold.provenance.hostMatched, true); assert.equal(cold.provenance.unmasked, true);
  assert.doesNotMatch(cold.driver.renderer, /swiftshader|software|llvmpipe|microsoft basic render/i);
  await page.getByRole('heading', { name: '本机图形能力', exact: true }).waitFor({ state: 'visible', timeout: 90000 });
  await page.waitForFunction(() => window.gpuProfileHarness.store.getState().lightingGpuCapabilityProfile?.status === 'measured');
  const before = await page.evaluate(() => window.gpuProfileHarness.snapshot()); report.before = before;
  assert.equal(before.settings, await page.evaluate(() => window.gpuProfileHarness.before.settings));
  assert.equal(before.scale, await page.evaluate(() => window.gpuProfileHarness.before.scale));
  assert.equal(before.counts.contexts, 1); assert.equal(before.counts.deleted, 5); assert.equal(before.counts.lost, 1);
  assert.equal(before.diagnostic.gpuCapabilityProfile.status, 'measured'); assert.equal(before.diagnostic.gpuCapabilityProfile.tier, 'T0');
  report.invalidated = await page.evaluate(() => window.gpuProfileHarness.invalidate());
  assert.equal(report.invalidated, null);
  await page.waitForFunction(() => window.gpuProfileHarness.store.getState().lightingGpuCapabilityProfile === null, undefined, { timeout: 5000 });
  report.unavailable = await page.evaluate(() => window.gpuProfileHarness.unavailable());
  await page.waitForFunction(() => window.gpuProfileHarness.store.getState().lightingGpuCapabilityProfile?.status === 'unavailable', undefined, { timeout: 5000 });
  assert.ok(await page.getByText('本机检测不可用，增强效果建议保留默认。', { exact: true }).isVisible());
  report.recovered = await page.evaluate(() => window.gpuProfileHarness.recover());
  await page.waitForFunction(() => window.gpuProfileHarness.store.getState().lightingGpuCapabilityProfile?.status === 'measured', undefined, { timeout: 5000 });
  const verifiedProbeCount = await page.evaluate(() => window.gpuProfileHarness.counts.contexts);
  const device = page.getByLabel('烘焙计算设备', { exact: true }); const deviceBefore = await device.inputValue();
  assert.equal(await page.getByRole('button', { name: '应用配置', exact: true }).count(), 0, '只读诊断不能弄脏画质草稿');
  await page.getByText('检测范围与建议说明', { exact: true }).click();
  assert.ok(await page.getByText('不是 GPU 计时器或整场景帧率', { exact: false }).isVisible());
  await page.screenshot({ path: path.join(output, 'manager-t0.png') });
  await page.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
  await page.evaluate(() => window.gpuProfileHarness.store.getState().openLightingManager());
  await page.getByRole('heading', { name: '本机图形能力', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await device.inputValue(), deviceBefore); assert.equal(await page.evaluate(() => window.gpuProfileHarness.counts.contexts), verifiedProbeCount, '重开manager不发起probe');
  report.readonlyReopened = await page.evaluate(() => window.gpuProfileHarness.snapshot());
  assert.equal(report.readonlyReopened.settings, before.settings); assert.equal(report.readonlyReopened.scale, before.scale);
  await page.screenshot({ path: path.join(output, 'manager-reopened.png') });
  const quality = page.getByLabel('烘焙质量', { exact: true }), oldQuality = await quality.inputValue(), desired = oldQuality === 'high' ? 'standard' : 'high';
  await quality.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'quality-before.png') });
  await quality.selectOption(desired); await page.getByRole('button', { name: '应用配置', exact: true }).click();
  await page.waitForFunction(value => window.gpuProfileHarness.store.getState().scene.sceneSettings.lighting.bake.quality === value, desired);
  report.manualControl = { originalDevice: deviceBefore, deviceAfter: await device.inputValue(), oldQuality, requestedQuality: desired,
    actualQuality: await page.evaluate(() => window.gpuProfileHarness.store.getState().scene.sceneSettings.lighting.bake.quality) };
  assert.equal(report.manualControl.deviceAfter, deviceBefore);
  await quality.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'quality-after.png') });
  await page.screenshot({ path: path.join(output, 'manager-manual-quality.png') });
  report.hot = await page.evaluate(() => window.gpuProfileHarness.hot()); await save();
  assert.equal(report.hot.profile.status, 'measured'); assert.equal(report.hot.profile.source, 'cache');
  assert.equal(report.hot.loading.stages.gpuCapabilityProbe.count, 1, '真实Readiness准备阶段应独立记录GPU诊断');
  assert.equal(report.hot.counts.contexts, verifiedProbeCount, '热cache不创建新probe');
  report.cancel = await page.evaluate(() => window.gpuProfileHarness.cancel()); await save();
  assert.equal(report.cancel.sameReason, true); assert.equal(report.cancel.profile, null); assert.equal(report.cancel.hostAlive, true);
  assert.equal(report.cancel.counts.deleted - report.cancel.start.deleted, 5); assert.equal(report.cancel.counts.lost - report.cancel.start.lost, 1);
  report.rollover = await page.evaluate(() => window.gpuProfileHarness.ownerRollover()); await save();
  assert.equal(report.rollover.sameOwnerReason, true); assert.equal(report.rollover.profile.status, 'measured'); assert.equal(report.rollover.hostAlive, true);
  assert.equal(report.rollover.counts.contexts - report.rollover.start.contexts, 2); assert.equal(report.rollover.counts.lost - report.rollover.start.lost, 2);
  assert.equal(report.rollover.counts.deleted - report.rollover.start.deleted, 10); assert.deepEqual(report.errors, []);
  await page.evaluate(() => window.gpuProfileHarness.dispose());
  await page.reload({ waitUntil: 'commit', timeout: 120000 });
  await page.waitForFunction(() => window.gpuProfileHarness?.ready, undefined, { timeout: 120000 });
  await page.waitForFunction(() => window.gpuProfileHarness.store.getState().lightingGpuCapabilityProfile?.source === 'cache', undefined, { timeout: 10000 });
  report.warmReload = await page.evaluate(() => window.gpuProfileHarness.snapshot());
  assert.equal(report.warmReload.profile.source, 'cache'); assert.equal(report.warmReload.counts.contexts, 0);
  assert.ok(await page.getByText('已读取本机缓存', { exact: false }).isVisible());
  await page.screenshot({ path: path.join(output, 'manager-cached.png') });
  assert.deepEqual(hashes(), report.inputs, '运行中源码漂移不能作为交付证据');
  await page.evaluate(() => window.gpuProfileHarness.dispose()); report.status = 'PASS'; report.completedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, output, renderer: cold.driver.renderer, tier: cold.tier, source: cold.source,
    sampleCount: cold.measurement.samplesMs.length, hotSource: report.hot.profile.source, manualControl: report.manualControl, cancel: report.cancel.sameReason, rollover: report.rollover.profile.status }, null, 2));
} catch (error) { report.status = 'FAIL'; report.error = { message: error.message, stack: error.stack };
  if (page) { report.failureBoot = await page.evaluate(() => window.gpuProfileBoot).catch(() => null); report.failureState = await page.evaluate(() => window.gpuProfileHarness?.snapshot()).catch(() => null); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
  await save(); throw error;
} finally { await browser?.close(); await server?.close(); }
