import { Mesh, type Engine, type Scene } from '@babylonjs/core';
import { EngineInstrumentation } from '@babylonjs/core/Instrumentation/engineInstrumentation';
import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation';
import type { SceneRuntimePerformanceMetrics } from './SceneRuntime';

const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;
const MAX_HISTORY_SAMPLES = 60;
const GPU_NANOSECONDS_TO_MILLISECONDS = 0.000001;

export type EditModeThinInstancePlanPerformanceMetrics = {
  planCount: number;
  lastDurationMs: number;
  maxDurationMs: number;
  entityCount: number;
  groupCount: number;
  thinInstanceEntityCount: number;
};

export type ScenePerformanceSnapshot = {
  sampledAt: string;
  fps: number;
  frameTimeMs: number;
  renderTimeMs: number;
  activeMeshesEvaluationMs: number;
  gpuFrameTimeMs: number | null;
  shaderCompilationMs: number;
  drawCalls: number;
  activeMeshes: number;
  totalMeshes: number;
  totalVertices: number;
  thinInstances: number;
  longTaskCount: number;
  longTaskDurationMs: number;
  runtime: SceneRuntimePerformanceMetrics;
  editThinInstancePlan: EditModeThinInstancePlanPerformanceMetrics;
};

export type ScenePerformanceSummary = {
  sampleCount: number;
  averageFps: number;
  minimumFps: number;
  p95FrameTimeMs: number;
  maximumGpuFrameTimeMs: number | null;
  maximumDrawCalls: number;
  maximumActiveMeshes: number;
  longTaskCount: number;
  longTaskDurationMs: number;
};

type ScenePerformanceMonitorOptions = {
  getRuntimeMetrics: () => SceneRuntimePerformanceMetrics;
  getEditThinInstancePlanMetrics: () => EditModeThinInstancePlanPerformanceMetrics;
};

