import type { DeviceTelemetryFields } from './deviceTelemetry';
import { areFlatTelemetryFieldsEqual, areTelemetryStringArraysEqual } from './telemetryValueComparison';

export type TelemetryRuntimeDiagnosticStatus = {
  online: boolean;
  stale: boolean;
  faulted: boolean;
  conflict: boolean;
  lastReceivedAt: number | null;
  errors: string[];
};

export type TelemetryRuntimeDiagnosticSnapshot = TelemetryRuntimeDiagnosticStatus & {
  entityId: string;
  sourceId: string | null;
  deviceType: string | null;
  assetCode: string | null;
  topic: string | null;
  sequence: number | null;
  sourceTimestamp: number | null;
  fields: DeviceTelemetryFields;
  message: string;
  nodeTargets: string[];
  boneTargets: string[];
  animationTargets: string[];
};

export type TelemetryRuntimeDiagnosticInput = Omit<TelemetryRuntimeDiagnosticSnapshot, 'entityId'>;

type TelemetryRuntimeDiagnosticsListener = () => void;

/** 保存模型遥测运行时诊断的纯外部 store，供 Inspector 通过 useSyncExternalStore 只读订阅。 */
export class TelemetryRuntimeDiagnosticsStore {
  private readonly snapshots = new Map<string, TelemetryRuntimeDiagnosticSnapshot>();
  private readonly listeners = new Set<TelemetryRuntimeDiagnosticsListener>();
  private readonly fieldKeys = new WeakMap<TelemetryRuntimeDiagnosticSnapshot, string[]>();

  /** 写入指定实体的诊断快照；内容未变化时不通知订阅者。 */
  upsert(entityId: string, input: TelemetryRuntimeDiagnosticInput): boolean {
    if (this.isUnchanged(entityId, input)) return false;
    const snapshot: TelemetryRuntimeDiagnosticSnapshot = {
      entityId,
      ...input,
      errors: [...input.errors],
      fields: { ...input.fields },
      nodeTargets: [...input.nodeTargets],
      boneTargets: [...input.boneTargets],
      animationTargets: [...input.animationTargets],
    };
    this.fieldKeys.set(snapshot, Object.keys(snapshot.fields));
    this.snapshots.set(entityId, snapshot);
    this.emitChange();
    return true;
  }

  /** 未变化的点位在构造快照前返回。 */
  private isUnchanged(entityId: string, input: TelemetryRuntimeDiagnosticInput): boolean {
    const current = this.snapshots.get(entityId);
    return !!current && (areDiagnosticValuesEqual(current, input, this.fieldKeys.get(current)!)
      || createDiagnosticSignature(current) === createDiagnosticSignature(input));
  }

  /** 按实体 ID 读取最新诊断；没有运行时诊断时返回 null。 */
  getSnapshot(entityId: string | null | undefined): TelemetryRuntimeDiagnosticSnapshot | null {
    return entityId ? this.snapshots.get(entityId) ?? null : null;
  }

  /** 清理指定实体诊断；没有内容时保持静默。 */
  delete(entityId: string): boolean {
    const changed = this.snapshots.delete(entityId);
    if (changed) this.emitChange();
    return changed;
  }

  /** 清空所有诊断；用于运行时整体释放和测试隔离。 */
  clear(): void {
    if (this.snapshots.size === 0) return;
    this.snapshots.clear();
    this.emitChange();
  }

  /** 订阅诊断变化，返回取消订阅函数。 */
  subscribe(listener: TelemetryRuntimeDiagnosticsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 通知所有外部订阅者刷新快照。 */
  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

export const telemetryRuntimeDiagnosticsStore = new TelemetryRuntimeDiagnosticsStore();

/** 生成稳定内容签名，用于避免重复诊断触发无意义重渲染。 */
function createDiagnosticSignature(snapshot: TelemetryRuntimeDiagnosticInput): string {
  return JSON.stringify({
    online: snapshot.online,
    stale: snapshot.stale,
    faulted: snapshot.faulted,
    conflict: snapshot.conflict,
    lastReceivedAt: snapshot.lastReceivedAt,
    errors: snapshot.errors,
    sourceId: snapshot.sourceId,
    deviceType: snapshot.deviceType,
    assetCode: snapshot.assetCode,
    topic: snapshot.topic,
    sequence: snapshot.sequence,
    sourceTimestamp: snapshot.sourceTimestamp,
    fields: snapshot.fields,
    message: snapshot.message,
    nodeTargets: snapshot.nodeTargets,
    boneTargets: snapshot.boneTargets,
    animationTargets: snapshot.animationTargets,
  });
}

/** 相同的标量点位直接返回；复杂字段保留既有 JSON 比较语义。 */
function areDiagnosticValuesEqual(
  current: TelemetryRuntimeDiagnosticSnapshot,
  next: TelemetryRuntimeDiagnosticInput,
  keys: readonly string[],
): boolean {
  return current.online === next.online && current.stale === next.stale
    && current.faulted === next.faulted && current.conflict === next.conflict
    && current.lastReceivedAt === next.lastReceivedAt && current.sourceId === next.sourceId
    && current.deviceType === next.deviceType && current.assetCode === next.assetCode
    && current.topic === next.topic && current.sequence === next.sequence
    && current.sourceTimestamp === next.sourceTimestamp && current.message === next.message
    && areTelemetryStringArraysEqual(current.errors, next.errors)
    && areTelemetryStringArraysEqual(current.nodeTargets, next.nodeTargets)
    && areTelemetryStringArraysEqual(current.boneTargets, next.boneTargets)
    && areTelemetryStringArraysEqual(current.animationTargets, next.animationTargets)
    && areFlatTelemetryFieldsEqual(next.fields, current.fields, keys);
}
