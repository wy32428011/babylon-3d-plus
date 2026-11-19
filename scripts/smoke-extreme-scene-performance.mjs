import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { _electron } from 'playwright';
import { createPerformanceMqttReplay } from './lib/performanceMqttReplay.mjs';

if (process.argv[1] && path.relative(fileURLToPath(import.meta.url), path.resolve(process.argv[1])) === '') {
  const args = process.argv.slice(2);
  if (args.includes('--baab')) {
    const { runHardwareScalingDiagnosis } = await import('./diagnose-extreme-scene-baab.mjs');
    await runHardwareScalingDiagnosis(args, {
      launch: (options) => _electron.launch(options),
      createPerformanceMqttReplay, configureWindow, selectProjectDirectory, openRecentScene,
      waitForStableCanvas, installCapture, startCpuProfile,
    });
  } else {
    await runLegacy();
  }
}

async function runLegacy() {
const { values } = parseArgs({ options: {
  scene: { type: 'string' }, workspace: { type: 'string' }, output: { type: 'string' },
  url: { type: 'string' },
  'app-root': { type: 'string' }, replay: { type: 'string' }, 'no-timing': { type: 'boolean', default: false },
  'project-root': { type: 'string' },
  'warm-opens': { type: 'string', default: '0' },
  fullscreen: { type: 'boolean', default: false },
  seconds: { type: 'string', default: '60' }, repeats: { type: 'string', default: '3' },
  'soak-cycles': { type: 'string', default: '0' },
  modes: { type: 'string', default: 'edit,static,input-only,motion,roam-still,roam-walk' },
  profile: { type: 'boolean', default: false }, timeout: { type: 'string', default: '600000' },
  'react-probe': { type: 'boolean', default: false },
} });
assert.ok(values.scene && values.workspace && values.output,
  '用法：node scripts/smoke-extreme-scene-performance.mjs --scene <scene.json> --workspace <资源工作区> --output <报告目录>');
const seconds = Number(values.seconds), repeats = Number(values.repeats), timeout = Number(values.timeout);
const warmOpens = Number(values['warm-opens']);
assert.ok(Number.isInteger(warmOpens) && warmOpens >= 0 && warmOpens <= 20);
assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 1800);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
assert.ok(Number.isFinite(timeout) && timeout >= 1000 && timeout <= 3_600_000);
const modes = values.modes.split(',');
const soakCycles = Number(values['soak-cycles']);
assert.ok(Number.isInteger(soakCycles) && soakCycles >= 0 && soakCycles <= 50);
if (soakCycles) assert.ok(repeats === 1 && modes.length === 1 && modes[0] === 'motion-roam'
  && seconds >= soakCycles * 30 && !values.replay, '资源浸泡使用持续本机数据，每次启停至少预留 30 秒。');
assert.ok(modes.length && modes.every(mode => ['edit', 'static', 'input-only', 'motion', 'roam-still', 'roam-walk', 'motion-roam'].includes(mode)));
const sourcePath = path.resolve(values.scene), workspace = path.resolve(values.workspace);
const output = path.resolve(values.output), sourceBytes = await readFile(sourcePath);
const appRoot = path.resolve(values['app-root'] ?? process.cwd());
const recording = values.replay ? JSON.parse(await readFile(path.resolve(values.replay), 'utf8')) : null;
if (recording) {
  assert.ok(recording.summary?.sensitiveSkipped === 0 && recording.records?.length, '录制包含缺失消息，不能用于完整回放');
  assert.ok(recording.records.at(-1).atMs - recording.records[0].atMs >= seconds * 1000 + 3000,
    '录制时长必须覆盖预热和完整采样窗口，不能把回放耗尽当作设备静止。');
}
const sourceHash = digest(sourceBytes), document = JSON.parse(sourceBytes.toString('utf8'));
const sceneDocument = document.scene;
assert.ok(sceneDocument?.entities && sceneDocument.entityIds?.length, '场景没有实体。');
const bindings = Object.values(sceneDocument.entities).filter(entity => entity.components?.telemetryBinding?.enabled
  && entity.components?.modelAsset?.assetCode).map(entity => ({
    assetCode: entity.components.modelAsset.assetCode,
    deviceType: entity.components.telemetryBinding.deviceType,
    sourceId: entity.components.telemetryBinding.sourceId || 'default',
  })).filter(device => ['stacker', 'conveyor', 'rgv'].includes(device.deviceType));
