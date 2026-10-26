/** 打开诊断仅保存有界纯数据；ID不是授权能力，不进入场景或资产索引。 */
export const PROJECT_OPEN_PHASES = ['projectResolve', 'sourceDownload', 'sourceExtractValidate', 'projectMaterialize',
  'sceneCommitResourceSync', 'runtimeAcquireInitialize', 'batchFirstReady'] as const;
export const PROJECT_OPEN_TASKS = ['ipcInvoke', 'previousTaskDrain', 'sourceDetect', 'sceneRewrite', 'conflictCompare', 'conflictCopy',
  'projectPromote', 'projectRollback', 'indexRebuild', 'projectActivate', 'sceneRead', 'sceneDeserialize', 'imageCacheRestore',
  'sceneConfirm', 'resourceQuery', 'resourceDownload', 'resourceValidate', 'resourcePromote', 'resourceApply',
  'assetQueue', 'assetReadDecode', 'environmentQueue', 'environmentReadDecode', 'environmentClone', 'environmentRenderReady',
  'templateWait', 'modelAcquire', 'modelClone', 'modelInitialize', 'modelScriptRefresh', 'scriptInitialize', 'scriptConstructor',
  'scriptOnStart', 'presentationRefresh', 'entrancePrepare', 'modelArrayBatch', 'cargoReady', 'skyboxReady',
  'gpuCapabilityProbe', 'shaderWarmup', 'firstFrameValidation', 'rawCacheRead', 'networkRequest', 'networkBodyRead',
  'integrityCheck', 'cacheWrite'] as const;
export const PROJECT_OPEN_TRACE_LIMIT = 8;
export const PROJECT_OPEN_SPAN_LIMIT = 4096;
export type ProjectOpenPhase = typeof PROJECT_OPEN_PHASES[number];
export type ProjectOpenTask = typeof PROJECT_OPEN_TASKS[number];
export type ProjectOpenClockDomain = 'main' | 'renderer';
export type ProjectOpenIpcOperation = 'openProject' | 'sceneResources';
export type ProjectOpenTraceContext = Readonly<{ version: 1; openId: string; parentSpanId?: string; detail: 'phases' | 'assets' }>;
export type ProjectOpenSpanOutcome = 'ok' | 'error' | 'cancelled' | 'stale' | 'skipped';
export type ProjectOpenTraceStatus = 'active' | 'ready' | 'failed' | 'cancelled' | 'stale' | 'partial';
export type ProjectOpenTraceCode = 'operation-failed' | 'aborted' | 'scene-stale' | 'no-source-package' | 'cache-hit'
  | 'not-applicable' | 'diagnostic-incomplete';
