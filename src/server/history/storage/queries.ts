import { randomUUID } from 'node:crypto';
import { readCheckpoint } from '../../../runtime/history/state/codec.ts';
import { canonicalStringify, compareDecimal, nextDecimal } from '../../../runtime/history/state/safeJson.ts';
import type { StateBudgets } from '../../../runtime/history/state/safeJson.ts';
import type { StateAdapterRegistry } from '../../../runtime/history/state/adapters.ts';
import type { DeepReadonly, InputCursor, StateCursor, TwinCheckpoint } from '../../../runtime/history/state/types.ts';
import type {
  ArchiveLimits, CapturePage, CaptureReadSession, CapturedArrival, CapturedReceipt, HistoryChangePage,
  HistoryDurability, HistoryReadSession, ReadSessionRequest,
} from './types.ts';
import type { BatchIndex, CheckpointIndex, LeaseIndex, ProjectionIndex, RawGroupIndex, SegmentIndex } from './metadata.ts';
import { ArchiveIndex } from './metadata.ts';
import { ArchiveFiles } from './files.ts';
import { ReadBudget, SegmentReadContext } from './segments.ts';
import { assertInputScope, decodeStoredBatch, sliceBatch } from './contracts.ts';
import type { RawGroupDocument } from './contracts.ts';
import { clone, decimal, need, parse, same, timestamp, upperBound } from './primitives.ts';

