import { PROJECT_OPEN_TRACE_LIMIT, ProjectOpenTraceRecorder, readProjectOpenTraceContext,
  type ProjectOpenTraceSnapshot } from '../shared/projectOpenTrace.ts';

type Entry = { owner: number; recorder: ProjectOpenTraceRecorder };
const ownerValid = (owner: number) => Number.isSafeInteger(owner) && owner > 0;

/** IPC内部按sender持有上下文；读取方法不接受caller伪造owner，不访问磁盘或注册定时器。 */
export class ProjectOpenTraceStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private rejectedStarts = 0;
  private evictedTraces = 0;

  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? (() => performance.now()); }

  /** 重复ID不能覆盖旧记录；容量全在途时只失去诊断，不阻断原业务调用。 */
  start(owner: number, value: unknown): ProjectOpenTraceRecorder | null {
    const context = readProjectOpenTraceContext(value);
    if (!ownerValid(owner) || !context || this.entries.has(context.openId)) { this.rejectedStarts++; return null; }
    if (this.entries.size >= PROJECT_OPEN_TRACE_LIMIT) {
      const available = [...this.entries].find(([, entry]) => { const snapshot = entry.recorder.snapshot();
        return snapshot.recording.activeSpans === 0 && (snapshot.root.ended || snapshot.recording.phaseCoverageComplete); });
      if (!available) { this.rejectedStarts++; return null; }
      this.entries.delete(available[0]); this.evictedTraces++;
    }
    try {
      const recorder = new ProjectOpenTraceRecorder(context, { clockDomain: 'main', now: this.now });
      this.entries.set(context.openId, { owner, recorder }); return recorder;
    } catch { this.rejectedStarts++; return null; }
  }

  /** 仅业务服务内部用于后续resource IPC接回同一open；外部API只暴露read。 */
  forOwner(owner: number, openId: string): ProjectOpenTraceRecorder | null {
    const entry = this.entries.get(openId); return ownerValid(owner) && entry?.owner === owner ? entry.recorder : null;
  }

  read(owner: number, openId: string): ProjectOpenTraceSnapshot | null { return this.forOwner(owner, openId)?.snapshot() ?? null; }

  closeOwner(owner: number, outcome: 'cancelled' | 'stale' = 'cancelled'): number {
    if (!ownerValid(owner)) return 0;
    let count = 0;
    for (const entry of this.entries.values()) if (entry.owner === owner) {
      const snapshot = entry.recorder.snapshot();
      // 全程ready由renderer判定；已结算的历史main阶段不能被下一次关闭改写为取消。
      if (snapshot.recording.phaseCoverageComplete && snapshot.recording.activeSpans === 0) continue;
      if (entry.recorder.finish(outcome)) count++;
    }
    return count;
  }

  stats() { return { traceLimit: PROJECT_OPEN_TRACE_LIMIT, retainedTraces: this.entries.size, rejectedStarts: this.rejectedStarts, evictedTraces: this.evictedTraces }; }
}
