import type { ScenePerformanceSnapshot } from '../runtime/babylon/ScenePerformanceMonitor';

const SAMPLE_INTERVAL_MS = 1_000;
const HISTORY_WINDOW_MS = 60_000;
const MAX_SAMPLES = 60;

export type PlayerPerformanceSourceSnapshot = Pick<ScenePerformanceSnapshot,
  'sampledAt' | 'fps' | 'frameTimeMs' | 'renderTimeMs' | 'activeMeshesEvaluationMs'
  | 'gpuFrameTimeMs' | 'shaderCompilationMs' | 'drawCalls' | 'activeMeshes'
  | 'totalMeshes' | 'totalVertices' | 'thinInstances' | 'longTaskCount' | 'longTaskDurationMs'>;

export type PlayerPerformanceMonitor = {
  start(onSample: (snapshot: PlayerPerformanceSourceSnapshot) => void, intervalMs: number): void;
  dispose(): void;
};

export type PlayerTelemetryPerformanceMetrics = {
  frames: number;
  candidateRebuilds: number;
  contextSignatureBuilds: number;
  diagnosticWrites: number;
  lastFrameTimeMs: number | null;
  maxFrameTimeMs: number | null;
};

export type PlayerPerformanceSample = PlayerPerformanceSourceSnapshot & {
  telemetry: PlayerTelemetryPerformanceMetrics | null;
};

export type PlayerPerformanceSession = {
  createReport(): string;
  dispose(): void;
};

export function isPlayerPerformanceEnabled(search: string): boolean {
  return new URLSearchParams(search).get('performance') === '1';
}

/** 使用固定白名单，避免把运行配置、资源名称或业务数据带入可复制报告。 */
function selectPerformanceMetrics(sample: PlayerPerformanceSourceSnapshot): PlayerPerformanceSourceSnapshot {
  return {
    sampledAt: sample.sampledAt,
    fps: sample.fps,
    frameTimeMs: sample.frameTimeMs,
    renderTimeMs: sample.renderTimeMs,
    activeMeshesEvaluationMs: sample.activeMeshesEvaluationMs,
    gpuFrameTimeMs: sample.gpuFrameTimeMs,
    shaderCompilationMs: sample.shaderCompilationMs,
    drawCalls: sample.drawCalls,
    activeMeshes: sample.activeMeshes,
    totalMeshes: sample.totalMeshes,
    totalVertices: sample.totalVertices,
    thinInstances: sample.thinInstances,
    longTaskCount: sample.longTaskCount,
    longTaskDurationMs: sample.longTaskDurationMs,
  };
}

function selectTelemetryMetrics(metrics: PlayerTelemetryPerformanceMetrics | null): PlayerTelemetryPerformanceMetrics | null {
  if (!metrics) return null;
  return {
    frames: metrics.frames,
    candidateRebuilds: metrics.candidateRebuilds,
    contextSignatureBuilds: metrics.contextSignatureBuilds,
    diagnosticWrites: metrics.diagnosticWrites,
    lastFrameTimeMs: metrics.lastFrameTimeMs,
    maxFrameTimeMs: metrics.maxFrameTimeMs,
  };
}

function summarize(samples: PlayerPerformanceSourceSnapshot[]) {
  const frameTimes = samples.map((sample) => sample.frameTimeMs).sort((a, b) => a - b);
  const gpuTimes = samples.map((sample) => sample.gpuFrameTimeMs).filter((value): value is number => value !== null);
  return {
    sampleCount: samples.length,
    averageFps: samples.length > 0 ? samples.reduce((total, sample) => total + sample.fps, 0) / samples.length : null,
    minimumFps: samples.length > 0 ? Math.min(...samples.map((sample) => sample.fps)) : null,
    // Babylon 采样值是最近一秒计数器均值；不能把其分位数表述成逐帧 P95/P99。
    p95SampleFrameTimeMs: frameTimes[Math.ceil(frameTimes.length * 0.95) - 1] ?? null,
    p99SampleFrameTimeMs: frameTimes[Math.ceil(frameTimes.length * 0.99) - 1] ?? null,
    maximumGpuFrameTimeMs: gpuTimes.length > 0 ? Math.max(...gpuTimes) : null,
    maximumDrawCalls: samples.length > 0 ? Math.max(...samples.map((sample) => sample.drawCalls)) : null,
    maximumActiveMeshes: samples.length > 0 ? Math.max(...samples.map((sample) => sample.activeMeshes)) : null,
    longTaskCount: samples.reduce((total, sample) => total + sample.longTaskCount, 0),
    longTaskDurationMs: samples.reduce((total, sample) => total + sample.longTaskDurationMs, 0),
  };
}

/** 未启用时不创建监控；关闭与初始化失败时统一释放 Instrumentation 和其计时器。 */
export function startPlayerPerformanceSession(
  enabled: boolean,
  createMonitor: () => PlayerPerformanceMonitor,
  onSample: (snapshot: PlayerPerformanceSample) => void,
  now: () => number = Date.now,
  getTelemetryMetrics: () => PlayerTelemetryPerformanceMetrics | null = () => null,
): PlayerPerformanceSession | null {
  if (!enabled) return null;
  const monitor = createMonitor();
  const history: { at: number; sample: PlayerPerformanceSample }[] = [];
  let disposed = false;
  const pruneHistory = () => {
    const cutoff = now() - HISTORY_WINDOW_MS;
    while (history.length > 0 && (history[0].at < cutoff || history.length > MAX_SAMPLES)) history.shift();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    monitor.dispose();
    history.length = 0;
  };
  try {
    monitor.start((snapshot) => {
      if (disposed) return;
      const sample = { ...selectPerformanceMetrics(snapshot), telemetry: selectTelemetryMetrics(getTelemetryMetrics()) };
      history.push({ at: now(), sample });
      pruneHistory();
      onSample(sample);
    }, SAMPLE_INTERVAL_MS);
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    dispose,
    createReport: () => {
      pruneHistory();
      const samples = history.map((entry) => entry.sample);
      return JSON.stringify({
        version: 1,
        generatedAt: new Date(now()).toISOString(),
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        historyWindowMs: HISTORY_WINDOW_MS,
        counterSemantics: 'Babylon counters use the last-second mean; percentiles describe samples, not individual frames. GPU null means unavailable.',
        telemetrySemantics: 'Counters cover the runtime lifetime; lastFrameTimeMs times the last telemetry frame and maxFrameTimeMs covers this diagnostic session. Null timing means unavailable.',
        summary: summarize(samples),
        samples,
      }, null, 2);
    },
  };
}