type QueryHost = {
  index: ArchiveIndex; files: ArchiveFiles; limits: Readonly<ArchiveLimits>; registry: StateAdapterRegistry;
  stateBudgets: Readonly<StateBudgets>; checkpointBudgets: Readonly<StateBudgets>; durability: HistoryDurability;
  assertHealthy(): void; persistLease(lease: LeaseIndex): Promise<void>; releaseLease(id: string): Promise<void>;
};
type SessionBase = {
  id: string; expiresAt: number; segments: Map<string, SegmentIndex>; usedBytes: number; pages: number;
  maxReadBytes: number; maxPages: number; maxPageBytes: number; maxPageBatches: number;
  pageCursor: string; busy: boolean; closed: boolean;
};
type StateSession = SessionBase & {
  kind: 'state'; view: HistoryReadSession; checkpoint: CheckpointIndex | null; batches: BatchIndex[];
  after: StateCursor; actualTime: number;
};
type RawSession = SessionBase & { kind: 'raw'; view: CaptureReadSession; groups: RawGroupIndex[]; after: InputCursor };
type AnySession = StateSession | RawSession;
export class ArchiveQueries {
  readonly runtimeId = randomUUID();
  readonly #sessions = new Map<string, AnySession>();
  readonly #pins = new Map<string, number>();
  #running = 0;
  #opening = 0;
  readonly #idleWaiters: (() => void)[] = [];
  constructor(readonly host: QueryHost) {}
  /** 用于留存和压缩回收；运行中的读取即使租约到期也保留其短暂 I/O pin。 */
  pinnedSegments(now = Date.now()): Set<string> {
    const result = new Set(this.#pins.keys());
    for (const lease of this.host.index.leases.values()) if (lease.expiresAt > now) for (const id of lease.segmentIds) result.add(id);
    return result;
  }
  private pin(ids: Iterable<string>): () => void {
    const values = [...new Set(ids)];
    for (const id of values) this.#pins.set(id, (this.#pins.get(id) ?? 0) + 1);
    return () => { for (const id of values) { const value = (this.#pins.get(id) ?? 1) - 1; if (value) this.#pins.set(id, value); else this.#pins.delete(id); } };
  }
  private segmentSnapshot(ids: Iterable<string>): Map<string, SegmentIndex> {
    const result = new Map<string, SegmentIndex>();
    for (const id of ids) if (!result.has(id)) result.set(id, clone(this.host.index.segment(id)));
    return result;
  }
  private settings(request: { ttlMs?: number; maxPageBytes?: number; maxPageBatches?: number; maxPages?: number; maxReadBytes?: number }): Pick<SessionBase, 'expiresAt' | 'maxPageBytes' | 'maxPageBatches' | 'maxPages' | 'maxReadBytes'> {
    const bounds = this.host.limits;
    const bound = (value: number | undefined, maximum: number): number => {
      const selected = value ?? maximum; need(Number.isSafeInteger(selected) && selected > 0 && selected <= maximum, 'QUERY_BUDGET', '查询预算必须为服务器上限以内的正整数。'); return selected;
    };
    return { expiresAt: Date.now() + bound(request.ttlMs, bounds.maxSessionTtlMs),
      maxPageBytes: bound(request.maxPageBytes, bounds.maxPageBytes), maxPageBatches: bound(request.maxPageBatches, bounds.maxPageBatches),
      maxPages: bound(request.maxPages, bounds.maxPagesPerSession), maxReadBytes: bound(request.maxReadBytes, bounds.maxReadBytesPerSession) };
  }
  private ensureSessionCapacity(): void {
    this.host.assertHealthy(); const now = Date.now();
    for (const [id, session] of this.#sessions) if (!session.busy && session.expiresAt <= now) this.#sessions.delete(id);
    let count = 0; for (const lease of this.host.index.leases.values()) if (lease.expiresAt > now) count += 1;
    need(count < this.host.limits.maxSessions && this.#running + this.#opening < this.host.limits.maxConcurrentReads,
      'SESSION_CAPACITY', '查询会话或准备队列达到上限。');
  }
  async open(request: ReadSessionRequest): Promise<HistoryReadSession> {
    this.ensureSessionCapacity();
    const projection = this.host.index.projection(request.projectionId), settings = this.settings(request);
    const head = clone(projection.head), versions = clone(projection.versions), versionDigest = projection.versionDigest;
    let time: number, checkpoint: CheckpointIndex | null = null, after: StateCursor, ceiling: StateCursor;
    let committedUpperCursor: StateCursor | null = null;
    let cursorTarget: StateCursor | null = null;
    if (request.mode === 'as-of') {
      timestamp(request.targetTime); time = request.targetTime;
      need(time >= projection.retainedFrom, 'CURSOR_EXPIRED', '目标早于可恢复的保留窗口。');
      need(time <= head.completeTime, head.continuity.status === 'gap' ? 'CONTINUITY_GAP' : 'TIME_NOT_QUERYABLE', '目标超出连续可查询水位；不会钳制后冒充目标时刻。');
      ceiling = head.completeCursor;
      const end = upperBound(projection.checkpoints, item => item.logicalTime <= time && compareDecimal(item.cursor.stateRevision, ceiling.stateRevision) <= 0);
      need(end > 0, 'CHECKPOINT_MISSING', '目标之前没有兼容且完整的恢复检查点。'); checkpoint = clone(projection.checkpoints[end - 1]); after = clone(checkpoint.cursor);
    } else if (request.mode === 'recovery') {
      time = head.logicalTime; ceiling = head.cursor; checkpoint = clone(projection.checkpoints[projection.checkpoints.length - 1]); after = clone(checkpoint.cursor);
    } else if (request.mode === 'cursor-recovery') {
      ceiling = clone(request.atCursor); decimal(ceiling.stateRevision);
      need(ceiling.projectionId === projection.id && compareDecimal(ceiling.stateRevision, head.completeCursor.stateRevision) <= 0,
        'CURSOR_RANGE', '恢复游标不属于当前连续的已提交投影。');
      const end = upperBound(projection.checkpoints, item => compareDecimal(item.cursor.stateRevision, ceiling.stateRevision) <= 0);
      need(end > 0, 'CHECKPOINT_MISSING', '游标之前没有保留的完整检查点。');
      checkpoint = clone(projection.checkpoints[end - 1]); after = clone(checkpoint.cursor);
      need(checkpoint.continuity.status === 'complete', 'CONTINUITY_GAP', '不能跨越缺口恢复连续状态。');
      time = head.logicalTime; cursorTarget = clone(ceiling);
    } else {
      after = clone(request.afterCursor); decimal(after.stateRevision);
      need(after.projectionId === projection.id, 'STATE_RESET_REQUIRED', '变化游标属于其他投影。');
      need(compareDecimal(after.stateRevision, projection.checkpoints[0].cursor.stateRevision) >= 0, 'CURSOR_EXPIRED', '变化游标早于保留的恢复依赖。');
      if (request.mode === 'changes-bounded') {
        need(Number.isSafeInteger(request.maxBatches) && request.maxBatches > 0 && request.maxBatches <= settings.maxPages * settings.maxPageBatches,
          'QUERY_BUDGET', '批次窗口超过当前租约页数预算。');
        committedUpperCursor = clone(request.upperCursor ?? head.completeCursor); decimal(committedUpperCursor.stateRevision);
        need(committedUpperCursor.projectionId === projection.id && compareDecimal(committedUpperCursor.stateRevision, head.completeCursor.stateRevision) <= 0
          && compareDecimal(after.stateRevision, committedUpperCursor.stateRevision) <= 0,
        'CURSOR_RANGE', '固定变化上界不属于当前连续的已提交投影。');
        ceiling = clone(committedUpperCursor); time = head.logicalTime;
      } else {
        ceiling = clone(request.toCursor ?? head.cursor); decimal(ceiling.stateRevision);
        need(ceiling.projectionId === projection.id && compareDecimal(ceiling.stateRevision, head.cursor.stateRevision) <= 0
          && compareDecimal(after.stateRevision, ceiling.stateRevision) <= 0, 'CURSOR_RANGE', '固定变化上界不属于当前已提交范围。');
        time = request.throughTime ?? head.logicalTime; timestamp(time);
        need(time <= head.logicalTime && time >= projection.retainedFrom, 'TIME_NOT_QUERYABLE', '变化时间上界不在已提交保留范围内。');
      }
    }
    const start = upperBound(projection.batches, item => compareDecimal(item.proof.toRevision, after.stateRevision) <= 0);
    let end = Math.min(upperBound(projection.batches, item => item.firstTime <= time),
      upperBound(projection.batches, item => compareDecimal(item.proof.fromRevision, ceiling.stateRevision) < 0));
    if (request.mode === 'changes-bounded') {
      end = Math.min(end, start + request.maxBatches);
      need(end > start || compareDecimal(after.stateRevision, ceiling.stateRevision) === 0,
        'REVISION_GAP', '固定提交上界之前没有可连续读取的批次。');
      const last = end > start ? projection.batches[end - 1] : null;
      ceiling = last && compareDecimal(last.proof.toRevision, ceiling.stateRevision) < 0
        ? { projectionId: projection.id, stateRevision: last.proof.toRevision } : end > start ? ceiling : clone(after);
      cursorTarget = clone(ceiling);
    }
    const batches = projection.batches.slice(start, Math.max(start, end));
    need(batches.length <= settings.maxPages * settings.maxPageBatches, 'QUERY_BUDGET', '查询跨度超出页数预算，请从更近的检查点重建。');
    const afterBatch = this.cursorBatch(projection, after.stateRevision);
    const targetBatch = cursorTarget ? this.cursorBatch(projection, cursorTarget.stateRevision) : undefined;
    const ids = new Set(batches.map(batch => batch.proof.record.segmentId));
    if (checkpoint) ids.add(checkpoint.record.segmentId);
    if (afterBatch && afterBatch.proof.toRevision !== after.stateRevision) ids.add(afterBatch.proof.record.segmentId);
    if (cursorTarget && targetBatch && targetBatch.proof.toRevision !== cursorTarget.stateRevision) ids.add(targetBatch.proof.record.segmentId);
    const segments = this.segmentSnapshot(ids), unpin = this.pin(ids); this.#opening += 1;
    const setupBudget = new ReadBudget(settings.maxReadBytes);
    const context = new SegmentReadContext(this.host.files, this.host.limits, setupBudget);
    try {
      if (cursorTarget) time = await this.cursorTime(projection, cursorTarget, targetBatch, context, segments);
      let initialTime = checkpoint?.logicalTime;
      if (initialTime === undefined) initialTime = await this.cursorTime(projection, after, afterBatch, context, segments);
      need(initialTime <= time, 'CURSOR_RANGE', 'afterCursor 已晚于请求时间上界。');
      let toCursor = clone(after);
      if (batches.length) {
        const last = batches[batches.length - 1];
        if (last.proof.throughTime <= time && compareDecimal(last.proof.toRevision, ceiling.stateRevision) <= 0) {
          toCursor = { projectionId: projection.id, stateRevision: last.proof.toRevision };
        } else {
          const batch = decodeStoredBatch(await context.read(last.proof.record, segments.get(last.proof.record.segmentId)!), last, this.host.stateBudgets);
          const revision = batch.revisions.filter(item => item.logicalTime <= time && compareDecimal(item.revision, ceiling.stateRevision) <= 0
            && compareDecimal(item.revision, after.stateRevision) > 0).at(-1);
          if (revision) toCursor = { projectionId: projection.id, stateRevision: revision.revision };
          else if (batches.length > 1) toCursor = { projectionId: projection.id, stateRevision: batches[batches.length - 2].proof.toRevision };
        }
      }
      const selected = batches.filter(batch => compareDecimal(batch.proof.fromRevision, toCursor.stateRevision) < 0);
      this.assertBatchChain(selected, after.stateRevision, toCursor.stateRevision);
      const id = randomUUID(), pageCursor = randomUUID();
      const view: HistoryReadSession = { sessionId: id, projectionId: projection.id, versionDigest, versions,
        expiresAt: settings.expiresAt, requestedTime: time, actualTime: initialTime, queryableThrough: head.completeTime,
        checkpoint: checkpoint ? clone(checkpoint) : null, afterCursor: clone(after), toCursor, throughTime: time, pageCursor,
        ...(committedUpperCursor ? { committedUpperCursor, hasMoreCommitted: compareDecimal(toCursor.stateRevision, committedUpperCursor.stateRevision) < 0 } : {}),
        continuity: clone(compareDecimal(toCursor.stateRevision, head.completeCursor.stateRevision) <= 0
          ? (checkpoint?.continuity ?? projection.checkpoints[0].continuity) : head.continuity) };
      await this.host.persistLease({ id, runtimeId: this.runtimeId, expiresAt: settings.expiresAt, segmentIds: [...ids],
        projectionId: projection.id, dependencies: clone(projection.dependencies.references) });
      this.#sessions.set(id, { kind: 'state', id, view, checkpoint, batches: selected, after, actualTime: initialTime, segments, ...settings,
        usedBytes: setupBudget.used, pages: 0, pageCursor, busy: false, closed: false });
      return clone(view);
    } finally { unpin(); this.#opening -= 1; this.notifyIdle(); }
  }
  private cursorBatch(projection: ProjectionIndex, revision: string): BatchIndex | undefined {
    const index = upperBound(projection.batches, batch => compareDecimal(batch.proof.toRevision, revision) < 0);
    const batch = projection.batches[index];
    return batch && compareDecimal(batch.proof.fromRevision, revision) < 0 && compareDecimal(batch.proof.toRevision, revision) >= 0 ? batch : undefined;
  }
  private async cursorTime(projection: ProjectionIndex, cursor: StateCursor, batch: BatchIndex | undefined,
    context: SegmentReadContext, segments: Map<string, SegmentIndex>): Promise<number> {
    if (same(cursor, projection.head.cursor)) return projection.head.logicalTime;
    if (batch?.proof.toRevision === cursor.stateRevision) return batch.proof.throughTime;
    if (batch) {
      const decoded = decodeStoredBatch(await context.read(batch.proof.record, segments.get(batch.proof.record.segmentId)!), batch, this.host.stateBudgets);
      const found = decoded.revisions.find(item => item.revision === cursor.stateRevision);
      need(found, 'REVISION_GAP', '游标对应的原子修订缺失。'); return found.logicalTime;
    }
    const position = upperBound(projection.checkpoints, item => compareDecimal(item.cursor.stateRevision, cursor.stateRevision) < 0);
    const checkpoint = projection.checkpoints[position];
    need(checkpoint && same(checkpoint.cursor, cursor), 'REVISION_GAP', '游标不属于任何已提交原子修订。'); return checkpoint.logicalTime;
  }
  private assertBatchChain(batches: BatchIndex[], after: string, through: string): void {
    let cursor = after;
    for (const batch of batches) {
      need(compareDecimal(batch.proof.fromRevision, cursor) <= 0 && compareDecimal(batch.proof.toRevision, cursor) > 0, 'REVISION_GAP', '变化段索引存在缺口或重叠。');
      if (cursor !== after) need(batch.proof.fromRevision === cursor, 'REVISION_GAP', '变化段索引不连续。');
      cursor = compareDecimal(batch.proof.toRevision, through) > 0 ? through : batch.proof.toRevision;
    }
    need(cursor === through, 'REVISION_GAP', '固定上界没有完整连续的已提交批次。');
  }
  async checkpoint(sessionId: string, signal?: AbortSignal): Promise<DeepReadonly<TwinCheckpoint>> {
    const session = this.stateSession(sessionId);
    need(session.checkpoint, 'CHECKPOINT_REQUIRED', '该变化会话未申请检查点。');
    return this.read(session, signal, async context => {
      const item = session.checkpoint!;
      const data = parse<unknown>(await context.read(item.record, session.segments.get(item.record.segmentId)!), this.host.limits.maxCheckpointBytes);
      const checkpoint = readCheckpoint(data, this.host.registry, { budgets: this.host.checkpointBudgets, expectedVersions: session.view.versions });
      need(checkpoint.checksum.value === item.checksum && same(checkpoint.state.metadata.cursor, item.cursor)
        && checkpoint.state.metadata.logicalTime === item.logicalTime && same(checkpoint.state.metadata.inputCursor, item.inputCursor), 'CORRUPT_CHECKPOINT', '检查点内容与持久索引不匹配。');
      return checkpoint;
    });
  }
  async changes(sessionId: string, pageCursor: string, signal?: AbortSignal): Promise<HistoryChangePage> {
    const session = this.stateSession(sessionId);
    need(pageCursor === session.pageCursor, 'PAGE_CURSOR', '分页游标过期或不属于该固定查询会话。');
    return this.read(session, signal, async context => {
      const after = clone(session.after), batches: HistoryChangePage['batches'] = []; let next = clone(after), actualTime = session.actualTime;
      let outputBytes = Buffer.byteLength(canonicalStringify({ sessionId, batches: [], afterCursor: after, toCursor: session.view.toCursor,
        nextStateCursor: session.view.toCursor, nextCursor: '0'.repeat(36), hasMore: false, requestedTime: session.view.requestedTime,
        actualTime: Number.MAX_SAFE_INTEGER, throughTime: session.view.throughTime, queryableThrough: session.view.queryableThrough, readBytes: Number.MAX_SAFE_INTEGER }));
      need(outputBytes <= session.maxPageBytes, 'PAGE_BUDGET', '分页信封本身超过页预算。');
      let index = upperBound(session.batches, batch => compareDecimal(batch.proof.toRevision, after.stateRevision) <= 0);
      while (index < session.batches.length && batches.length < session.maxPageBatches && compareDecimal(next.stateRevision, session.view.toCursor.stateRevision) < 0) {
        this.abort(signal); const entry = session.batches[index], segment = session.segments.get(entry.proof.record.segmentId)!;
        if (!context.budget.fits(context.cost(entry.proof.record, segment)) && batches.length) break;
        const decoded = decodeStoredBatch(await context.read(entry.proof.record, segment), entry, this.host.stateBudgets);
        const batch = sliceBatch(decoded, next.stateRevision, session.view.toCursor.stateRevision, this.host.stateBudgets);
        const bytes = Buffer.byteLength(canonicalStringify(batch), 'utf8') + 1;
        if (outputBytes + bytes > session.maxPageBytes) { need(batches.length > 0, 'PAGE_BUDGET', '单个完整原子变化批次超过页预算；不能返回半个修订。'); break; }
        batches.push(batch); outputBytes += bytes; next = { projectionId: session.view.projectionId, stateRevision: batch.toRevision }; actualTime = batch.throughTime; index += 1;
      }
      const hasMore = compareDecimal(next.stateRevision, session.view.toCursor.stateRevision) < 0;
      need(!hasMore || batches.length > 0, 'REVISION_GAP', '固定上界尚有修订但没有可读连续批次。');
      this.abort(signal); need(!session.closed, 'SESSION_CLOSED', '查询已取消。');
      session.after = next; session.actualTime = actualTime; session.pageCursor = randomUUID();
      return { sessionId, batches, afterCursor: after, toCursor: clone(session.view.toCursor), nextStateCursor: clone(next),
        nextCursor: hasMore ? session.pageCursor : null, hasMore, requestedTime: session.view.requestedTime, actualTime,
        throughTime: session.view.throughTime, queryableThrough: session.view.queryableThrough, readBytes: context.budget.used };
    });
  }
  async openCapture(after: InputCursor, options: { through?: InputCursor; ttlMs?: number; maxPages?: number; maxReadBytes?: number; maxPageBytes?: number } = {}): Promise<CaptureReadSession> {
    this.ensureSessionCapacity(); assertInputScope(after, this.host.index.scope);
    const through = clone(options.through ?? this.host.index.capturedCursor), settings = this.settings(options);
    assertInputScope(through, this.host.index.scope);
    need(compareDecimal(after.offset, this.host.index.rawFloor) >= 0, 'CURSOR_EXPIRED', '原始游标已过保留窗口。');
    need(compareDecimal(after.offset, through.offset) <= 0 && compareDecimal(through.offset, this.host.index.capturedOffset) <= 0, 'CURSOR_RANGE', '原始读取上界未持久提交。');
    const start = upperBound(this.host.index.groups, group => compareDecimal(group.lastOffset, after.offset) <= 0);
    const end = upperBound(this.host.index.groups, group => compareDecimal(group.firstOffset, through.offset) <= 0);
    const groups = this.host.index.groups.slice(start, end);
    need(groups.length <= settings.maxPages * settings.maxPageBatches, 'QUERY_BUDGET', '原始读取跨度超过会话页数预算。');
    let next = after.offset;
    for (const group of groups) { need(compareDecimal(group.firstOffset, nextDecimal(next)) <= 0 && compareDecimal(group.lastOffset, next) > 0, 'INPUT_GAP', '原始索引存在缺口。'); next = group.lastOffset; }
    need(compareDecimal(next, through.offset) >= 0, 'INPUT_GAP', '原始固定上界缺少持久记录。');
    const ids = new Set(groups.map(group => group.record.segmentId)), segments = this.segmentSnapshot(ids), unpin = this.pin(ids); this.#opening += 1;
    try {
      const id = randomUUID(), pageCursor = randomUUID();
      const view: CaptureReadSession = { sessionId: id, after: clone(after), through, pageCursor, expiresAt: settings.expiresAt };
      await this.host.persistLease({ id, runtimeId: this.runtimeId, expiresAt: settings.expiresAt, segmentIds: [...ids], projectionId: null, dependencies: [] });
      this.#sessions.set(id, { kind: 'raw', id, view, groups, after: clone(after), segments, ...settings, usedBytes: 0, pages: 0, pageCursor, busy: false, closed: false });
      return clone(view);
    } finally { unpin(); this.#opening -= 1; this.notifyIdle(); }
  }
  async captured(sessionId: string, pageCursor: string, options: { maxRecords?: number; signal?: AbortSignal } = {}): Promise<CapturePage> {
    const session = this.session(sessionId);
    need(session.kind === 'raw' && session.pageCursor === pageCursor, 'PAGE_CURSOR', '原始分页游标不属于该固定会话。');
    const maximum = options.maxRecords ?? this.host.limits.maxRawGroupRecords;
    need(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= this.host.limits.maxRawGroupRecords * session.maxPageBatches, 'QUERY_BUDGET', '原始记录页数超过上限。');
    return this.read(session, options.signal, async context => {
      const arrivals: CapturedArrival[] = []; let next = clone(session.after), groupsRead = 0;
      let outputBytes = Buffer.byteLength(canonicalStringify({ arrivals: [], nextInputCursor: session.view.through,
        through: session.view.through, nextCursor: '0'.repeat(36), hasMore: false, readBytes: Number.MAX_SAFE_INTEGER }));
      need(outputBytes <= session.maxPageBytes, 'PAGE_BUDGET', '原始分页信封本身超过页预算。');
      const start = upperBound(session.groups, group => compareDecimal(group.lastOffset, next.offset) <= 0);
      outer: for (let index = start; index < session.groups.length && groupsRead < session.maxPageBatches; index += 1) {
        this.abort(options.signal); const group = session.groups[index], segment = session.segments.get(group.record.segmentId)!;
        if (!context.budget.fits(context.cost(group.record, segment)) && arrivals.length) break;
        const document = parse<RawGroupDocument>(await context.read(group.record, segment), this.host.limits.maxRawGroupBytes);
        need(document.format === 'history-raw/1' && document.archiveId === this.host.index.archiveId && same(document.scope, this.host.index.scope)
          && document.records.length === group.count, 'CORRUPT_RAW', '原始组身份、作用域或记录数不匹配。'); groupsRead += 1;
        for (let recordIndex = 0; recordIndex < document.records.length; recordIndex += 1) {
          const record = document.records[recordIndex], expected = (BigInt(group.firstOffset) + BigInt(recordIndex)).toString();
          assertInputScope(record.inputCursor, this.host.index.scope);
          need(record.inputCursor.offset === expected, 'INPUT_GAP', '原始组内部 offset 不连续。');
          if (compareDecimal(expected, next.offset) <= 0) continue;
          if (compareDecimal(expected, session.view.through.offset) > 0) break outer;
          need(expected === nextDecimal(next.offset), 'INPUT_GAP', '原始读取跨越了缺口。');
          need(typeof record.payloadBase64 === 'string' && Number.isSafeInteger(record.payloadBytes) && record.payloadBytes >= 0
            && record.payloadBytes <= this.host.limits.maxRawPayloadBytes && record.payloadBase64.length <= Math.ceil(this.host.limits.maxRawPayloadBytes / 3) * 4,
          'CORRUPT_RAW', '原始载荷大小无效。');
          const payload = Buffer.from(record.payloadBase64, 'base64');
          need(payload.byteLength === record.payloadBytes && payload.toString('base64') === record.payloadBase64, 'CORRUPT_RAW', '原始载荷编码损坏。');
          const receipt: CapturedReceipt = { kind: 'captured', archiveId: this.host.index.archiveId, inputCursor: clone(record.inputCursor), receivedAt: record.receivedAt,
            record: clone(group.record), recordIndex, journalSequence: group.journalSequence, fencingToken: group.fencingToken, durability: this.host.durability };
          // 原始页按完整 base64 证据及回执的 UTF-8 尺寸计量，至少覆盖返回的原始二进制字节。
          const bytes = Buffer.byteLength(canonicalStringify({ ...record, receipt })) + 1;
          if (outputBytes + bytes > session.maxPageBytes) { need(arrivals.length > 0, 'PAGE_BUDGET', '一条原始到达记录超过页预算。'); break outer; }
          arrivals.push({ sourceId: record.sourceId, sourceContractId: record.sourceContractId, receivedAt: record.receivedAt,
            transport: clone(record.transport), rawPayload: payload, receipt }); outputBytes += bytes; next = clone(record.inputCursor);
          if (arrivals.length >= maximum) break outer;
        }
      }
      const hasMore = compareDecimal(next.offset, session.view.through.offset) < 0;
      need(!hasMore || arrivals.length > 0, 'INPUT_GAP', '原始固定上界没有可读连续记录。');
      this.abort(options.signal); need(!session.closed, 'SESSION_CLOSED', '查询已取消。'); session.after = next; session.pageCursor = randomUUID();
      return { arrivals, nextInputCursor: clone(next), through: clone(session.view.through), nextCursor: hasMore ? session.pageCursor : null, hasMore, readBytes: context.budget.used };
    });
  }
  private session(id: string): AnySession {
    this.host.assertHealthy(); const session = this.#sessions.get(id);
    need(session, this.host.index.leases.has(id) ? 'SESSION_RESTARTED' : 'SESSION_NOT_FOUND', '查询会话不存在或服务进程已重启，必须重新握手。');
    need(!session.closed && session.expiresAt > Date.now(), 'SESSION_EXPIRED', '查询租约已关闭或过期。'); return session;
  }
  private stateSession(id: string): StateSession { const session = this.session(id); need(session.kind === 'state', 'SESSION_KIND', '会话不是状态查询。'); return session; }
  private async read<T>(session: AnySession, signal: AbortSignal | undefined, operation: (context: SegmentReadContext) => Promise<T>): Promise<T> {
    this.host.assertHealthy(); this.abort(signal);
    need(!session.busy && this.#running + this.#opening < this.host.limits.maxConcurrentReads, 'QUERY_BUSY', '并发读取达到上限，未消耗分页游标。');
    need(session.pages < session.maxPages, 'QUERY_BUDGET', '查询会话页数已耗尽。');
    session.busy = true; session.pages += 1; this.#running += 1; const unpin = this.pin(session.segments.keys());
    const budget = new ReadBudget(Math.min(session.maxReadBytes - session.usedBytes, this.host.limits.maxSegmentBytes * 2 + session.maxPageBytes), bytes => {
      need(session.usedBytes + bytes <= session.maxReadBytes, 'QUERY_BUDGET', '查询会话总读取预算已耗尽。'); session.usedBytes += bytes;
    });
    try {
      const result = await operation(new SegmentReadContext(this.host.files, this.host.limits, budget));
      this.abort(signal); need(session.expiresAt > Date.now() && !session.closed, 'SESSION_EXPIRED', '读取期间会话已过期或取消。'); return result;
    } finally { session.busy = false; this.#running -= 1; unpin(); this.notifyIdle(); }
  }
  private abort(signal?: AbortSignal): void { need(!signal?.aborted, 'CANCELLED', '查询已经取消。'); }
  async close(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (session) session.closed = true;
    if (this.host.index.leases.has(id)) await this.host.releaseLease(id);
    this.#sessions.delete(id);
  }
  usage(id: string): { readBytes: number; pages: number } { const session = this.#sessions.get(id); need(session, 'SESSION_NOT_FOUND', '会话不存在。'); return { readBytes: session.usedBytes, pages: session.pages }; }
  private notifyIdle(): void {
    if (this.#running === 0 && this.#opening === 0) for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
  async stopReads(): Promise<void> {
    for (const session of this.#sessions.values()) session.closed = true;
    if (this.#running || this.#opening) await new Promise<void>(resolve => this.#idleWaiters.push(resolve));
  }
  async closeAll(): Promise<void> {
    await this.stopReads();
    for (const id of [...this.#sessions.keys()]) await this.close(id);
  }
}