export type ProjectOpenSpanRef = Readonly<{ openId: string; clockDomain: ProjectOpenClockDomain; spanId: string }>;
export type ProjectOpenSpanOptions = { parent?: ProjectOpenSpanRef; links?: readonly ProjectOpenSpanRef[]; resourceOrdinal?: number; entityId?: string; attempt?: number };
export type ProjectOpenTraceGuard = () => 'current' | 'cancelled' | 'stale';
export type ProjectOpenSpan = {
  spanId: string; kind: 'phase' | 'task' | 'bridge'; stage: ProjectOpenPhase | ProjectOpenTask; phase: ProjectOpenPhase; ipcOperation?: ProjectOpenIpcOperation;
  startMs: number | null; endMs: number | null; durationMs: number | null; ended: boolean;
  status: 'running' | ProjectOpenSpanOutcome; code?: ProjectOpenTraceCode; lateCompletion: boolean;
  parent?: ProjectOpenSpanRef; links?: readonly ProjectOpenSpanRef[]; resourceOrdinal?: number; entityId?: string; attempt?: number;
};
type Counters = { count: number; endedCount: number; unknownDurationCount: number; knownTaskSumMs: number; dropped: number };
export type ProjectOpenPhaseSummary = {
  phase: ProjectOpenPhase; state: 'unreached' | 'running' | ProjectOpenSpanOutcome;
  phaseWallUnionMs: number | null; retainedPhaseWallUnionMs: number; taskUnionMs: number | null; retainedTaskUnionMs: number;
  taskDetailRecorded: boolean; taskSumMs: number | null; knownTaskSumMs: number; taskCount: number; activeTaskCount: number; unknownDurationCount: number;
};
export type ProjectOpenTraceSnapshot = {
  version: 1; openId: string; clockDomain: ProjectOpenClockDomain; detail: 'phases' | 'assets'; status: ProjectOpenTraceStatus; sampledAtMs: number | null;
  root: { spanId: string; parentSpanId?: string; startMs: number | null; endMs: number | null; wallMs: number | null; ended: boolean };
  spans: ProjectOpenSpan[]; phases: ProjectOpenPhaseSummary[];
  recording: { spanLimit: number; retainedSpans: number; activeSpans: number; droppedSpans: number; suppressedTasks: number;
    diagnosticErrors: number; lateCompletions: number; requiredPhases: ProjectOpenPhase[]; phaseCoverageComplete: boolean; criticalPathComplete: boolean };
};
export type ProjectOpenSpanToken = Readonly<{ ref: ProjectOpenSpanRef | null;
  end: (outcome?: ProjectOpenSpanOutcome, code?: ProjectOpenTraceCode, endedAtMs?: number | null) => boolean }>;

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const SPAN_ID = /^(?:main|renderer):(?:0|[1-9]\d{0,8})$/;
const OUTCOMES = new Set<string>(['ok', 'error', 'cancelled', 'stale', 'skipped']);
const CODES = new Set<string>(['operation-failed', 'aborted', 'scene-stale', 'no-source-package', 'cache-hit', 'not-applicable', 'diagnostic-incomplete']);
const PHASE_SET = new Set<string>(PROJECT_OPEN_PHASES), TASK_SET = new Set<string>(PROJECT_OPEN_TASKS);
const NO_TOKEN: ProjectOpenSpanToken = Object.freeze({ ref: null, end: () => false });
const own = (value: object, key: string): unknown => { const field = Object.getOwnPropertyDescriptor(value, key); return field && 'value' in field ? field.value : undefined; };

/** 不调用访问器、不保留未知字段，原始URL、Error、Scene等对象无法进入上下文。 */
export function readProjectOpenTraceContext(value: unknown): ProjectOpenTraceContext | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value); if (keys.length > 4 || keys.some(key => !['version', 'openId', 'parentSpanId', 'detail'].includes(key))) return null;
    const version = own(value, 'version'), openId = own(value, 'openId'), parentSpanId = own(value, 'parentSpanId'), detail = own(value, 'detail') ?? 'phases';
    if (version !== 1 || typeof openId !== 'string' || !UUID.test(openId) || (detail !== 'phases' && detail !== 'assets')
      || (parentSpanId !== undefined && (typeof parentSpanId !== 'string' || !SPAN_ID.test(parentSpanId)))) return null;
    return Object.freeze({ version: 1, openId, detail: detail as 'phases' | 'assets', ...(parentSpanId === undefined ? {} : { parentSpanId }) });
  } catch { return null; }
}

function readRef(value: unknown): ProjectOpenSpanRef | null {
  if (!value || typeof value !== 'object') return null;
  const openId = own(value, 'openId'), spanId = own(value, 'spanId'), clockDomain = own(value, 'clockDomain');
  return typeof openId === 'string' && UUID.test(openId) && typeof spanId === 'string' && SPAN_ID.test(spanId)
    && (clockDomain === 'main' || clockDomain === 'renderer') && spanId.startsWith(clockDomain + ':')
    ? { openId, spanId, clockDomain } : null;
}
const duration = (start: number | null, end: number | null): number | null => start !== null && end !== null && end >= start ? end - start : null;
const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** 区间并集只在读取报告时计算；重叠任务的sum与wall始终分别返回。 */
export function projectOpenIntervalUnion(intervals: readonly { startMs: number | null; endMs: number | null }[]) {
  const valid = intervals.filter((item): item is { startMs: number; endMs: number } => finiteTime(item.startMs) && finiteTime(item.endMs) && item.endMs >= item.startMs)
    .map(item => [item.startMs, item.endMs]).sort((a, b) => a[0] - b[0]);
  let union = 0, end = -Infinity;
  for (const [start, currentEnd] of valid) { union += Math.max(0, currentEnd - Math.max(start, end)); end = Math.max(end, currentEnd); }
  return { unionMs: valid.length === intervals.length ? union : null, retainedUnionMs: union, unknownCount: intervals.length - valid.length };
}

