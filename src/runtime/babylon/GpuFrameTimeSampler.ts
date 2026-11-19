import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { ThinEngine } from '@babylonjs/core/Engines/thinEngine.js';

const SAMPLE_INTERVAL_MS = 200;
const POLL_INTERVAL_MS = 50;
const QUERY_TIMEOUT_MS = 2_000;

export type GpuFrameTimingStatus =
  | 'disabled'
  | 'unsupported'
  | 'pending'
  | 'valid'
  | 'disjoint'
  | 'context-lost'
  | 'unavailable';

export type GpuFrameTiming = {
  gpuFrameMs: number | null;
  gpuTimingStatus: GpuFrameTimingStatus;
  /** 当前采样会话内成功解析的查询数；重复读取同一样本不会递增。 */
  gpuFrameSamples: number;
};

export type FrameWorkTiming = GpuFrameTiming & { cpuFrameMs: number | null };

export const FRAME_WORK_TIMING_SEMANTICS =
  'cpuFrameMs is the latest completed Babylon scene CPU time; ' +
  'gpuFrameMs (and the legacy alias gpuFrameTimeMs) is the latest valid sampled WebGL2 engine-frame timer query, not a mean. ' +
  'gpuFrameSamples counts completed valid queries since capture started or reset. ' +
  'Frame intervals are reported separately as frameTiming.';

const GPU_TIMING_STATUSES = new Set<GpuFrameTimingStatus>([
  'disabled', 'unsupported', 'pending', 'valid', 'disjoint', 'context-lost', 'unavailable',
]);

/** 仅复制计时白名单；旧样本可能没有新增字段。 */
export function copyFrameWorkTiming(timing: Partial<FrameWorkTiming>): FrameWorkTiming {
  const metric = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const { gpuTimingStatus, gpuFrameSamples = 0 } = timing;
  return {
    cpuFrameMs: metric(timing.cpuFrameMs),
    gpuFrameMs: metric(timing.gpuFrameMs),
    gpuTimingStatus: gpuTimingStatus && GPU_TIMING_STATUSES.has(gpuTimingStatus)
      ? gpuTimingStatus : 'unavailable',
    gpuFrameSamples: Number.isSafeInteger(gpuFrameSamples) && gpuFrameSamples >= 0 ? gpuFrameSamples : 0,
  };
}

type QueryTarget = { gl: WebGL2RenderingContext; elapsed: number; disjoint: number };
type FrameQuery = {
  handle: WebGLQuery;
  startedAt: number;
  completedFramesAtStart: number;
  ended: boolean;
};

/** 只观察现有 WebGL2 上下文；不接管 Babylon 计数器，也不与其它 elapsed query 嵌套。 */
export class GpuFrameTimeSampler {
  private unsubscribe: (() => void) | null = null;
  private target: QueryTarget | null = null;
  private query: FrameQuery | null = null;
  private nextSampleAt = 0;
  private nextPollAt = 0;
  private sampledAt = 0;
  private samples = 0;
  private value: number | null = null;
  private status: GpuFrameTimingStatus = 'disabled';

  constructor(
    private readonly engine: AbstractEngine,
    private readonly getCompletedFrames: () => number,
  ) {}

  setEnabled(enabled: boolean): void {
    if (enabled === Boolean(this.unsubscribe)) return;
    if (enabled) {
      const begin = this.engine.onBeginFrameObservable.add(() => this.beginFrame());
      const end = this.engine.onEndFrameObservable.add(() => this.endFrame());
      const lost = this.engine.onContextLostObservable.add(() => this.contextLost());
      const restored = this.engine.onContextRestoredObservable.add(() => this.reset());
      this.unsubscribe = () => {
        this.engine.onBeginFrameObservable.remove(begin);
        this.engine.onEndFrameObservable.remove(end);
        this.engine.onContextLostObservable.remove(lost);
        this.engine.onContextRestoredObservable.remove(restored);
      };
    } else {
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
    this.reset();
  }

  reset(): void {
    this.releaseQuery();
    this.target = null;
    this.nextSampleAt = 0;
    this.samples = 0;
    this.value = null;
    this.status = this.unsubscribe ? 'unsupported' : 'disabled';
    if (!this.unsubscribe || this.engine.isWebGPU) return;

    try {
      const engine = this.engine as AbstractEngine & Partial<Pick<ThinEngine, '_gl' | 'webGLVersion'>>;
      const { _gl: gl, webGLVersion } = engine;
      if (!gl || webGLVersion !== 2) return;
      if (gl.isContextLost()) {
        this.contextLost();
        return;
      }
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext) return;
      const counterBits: unknown = gl.getQuery(ext.TIME_ELAPSED_EXT, ext.QUERY_COUNTER_BITS_EXT);
      if (typeof counterBits !== 'number' || counterBits <= 0) return;
      this.target = { gl, elapsed: ext.TIME_ELAPSED_EXT, disjoint: ext.GPU_DISJOINT_EXT };
      this.status = 'pending';
    } catch {
      this.status = 'unavailable';
    }
  }

