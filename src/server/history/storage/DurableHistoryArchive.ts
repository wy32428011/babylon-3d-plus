import { randomUUID } from 'node:crypto';
import { readCheckpoint } from '../../../runtime/history/state/codec.ts';
import { TwinStateKernel } from '../../../runtime/history/state/kernel.ts';
import { compareDecimal, nextDecimal } from '../../../runtime/history/state/safeJson.ts';
import type { StateBudgets } from '../../../runtime/history/state/safeJson.ts';
import type { StateAdapterRegistry } from '../../../runtime/history/state/adapters.ts';
import type { DeepReadonly, InputCursor, TwinCheckpoint } from '../../../runtime/history/state/types.ts';
import type {
  ArchiveLimits, ArchiveRecoveryNotice, ArchiveScope, ArchiveWatermarks, CapturePage, CaptureReadSession, CapturedReceipt,
  CheckpointReceipt, DurableCommitProof, DurableHistoryArchiveOptions, HistoryChangePage, HistoryDurability,
  HistoryReadSession, HistoryWriter, PrepareCommitRequest, PreparedCommitProof, PreparedProjectionProof,
  ProjectionDependencies, RawHistoryArrival, ReadSessionRequest, RecoveryResult, RetentionPlan, RetentionRequest, RetentionResult,
} from './types.ts';
import { HistoryStorageError } from './types.ts';
import { ArchiveFiles } from './files.ts';
import { ArchiveWriterLock } from './writerLock.ts';
import { ArchiveJournal } from './journal.ts';
import type { JournalPosition } from './journal.ts';
import { ArchiveIndex } from './metadata.ts';
import type { ArchiveCatalog, ArchiveEvent, CheckpointIndex, HeadIndex, LeaseIndex, RawGroupIndex, SegmentIndex } from './metadata.ts';
import { ArchiveSegments } from './segments.ts';
import { ArchiveQueries } from './queries.ts';
import { prepareRetention } from './retention.ts';
import { assertInputScope, dependencyClosure, normalizeArrival, validatePreparedInput } from './contracts.ts';
import type { RawGroupDocument, RawRecord, StateRecordDocument } from './contracts.ts';
import { checksum, clone, decimal, jsonHash, metadataReserve, need, pack, parse, resolveArchiveLimits, same, storageStateBudgets, timestamp, upperBound, validateRecordRef, validateScope } from './primitives.ts';

type Identity = { format: 'durable-history/1'; archiveId: string; scope: ArchiveScope; initialOffset: string; durability: HistoryDurability };
type PendingArrival = { record: Omit<RawRecord, 'inputCursor'>; bytes: number; resolve(value: CapturedReceipt): void; reject(error: unknown): void };
/**
 * Node 本地持久归档。只有该实例拥有写锁；所有写操作都经过外层持久 fencing gate。
 * 原始 fsync、候选 fsync、提交记录 fsync、内核内存 commit 是不同边界；本类从不调用 prepareInput().commit()。
 * 读取只看提交索引，不等待周期检查点/冷归档；查询固定版本、游标上界和租约，不重新执行来源请求。
 */
