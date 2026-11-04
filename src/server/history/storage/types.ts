import type { StateAdapterRegistry } from '../../../runtime/history/state/adapters.ts';
import type { StateBudgets } from '../../../runtime/history/state/safeJson.ts';
import type {
  Continuity, DeepReadonly, InputCursor, KernelInput, StateChangeBatch, StateCursor,
  TwinCheckpoint, VersionManifest,
} from '../../../runtime/history/state/types.ts';

export type ArchiveScope = { projectId: string; captureDomainId: string; captureEpoch: string };
export type HistoryWriter = { ownerId: string; fencingToken: string };
export type HistoryDurability = 'file-and-directory-fsync' | 'file-fsync';
/**
 * 必须由持久授权层实现，不是租约时间检查或进程内 Mutex 的替代接口。
 * 在调用 operation 之前核验当前 owner/token，并在其结束前阻止换代及其他 writer 的 operation。
 * token 严格递增；失败不可自动重跑 operation。回调内包含真实 fsync，不能先释放授权锁。
 * 同一项目/关联域（跨 captureEpoch）必须使用同一互斥键。
 */
export interface HistoryFencingPort {
  runExclusive<T>(scope: Readonly<ArchiveScope>, writer: Readonly<HistoryWriter>, operation: () => Promise<T>): Promise<T>;
}
export type ArchiveLimits = {
  maxRawPayloadBytes: number; maxRawGroupBytes: number; maxRawGroupRecords: number;
  maxQueuedArrivalBytes: number; maxQueuedArrivals: number; groupCommitDelayMs: number;
  maxBatchBytes: number; maxCheckpointBytes: number; maxSegmentBytes: number;
  maxRecordsPerSegment: number; maxJournalSegmentBytes: number; maxJournalRecordBytes: number;
  maxJournalReplayBytes: number; maxCatalogBytes: number; maxIndexEntries: number;
  /** maxStoredBytes 包含元数据换代临时空间；配额不足明确背压，不静默缩短留存。 */
  maxHotBytes: number; maxStoredBytes: number; maxInflationRatio: number;
  maxSessions: number; maxSessionTtlMs: number; maxPageBytes: number; maxPageBatches: number;
  maxPagesPerSession: number; maxReadBytesPerSession: number; maxConcurrentReads: number;
  maxRecoveryBytes: number; maxRecoveryPages: number; maxCompactionSegments: number;
  maxDependencies: number; maxRetentionFiles: number;
};
export type DurableHistoryArchiveOptions = {
  /** 预先部署的私有本地目录；不接受 symlink/junction，不适用于共享网络文件系统。 */
  rootDirectory: string;
  scope: ArchiveScope;
  writer: HistoryWriter;
  fencing: HistoryFencingPort;
  registry: StateAdapterRegistry;
  stateBudgets?: Partial<StateBudgets>;
  limits?: Partial<ArchiveLimits>;
  /** 默认要求文件和目录 fsync；Windows 上须显式选择较弱的 file-fsync 才能使用。 */
  durability?: HistoryDurability;
  initialOffset?: string;
  /** 仅在外层已持久换代后显式指定原 owner；不按时间/PID猜测或自动偷锁。 */
  reclaimAbandonedWriter?: HistoryWriter;
};
export type MqttArrivalMetadata = {
  kind: 'mqtt'; topic: string; qos: 0 | 1 | 2; retain: boolean; duplicate: boolean;
  /** 原始 MQTT 协议 packet identifier，与持久捕获事务标识分离。 */
  packetId: string | null;
  captureTransactionId?: string;
};
export type HttpArrivalMetadata = {
  kind: 'http'; requestId: string; attemptId: string; method: 'GET' | 'POST';
  scope: 'full' | 'rows'; rows: string[]; statusCode: number | null; outcome: 'response' | 'transport-error';
};
export type ControlArrivalMetadata = { kind: 'control'; controlKind: 'advance' | 'gap' | 'baseline' | 'configuration' };
/** rawPayload 是业务载荷原始字节，包括无法解析的载荷；禁止传入 HTTP 请求/响应头或凭据。 */
export type RawHistoryArrival = {
  sourceId: string; sourceContractId: string; receivedAt: number;
  transport: MqttArrivalMetadata | HttpArrivalMetadata | ControlArrivalMetadata;
  rawPayload: Uint8Array;
};
export type HistoryRecordRef = { segmentId: string; offset: string; bytes: number; sha256: string };
export type CapturedReceipt = {
  kind: 'captured'; archiveId: string; inputCursor: InputCursor; receivedAt: number;
  record: HistoryRecordRef; recordIndex: number; journalSequence: string; fencingToken: string;
  durability: HistoryDurability;
};
export type CapturedArrival = {
  sourceId: string; sourceContractId: string; receivedAt: number;
  transport: RawHistoryArrival['transport']; rawPayload: Uint8Array; receipt: CapturedReceipt;
};
export type HistoryDependencyKind = 'publication' | 'viewer' | 'projector' | 'kernel' | 'scene' | 'models' | 'scripts' | 'logic' | 'source-contract' | 'resource';
/** 不包含磁盘路径或凭据。存储只持有/释放引用，不负责删除外部发布资源。 */
export type HistoryDependencyRef = {
  id: string; kind: HistoryDependencyKind; version: string; sha256: string; dependsOn: string[];
};
export type ProjectionDependencies = { roots: string[]; references: HistoryDependencyRef[] };
export type PreparedProjectionProof = {
  kind: 'projection-prepared'; archiveId: string; preparationId: string; projectionId: string;
  versionDigest: string; checkpointChecksum: string; inputCursor: InputCursor; cursor: StateCursor;
  logicalTime: number; record: HistoryRecordRef; journalSequence: string; fencingToken: string;
  durability: HistoryDurability;
};
export type PreparedCommitProof = {
  kind: 'state-prepared'; archiveId: string; preparationId: string; projectionId: string;
  versionDigest: string; inputCursor: InputCursor; fromRevision: string; toRevision: string;
  throughTime: number; batchChecksum: string; record: HistoryRecordRef;
  journalSequence: string; fencingToken: string; durability: HistoryDurability;
};
export type DurableCommitProof = {
  kind: 'state-committed' | 'projection-activated'; archiveId: string; commitId: string;
  preparationId: string; projectionId: string; versionDigest: string; inputCursor: InputCursor;
  committedStateCursor: StateCursor; committedThroughTime: number; checksum: string;
  /** 此序列及 hash 是本地持久提交证明；不是 Java 元数据事务已经完成的证明。 */
  journalSequence: string; journalHash: string; fencingToken: string; durability: HistoryDurability;
};
export type CheckpointReceipt = {
  projectionId: string; cursor: StateCursor; logicalTime: number; checksum: string;
  record: HistoryRecordRef; journalSequence: string; durability: HistoryDurability;
};
export type ProjectionWatermarks = {
  projectionId: string; versions: DeepReadonly<VersionManifest>;
  committedStateCursor: StateCursor; committedThroughTime: number;
  checkpointCursor: StateCursor; checkpointTime: number;
  queryableThrough: number; queryableCursor: StateCursor; continuity: DeepReadonly<Continuity>;
  retainedFrom: number; closed: boolean;
};
export type ArchiveWatermarks = {
  archiveId: string; scope: ArchiveScope; capturedThrough: InputCursor; capturedReceivedAt: number | null;
  archivedThrough: InputCursor | null; projections: ProjectionWatermarks[];
  durability: HistoryDurability; journalSequence: string;
};
export type ReadSessionRequest = {
  projectionId: string; ttlMs?: number; maxPageBytes?: number; maxPageBatches?: number;
  maxPages?: number; maxReadBytes?: number;
} & ({ mode: 'as-of'; targetTime: number }
  | { mode: 'changes'; afterCursor: StateCursor; toCursor?: StateCursor; throughTime?: number }
  | { mode: 'cursor-recovery'; atCursor: StateCursor }
  | { mode: 'changes-bounded'; afterCursor: StateCursor; upperCursor?: StateCursor; maxBatches: number }
  | { mode: 'recovery' });
