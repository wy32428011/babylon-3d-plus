import type { ScenePerformanceSnapshot } from '../../runtime/babylon/ScenePerformanceMonitor';

const SAMPLE_INTERVAL_MS = 1_000;
const HISTORY_WINDOW_MS = 60_000;
const MAX_SAMPLES = 60;
// Babylon 秒级计数器与 HUD 定时器不同步，等待两个完整窗口排除启动前均值。
const WARMUP_WINDOW_MS = 2_000;

export type EditorPerformanceSourceSnapshot = Pick<ScenePerformanceSnapshot,
  'sampledAt' | 'fps' | 'frameTimeMs' | 'renderTimeMs' | 'activeMeshesEvaluationMs'
  | 'gpuFrameTimeMs' | 'shaderCompilationMs' | 'drawCalls' | 'activeMeshes'
  | 'totalMeshes' | 'totalVertices' | 'thinInstances' | 'activeThinInstances'
  | 'estimatedActiveVertexInvocations' | 'estimatedActiveTriangleInvocations'
  | 'longTaskCount' | 'longTaskDurationMs'>;

export type EditorTelemetryPerformanceMetrics = {
  frames: number;
  candidateRebuilds: number;
  contextSignatureBuilds: number;
  diagnosticWrites: number;
  lastFrameTimeMs: number | null;
  maxFrameTimeMs: number | null;
};

type EditorPerformanceSample = EditorPerformanceSourceSnapshot & {
  telemetry: EditorTelemetryPerformanceMetrics;
};

export type EditorPerformanceRunSnapshot = {
  phase: 'warming' | 'running' | 'stopped';
  sampleCount: number;
  telemetry: EditorTelemetryPerformanceMetrics;
};

export type EditorPerformanceRunSession = {
  record(snapshot: EditorPerformanceSourceSnapshot, telemetry: EditorTelemetryPerformanceMetrics): void;
  stop(telemetry: EditorTelemetryPerformanceMetrics): void;
  getSnapshot(): EditorPerformanceRunSnapshot;
  createReport(): string;
};

