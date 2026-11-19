import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { installCapture } from '../../scripts/smoke-extreme-scene-performance.mjs';
import {
  assertOfflineResources,
  classifyBaab,
  parseBaabArgs,
  prepareRecordedMotion,
  summarizeCpuProfile,
} from '../../scripts/diagnose-extreme-scene-baab.mjs';

const fixtureHash = 'a'.repeat(64);
const topic = 'dt/factory/logistics/stacker/fixture/twindatadriven/joint';
const bindings = [{ deviceType: 'stacker', assetCode: 'fixture', sourceId: 'default' }];
const point = (atMs, value, name = 'distance_x') => ({
  atMs,
  topic,
  payloadText: JSON.stringify({ seq: atMs, data: [{ e: 'fixture', p: name, v: value }] }),
});
const coveringRecording = () => ({
  source: { sceneSha256: fixtureHash },
  summary: { sensitiveSkipped: 0, budgetSkipped: 0, replayCompatible: true },
  records: Array.from({ length: 66 }, (_, n) => point(n * 1000, n)),
});

const evidence = {
  unchanged: true,
  sourceSha256: fixtureHash,
  fixtureSha256: fixtureHash,
  buildSha256: fixtureHash,
  resourcesSha256: fixtureHash,
  recordingSha256: fixtureHash,
  replaySha256: fixtureHash,
  replayMessages: 64,
  replayBytes: 6400,
  maxDeviceGapMs: 1000,
};
const view = {
  ready: true,
  width: 1401,
  height: 801,
  cssWidth: 1401,
  cssHeight: 801,
  windowWidth: 1560,
  windowHeight: 900,
  displayWidth: 2560,
  displayHeight: 1440,
  dpr: 1,
  scale: 1,
  frameRateLimit: null,
  telemetryFrames: 100,
  motionContexts: 10,
  renderer: { isWebGPU: false, renderer: 'ANGLE (Intel UHD 630)', vendor: 'Intel', version: 'WebGL 2' },
  camera: { alpha: 1, beta: 1, radius: 8, x: 0, y: 0, z: 0, mode: 0, fov: 0.8, minZ: 0.1, maxZ: 100 },
  cpuFrameMs: 16,
  gpuFrameMs: null,
  gpuTimingStatus: 'unsupported',
  gpuFrameSamples: 0,
};

function makeWindows(frameCounts, { displayHz = 60, frameRateLimit = null } = {}) {
  return frameCounts.map((frameCount, i) => {
    const variant = ['B', 'A', 'A', 'B'][i];
    const scale = variant === 'B' ? 2 : 1;
    const baseline = { ...structuredClone(view), frameRateLimit };
    const sample = { ...structuredClone(baseline), width: Math.floor(view.width / scale),
      height: Math.floor(view.height / scale), scale };
    const intervalCount = frameCount - 1;
    const measuredDurationMs = 59_000;
    return {
      variant,
      index: i + 1,
      mode: 'motion',
      baseline,
      driver: { enabled: true, vendorId: 0x8086, deviceId: 0x3e92, driverVersion: '31.0.101.2130', displayHz },
      inventorySha256: fixtureHash,
      violation: null,
      elapsedMs: 60_100,
      startEpochMs: 100_000 + 64_000 * i,
      firstFrameOffsetMs: 500,
      lastFrameOffsetMs: 59_500,
      windowMs: 60_000,
      measuredDurationMs,
      intervalCount,
      frameCount,
      intervalsMs: Array.from({ length: intervalCount }, () => measuredDurationMs / intervalCount),
      replay: { clients: 1, failures: 0, ticks: 64, messages: 64, bytes: 6400 },
      samples: [sample],
      last: { ...structuredClone(sample), telemetryFrames: 100 + frameCount, motionContexts: 60 },
    };
  });
}