/** 两域仅用IPC包络建立偏移界限，不把跨进程performance.now直接相减当耗时。 */
export function projectOpenIpcResidual(anchor: { rendererStartMs: number | null; rendererEndMs: number | null; mainStartMs: number | null; mainEndMs: number | null }) {
  const r = anchor.rendererStartMs, re = anchor.rendererEndMs, m = anchor.mainStartMs, me = anchor.mainEndMs;
  const rendererMs = finiteTime(r) && finiteTime(re) ? duration(r, re) : null;
  const mainMs = finiteTime(m) && finiteTime(me) ? duration(m, me) : null;
  const valid = rendererMs !== null && mainMs !== null && rendererMs >= mainMs;
  return { alignment: 'ipc-bounded-separate-monotonic-clocks' as const, rendererMs, mainMs,
    residualMs: valid ? rendererMs - mainMs : null,
    mainToRendererOffsetBoundsMs: valid ? [r! - m!, re! - me!] as [number, number] : null,
    valid, reason: valid ? null : rendererMs === null || mainMs === null ? 'unknown-or-regressing-clock' : 'main-exceeds-ipc-envelope' };
}

/** 独立生命周期的有界记录器；所有异步闭包捕获token，后续切换上下文不会改变归属。 */
export class ProjectOpenTraceRecorder {
  readonly context: ProjectOpenTraceContext;
  readonly clockDomain: ProjectOpenClockDomain;
  readonly rootRef: ProjectOpenSpanRef;
  private readonly now: () => number;
  private readonly required: readonly ProjectOpenPhase[];
  private readonly primary = new Map<ProjectOpenPhase, ProjectOpenSpan>();
  private readonly other: ProjectOpenSpan[] = [];
  private readonly counters = new Map<ProjectOpenPhase, Counters>();
  private sequence = 0;
  private active = 0;
  private dropped = 0;
  private suppressed = 0;
  private diagnosticErrors = 0;
  private lateCompletions = 0;
  private readonly retainedIds = new Set<string>();
  private lastTime: number | null = null;
  private startedAt: number | null;
  private endedAt: number | null = null;
  private ended = false;
  private status: ProjectOpenTraceStatus = 'active';

  constructor(context: ProjectOpenTraceContext, options: { clockDomain: ProjectOpenClockDomain; now?: () => number }) {
    const normalized = readProjectOpenTraceContext(context);
    if (!normalized || !['main', 'renderer'].includes(options.clockDomain)) throw new TypeError('打开诊断上下文格式无效。');
    this.context = normalized; this.clockDomain = options.clockDomain; this.now = options.now ?? (() => performance.now());
    const required = this.clockDomain === 'main' ? PROJECT_OPEN_PHASES.slice(0, 4) : PROJECT_OPEN_PHASES.slice(4);
    this.required = [...required]; this.rootRef = Object.freeze({ openId: normalized.openId, clockDomain: this.clockDomain, spanId: this.clockDomain + ':0' });
    this.startedAt = this.readTime();
  }

  private readTime(): number | null {
    try { const current = this.now(); if (!finiteTime(current) || (this.lastTime !== null && current < this.lastTime)) throw new Error();
      this.lastTime = current; return current;
    } catch { this.diagnosticErrors++; return null; }
  }

  /** 异常只影响诊断完整性，不替换原业务返回值或错误。 */
  noteDiagnosticFailure(): void { this.diagnosticErrors++; }
  getStatus(): ProjectOpenTraceStatus { return this.status; }

