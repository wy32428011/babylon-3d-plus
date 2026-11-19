import type {
  ProjectOpenSpan,
  ProjectOpenTraceSnapshot,
} from '../../../electron/shared/projectOpenTrace.ts';

const LONG_TASK_LIMIT = 10;
type Category = 'script' | 'classification' | 'asset-decode' | 'sync';
type CaptureStatus =
  'recording' | 'stopped' | 'unsupported' | 'observer-error' | 'clock-unavailable';
type LongTask = {
  startMs: number;
  endMs: number;
  durationMs: number;
  observedOpenCount: number;
};
export type ProjectOpenLongTaskCapture = {
  startMs: number | null;
  status: CaptureStatus;
  observedCount: number;
  longest: LongTask[];
};

/** 同一 renderer 共用观察器，由打开追踪表持有各自的样本。 */
export class ProjectOpenLongTaskObserver {
  private observer: PerformanceObserver | null = null;
  private readonly active = new Set<ProjectOpenLongTaskCapture>();
  private readonly now: () => number | null;

  constructor(now: () => number | null) {
    this.now = now;
  }

  start(startMs: number | null): ProjectOpenLongTaskCapture {
    const capture: ProjectOpenLongTaskCapture = {
      startMs,
      status: 'recording',
      observedCount: 0,
      longest: [],
    };
    if (startMs === null) {
      capture.status = 'clock-unavailable';
      return capture;
    }
    if (!this.observer) {
      try {
        if (
          typeof PerformanceObserver !== 'function' ||
          PerformanceObserver.supportedEntryTypes?.includes('longtask') === false
        ) {
          capture.status = 'unsupported';
          return capture;
        }
        const observer = new PerformanceObserver((list, source) => {
          if (source !== this.observer) return;
          try {
            this.record(list.getEntries());
          } catch {
            this.fail('observer-error');
          }
        });
        this.observer = observer;
        // entryTypes 兼容旧实现，且不请求打开前的缓冲记录。
        observer.observe({ entryTypes: ['longtask'] });
      } catch {
        this.disconnect();
        capture.status = 'observer-error';
        return capture;
      }
    }
    this.active.add(capture);
    return capture;
  }

  stop(capture: ProjectOpenLongTaskCapture): void {
    if (!this.observer || !this.active.has(capture)) return;
    try {
      this.record(this.observer.takeRecords());
    } catch {
      this.fail('observer-error');
    }
    if (this.active.delete(capture)) capture.status = 'stopped';
    if (this.active.size === 0) this.disconnect();
  }

  private record(entries: readonly PerformanceEntry[]): void {
    if (entries.length === 0) return;
    const now = this.now();
    if (now === null) {
      this.fail('clock-unavailable');
      return;
    }
    for (const entry of entries) {
      if (entry.entryType !== 'longtask') continue;
      const startMs = entry.startTime,
        durationMs = entry.duration,
        endMs = startMs + durationMs;
      if (
        !Number.isFinite(startMs) ||
        startMs < 0 ||
        startMs >= now ||
        !Number.isFinite(endMs) ||
        durationMs < 50
      )
        continue;
      const matching = [...this.active].filter(
        (capture) =>
          capture.startMs !== null && Math.max(startMs, capture.startMs) < Math.min(endMs, now),
      );
      const task = { startMs, endMs, durationMs, observedOpenCount: matching.length };
      for (const capture of matching) {
        capture.observedCount++;
        const longest = capture.longest;
        longest.push(task);
        longest.sort((a, b) => b.durationMs - a.durationMs || a.startMs - b.startMs);
        if (longest.length > LONG_TASK_LIMIT) longest.pop();
      }
    }
  }

  private fail(status: 'observer-error' | 'clock-unavailable'): void {
    for (const capture of this.active) capture.status = status;
    this.active.clear();
    this.disconnect();
  }

  private disconnect(): void {
    const observer = this.observer;
    this.observer = null;
    try {
      observer?.disconnect();
    } catch {
      /* 观察器失败时仍忽略该实例的回调。 */
    }
  }
}

const CATEGORY_BY_STAGE: Partial<Record<ProjectOpenSpan['stage'], Category>> = {
  scriptInitialize: 'script',
  scriptConstructor: 'script',
  scriptOnStart: 'script',
  modelScriptRefresh: 'script',
  lightingClassificationSources: 'classification',
  assetReadDecode: 'asset-decode',
  environmentReadDecode: 'asset-decode',
  resourceApply: 'sync',
};

type Overlap = Pick<ProjectOpenSpan, 'spanId' | 'phase' | 'stage' | 'ipcOperation'> & {
  category: Category | 'unknown';
  overlapMs: number;
};

function overlapHints(spans: ProjectOpenSpan[], startMs: number, endMs: number, cutoffMs: number) {
  const best = new Map<Overlap['category'], { hint: Overlap; spanDurationMs: number }>();
  for (const span of spans) {
    const spanEndMs = span.ended ? span.endMs : cutoffMs;
    if (span.startMs === null || spanEndMs === null) continue;
    const overlapMs = Math.min(endMs, spanEndMs) - Math.max(startMs, span.startMs);
    if (overlapMs <= 0) continue;
    const category =
      span.ipcOperation === 'sceneResources'
        ? 'sync'
        : (CATEGORY_BY_STAGE[span.stage] ?? 'unknown');
    const spanDurationMs = spanEndMs - span.startMs;
    const previous = best.get(category);
    if (
      previous &&
      (previous.hint.overlapMs > overlapMs ||
        (previous.hint.overlapMs === overlapMs && previous.spanDurationMs <= spanDurationMs))
    )
      continue;
    best.set(category, {
      spanDurationMs,
      hint: {
        category,
        overlapMs,
        spanId: span.spanId,
        stage: span.stage,
        phase: span.phase,
        ...(span.ipcOperation ? { ipcOperation: span.ipcOperation } : {}),
      },
    });
  }
  return [...best.values()].map(({ hint }) => hint);
}

/** Long Tasks API 的耗时与 span 仅按同域区间对齐。每个候选类别保留一条重叠证据。 */
export function readProjectOpenLongTasks(
  capture: ProjectOpenLongTaskCapture | undefined,
  trace: ProjectOpenTraceSnapshot,
) {
  if (!capture || trace.clockDomain !== 'renderer') return undefined;
  const startMs = capture.startMs;
  const endMs = trace.root.endMs;
  const sampledThroughMs = trace.root.ended ? endMs : trace.sampledAtMs;
  const entries = capture.longest.map((task) => {
    const overlapStart = startMs === null ? null : Math.max(startMs, task.startMs);
    const overlapEnd = sampledThroughMs === null ? null : Math.min(sampledThroughMs, task.endMs);
    const openOverlapMs =
      overlapStart === null || overlapEnd === null ? null : Math.max(0, overlapEnd - overlapStart);
    const overlaps =
      overlapStart !== null && overlapEnd !== null && sampledThroughMs !== null
        ? overlapHints(trace.spans, overlapStart, overlapEnd, sampledThroughMs)
        : [];
    const categories = overlaps.filter((hint) => hint.category !== 'unknown');
    const category =
      categories.length > 1 ? ('ambiguous' as const) : (categories[0]?.category ?? 'unknown');
    return { ...task, openOverlapMs, category, overlaps };
  });
  return {
    openId: trace.openId,
    clockDomain: 'renderer' as const,
    source: 'PerformanceObserver.longtask' as const,
    attribution: 'span-overlap' as const,
    status: capture.status,
    window: { startMs, endMs, sampledThroughMs },
    limit: LONG_TASK_LIMIT,
    observedCount: capture.observedCount,
    entries,
  };
}