function makeCapture(timing, diagnostic = true) {
  let scale = 1, now = 0, render;
  const canvas = { clientWidth: 1401, clientHeight: 801, isConnected: true,
    addEventListener() {}, removeEventListener() {} };
  const engine = { getRenderingCanvas: () => canvas, getHardwareScalingLevel: () => scale,
    getRenderWidth: main => main ? Math.floor(canvas.clientWidth / scale) : 1024,
    getRenderHeight: main => main ? Math.floor(canvas.clientHeight / scale) : 1024, getGlInfo: () => view.renderer,
    setHardwareScalingLevel: value => { scale = value; }, isWebGPU: false };
  const camera = { ...view.camera, target: { x: 0, y: 0, z: 0, clone() { return this; },
    equalsWithEpsilon: other => other.x === 0 && other.y === 0 && other.z === 0 } };
  const scene = { activeCamera: camera, meshes: [], getEngine: () => engine,
    onAfterRenderObservable: { add(handler) { render = handler; }, remove() {} } };
  const originalApply = () => 'frame-applied';
  const specialized = { applyFrame: originalApply };
  const modelAsset = { sourceUrl: 'model.glb', assetRevision: 3, parameterValues: { length: 2 } };
  const runtime = {
    scene,
    telemetry: { specializedTelemetryRuntime: specialized },
    document: { syncedEntities: new Map([['model', { id: 'model', components: { modelAsset } }]]) },
    environment: { environmentRuntime: { getSnapshot: () => ({ sourceUrl: 'environment.glb' }) } },
    getSkyboxReadiness: () => ({ sourceUrl: 'skybox.env' }),
    getPerformanceMetrics: () => ({ loading: { pendingModelCount: 0, failedModelAcquisitions: 0,
      environmentPhase: 'ready', skybox: { phase: 'ready' } } }),
    getTelemetryPerformanceMetrics: () => ({ frames: 1, contextSignatureBuilds: 1 }),
    setTelemetryPerformanceTimingEnabled() {},
  };
  const monitor = { scene, sceneInstrumentation: { frameTimeCounter: { count: 5, current: 2.5 } },
    engineInstrumentation: { captureGPUFrameTime: true, gpuFrameTimeCounter: { count: 5, current: 1_250_000 } },
  };
  if (timing) monitor.getFrameWorkTiming = () => timing;
  const fiber = { memoizedProps: { runtime: { current: runtime }, monitor: { current: monitor } } };
  const window = { devicePixelRatio: 1 };
  const timeOrigin = 100_000;
  runInNewContext(`(${installCapture.toString()})(diagnostic)`, {
    diagnostic, window, performance: { now: () => now, timeOrigin }, innerWidth: 1440, innerHeight: 900,
    screen: { width: 2560, height: 1440 },
    document: { getElementById: () => ({ __reactContainer$fixture: fiber }),
      addEventListener() {}, removeEventListener() {} },
  });
  return { capture: window.__extremeCapture, monitor, window, timeOrigin, originalApply, specialized,
    frameAt(ms) { now = ms; render(); } };
}

test('诊断探针可读取拆分后的资源清单，遥测帧方法保持原样', () => {
  const { capture, specialized, originalApply } = makeCapture();
  const inventory = capture.inventory();
  assert.equal(inventory.models[0].id, 'model');
  assert.equal(inventory.models[0].sourceUrl, 'model.glb');
  assert.equal(inventory.models[0].revision, 3);
  assert.equal(inventory.models[0].parameters.length, 2);
  assert.equal(inventory.environment, 'environment.glb');
  assert.equal(inventory.skybox, 'skybox.env');
  capture.disableActions(true);
  assert.equal(specialized.applyFrame, originalApply);
  capture.dispose();
});

test('旧回放入口可暂停并恢复控制器的动作，释放时还原方法', () => {
  const { capture, specialized, originalApply } = makeCapture(undefined, false);
  assert.equal(specialized.applyFrame(), 'frame-applied');
  capture.disableActions(true);
  assert.equal(specialized.applyFrame(), undefined);
  capture.disableActions(false);
  assert.equal(specialized.applyFrame(), 'frame-applied');
  capture.dispose();
  assert.equal(specialized.applyFrame, originalApply);
});

test('诊断快照优先读公开 monitor：缺测不退回旧值，显式有效零和旧版计数均可读', () => {
  const modern = { cpuFrameMs: null, gpuFrameMs: null, gpuTimingStatus: 'unsupported', gpuFrameSamples: 0 };
  const { capture } = makeCapture(modern);
  assert.equal(capture.snapshot().cpuFrameMs, null);
  assert.equal(capture.snapshot().gpuFrameMs, null);
  assert.equal(capture.snapshot().gpuFrameSamples, 0);
  Object.assign(modern, { cpuFrameMs: 0, gpuFrameMs: 0, gpuTimingStatus: 'valid', gpuFrameSamples: 1 });
  assert.equal(capture.snapshot().cpuFrameMs, 0);
  assert.equal(capture.snapshot().gpuFrameMs, 0);
  const legacy = makeCapture();
  assert.equal(legacy.capture.snapshot().cpuFrameMs, 2.5);
  assert.equal(legacy.capture.snapshot().gpuFrameMs, 1.25);
  legacy.monitor.engineInstrumentation.captureGPUFrameTime = false;
  assert.equal(legacy.capture.snapshot().gpuFrameMs, null);
});

