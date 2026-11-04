import { randomUUID } from 'node:crypto';
import { TwinStateKernel } from '../../../runtime/history/state/kernel.ts';
import type { StateAdapterRegistry } from '../../../runtime/history/state/adapters.ts';
import { canonicalStringify, compareDecimal, DEFAULT_STATE_BUDGETS, nextDecimal } from '../../../runtime/history/state/safeJson.ts';
import type { StateBudgets } from '../../../runtime/history/state/safeJson.ts';
import type { DeepReadonly, StateCursor, TwinCheckpoint } from '../../../runtime/history/state/types.ts';
import type { HistoryTimeRange } from '../../../runtime/history/historyReplayContract.ts';
import { DurableHistoryArchive } from '../storage/DurableHistoryArchive.ts';
import type { HistoryFencingPort, HistoryWriter, ProjectionWatermarks } from '../storage/types.ts';
import { HistoryStorageError } from '../storage/types.ts';
import { clone, decimal, jsonHash, need, pack, parse, same, timestamp, upperBound } from '../storage/primitives.ts';
import { EventFiles } from './eventFiles.ts';
import type { EventFileLimits, FrameLocation } from './eventFiles.ts';
import { deriveEvents, EVENT_PROJECTION_VERSION, validateIndexedEvent } from './projection.ts';
import type { IncompleteEventRange, IndexedHistoryEvent } from './projection.ts';

export type HistoryEventIndexLimits = EventFileLimits & {
  maxGroups: number; maxRecordsPerGroup: number; maxEventsPerGroup: number; maxIncompleteRanges: number; maxSessions: number;
  maxSessionTtlMs: number; maxPages: number; maxReadBytes: number; maxReadOps: number; maxConcurrentReads: number; maxPageBytes: number; maxPageItems: number;
};
type Limits = HistoryEventIndexLimits;
const DEFAULTS: Limits = {
  maxSegmentBytes: 16 * 1024 * 1024, maxFrameBytes: 4 * 1024 * 1024, maxStoredBytes: 4 * 1024 ** 3,
  maxRecoveryBytes: 4 * 1024 ** 3, maxSegments: 4096, maxGroups: 500_000, maxRecordsPerGroup: 256,
  maxEventsPerGroup: 20_000, maxIncompleteRanges: 500_000, maxSessions: 64, maxSessionTtlMs: 300_000, maxPages: 256,
  maxReadBytes: 256 * 1024 * 1024, maxReadOps: 8192, maxConcurrentReads: 4, maxPageBytes: 2 * 1024 * 1024, maxPageItems: 1000,
};
type Identity = {
  format: 'history-event-index/1'; eventProjectionVersion: typeof EVENT_PROJECTION_VERSION; archiveId: string; projectionId: string; versionDigest: string;
  anchor: StateCursor; anchorTime: number; availableFrom: number; checkpointChecksum: string;
};
type RecordEntry = {
  fromRevision: string; toRevision: string; throughTime: number; batchChecksum: string; events: IndexedHistoryEvent[];
  incompleteRanges: IncompleteEventRange[];
};
type Group = { format: 'history-event-group/1'; sequence: string; previousHash: string; records: RecordEntry[] };
type GroupEntry = { location: FrameLocation; firstTime: number; lastTime: number; firstRevision: string; lastRevision: string };
function coverageAfter(count: number, end: number | null, ranges: readonly IncompleteEventRange[]): { count: number; end: number | null } {
  for (const range of ranges) {
    if (end === null || range.firstTime > end + 1) count += 1;
    end = end === null ? range.lastTime : Math.max(end, range.lastTime);
  }
  return { count, end };
}
type Query = {
  id: string; owner: string; range: HistoryTimeRange; direction: 'forward' | 'reverse'; expiresAt: number; cursor: string; group: number; event: number;
  firstGroup: number; lastGroup: number; pages: number; readBytes: number; readOps: number; maxPages: number; maxReadBytes: number; maxReadOps: number; maxPageBytes: number;
  busy: boolean; closed: boolean; cancelled: boolean; upper: StateCursor; archiveSessionId: string;
};
export type HistoryEventIndexOptions = {
  /** 预部署的私有目录；不接受路径链接，且不能与外层存储目录共用索引文件名。 */
  rootDirectory: string; archive: DurableHistoryArchive; projectionId: string; registry: StateAdapterRegistry;
  fencing: HistoryFencingPort; stateBudgets?: Partial<StateBudgets>; limits?: Partial<HistoryEventIndexLimits>;
  /** 仅当外层已持久换代，指定本索引先前的准确 owner/token。 */
  reclaimAbandonedWriter?: HistoryWriter;
};
export type EventIndexStatus = {
  indexedThrough: StateCursor; indexedThroughTime: number; availableFrom: number; eventGroups: number;
  coverage: 'complete' | 'net-only'; incompleteGroups: number;
};
export type EventSyncResult = EventIndexStatus & { committedUpperCursor: StateCursor; hasMoreCommitted: boolean };
export type OpenEventQuery = {
  owner: string; range: HistoryTimeRange; direction?: 'forward' | 'reverse';
  /** 排除已返回的锚事件；按修订与 ordinal 定位同毫秒前后事件。 */
  afterEvent?: Pick<IndexedHistoryEvent, 'id' | 'time' | 'revision' | 'ordinal'>;
  ttlMs?: number; maxPages?: number; maxReadBytes?: number; maxReadOps?: number; maxPageBytes?: number; signal?: AbortSignal;
};
export type EventQueryPage = {
  queryId: string; cursor: string; nextCursor: string | null; hasMore: boolean; expiresAt: number;
  range: HistoryTimeRange; direction: 'forward' | 'reverse'; indexedThrough: StateCursor; items: IndexedHistoryEvent[]; readBytes: number; readOps: number;
};

