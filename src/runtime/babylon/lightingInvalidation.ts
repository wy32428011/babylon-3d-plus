export type LightingChangeKind = 'pose' | 'bindings' | 'classification' | 'structure' | 'unknown';
export type LightingInvalidationEntry = 'query' | 'frame' | 'sync' | 'capture' | 'snapshot' | 'preview' | 'focus';
// noConsumer：当前没有任何分类消费者，帧内不收集；coalesced：合并窗口内延后收集。
const kinds = () => ({ pose: 0, bindings: 0, classification: 0, structure: 0, unknown: 0 });
const entries = () => ({ query: 0, frame: 0, sync: 0, capture: 0, snapshot: 0, preview: 0, focus: 0 });
const counters = () => ({
  marks: { total: 0, byKind: kinds(), byReason: Object.create(null) as Record<string, number>, overflowReasons: 0 },
  collections: { count: 0, totalMs: 0, maxMs: 0, byEntry: entries() },
  bindings: { refreshes: 0, forcedRebuilds: 0, byEntry: entries() },
  meshLifecycle: { requests: 0, coalescedMarks: 0, fullRequests: 0 },
  skipped: { pose: 0, cleanClassification: 0, cleanBindings: 0, pendingActivation: 0, derived: 0, disposed: 0, noConsumer: 0, coalesced: 0, preparing: 0 },
  decisions: { skipped: 0, fallbacks: 0, byReason: Object.create(null) as Record<string, { skipped: number; fallbacks: number }>, overflowReasons: 0 },
  fallbacks: { unknown: 0 }, reentrant: { classification: 0, bindings: 0 },
});
export type LightingInvalidationCounters = ReturnType<typeof counters>;
export type LightingInvalidationDiagnosticsSnapshot = Readonly<{
  enabled: boolean;
  marks: Readonly<{ total: number; byKind: Readonly<Record<LightingChangeKind, number>>; byReason: Readonly<Record<string, number>>; overflowReasons: number }>;
  collections: Readonly<{ count: number; totalMs: number; maxMs: number; byEntry: Readonly<Record<LightingInvalidationEntry, number>> }>;
  bindings: Readonly<{ refreshes: number; forcedRebuilds: number; byEntry: Readonly<Record<LightingInvalidationEntry, number>> }>;
  meshLifecycle: Readonly<LightingInvalidationCounters['meshLifecycle']>;
  skipped: Readonly<LightingInvalidationCounters['skipped']>;
  decisions: Readonly<{ skipped: number; fallbacks: number; byReason: Readonly<Record<string, Readonly<{ skipped: number; fallbacks: number }>>>; overflowReasons: number }>;
  fallbacks: Readonly<LightingInvalidationCounters['fallbacks']>;
  reentrant: Readonly<LightingInvalidationCounters['reentrant']>;
}>;

/** 默认关闭；诊断不会逐网格读取、格式化或输出日志，原因键数量有上限。 */
export class LightingInvalidationDiagnostics {
  private active = false;
  private values = counters();
  private reasonCount = 0;
  private decisionReasonCount = 0;
  constructor(private readonly clock: () => number = () => performance.now()) {}
  get enabled(): boolean { return this.active; }
  setEnabled(enabled: boolean): void { this.active = enabled; }
  reset(): void { this.values = counters(); this.reasonCount = 0; this.decisionReasonCount = 0; }
  mark(kind: LightingChangeKind, reason: string): void {
    if (!this.active) return;
    this.values.marks.total++; this.values.marks.byKind[kind]++;
    if (Object.hasOwn(this.values.marks.byReason, reason)) this.values.marks.byReason[reason]++;
    else if (this.reasonCount < 64) { this.values.marks.byReason[reason] = 1; this.reasonCount++; }
    else this.values.marks.overflowReasons++;
    if (kind === 'pose') this.values.skipped.pose++;
    if (kind === 'unknown') this.values.fallbacks.unknown++;
  }
  decision(reason: string, skipped: boolean): void {
    if (!this.active) return;
    const field = skipped ? 'skipped' : 'fallbacks', decisions = this.values.decisions;
    decisions[field]++;
    if (Object.hasOwn(decisions.byReason, reason)) decisions.byReason[reason][field]++;
    else if (this.decisionReasonCount < 64) { decisions.byReason[reason] = { skipped: skipped ? 1 : 0, fallbacks: skipped ? 0 : 1 }; this.decisionReasonCount++; }
    else decisions.overflowReasons++;
  }
  /** 这是重复标记合并量，不能解释为避免了相同数量的collect。 */
  meshLifecycle(reason: string, coalesced: boolean): void {
    if (!this.active) return;
    const counts = this.values.meshLifecycle;
    counts.requests++;
    if (coalesced) counts.coalescedMarks++;
    else counts.fullRequests++;
    this.decision(reason, coalesced);
  }
  skip(kind: keyof LightingInvalidationCounters['skipped']): void {
    if (this.active) this.values.skipped[kind]++;
  }
  reentrant(kind: keyof LightingInvalidationCounters['reentrant']): void {
    if (this.active) this.values.reentrant[kind]++;
  }
  beginCollection(): number | null { return this.active ? this.clock() : null; }
  endCollection(entry: LightingInvalidationEntry, started: number | null): void {
    if (!this.active || started === null) return;
    const elapsed = Math.max(0, this.clock() - started);
    this.values.collections.count++; this.values.collections.totalMs += elapsed;
    this.values.collections.maxMs = Math.max(this.values.collections.maxMs, elapsed);
    this.values.collections.byEntry[entry]++;
  }
  bindingRefresh(entry: LightingInvalidationEntry, forced: boolean): void {
    if (!this.active) return;
    this.values.bindings.refreshes++; this.values.bindings.byEntry[entry]++;
    if (forced) this.values.bindings.forcedRebuilds++;
  }
  snapshot(): LightingInvalidationDiagnosticsSnapshot {
    const value = this.values, decisions = Object.create(null) as Record<string, { skipped: number; fallbacks: number }>;
    for (const [reason, counts] of Object.entries(value.decisions.byReason)) decisions[reason] = { ...counts };
    return { enabled: this.active,
      marks: { ...value.marks, byKind: { ...value.marks.byKind }, byReason: { ...value.marks.byReason } },
      collections: { ...value.collections, byEntry: { ...value.collections.byEntry } },
      bindings: { ...value.bindings, byEntry: { ...value.bindings.byEntry } },
      meshLifecycle: { ...value.meshLifecycle },
      decisions: { ...value.decisions, byReason: { ...decisions } },
      skipped: { ...value.skipped }, fallbacks: { ...value.fallbacks }, reentrant: { ...value.reentrant },
    };
  }
}