test('采样观察器只在约定墙钟窗口内计量，且核验中途 DPR 变化', () => {
  const { capture, frameAt, timeOrigin, window } = makeCapture();
  capture.setDiagnosticScale(2);
  assert.equal(capture.snapshot().width, 700);
  capture.start(true, false, { startEpochMs: timeOrigin + 1000, durationMs: 60_000 });
  for (const ms of [500, 1000, 2500, 60_999, 61_000, 61_001]) frameAt(ms);
  const report = capture.stop();
  assert.equal(report.frameCount, 3);
  assert.equal(report.measuredDurationMs, 59_999);
  assert.equal(report.lastFrameOffsetMs, 59_999);
  capture.start(true, false, { startEpochMs: timeOrigin + 62_000, durationMs: 60_000 });
  frameAt(62_000);
  window.devicePixelRatio = 2;
  frameAt(62_010);
  assert.match(capture.stop().violation, /硬件缩放或相机投影发生变化/);
});

test('诊断入口必须显式提供本地场景、工程和录制，不接受中台或短窗口开关', () => {
  const args = ['--baab', '--scene', 'fixture.scene.json', '--project-root', 'fixture',
    '--replay', 'recording.json', '--output', 'result'];
  assert.equal(parseBaabArgs([...args, '--fullscreen', '--profile']).profile, true);
  assert.throws(() => parseBaabArgs(args.slice(0, 5)));
  assert.throws(() => parseBaabArgs([...args, '--url', 'https://fixture.invalid']));
  assert.throws(() => parseBaabArgs([...args, '--seconds', '5']));
});

test('录制的固定 63 秒前缀包含预热和持续运动，只交出计数及可比较的哈希证据', () => {
  const recording = coveringRecording();
  const prepared = prepareRecordedMotion(recording, bindings, fixtureHash);
  assert.equal(prepared.messages, 64);
  assert.equal(prepared.maxDeviceGapMs, 1000);
  assert.equal(prepared.bytes, recording.records.slice(0, 64).reduce((sum, record) =>
    sum + Buffer.byteLength(record.payloadText), 0));
  assert.equal(prepared.sha256, prepareRecordedMotion(structuredClone(recording), bindings, fixtureHash).sha256);
  assert.throws(() => prepareRecordedMotion(recording, bindings, 'b'.repeat(64)));
  assert.throws(() => prepareRecordedMotion({ ...recording, summary: { sensitiveSkipped: 1 } }, bindings, fixtureHash));
});

test('尾部断流、只有故障值变化、未绑定设备和敏感 EPV 点位均不能作为运动输入', () => {
  const recording = coveringRecording();
  for (const records of [
    [...recording.records.slice(0, 6), recording.records.at(-1)],
    recording.records.map((record, n) => point(record.atMs, n, 'errorCode')),
    recording.records.map((record) => ({ ...record, topic: topic.replace('/fixture/', '/other/') })),
    recording.records.with(10, point(10_000, 'non-real-credential', 'api_key')),
  ]) {
    assert.throws(() => prepareRecordedMotion({ ...recording, records }, bindings, fixtureHash));
  }
});

test('完整 B-A-A-B 按真实 60 秒FPS 判定；两对均须同向过线，GPU 不可用仍是 null', () => {
  const windows = makeWindows([600, 300, 300, 600]);
  const result = classifyBaab(windows, evidence);
  assert.equal(result.conditionsMatched, true);
  assert.equal(result.classification, 'gpu-limited');
  assert.deepEqual(result.fps, { A: 5, B: 10, ratio: 2, pairedRatios: [2, 2], windows: [10, 5, 5, 10] });
  assert.equal(windows[0].last.gpuFrameMs, null);
  const oneBelow = classifyBaab(makeWindows([630, 300, 300, 594]), evidence);
  assert.ok(oneBelow.fps.ratio > 2);
  assert.equal(oneBelow.classification, 'undetermined');
  assert.equal(classifyBaab(makeWindows([750, 300, 300, 600]), evidence).reason, 'within-scale-drift');
});