/** 单进程、单 archive owner 的派生索引；调用者负责绑定鉴权项目、发布身份和外层会话。 */
export class HistoryEventIndex {
  readonly #files: EventFiles; readonly #identity: Identity; readonly #options: HistoryEventIndexOptions; readonly #limits: Limits;
  readonly #groups: GroupEntry[] = []; readonly #incomplete: { firstTime: number; lastTime: number }[] = [];
  readonly #incompleteGroupLastTimes: number[] = [];
  readonly #queries = new Map<string, Query>();
  #revision: string; #time: number; #sequence = '0'; #hash = '0'.repeat(64); #groupCount = 0;
  #kernel!: TwinStateKernel; #syncing = false; #opening = 0; #reads = 0; #failure: unknown = null; #closed = false; #closing = false;
  private constructor(files: EventFiles, identity: Identity, options: HistoryEventIndexOptions, limits: Limits) {
    this.#files = files; this.#identity = identity; this.#options = options; this.#limits = limits;
    this.#revision = identity.anchor.stateRevision; this.#time = identity.anchorTime;
  }
  static async open(options: HistoryEventIndexOptions): Promise<HistoryEventIndex> {
    // 异步打开前固定全部授权和版本依赖，调用方不能通过修改 options 更换写入 gate 或状态解码器。
    options = Object.freeze({ ...options, registry: options.registry.snapshot(),
      stateBudgets: options.stateBudgets ? Object.freeze({ ...options.stateBudgets }) : undefined,
      limits: options.limits ? Object.freeze({ ...options.limits }) : undefined,
      reclaimAbandonedWriter: options.reclaimAbandonedWriter ? Object.freeze({ ...options.reclaimAbandonedWriter }) : undefined });
    need(options.archive instanceof DurableHistoryArchive && options.archive.usesFencing(options.fencing), 'FENCING_REQUIRED', '事件索引必须使用该归档真实的同一持久 fencing 端口。');
    need(typeof options.projectionId === 'string' && options.projectionId.length > 0 && options.projectionId.length <= 2048, 'IDENTITY', '投影身份无效。');
    const limits = { ...DEFAULTS, ...options.limits };
    for (const [key, value] of Object.entries(limits)) need(Object.hasOwn(DEFAULTS, key) && Number.isSafeInteger(value) && value > 0, 'BUDGET', '事件预算必须是已知的正安全整数。');
    need(limits.maxFrameBytes + 36 <= limits.maxSegmentBytes && limits.maxSegmentBytes <= 0x7fffffff
      && limits.maxSegments <= 999_999_999_999 && limits.maxEventsPerGroup <= Math.floor(Number.MAX_SAFE_INTEGER / 4)
      && limits.maxPageBytes <= limits.maxReadBytes, 'BUDGET', '事件分段和读取预算不兼容。');
    const watermark = HistoryEventIndex.watermark(options.archive, options.projectionId);
    const anchorReceipt = options.archive.findCheckpoint(options.projectionId, watermark.retainedFrom);
    const anchorSession = await options.archive.openReadSession({ mode: 'cursor-recovery', projectionId: options.projectionId, atCursor: anchorReceipt.cursor });
    let files: EventFiles | undefined, anchorClosed = false;
    try {
      const checkpoint = await options.archive.readCheckpoint(anchorSession.sessionId);
      need(same(checkpoint.state.metadata.cursor, anchorReceipt.cursor) && checkpoint.checksum.value === anchorReceipt.checksum,
        'CHECKPOINT_MISMATCH', '留存锚点与已固定的检查点不一致。');
      need(checkpoint.state.metadata.continuity.status === 'complete', 'CONTINUITY_GAP', '初始检查点不连续。');
      const anchor = clone(checkpoint.state.metadata.cursor), anchorTime = checkpoint.state.metadata.logicalTime;
      const availableFrom = Math.max(watermark.retainedFrom, anchorTime + (anchor.stateRevision === '0' ? 0 : 1));
      timestamp(availableFrom);
      const proposed: Identity = { format: 'history-event-index/1', eventProjectionVersion: EVENT_PROJECTION_VERSION,
        archiveId: options.archive.archiveId, projectionId: options.projectionId,
        versionDigest: jsonHash(watermark.versions), anchor, anchorTime, availableFrom, checkpointChecksum: checkpoint.checksum.value };
      let instance!: HistoryEventIndex;
      await HistoryEventIndex.gated(options, async () => {
        // 投影语义改变时在独立目录重建，不复用旧索引对完整覆盖的错误判断。
        files = await EventFiles.open(options.rootDirectory, JSON.stringify([options.archive.archiveId, options.projectionId, EVENT_PROJECTION_VERSION]), options.archive.scope,
          options.archive.writer, options.archive.durability, limits, options.reclaimAbandonedWriter);
        const identity = await files.identity(proposed);
        need(identity.format === 'history-event-index/1' && identity.eventProjectionVersion === EVENT_PROJECTION_VERSION
          && identity.archiveId === proposed.archiveId && identity.projectionId === proposed.projectionId
          && identity.versionDigest === proposed.versionDigest && identity.anchor?.projectionId === options.projectionId,
        'INDEX_IDENTITY', '事件索引的归档、投影或固定版本不匹配。');
        decimal(identity.anchor.stateRevision); timestamp(identity.anchorTime); timestamp(identity.availableFrom);
        need(identity.availableFrom >= identity.anchorTime && identity.availableFrom <= 8_640_000_000_000_000,
          'INDEX_IDENTITY', '事件索引的覆盖起点无效。');
        need(/^[a-f0-9]{64}$/u.test(identity.checkpointChecksum), 'CHECKSUM', '初始检查点摘要无效。');
        instance = new HistoryEventIndex(files, identity, options, limits);
        await files.recover((location, payload) => instance.install(location, payload));
      });
      await instance.restoreFollower(checkpoint);
      await options.archive.closeReadSession(anchorSession.sessionId); anchorClosed = true;
      return instance;
    } catch (error) {
      if (files) {
        try { await HistoryEventIndex.gated(options, async () => files!.release()); }
        catch (releaseError) { throw new Error(`事件索引打开失败且锁释放失败：${String(error)}；${String(releaseError)}`); }
      }
      throw error;
    } finally { if (!anchorClosed) await options.archive.closeReadSession(anchorSession.sessionId); }
  }
  private static async gated<T>(options: HistoryEventIndexOptions, fn: () => Promise<T>): Promise<T> {
    let calls = 0;
    const result = await options.fencing.runExclusive(options.archive.scope, options.archive.writer, async () => {
      calls += 1; need(calls === 1, 'FENCING_CONTRACT', '持久 fencing 不得重跑事件写回调。'); return fn();
    });
    need(calls === 1, 'FENCING_CONTRACT', '持久 fencing 没有执行事件写回调。'); return result;
  }
  private static watermark(archive: DurableHistoryArchive, projectionId: string): ProjectionWatermarks {
    const value = archive.getWatermarks().projections.find(item => item.projectionId === projectionId);
    need(value, 'PROJECTION_MISSING', '归档不存在该投影。'); return value;
  }
  private watermark(): ProjectionWatermarks {
    const value = HistoryEventIndex.watermark(this.#options.archive, this.#identity.projectionId);
    need(jsonHash(value.versions) === this.#identity.versionDigest && compareDecimal(value.queryableCursor.stateRevision, this.#revision) >= 0,
      'INDEX_AHEAD', '事件索引领先归档连续可查询水位或投影版本已改变。'); return value;
  }
  private healthy(): void { need(!this.#closed && !this.#closing, 'INDEX_CLOSED', '事件索引已关闭或正在关闭。'); need(this.#failure === null, 'RECOVERY_REQUIRED', '事件索引发生写入或校验失败，须关闭后从归档恢复。'); }
  private parseGroup(payload: Buffer): Group {
    const arrays = Math.min(this.#limits.maxFrameBytes, Math.max(this.#limits.maxEventsPerGroup * 4, this.#limits.maxRecordsPerGroup,
      this.#options.stateBudgets?.maxRevisionsPerBatch ?? DEFAULT_STATE_BUDGETS.maxRevisionsPerBatch));
    return parse<Group>(payload, this.#limits.maxFrameBytes, arrays);
  }
  private install(location: FrameLocation, payload: Buffer): void {
    const group = this.parseGroup(payload);
    need(group.format === 'history-event-group/1' && group.sequence === nextDecimal(this.#sequence) && group.previousHash === this.#hash
      && Array.isArray(group.records) && group.records.length > 0 && group.records.length <= this.#limits.maxRecordsPerGroup,
    'CORRUPT_INDEX', '事件提交组序号、链或记录数无效。');
    let revision = this.#revision, time = this.#time, firstTime: number | null = null, lastTime: number | null = null;
    let firstRevision: string | null = null, lastEventRevision: string | null = null, count = 0;
    const incompleteRanges: IncompleteEventRange[] = [];
    for (const record of group.records) {
      decimal(record.fromRevision); decimal(record.toRevision); timestamp(record.throughTime);
      need(record.fromRevision === revision && compareDecimal(record.toRevision, revision) > 0 && record.throughTime >= time
        && /^[a-f0-9]{64}$/u.test(record.batchChecksum) && Array.isArray(record.events), 'REVISION_GAP', '事件批次水位不连续或来源摘要无效。');
      need(Array.isArray(record.incompleteRanges), 'CORRUPT_INDEX', '旧事实覆盖区间缺失。');
      let previousIncomplete = time;
      for (const range of record.incompleteRanges) {
        need(range && typeof range === 'object', 'CORRUPT_INDEX', '旧事实覆盖区间无效。');
        timestamp(range.firstTime); timestamp(range.lastTime);
        need(range.firstTime >= previousIncomplete && range.lastTime >= range.firstTime && range.lastTime <= record.throughTime,
          'CORRUPT_INDEX', '旧事实覆盖区间超出已提交修订或次序反转。');
        incompleteRanges.push(range); previousIncomplete = range.lastTime;
      }
      let previousRevision = record.fromRevision, lastOrdinal = -1, lastEventTime = time;
      for (const event of record.events) {
        validateIndexedEvent(this.#identity.archiveId, event, this.#identity.projectionId, this.#identity.versionDigest); decimal(event.revision);
        const order = compareDecimal(event.revision, previousRevision);
        need(compareDecimal(event.revision, record.fromRevision) > 0 && compareDecimal(event.revision, record.toRevision) <= 0
          && order >= 0 && (order > 0 ? event.ordinal === 0 : event.ordinal === lastOrdinal + 1)
          && event.time >= lastEventTime && event.time <= record.throughTime,
        'CORRUPT_EVENT', '事件不属于有序已提交修订。');
        previousRevision = event.revision; lastOrdinal = event.ordinal; lastEventTime = event.time;
        firstTime ??= event.time; lastTime = event.time; firstRevision ??= event.revision; lastEventRevision = event.revision; count += 1;
      }
      need(count <= this.#limits.maxEventsPerGroup, 'EVENT_BUDGET', '事件提交组数量超限。');
      revision = record.toRevision; time = record.throughTime;
    }
    need(this.#groupCount < this.#limits.maxGroups, 'INDEX_CAPACITY', '事件索引达到分组容量上限。');
    const coverage = coverageAfter(this.#incomplete.length, this.#incomplete[this.#incomplete.length - 1]?.lastTime ?? null, incompleteRanges);
    need(coverage.count <= this.#limits.maxIncompleteRanges, 'INDEX_CAPACITY', '旧事实覆盖区间达到容量上限。');
    if (firstTime !== null && lastTime !== null && firstRevision !== null && lastEventRevision !== null)
      this.#groups.push({ location, firstTime, lastTime, firstRevision, lastRevision: lastEventRevision });
    for (const range of incompleteRanges) {
      const last = this.#incomplete[this.#incomplete.length - 1];
      if (last && range.firstTime <= last.lastTime + 1) last.lastTime = Math.max(last.lastTime, range.lastTime);
      else this.#incomplete.push({ ...range });
    }
    if (incompleteRanges.length) this.#incompleteGroupLastTimes.push(incompleteRanges[incompleteRanges.length - 1].lastTime);
    this.#groupCount += 1; this.#revision = revision; this.#time = time; this.#sequence = group.sequence; this.#hash = location.digest;
  }
  private async restoreFollower(initial: DeepReadonly<TwinCheckpoint>): Promise<void> {
    const cursor = { projectionId: this.#identity.projectionId, stateRevision: this.#revision };
    const applyCheckpoint = (checkpoint: DeepReadonly<TwinCheckpoint>): TwinStateKernel => {
      const meta = checkpoint.state.metadata;
      need(meta.continuity.status === 'complete' && (compareDecimal(meta.cursor.stateRevision, this.#identity.anchor.stateRevision) !== 0
        || checkpoint.checksum.value === this.#identity.checkpointChecksum), 'CHECKPOINT_MISMATCH', '恢复检查点不完整或索引初态摘要不匹配。');
      return TwinStateKernel.fromCheckpoint(checkpoint, this.#options.registry, { mode: 'canonical-follower', budgets: this.#options.stateBudgets });
    };
    let kernel: TwinStateKernel;
    if (same(initial.state.metadata.cursor, cursor) && initial.checksum.value === this.#identity.checkpointChecksum) kernel = applyCheckpoint(initial);
    else {
      const session = await this.#options.archive.openReadSession({ mode: 'cursor-recovery', projectionId: cursor.projectionId, atCursor: cursor });
      try {
        need(same(session.toCursor, cursor) && session.throughTime === this.#time && session.versionDigest === this.#identity.versionDigest,
          'RECOVERY_GAP', '归档未固定事件水位的精确修订、时间和版本。');
        kernel = applyCheckpoint(await this.#options.archive.readCheckpoint(session.sessionId));
        let pageCursor: string | null = session.pageCursor;
        while (pageCursor !== null) {
          const page = await this.#options.archive.readChanges(session.sessionId, pageCursor);
          for (const batch of page.batches) kernel.applyChangeBatch(batch);
          pageCursor = page.nextCursor;
        }
      } finally { await this.#options.archive.closeReadSession(session.sessionId); }
    }
    need(same(kernel.metadata.cursor, cursor) && kernel.metadata.logicalTime === this.#time && kernel.metadata.continuity.status === 'complete',
      'RECOVERY_GAP', 'canonical-follower 没有恢复到事件索引的真实连续水位。');
    this.#kernel = kernel;
  }
  /** 只允许归档所有者把同一投影的事件索引绑定到只读查询。 */
  isBoundTo(archive: DurableHistoryArchive, projectionId: string): boolean {
    this.healthy();
    if (this.#options.archive !== archive || this.#identity.archiveId !== archive.archiveId || this.#identity.projectionId !== projectionId) return false;
    this.watermark();
    return true;
  }
  get queryLimits(): Readonly<Pick<HistoryEventIndexLimits, 'maxSessionTtlMs' | 'maxPages' | 'maxReadBytes' | 'maxPageBytes' | 'maxPageItems'>> {
    const { maxSessionTtlMs, maxPages, maxReadBytes, maxPageBytes, maxPageItems } = this.#limits;
    return { maxSessionTtlMs, maxPages, maxReadBytes, maxPageBytes, maxPageItems };
  }
  status(): EventIndexStatus {
    this.healthy(); const watermark = this.watermark(), availableFrom = Math.max(this.#identity.availableFrom, watermark.retainedFrom);
    const firstIncomplete = upperBound(this.#incomplete, range => range.lastTime < availableFrom);
    const firstIncompleteGroup = upperBound(this.#incompleteGroupLastTimes, time => time < availableFrom);
    return { indexedThrough: { projectionId: this.#identity.projectionId, stateRevision: this.#revision },
      indexedThroughTime: this.#time, availableFrom, eventGroups: this.#groups.length,
      coverage: firstIncomplete < this.#incomplete.length ? 'net-only' : 'complete',
      incompleteGroups: this.#incompleteGroupLastTimes.length - firstIncompleteGroup };
  }
  /** 每次读取固定的归档已提交上界；每页一个 fsync 提交组，组内每个批次均保存 indexedThrough，包括零事件。 */
  async sync(options: { maxPages?: number; maxReadBytes?: number; maxBatches?: number; signal?: AbortSignal; toCursor?: StateCursor; throughTime?: number } = {}): Promise<EventSyncResult> {
    this.healthy(); need(!this.#syncing, 'INDEX_BUSY', '已有事件追赶正在运行。'); this.#syncing = true;
    let advanced = false;
    try {
      const watermark = this.watermark();
      const afterCursor = { projectionId: this.#identity.projectionId, stateRevision: this.#revision };
      need(options.throughTime === undefined || options.toCursor !== undefined, 'CURSOR_RANGE', '提交时间必须绑定明确的游标。');
      // 缺口之后仍可补索引已提交的完整前缀，但绝不能追过最后连续水位。
      const ceiling = options.toCursor ?? watermark.queryableCursor;
      decimal(ceiling.stateRevision);
      if (options.throughTime !== undefined) timestamp(options.throughTime);
      need(ceiling.projectionId === afterCursor.projectionId && compareDecimal(ceiling.stateRevision, afterCursor.stateRevision) >= 0
        && compareDecimal(ceiling.stateRevision, watermark.queryableCursor.stateRevision) <= 0, 'CURSOR_RANGE', '目标游标不在连续可查询的已提交状态范围内。');
      const maxPageBatches = Math.min(this.#limits.maxRecordsPerGroup, this.#options.archive.limits.maxPageBatches);
      const session = await this.#options.archive.openReadSession({ mode: 'changes-bounded', projectionId: afterCursor.projectionId, afterCursor,
        upperCursor: ceiling, maxBatches: options.maxBatches ?? maxPageBatches, maxPages: options.maxPages,
        maxReadBytes: options.maxReadBytes, maxPageBatches });
      let result: EventSyncResult;
      try {
        need(session.committedUpperCursor && same(session.committedUpperCursor, ceiling)
          && typeof session.hasMoreCommitted === 'boolean' && compareDecimal(session.toCursor.stateRevision, ceiling.stateRevision) <= 0
          && (same(afterCursor, ceiling) || compareDecimal(session.toCursor.stateRevision, afterCursor.stateRevision) > 0),
        'REVISION_GAP', '归档没有返回有界的连续已提交游标窗口。');
        if (!session.hasMoreCommitted && options.throughTime !== undefined)
          need(session.throughTime === options.throughTime, 'CURSOR_RANGE', '提交游标与指定的实际逻辑时间不匹配。');
        let cursor: string | null = session.pageCursor;
        while (cursor !== null) {
          need(!options.signal?.aborted, 'CANCELLED', '事件追赶已取消。');
          const page = await this.#options.archive.readChanges(session.sessionId, cursor, options.signal);
          let records: RecordEntry[] = [], eventCount = 0;
          let coverage: { count: number; end: number | null } = { count: this.#incomplete.length, end: this.#incomplete[this.#incomplete.length - 1]?.lastTime ?? null };
          const body = (items: RecordEntry[]): Group => ({ format: 'history-event-group/1', sequence: nextDecimal(this.#sequence), previousHash: this.#hash, records: items });
          const headerBytes = (): number => Buffer.byteLength(canonicalStringify(body([])), 'utf8');
          let groupBytes = headerBytes();
          const flush = async (): Promise<void> => {
            if (!records.length) return;
            need(this.#groupCount < this.#limits.maxGroups, 'INDEX_CAPACITY', '事件索引达到分组容量上限。');
            const payload = pack(body(records), this.#limits.maxFrameBytes);
            need(!options.signal?.aborted && session.expiresAt > Date.now(), 'SESSION_EXPIRED', '事件追赶已取消或归档租约已过期。');
            await HistoryEventIndex.gated(this.#options, async () => {
              await this.#files.assertOwned(); this.watermark();
              need(!options.signal?.aborted && session.expiresAt > Date.now(), 'SESSION_EXPIRED', '事件追赶写入前租约已过期或取消。');
              const location = await this.#files.append(payload);
              need(!options.signal?.aborted && session.expiresAt > Date.now(), 'SESSION_EXPIRED', '事件追赶写入期间租约已过期或取消，须恢复索引。');
              this.install(location, payload);
            });
            records = []; eventCount = 0; groupBytes = headerBytes(); advanced = false;
            coverage = { count: this.#incomplete.length, end: this.#incomplete[this.#incomplete.length - 1]?.lastTime ?? null };
          };
          for (const batch of page.batches) {
            need(batch.fromRevision === this.#kernel.metadata.cursor.stateRevision, 'REVISION_GAP', '事件 follower 批次不连续。');
            const prepared = this.#kernel.prepareChangeBatch(batch);
            let committed = false;
            try {
              const projected = deriveEvents(this.#identity.archiveId, this.#identity.versionDigest, batch, this.#kernel.view, this.#limits.maxEventsPerGroup);
              const events = projected.events;
              const entry: RecordEntry = { fromRevision: batch.fromRevision, toRevision: batch.toRevision, throughTime: batch.throughTime,
                batchChecksum: batch.checksum.value, events, incompleteRanges: projected.incompleteRanges };
              const entryBytes = Buffer.byteLength(canonicalStringify(entry), 'utf8');
              if (records.length && (eventCount + events.length > this.#limits.maxEventsPerGroup
                || groupBytes + entryBytes + 1 > this.#limits.maxFrameBytes)) await flush();
              need(groupBytes + entryBytes + (records.length ? 1 : 0) <= this.#limits.maxFrameBytes,
                'EVENT_BUDGET', '单个已提交变化批次的关键事件超过帧预算，不能截断。');
              const nextCoverage = coverageAfter(coverage.count, coverage.end, entry.incompleteRanges);
              need(nextCoverage.count <= this.#limits.maxIncompleteRanges, 'INDEX_CAPACITY', '旧事实覆盖区间达到容量上限。');
              advanced = true; prepared.commit(); committed = true; coverage = nextCoverage;
              groupBytes += entryBytes + (records.length ? 1 : 0); eventCount += events.length; records.push(entry);
            } catch (error) { if (!committed) prepared.abort(); throw error; }
          }
          await flush();
          cursor = page.nextCursor;
        }
        need(this.#revision === session.toCursor.stateRevision && this.#time === session.throughTime,
          'REVISION_GAP', '归档页结束但事件水位未达到固定游标及其实际时间。');
        result = { ...this.status(), committedUpperCursor: clone(session.committedUpperCursor), hasMoreCommitted: session.hasMoreCommitted };
      } finally { await this.#options.archive.closeReadSession(session.sessionId); }
      return result;
    } catch (error) {
      if (advanced || error instanceof HistoryStorageError && /^(?:CHECKSUM|CORRUPT|FENCED|REVISION_GAP|DEPENDENCY_MISSING)/u.test(error.code)) this.#failure = error;
      throw error;
    } finally { this.#syncing = false; }
  }
  async openQuery(request: OpenEventQuery): Promise<{ queryId: string; cursor: string; expiresAt: number; indexedThrough: StateCursor }> {
    this.healthy(); const now = Date.now();
    const active = [...this.#queries.values()].filter(query => query.busy || (!query.closed && query.expiresAt > now)).length;
    need(active + this.#opening < this.#limits.maxSessions, 'SESSION_CAPACITY', '事件查询租约数达到上限。');
    need(typeof request.owner === 'string' && request.owner.length > 0 && request.owner.length <= 2048, 'SESSION', '必须绑定外层授权会话。');
    const range = clone(request.range); timestamp(range.from); timestamp(range.to);
    const anchor = request.afterEvent ? clone(request.afterEvent) : null;
    if (anchor) {
      decimal(anchor.revision); timestamp(anchor.time);
      need(/^[a-f0-9]{64}$/u.test(anchor.id) && Number.isSafeInteger(anchor.ordinal) && anchor.ordinal >= 0
        && anchor.time >= range.from && anchor.time < range.to, 'EVENT_ANCHOR', '事件锚点必须位于查询范围且具有完整身份。');
    }
    need(!request.signal?.aborted, 'CANCELLED', '事件查询已取消。');
    const direction = request.direction ?? 'forward';
    need(direction === 'forward' || direction === 'reverse', 'QUERY', '事件查询方向无效。');
    need(range.to <= 8_640_000_000_000_000, 'TIME', '事件查询超出 UTC 毫秒时间合同。');
    const bound = (value: number | undefined, max: number): number => { const n = value ?? max; need(Number.isSafeInteger(n) && n > 0 && n <= max, 'QUERY_BUDGET', '查询预算超出上限。'); return n; };
    const ttl = bound(request.ttlMs, Math.min(this.#limits.maxSessionTtlMs, this.#options.archive.limits.maxSessionTtlMs));
    const maxPages = bound(request.maxPages, this.#limits.maxPages), maxReadBytes = bound(request.maxReadBytes, this.#limits.maxReadBytes);
    const maxReadOps = bound(request.maxReadOps, this.#limits.maxReadOps), maxPageBytes = bound(request.maxPageBytes, this.#limits.maxPageBytes);
    const assertRange = (watermark: ProjectionWatermarks): void => {
      need(range.to > range.from && range.from >= Math.max(this.#identity.availableFrom, watermark.retainedFrom), 'CURSOR_EXPIRED', '事件区间早于可证明的索引或归档保留起点。');
      need(range.to <= this.#time && range.to <= watermark.queryableThrough, 'TIME_NOT_QUERYABLE', '事件索引尚未覆盖整个半开区间或区间跨缺口。');
      const partial = upperBound(this.#incomplete, item => item.lastTime < range.from);
      need(partial === this.#incomplete.length || this.#incomplete[partial].firstTime >= range.to,
        'EVENT_FACTS_MISSING', '查询范围包含旧净变化而缺少原子关键事实，不能返回完整事件或伪造空结果。');
    };
    assertRange(this.watermark()); this.#opening += 1;
    let archiveSessionId: string | null = null;
    try {
      for (const [id, query] of this.#queries) if (!query.busy && (query.closed || query.expiresAt <= Date.now())) {
        query.closed = true; this.#queries.delete(id); await this.#options.archive.closeReadSession(query.archiveSessionId);
      }
      // 空变化窗口仅固定投影及版本依赖；事件段由本索引持有，不为事件查询重放从旧检查点到起点的状态。
      const upper = { projectionId: this.#identity.projectionId, stateRevision: this.#revision }, upperTime = this.#time;
      const lease = await this.#options.archive.openReadSession({ mode: 'changes', projectionId: this.#identity.projectionId,
        afterCursor: upper, toCursor: upper, throughTime: upperTime, ttlMs: ttl });
      archiveSessionId = lease.sessionId; this.healthy(); assertRange(this.watermark());
      need(same(lease.toCursor, upper) && lease.versionDigest === this.#identity.versionDigest && lease.continuity.status === 'complete',
        'CONTINUITY_GAP', '事件租约的投影版本或连续状态不匹配。');
      const id = randomUUID(), cursor = randomUUID(), expiresAt = Math.min(now + ttl, lease.expiresAt);
      need(expiresAt > Date.now(), 'SESSION_EXPIRED', '准备事件租约时已过期。');
      const start = upperBound(this.#groups, item => item.lastTime < range.from);
      const end = upperBound(this.#groups, item => item.firstTime < range.to);
      let group = direction === 'forward' ? start : end - 1, event = direction === 'forward' ? 0 : -1;
      let readBytes = 0, readOps = 0;
      if (anchor) {
        need(compareDecimal(anchor.revision, upper.stateRevision) <= 0, 'EVENT_ANCHOR', '事件锚点超过固定提交上界。');
        const at = upperBound(this.#groups, item => compareDecimal(item.lastRevision, anchor.revision) < 0);
        const entry = this.#groups[at];
        need(at >= start && at < end && entry && compareDecimal(entry.firstRevision, anchor.revision) <= 0,
          'EVENT_ANCHOR', '事件锚点不属于保留的索引。');
        need(entry.location.bytes <= maxReadBytes, 'QUERY_BUDGET', '定位事件锚点超过实际读取预算。');
        const payload = await this.#files.readFrame(entry.location, {
          onRead: () => { need(readOps < maxReadOps, 'QUERY_BUDGET', '定位事件锚点超过读取次数预算。'); readOps += 1; },
          onBytes: bytes => { readBytes += bytes; },
        });
        const candidate = this.parseGroup(payload);
        const events = candidate.records.flatMap(record => record.events);
        const position = events.findIndex(item => item.id === anchor.id && item.revision === anchor.revision
          && item.ordinal === anchor.ordinal && item.time === anchor.time);
        need(position >= 0, 'EVENT_ANCHOR', '事件锚点未出现在已提交的索引帧中。');
        const step = direction === 'forward' ? 1 : -1;
        group = at; event = position + step;
        if (event < 0 || event >= events.length) { group += step; event = direction === 'forward' ? 0 : -1; }
      }
      need(!request.signal?.aborted && expiresAt > Date.now(), 'SESSION_EXPIRED', '事件查询准备时已取消或过期。');
      this.#queries.set(id, { id, owner: request.owner, range, direction, expiresAt, cursor, group, event, firstGroup: start, lastGroup: end,
        pages: 0, readBytes, readOps, maxPages, maxReadBytes, maxReadOps, maxPageBytes, busy: false, closed: false, cancelled: false, upper, archiveSessionId });
      archiveSessionId = null;
      return { queryId: id, cursor, expiresAt, indexedThrough: clone(upper) };
    } catch (error) {
      if (error instanceof HistoryStorageError && /^(?:CHECKSUM|CORRUPT|DEPENDENCY_MISSING)/u.test(error.code)) this.#failure = error;
      throw error;
    } finally {
      try { if (archiveSessionId !== null) await this.#options.archive.closeReadSession(archiveSessionId); }
      finally { this.#opening -= 1; }
    }
  }
  async readQuery(owner: string, queryId: string, cursor: string, limit: number, signal?: AbortSignal): Promise<EventQueryPage> {
    this.healthy(); const query = this.#queries.get(queryId);
    need(query && query.owner === owner && !query.closed && query.expiresAt > Date.now(), 'SESSION_EXPIRED', '事件会话不存在、未授权或已过期。');
    need(query.cursor === cursor, 'PAGE_CURSOR', '事件游标过期或不属于此会话。');
    need(!query.busy && this.#reads < this.#limits.maxConcurrentReads, 'QUERY_BUSY', '事件读取并发已满。');
    need(Number.isSafeInteger(limit) && limit > 0 && limit <= this.#limits.maxPageItems && query.pages < query.maxPages, 'QUERY_BUDGET', '事件页条数或次数超过预算。');
    query.busy = true; query.pages += 1; this.#reads += 1;
    try {
      let groupIndex = query.group, eventIndex = query.event;
      let pageBytes = Buffer.byteLength(canonicalStringify({ queryId, cursor, nextCursor: '0'.repeat(36), hasMore: true,
        expiresAt: query.expiresAt, range: query.range, direction: query.direction, indexedThrough: query.upper, items: [], readBytes: query.maxReadBytes, readOps: query.maxReadOps }), 'utf8');
      need(pageBytes <= query.maxPageBytes, 'PAGE_BUDGET', '事件响应信封超过页字节预算。');
      const items: IndexedHistoryEvent[] = []; let hasMore = false, exhausted = false;
      const reverse = query.direction === 'reverse', step = reverse ? -1 : 1;
      while (groupIndex >= query.firstGroup && groupIndex < query.lastGroup) {
        need(!signal?.aborted && !query.closed && query.expiresAt > Date.now(), 'CANCELLED', '事件查询已取消或过期。');
        const groupEntry = this.#groups[groupIndex];
        need(query.readBytes + groupEntry.location.bytes <= query.maxReadBytes, 'QUERY_BUDGET', '事件会话实际磁盘读取字节超过预算。');
        const payload = await this.#files.readFrame(groupEntry.location, {
          onRead: () => { need(query.readOps < query.maxReadOps, 'QUERY_BUDGET', '事件会话实际读取次数超过预算。'); query.readOps += 1; },
          onBytes: bytes => { query.readBytes += bytes; },
        });
        const group = this.parseGroup(payload);
        const events = group.records.flatMap(record => record.events);
        if (reverse && eventIndex < 0) eventIndex = events.length - 1;
        while (eventIndex >= 0 && eventIndex < events.length) {
          const event = events[eventIndex];
          if (reverse ? event.time >= query.range.to : event.time < query.range.from) { eventIndex += step; continue; }
          if (reverse ? event.time < query.range.from : event.time >= query.range.to) { exhausted = true; break; }
          const bytes = Buffer.byteLength(canonicalStringify(event), 'utf8') + 1;
          if (items.length >= limit || pageBytes + bytes > query.maxPageBytes) {
            need(items.length > 0, 'PAGE_BUDGET', '单个事件或响应信封超过页字节预算。'); hasMore = true; break;
          }
          items.push(event); pageBytes += bytes; eventIndex += step;
        }
        if (hasMore || exhausted) break;
        groupIndex += step; eventIndex = reverse ? -1 : 0;
      }
      need(!signal?.aborted && !query.closed && query.expiresAt > Date.now(), 'CANCELLED', '事件查询已取消或过期。');
      const watermark = this.watermark();
      need(query.range.to <= watermark.queryableThrough, 'CONTINUITY_GAP', '查询期间归档的连续水位发生变化。');
      query.group = groupIndex; query.event = eventIndex; const nextCursor = hasMore ? randomUUID() : null; query.cursor = nextCursor ?? '';
      if (!hasMore) {
        query.closed = true; await this.#options.archive.closeReadSession(query.archiveSessionId);
        need(!signal?.aborted && !query.cancelled && query.expiresAt > Date.now(), 'SESSION_EXPIRED', '事件页交付前租约已过期或请求已取消。');
      }
      return { queryId, cursor, nextCursor, hasMore, expiresAt: query.expiresAt, range: clone(query.range), direction: query.direction, indexedThrough: clone(query.upper), items,
        readBytes: query.readBytes, readOps: query.readOps };
    } catch (error) {
      if (error instanceof HistoryStorageError && /^(?:CHECKSUM|CORRUPT|DEPENDENCY_MISSING)/u.test(error.code)) this.#failure = error;
      throw error;
    } finally { query.busy = false; this.#reads -= 1; if (query.closed) this.#queries.delete(query.id); }
  }
  async closeQuery(owner: string, queryId: string): Promise<void> {
    const query = this.#queries.get(queryId); if (!query) return;
    need(query.owner === owner, 'SESSION', '事件会话不属于调用方。'); query.cancelled = true; query.closed = true;
    await this.#options.archive.closeReadSession(query.archiveSessionId);
    if (!query.busy) this.#queries.delete(queryId);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    need(!this.#closing && !this.#syncing && this.#opening === 0 && ![...this.#queries.values()].some(query => query.busy),
      'INDEX_BUSY', '追赶或读取进行中，先取消并等待结束。');
    this.#closing = true;
    try {
      for (const query of this.#queries.values()) { query.closed = true; await this.#options.archive.closeReadSession(query.archiveSessionId); }
      this.#queries.clear();
      await HistoryEventIndex.gated(this.#options, async () => this.#files.release()); this.#closed = true;
    } finally { this.#closing = false; }
  }
}