assert.ok(bindings.every(device => device.sourceId === 'default'), '此回放要求 default 数据源；其他来源需提供对应固定回放。');
const devices = [...new Map(bindings.map(device => [`${device.deviceType}:${device.assetCode}`, device])).values()];
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'zending-extreme-performance-'));
const userData = path.join(root, 'userdata'), fixture = path.join(root, 'performance.scene.json');
const report = { passed: false, sourceSha256: sourceHash, scope: recording ? 'real-scene-recorded-MQTT-replay' : 'real-scene-local-MQTT-replay',
  replaySha256: recording ? digest(Buffer.from(JSON.stringify(recording.records))) : null,
  telemetryTimingEnabled: !values['no-timing'],
  sceneEntityCount: sceneDocument.entityIds.length, deviceCount: devices.length, seconds, repeats,
  profileEnabled: values.profile, modes, runs: [], errors: [] };
report.reactProbeEnabled = values['react-probe'];
report.lifecycleSoak = soakCycles > 0;
report.fullscreen4k = values.fullscreen;
let app, page, broker;
const harnessStarted = performance.now();
let applicationStarted;
try {
  report.buildFiles = await Promise.all(['dist/index.html', 'dist-electron/main.js'].map(async file => ({
    file, sha256: digest(await readFile(path.join(appRoot, file))),
  })));
  broker = await createPerformanceMqttReplay(devices, 500, { records: recording?.records, durationMs: seconds * 1000 + 3000 });
  await mkdir(userData);
  // 只修改临时场景的数据入口，原场景、资源引用、相机、人物、几何及动画脚本保持原样。
  sceneDocument.mqttConfig = { ...sceneDocument.mqttConfig, enabled: true, simulatorEnabled: false,
    address: broker.address, ip: '127.0.0.1', topic: 'dt/factory/logistics/+/+/twindatadriven/joint',
    subscriptions: [{ topic: 'dt/factory/logistics/+/+/twindatadriven/joint', qos: 0, adapter: { kind: 'epv', sourceId: 'default' } }] };
  await writeFile(fixture, JSON.stringify(document));
  await writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: values.url ?? '', workspaceRoot: workspace }));
  await writeFile(path.join(userData, 'recent-workspaces.json'), JSON.stringify({ version: 1, projects: [],
    scenes: [{ filePath: fixture, lastOpenedAt: new Date().toISOString() }] }));
  applicationStarted = performance.now();
  app = await _electron.launch({ args: [appRoot, `--user-data-dir=${userData}`], cwd: appRoot,
    env: { ...process.env, OPEN_DEVTOOLS: 'false', VITE_DEV_SERVER_URL: '' }, timeout: 120000 });
  page = await app.firstWindow();
  if (values['react-probe']) {
    await page.addInitScript(() => {
      if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;
      const probe = { commits: 0, renderers: new Map() };
      window.__performanceReactProbe = probe;
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true, renderers: probe.renderers,
        inject(renderer) { const id = probe.renderers.size + 1; probe.renderers.set(id, renderer); return id; },
        onCommitFiberRoot() { probe.commits += 1; }, onCommitFiberUnmount() {},
      };
    });
    // 诊断专用 reload 使生产 React 在初始化时连接计数 hook，不纳入冷启动对比。
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__performanceReactProbe?.renderers.size > 0);
  }
  await configureWindow(app, values.fullscreen);
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.errors.push(redact(error.message)));
  page.on('dialog', dialog => dialog.accept()); // 仅本脚本创建的场景副本，无用户编辑。
  await page.bringToFront();
  if (values['project-root']) {
    await selectProjectDirectory(app, page, path.resolve(values['project-root']));
  }
  if (values.fullscreen) await page.waitForFunction(() => Math.round(innerWidth * devicePixelRatio) === 3840
    && Math.round(innerHeight * devicePixelRatio) === 2160, null, { timeout: 15000 });
  const firstOpenStarted = performance.now();
  await openRecentScene(page, fixture, timeout);
  report.loading = {
    diagnosticOnly: values['react-probe'],
    cold: { harnessToReadyMs: performance.now() - harnessStarted,
      applicationToReadyMs: performance.now() - applicationStarted,
      openToReadyMs: performance.now() - firstOpenStarted },
    warm: [],
    definition: 'cold=fresh Electron and userData; warm=renderer reload in same Electron/userData; OS file cache not cleared',
  };
  console.log(JSON.stringify({ phase: 'cold-ready', ...report.loading.cold }));
  for (let index = 0; index < warmOpens; index += 1) {
    const started = performance.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    const recent = page.locator('.home-recent-card').filter({ hasText: path.basename(fixture) })
      .getByRole('button', { name: '打开', exact: true });
    await recent.waitFor({ state: 'visible', timeout: 120000 });
    const openStarted = performance.now();
    await recent.click();
    await page.waitForFunction(() => document.querySelector('canvas.scene-canvas')
      && (!document.querySelector('[data-scene-preparation-phase]')
        || document.querySelector('[data-scene-preparation-phase]')?.textContent?.includes('场景资源加载失败')),
    null, { timeout });
    assert.equal(await page.locator('[data-scene-preparation-phase]').count(), 0,
      '暖加载资源准备失败，不得计为通过样本');
    const sample = { index: index + 1, reloadToReadyMs: performance.now() - started,
      openToReadyMs: performance.now() - openStarted };
    report.loading.warm.push(sample);
    console.log(JSON.stringify({ phase: 'warm-ready', ...sample }));
  }
  if (values.fullscreen) {
    await page.getByRole('button', { name: '全屏显示场景 (F11)', exact: true }).click();
    await page.locator('[data-scene-fullscreen="true"]').waitFor();
    // Windows 全屏边界可能波动 1 px；仅测试固定完整画布，保持 DPR 与渲染质量。
    await page.locator('canvas.scene-canvas').evaluate(canvas => {
      Object.assign(canvas.style, { width: '3840px', minWidth: '3840px', maxWidth: '3840px',
        height: '2110px', minHeight: '2110px', maxHeight: '2110px' });
    });
  }
  await waitForStableCanvas(page);
  await page.evaluate(installCapture);
  const resourceProblems = await page.locator('aside[aria-label="场景资源状态"] pre').allTextContents();
  assert.deepEqual(resourceProblems, [], '场景仍有资源问题，不能作为完整功能性能基线');
  const initial = await page.evaluate(() => window.__extremeCapture.snapshot());
  assert.equal(initial.pendingModels, 0);
  assert.equal(initial.failedAcquisitions, 0);
  assert.ok(['ready', 'idle'].includes(initial.environmentPhase));
  assert.ok(['ready', 'idle'].includes(initial.skyboxPhase));
  assert.doesNotMatch(initial.renderer.renderer, /swiftshader|llvmpipe|software/i);
  report.initial = initial;
  const inventory = await page.evaluate(() => window.__extremeCapture.inventory());
  report.inventorySha256 = digest(Buffer.from(JSON.stringify(inventory)));
  report.inventory = inventory;
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const mode of modes) {
      broker.setMode('silent');
      await page.evaluate(() => window.__extremeCapture.resetCamera());
      if (mode !== 'edit') {
        await page.locator('button.toolbar-button[aria-label="运行"]').click();
        await page.locator('button.toolbar-button[aria-label="停止"]').waitFor();
        await page.waitForFunction(() => !document.querySelector('button[aria-label="停止"]')?.disabled);
      }
      await page.evaluate(disabled => window.__extremeCapture.disableActions(disabled), mode === 'input-only');
      if (mode !== 'edit') {
        const connectedBy = Date.now() + 10000;
        while (!broker.getMetrics().clients && Date.now() < connectedBy) await page.waitForTimeout(50);
        assert.ok(broker.getMetrics().clients, '未连接隔离 MQTT 回放服务');
      }
      if (mode.startsWith('roam-') || mode === 'motion-roam') {
        await page.getByRole('button', { name: '开始漫游', exact: true }).click();
        await page.getByRole('button', { name: '结束漫游', exact: true }).waitFor();
      }
      await waitForStableCanvas(page);
      broker.setMode(['motion', 'input-only', 'motion-roam'].includes(mode) ? 'motion' : mode === 'static' ? 'static' : 'silent');
      await page.waitForTimeout(3000);
      const profiler = values.profile ? await startCpuProfile(page) : null;
      await page.evaluate(({ timing, movingCamera }) => window.__extremeCapture.start(timing, movingCamera), {
        timing: !values['no-timing'], movingCamera: mode.startsWith('roam-') || mode === 'motion-roam',
      });
      const deadline = Date.now() + seconds * 1000;
      let direction = 0;
      let completedSoakCycles = 0;
      const soakStarted = Date.now();
      const cycleSnapshots = [];
      while (Date.now() < deadline) {
        const key = ['w', 'd', 's', 'a'][direction++ % 4];
        if (mode === 'roam-walk') await page.keyboard.down(key);
        await page.waitForTimeout(Math.min(2000, Math.max(1, deadline - Date.now())));
        if (mode === 'roam-walk') await page.keyboard.up(key);
        const violation = await page.evaluate(() => window.__extremeCapture.getViolation());
        assert.equal(violation, null, violation || '采样条件变化');
        if (completedSoakCycles < soakCycles
          && Date.now() - soakStarted >= (completedSoakCycles + 1) * seconds * 1000 / (soakCycles + 1)) {
          broker.setMode('silent');
          await page.getByRole('button', { name: '结束漫游', exact: true }).click();
          await page.locator('button.toolbar-button[aria-label="停止"]').click();
          await page.waitForTimeout(500);
          await page.locator('button.toolbar-button[aria-label="运行"]').click();
          await page.getByRole('button', { name: '开始漫游', exact: true }).click();
          broker.setMode('motion');
          completedSoakCycles += 1;
          cycleSnapshots.push(await page.evaluate(() => window.__extremeCapture.snapshot()));
        }
      }
      const measured = await page.evaluate(() => window.__extremeCapture.stop());
      const replay = broker.getMetrics();
      if (profiler) {
        const profile = await profiler.send('Profiler.stop');
        await writeFile(path.join(output, `${mode}-${repeat}.cpuprofile`), JSON.stringify(profile.profile));
        await profiler.detach();
      }
      assert.ok(measured.intervalCount > 1, '缺少连续渲染帧');
      assert.equal(replay.failures, 0, `回放连接出现积压或协议错误：${JSON.stringify(replay)}`);
      if (['static', 'motion', 'input-only', 'motion-roam'].includes(mode)) assert.ok(replay.messages > 0 && replay.clients > 0, '没有持续的实际 MQTT 投递');
      const run = { mode, repeat, replay, completedSoakCycles, cycleSnapshots, ...measured };
      if (soakCycles) assert.equal(completedSoakCycles, soakCycles);
      run.processMemory = await app.evaluate(({ app }) => app.getAppMetrics().map(metric => ({
        type: metric.type, workingSetSizeKB: metric.memory.workingSetSize, peakWorkingSetSizeKB: metric.memory.peakWorkingSetSize,
      })));
      report.runs.push(run);
      await page.screenshot({ path: path.join(output, `${mode}-${repeat}.png`), timeout: 30000 });
      await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ mode, repeat, fps: run.effectiveFps, p95: run.p95Ms, p99: run.p99Ms,
        cpuTelemetryMs: run.last?.telemetry?.lastFrameTimeMs, roam: run.last?.roamMetrics }));
      await page.evaluate(() => window.__extremeCapture.disableActions(false));
      broker.setMode('silent');
      if (mode.startsWith('roam-') || mode === 'motion-roam') await page.getByRole('button', { name: '结束漫游', exact: true }).click();
      if (mode !== 'edit') await page.locator('button.toolbar-button[aria-label="停止"]').click();
      await page.waitForTimeout(1000);
    }
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(redact(error.stack || String(error)));
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    report.failureState = await page.locator('[data-scene-preparation-phase]').allTextContents().then(text => redact(text.join('\n'))).catch(() => null);
    report.failureLogs = await page.locator('.console-dock-message').allTextContents().then(text => text.slice(0, 12).map(redact)).catch(() => []);
  }
  process.exitCode = 1;
} finally {
  try {
    if (page && !page.isClosed()) await page.evaluate(() => window.__extremeCapture?.dispose()).catch(() => {});
    await app?.close();
  } catch (error) {
    report.errors.push(`关闭测试应用失败：${redact(error.message)}`);
    report.passed = false;
  }
  try { await broker?.close(); }
  catch (error) { report.errors.push(`关闭回放服务失败：${redact(error.message)}`); report.passed = false; }
  try {
    report.sourceUnchanged = digest(await readFile(sourcePath)) === sourceHash;
  } catch (error) {
    report.sourceUnchanged = false;
    report.errors.push(`源场景复核失败：${redact(error.message)}`);
  }
  try {
    report.passed &&= report.sourceUnchanged;
    if (!report.passed) process.exitCode = 1;
    await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  } finally {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    assert.ok(relative.startsWith('zending-extreme-performance-') && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ passed: report.passed, output, errors: report.errors }));
}
}

