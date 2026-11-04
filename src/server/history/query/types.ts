import type { DurableHistoryArchive } from '../storage/index.ts';
import type { StateAdapterRegistry } from '../../../runtime/history/state/adapters.ts';
import type { HistoryEventIndex } from '../events/HistoryEventIndex.ts';

export type ReadIdentity = { projectId: string; cacheRevision: string; publishedVersionId: string; bindingRevision: string; projectionId: string };
export type ReadGrant = { grantId: string; identity: ReadIdentity; from: number; to: number; expiresAt: number };
export type ReadAction = 'coverage' | 'sessions/open' | 'state/at' | 'state/chunk' | 'state/cancel' | 'changes/query' | 'events/query' | 'sessions/close';
export type TimeRange = { from: number; to: number };

/**
 * 由真正拥有 archive 的 worker 注入；必须与持久换代互斥，并在整个 operation 内维持 fencing。
 * 归档开/关读取租约内部也会执行 fencing 写入：实现必须显式支持同一 owner 的安全重入，
 * 或使用不与归档写入互锁的所有权屏障；不得在外层持有不可重入的同一锁造成死锁。
 * state/cancel 必须可与正在执行的恢复请求并行，且同样经当前授权检查。
 * 只执行一次 operation 并原样返回其结果；授权撤销或过期应分别使用 ACCESS_DENIED、CAPABILITY_EXPIRED。
 */
export interface QueryAuthority {
  runAuthorized<T>(grant: Readonly<ReadGrant>, action: ReadAction, operation: () => Promise<T>): Promise<T>;
  /** 覆盖及版本边界来自已授权的真实索引，不得将缺索引当成空数组。 */
  coverage(grant: Readonly<ReadGrant>, range: TimeRange): Promise<{ sourceName: string; sourceQuality: string; versionBoundaries: { time: number; versionLabel: string }[] }>;
}

export type QueryOptions = {
  archive: DurableHistoryArchive;
  registry: StateAdapterRegistry;
  authority: QueryAuthority;
  /** 只返回同一归档 owner 已打开并追赶的投影索引，缺失时不得伪造空事件。 */
  eventIndexForProjection?: (projectionId: string) => HistoryEventIndex | null;
  replayAbi: string;
  maxSessions?: number;
  maxSessionTtlMs?: number;
  maxSnapshotBytes?: number;
  maxTotalSnapshotBytes?: number;
  maxChunks?: number;
  chunkBytes?: number;
  maxPageBytes?: number;
  maxPages?: number;
  maxReadBytes?: number;
  /** 单个归档租约的 I/O 上限；上层会预扣该额度，避免多个租约绕过总预算。 */
  maxLeaseReadBytes?: number;
  maxConcurrent?: number;
};

export class HistoryQueryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HistoryQueryError'; }
}
