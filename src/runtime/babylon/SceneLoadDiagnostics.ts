export type SceneLoadStage = 'assetQueue' | 'assetReadDecode' | 'environmentQueue'
  | 'environmentReadDecode' | 'environmentClone' | 'environmentRenderReady'
  | 'modelInitialize' | 'modelScriptRefresh' | 'presentationRefresh' | 'progressNotify'
  | 'modelClone' | 'scriptInitialize' | 'entrancePrepare' | 'firstFrameValidation'
  | 'rawCacheRead' | 'networkRequest' | 'networkBodyRead' | 'integrityCheck' | 'cacheWrite';

type StageMetric = { count: number; failedCount: number; totalMs: number; maxMs: number; activeCount: number };
export type SceneLoadContext = string | { resource?: string; entityId?: string };
type AssetTiming = { fileName?: string; entityId?: string; stage: SceneLoadStage; durationMs: number; failed: boolean };

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
  private readonly active = new Set<{ stage: SceneLoadStage; startedAt: number; fileName?: string; entityId?: string }>();
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  record(stage: SceneLoadStage, durationMs: number, failed = false, context?: SceneLoadContext): void {
    const duration = Math.max(0, durationMs);
    const metric = this.stages[stage] ??= { count: 0, failedCount: 0, totalMs: 0, maxMs: 0, activeCount: 0 };
    metric.count += 1;
    metric.failedCount += Number(failed);
    metric.totalMs += duration;
    metric.maxMs = Math.max(metric.maxMs, duration);
    if (context) {
      // 诊断只保留文件名，不保留服务器、用户信息、本地目录或查询参数。
      this.slowestAssets.push({ ...diagnosticContext(context), stage, durationMs: duration, failed });
      this.slowestAssets.sort((left, right) => right.durationMs - left.durationMs);
      this.slowestAssets.length = Math.min(12, this.slowestAssets.length);
    }
  }

  measure<T>(stage: SceneLoadStage, task: () => T, context?: SceneLoadContext): T {
    const startedAt = this.now();
    let failed = true;
    try {
      const result = task();
      failed = false;
      return result;
    } finally {
      this.record(stage, this.now() - startedAt, failed, context);
    }
  }

  async measureAsync<T>(stage: SceneLoadStage, task: () => Promise<T>, context?: SceneLoadContext): Promise<T> {
    const startedAt = this.now();
    const active = { stage, startedAt, ...diagnosticContext(context) };
    this.active.add(active);
    let failed = true;
    try {
      const result = await task();
      failed = false;
      return result;
    } finally {
      this.active.delete(active);
      this.record(stage, this.now() - startedAt, failed, context);
    }
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
    };
  }
}
