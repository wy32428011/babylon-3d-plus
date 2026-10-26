import { type ProjectOpenTraceRecorder, type ProjectOpenSpanToken, type ProjectOpenSpanOutcome,
  type ProjectOpenTraceCode, type ProjectOpenTask, type ProjectOpenSpanOptions } from '../../../electron/shared/projectOpenTrace.ts';

export type SceneLoadStage = 'assetQueue' | 'assetReadDecode' | 'environmentQueue'
  | 'environmentReadDecode' | 'environmentClone' | 'environmentRenderReady'
  | 'modelInitialize' | 'modelScriptRefresh' | 'presentationRefresh' | 'progressNotify'
  | 'modelClone' | 'scriptInitialize' | 'scriptConstructor' | 'scriptOnStart' | 'entrancePrepare' | 'firstFrameValidation'
  | 'gpuCapabilityProbe' | 'shaderWarmup'
  | 'rawCacheRead' | 'networkRequest' | 'networkBodyRead' | 'integrityCheck' | 'cacheWrite'
  | 'modelAcquire' | 'templateWait' | 'modelArrayBatch' | 'cargoReady' | 'skyboxReady';

/** 只含诊断纯数据；异步入口捕获此对象，切换场景不会改写其 openId。 */
export type SceneLoadTraceScope = {
  recorder: ProjectOpenTraceRecorder;
  sceneSessionId: string | null;
  modelAcquisitionFailures: number;
  acquire: ProjectOpenSpanToken;
  firstReady: ProjectOpenSpanToken | null;
  outcome: ProjectOpenSpanOutcome | null;
  resourceSequence: number;
};
export type SceneAssetTrace = {
  resourceOrdinal?: number;
  begin: (stage: ProjectOpenTask, options?: ProjectOpenSpanOptions) => ProjectOpenSpanToken | null;
};
/** 可选观察器不得改变缓存、脚本的原始返回值、调用顺序或异常。 */
export function beginSceneAssetTrace(trace: SceneAssetTrace | undefined, stage: ProjectOpenTask, options?: ProjectOpenSpanOptions): ProjectOpenSpanToken | null {
  try {
    const token = trace?.begin(stage, options); if (!token) return null;
    return { ref: token.ref, end: (...args) => { try { return token.end(...args); } catch { return false; } } };
  } catch { return null; }
}
const FIRST_READY_STAGES = new Set<SceneLoadStage>(['modelArrayBatch', 'cargoReady', 'skyboxReady', 'gpuCapabilityProbe', 'shaderWarmup', 'firstFrameValidation', 'entrancePrepare']);

type StageMetric = { count: number; failedCount: number; totalMs: number; maxMs: number; activeCount: number };
export type SceneLoadContext = string | { resource?: string; entityId?: string; resourceOrdinal?: number };
type AssetTiming = { fileName?: string; entityId?: string; stage: SceneLoadStage; durationMs: number; failed: boolean };
type ScriptInitializationStage = 'scriptConstructor' | 'scriptOnStart';
type ScriptResourceTiming = { resourceId: string; fileName?: string; totalMs: number;
  phases: Partial<Record<ScriptInitializationStage, StageMetric>> };
const SCRIPT_RESOURCE_LIMIT = 512;

function diagnosticContext(context?: SceneLoadContext): { fileName?: string; entityId?: string } {
  const resource = typeof context === 'string' ? context : context?.resource;
  return { fileName: resource ? diagnosticFileName(resource) : undefined,
    entityId: typeof context === 'object' ? context.entityId : undefined };
}

