import { compareDecimal, nextDecimal } from '../../../runtime/history/state/safeJson.ts';
import type { Continuity, DeepReadonly, InputCursor, StateCursor, VersionManifest } from '../../../runtime/history/state/types.ts';
import type {
  ArchiveLimits, ArchiveScope, CheckpointReceipt, DurableCommitProof, HistoryDependencyRef, HistoryDurability,
  HistoryRecordRef, PreparedCommitProof, PreparedProjectionProof, ProjectionDependencies, RetentionPlan,
} from './types.ts';
import type { JournalPosition } from './journal.ts';
import type { ExactFile } from './files.ts';
import { clone, jsonHash, need, physicalOffset, same, validateRecordRef } from './primitives.ts';

export type SegmentKind = 'raw' | 'changes' | 'checkpoints';
export type SegmentIndex = {
  id: string; kind: SegmentKind; hotPath: string; bytes: number; records: number; sealed: boolean; sha256: string | null;
  cold: { relativePath: string; bytes: number; sha256: string } | null;
};
export type OwnedFile = ExactFile & { segmentId: string; state: 'reserved' | 'hot' | 'cold' | 'obsolete' };
export type RawGroupIndex = {
  firstOffset: string; lastOffset: string; count: number; minReceivedAt: number; maxReceivedAt: number;
  lastReceivedAt: number; record: HistoryRecordRef; journalSequence: string; fencingToken: string;
};
export type HeadIndex = {
  cursor: StateCursor; inputCursor: InputCursor; logicalTime: number; continuity: DeepReadonly<Continuity>;
  completeCursor: StateCursor; completeTime: number;
};
export type CheckpointIndex = CheckpointReceipt & { inputCursor: InputCursor; continuity: DeepReadonly<Continuity> };
export type BatchIndex = {
  proof: PreparedCommitProof; commit: DurableCommitProof; firstTime: number; head: HeadIndex;
};
export type ProjectionIndex = {
  id: string; versionDigest: string; versions: DeepReadonly<VersionManifest>; dependencies: ProjectionDependencies;
  activation: DurableCommitProof; initialProof: PreparedProjectionProof;
  checkpoints: CheckpointIndex[]; batches: BatchIndex[]; head: HeadIndex; retainedFrom: number; closed: boolean;
};
export type ProjectionPreparation = {
  kind: 'projection'; proof: PreparedProjectionProof; versions: DeepReadonly<VersionManifest>;
  dependencies: ProjectionDependencies; head: HeadIndex;
};
export type StatePreparation = { kind: 'state'; proof: PreparedCommitProof; firstTime: number; head: HeadIndex };
export type PreparationIndex = ProjectionPreparation | StatePreparation;
export type LeaseIndex = {
  id: string; runtimeId: string; expiresAt: number; segmentIds: string[]; projectionId: string | null;
  dependencies: HistoryDependencyRef[];
};
export type TrimIndex = { projectionId: string; retire: boolean; checkpointRevision: string; retainedFrom: number };
export type StoredRetentionPlan = { plan: RetentionPlan; trims: TrimIndex[]; dropRawThrough: string; removeSegments: string[]; removedFiles: string[]; expiredLeases: string[] };
export type ArchiveEvent =
  | { kind: 'segment-open'; segment: SegmentIndex }
  | { kind: 'raw'; group: RawGroupIndex }
  | { kind: 'prepare'; preparation: PreparationIndex }
  | { kind: 'abort'; preparationId: string }
  | { kind: 'commit'; preparationId: string }
  | { kind: 'checkpoint'; checkpoint: CheckpointIndex }
  | { kind: 'close-projection'; projectionId: string }
  | { kind: 'seal'; segmentId: string; bytes: number; sha256: string }
  | { kind: 'reserve-compressed'; file: OwnedFile }
  | { kind: 'compressed'; segmentId: string; file: ExactFile }
  | { kind: 'lease-open'; lease: LeaseIndex }
  | { kind: 'lease-close'; leaseId: string }
  | { kind: 'retention'; retention: StoredRetentionPlan }
  | { kind: 'forget-retention'; planId: string }
  | { kind: 'file-deleted'; planId: string; relativePath: string };