async function configureWindow(app, fullscreen) {
  await app.evaluate(({ BrowserWindow }, fullscreen) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (fullscreen) window.setFullScreen(true);
    else {
      window.setSize(1440, 900);
      window.setResizable(false);
      window.setMaximizable(false);
      window.setMovable(false);
    }
  }, fullscreen);
}

async function selectProjectDirectory(app, page, projectRoot) {
  // SOURCE 工程副本沿用正常项目选择 IPC 建立资源授权，不把 Viewer 文件当成已打开工程。
  await app.evaluate(({ dialog }, root) => {
    globalThis.__performanceOriginalDirectoryDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  }, projectRoot);
  try {
    const selected = await page.evaluate(() => window.editorApi.selectProjectDirectory());
    assert.ok(!selected.canceled && path.resolve(selected.projectRoot) === projectRoot, '未能打开指定的本地工程');
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.__performanceOriginalDirectoryDialog;
      delete globalThis.__performanceOriginalDirectoryDialog;
    });
  }
}

async function openRecentScene(page, fixture, timeout, diagnostic = false) {
  await page.locator('.home-recent-card').filter({ hasText: path.basename(fixture) })
    .getByRole('button', { name: '打开', exact: true }).click();
  const phase = page.locator('[data-scene-preparation-phase]');
  await page.waitForFunction(() => document.querySelector('canvas.scene-canvas')
    && (!document.querySelector('[data-scene-preparation-phase]')
      || document.querySelector('[data-scene-preparation-phase]')?.textContent?.includes('场景资源加载失败')),
  null, { timeout });
  if (await phase.count() !== 0) {
    const detail = diagnostic ? '' : `：${(await phase.allTextContents()).join('\n')}`;
    throw new Error(`资源准备失败，不能将不完整场景计为性能样本${detail}`);
  }
}