  private metadata(options?: ProjectOpenSpanOptions): ProjectOpenSpanOptions {
    if (!options) return {};
    try {
      const result: ProjectOpenSpanOptions = {};
      const parent = own(options, 'parent'); if (parent !== undefined) {
        const ref = readRef(parent);
        if (ref && ref.openId === this.context.openId && (ref.clockDomain !== this.clockDomain || ref.spanId === this.rootRef.spanId || this.retainedIds.has(ref.spanId))) result.parent = ref;
        else this.noteDiagnosticFailure();
      }
      const links = own(options, 'links'); if (links !== undefined) {
        if (Array.isArray(links) && links.length <= 8) {
          const normalized = links.map(readRef); if (normalized.every((ref): ref is ProjectOpenSpanRef => ref !== null)) result.links = normalized;
          else this.noteDiagnosticFailure();
        } else this.noteDiagnosticFailure();
      }
      for (const name of ['resourceOrdinal', 'attempt'] as const) {
        const value = own(options, name); if (value !== undefined) {
          if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[name] = value; else this.noteDiagnosticFailure();
        }
      }
      const entityId = own(options, 'entityId'); if (entityId !== undefined) {
        if (typeof entityId === 'string' && /^[A-Za-z\d][A-Za-z\d_-]{0,95}$/.test(entityId)) result.entityId = entityId; else this.noteDiagnosticFailure();
      }
      return result;
    } catch { this.noteDiagnosticFailure(); return {}; }
  }

  beginPhase(phase: ProjectOpenPhase, options?: ProjectOpenSpanOptions): ProjectOpenSpanToken { return this.begin('phase', phase, phase, options); }
  beginTask(stage: ProjectOpenTask, phase: ProjectOpenPhase, options?: ProjectOpenSpanOptions): ProjectOpenSpanToken {
    if (this.context.detail === 'phases') { this.suppressed++; return NO_TOKEN; }
    return this.begin('task', stage, phase, options);
  }

  /** handler实际边界由宿主捕获；bridge在phase-only也保留，独立于阶段/任务累计。 */
  beginIpcBridge(operation: ProjectOpenIpcOperation, receivedAtMs: number | null, options?: ProjectOpenSpanOptions): ProjectOpenSpanToken {
    if (operation !== 'openProject' && operation !== 'sceneResources') { this.noteDiagnosticFailure(); return NO_TOKEN; }
    return this.begin('bridge', 'ipcInvoke', operation === 'openProject' ? 'projectResolve' : 'sceneCommitResourceSync', options, receivedAtMs, operation);
  }