  read(): GpuFrameTiming {
    const stale = this.status === 'valid' && performance.now() - this.sampledAt > QUERY_TIMEOUT_MS;
    return {
      gpuFrameMs: stale ? null : this.value,
      gpuTimingStatus: stale ? 'unavailable' : this.status,
      gpuFrameSamples: this.samples,
    };
  }

  private beginFrame(): void {
    if (!this.target) return;
    const now = performance.now();
    if (!this.query && now < this.nextSampleAt) return;
    if (this.query?.ended && now < this.nextPollAt) return;
    const { gl, elapsed, disjoint } = this.target;
    try {
      if (gl.isContextLost()) {
        this.contextLost();
        return;
      }
      if (this.query) {
        // 未结束的上一引擎帧或始终未完成的查询不能跨帧占用计时目标。
        if (!this.query.ended || now - this.query.startedAt >= QUERY_TIMEOUT_MS) {
          this.invalidate('unavailable', now);
          return;
        }
        this.nextPollAt = now + POLL_INTERVAL_MS;
        if (gl.getParameter(disjoint)) {
          this.invalidate('disjoint', now);
          return;
        }
        if (!gl.getQueryParameter(this.query.handle, gl.QUERY_RESULT_AVAILABLE)) return;
        const ns: unknown = gl.getQueryParameter(this.query.handle, gl.QUERY_RESULT);
        this.releaseQuery();
        if (typeof ns !== 'number' || !Number.isFinite(ns) || ns < 0) {
          this.invalidate('unavailable', now);
          return;
        }
        this.value = ns / 1_000_000;
        this.sampledAt = now;
        this.status = 'valid';
        this.samples++;
      }
      if (now < this.nextSampleAt) return;
      this.nextSampleAt = now + SAMPLE_INTERVAL_MS;
      if (gl.getQuery(elapsed, gl.CURRENT_QUERY)) return;
      if (gl.getParameter(disjoint)) {
        this.invalidate('disjoint', now);
        return;
      }
      const handle = gl.createQuery();
      if (!handle) {
        this.invalidate('unavailable', now);
        return;
      }
      this.query = { handle, startedAt: now, completedFramesAtStart: this.getCompletedFrames(), ended: false };
      gl.beginQuery(elapsed, handle);
    } catch {
      this.invalidate('unavailable', now);
    }
  }

  private endFrame(): void {
    if (!this.target || !this.query || this.query.ended) return;
    const { gl, elapsed } = this.target;
    try {
      if (gl.isContextLost()) {
        this.contextLost();
        return;
      }
      if (gl.getQuery(elapsed, gl.CURRENT_QUERY) !== this.query.handle) {
        this.invalidate('unavailable', performance.now());
        return;
      }
      gl.endQuery(elapsed);
      this.query.ended = true;
      // 引擎帧可能只经过准备期节流、没有提交场景帧，不计入 GPU 样本。
      if (this.getCompletedFrames() <= this.query.completedFramesAtStart) this.releaseQuery();
      else this.nextPollAt = performance.now();
    } catch {
      this.invalidate('unavailable', performance.now());
    }
  }

  private contextLost(): void {
    // 上下文负责销毁旧查询；不能在恢复后触碰这些句柄。
    this.target = null;
    this.query = null;
    this.value = null;
    this.status = 'context-lost';
  }

  private invalidate(status: 'unavailable' | 'disjoint', now: number): void {
    this.releaseQuery();
    this.nextSampleAt = now + SAMPLE_INTERVAL_MS;
    this.value = null;
    this.status = status;
  }

  private releaseQuery(): void {
    const { query, target } = this;
    this.query = null;
    if (!query || !target) return;
    const { gl, elapsed } = target;
    try {
      if (gl.isContextLost()) return;
      try {
        if (!query.ended && gl.getQuery(elapsed, gl.CURRENT_QUERY) === query.handle) {
          gl.endQuery(elapsed);
        }
      } finally {
        gl.deleteQuery(query.handle);
      }
    } catch {
      // 驱动正在恢复或释放时，诊断不能阻止宿主清理。
    }
  }
}
