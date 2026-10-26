import { PROJECT_OPEN_TRACE_LIMIT, ProjectOpenTraceRecorder, readProjectOpenTraceContext,
  projectOpenIpcResidual, joinProjectOpenTraces, type ProjectOpenTraceSnapshot, type ProjectOpenTraceContext,
  type ProjectOpenSpanToken, type ProjectOpenSpanOutcome, type ProjectOpenTraceStatus, type ProjectOpenTask } from '../../../electron/shared/projectOpenTrace.ts';
import type { ProjectOpenIpcTiming } from '../../../electron/types';

type Entry = { recorder: ProjectOpenTraceRecorder; sceneSessionId: string | null };
const SESSION = /^[A-Za-z\d][A-Za-z\d_.:-]{0,127}$/;

/** renderer运行态归属表；不写SceneDocument，不以“当前ID”替换已捕获的异步token。 */
export class RendererProjectOpenTraceStore {
  private readonly entries = new Map<string, Entry>();
  private readonly sceneOwners = new Map<string, string>();
  private readonly now: () => number;
  private rejectedStarts = 0;
  private evictedTraces = 0;

  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? (() => performance.now()); }

  start(value: unknown): ProjectOpenTraceRecorder | null {
    const context = readProjectOpenTraceContext(value);
    if (!context || this.entries.has(context.openId)) { this.rejectedStarts++; return null; }
    if (this.entries.size >= PROJECT_OPEN_TRACE_LIMIT) {
      const oldest = [...this.entries].find(([, entry]) => { const snapshot = entry.recorder.snapshot(); return snapshot.root.ended && snapshot.recording.activeSpans === 0; });
      if (!oldest) { this.rejectedStarts++; return null; }
      if (oldest[1].sceneSessionId) this.sceneOwners.delete(oldest[1].sceneSessionId);
      this.entries.delete(oldest[0]); this.evictedTraces++;
    }
    try {
      const recorder = new ProjectOpenTraceRecorder(context, { clockDomain: 'renderer', now: this.now });
      this.entries.set(context.openId, { recorder, sceneSessionId: null }); return recorder;
    } catch { this.rejectedStarts++; return null; }
  }

  /** 只能在实际Store提交后绑定一次；同会话不允许后来ID抢占，也不把旧场景归给新打开。 */
  bindScene(openId: string, sceneSessionId: string): boolean {
    if (typeof sceneSessionId !== 'string' || !SESSION.test(sceneSessionId)) return false;
    const entry = this.entries.get(openId), existing = this.sceneOwners.get(sceneSessionId);
    if (!entry || entry.recorder.snapshot().root.ended || (existing !== undefined && existing !== openId)
      || (entry.sceneSessionId !== null && entry.sceneSessionId !== sceneSessionId)) return false;
    entry.sceneSessionId = sceneSessionId; this.sceneOwners.set(sceneSessionId, openId); return true;
  }

  contextForScene(sceneSessionId: string): ProjectOpenTraceContext | null {
    const openId = this.sceneOwners.get(sceneSessionId); return openId ? this.entries.get(openId)?.recorder.context ?? null : null;
  }

  forOpen(openId: string): ProjectOpenTraceRecorder | null { return this.entries.get(openId)?.recorder ?? null; }

  forScene(sceneSessionId: string): ProjectOpenTraceRecorder | null {
    const openId = this.sceneOwners.get(sceneSessionId); return openId ? this.forOpen(openId) : null;
  }

  read(openId: string): (ProjectOpenTraceSnapshot & { sceneSessionId: string | null }) | null {
    const entry = this.entries.get(openId); return entry ? { ...entry.recorder.snapshot(), sceneSessionId: entry.sceneSessionId } : null;
  }

  retireScene(sceneSessionId: string, outcome: 'stale' | 'cancelled' = 'stale'): boolean {
    const entry = this.forScene(sceneSessionId); this.sceneOwners.delete(sceneSessionId); return entry?.finish(outcome) ?? false;
  }

  stats() { return { traceLimit: PROJECT_OPEN_TRACE_LIMIT, retainedTraces: this.entries.size, boundScenes: this.sceneOwners.size,
    rejectedStarts: this.rejectedStarts, evictedTraces: this.evictedTraces }; }
}

type BridgePair = { openId: string; operation: 'openProject' | 'sceneResources'; spanId: string | null;
  rendererStartMs: number | null; rendererEndMs: number | null; mainStartMs: number | null; mainEndMs: number | null };
type OpenEntry = { recorder: ProjectOpenTraceRecorder; phase5?: ProjectOpenSpanToken; issues: boolean; pairs: BridgePair[] };
export type ProjectOpenRequestToken = Readonly<{ context: ProjectOpenTraceContext; finish: (outcome: ProjectOpenSpanOutcome,
  result?: { trace?: ProjectOpenTraceSnapshot; traceIpc?: ProjectOpenIpcTiming }) => void }>;