  private begin(kind: 'phase' | 'task' | 'bridge', stage: ProjectOpenPhase | ProjectOpenTask, phase: ProjectOpenPhase,
    options?: ProjectOpenSpanOptions, receivedAtMs?: number | null, ipcOperation?: ProjectOpenIpcOperation): ProjectOpenSpanToken {
    if (this.ended || !PHASE_SET.has(phase) || !(kind === 'phase' ? PHASE_SET : TASK_SET).has(stage)) { this.noteDiagnosticFailure(); return NO_TOKEN; }
    const id = this.clockDomain + ':' + ++this.sequence;
    const start = receivedAtMs === undefined ? this.readTime() : finiteTime(receivedAtMs) ? receivedAtMs : null;
    if (receivedAtMs !== undefined && start === null) this.noteDiagnosticFailure();
    const firstPhase = kind === 'phase' && !this.primary.has(phase);
    const retained = firstPhase || this.other.length < PROJECT_OPEN_SPAN_LIMIT - 1 - PROJECT_OPEN_PHASES.length;
    const span: ProjectOpenSpan = { spanId: id, kind, stage, phase, startMs: start, endMs: null, durationMs: null, ended: false,
      status: 'running', lateCompletion: false, ...(ipcOperation ? { ipcOperation } : {}), ...this.metadata(options) };
    if (firstPhase) this.primary.set(phase, span); else if (retained) this.other.push(span); else this.dropped++;
    if (retained) this.retainedIds.add(id);
    const counter = this.counters.get(phase) ?? { count: 0, endedCount: 0, unknownDurationCount: 0, knownTaskSumMs: 0, dropped: 0 };
    this.counters.set(phase, counter); if (kind === 'task') { counter.count++; if (!retained) counter.dropped++; }
    this.active++;
    const ref = Object.freeze({ openId: this.context.openId, clockDomain: this.clockDomain, spanId: id });
    let closed = false;
    return Object.freeze({ ref, end: (outcome: ProjectOpenSpanOutcome = 'ok', code?: ProjectOpenTraceCode, endedAtMs?: number | null) => {
      if (closed) return false; closed = true;
      const validExplicit = finiteTime(endedAtMs) && (this.lastTime === null || endedAtMs >= this.lastTime) && (start === null || endedAtMs >= start);
      const end = endedAtMs === undefined ? this.readTime() : validExplicit ? endedAtMs : null;
      if (endedAtMs !== undefined) { if (validExplicit) this.lastTime = endedAtMs; else this.noteDiagnosticFailure(); }
      this.active--;
      if (!OUTCOMES.has(outcome)) { this.noteDiagnosticFailure(); outcome = 'error'; code = 'diagnostic-incomplete'; }
      if (code !== undefined && !CODES.has(code)) { this.noteDiagnosticFailure(); code = 'diagnostic-incomplete'; }
      if (this.status === 'cancelled' || this.status === 'stale') outcome = this.status;
      if (outcome === 'skipped' && !code) { this.noteDiagnosticFailure(); code = 'diagnostic-incomplete'; }
      if (this.ended) this.lateCompletions++;
      Object.assign(span, { ended: true, endMs: end, durationMs: duration(start, end), status: outcome, ...(code ? { code } : {}), lateCompletion: this.ended });
      if (kind === 'task') { counter.endedCount++; if (span.durationMs === null) counter.unknownDurationCount++; else counter.knownTaskSumMs += span.durationMs; }
      return true;
    } });
  }

  /** 不提前关闭在途子任务；取消后的真实收束仍结束原token并标记lateCompletion。 */
  finish(status: Exclude<ProjectOpenTraceStatus, 'active'>): boolean {
    if (this.ended) return false;
    if (!['ready', 'failed', 'cancelled', 'stale', 'partial'].includes(status)) { this.noteDiagnosticFailure(); return false; }
    this.status = status; this.endedAt = this.readTime(); this.ended = true; return true;
  }

  private guardedOutcome(outcome: ProjectOpenSpanOutcome, guard?: ProjectOpenTraceGuard): ProjectOpenSpanOutcome {
    if (!guard) return outcome;
    try { const current = guard(); if (current === 'stale' || current === 'cancelled') return current;
      if (current !== 'current') this.noteDiagnosticFailure(); return outcome;
    } catch { this.noteDiagnosticFailure(); return outcome; }
  }

  async measureTaskAsync<T>(stage: ProjectOpenTask, phase: ProjectOpenPhase, task: (token: ProjectOpenSpanToken) => Promise<T>, options?: ProjectOpenSpanOptions, guard?: ProjectOpenTraceGuard): Promise<T> {
    const token = this.beginTask(stage, phase, options);
    try { const result = await task(token); token.end(this.guardedOutcome('ok', guard)); return result; }
    catch (error) { token.end(this.guardedOutcome('error', guard), 'operation-failed'); throw error; }
  }

  measureTask<T>(stage: ProjectOpenTask, phase: ProjectOpenPhase, task: (token: ProjectOpenSpanToken) => T, options?: ProjectOpenSpanOptions, guard?: ProjectOpenTraceGuard): T {
    const token = this.beginTask(stage, phase, options);
    try { const result = task(token); token.end(this.guardedOutcome('ok', guard)); return result; }
    catch (error) { token.end(this.guardedOutcome('error', guard), 'operation-failed'); throw error; }
  }