async function startCpuProfile(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Profiler.enable');
    await session.send('Profiler.start');
    return session;
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
}

/** 探针只读现有运行时；动作隔离只在此测试实例中包装帧入口，退出时恢复原方法。 */
export function installCapture(diagnostic = false) {
  const element = document.getElementById('root');
  const key = Object.keys(element ?? {}).find(key => key.startsWith('__reactContainer$'));
  const first = element?.[key];
  const stack = first ? [first.stateNode?.current ?? first] : [];
  const seen = new Set();
  let runtime, roam;
  const monitors = [];
  let reactCommitsAtStart = null;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    const current = value.current ?? value;
    if (current.scene?.meshes && !current.scene.isDisposed && typeof current.getPerformanceMetrics === 'function'
      && typeof current.getTelemetryPerformanceMetrics === 'function') runtime = current;
    if (current.options?.scene && typeof current.setVirtualMovement === 'function' && typeof current.getSnapshot === 'function') roam = current;
    if (!current.disposed && (typeof current.getFrameWorkTiming === 'function'
      || (current.engineInstrumentation && current.sceneInstrumentation))) monitors.push(current);
  };
  while (stack.length && seen.size < 30000) {
    const fiber = stack.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    visit(fiber.memoizedProps); for (const value of Object.values(fiber.memoizedProps ?? {})) visit(value);
    let hook = fiber.memoizedState;
    for (let count = 0; hook && count < 500; count++, hook = hook.next) visit(hook.memoizedState);
    stack.push(fiber.child, fiber.sibling);
  }
  if (!runtime) throw new Error('未找到实际 SceneRuntime。');
  const scene = runtime.scene, engine = scene.getEngine(), camera = scene.activeCamera;
  const monitor = monitors.find(candidate => candidate.scene === scene)
    ?? monitors.find(candidate => !candidate.scene && candidate.engine === engine);
  const canvas = engine.getRenderingCanvas();
  const pose = { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() };
  const specialized = diagnostic ? null
    : runtime.telemetry?.specializedTelemetryRuntime ?? runtime.specializedTelemetryRuntime;
  const originalApply = specialized?.applyFrame;
  if (!diagnostic && typeof originalApply !== 'function') throw new Error('未找到遥测动作帧入口。');
  const viewport = () => ({
    width: engine.getRenderWidth(true), height: engine.getRenderHeight(true),
    cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, dpr: window.devicePixelRatio,
    windowWidth: innerWidth, windowHeight: innerHeight, displayWidth: screen.width, displayHeight: screen.height,
    scale: engine.getHardwareScalingLevel(),
    frameRateLimit: Number.isFinite(engine.maxFPS) && engine.maxFPS > 0 ? engine.maxFPS : null,
  });
  const projectionFields = ['mode', 'fov', 'fovMode', 'minZ', 'maxZ', 'orthoLeft', 'orthoRight', 'orthoTop', 'orthoBottom'];
  const cameraState = () => ({ alpha: camera.alpha, beta: camera.beta, radius: camera.radius,
    x: camera.target.x, y: camera.target.y, z: camera.target.z,
    ...Object.fromEntries(projectionFields.map(key => [key, camera[key] ?? null])) });
  const glInfo = () => {
    const { vendor, renderer, version } = engine.getGlInfo();
    return { vendor, renderer, version, isWebGPU: engine.isWebGPU };
  };
  const frameWorkTiming = () => {
    const validTime = value => Number.isFinite(value) && value >= 0 ? value : null;
    // 新接口显式报告不可用；不得用旧计数覆盖 null 或把停用前的残留结果计为本轮 GPU 样本。
    if (typeof monitor?.getFrameWorkTiming === 'function') {
      const timing = monitor.getFrameWorkTiming();
      const gpuTimingStatus = typeof timing?.gpuTimingStatus === 'string' ? timing.gpuTimingStatus : null;
      const gpuFrameSamples = Number.isSafeInteger(timing?.gpuFrameSamples) && timing.gpuFrameSamples >= 0
        ? timing.gpuFrameSamples : null;
      return {
        cpuFrameMs: validTime(timing?.cpuFrameMs),
        gpuFrameMs: gpuTimingStatus === 'valid' && gpuFrameSamples > 0 ? validTime(timing.gpuFrameMs) : null,
        gpuTimingStatus, gpuFrameSamples,
      };
    }
    const counterMs = counter => counter?.count > 0
      ? validTime(counter.lastSecAverage > 0 ? counter.lastSecAverage : counter.current) : null;
    const instrumentation = monitor?.engineInstrumentation;
    const gpuCounter = instrumentation?.gpuFrameTimeCounter;
    const gpuSamples = instrumentation?.captureGPUFrameTime && gpuCounter?.count > (monitor.gpuCaptureStartCount ?? 0)
      ? gpuCounter.count - (monitor.gpuCaptureStartCount ?? 0) : 0;
    const gpuNs = gpuSamples > 0 ? counterMs(gpuCounter) : null;
    return { cpuFrameMs: counterMs(monitor?.sceneInstrumentation?.frameTimeCounter),
      gpuFrameMs: gpuNs > 0 ? gpuNs / 1e6 : null, gpuTimingStatus: gpuNs > 0 ? 'legacy-counter' : 'legacy-unavailable',
      gpuFrameSamples: gpuSamples };
  };
  const diagnosticSnapshot = () => {
    const { loading } = runtime.getPerformanceMetrics();
    const { frames, contextSignatureBuilds } = runtime.getTelemetryPerformanceMetrics();
    return { ...viewport(), camera: cameraState(), renderer: glInfo(), ...frameWorkTiming(),
      telemetryFrames: Number.isSafeInteger(frames) ? frames : null,
      motionContexts: Number.isSafeInteger(contextSignatureBuilds) ? contextSignatureBuilds : null,
      ready: loading.pendingModelCount === 0 && loading.failedModelAcquisitions === 0
        && ['ready', 'idle'].includes(loading.environmentPhase) && ['ready', 'idle'].includes(loading.skybox.phase) };
  };
  let actionsDisabled = false, recording = false, previous = null, nextSample = 0, samples = [], intervals = [];
  let violation = null, conditions = null, wallEnd = null, firstFrame = null;
  let longTasks = [], longTaskOverflow = false, captureStarted = 0;
  const invalidate = reason => { violation = reason; recording = false; };
  const onVisibilityChange = () => { if (recording && document.hidden) invalidate('采样窗口出现在后台'); };
  const onContextLost = () => { if (recording) invalidate('采样期间 WebGL 上下文丢失'); };
  if (diagnostic) {
    document.addEventListener('visibilitychange', onVisibilityChange);
    canvas.addEventListener('webglcontextlost', onContextLost);
  }
  const collectLongTasks = entries => {
    if (!recording) return;
    for (const entry of entries) {
      if (entry.startTime < captureStarted || (wallEnd !== null && entry.startTime >= wallEnd)) continue;
      if (longTasks.length < 10000) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      else longTaskOverflow = true;
    }
  };
  const longTaskObserver = globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')
    ? new PerformanceObserver(list => collectLongTasks(list.getEntries())) : null;
  longTaskObserver?.observe({ type: 'longtask' });
  if (!diagnostic) specialized.applyFrame = function (...args) { if (!actionsDisabled) return originalApply.apply(this, args); };
  const snapshot = () => {
    if (diagnostic) return diagnosticSnapshot();
    const metrics = runtime.getPerformanceMetrics();
    const counter = value => value ? (value.lastSecAverage > 0 ? value.lastSecAverage : value.current) : null;
    return { frame: scene.getFrameId(), fps: engine.getFps(), renderer: engine.getGlInfo(),
      ...frameWorkTiming(),
      activeMeshEvaluationMs: counter(monitor?.sceneInstrumentation?.activeMeshesEvaluationTimeCounter),
      jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
      drawCalls: engine._drawCalls?.current ?? null,
      width: engine.getRenderWidth(true), height: engine.getRenderHeight(true), dpr: window.devicePixelRatio,
      camera: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, mode: camera.mode,
        target: { x: camera.target.x, y: camera.target.y, z: camera.target.z } },
      meshes: scene.meshes.length, activeMeshes: scene.getActiveMeshes().length,
      activeAnimations: scene.animatables.length, skeletons: scene.skeletons.length,
      observers: { beforeRender: scene.onBeforeRenderObservable.observers.length,
        afterRender: scene.onAfterRenderObservable.observers.length, newMeshes: scene.onNewMeshAddedObservable.observers.length },
      pendingModels: metrics.loading.pendingModelCount, failedAcquisitions: metrics.loading.failedModelAcquisitions,
      environmentPhase: metrics.loading.environmentPhase, skyboxPhase: metrics.loading.skybox.phase,
      modelRuntimeCount: metrics.modelRuntimeCount, batchEntities: metrics.modelArrayBatchEntityCount,
      telemetry: runtime.getTelemetryPerformanceMetrics(), roam: roam?.getSnapshot(),
      cargoCounts: { stacker: specialized.state.stackerCargoMeshes.size,
        conveyor: specialized.state.conveyorCargoMeshes.size, rgv: specialized.state.rgvCargoMeshes.size },
      roamPosition: roam ? { x: roam.collider.position.x, y: roam.collider.position.y, z: roam.collider.position.z } : null,
      roamMetrics: roam?.localTriangleCollider?.getPerformanceMetrics?.() ?? null };
  };
  const addRenderObserver = () => scene.onAfterRenderObservable.add(() => {
    if (!recording) return;
    const now = performance.now();
    if (wallEnd !== null && (now < captureStarted || now >= wallEnd)) return;
    const width = engine.getRenderWidth(true), height = engine.getRenderHeight(true);
    if (width !== conditions.width || height !== conditions.height) {
      invalidate(`采样期间 Canvas 尺寸发生变化：${conditions.width}x${conditions.height} -> ${width}x${height}，本窗口无效`);
      return;
    }
    if (!conditions.movingCamera && (Math.abs(camera.alpha - conditions.alpha) > 1e-6
      || Math.abs(camera.beta - conditions.beta) > 1e-6 || Math.abs(camera.radius - conditions.radius) > 1e-6
      || !camera.target.equalsWithEpsilon(conditions.target, 1e-6))) {
      invalidate('采样期间固定相机发生变化，本窗口无效');
      return;
    }
    if (diagnostic && (scene.activeCamera !== camera || document.hidden || !canvas.isConnected
      || engine.getHardwareScalingLevel() !== conditions.scale || window.devicePixelRatio !== conditions.dpr
      || projectionFields.some(key => (camera[key] ?? null) !== conditions.camera[key]))) {
      invalidate('采样期间视口、硬件缩放或相机投影发生变化');
      return;
    }
    if (document.hidden) { previous = null; return; }
    firstFrame ??= now;
    if (diagnostic && intervals.length >= 200000) { invalidate('逐帧采样超出窗口预算'); return; }
    if (previous !== null && intervals.length < 200000) intervals.push(now - previous);
    previous = now;
    if (now >= nextSample) { samples.push(snapshot()); nextSample = now + 1000; }
  });
  const observer = diagnostic && typeof runtime.withControlledSceneObservers === 'function'
    ? runtime.withControlledSceneObservers(addRenderObserver) : addRenderObserver();
  window.__extremeCapture = {
    snapshot,
    inventory() {
      const entities = runtime.document?.syncedEntities ?? runtime.syncedEntities;
      const environment = runtime.environment?.environmentRuntime ?? runtime.environmentRuntime;
      return {
        models: [...entities.values()].filter(entity => entity.components.modelAsset)
          .map(entity => ({ id: entity.id, sourceUrl: entity.components.modelAsset.sourceUrl,
            revision: entity.components.modelAsset.assetRevision, parameters: entity.components.modelAsset.parameterValues })),
        environment: environment.getSnapshot().sourceUrl, skybox: runtime.getSkyboxReadiness().sourceUrl,
      };
    },
    resetCamera() { camera.setTarget(pose.target); camera.alpha = pose.alpha; camera.beta = pose.beta; camera.radius = pose.radius; },
    disableActions(disabled) { actionsDisabled = disabled; },
    getViolation: () => violation,
    setDiagnosticScale(level) {
      if (!diagnostic || recording || ![1, 2].includes(level)) throw new Error('仅允许在独立诊断窗口外切换缩放');
      engine.setHardwareScalingLevel(level);
    },
    start(timing = true, movingCamera = false, wallWindow = null) {
      previous = null; firstFrame = null; samples = []; intervals = []; nextSample = 0; violation = null;
      reactCommitsAtStart = window.__performanceReactProbe?.commits ?? null;
      longTasks = []; longTaskOverflow = false;
      captureStarted = wallWindow === null ? performance.now() : wallWindow.startEpochMs - performance.timeOrigin;
      wallEnd = wallWindow === null ? null : captureStarted + wallWindow.durationMs;
      if (diagnostic && (wallWindow === null || captureStarted <= performance.now() || document.hidden)) {
        throw new Error('未能在墙钟起点之前启用前台逐帧采集');
      }
      longTaskObserver?.takeRecords();
      conditions = { ...viewport(), movingCamera, ...(diagnostic ? { camera: cameraState() } : {}),
        alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() };
      recording = true;
      if (!diagnostic) runtime.setTelemetryPerformanceTimingEnabled(timing);
    },
    stop() {
      collectLongTasks(longTaskObserver?.takeRecords() ?? []);
      recording = false;
      if (!diagnostic) runtime.setTelemetryPerformanceTimingEnabled(false);
      const sorted = [...intervals].sort((a, b) => a - b), duration = intervals.reduce((a, b) => a + b, 0);
      const frameStats = {
        intervalCount: intervals.length, measuredDurationMs: duration,
        p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
        p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
        over50MsCount: intervals.filter(ms => ms > 50).length, intervalsMs: intervals,
        longTasks: longTaskObserver ? { entries: longTasks, count: longTasks.length,
          totalDurationMs: longTasks.reduce((sum, entry) => sum + entry.duration, 0), overflow: longTaskOverflow } : null,
        samples, last: snapshot(),
      };
      if (diagnostic) return { ...frameStats, violation, windowMs: wallEnd - captureStarted,
        elapsedMs: performance.now() - captureStarted, startEpochMs: captureStarted + performance.timeOrigin,
        firstFrameOffsetMs: firstFrame === null ? null : firstFrame - captureStarted,
        lastFrameOffsetMs: previous === null ? null : previous - captureStarted,
        frameCount: firstFrame === null ? 0 : intervals.length + 1 };
      return { ...frameStats, reactCommits: reactCommitsAtStart === null ? null : window.__performanceReactProbe.commits - reactCommitsAtStart,
        effectiveFps: duration ? intervals.length * 1000 / duration : null,
        cargo: ['stacker', 'conveyor', 'rgv'].flatMap(kind => (
          [...specialized.state[`${kind}CargoMeshes`].entries()].map(([key, cargo]) => ({
            kind, key, task: cargo.task, assetCode: cargo.assetCode, generatorEntityId: cargo.generatorEntityId,
            outputKind: cargo.outputOwner?.output?.kind ?? null, enabled: cargo.root.isEnabled(),
            position: { x: cargo.root.position.x, y: cargo.root.position.y, z: cargo.root.position.z },
          }))
        )) };
    },
    dispose() {
      recording = false; longTaskObserver?.disconnect(); scene.onAfterRenderObservable.remove(observer);
      if (diagnostic) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        canvas.removeEventListener('webglcontextlost', onContextLost);
      } else {
        specialized.applyFrame = originalApply;
        runtime.setTelemetryPerformanceTimingEnabled(false);
      }
      delete window.__extremeCapture;
    },
  };
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function waitForStableCanvas(page) {
  const deadline = Date.now() + 15000;
  let previous = '', stableSince = Date.now();
  while (Date.now() < deadline) {
    const size = await page.locator('canvas.scene-canvas').evaluate(canvas => `${canvas.width}:${canvas.height}`);
    if (size !== previous) { previous = size; stableSince = Date.now(); }
    if (Date.now() - stableSince >= 2000) return;
    await page.waitForTimeout(250);
  }
  throw new Error('画布布局持续变化，无法开始固定条件采样');
}
function redact(value) { return String(value).replace(/(?:https?|wss?|mqtts?):\/\/[^\s"'<>]+/gi, '<resource>').slice(0,6000); }