export type ArchiveCatalog = {
  format: 'history-index/1'; capturedOffset: string; capturedReceivedAt: number | null; rawFloor: string;
  segments: SegmentIndex[]; files: OwnedFile[]; groups: RawGroupIndex[]; preparations: PreparationIndex[];
  projections: ProjectionIndex[]; leases: LeaseIndex[]; plans: StoredRetentionPlan[];
};
export class ArchiveIndex {
  readonly segments = new Map<string, SegmentIndex>();
  readonly files = new Map<string, OwnedFile>();
  readonly preparations = new Map<string, PreparationIndex>();
  readonly projections = new Map<string, ProjectionIndex>();
  readonly leases = new Map<string, LeaseIndex>();
  readonly plans = new Map<string, StoredRetentionPlan>();
  readonly committed = new Map<string, { proof: PreparedCommitProof | PreparedProjectionProof; commit: DurableCommitProof }>();
  groups: RawGroupIndex[] = [];
  capturedOffset: string;
  capturedReceivedAt: number | null = null;
  rawFloor: string;
  entries = 0;
  #storedBytes = 0;
  #hotBytes = 0;
  constructor(readonly archiveId: string, readonly scope: ArchiveScope, readonly initialOffset: string,
    readonly durability: HistoryDurability, readonly limits: Readonly<ArchiveLimits>) {
    this.capturedOffset = initialOffset; this.rawFloor = initialOffset;
  }
  get capturedCursor(): InputCursor { return { captureDomainId: this.scope.captureDomainId, captureEpoch: this.scope.captureEpoch, offset: this.capturedOffset }; }
  get storedBytes(): number { return this.#storedBytes; }
  get hotBytes(): number { return this.#hotBytes; }
  apply(event: ArchiveEvent, position: JournalPosition): void {
    switch (event.kind) {
      case 'segment-open': {
        const segment = clone(event.segment);
        need(!this.segments.has(segment.id) && segment.bytes === 0 && segment.records === 0 && !segment.sealed && segment.cold === null,
          'CORRUPT_INDEX', '段创建记录重复或不合法。');
        this.segments.set(segment.id, segment);
        this.files.set(segment.hotPath, { relativePath: segment.hotPath, bytes: 0, sha256: '', segmentId: segment.id, state: 'hot' });
        break;
      }
      case 'raw': {
        const group = clone(event.group);
        need(group.firstOffset === nextDecimal(this.capturedOffset) && BigInt(group.lastOffset) - BigInt(group.firstOffset) + 1n === BigInt(group.count)
          && group.count > 0 && group.count <= this.limits.maxRawGroupRecords, 'INPUT_GAP', '原始到达索引不连续。');
        group.journalSequence = position.sequence; group.fencingToken = position.writer.fencingToken;
        this.touch(group.record, 'raw'); this.groups.push(group); this.entries += 1;
        this.capturedOffset = group.lastOffset; this.capturedReceivedAt = group.lastReceivedAt;
        break;
      }
      case 'prepare': {
        const candidate = clone(event.preparation), proof = candidate.proof;
        need(!this.preparations.has(proof.preparationId) && !this.committed.has(proof.preparationId)
          && proof.archiveId === this.archiveId && proof.fencingToken === position.writer.fencingToken, 'CORRUPT_INDEX', '候选身份或 writer 代际不匹配。');
        proof.journalSequence = position.sequence;
        this.touch(proof.record, candidate.kind === 'projection' ? 'checkpoints' : 'changes');
        this.preparations.set(proof.preparationId, candidate); this.entries += 1; break;
      }
      case 'abort':
        need(this.preparations.delete(event.preparationId), 'CORRUPT_INDEX', '不存在待放弃候选。'); this.entries -= 1; break;
      case 'commit': {
        const candidate = this.preparations.get(event.preparationId);
        need(candidate && candidate.proof.fencingToken === position.writer.fencingToken, 'FENCED', '不允许跨 writer 代际直接提交旧候选。');
        const proof = candidate.proof;
        const commit: DurableCommitProof = { kind: candidate.kind === 'projection' ? 'projection-activated' : 'state-committed',
          archiveId: this.archiveId, commitId: jsonHash([this.archiveId, proof.preparationId, position.sequence]),
          preparationId: proof.preparationId, projectionId: proof.projectionId, versionDigest: proof.versionDigest,
          inputCursor: clone(proof.inputCursor), committedStateCursor: clone(candidate.head.cursor),
          committedThroughTime: candidate.head.logicalTime, checksum: candidate.kind === 'projection' ? candidate.proof.checkpointChecksum : candidate.proof.batchChecksum,
          journalSequence: position.sequence, journalHash: position.hash, fencingToken: position.writer.fencingToken, durability: this.durability };
        if (candidate.kind === 'projection') {
          need(!this.projections.has(proof.projectionId), 'STATE_RESET_REQUIRED', 'projectionId 不得重复激活。');
          const checkpoint: CheckpointIndex = { projectionId: proof.projectionId, cursor: clone(candidate.head.cursor), logicalTime: candidate.head.logicalTime,
            checksum: candidate.proof.checkpointChecksum, record: clone(proof.record), journalSequence: position.sequence, durability: this.durability,
            inputCursor: clone(candidate.head.inputCursor), continuity: clone(candidate.head.continuity) };
          this.projections.set(proof.projectionId, { id: proof.projectionId, versionDigest: proof.versionDigest, versions: candidate.versions,
            dependencies: candidate.dependencies, activation: commit, initialProof: candidate.proof, checkpoints: [checkpoint], batches: [],
            head: candidate.head, retainedFrom: candidate.head.logicalTime, closed: false });
        } else {
          const projection = this.projection(proof.projectionId);
          need(!projection.closed && projection.head.cursor.stateRevision === candidate.proof.fromRevision
            && projection.versionDigest === proof.versionDigest && candidate.head.inputCursor.offset === nextDecimal(projection.head.inputCursor.offset),
          'REVISION_GAP', '提交水位不接续当前已提交状态。');
          projection.batches.push({ proof: candidate.proof, commit, firstTime: candidate.firstTime, head: candidate.head });
          projection.head = candidate.head;
        }
        this.preparations.delete(event.preparationId); this.committed.set(event.preparationId, { proof, commit });
        break;
      }
      case 'checkpoint': {
        const checkpoint = clone(event.checkpoint), projection = this.projection(checkpoint.projectionId);
        need(same(checkpoint.cursor, projection.head.cursor) && checkpoint.logicalTime === projection.head.logicalTime
          && same(checkpoint.inputCursor, projection.head.inputCursor) && same(checkpoint.continuity, projection.head.continuity),
        'CHECKPOINT_BOUNDARY', '检查点未对齐已提交状态边界。');
        this.touch(checkpoint.record, 'checkpoints'); checkpoint.journalSequence = position.sequence;
        const prior = projection.checkpoints[projection.checkpoints.length - 1];
        need(compareDecimal(checkpoint.cursor.stateRevision, prior.cursor.stateRevision) > 0, 'CHECKPOINT_BOUNDARY', '周期检查点必须前进。');
        projection.checkpoints.push(checkpoint); this.entries += 1; break;
      }
      case 'close-projection': this.projection(event.projectionId).closed = true; break;
      case 'seal': {
        const segment = this.segment(event.segmentId);
        need(!segment.sealed && segment.bytes === event.bytes, 'CORRUPT_INDEX', '封存段尺寸不匹配。');
        segment.sealed = true; segment.sha256 = event.sha256;
        this.file(segment.hotPath).sha256 = event.sha256; break;
      }
      case 'reserve-compressed': {
        need(!this.files.has(event.file.relativePath) && event.file.state === 'reserved', 'CORRUPT_INDEX', '压缩对象保留记录重复。');
        this.files.set(event.file.relativePath, clone(event.file)); this.#storedBytes += event.file.bytes; break;
      }
      case 'compressed': {
        const segment = this.segment(event.segmentId), file = this.file(event.file.relativePath);
        need(segment.sealed && !segment.cold && file.state === 'reserved' && same(event.file, { relativePath: file.relativePath, bytes: file.bytes, sha256: file.sha256 }),
          'CORRUPT_INDEX', '压缩提交没有匹配的持久准备记录。');
        segment.cold = clone(event.file); file.state = 'cold'; this.file(segment.hotPath).state = 'obsolete'; break;
      }
      case 'lease-open':
        need(!this.leases.has(event.lease.id), 'CORRUPT_INDEX', '查询租约身份重复。'); this.leases.set(event.lease.id, clone(event.lease)); break;
      case 'lease-close': this.leases.delete(event.leaseId); break;
      case 'retention': {
        const retention = clone(event.retention);
        need(!this.plans.has(retention.plan.planId), 'CORRUPT_INDEX', '留存计划身份重复。');
        retention.plan.journalSequence = position.sequence;
        for (const trim of retention.trims) {
          const projection = this.projection(trim.projectionId);
          if (trim.retire) this.projections.delete(projection.id);
          else {
            need(projection.checkpoints.some(checkpoint => checkpoint.cursor.stateRevision === trim.checkpointRevision), 'DEPENDENCY_MISSING', '留存恢复锚点不存在。');
            projection.checkpoints = projection.checkpoints.filter(checkpoint => compareDecimal(checkpoint.cursor.stateRevision, trim.checkpointRevision) >= 0);
            projection.batches = projection.batches.filter(batch => compareDecimal(batch.proof.toRevision, trim.checkpointRevision) > 0);
            projection.retainedFrom = Math.max(projection.retainedFrom, trim.retainedFrom);
          }
        }
        this.groups = this.groups.filter(group => compareDecimal(group.lastOffset, retention.dropRawThrough) > 0);
        this.rawFloor = retention.dropRawThrough;
        for (const id of retention.removeSegments) this.segments.delete(id);
        for (const id of retention.expiredLeases) this.leases.delete(id);
        this.plans.set(retention.plan.planId, retention); this.rebuildDerived(); break;
      }
      case 'forget-retention': {
        const plan = this.plans.get(event.planId);
        need(plan && plan.removedFiles.length === plan.plan.files.length, 'DELETE_PLAN_PENDING', '尚有文件未完成清理，不能撤掉持久计划。');
        this.plans.delete(event.planId); break;
      }
      case 'file-deleted': {
        const plan = this.plans.get(event.planId);
        need(plan && plan.plan.files.some(file => file.relativePath === event.relativePath), 'DELETE_PLAN', '文件未被持久删除计划标记。');
        const removed = this.files.get(event.relativePath);
        if (removed) {
          this.#storedBytes -= removed.bytes;
          if (removed.state === 'hot' || removed.state === 'obsolete') this.#hotBytes -= removed.bytes;
        }
        this.files.delete(event.relativePath);
        if (!plan.removedFiles.includes(event.relativePath)) plan.removedFiles.push(event.relativePath);
        break;
      }
      default: need(false, 'CORRUPT_INDEX', '不支持的提交日志类型。');
    }
    need(this.entries <= this.limits.maxIndexEntries, 'INDEX_CAPACITY', '归档索引达到预算，不能截断或静默驱逐历史。');
  }
  private touch(ref: HistoryRecordRef, expectedKind: SegmentKind): void {
    validateRecordRef(ref, this.limits.maxSegmentBytes);
    const segment = this.segment(ref.segmentId), offset = physicalOffset(ref.offset, this.limits.maxSegmentBytes);
    need(segment.kind === expectedKind && !segment.sealed && offset === segment.bytes, 'SEGMENT_GAP', '提交记录未紧接段的持久边界。');
    segment.bytes += ref.bytes; segment.records += 1; this.file(segment.hotPath).bytes = segment.bytes;
    this.#storedBytes += ref.bytes; this.#hotBytes += ref.bytes;
  }
  segment(id: string): SegmentIndex { const value = this.segments.get(id); need(value, 'DEPENDENCY_MISSING', '所需归档段不存在。', { id }); return value; }
  file(relative: string): OwnedFile { const value = this.files.get(relative); need(value, 'DEPENDENCY_MISSING', '文件未登记归档所有权。'); return value; }
  projection(id: string): ProjectionIndex { const value = this.projections.get(id); need(value, 'PROJECTION_NOT_FOUND', '投影尚未提交或已过保留窗口。', { projectionId: id }); return value; }
  export(): ArchiveCatalog {
    const catalog: ArchiveCatalog = { format: 'history-index/1', capturedOffset: this.capturedOffset, capturedReceivedAt: this.capturedReceivedAt, rawFloor: this.rawFloor,
      segments: [...this.segments.values()], files: [...this.files.values()], groups: this.groups, preparations: [...this.preparations.values()],
      projections: [...this.projections.values()], leases: [...this.leases.values()],
      plans: [...this.plans.values()] };
    return clone(catalog);
  }
  load(catalog: ArchiveCatalog): void {
    need(catalog.format === 'history-index/1', 'CORRUPT_CATALOG', '不支持的索引快照版本。');
    this.capturedOffset = catalog.capturedOffset; this.capturedReceivedAt = catalog.capturedReceivedAt; this.rawFloor = catalog.rawFloor;
    const assign = <T>(map: Map<string, T>, values: T[], key: (item: T) => string) => {
      map.clear(); for (const value of values) { const id = key(value); need(!map.has(id), 'CORRUPT_CATALOG', '索引快照含重复身份。'); map.set(id, value); }
    };
    assign(this.segments, catalog.segments, item => item.id); assign(this.files, catalog.files, item => item.relativePath);
    assign(this.preparations, catalog.preparations, item => item.proof.preparationId); assign(this.projections, catalog.projections, item => item.id);
    assign(this.leases, catalog.leases, item => item.id); assign(this.plans, catalog.plans, item => item.plan.planId);
    this.groups = catalog.groups; this.rebuildDerived();
  }
  private rebuildDerived(): void {
    this.committed.clear(); this.entries = this.groups.length + this.preparations.size;
    this.#storedBytes = 0; this.#hotBytes = 0;
    for (const file of this.files.values()) {
      this.#storedBytes += file.bytes;
      if (file.state === 'hot' || file.state === 'obsolete') this.#hotBytes += file.bytes;
    }
    for (const projection of this.projections.values()) {
      this.committed.set(projection.initialProof.preparationId, { proof: projection.initialProof, commit: projection.activation });
      for (const batch of projection.batches) this.committed.set(batch.proof.preparationId, { proof: batch.proof, commit: batch.commit });
      this.entries += projection.checkpoints.length + projection.batches.length;
    }
    need(this.entries <= this.limits.maxIndexEntries, 'INDEX_CAPACITY', '持久索引超过已配置容量。');
  }
}