export type HistoryReadSession = {
  sessionId: string; projectionId: string; versionDigest: string; versions: DeepReadonly<VersionManifest>;
  expiresAt: number; requestedTime: number; actualTime: number; queryableThrough: number;
  checkpoint: CheckpointReceipt | null; afterCursor: StateCursor; toCursor: StateCursor;
  throughTime: number; pageCursor: string; continuity: DeepReadonly<Continuity>;
  /** 分段索引追赶时的固定提交上界；同毫秒的其他批次不能被时间截断。 */
  committedUpperCursor?: StateCursor;
  hasMoreCommitted?: boolean;
};
export type HistoryChangePage = {
  sessionId: string; batches: DeepReadonly<StateChangeBatch>[];
  afterCursor: StateCursor; toCursor: StateCursor; nextStateCursor: StateCursor;
  nextCursor: string | null; hasMore: boolean; requestedTime: number; actualTime: number;
  throughTime: number; queryableThrough: number; readBytes: number;
};
export type CaptureReadSession = {
  sessionId: string; after: InputCursor; through: InputCursor; pageCursor: string; expiresAt: number;
};
export type CapturePage = {
  arrivals: CapturedArrival[]; nextInputCursor: InputCursor; through: InputCursor;
  nextCursor: string | null; hasMore: boolean; readBytes: number;
};
export type RecoveryResult = {
  checkpoint: DeepReadonly<TwinCheckpoint>; committedStateCursor: StateCursor;
  capturedThrough: InputCursor; unprocessedAfter: InputCursor; readBytes: number; pages: number;
};
export type RetentionRequest = { retainFrom: number };
export type RetentionPlan = {
  planId: string; retainFrom: number; journalSequence: string;
  files: { relativePath: string; bytes: number; sha256: string }[];
  retiredProjectionIds: string[]; retainedDependencies: HistoryDependencyRef[];
  releasedDependencies: HistoryDependencyRef[];
  /** 有效读租约/未完成候选所需的段不进入删除列表；后续计划可再次回收。 */
  pinnedSegmentIds: string[];
};
export type RetentionResult = { planId: string; removedFiles: string[]; deferredFiles: string[] };
export type ArchiveRecoveryNotice = {
  kind: 'uncommitted-journal-tail' | 'uncommitted-segment-tail' | 'abandoned-writer-reclaimed';
  relativePath: string; discardedBytes: number;
};
export type PrepareCommitRequest = { input: DeepReadonly<KernelInput>; batch: DeepReadonly<StateChangeBatch> };
export class HistoryStorageError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message); this.name = 'HistoryStorageError'; this.code = code; this.detail = Object.freeze(detail);
  }
}