  snapshot(): ProjectOpenTraceSnapshot {
    const now = this.readTime(), retained = [...this.primary.values(), ...this.other];
    const spans = retained.map(span => ({ ...span, ...(span.parent ? { parent: { ...span.parent } } : {}), ...(span.links ? { links: span.links.map(ref => ({ ...ref })) } : {}) }));
    const phases = PROJECT_OPEN_PHASES.map(phase => {
      const phaseSpans = spans.filter(span => span.phase === phase && span.kind === 'phase'), tasks = spans.filter(span => span.phase === phase && span.kind === 'task');
      const phaseUnion = projectOpenIntervalUnion(phaseSpans), taskUnion = projectOpenIntervalUnion(tasks);
      const counter = this.counters.get(phase), last = [...phaseSpans].sort((a, b) => Number(a.spanId.split(':')[1]) - Number(b.spanId.split(':')[1])).at(-1);
      return { phase, state: phaseSpans.some(span => !span.ended) ? 'running' as const : last?.status ?? 'unreached' as const,
        phaseWallUnionMs: this.dropped || phaseSpans.length === 0 ? null : phaseUnion.unionMs, retainedPhaseWallUnionMs: phaseUnion.retainedUnionMs,
        taskUnionMs: this.context.detail === 'phases' || counter?.dropped ? null : taskUnion.unionMs, retainedTaskUnionMs: taskUnion.retainedUnionMs,
        taskDetailRecorded: this.context.detail === 'assets',
        taskSumMs: this.context.detail === 'phases' || counter?.unknownDurationCount || counter?.count !== counter?.endedCount ? null : counter?.knownTaskSumMs ?? 0,
        knownTaskSumMs: counter?.knownTaskSumMs ?? 0,
        taskCount: counter?.count ?? 0, activeTaskCount: (counter?.count ?? 0) - (counter?.endedCount ?? 0), unknownDurationCount: counter?.unknownDurationCount ?? 0 };
    });
    const coverage = this.required.every(phase => phases.some(row => row.phase === phase && ['ok', 'skipped'].includes(row.state)))
      && !this.active && !this.dropped && !this.diagnosticErrors && !this.lateCompletions;
    return { version: 1, openId: this.context.openId, clockDomain: this.clockDomain, detail: this.context.detail, status: this.status, sampledAtMs: now,
      root: { spanId: this.rootRef.spanId, ...(this.context.parentSpanId ? { parentSpanId: this.context.parentSpanId } : {}),
        startMs: this.startedAt, endMs: this.ended ? this.endedAt : null, wallMs: duration(this.startedAt, this.ended ? this.endedAt : now), ended: this.ended },
      spans, phases, recording: { spanLimit: PROJECT_OPEN_SPAN_LIMIT, retainedSpans: spans.length + 1, activeSpans: this.active,
        droppedSpans: this.dropped, suppressedTasks: this.suppressed, diagnosticErrors: this.diagnosticErrors, lateCompletions: this.lateCompletions, requiredPhases: [...this.required],
        phaseCoverageComplete: coverage, criticalPathComplete: coverage && this.context.detail === 'assets' && this.ended && this.status === 'ready' } };
  }
}

/** 联合报告保留两时钟域；全程wall只取renderer根，不能相加main/runtime累计值。 */
export function joinProjectOpenTraces(renderer: ProjectOpenTraceSnapshot, main: ProjectOpenTraceSnapshot | null,
  anchor: Parameters<typeof projectOpenIpcResidual>[0] & { openId: string }) {
  const sameOpenId = !!main && renderer.openId === main.openId && renderer.clockDomain === 'renderer' && main.clockDomain === 'main';
  const anchorMatchesOpenId = anchor.openId === renderer.openId;
  const ipc = projectOpenIpcResidual(anchor);
  return { version: 1 as const, openId: renderer.openId, rootWallMs: renderer.root.wallMs, sameOpenId, anchorMatchesOpenId, ipc,
    domains: { renderer, main: sameOpenId ? main : null },
    criticalPathComplete: sameOpenId && anchorMatchesOpenId && ipc.valid && renderer.recording.criticalPathComplete && !!main?.recording.phaseCoverageComplete
      && (main.status === 'active' || main.status === 'ready') && main.detail === 'assets' && main.recording.droppedSpans === 0 && main.recording.diagnosticErrors === 0 };
}
