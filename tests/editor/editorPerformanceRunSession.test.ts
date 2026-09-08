import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEditorPerformanceRunSession,
  type EditorPerformanceSourceSnapshot,
  type EditorTelemetryPerformanceMetrics,
} from '../../src/editor/runtime/editorPerformanceRunSession.ts';

function telemetry(frames = 100): EditorTelemetryPerformanceMetrics {
  return {
    frames, candidateRebuilds: 10, contextSignatureBuilds: 20, diagnosticWrites: 30,
    lastFrameTimeMs: 0.5, maxFrameTimeMs: 2,
  };
}

function sample(at: number, fps = 60): EditorPerformanceSourceSnapshot {
  return {
    sampledAt: new Date(at).toISOString(), fps, frameTimeMs: 8, renderTimeMs: 5,
    activeMeshesEvaluationMs: 1, gpuFrameTimeMs: null, shaderCompilationMs: 0,
    drawCalls: 30, activeMeshes: 15, totalMeshes: 20, totalVertices: 1000,
    thinInstances: 0, activeThinInstances: 0, estimatedActiveVertexInvocations: 1000,
    estimatedActiveTriangleInvocations: 300, longTaskCount: 0, longTaskDurationMs: 0,
  };
}

test('性能运行仅消费启动后的完整采样窗口，不混入编辑和启动前样本', () => {
  let now = 10_000;
  const session = createEditorPerformanceRunSession(telemetry(), () => now);
  session.record(sample(9_000, 1), telemetry(101));
  now = 10_500;
  session.record(sample(now, 2), telemetry(102));
  now = 11_500;
  session.record(sample(now, 3), telemetry(103));
  assert.equal(session.getSnapshot().phase, 'warming');
  assert.equal(session.getSnapshot().sampleCount, 0);
  now = 12_500;
  session.record(sample(now, 60), telemetry(160));
  const report = JSON.parse(session.createReport());
  assert.deepEqual(report.samples.map((entry: { fps: number }) => entry.fps), [60]);
  assert.equal(report.summary.averageFps, 60);
  assert.equal(session.getSnapshot().phase, 'running');
});

test('遥测使用本次运行增量，复制快照且报告不含业务字段', () => {
  let now = 0;
  const baseline = telemetry();
  const session = createEditorPerformanceRunSession(baseline, () => now);
  baseline.frames = 999;
  now = 2_000;
  const metrics = { ...telemetry(130), candidateRebuilds: 12, contextSignatureBuilds: 25, diagnosticWrites: 37, password: 'hidden' };
  session.record(Object.assign(sample(now), { mqtt: { password: 'secret' }, meshName: 'private' }), metrics);
  metrics.frames = 999;
  const report = JSON.parse(session.createReport());
  assert.deepEqual(report.samples[0].telemetry, {
    frames: 30, candidateRebuilds: 2, contextSignatureBuilds: 5, diagnosticWrites: 7,
    lastFrameTimeMs: 0.5, maxFrameTimeMs: 2,
  });
  assert.equal(/hidden|secret|private/.test(session.createReport()), false);
  assert.match(report.counterSemantics, /not individual frames/);
  assert.match(report.telemetrySemantics, /this performance run/);
});

test('停止后报告冻结保留，晚到采样和普通运行数据不会污染，下次运行独立重置', () => {
  let now = 0;
  const first = createEditorPerformanceRunSession(telemetry(), () => now);
  now = 2_000;
  first.record(sample(now, 55), telemetry(110));
  now = 2_100;
  first.stop(telemetry(115));
  now = 100_000;
  first.record(sample(now, 1), telemetry(900));
  first.stop(telemetry(1000));
  const frozen = JSON.parse(first.createReport());
  assert.equal(frozen.samples.length, 1);
  assert.equal(frozen.stoppedAt, new Date(2_100).toISOString());
  assert.equal(frozen.telemetry.frames, 15);
  assert.equal(first.getSnapshot().phase, 'stopped');
  const second = createEditorPerformanceRunSession(telemetry(900), () => now);
  assert.equal(second.getSnapshot().sampleCount, 0);
  now += 2_000;
  second.record(sample(now, 60), telemetry(910));
  assert.equal(JSON.parse(second.createReport()).telemetry.frames, 10);
  assert.equal(JSON.parse(first.createReport()).summary.averageFps, 55);
});

test('采样历史有界且仅保留运行中最近一分钟，停止后不会因稍后复制而过期', () => {
  let now = 0;
  const session = createEditorPerformanceRunSession(telemetry(), () => now);
  for (let index = 1; index <= 80; index += 1) {
    now = index * 1_000;
    session.record(sample(now, index), telemetry(100 + index));
  }
  let report = JSON.parse(session.createReport());
  assert.equal(report.samples.length, 60);
  assert.equal(report.samples[0].fps, 21);
  assert.equal(report.recordedSampleCount, 79);
  now += 61_000;
  report = JSON.parse(session.createReport());
  assert.equal(report.samples.length, 0);
  assert.equal(report.summary.averageFps, null);
  session.record(sample(now, 60), telemetry(200));
  session.stop(telemetry(200));
  now += 600_000;
  assert.equal(JSON.parse(session.createReport()).samples.length, 1);
});

test('无效和负数指标归零，GPU 不可用保留 null，遥测计数不会产生负增量', () => {
  let now = 0;
  const session = createEditorPerformanceRunSession(telemetry(), () => now);
  now = 2_000;
  session.record({ ...sample(now), fps: Number.NaN, frameTimeMs: Infinity, drawCalls: -1, gpuFrameTimeMs: Number.NaN }, {
    ...telemetry(1), candidateRebuilds: -1, contextSignatureBuilds: Infinity,
    diagnosticWrites: Number.NaN, lastFrameTimeMs: Number.NaN, maxFrameTimeMs: null,
  });
  const report = JSON.parse(session.createReport());
  assert.equal(report.samples[0].fps, 0);
  assert.equal(report.samples[0].frameTimeMs, 0);
  assert.equal(report.samples[0].drawCalls, 0);
  assert.equal(report.samples[0].gpuFrameTimeMs, null);
  assert.equal(report.summary.maximumGpuFrameTimeMs, null);
  assert.equal(report.telemetry.frames, 0);
  assert.equal(report.telemetry.contextSignatureBuilds, 0);
  assert.equal(report.telemetry.lastFrameTimeMs, null);
});

test('报告区分秒级样本分位数与逐帧统计，提前停止有明确空样本结果', () => {
  let now = 0;
  const session = createEditorPerformanceRunSession(telemetry(), () => now);
  now = 500;
  session.stop(telemetry(105));
  const report = JSON.parse(session.createReport());
  assert.equal(report.sampleIntervalMs, 1_000);
  assert.equal(report.warmupWindowMs, 2_000);
  assert.equal(report.summary.sampleCount, 0);
  assert.equal(report.summary.p95SampleFrameTimeMs, null);
  assert.equal(report.telemetry.frames, 5);
});
