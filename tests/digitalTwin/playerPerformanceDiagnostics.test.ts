import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPlayerPerformanceEnabled,
  startPlayerPerformanceSession,
  type PlayerPerformanceMonitor,
  type PlayerPerformanceSourceSnapshot,
} from '../../src/player/playerPerformanceDiagnostics.ts';

function snapshot(fps = 60): PlayerPerformanceSourceSnapshot {
  return {
    sampledAt: '2026-09-08T00:00:00.000Z', fps, frameTimeMs: 6, renderTimeMs: 4,
    activeMeshesEvaluationMs: 1, gpuFrameTimeMs: null, shaderCompilationMs: 0,
    drawCalls: 12, activeMeshes: 8, totalMeshes: 16, totalVertices: 1000,
    thinInstances: 0, longTaskCount: 0, longTaskDurationMs: 0,
  };
}

function fixture() {
  let emit: (sample: PlayerPerformanceSourceSnapshot) => void = () => {};
  let interval = 0;
  let disposals = 0;
  const monitor: PlayerPerformanceMonitor = {
    start(callback, intervalMs) { emit = callback; interval = intervalMs; },
    dispose() { disposals += 1; },
  };
  return { monitor, emit: (sample = snapshot()) => emit(sample),
    get interval() { return interval; }, get disposals() { return disposals; } };
}

test('发布性能诊断只接受明确的 performance=1 开关', () => {
  for (const search of ['', '?performance', '?performance=0', '?performance=true', '?x=performance%3D1']) {
    assert.equal(isPlayerPerformanceEnabled(search), false);
  }
  assert.equal(isPlayerPerformanceEnabled('?performance=1'), true);
  assert.equal(isPlayerPerformanceEnabled('?scene=example&performance=1'), true);
});

test('默认关闭时完全不创建 Instrumentation 或采样任务', () => {
  const result = startPlayerPerformanceSession(false, () => { throw new Error('must not create'); }, () => {});
  assert.equal(result, null);
});

test('诊断按一秒采样，报告仅保留性能白名单且 GPU 不可用保持 null', () => {
  const source = fixture();
  let updates = 0;
  const session = startPlayerPerformanceSession(true, () => source.monitor, () => { updates += 1; }, () => 0)!;
  source.emit(Object.assign(snapshot(), { mqtt: { password: 'secret' }, topActiveGpuWorkloads: [{ meshName: 'private' }] }));
  const report = JSON.parse(session.createReport());
  assert.equal(source.interval, 1000);
  assert.equal(updates, 1);
  assert.equal(report.samples[0].gpuFrameTimeMs, null);
  assert.equal(report.summary.maximumGpuFrameTimeMs, null);
  assert.equal(report.summary.averageFps, 60);
  assert.equal(report.summary.p95SampleFrameTimeMs, 6);
  assert.equal(session.createReport().includes('secret'), false);
  assert.equal(session.createReport().includes('private'), false);
  session.dispose();
});

test('历史最多保留 60 个样本，复制时也按最近一分钟清理过期数据', () => {
  const source = fixture();
  let now = 0;
  const session = startPlayerPerformanceSession(true, () => source.monitor, () => {}, () => now)!;
  for (let index = 0; index < 80; index += 1) {
    now = index * 1000;
    source.emit(snapshot(index));
  }
  const report = JSON.parse(session.createReport());
  assert.equal(report.samples.length, 60);
  assert.equal(report.samples[0].fps, 20);
  assert.equal(report.summary.minimumFps, 20);
  now += 61_000;
  const expiredReport = JSON.parse(session.createReport());
  assert.equal(expiredReport.samples.length, 0);
  assert.equal(expiredReport.summary.sampleCount, 0);
  assert.equal(expiredReport.summary.averageFps, null);
  session.dispose();
});

test('释放幂等且晚到的采样不再刷新 UI，启动失败同样释放监控', () => {
  const source = fixture();
  let updates = 0;
  const session = startPlayerPerformanceSession(true, () => source.monitor, () => { updates += 1; })!;
  session.dispose();
  session.dispose();
  source.emit();
  assert.equal(source.disposals, 1);
  assert.equal(updates, 0);
  let disposed = false;
  assert.throws(() => startPlayerPerformanceSession(true, () => ({
    start() { throw new Error('sample failed'); }, dispose() { disposed = true; },
  }), () => {}), /sample failed/);
  assert.equal(disposed, true);
});

test('遥测报告复制计数和耗时快照，说明累计范围且不携带业务字段', () => {
  const source = fixture();
  const metrics = { frames: 100, candidateRebuilds: 1, contextSignatureBuilds: 4,
    diagnosticWrites: 3, lastFrameTimeMs: 0.25, maxFrameTimeMs: 1.5, password: 'hidden' };
  const session = startPlayerPerformanceSession(true, () => source.monitor, () => {}, () => 0, () => metrics)!;
  source.emit();
  metrics.frames = 200;
  const report = JSON.parse(session.createReport());
  assert.equal(report.samples[0].telemetry.frames, 100);
  assert.equal(report.samples[0].telemetry.lastFrameTimeMs, 0.25);
  assert.equal(report.samples[0].telemetry.maxFrameTimeMs, 1.5);
  assert.equal(session.createReport().includes('hidden'), false);
  assert.match(report.telemetrySemantics, /runtime lifetime/);
  session.dispose();
});