const rendererTraces = new RendererProjectOpenTraceStore();
const openEntries = new Map<string, OpenEntry>();
let nextDetail: 'phases' | 'assets' = 'phases';

/** 仅下一次被Home接受的打开消费；不持久化，不生成ID，也不注册采样器。 */
export function setNextProjectOpenTraceDetail(detail: 'phases' | 'assets'): boolean {
  if (detail !== 'phases' && detail !== 'assets') return false;
  nextDetail = detail; return true;
}
function traceNow(): number | null { try { const value = performance.now(); return Number.isFinite(value) && value >= 0 ? value : null; } catch { return null; } }
function safely<T>(entry: OpenEntry | undefined, task: () => T): T | undefined {
  try { return task(); } catch { try { entry?.recorder.noteDiagnosticFailure(); } catch { /* 诊断不改变原业务结果。 */ } return undefined; }
}
function entryFor(context: ProjectOpenTraceContext | null | undefined): OpenEntry | undefined { return context ? openEntries.get(context.openId) : undefined; }

export function beginHomeProjectOpenTrace(openId: string): ProjectOpenTraceContext | undefined {
  const detail = nextDetail; nextDetail = 'phases';
  return safely(undefined, () => {
    const recorder = rendererTraces.start({ version: 1, openId, detail }); if (!recorder) return undefined;
    // 与8项主归属表一致淘汰，不能额外无限保存已完成请求包络。
    for (const id of openEntries.keys()) if (!rendererTraces.forOpen(id)) openEntries.delete(id);
    openEntries.set(openId, { recorder, issues: false, pairs: [] }); return recorder.context;
  });
}

/** 调用前/await后直接取边界，不增加来源Promise、探针或等待。 */
export function beginProjectOpenRequest(context: ProjectOpenTraceContext | undefined, operation: 'openProject' | 'sceneResources'): ProjectOpenRequestToken | undefined {
  const entry = entryFor(context); if (!entry || entry.recorder.getStatus() !== 'active') return undefined;
  return safely(entry, () => {
    const start = traceNow(), bridge = entry.recorder.beginIpcBridge(operation, start);
    const pair: BridgePair = { openId: context!.openId, operation, spanId: bridge.ref?.spanId ?? null, rendererStartMs: start,
      rendererEndMs: null, mainStartMs: null, mainEndMs: null };
    if (entry.pairs.length < 32) entry.pairs.push(pair); else entry.recorder.noteDiagnosticFailure();
    let ended = false;
    return { context: { ...entry.recorder.context, parentSpanId: bridge.ref?.spanId ?? entry.recorder.rootRef.spanId }, finish(outcome, result) {
      const end = traceNow(); if (ended) return; ended = true;
      safely(entry, () => {
        pair.rendererEndMs = end;
        const packet = result?.traceIpc;
        if (packet?.openId === context!.openId && packet.operation === operation && result?.trace?.openId === context!.openId
          && result.trace.clockDomain === 'main') { pair.mainStartMs = packet.receivedMs; pair.mainEndMs = packet.returnedMs; }
        else if (outcome === 'ok') entry.recorder.noteDiagnosticFailure();
        bridge.end(outcome, outcome === 'ok' ? undefined : outcome === 'cancelled' ? 'aborted' : outcome === 'stale' ? 'scene-stale' : 'operation-failed', end);
      });
    } };
  });
}