export class DurableHistoryArchive {
  readonly archiveId: string;
  readonly scope: Readonly<ArchiveScope>;
  readonly writer: Readonly<HistoryWriter>;
  readonly limits: Readonly<ArchiveLimits>;
  readonly durability: HistoryDurability;
  readonly #options: DurableHistoryArchiveOptions;
  readonly #files: ArchiveFiles;
  readonly #lock: ArchiveWriterLock;
  readonly #index: ArchiveIndex;
  readonly #registry: StateAdapterRegistry;
  readonly #stateBudgets: Readonly<StateBudgets>;
  readonly #checkpointBudgets: Readonly<StateBudgets>;
  readonly #notices: ArchiveRecoveryNotice[];
  #journal!: ArchiveJournal<ArchiveEvent>;
  #segments!: ArchiveSegments;
  #queries!: ArchiveQueries;
  #tail: Promise<unknown> = Promise.resolve();
  #mutated = false;
  #failure: unknown = null;
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | null = null;
  #queue: PendingArrival[] = [];
  #queuedBytes = 0;
  #queuedCount = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #flushing: Promise<void> | null = null;
  #compacting = false;
  #compactionDone: Promise<void> | null = null;
  private constructor(options: DurableHistoryArchiveOptions, files: ArchiveFiles, lock: ArchiveWriterLock,
    identity: Identity, limits: Readonly<ArchiveLimits>, notices: ArchiveRecoveryNotice[]) {
    this.#options = Object.freeze({ ...options }); this.#files = files; this.#lock = lock; this.archiveId = identity.archiveId;
    this.scope = Object.freeze(clone(identity.scope)); this.writer = Object.freeze(clone(options.writer));
    this.limits = limits; this.durability = identity.durability; this.#notices = notices;
    this.#registry = options.registry.snapshot();
    this.#stateBudgets = storageStateBudgets(options.stateBudgets, limits.maxBatchBytes);
    this.#checkpointBudgets = storageStateBudgets(options.stateBudgets, limits.maxCheckpointBytes);
    this.#index = new ArchiveIndex(identity.archiveId, clone(identity.scope), identity.initialOffset, identity.durability, limits);
  }
  /** 采集器必须与归档使用同一个持久 fencing gate。 */
  usesFencing(port: DurableHistoryArchiveOptions['fencing']): boolean { return this.#options.fencing === port; }

  static async open(options: DurableHistoryArchiveOptions): Promise<DurableHistoryArchive> {
    validateScope(options.scope, options.writer); decimal(options.initialOffset ?? '0', 'initialOffset');
    need(options.fencing && typeof options.fencing.runExclusive === 'function', 'FENCING_REQUIRED', '必须接入真实的持久 fencing 授权端口。');
    const limits = resolveArchiveLimits(options.limits), durability = options.durability ?? 'file-and-directory-fsync';
    need(['file-and-directory-fsync', 'file-fsync'].includes(durability), 'DURABILITY', '不支持的持久性级别。');
    // 创建目录、所有权变更和恢复尾部也在同一个持久 gate 内，不允许旧 writer 迟到写入。
    return options.fencing.runExclusive(clone(options.scope), clone(options.writer), async () => {
      const { files, domain } = await ArchiveFiles.prepareRoot(options.rootDirectory, options.scope, durability);
      const acquired = await ArchiveWriterLock.acquire(domain, options.scope, options.writer, durability, options.reclaimAbandonedWriter);
      const notices: ArchiveRecoveryNotice[] = acquired.reclaimed ? [{ kind: 'abandoned-writer-reclaimed', relativePath: '.history-writer.json', discardedBytes: 0 }] : [];
      try {
        let identity: Identity;
        if (await files.exists('identity.json')) {
          identity = parse<Identity>(await files.read('identity.json', 16_384), 16_384);
          need(identity.format === 'durable-history/1' && same(identity.scope, options.scope) && identity.durability === durability
            && (options.initialOffset === undefined || identity.initialOffset === options.initialOffset), 'ARCHIVE_IDENTITY', '目录中的作用域、初始 offset 或持久性合同不匹配。');
          decimal(identity.initialOffset); need(typeof identity.archiveId === 'string' && /^[a-f0-9-]{36}$/u.test(identity.archiveId), 'ARCHIVE_IDENTITY', '归档身份损坏。');
        } else {
          const knownFiles = [...await files.list('journal', limits.maxIndexEntries), ...await files.list('segments', limits.maxIndexEntries), ...await files.list('catalog', limits.maxIndexEntries)];
          need(knownFiles.length === 0, 'ARCHIVE_IDENTITY', '已有数据而缺少归档身份，禁止初始化空状态覆盖。');
          identity = { format: 'durable-history/1', archiveId: randomUUID(), scope: clone(options.scope), initialOffset: options.initialOffset ?? '0', durability };
          await files.create('identity.json', pack(identity, 16_384));
        }
        const archive = new DurableHistoryArchive(options, files, acquired.lock, identity, limits, notices);
        archive.#journal = await ArchiveJournal.open<ArchiveEvent, ArchiveCatalog>(files, identity.archiveId, limits, options.writer,
          state => archive.#index.load(state), (event, position) => archive.#index.apply(event, position), notices);
        const knownMetadata = archive.#journal.knownMetadataPaths;
        let reservedMetadataBytes = metadataReserve(limits);
        for (const relative of [...await files.list('journal', limits.maxIndexEntries), ...await files.list('catalog', limits.maxIndexEntries),
          ...await files.list('segments', limits.maxIndexEntries)]) {
          // 未公布 catalog/temp/未知段不供查询，也不猜测删除；计入实际磁盘背压，等待显式运维处置。
          if (!knownMetadata.has(relative) && !archive.#index.files.has(relative)) reservedMetadataBytes += await files.size(relative);
        }
        need(Number.isSafeInteger(reservedMetadataBytes) && reservedMetadataBytes < limits.maxStoredBytes,
          'STORAGE_BACKPRESSURE', '孤立元数据及换代预留达到总存储预算；没有执行目录清理。');
        archive.#segments = new ArchiveSegments(files, archive.#index, limits, event => archive.#append(event),
          () => { archive.#mutated = true; }, reservedMetadataBytes);
        archive.#validateRecoveredIndex();
        await archive.#segments.recover(notices);
        archive.#queries = new ArchiveQueries({ index: archive.#index, files, limits, registry: archive.#registry,
          stateBudgets: archive.#stateBudgets, checkpointBudgets: archive.#checkpointBudgets, durability,
          assertHealthy: () => { archive.#assertHealthy(); need(!archive.#closing, 'ARCHIVE_CLOSED', '归档正在关闭，不再接受查询。'); },
          persistLease: lease => archive.#persistLease(lease),
          releaseLease: id => archive.#write(async () => { await archive.#append({ kind: 'lease-close', leaseId: id }); }, true) });
        await archive.#journal.cleanupCatalog();
        return archive;
      } catch (error) {
        try { await acquired.lock.release(); }
        catch (releaseError) { throw new HistoryStorageError('OPEN_FAILED', '归档恢复失败且自有 writer 锁未能释放；不得猜测偷锁。', { cause: String(error), releaseError: String(releaseError) }); }
        throw error;
      }
    });
  }
  get recoveryNotices(): readonly ArchiveRecoveryNotice[] { return clone(this.#notices); }
  #assertHealthy(): void {
    need(!this.#closed, 'ARCHIVE_CLOSED', '归档已关闭。');
    if (this.#failure !== null) throw new HistoryStorageError('RECOVERY_REQUIRED', '发生持久 I/O、校验或 fencing 失败，必须关闭并恢复后再确认任何输入。', { cause: String(this.#failure) });
  }
  #write<T>(operation: () => Promise<T>, allowClosing = false): Promise<T> {
    const work = this.#tail.then(async () => {
      this.#assertHealthy(); need(allowClosing || !this.#closing, 'ARCHIVE_CLOSED', '归档正在关闭。'); this.#mutated = false;
      let entered = false, calls = 0;
      try {
        const result = await this.#options.fencing.runExclusive(this.scope, this.writer, async () => {
          calls += 1; need(calls === 1, 'FENCING_CONTRACT', '持久授权端口不得自动重跑磁盘写入回调。');
          await this.#lock.assertOwned(); entered = true; return operation();
        });
        need(calls === 1, 'FENCING_CONTRACT', '持久授权端口没有执行受保护的提交回调。'); return result;
      } catch (error) {
        if (!entered || this.#mutated || (error instanceof HistoryStorageError && ['FENCED', 'FENCING_CONTRACT', 'WRITER_LOCK', 'WRITER_LOCKED', 'CHECKSUM', 'DEPENDENCY_MISSING', 'CORRUPT_FILE'].includes(error.code))) this.#failure = error;
        throw error;
      }
    });
    this.#tail = work.then(() => undefined, () => undefined); return work;
  }
  async #append(event: ArchiveEvent): Promise<JournalPosition> {
    const threshold = Math.min(Math.floor(this.limits.maxJournalReplayBytes / 2), this.limits.maxJournalSegmentBytes * 8);
    if (this.#journal.bytesSinceCatalog >= threshold) { this.#mutated = true; await this.#journal.checkpoint(this.#index.export()); }
    this.#mutated = true; return this.#journal.append(event, this.writer);
  }
  /** Promise 只在原始组文件和其提交索引均 fsync 后 resolve；调用方此后才可 MQTT ACK/HTTP确认。 */
  appendArrival(arrival: RawHistoryArrival): Promise<CapturedReceipt> {
    try {
      this.#assertHealthy(); need(!this.#closing, 'ARCHIVE_CLOSED', '归档正在关闭，不接受新到达。');
      const record = { ...normalizeArrival(arrival, this.limits), id: randomUUID() };
      const bytes = pack(record, this.limits.maxRawGroupBytes).byteLength + 2048;
      need(bytes + 4096 <= this.limits.maxRawGroupBytes, 'ARRIVAL_BUDGET', '单条原始 envelope 超过 group commit 预算。');
      need(this.#queuedCount + 1 <= this.limits.maxQueuedArrivals && this.#queuedBytes + bytes <= this.limits.maxQueuedArrivalBytes,
        'CAPTURE_BACKPRESSURE', '持久接收队列已满；调用方必须背压或显式记录缺口，不能确认后丢弃。');
      return new Promise<CapturedReceipt>((resolve, reject) => {
        this.#queue.push({ record, bytes, resolve, reject }); this.#queuedBytes += bytes; this.#queuedCount += 1;
        this.#scheduleFlush(this.#queue.length >= this.limits.maxRawGroupRecords ? 0 : this.limits.groupCommitDelayMs);
      });
    } catch (error) { return Promise.reject(error); }
  }
  #scheduleFlush(delay: number): void {
    if (this.#flushing || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      // 所有失败同时传回每个接收 Promise，并令实例停止确认；这里只消费重复的计时器 Promise 拒绝。
      void this.#flushOne().catch(() => undefined);
    }, delay);
  }
  #flushOne(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    if (!this.#queue.length) return Promise.resolve();
    const pending: PendingArrival[] = []; let bytes = 4096;
    while (this.#queue.length && pending.length < this.limits.maxRawGroupRecords && bytes + this.#queue[0].bytes <= this.limits.maxRawGroupBytes) {
      const entry = this.#queue.shift()!; pending.push(entry); bytes += entry.bytes;
    }
    need(pending.length > 0, 'ARRIVAL_BUDGET', '队首记录不能进入有界提交组。');
    this.#flushing = this.#write(async () => {
      let offset = this.#index.capturedOffset;
      const records: RawRecord[] = pending.map(entry => {
        offset = nextDecimal(offset); return { ...entry.record, inputCursor: { captureDomainId: this.scope.captureDomainId, captureEpoch: this.scope.captureEpoch, offset } };
      });
      let minReceivedAt = records[0].receivedAt, maxReceivedAt = minReceivedAt;
      for (const item of records) { minReceivedAt = Math.min(minReceivedAt, item.receivedAt); maxReceivedAt = Math.max(maxReceivedAt, item.receivedAt); }
      const document: RawGroupDocument = { format: 'history-raw/1', archiveId: this.archiveId, scope: clone(this.scope), records };
      const record = await this.#segments.append('raw', pack(document, this.limits.maxRawGroupBytes));
      const group: RawGroupIndex = { firstOffset: records[0].inputCursor.offset, lastOffset: offset, count: records.length,
        minReceivedAt, maxReceivedAt, lastReceivedAt: records[records.length - 1].receivedAt, record, journalSequence: '0', fencingToken: this.writer.fencingToken };
      const position = await this.#append({ kind: 'raw', group });
      return records.map((item, recordIndex): CapturedReceipt => ({ kind: 'captured', archiveId: this.archiveId,
        inputCursor: clone(item.inputCursor), receivedAt: item.receivedAt, record: clone(record), recordIndex,
        journalSequence: position.sequence, fencingToken: position.writer.fencingToken, durability: this.durability }));
    }, true).then(receipts => { pending.forEach((entry, index) => entry.resolve(receipts[index])); }, error => {
      for (const entry of pending) entry.reject(error);
      // 不把同一 writer 的后续队列悄悄移到另一代；每个未确认到达都明确失败。
      for (const entry of this.#queue.splice(0)) { entry.reject(error); this.#queuedCount -= 1; this.#queuedBytes -= entry.bytes; }
      throw error;
    }).finally(() => {
      this.#queuedCount -= pending.length; this.#queuedBytes -= pending.reduce((total, entry) => total + entry.bytes, 0);
      this.#flushing = null; if (this.#queue.length) this.#scheduleFlush(0);
    });
    return this.#flushing;
  }
  async flush(): Promise<void> {
    this.#assertHealthy(); if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    while (this.#queue.length || this.#flushing) await this.#flushOne();
  }
  #captured(cursor: DeepReadonly<InputCursor>, allowInitial = false): void {
    assertInputScope(cursor, this.scope);
    if (allowInitial && cursor.offset === this.#index.initialOffset) return;
    need(compareDecimal(cursor.offset, this.#index.capturedOffset) <= 0 && compareDecimal(cursor.offset, this.#index.rawFloor) > 0,
      'INPUT_NOT_DURABLE', '输入尚未持久接收或其原始证据已过保留期。');
    const position = upperBound(this.#index.groups, group => compareDecimal(group.lastOffset, cursor.offset) < 0), group = this.#index.groups[position];
    need(group && compareDecimal(group.firstOffset, cursor.offset) <= 0, 'INPUT_GAP', '输入对应的原始到达证据缺失。');
  }
  async prepareProjection(value: DeepReadonly<TwinCheckpoint>, dependencies: ProjectionDependencies): Promise<PreparedProjectionProof> {
    return this.#write(async () => {
      const checkpoint = readCheckpoint(value, this.#registry, { budgets: this.#checkpointBudgets }), state = checkpoint.state, metadata = state.metadata;
      need(state.versions.projectId === this.scope.projectId && metadata.cursor.stateRevision === '0'
        && metadata.logicalTime === metadata.baseline.asOf && same(metadata.inputCursor, metadata.baseline.inputCursor)
        && metadata.continuity.status === 'complete', 'BASELINE_REQUIRED', '新投影必须以权威对齐的完整 revision 0 检查点开始，不允许补空基线。');
      this.#captured(metadata.inputCursor, true);
      need(!this.#index.projections.has(metadata.projectionId), 'STATE_RESET_REQUIRED', 'projectionId 已激活，版本/基线切换必须创建新投影。');
      const locked = dependencyClosure(dependencies, state.versions, this.limits.maxDependencies), versionDigest = jsonHash(state.versions);
      const preparationId = jsonHash(['projection', this.archiveId, metadata.projectionId, this.writer.fencingToken, checkpoint.checksum.value, locked]);
      const previous = this.#index.preparations.get(preparationId);
      if (previous) { need(previous.kind === 'projection', 'PREPARATION_MISMATCH', '候选身份冲突。'); return clone(previous.proof); }
      const record = await this.#segments.append('checkpoints', pack(checkpoint, this.limits.maxCheckpointBytes));
      const proof: PreparedProjectionProof = { kind: 'projection-prepared', archiveId: this.archiveId, preparationId, projectionId: metadata.projectionId,
        versionDigest, checkpointChecksum: checkpoint.checksum.value, inputCursor: clone(metadata.inputCursor), cursor: clone(metadata.cursor),
        logicalTime: metadata.logicalTime, record, journalSequence: '0', fencingToken: this.writer.fencingToken, durability: this.durability };
      const head: HeadIndex = { cursor: clone(metadata.cursor), inputCursor: clone(metadata.inputCursor), logicalTime: metadata.logicalTime,
        continuity: clone(metadata.continuity), completeCursor: clone(metadata.cursor), completeTime: metadata.logicalTime };
      await this.#append({ kind: 'prepare', preparation: { kind: 'projection', proof, versions: state.versions, dependencies: locked, head } });
      return clone(this.#index.preparations.get(preparationId)!.proof) as PreparedProjectionProof;
    });
  }
  async activateProjection(proof: PreparedProjectionProof): Promise<DurableCommitProof> { return this.#commit(proof); }
  async prepareCommit(request: PrepareCommitRequest): Promise<PreparedCommitProof> {
    return this.#write(async () => {
      const projection = this.#index.projection(request.batch.projectionId);
      need(!projection.closed, 'PROJECTION_CLOSED', '已关闭投影不能继续提交业务变化。');
      const candidate = validatePreparedInput(request, projection.head, this.scope, projection.versions, this.#stateBudgets);
      this.#captured(candidate.input.cursor);
      const preparationId = jsonHash(['state', this.archiveId, projection.id, this.writer.fencingToken, candidate.batch.checksum.value, jsonHash(candidate.input)]);
      const previous = this.#index.preparations.get(preparationId);
      if (previous) { need(previous.kind === 'state', 'PREPARATION_MISMATCH', '候选身份冲突。'); return clone(previous.proof); }
      const document: StateRecordDocument = { format: 'history-state/1', input: candidate.input, batch: candidate.batch };
      const record = await this.#segments.append('changes', pack(document, this.limits.maxBatchBytes));
      const proof: PreparedCommitProof = { kind: 'state-prepared', archiveId: this.archiveId, preparationId, projectionId: projection.id,
        versionDigest: projection.versionDigest, inputCursor: clone(candidate.input.cursor), fromRevision: candidate.batch.fromRevision,
        toRevision: candidate.batch.toRevision, throughTime: candidate.batch.throughTime, batchChecksum: candidate.batch.checksum.value,
        record, journalSequence: '0', fencingToken: this.writer.fencingToken, durability: this.durability };
      await this.#append({ kind: 'prepare', preparation: { kind: 'state', proof, head: candidate.head, firstTime: candidate.batch.revisions[0].logicalTime } });
      return clone(this.#index.preparations.get(preparationId)!.proof) as PreparedCommitProof;
    });
  }
  async commitPrepared(proof: PreparedCommitProof): Promise<DurableCommitProof> { return this.#commit(proof); }
  #commit(proof: PreparedCommitProof | PreparedProjectionProof): Promise<DurableCommitProof> {
    return this.#write(async () => {
      const committed = this.#index.committed.get(proof.preparationId);
      if (committed) { need(same(committed.proof, proof), 'PREPARATION_MISMATCH', '幂等提交证明不匹配。'); return clone(committed.commit); }
      const candidate = this.#index.preparations.get(proof.preparationId);
      need(candidate && same(candidate.proof, proof) && proof.archiveId === this.archiveId, 'PREPARATION_MISMATCH', '候选准备证明不存在或内容被修改。');
      need(proof.fencingToken === this.writer.fencingToken, 'FENCED', '旧 writer 的候选不能被直接提交；新 owner 必须重新准备并验证。');
      if (candidate.kind === 'state') {
        const projection = this.#index.projection(proof.projectionId);
        need(!projection.closed && projection.head.cursor.stateRevision === candidate.proof.fromRevision
          && candidate.proof.inputCursor.offset === nextDecimal(projection.head.inputCursor.offset), 'STALE_PREPARATION', '已有其他提交前进了水位；该候选只能放弃。');
      } else need(!this.#index.projections.has(proof.projectionId), 'STATE_RESET_REQUIRED', '投影已经激活。');
      await this.#append({ kind: 'commit', preparationId: proof.preparationId });
      return clone(this.#index.committed.get(proof.preparationId)!.commit);
    });
  }
  async abortPrepared(preparationId: string): Promise<void> {
    await this.#write(async () => {
      need(!this.#index.committed.has(preparationId), 'ALREADY_COMMITTED', '已提交业务事实不能冒充未提交候选撤销。');
      if (this.#index.preparations.has(preparationId)) await this.#append({ kind: 'abort', preparationId });
    });
  }
  getCommit(preparationId: string): DurableCommitProof | null { this.#assertHealthy(); return clone(this.#index.committed.get(preparationId)?.commit ?? null); }
  listPrepared(): (PreparedCommitProof | PreparedProjectionProof)[] { this.#assertHealthy(); return [...this.#index.preparations.values()].map(item => clone(item.proof)); }
  async putCheckpoint(value: DeepReadonly<TwinCheckpoint>): Promise<CheckpointReceipt> {
    return this.#write(async () => {
      const projection = this.#index.projection(value.state.metadata.projectionId);
      const checkpoint = readCheckpoint(value, this.#registry, { budgets: this.#checkpointBudgets, expectedVersions: projection.versions });
      const metadata = checkpoint.state.metadata, last = projection.checkpoints[projection.checkpoints.length - 1];
      if (same(last.cursor, metadata.cursor)) {
        need(last.checksum === checkpoint.checksum.value, 'CHECKPOINT_CONFLICT', '同一检查点边界对应不同状态。'); return clone(last);
      }
      need(same(metadata.cursor, projection.head.cursor) && same(metadata.inputCursor, projection.head.inputCursor)
        && metadata.logicalTime === projection.head.logicalTime && same(metadata.continuity, projection.head.continuity),
      'CHECKPOINT_BOUNDARY', '周期检查点必须对齐当前完整持久提交，不能发布内存候选。');
      const record = await this.#segments.append('checkpoints', pack(checkpoint, this.limits.maxCheckpointBytes));
      const receipt: CheckpointIndex = { projectionId: projection.id, cursor: clone(metadata.cursor), logicalTime: metadata.logicalTime,
        inputCursor: clone(metadata.inputCursor), continuity: clone(metadata.continuity), checksum: checkpoint.checksum.value,
        record, journalSequence: '0', durability: this.durability };
      await this.#append({ kind: 'checkpoint', checkpoint: receipt }); return clone(projection.checkpoints[projection.checkpoints.length - 1]);
    });
  }
  async closeProjection(projectionId: string): Promise<void> {
    await this.#write(async () => {
      const projection = this.#index.projection(projectionId);
      need(![...this.#index.preparations.values()].some(item => item.proof.projectionId === projectionId), 'PREPARATION_PENDING', '关闭投影前须提交或放弃其候选。');
      if (!projection.closed) await this.#append({ kind: 'close-projection', projectionId });
    });
  }
  getWatermarks(): ArchiveWatermarks {
    this.#assertHealthy(); let archived: InputCursor | null = null;
    for (const group of this.#index.groups) {
      if (!this.#index.segment(group.record.segmentId).cold) break;
      archived = { captureDomainId: this.scope.captureDomainId, captureEpoch: this.scope.captureEpoch, offset: group.lastOffset };
    }
    return { archiveId: this.archiveId, scope: clone(this.scope), capturedThrough: this.#index.capturedCursor, capturedReceivedAt: this.#index.capturedReceivedAt,
      archivedThrough: archived, durability: this.durability, journalSequence: this.#journal.position.sequence,
      projections: [...this.#index.projections.values()].map(projection => {
        const checkpoint = projection.checkpoints[projection.checkpoints.length - 1];
        return { projectionId: projection.id, versions: clone(projection.versions), committedStateCursor: clone(projection.head.cursor),
          committedThroughTime: projection.head.logicalTime, checkpointCursor: clone(checkpoint.cursor), checkpointTime: checkpoint.logicalTime,
          queryableThrough: projection.head.completeTime, queryableCursor: clone(projection.head.completeCursor),
          continuity: clone(projection.head.continuity), retainedFrom: projection.retainedFrom, closed: projection.closed };
      }) };
  }
  /** 仅查分段索引，返回 <= target 的最近检查点；读取内容须先开带 pin 的会话。 */
  findCheckpoint(projectionId: string, targetTime: number): CheckpointReceipt {
    this.#assertHealthy(); timestamp(targetTime); const projection = this.#index.projection(projectionId);
    need(targetTime >= projection.retainedFrom && targetTime <= projection.head.completeTime, 'TIME_NOT_QUERYABLE', '目标不在连续可查询保留窗口。');
    const position = upperBound(projection.checkpoints, checkpoint => checkpoint.logicalTime <= targetTime
      && compareDecimal(checkpoint.cursor.stateRevision, projection.head.completeCursor.stateRevision) <= 0);
    need(position > 0, 'CHECKPOINT_MISSING', '目标之前没有完整检查点。'); return clone(projection.checkpoints[position - 1]);
  }
  openReadSession(request: ReadSessionRequest): Promise<HistoryReadSession> { return this.#queries.open(request); }
  readCheckpoint(sessionId: string, signal?: AbortSignal): Promise<DeepReadonly<TwinCheckpoint>> { return this.#queries.checkpoint(sessionId, signal); }
  readChanges(sessionId: string, pageCursor: string, signal?: AbortSignal): Promise<HistoryChangePage> { return this.#queries.changes(sessionId, pageCursor, signal); }
  openCaptureSession(after: InputCursor, options: { through?: InputCursor; ttlMs?: number; maxPages?: number; maxReadBytes?: number; maxPageBytes?: number } = {}): Promise<CaptureReadSession> {
    return this.#queries.openCapture(after, options);
  }
  readCaptured(sessionId: string, pageCursor: string, options: { maxRecords?: number; signal?: AbortSignal } = {}): Promise<CapturePage> { return this.#queries.captured(sessionId, pageCursor, options); }
  /** 返回该固定租约的实际解压读取和分页用量；调用方可据此累计会话总预算。 */
  getReadSessionUsage(sessionId: string): { readBytes: number; pages: number } { return this.#queries.usage(sessionId); }
  closeReadSession(sessionId: string): Promise<void> { return this.#queries.close(sessionId); }
  async #persistLease(lease: LeaseIndex): Promise<void> {
    await this.#write(async () => {
      let active = 0; const expired: string[] = [], now = Date.now();
      for (const item of this.#index.leases.values()) { if (item.expiresAt > now) active += 1; else expired.push(item.id); }
      need(active < this.limits.maxSessions && lease.expiresAt > now, 'SESSION_CAPACITY', '并发查询租约超限或在准备时已过期。');
      if (lease.projectionId) this.#index.projection(lease.projectionId);
      for (const id of lease.segmentIds) this.#index.segment(id);
      for (const id of expired) await this.#append({ kind: 'lease-close', leaseId: id });
      await this.#append({ kind: 'lease-open', lease });
    });
  }
  /** 恢复只应用已提交 canonical 变化，不调用任何设备 reducer 或业务 Fetch。 */
  async recoverProjection(projectionId: string, signal?: AbortSignal): Promise<RecoveryResult> {
    const session = await this.openReadSession({ mode: 'recovery', projectionId,
      maxReadBytes: Math.min(this.limits.maxRecoveryBytes, this.limits.maxReadBytesPerSession),
      maxPages: Math.min(this.limits.maxRecoveryPages, this.limits.maxPagesPerSession) });
    try {
      const checkpoint = await this.readCheckpoint(session.sessionId, signal);
      const kernel = TwinStateKernel.fromCheckpoint(checkpoint, this.#registry, { mode: 'canonical-follower', budgets: this.#checkpointBudgets, expectedVersions: session.versions });
      let cursor: string | null = session.pageCursor;
      while (cursor !== null) {
        const page = await this.readChanges(session.sessionId, cursor, signal);
        for (const batch of page.batches) kernel.applyChangeBatch(batch);
        cursor = page.nextCursor;
      }
      need(same(kernel.metadata.cursor, session.toCursor), 'RECOVERY_GAP', '恢复没有达到固定持久提交上界。');
      const usage = this.#queries.usage(session.sessionId);
      return { checkpoint: kernel.checkpoint(), committedStateCursor: clone(kernel.metadata.cursor), capturedThrough: this.#index.capturedCursor,
        unprocessedAfter: clone(kernel.metadata.inputCursor), readBytes: usage.readBytes, pages: usage.pages };
    } finally { await this.closeReadSession(session.sessionId); }
  }
  /** 压缩计算在写 gate 外；只在公布压缩文件/索引时短暂进入提交队列。不会替换热提交水位。 */
  async compact(options: { maxSegments?: number; sealActive?: boolean } = {}): Promise<{ archivedSegmentIds: string[] }> {
    this.#assertHealthy(); need(!this.#compacting, 'COMPACTION_BUSY', '已有冷归档维护正在运行。');
    const maximum = options.maxSegments ?? this.limits.maxCompactionSegments;
    need(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= this.limits.maxCompactionSegments, 'BUDGET', '压缩段数超出预算。');
    this.#compacting = true;
    let finishCompaction!: () => void;
    this.#compactionDone = new Promise<void>(resolve => { finishCompaction = resolve; });
    let leaseId: string | null = null;
    try {
      const candidates = await this.#write(async () => {
        if (options.sealActive !== false) await this.#segments.sealActive();
        const selected = [...this.#index.segments.values()].filter(segment => segment.sealed && !segment.cold && segment.bytes > 0)
          .slice(0, maximum).map(segment => clone(segment));
        if (selected.length) {
          leaseId = randomUUID();
          // 此持久租约是维护 pin，不是 writer 授权；超时不用于抢写锁。
          await this.#append({ kind: 'lease-open', lease: { id: leaseId, runtimeId: this.#queries.runtimeId, expiresAt: Date.now() + this.limits.maxSessionTtlMs,
            segmentIds: selected.map(segment => segment.id), projectionId: null, dependencies: [] } });
        }
        return selected;
      });
      const archivedSegmentIds: string[] = [];
      for (const segment of candidates) {
        const candidate = await this.#segments.compressCandidate(segment);
        await this.#write(async () => {
          need(leaseId !== null && (this.#index.leases.get(leaseId)?.expiresAt ?? 0) > Date.now(), 'COMPACTION_EXPIRED', '压缩维护租约过期；不公布迟到结果。');
          const relative = `segments/${segment.kind}-${segment.id}.gz`;
          need(![...this.#index.plans.values()].some(plan => plan.plan.files.some(file => file.relativePath === relative) && !plan.removedFiles.includes(relative)),
            'DELETE_PLAN_PENDING', '压缩目标仍在持久删除计划中，先完成该计划再重试。');
          await this.#segments.commitCompressed(candidate);
        });
        archivedSegmentIds.push(segment.id);
      }
      return { archivedSegmentIds };
    } finally {
      try {
        if (leaseId !== null && this.#failure === null) await this.#write(async () => { await this.#append({ kind: 'lease-close', leaseId: leaseId! }); }, true);
      } finally { this.#compacting = false; this.#compactionDone = null; finishCompaction(); }
    }
  }
  /** 持久提交留存窗口/依赖裁剪；物理删除必须另外调用 applyRetention。外部资源只返回引用，不做删除。 */
  async planRetention(request: RetentionRequest): Promise<RetentionPlan> {
    await this.flush();
    return this.#write(async () => {
      need(this.#index.plans.size < this.limits.maxIndexEntries, 'INDEX_CAPACITY', '留存计划达到索引预算；外层确认已完成计划后再释放其记录。');
      await this.#segments.sealActive();
      const retention = await prepareRetention(this.#index, this.#files, this.limits, request, this.#queries.pinnedSegments());
      await this.#append({ kind: 'retention', retention }); return clone(this.#index.plans.get(retention.plan.planId)!.plan);
    });
  }
  async applyRetention(planId: string): Promise<RetentionResult> {
    return this.#write(async () => {
      const retention = this.#index.plans.get(planId); need(retention, 'DELETE_PLAN', '不存在该持久留存计划。');
      const removedFiles: string[] = [...retention.removedFiles], deferredFiles: string[] = [];
      for (const file of retention.plan.files) {
        if (retention.removedFiles.includes(file.relativePath)) continue;
        const owned = this.#index.files.get(file.relativePath);
        need(owned, 'DELETE_PLAN', '待删除对象已失去任务所有权登记。');
        if (this.#queries.pinnedSegments().has(owned.segmentId)) { deferredFiles.push(file.relativePath); continue; }
        this.#mutated = true;
        await this.#files.removeExact(file, this.limits.maxSegmentBytes + 65_536);
        await this.#append({ kind: 'file-deleted', planId, relativePath: file.relativePath }); removedFiles.push(file.relativePath);
      }
      return { planId, removedFiles, deferredFiles };
    });
  }
  listRetentionPlans(): RetentionPlan[] { this.#assertHealthy(); return [...this.#index.plans.values()].map(item => clone(item.plan)); }
  /** 外层完成依赖引用事务之后才能调用；无此确认时，完成的计划仍跨重启保存，供超时重试。 */
  async acknowledgeRetention(planId: string): Promise<void> {
    await this.#write(async () => {
      const plan = this.#index.plans.get(planId); if (!plan) return;
      need(plan.removedFiles.length === plan.plan.files.length, 'DELETE_PLAN_PENDING', '尚有文件被租约保留或未删除。');
      await this.#append({ kind: 'forget-retention', planId });
    });
  }
  async checkpointCatalog(): Promise<{ sequence: string; removedFiles: string[] }> {
    return this.#write(async () => { this.#mutated = true; return this.#journal.checkpoint(this.#index.export()); });
  }
  #validateRecoveredIndex(): void {
    for (const segment of this.#index.segments.values()) {
      need(/^[a-f0-9-]{36}$/u.test(segment.id) && ['raw', 'changes', 'checkpoints'].includes(segment.kind)
        && segment.hotPath === `segments/${segment.kind}-${segment.id}.wal`
        && (!segment.cold || segment.cold.relativePath === `segments/${segment.kind}-${segment.id}.gz`),
      'CORRUPT_INDEX', '段路径不属于该归档分配的文件类型。');
    }
    for (const file of this.#index.files.values()) {
      const match = /^segments\/(raw|changes|checkpoints)-([a-f0-9-]{36})\.(wal|gz)$/u.exec(file.relativePath);
      need(match && match[2] === file.segmentId && Number.isSafeInteger(file.bytes) && file.bytes >= 0
        && ['reserved', 'hot', 'cold', 'obsolete'].includes(file.state), 'CORRUPT_INDEX', '文件所有权目录含非任务段或非法尺寸。');
    }
    decimal(this.#index.capturedOffset); decimal(this.#index.rawFloor);
    let offset = this.#index.rawFloor;
    for (const group of this.#index.groups) {
      need(group.firstOffset === nextDecimal(offset) && BigInt(group.lastOffset) - BigInt(group.firstOffset) + 1n === BigInt(group.count), 'INPUT_GAP', '恢复索引中的原始组不连续。');
      this.#validateRef(group.record, 'raw'); offset = group.lastOffset;
    }
    need(offset === this.#index.capturedOffset, 'INPUT_GAP', '捕获水位没有完整原始索引支持。');
    for (const projection of this.#index.projections.values()) {
      need(projection.versions.projectId === this.scope.projectId && jsonHash(projection.versions) === projection.versionDigest
        && projection.checkpoints.length > 0, 'VERSION_MISMATCH', '投影版本或恢复锚点损坏。');
      dependencyClosure(projection.dependencies, projection.versions, this.limits.maxDependencies);
      let revision = projection.checkpoints[0].cursor.stateRevision, time = projection.checkpoints[0].logicalTime;
      for (const checkpoint of projection.checkpoints) {
        this.#validateRef(checkpoint.record, 'checkpoints'); assertInputScope(checkpoint.inputCursor, this.scope); checksum(checkpoint.checksum);
        need(checkpoint.projectionId === projection.id && checkpoint.cursor.projectionId === projection.id
          && compareDecimal(checkpoint.cursor.stateRevision, revision) >= 0 && checkpoint.logicalTime >= time, 'CHECKPOINT_BOUNDARY', '检查点索引顺序损坏。');
        revision = checkpoint.cursor.stateRevision; time = checkpoint.logicalTime;
      }
      revision = projection.checkpoints[0].cursor.stateRevision; time = projection.checkpoints[0].logicalTime;
      for (const batch of projection.batches) {
        this.#validateRef(batch.proof.record, 'changes'); assertInputScope(batch.proof.inputCursor, this.scope);
        need(batch.proof.projectionId === projection.id && batch.proof.versionDigest === projection.versionDigest
          && batch.proof.fromRevision === revision && compareDecimal(batch.proof.toRevision, revision) > 0 && batch.firstTime >= time
          && batch.proof.throughTime >= batch.firstTime, 'REVISION_GAP', '恢复索引中的变化范围不连续。');
        revision = batch.proof.toRevision; time = batch.proof.throughTime;
      }
      need(revision === projection.head.cursor.stateRevision && time === projection.head.logicalTime, 'REVISION_GAP', '状态提交水位没有连续变化依赖支持。');
      assertInputScope(projection.head.inputCursor, this.scope);
      need(compareDecimal(projection.head.inputCursor.offset, this.#index.capturedOffset) <= 0, 'INPUT_NOT_DURABLE', '状态水位领先于原始持久接收水位。');
    }
    for (const preparation of this.#index.preparations.values()) this.#validateRef(preparation.proof.record, preparation.kind === 'projection' ? 'checkpoints' : 'changes');
  }
  #validateRef(ref: { segmentId: string; offset: string; bytes: number; sha256: string }, kind: SegmentIndex['kind']): void {
    validateRecordRef(ref, this.limits.maxSegmentBytes); const segment = this.#index.segment(ref.segmentId);
    need(segment.kind === kind && BigInt(ref.offset) + BigInt(ref.bytes) <= BigInt(segment.bytes), 'CORRUPT_INDEX', '记录引用超出已提交段。');
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
      let failure: unknown = null;
      try { await this.flush(); } catch (error) { failure = error; }
      await this.#tail;
      if (this.#compactionDone) await this.#compactionDone;
      await this.#queries.stopReads();
      for (const entry of this.#queue.splice(0)) entry.reject(failure ?? new HistoryStorageError('ARCHIVE_CLOSED', '归档已关闭。'));
      if (this.#failure === null) {
        try { await this.#queries.closeAll(); } catch (error) { failure ??= error; }
      }
      // 即使此前 I/O 失败，也只在仍持有外层授权及精确 owner 记录时释放本实例的锁。
      try { await this.#options.fencing.runExclusive(this.scope, this.writer, async () => { await this.#lock.release(); }); }
      catch (error) { failure ??= error; }
      this.#closed = true; if (failure !== null) throw failure;
    })();
    return this.#closePromise;
  }
}