function diagnosticFileName(resource: string): string {
  if (resource.startsWith('data:')) return 'inline-asset';
  let decoded = resource.split(/[?#]/, 1)[0];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(decoded)) {
    try { decoded = new URL(decoded).pathname; } catch { return 'asset'; }
  }
  try { decoded = decodeURIComponent(decoded); } catch { /* 非法编码仍按原始路径提取文件名。 */ }
  return (decoded.split(/[?#]/, 1)[0].split(/[/\\]/).pop() || 'asset').slice(0, 160);
}

/** 运行时生命周期内的累计诊断；并行阶段的 totalMs 不能相加当作场景打开总耗时。 */
export class SceneLoadDiagnostics {
  private readonly stages: Partial<Record<SceneLoadStage, StageMetric>> = {};
  private readonly slowestAssets: AssetTiming[] = [];
  private readonly scriptResources = new Map<string, ScriptResourceTiming>();
  private droppedScriptTimingRecords = 0;
  private readonly active = new Set<{ stage: SceneLoadStage; startedAt: number; fileName?: string; entityId?: string }>();
  private readonly now: () => number;
  private trace: SceneLoadTraceScope | null = null;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  beginProjectOpenTrace(recorder?: ProjectOpenTraceRecorder | null, sceneSessionId?: string): void {
    const session = sceneSessionId ?? null;
    if (this.trace?.recorder === recorder && this.trace?.sceneSessionId === session) return;
    this.completeProjectOpenRuntime('stale', 'scene-stale');
    if (recorder?.getStatus() === 'active') this.trace = { recorder,
      sceneSessionId: session, modelAcquisitionFailures: 0,
      acquire: recorder.beginPhase('runtimeAcquireInitialize'), firstReady: null, outcome: null, resourceSequence: 0 };
  }

  captureTrace(): SceneLoadTraceScope | null { return this.trace; }

  /** 失败只归入口捕获的打开；旧请求晚到时不能污染后来的会话，也不重置累计指标。 */
  recordProjectOpenModelAcquisitionFailure(scope: SceneLoadTraceScope | null): void {
    if (scope) scope.modelAcquisitionFailures += 1;
  }

  getProjectOpenModelAcquisitionFailures(sceneSessionId: string): number | null {
    const scope = this.trace;
    return scope && scope.sceneSessionId === sceneSessionId && scope.outcome === null && scope.recorder.getStatus() === 'active'
      ? scope.modelAcquisitionFailures : null;
  }

  markProjectOpenAssetsSettled(): void {
    const scope = this.trace; if (!scope) return;
    scope.acquire.end(); this.beginFirstReady(scope);
  }

  completeProjectOpenRuntime(outcome: ProjectOpenSpanOutcome = 'ok', code?: ProjectOpenTraceCode): void {
    const scope = this.trace; if (!scope) return;
    this.trace = null; scope.outcome = outcome;
    scope.acquire.end(outcome, code);
    if (outcome === 'ok') this.beginFirstReady(scope);
    scope.firstReady?.end(outcome, code);
  }

  private beginFirstReady(scope: SceneLoadTraceScope): void {
    if (!scope.firstReady && scope.recorder.getStatus() === 'active') scope.firstReady = scope.recorder.beginPhase('batchFirstReady');
  }

  /** 新任务只取入口捕获的归属；token 结束时仍能标明取消/过期，绝不查找新的当前 ID。 */
  beginTraceTask(stage: SceneLoadStage, context?: SceneLoadContext, scope: SceneLoadTraceScope | null = this.trace,
    options?: ProjectOpenSpanOptions): ProjectOpenSpanToken | null {
    if (!scope || stage === 'progressNotify' || scope.recorder.getStatus() !== 'active') return null;
    const firstReady = FIRST_READY_STAGES.has(stage);
    if (firstReady) this.beginFirstReady(scope);
    const parent = firstReady ? scope.firstReady?.ref : scope.acquire.ref;
    const entityId = typeof context === 'object' && context.entityId && /^[A-Za-z\d][A-Za-z\d_-]{0,95}$/.test(context.entityId) ? context.entityId : undefined;
    const token = scope.recorder.beginTask(stage, firstReady ? 'batchFirstReady' : 'runtimeAcquireInitialize', {
      ...(parent ? { parent } : {}),
      ...(entityId ? { entityId } : {}),
      ...(typeof context === 'object' && Number.isSafeInteger(context.resourceOrdinal) && context.resourceOrdinal! >= 0 ? { resourceOrdinal: context.resourceOrdinal } : {}), ...options,
    });
    return { ref: token.ref, end: (outcome = 'ok', code, endedAtMs) => token.end(
      scope.outcome === 'stale' || scope.outcome === 'cancelled' ? scope.outcome : outcome, code, endedAtMs) };
  }

  /** 每个消费者仅保留序号、实体短 ID 和共享源 span 引用，不泄露 URL/缓存 key。 */
  createAssetTrace(scope: SceneLoadTraceScope | null = this.trace, context?: SceneLoadContext): SceneAssetTrace | undefined {
    if (!scope || scope.recorder.context.detail !== 'assets') return undefined;
    const resourceOrdinal = ++scope.resourceSequence;
    return { resourceOrdinal, begin: (stage, options) => this.beginTraceTask(stage as SceneLoadStage, context, scope, { resourceOrdinal, ...options }) };
  }

  withTrace<T>(scope: SceneLoadTraceScope | null, task: () => T): T {
    const previous = this.trace; this.trace = scope;
    try { return task(); } finally { this.trace = previous; }
  }

  record(stage: SceneLoadStage, durationMs: number, failed = false, context?: SceneLoadContext): void {
    const duration = Math.max(0, durationMs);
    const metric = this.stages[stage] ??= { count: 0, failedCount: 0, totalMs: 0, maxMs: 0, activeCount: 0 };
    metric.count += 1;
    metric.failedCount += Number(failed);
    metric.totalMs += duration;
    metric.maxMs = Math.max(metric.maxMs, duration);
    if ((stage === 'scriptConstructor' || stage === 'scriptOnStart') && context) {
      this.recordScriptResource(stage, duration, failed, context);
    }
    if (context) {
      // 诊断只保留文件名，不保留服务器、用户信息、本地目录或查询参数。
      this.slowestAssets.push({ ...diagnosticContext(context), stage, durationMs: duration, failed });
      this.slowestAssets.sort((left, right) => right.durationMs - left.durationMs);
      this.slowestAssets.length = Math.min(12, this.slowestAssets.length);
    }
  }

  /** 按资源汇总同步初始化成本；内存有界，完整引用只作为私有键，输出用不含路径的运行期 ID。 */
  private recordScriptResource(stage: ScriptInitializationStage, durationMs: number, failed: boolean, context: SceneLoadContext): void {
    const key = typeof context === 'string' ? context : context.resource;
    if (!key) return;
    let resource = this.scriptResources.get(key);
    if (!resource) {
      if (this.scriptResources.size >= SCRIPT_RESOURCE_LIMIT) { this.droppedScriptTimingRecords += 1; return; }
      resource = { resourceId: `script-resource-${this.scriptResources.size + 1}`, ...diagnosticContext(key), totalMs: 0, phases: {} };
      this.scriptResources.set(key, resource);
    }
    const metric = resource.phases[stage] ??= { count: 0, failedCount: 0, totalMs: 0, maxMs: 0, activeCount: 0 };
    metric.count += 1; metric.failedCount += Number(failed);
    metric.totalMs += durationMs; metric.maxMs = Math.max(metric.maxMs, durationMs);
    resource.totalMs += durationMs;
  }

  measure<T>(stage: SceneLoadStage, task: () => T, context?: SceneLoadContext, scope: SceneLoadTraceScope | null = this.trace): T {
    const token = this.beginTraceTask(stage, context, scope);
    const startedAt = this.now();
    let failed = true;
    try {
      const result = task();
      failed = false;
      return result;
    } finally {
      token?.end(failed ? 'error' : 'ok', failed ? 'operation-failed' : undefined);
      this.record(stage, this.now() - startedAt, failed, context);
    }
  }

  async measureAsync<T>(stage: SceneLoadStage, task: () => Promise<T>, context?: SceneLoadContext, scope: SceneLoadTraceScope | null = this.trace): Promise<T> {
    const token = this.beginTraceTask(stage, context, scope);
    const startedAt = this.now();
    const active = { stage, startedAt, ...diagnosticContext(context) };
    this.active.add(active);
    let failed = true;
    try {
      const result = await task();
      failed = false;
      return result;
    } finally {
      token?.end(failed ? 'error' : 'ok', failed ? 'operation-failed' : undefined);
      this.active.delete(active);
      this.record(stage, this.now() - startedAt, failed, context);
    }
  }

  /** 只检查现有在途作业，不扫描场景；首帧/环境渲染等待不属于可延后分类的资源工作。 */
  hasPendingAssetWork(): boolean {
    for (const { stage } of this.active) {
      if (stage === 'assetReadDecode' || stage === 'scriptInitialize' || stage === 'environmentReadDecode') return true;
    }
    return false;
  }

  snapshot() {
    const stages = Object.fromEntries(Object.entries(this.stages).map(([key, value]) => [key, { ...value }])) as Partial<Record<SceneLoadStage, StageMetric>>;
    for (const { stage } of this.active) {
      const metric = stages[stage] ??= { count: 0, failedCount: 0, totalMs: 0, maxMs: 0, activeCount: 0 };
      metric.activeCount += 1;
    }
    return {
      scope: 'runtime-lifetime' as const,
      active: [...this.active].map(({ stage, startedAt, fileName, entityId }) => ({ stage, fileName, entityId, elapsedMs: this.now() - startedAt })),
      stages,
      slowestAssets: this.slowestAssets.map((entry) => ({ ...entry })),
      scriptInitialization: {
        scope: 'runtime-lifetime-synchronous-dispatch' as const,
        resourceLimit: SCRIPT_RESOURCE_LIMIT, trackedResources: this.scriptResources.size,
        droppedTimingRecords: this.droppedScriptTimingRecords, rankingComplete: this.droppedScriptTimingRecords === 0,
        topResources: [...this.scriptResources.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 20)
          .map(resource => ({ ...resource, phases: Object.fromEntries(Object.entries(resource.phases).map(([stage, metric]) => [stage, { ...metric }])) })),
      },
    };
  }
}