test('CPU 判据的容差为 ±10%，接近显示或引擎帧率上限时保持未定', () => {
  assert.equal(classifyBaab(makeWindows([330, 300, 300, 330]), evidence).classification, 'cpu-limited');
  assert.equal(classifyBaab(makeWindows([270, 300, 300, 270]), evidence).classification, 'cpu-limited');
  assert.equal(classifyBaab(makeWindows([331, 300, 300, 331]), evidence).classification, 'undetermined');
  assert.equal(classifyBaab(makeWindows([330, 300, 300, 330], { frameRateLimit: 6 }), evidence).reason,
    'refresh-rate-unknown-or-near-cap');
  assert.equal(classifyBaab(makeWindows([3420, 3420, 3420, 3420]), evidence).reason,
    'refresh-rate-unknown-or-near-cap');
  assert.equal(classifyBaab(makeWindows([300, 300, 300, 300], { displayHz: null }), evidence).classification,
    'undetermined');
});

test('缺窗、时长不足、驱动/镜头/画布漂移、回放缺失或资源变化均不产出归因结论', () => {
  const variants = [
    (runs) => runs.pop(),
    (runs) => { runs[0].variant = 'A'; },
    (runs) => { runs[0].elapsedMs = 59_999; },
    (runs) => { runs[0].intervalsMs[0] = 100_000; },
    (runs) => { runs[0].samples[0].width += 1; },
    (runs) => { runs[0].inventorySha256 = 'b'.repeat(64); },
    (runs) => { runs[0].driver.driverVersion = '31.0.101.2131'; },
    (runs) => { runs[0].replay.messages -= 1; },
    (runs) => { runs[0].last.camera.x += 1; },
    (runs) => { runs[0].last.dpr += 0.1; },
    (runs) => { runs[0].last.motionContexts = runs[0].samples[0].motionContexts; },
    (runs) => { runs[1].startEpochMs -= 10_000; },
    (runs) => { runs[1].baseline.renderer.renderer = 'SwiftShader'; },
  ];
  for (const mutate of variants) {
    const windows = makeWindows([600, 300, 300, 600]);
    mutate(windows);
    const result = classifyBaab(windows, evidence);
    assert.equal(result.conditionsMatched, false);
    assert.equal(result.classification, 'undetermined');
    assert.equal(result.fps, null);
  }
  assert.equal(classifyBaab(makeWindows([600, 300, 300, 600]), { ...evidence, unchanged: false }).conditionsMatched, false);
});

test('离线资源检查拒绝离开临时工程的引用、协议大小写变体和相对回退', () => {
  const assets = path.resolve('fixture', 'Assets');
  const inside = path.join(assets, 'Models', 'fixture.glb');
  const outside = path.join(path.dirname(assets), 'outside.glb');
  assert.doesNotThrow(() => assertOfflineResources({
    sourcePath: inside,
    sourceUrl: `editor-asset://local/${encodeURIComponent(inside)}`,
  }, assets));
  assert.throws(() => assertOfflineResources({ sourceUrl: `EDITOR-ASSET://local/${encodeURIComponent(outside)}` }, assets));
  assert.throws(() => assertOfflineResources({ path: pathToFileURL(outside).href }, assets));
  assert.throws(() => assertOfflineResources({ scriptPaths: ['../outside.js'] }, assets));
});

test('CPU profile 按叶帧累计自耗时，输出不保留 URL、外部函数名或空闲时间', () => {
  const appRoot = path.resolve('profile-fixture');
  const appScript = pathToFileURL(path.join(appRoot, 'dist', 'assets', 'index.js')).href;
  const profile = { startTime: 0, endTime: 20_000_000, samples: [1, 2, 3, 1],
    timeDeltas: [1_000_000, 5_000_000, 11_000_000, 3_000_000], nodes: [
      { id: 1, callFrame: { url: appScript, functionName: 'domWork', lineNumber: 10, columnNumber: 20 } },
      { id: 2, callFrame: { url: 'https://fixture.invalid/local-secret', functionName: 'externalSecret', lineNumber: 1, columnNumber: 1 } },
      { id: 3, callFrame: { url: '', functionName: '(idle)', lineNumber: -1, columnNumber: -1 } },
    ] };
  const summary = summarizeCpuProfile(profile, appRoot);
  assert.equal(summary.durationMs, 20_000);
  assert.deepEqual(summary.bottomUpTop10.map(({ functionName, selfMs, selfPercent }) =>
    ({ functionName, selfMs, selfPercent })), [
    { functionName: null, selfMs: 5000, selfPercent: 25 },
    { functionName: 'domWork', selfMs: 4000, selfPercent: 20 },
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /fixture\.invalid|local-secret|externalSecret|file:/);
});
