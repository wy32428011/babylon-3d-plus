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

/** 固定墙钟窗采用(start,end]完成帧计数；跨窗完整间隔只用于独立的尾延迟核对。 */
export type FrameTimingWallClockReport = {
  source: 'wall-clock-after-render-window';
  windowStartMs: number;
  windowEndMs: number | null;
  wallClockDurationMs: number | null;
  completedFrames: number | null;
  effectiveFps: number | null;
  measurementValid: boolean;
  invalidReasons: string[];
  headCensored: boolean;
  tailCensored: boolean;
  trailingStallLowerBoundMs: number | null;
  frameBeforeStartMs: number | null;
  frameAtOrAfterEndMs: number | null;
  capacityDroppedFrames: number;
  continuityBreaks: number;
  invalidTimestampCount: number;
  frameTimestampsMs: number[];
  intervalStartsMs: number[];
  intervalEndsMs: number[];
  intervalsMs: number[];
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maximumMs: number | null;
};

type WallClockCapture = {
  startMs: number;
  endMs: number | null;
  beforeStartMs: number | null;
  lastSeenMs: number | null;
  times: Float64Array;
  count: number;
  dropped: number;
  continuityBreaks: number;
  invalidTimestamps: number;
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
  private wallClockCapture: WallClockCapture | null = null;

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
      if (this.wallClockCapture && !this.isWallClockCaptureComplete(this.wallClockCapture)) {
        this.wallClockCapture.invalidTimestamps += 1;
      }
      this.breakContinuity();
      return;
    }
    this.recordWallClockFrame(nowMs);
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
    if (this.wallClockCapture && !this.isWallClockCaptureComplete(this.wallClockCapture)) {
      this.wallClockCapture.continuityBreaks += 1;
    }
    this.previous = null;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.recorded = 0;
    this.dropped = 0;
    this.previous = null;
    this.wallClockCapture = null;
  }

  /** 新建固定采样窗；此前须保持逐帧记录，以保留最近的起点前邻帧。不会改变旧滚动口径。 */
  beginWallClockWindow(startMs: number): void {
    if (!Number.isFinite(startMs) || (this.previous !== null && startMs < this.previous)) {
      throw new RangeError('墙钟窗起点无效或早于已记录帧，不能追认缺失的原始时间线。');
    }
    this.wallClockCapture = {
      startMs, endMs: null, beforeStartMs: this.previous, lastSeenMs: this.previous,
      // 额外一格用于闭窗后的相邻帧；起点前邻帧单独保存。
      times: new Float64Array(this.ends.length + 1), count: 0, dropped: 0,
      continuityBreaks: 0, invalidTimestamps: 0,
    };
  }

  /** 冻结截止时刻；观察器仍应保留到后邻帧补齐，不得通过移动截止点掩盖末端停顿。 */
  endWallClockWindow(endMs: number): void {
    const capture = this.wallClockCapture;
    if (!capture || !Number.isFinite(endMs) || endMs <= capture.startMs
      || (capture.endMs !== null && capture.endMs !== endMs)) {
      throw new RangeError('墙钟窗截止时刻无效或已冻结。');
    }
    capture.endMs = endMs;
  }

  createWallClockReport(): FrameTimingWallClockReport | null {
    const capture = this.wallClockCapture;
    if (!capture) return null;
    const end = capture.endMs;
    const recorded = Array.from(capture.times.subarray(0, capture.count));
    const frames = capture.beforeStartMs === null ? recorded : [capture.beforeStartMs, ...recorded];
    const closingIndex = end === null ? -1 : frames.findIndex(at => at >= end);
    const frameTimestampsMs = closingIndex >= 0 ? frames.slice(0, closingIndex + 1) : frames;
    const headCensored = capture.beforeStartMs === null;
    const tailCensored = end === null || closingIndex < 0;
    const reliable = capture.dropped === 0 && capture.invalidTimestamps === 0 && capture.continuityBreaks === 0;
    const completedFrames = end === null || !reliable ? null
      : recorded.filter(at => at > capture.startMs && at <= end).length;
    const wallClockDurationMs = end === null ? null : end - capture.startMs;
    const intervalStartsMs: number[] = [], intervalEndsMs: number[] = [], intervalsMs: number[] = [];
    if (end !== null) {
      for (let index = 1; index < frameTimestampsMs.length; index += 1) {
        const previous = frameTimestampsMs[index - 1], current = frameTimestampsMs[index];
        if (previous < end && current > capture.startMs && current >= previous) {
          intervalStartsMs.push(previous); intervalEndsMs.push(current); intervalsMs.push(current - previous);
        }
      }
    }
    const invalidReasons: string[] = [];
    if (end === null) invalidReasons.push('window-not-ended');
    if (completedFrames === 0) invalidReasons.push('no-completed-frames');
    if (headCensored) invalidReasons.push('missing-leading-neighbor');
    if (tailCensored) invalidReasons.push('missing-trailing-neighbor');
    if (capture.dropped > 0) invalidReasons.push('capacity-truncated');
    if (capture.continuityBreaks > 0) invalidReasons.push('continuity-broken');
    if (capture.invalidTimestamps > 0) invalidReasons.push('invalid-timestamp');
    const measurementValid = invalidReasons.length === 0;
    const sorted = [...intervalsMs].sort((a, b) => a - b);
    const percentile = (fraction: number) => measurementValid ? sorted[Math.ceil(sorted.length * fraction) - 1] ?? null : null;
    const lastInside = end === null ? undefined : [...frameTimestampsMs].reverse().find(at => at <= end);
    return {
      source: 'wall-clock-after-render-window', windowStartMs: capture.startMs, windowEndMs: end,
      wallClockDurationMs, completedFrames,
      effectiveFps: completedFrames !== null && wallClockDurationMs !== null ? completedFrames * 1000 / wallClockDurationMs : null,
      measurementValid, invalidReasons, headCensored, tailCensored,
      trailingStallLowerBoundMs: end !== null && reliable ? end - (lastInside ?? capture.startMs) : null,
      frameBeforeStartMs: capture.beforeStartMs,
      frameAtOrAfterEndMs: closingIndex < 0 ? null : frames[closingIndex],
      capacityDroppedFrames: capture.dropped, continuityBreaks: capture.continuityBreaks,
      invalidTimestampCount: capture.invalidTimestamps, frameTimestampsMs, intervalStartsMs, intervalEndsMs, intervalsMs,
      p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
      maximumMs: measurementValid ? sorted.at(-1) ?? null : null,
    };
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

  private isWallClockCaptureComplete(capture: WallClockCapture): boolean {
    return capture.endMs !== null && capture.lastSeenMs !== null && capture.lastSeenMs >= capture.endMs;
  }

  private recordWallClockFrame(nowMs: number): void {
    const capture = this.wallClockCapture;
    if (!capture || this.isWallClockCaptureComplete(capture)) return;
    if (capture.lastSeenMs !== null && nowMs <= capture.lastSeenMs) capture.invalidTimestamps += 1;
    capture.lastSeenMs = nowMs;
    if (nowMs <= capture.startMs) {
      capture.beforeStartMs = nowMs;
      return;
    }
    if (capture.count < capture.times.length) capture.times[capture.count++] = nowMs;
    else capture.dropped += 1;
  }
}
