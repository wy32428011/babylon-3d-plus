export type FrameTimingReport = {
  source: 'completed-render-frame-intervals';
  intervalCount: number;
  recordedIntervals: number;
  capacityDroppedIntervals: number;
  historyWindowMs: number;
  maxIntervals: number;
  measuredDurationMs: number;
  effectiveFps: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maximumMs: number | null;
  over33MsCount: number;
  over50MsCount: number;
  intervalsMs: number[];
};

/** 固定容量保存真实渲染帧间隔；热路径不分配对象、不排序，复制报告时才求分位数。 */
export class FrameTimingWindow {
  private readonly ends: Float64Array;
  private readonly durations: Float64Array;
  private readonly historyWindowMs: number;
  private head = 0;
  private count = 0;
  private recorded = 0;
  private dropped = 0;
  private previous: number | null = null;

  constructor(options: { maxIntervals?: number; historyWindowMs?: number } = {}) {
    const capacity = options.maxIntervals ?? 16_384;
    const windowMs = options.historyWindowMs ?? 60_000;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65_536
      || !Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError('无效的逐帧采样窗口。');
    this.ends = new Float64Array(capacity);
    this.durations = new Float64Array(capacity);
    this.historyWindowMs = windowMs;
  }

  record(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      this.breakContinuity();
      return;
    }
    const previous = this.previous;
    this.previous = nowMs;
    if (previous === null || nowMs <= previous) return;
    // 保留在窗口内结束的完整间隔，包括跨越窗口边界的真实长帧。
    this.prune(nowMs);
    if (this.count === this.ends.length) {
      this.head = (this.head + 1) % this.ends.length;
      this.count -= 1;
      this.dropped += 1;
    }
    const index = (this.head + this.count) % this.ends.length;
    this.ends[index] = nowMs;
    this.durations[index] = nowMs - previous;
    this.count += 1;
    this.recorded += 1;
  }

  breakContinuity(): void {
    this.previous = null;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.recorded = 0;
    this.dropped = 0;
    this.previous = null;
  }

  createReport(nowMs?: number): FrameTimingReport {
    if (nowMs !== undefined && Number.isFinite(nowMs)) this.prune(nowMs);
    const intervalsMs = Array.from({ length: this.count }, (_, offset) => (
      this.durations[(this.head + offset) % this.ends.length]
    ));
    const sorted = [...intervalsMs].sort((a, b) => a - b);
    const measuredDurationMs = intervalsMs.reduce((total, interval) => total + interval, 0);
    const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
    return {
      source: 'completed-render-frame-intervals', intervalCount: this.count, recordedIntervals: this.recorded,
      capacityDroppedIntervals: this.dropped, historyWindowMs: this.historyWindowMs, maxIntervals: this.ends.length,
      measuredDurationMs, effectiveFps: measuredDurationMs > 0 ? this.count * 1000 / measuredDurationMs : null,
      p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maximumMs: sorted.at(-1) ?? null,
      over33MsCount: intervalsMs.filter(interval => interval > 1000 / 30).length,
      over50MsCount: intervalsMs.filter(interval => interval > 50).length,
      intervalsMs,
    };
  }

  private prune(nowMs: number): void {
    while (this.count > 0 && this.ends[this.head] < nowMs - this.historyWindowMs) {
      this.head = (this.head + 1) % this.ends.length;
      this.count -= 1;
    }
  }
}