function finiteMetric(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function nullableMetric(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 报告只选取数值指标，避免携带设备、资源名称和业务配置。 */
function selectSample(snapshot: EditorPerformanceSourceSnapshot, sampledAt: number): EditorPerformanceSourceSnapshot {
  return {
    sampledAt: new Date(sampledAt).toISOString(),
    fps: finiteMetric(snapshot.fps),
    frameTimeMs: finiteMetric(snapshot.frameTimeMs),
    renderTimeMs: finiteMetric(snapshot.renderTimeMs),
    activeMeshesEvaluationMs: finiteMetric(snapshot.activeMeshesEvaluationMs),
    gpuFrameTimeMs: nullableMetric(snapshot.gpuFrameTimeMs),
    shaderCompilationMs: finiteMetric(snapshot.shaderCompilationMs),
    drawCalls: finiteMetric(snapshot.drawCalls),
    activeMeshes: finiteMetric(snapshot.activeMeshes),
    totalMeshes: finiteMetric(snapshot.totalMeshes),
    totalVertices: finiteMetric(snapshot.totalVertices),
    thinInstances: finiteMetric(snapshot.thinInstances),
    activeThinInstances: finiteMetric(snapshot.activeThinInstances),
    estimatedActiveVertexInvocations: finiteMetric(snapshot.estimatedActiveVertexInvocations),
    estimatedActiveTriangleInvocations: finiteMetric(snapshot.estimatedActiveTriangleInvocations),
    longTaskCount: finiteMetric(snapshot.longTaskCount),
    longTaskDurationMs: finiteMetric(snapshot.longTaskDurationMs),
  };
}

function telemetryDelta(
  metrics: EditorTelemetryPerformanceMetrics,
  baseline: EditorTelemetryPerformanceMetrics,
): EditorTelemetryPerformanceMetrics {
  return {
    frames: finiteMetric(finiteMetric(metrics.frames) - baseline.frames),
    candidateRebuilds: finiteMetric(finiteMetric(metrics.candidateRebuilds) - baseline.candidateRebuilds),
    contextSignatureBuilds: finiteMetric(finiteMetric(metrics.contextSignatureBuilds) - baseline.contextSignatureBuilds),
    diagnosticWrites: finiteMetric(finiteMetric(metrics.diagnosticWrites) - baseline.diagnosticWrites),
    lastFrameTimeMs: nullableMetric(metrics.lastFrameTimeMs),
    maxFrameTimeMs: nullableMetric(metrics.maxFrameTimeMs),
  };
}

function summarize(samples: readonly EditorPerformanceSample[]) {
  const frameTimes = samples.map((sample) => sample.frameTimeMs).sort((a, b) => a - b);
  const gpuTimes = samples.map((sample) => sample.gpuFrameTimeMs).filter((value): value is number => value !== null);
  return {
    sampleCount: samples.length,
    averageFps: samples.length ? samples.reduce((sum, sample) => sum + sample.fps, 0) / samples.length : null,
    minimumFps: samples.length ? Math.min(...samples.map((sample) => sample.fps)) : null,
    p95SampleFrameTimeMs: frameTimes[Math.ceil(frameTimes.length * 0.95) - 1] ?? null,
    p99SampleFrameTimeMs: frameTimes[Math.ceil(frameTimes.length * 0.99) - 1] ?? null,
    maximumGpuFrameTimeMs: gpuTimes.length ? Math.max(...gpuTimes) : null,
    maximumDrawCalls: samples.length ? Math.max(...samples.map((sample) => sample.drawCalls)) : null,
    maximumActiveMeshes: samples.length ? Math.max(...samples.map((sample) => sample.activeMeshes)) : null,
    longTaskCount: samples.reduce((sum, sample) => sum + sample.longTaskCount, 0),
    longTaskDurationMs: samples.reduce((sum, sample) => sum + sample.longTaskDurationMs, 0),
  };
}

/** 只消费 Scene View 已有的 1 Hz 快照，不创建监控器或额外定时器。 */
export function createEditorPerformanceRunSession(
  initialTelemetry: EditorTelemetryPerformanceMetrics,
  now: () => number = Date.now,
): EditorPerformanceRunSession {
  const startedAt = now();
  const baseline = {
    frames: finiteMetric(initialTelemetry.frames),
    candidateRebuilds: finiteMetric(initialTelemetry.candidateRebuilds),
    contextSignatureBuilds: finiteMetric(initialTelemetry.contextSignatureBuilds),
    diagnosticWrites: finiteMetric(initialTelemetry.diagnosticWrites),
    lastFrameTimeMs: null,
    maxFrameTimeMs: null,
  };
  const history: { at: number; sample: EditorPerformanceSample }[] = [];
  let stoppedAt: number | null = null;
  let recordedSampleCount = 0;
  let telemetry = telemetryDelta(baseline, baseline);
  const prune = (at: number) => {
    while (history.length && (history[0].at < at - HISTORY_WINDOW_MS || history.length > MAX_SAMPLES)) history.shift();
  };

  return {
    record: (snapshot, metrics) => {
      if (stoppedAt !== null) return;
      const at = now();
      telemetry = telemetryDelta(metrics, baseline);
      const sampledAt = Date.parse(snapshot.sampledAt);
      if (!Number.isFinite(sampledAt) || sampledAt < startedAt + WARMUP_WINDOW_MS || at < startedAt + WARMUP_WINDOW_MS) return;
      history.push({ at, sample: { ...selectSample(snapshot, sampledAt), telemetry: { ...telemetry } } });
      recordedSampleCount += 1;
      prune(at);
    },
    stop: (metrics) => {
      if (stoppedAt !== null) return;
      stoppedAt = now();
      telemetry = telemetryDelta(metrics, baseline);
      prune(stoppedAt);
    },
    getSnapshot: () => ({
      phase: stoppedAt !== null ? 'stopped' : recordedSampleCount > 0 ? 'running' : 'warming',
      sampleCount: history.length,
      telemetry: { ...telemetry },
    }),
    createReport: () => {
      const generatedAt = now();
      // 停止后冻结最近一分钟，用户稍后复制时仍能拿到当次结果。
      if (stoppedAt === null) prune(generatedAt);
      const samples = history.map((entry) => entry.sample);
      return JSON.stringify({
        version: 1,
        mode: 'editor-performance-run',
        startedAt: new Date(startedAt).toISOString(),
        stoppedAt: stoppedAt === null ? null : new Date(stoppedAt).toISOString(),
        generatedAt: new Date(generatedAt).toISOString(),
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        warmupWindowMs: WARMUP_WINDOW_MS,
        historyWindowMs: HISTORY_WINDOW_MS,
        recordedSampleCount,
        counterSemantics: 'Babylon counters use the last-second mean; percentiles describe 1 Hz samples, not individual frames. The first two seconds are excluded. GPU null means unavailable.',
        telemetrySemantics: 'Counter deltas and telemetry timing cover this performance run, including warmup. Scene timing samples retain the latest minute of this run; a stopped report stays frozen.',
        telemetry,
        summary: summarize(samples),
        samples,
      }, null, 2);
    },
  };
}