export function beginProjectOpenSceneCommit(context?: ProjectOpenTraceContext): void {
  const entry = entryFor(context); if (!entry) return;
  safely(entry, () => { if (entry.recorder.getStatus() === 'active') entry.phase5 ??= entry.recorder.beginPhase('sceneCommitResourceSync'); });
}
export function bindProjectOpenScene(context: ProjectOpenTraceContext | undefined, sceneSessionId: string): boolean {
  const entry = entryFor(context); return !!entry && (safely(entry, () => rendererTraces.bindScene(context!.openId, sceneSessionId)) ?? false);
}
export function getSceneProjectOpenContext(sceneSessionId: string): ProjectOpenTraceContext | undefined {
  return safely(undefined, () => rendererTraces.contextForScene(sceneSessionId) ?? undefined);
}
/** SceneView将shared对象注入Runtime；runtime不需要知道Editor registry。 */
export function getSceneProjectOpenRecorder(sceneSessionId: string): ProjectOpenTraceRecorder | undefined {
  return safely(undefined, () => { const recorder = rendererTraces.forScene(sceneSessionId); return recorder?.getStatus() === 'active' ? recorder : undefined; });
}
/** 未提交/失败/取消的Home动作也可按明确ID读取；不查“最近一次”来替换调用方ID。 */
export function readProjectOpenTrace(openId: string) { return safely(openEntries.get(openId), () => rendererTraces.read(openId)) ?? null; }
export function beginProjectOpenTask(context: ProjectOpenTraceContext | undefined, stage: ProjectOpenTask): ProjectOpenSpanToken | undefined {
  const entry = entryFor(context); return entry?.recorder.getStatus() === 'active' ? safely(entry, () => entry.recorder.beginTask(stage, 'sceneCommitResourceSync', { parent: entry.phase5?.ref ?? entry.recorder.rootRef })) : undefined;
}
export function endProjectOpenTask(context: ProjectOpenTraceContext | undefined, token: ProjectOpenSpanToken | undefined, outcome: ProjectOpenSpanOutcome): void {
  const entry = entryFor(context); safely(entry, () => token?.end(outcome, outcome === 'ok' ? undefined : outcome === 'stale' ? 'scene-stale' : 'operation-failed'));
}
export function completeProjectOpenResources(context: ProjectOpenTraceContext | undefined, outcome: ProjectOpenSpanOutcome): void {
  const entry = entryFor(context); if (!entry || entry.recorder.getStatus() !== 'active') return;
  safely(entry, () => { if (outcome !== 'ok' && outcome !== 'skipped') entry.issues = true;
    entry.phase5?.end(outcome, outcome === 'skipped' ? 'not-applicable' : outcome === 'ok' ? undefined : 'diagnostic-incomplete'); });
}
export function finishProjectOpenTrace(context: ProjectOpenTraceContext | undefined, status: Exclude<ProjectOpenTraceStatus, 'active'>): void {
  const entry = entryFor(context); if (!entry || entry.recorder.getStatus() !== 'active') return;
  safely(entry, () => { if (status !== 'ready') entry.issues = true;
    if (status !== 'ready') entry.phase5?.end(status === 'cancelled' ? 'cancelled' : status === 'stale' ? 'stale' : 'error', 'diagnostic-incomplete');
    entry.recorder.finish(status === 'ready' && entry.issues ? 'partial' : status); });
}
export function finishUnboundProjectOpenTrace(context: ProjectOpenTraceContext | undefined, status: 'stale' | 'cancelled'): void {
  const snapshot = context ? safely(entryFor(context), () => rendererTraces.read(context.openId)) : null;
  if (snapshot && !snapshot.sceneSessionId) finishProjectOpenTrace(context, status);
}
export function retireSceneProjectOpenTrace(sceneSessionId: string): void {
  const context = getSceneProjectOpenContext(sceneSessionId); finishProjectOpenTrace(context, 'stale');
  safely(entryFor(context), () => rendererTraces.retireScene(sceneSessionId));
}

/** 只由既有复制报告入口调用一次owner getter；不注册轮询，也不借用最新场景的ID。 */
export async function readSceneProjectOpenReport(sceneSessionId: string,
  getMain?: (request: { openId: string }) => Promise<ProjectOpenTraceSnapshot | null>, isCurrent?: () => boolean) {
  const context = getSceneProjectOpenContext(sceneSessionId), entry = entryFor(context); if (!context || !entry) return null;
  let main: ProjectOpenTraceSnapshot | null = null;
  try { main = getMain ? await getMain({ openId: context.openId }) : null; } catch { entry.recorder.noteDiagnosticFailure(); }
  let stale = getSceneProjectOpenContext(sceneSessionId)?.openId !== context.openId;
  if (isCurrent) { try { stale ||= !isCurrent(); } catch { entry.recorder.noteDiagnosticFailure(); stale = true; } }
  const renderer = entry.recorder.snapshot();
  const pairs = entry.pairs.map(pair => {
    const actual = main?.spans.find(span => span.kind === 'bridge' && span.ipcOperation === pair.operation
      && span.parent?.openId === pair.openId && span.parent?.spanId === pair.spanId);
    const mainStartMs = actual?.startMs ?? pair.mainStartMs, mainEndMs = actual?.endMs ?? pair.mainEndMs;
    return { ...pair, mainStartMs, mainEndMs, residual: projectOpenIpcResidual({ ...pair, mainStartMs, mainEndMs }),
      packetMatches: pair.mainStartMs === null || (pair.mainStartMs === actual?.startMs && pair.mainEndMs === actual?.endMs) };
  });
  const initial = pairs.find(pair => pair.operation === 'openProject');
  const joint = joinProjectOpenTraces(renderer, main, { openId: context.openId, rendererStartMs: initial?.rendererStartMs ?? null,
    rendererEndMs: initial?.rendererEndMs ?? null, mainStartMs: initial?.mainStartMs ?? null, mainEndMs: initial?.mainEndMs ?? null });
  return { ...joint, sceneSessionId, stale, bridges: pairs,
    criticalPathComplete: joint.criticalPathComplete && !stale && !entry.issues && pairs.every(pair => pair.packetMatches && pair.residual.valid) };
}