/** 将性能计数器的最近一秒均值转换为稳定 HUD 数值。 */
function readCounterValue(counter: { current: number; lastSecAverage: number }): number {
  const value = counter.lastSecAverage > 0 ? counter.lastSecAverage : counter.current;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 只在展示边界做有限数值归一化，保留内部原始采样精度。 */
function normalizeMetric(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 计算一段采样历史的稳定摘要，供复制报告和 smoke 复用。 */
export function summarizeScenePerformance(
  snapshots: readonly ScenePerformanceSnapshot[],
): ScenePerformanceSummary {
  if (snapshots.length === 0) {
    return {
      sampleCount: 0,
      averageFps: 0,
      minimumFps: 0,
      p95FrameTimeMs: 0,
      maximumGpuFrameTimeMs: null,
      maximumDrawCalls: 0,
      maximumActiveMeshes: 0,
      longTaskCount: 0,
      longTaskDurationMs: 0,
    };
  }

  const sortedFrameTimes = snapshots.map((snapshot) => snapshot.frameTimeMs).sort((left, right) => left - right);
  const p95Index = Math.min(sortedFrameTimes.length - 1, Math.ceil(sortedFrameTimes.length * 0.95) - 1);
  const gpuFrameTimes = snapshots
    .map((snapshot) => snapshot.gpuFrameTimeMs)
    .filter((value): value is number => value !== null);

  return {
    sampleCount: snapshots.length,
    averageFps: snapshots.reduce((total, snapshot) => total + snapshot.fps, 0) / snapshots.length,
    minimumFps: Math.min(...snapshots.map((snapshot) => snapshot.fps)),
    p95FrameTimeMs: sortedFrameTimes[p95Index] ?? 0,
    maximumGpuFrameTimeMs: gpuFrameTimes.length > 0 ? Math.max(...gpuFrameTimes) : null,
    maximumDrawCalls: Math.max(...snapshots.map((snapshot) => snapshot.drawCalls)),
    maximumActiveMeshes: Math.max(...snapshots.map((snapshot) => snapshot.activeMeshes)),
    longTaskCount: snapshots.reduce((total, snapshot) => total + snapshot.longTaskCount, 0),
    longTaskDurationMs: snapshots.reduce((total, snapshot) => total + snapshot.longTaskDurationMs, 0),
  };
}

/**
 * 低频采集 Babylon CPU/GPU 指标和浏览器 Long Task。
 * Instrumentation 每帧只写 Babylon 自带 PerfCounter，React 状态最多每秒更新一次。
 */
export class ScenePerformanceMonitor {
  private readonly sceneInstrumentation: SceneInstrumentation;
  private readonly engineInstrumentation: EngineInstrumentation;
  private readonly history: ScenePerformanceSnapshot[] = [];
  private readonly glInfo: { vendor: string; renderer: string; version: string };
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private longTaskObserver: PerformanceObserver | null = null;
  private pendingLongTaskCount = 0;
  private pendingLongTaskDurationMs = 0;
  private gpuFrameTimeCaptureEnabled = false;
  private disposed = false;

  constructor(
    private readonly engine: Engine,
    private readonly scene: Scene,
    private readonly options: ScenePerformanceMonitorOptions,
  ) {
    this.sceneInstrumentation = new SceneInstrumentation(scene);
    this.sceneInstrumentation.captureFrameTime = true;
    this.sceneInstrumentation.captureRenderTime = true;
    this.sceneInstrumentation.captureActiveMeshesEvaluationTime = true;

    this.engineInstrumentation = new EngineInstrumentation(engine);
    this.engineInstrumentation.captureShaderCompilationTime = true;
    try {
      this.engineInstrumentation.captureGPUFrameTime = true;
      this.gpuFrameTimeCaptureEnabled = this.engineInstrumentation.captureGPUFrameTime;
    } catch (error) {
      console.warn('Scene View GPU frame time 采集不可用，HUD 将继续显示 CPU 与场景指标。', error);
    }

    try {
      this.glInfo = engine.getGlInfo();
    } catch {
      this.glInfo = engine.getInfo();
    }
    this.observeLongTasks();
  }

  /** 启动低频采样；重复调用会替换旧订阅，不会叠加 interval。 */
  start(
    onSample: (snapshot: ScenePerformanceSnapshot) => void,
    intervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  ): void {
    if (this.disposed) return;
    if (this.sampleTimer) clearInterval(this.sampleTimer);

    const emitSample = (): void => {
      if (this.disposed) return;
      onSample(this.sample());
    };
    emitSample();
    this.sampleTimer = setInterval(emitSample, Math.max(250, intervalMs));
  }

  /** 返回最近一次实时快照并把它加入有界历史。 */
  sample(): ScenePerformanceSnapshot {
    const gpuFrameTimeNanoseconds = readCounterValue(this.engineInstrumentation.gpuFrameTimeCounter);
    const snapshot: ScenePerformanceSnapshot = {
      sampledAt: new Date().toISOString(),
      fps: normalizeMetric(this.engine.getFps()),
      frameTimeMs: readCounterValue(this.sceneInstrumentation.frameTimeCounter),
      renderTimeMs: readCounterValue(this.sceneInstrumentation.renderTimeCounter),
      activeMeshesEvaluationMs: readCounterValue(this.sceneInstrumentation.activeMeshesEvaluationTimeCounter),
      gpuFrameTimeMs: this.gpuFrameTimeCaptureEnabled && gpuFrameTimeNanoseconds > 0
        ? gpuFrameTimeNanoseconds * GPU_NANOSECONDS_TO_MILLISECONDS
        : null,
      shaderCompilationMs: readCounterValue(this.engineInstrumentation.shaderCompilationTimeCounter),
      drawCalls: Math.round(readCounterValue(this.sceneInstrumentation.drawCallsCounter)),
      activeMeshes: this.scene.getActiveMeshes().length,
      totalMeshes: this.scene.meshes.length,
      totalVertices: this.scene.getTotalVertices(),
      thinInstances: this.scene.meshes.reduce(
        (total, mesh) => total + (mesh instanceof Mesh ? Math.max(0, mesh.thinInstanceCount) : 0),
        0,
      ),
      longTaskCount: this.pendingLongTaskCount,
      longTaskDurationMs: this.pendingLongTaskDurationMs,
      runtime: this.options.getRuntimeMetrics(),
      editThinInstancePlan: this.options.getEditThinInstancePlanMetrics(),
    };

    this.pendingLongTaskCount = 0;
    this.pendingLongTaskDurationMs = 0;
    this.history.push(snapshot);
    if (this.history.length > MAX_HISTORY_SAMPLES) this.history.shift();
    return snapshot;
  }

  /** 生成包含 renderer、最近一分钟采样和摘要的 JSON 报告。 */
  createReport(): string {
    return JSON.stringify({
      generatedAt: new Date().toISOString(),
      renderer: this.glInfo,
      summary: summarizeScenePerformance(this.history),
      samples: this.history,
    }, null, 2);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    this.longTaskObserver?.disconnect();
    this.longTaskObserver = null;
    if (this.gpuFrameTimeCaptureEnabled) {
      try {
        this.engineInstrumentation.captureGPUFrameTime = false;
      } catch {
        // Engine 正在释放时只需继续清理 instrumentation observer。
      }
    }
    this.engineInstrumentation.dispose();
    this.sceneInstrumentation.dispose();
    this.history.length = 0;
  }

  /** PerformanceObserver 不可用时静默降级；Babylon 指标仍然完整采集。 */
  private observeLongTasks(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;

    this.longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.pendingLongTaskCount += 1;
        this.pendingLongTaskDurationMs += entry.duration;
      }
    });
    try {
      this.longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      this.longTaskObserver.disconnect();
      this.longTaskObserver = null;
    }
  }
}
