export type SceneLoadStage = 'assetQueue' | 'assetReadDecode' | 'environmentQueue'
  | 'environmentReadDecode' | 'environmentClone' | 'environmentRenderReady'
  | 'modelInitialize' | 'modelScriptRefresh' | 'presentationRefresh' | 'progressNotify';

type StageMetric = { count: number; failedCount: number; totalMs: number; maxMs: number };
type AssetTiming = { fileName: string; stage: SceneLoadStage; durationMs: number; failed: boolean };

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
  private readonly active = new Set<{ stage: SceneLoadStage; startedAt: number; fileName?: string }>();
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  record(stage: SceneLoadStage, durationMs: number, failed = false, resource?: string): void {
    const duration = Math.max(0, durationMs);
    const metric = this.stages[stage] ??= { count: 0, failedCount: 0, totalMs: 0, maxMs: 0 };
    metric.count += 1;
    metric.failedCount += Number(failed);
    metric.totalMs += duration;
    metric.maxMs = Math.max(metric.maxMs, duration);
    if (resource) {
      // 诊断只保留文件名，不保留服务器、用户信息、本地目录或查询参数。
      const fileName = diagnosticFileName(resource);
      this.slowestAssets.push({ fileName, stage, durationMs: duration, failed });
      this.slowestAssets.sort((left, right) => right.durationMs - left.durationMs);
      this.slowestAssets.length = Math.min(12, this.slowestAssets.length);
    }
  }

  measure<T>(stage: SceneLoadStage, task: () => T): T {
    const startedAt = this.now();
    let failed = true;
    try {
      const result = task();
      failed = false;
      return result;
    } finally {
      this.record(stage, this.now() - startedAt, failed);
    }
  }

  async measureAsync<T>(stage: SceneLoadStage, task: () => Promise<T>, resource?: string): Promise<T> {
    const startedAt = this.now();
    const active = { stage, startedAt, fileName: resource ? diagnosticFileName(resource) : undefined };
    this.active.add(active);
    let failed = true;
    try {
      const result = await task();
      failed = false;
      return result;
    } finally {
      this.active.delete(active);
      this.record(stage, this.now() - startedAt, failed, resource);
    }
  }

  snapshot() {
    return {
      scope: 'runtime-lifetime' as const,
      active: [...this.active].map(({ stage, startedAt, fileName }) => ({ stage, fileName, elapsedMs: this.now() - startedAt })),
      stages: Object.fromEntries(Object.entries(this.stages).map(([key, value]) => [key, { ...value }])) as Partial<Record<SceneLoadStage, StageMetric>>,
      slowestAssets: this.slowestAssets.map((entry) => ({ ...entry })),
    };
  }
}
