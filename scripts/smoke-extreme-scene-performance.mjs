import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { _electron } from 'playwright';
import { createPerformanceMqttReplay } from './lib/performanceMqttReplay.mjs';

const { values } = parseArgs({ options: {
  scene: { type: 'string' }, workspace: { type: 'string' }, output: { type: 'string' },
  url: { type: 'string' },
  'app-root': { type: 'string' }, replay: { type: 'string' }, 'no-timing': { type: 'boolean', default: false },
  fullscreen: { type: 'boolean', default: false },
  seconds: { type: 'string', default: '60' }, repeats: { type: 'string', default: '3' },
  'soak-cycles': { type: 'string', default: '0' },
  modes: { type: 'string', default: 'edit,static,input-only,motion,roam-still,roam-walk' },
  profile: { type: 'boolean', default: false }, timeout: { type: 'string', default: '600000' },
} });
assert.ok(values.scene && values.workspace && values.output,
  '用法：node scripts/smoke-extreme-scene-performance.mjs --scene <scene.json> --workspace <资源工作区> --output <报告目录>');
const seconds = Number(values.seconds), repeats = Number(values.repeats), timeout = Number(values.timeout);
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
report.lifecycleSoak = soakCycles > 0;
report.fullscreen4k = values.fullscreen;
let app, page, broker;
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
  app = await _electron.launch({ args: [appRoot, `--user-data-dir=${userData}`], cwd: appRoot,
    env: { ...process.env, OPEN_DEVTOOLS: 'false', VITE_DEV_SERVER_URL: '' }, timeout: 120000 });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, fullscreen) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (fullscreen) window.setFullScreen(true);
    else {
      window.setSize(1440, 900);
      window.setResizable(false);
      window.setMaximizable(false);
      window.setMovable(false);
    }
  }, values.fullscreen);
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.errors.push(redact(error.message)));
  page.on('dialog', dialog => dialog.accept()); // 仅本脚本创建的场景副本，无用户编辑。
  await page.bringToFront();
  if (values.fullscreen) await page.waitForFunction(() => Math.round(innerWidth * devicePixelRatio) === 3840
    && Math.round(innerHeight * devicePixelRatio) === 2160, null, { timeout: 15000 });
  await page.locator('.home-recent-card').filter({ hasText: path.basename(fixture) })
    .getByRole('button', { name: '打开', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('canvas.scene-canvas')
    && !document.querySelector('[data-scene-preparation-phase]'), null, { timeout });
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
      let profiler;
      if (values.profile) {
        profiler = await page.context().newCDPSession(page);
        await profiler.send('Profiler.enable');
        await profiler.send('Profiler.start');
      }
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

/** 探针只读现有运行时；动作隔离只在此测试实例中包装帧入口，退出时恢复原方法。 */
function installCapture() {
  const element = document.getElementById('root');
  const key = Object.keys(element ?? {}).find(key => key.startsWith('__reactContainer$'));
  const first = element?.[key];
  const stack = first ? [first.stateNode?.current ?? first] : [];
  const seen = new Set();
  let runtime, roam, monitor;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    const current = value.current ?? value;
    if (current.scene?.meshes && !current.scene.isDisposed && typeof current.getPerformanceMetrics === 'function'
      && typeof current.getTelemetryPerformanceMetrics === 'function') runtime = current;
    if (current.options?.scene && typeof current.setVirtualMovement === 'function' && typeof current.getSnapshot === 'function') roam = current;
    if (current.engineInstrumentation && current.sceneInstrumentation && !current.disposed) monitor = current;
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
  const pose = { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() };
  const specialized = runtime.specializedTelemetryRuntime;
  const originalApply = specialized.applyFrame;
  let actionsDisabled = false, recording = false, previous = null, nextSample = 0, samples = [], intervals = [];
  let violation = null, conditions = null;
  specialized.applyFrame = function (...args) { if (!actionsDisabled) return originalApply.apply(this, args); };
  const snapshot = () => {
    const metrics = runtime.getPerformanceMetrics();
    const counter = value => value ? (value.lastSecAverage > 0 ? value.lastSecAverage : value.current) : null;
    const gpuNs = counter(monitor?.engineInstrumentation.gpuFrameTimeCounter);
    return { frame: scene.getFrameId(), fps: engine.getFps(), renderer: engine.getGlInfo(),
      cpuFrameMs: counter(monitor?.sceneInstrumentation.frameTimeCounter),
      activeMeshEvaluationMs: counter(monitor?.sceneInstrumentation.activeMeshesEvaluationTimeCounter),
      gpuFrameMs: gpuNs > 0 ? gpuNs / 1e6 : null,
      jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
      width: engine.getRenderWidth(), height: engine.getRenderHeight(), dpr: window.devicePixelRatio,
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
  const observer = scene.onAfterRenderObservable.add(() => {
    if (!recording) return;
    if (engine.getRenderWidth() !== conditions.width || engine.getRenderHeight() !== conditions.height) {
      violation = `采样期间 Canvas 尺寸发生变化：${conditions.width}x${conditions.height} -> ${engine.getRenderWidth()}x${engine.getRenderHeight()}，本窗口无效`; recording = false; return;
    }
    if (!conditions.movingCamera && (Math.abs(camera.alpha - conditions.alpha) > 1e-6
      || Math.abs(camera.beta - conditions.beta) > 1e-6 || Math.abs(camera.radius - conditions.radius) > 1e-6
      || !camera.target.equalsWithEpsilon(conditions.target, 1e-6))) {
      violation = '采样期间固定相机发生变化，本窗口无效'; recording = false; return;
    }
    const now = performance.now();
    if (document.hidden) { previous = null; return; }
    if (previous !== null && intervals.length < 200000) intervals.push(now - previous);
    previous = now;
    if (now >= nextSample) { samples.push(snapshot()); nextSample = now + 1000; }
  });
  window.__extremeCapture = {
    snapshot,
    inventory: () => ({ models: [...runtime.syncedEntities.values()].filter(entity => entity.components.modelAsset)
      .map(entity => ({ id: entity.id, sourceUrl: entity.components.modelAsset.sourceUrl,
        revision: entity.components.modelAsset.assetRevision, parameters: entity.components.modelAsset.parameterValues })),
      environment: runtime.environmentRuntime.getSnapshot().sourceUrl, skybox: runtime.getSkyboxReadiness().sourceUrl }),
    resetCamera() { camera.setTarget(pose.target); camera.alpha = pose.alpha; camera.beta = pose.beta; camera.radius = pose.radius; },
    disableActions(disabled) { actionsDisabled = disabled; },
    getViolation: () => violation,
    start(timing = true, movingCamera = false) {
      previous = null; samples = []; intervals = []; nextSample = 0; violation = null;
      conditions = { width: engine.getRenderWidth(), height: engine.getRenderHeight(), movingCamera,
        alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() };
      recording = true; runtime.setTelemetryPerformanceTimingEnabled(timing);
    },
    stop() {
      recording = false; runtime.setTelemetryPerformanceTimingEnabled(false);
      const sorted = [...intervals].sort((a, b) => a - b), duration = intervals.reduce((a, b) => a + b, 0);
      return { intervalCount: intervals.length, measuredDurationMs: duration,
        effectiveFps: duration ? intervals.length * 1000 / duration : null,
        p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
        p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
        over50MsCount: intervals.filter(ms => ms > 50).length, intervalsMs: intervals,
        samples, last: snapshot(), cargo: ['stacker', 'conveyor', 'rgv'].flatMap(kind => (
          [...specialized.state[`${kind}CargoMeshes`].entries()].map(([key, cargo]) => ({
            kind, key, task: cargo.task, assetCode: cargo.assetCode, generatorEntityId: cargo.generatorEntityId,
            outputKind: cargo.outputOwner?.output?.kind ?? null, enabled: cargo.root.isEnabled(),
            position: { x: cargo.root.position.x, y: cargo.root.position.y, z: cargo.root.position.z },
          }))
        )) };
    },
    dispose() { recording = false; scene.onAfterRenderObservable.remove(observer); specialized.applyFrame = originalApply;
      runtime.setTelemetryPerformanceTimingEnabled(false); delete window.__extremeCapture; },
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
