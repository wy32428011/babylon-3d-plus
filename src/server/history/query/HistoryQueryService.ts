import { createHash, randomUUID } from 'node:crypto';
import { canonicalStringify, compareDecimal } from '../../../runtime/history/state/safeJson.ts';
import type { StateCursor } from '../../../runtime/history/state/types.ts';
import type { HistoryChangePage, HistoryReadSession, ReadSessionRequest } from '../storage/types.ts';
import { HistoryQueryError } from './types.ts';
import type { QueryOptions, ReadAction, ReadGrant, ReadIdentity, TimeRange } from './types.ts';

type LeaseBudget = { id: string | null; limit: number; accounted: number; active: number; released: boolean };
type Snapshot = { id: string; requestId: string; requested: number | null; generation: number; bytes: Buffer; chunkSize: number; cursor: StateCursor; expiresAt: number; lease: string; response: Record<string, unknown> };
type Job = { generation: number; requested: number | null; controller: AbortController };
type Window = { id: string; generation: number; lease: string; budget: LeaseBudget; expiresAt: number; pageCursor: string; after: StateCursor; to: StateCursor; through: number; done: boolean };
type Session = {
  id: string; grantId: string; grantFrom: number; grantTo: number; identity: ReadIdentity; mode: 'history' | 'live'; range: TimeRange | null;
  expiresAt: number; generation: number; usedBytes: number; reservedBytes: number; pages: number; snapshots: Map<string, Snapshot>;
  windows: Map<string, Window>; openingWindows: number; cursors: Set<string>; jobs: Map<string, Job>; closed: boolean;
};
const MAX_TIME = 8_640_000_000_000_000;
function requireValue(value: unknown, code: string, message: string): asserts value { if (!value) throw new HistoryQueryError(code, message); }
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  requireValue(typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_REQUEST', '查询参数必须是普通对象。');
  const source = value as Record<string, unknown>;
  requireValue(Reflect.ownKeys(source).every(k => typeof k === 'string' && allowed.includes(k) && 'value' in Object.getOwnPropertyDescriptor(source, k)!), 'INVALID_REQUEST', '查询参数包含未声明字段。');
  return source;
}
function id(value: unknown): string { requireValue(typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/u.test(value), 'INVALID_REQUEST', '标识格式无效。'); return value; }
function integer(value: unknown, min = 0, max = MAX_TIME): number { requireValue(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max, 'INVALID_REQUEST', '整数参数无效。'); return value as number; }
function range(value: unknown): TimeRange { const r = object(value, ['from', 'to']); const from = integer(r.from), to = integer(r.to); requireValue(from < to, 'INVALID_REQUEST', '时间范围无效。'); return { from, to }; }
function cursor(value: unknown): StateCursor { const r = object(value, ['projectionId', 'stateRevision']); const projectionId = id(r.projectionId), stateRevision = id(r.stateRevision); requireValue(/^(0|[1-9][0-9]{0,255})$/u.test(stateRevision), 'INVALID_REQUEST', '状态修订无效。'); return { projectionId, stateRevision }; }
function sameCursor(a: StateCursor, b: StateCursor): boolean { return a.projectionId === b.projectionId && a.stateRevision === b.stateRevision; }
function sameIdentity(a: ReadIdentity, b: ReadIdentity): boolean { return a.projectId === b.projectId && a.cacheRevision === b.cacheRevision && a.publishedVersionId === b.publishedVersionId && a.bindingRevision === b.bindingRevision && a.projectionId === b.projectionId; }
function identity(value: unknown): ReadIdentity { const x = object(value, ['projectId', 'cacheRevision', 'publishedVersionId', 'bindingRevision', 'projectionId']); return { projectId: id(x.projectId), cacheRevision: id(x.cacheRevision), publishedVersionId: id(x.publishedVersionId), bindingRevision: id(x.bindingRevision), projectionId: id(x.projectionId) }; }
function hash(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function positive(value: number | undefined, fallback: number, maximum: number): number { return integer(value ?? fallback, 1, maximum); }

/** 仅在拥有真实 writer/fencing 的进程中实例化。不能自行再打开同一归档，也不监听公共 HTTP。 */
export class HistoryQueryService {
  readonly #sessions = new Map<string, Session>();
  readonly #maxSessions: number; readonly #ttl: number; readonly #maxSnapshot: number; readonly #maxTotal: number;
  readonly #maxChunks: number; readonly #chunk: number; readonly #maxPage: number; readonly #maxPages: number;
  readonly #maxRead: number; readonly #maxLeaseRead: number; readonly #maxConcurrent: number;
  #snapshotBytes = 0; #running = 0; #controls = 0;
  constructor(readonly options: QueryOptions) {
    requireValue(options.archive && options.registry && options.authority && typeof options.authority.runAuthorized === 'function'
      && typeof options.authority.coverage === 'function' && typeof options.replayAbi === 'string' && options.replayAbi.length > 0,
    'AUTHORITY_REQUIRED', '缺少真实的归档所有权、授权或覆盖索引端口。');
    this.#maxSessions = positive(options.maxSessions, 16, 64);
    this.#ttl = positive(options.maxSessionTtlMs, 60_000, Math.min(options.archive.limits.maxSessionTtlMs, 300_000));
    this.#maxSnapshot = positive(options.maxSnapshotBytes, 32 * 1024 * 1024, 64 * 1024 * 1024);
    this.#maxTotal = positive(options.maxTotalSnapshotBytes, 64 * 1024 * 1024, 256 * 1024 * 1024);
    this.#maxChunks = positive(options.maxChunks, 128, 1024);
    this.#chunk = positive(options.chunkBytes, 256 * 1024, 1024 * 1024);
    this.#maxPage = positive(options.maxPageBytes, 1024 * 1024, Math.min(4 * 1024 * 1024, options.archive.limits.maxPageBytes));
    this.#maxPages = positive(options.maxPages, 128, Math.min(1024, options.archive.limits.maxPagesPerSession));
    this.#maxRead = positive(options.maxReadBytes, Math.min(512 * 1024 * 1024, options.archive.limits.maxReadBytesPerSession), options.archive.limits.maxReadBytesPerSession);
    this.#maxLeaseRead = positive(options.maxLeaseReadBytes, Math.min(64 * 1024 * 1024, this.#maxRead), this.#maxRead);
    this.#maxConcurrent = positive(options.maxConcurrent, 4, 32);
    requireValue(this.#maxPage >= 16_384 && this.#chunk * this.#maxChunks >= this.#maxSnapshot && Math.ceil(this.#chunk * 4 / 3) + 4096 <= this.#maxPage,
      'QUERY_BUDGET', '快照分块或响应预算不一致。');
  }
  async dispatch(grant: ReadGrant, action: ReadAction, value: unknown, signal?: AbortSignal): Promise<unknown> {
    this.#validateGrant(grant); requireValue(!signal?.aborted, 'CANCELLED', '请求已取消。');
    const actions: ReadAction[] = ['coverage', 'sessions/open', 'state/at', 'state/chunk', 'state/cancel', 'changes/query', 'events/query', 'sessions/close'];
    requireValue(actions.includes(action), 'ACTION_NOT_FOUND', '不支持的查询动作。');
    // 取消和关闭不能被恢复作业占满的并发预算挡住。
    const counted = action !== 'state/cancel' && action !== 'sessions/close';
    if (counted) { requireValue(this.#running < this.#maxConcurrent, 'QUERY_BUSY', '查询并发已达上限。'); this.#running += 1; }
    else { requireValue(this.#controls < this.#maxConcurrent, 'QUERY_BUSY', '取消或关闭并发已达上限。'); this.#controls += 1; }
    try {
      return await this.options.authority.runAuthorized(grant, action, async () => {
        this.#validateGrant(grant); requireValue(!signal?.aborted, 'CANCELLED', '请求已取消。');
        const result = await this.#execute(grant, action, value, signal);
        this.#validateGrant(grant); requireValue(!signal?.aborted, 'CANCELLED', '请求已取消。');
        return result;
      });
    } finally { if (counted) this.#running -= 1; else this.#controls -= 1; }
  }
  #validateGrant(grant: ReadGrant): void {
    requireValue(grant && typeof grant === 'object', 'ACCESS_DENIED', '缺少只读授权。');
    id(grant.grantId); identity(grant.identity); integer(grant.from); integer(grant.to); integer(grant.expiresAt);
    requireValue(grant.from < grant.to && grant.identity.projectId === this.options.archive.scope.projectId, 'ACCESS_DENIED', '只读授权不属于归档项目或时间范围无效。');
    requireValue(grant.expiresAt > Date.now(), 'CAPABILITY_EXPIRED', '只读能力已过期。');
  }
  #projection(grant: ReadGrant) {
    const mark = this.options.archive.getWatermarks().projections.find(p => p.projectionId === grant.identity.projectionId);
    requireValue(mark && mark.versions.projectId === grant.identity.projectId && mark.versions.publishedVersionId === grant.identity.publishedVersionId
      && mark.versions.bindingRevision === grant.identity.bindingRevision, 'VERSION_MISMATCH', '投影与请求版本不匹配。');
    return mark;
  }
  #scope(grant: ReadGrant, r: TimeRange): void { requireValue(r.from >= grant.from && r.to <= grant.to, 'ACCESS_DENIED', '请求超出只读授权的时间范围。'); }
  #session(grant: ReadGrant, value: unknown): Session {
    const s = this.#sessions.get(id(value));
    requireValue(s && !s.closed && s.expiresAt > Date.now(), 'SESSION_EXPIRED', '读取会话不存在、已关闭或已过期。');
    requireValue(s.grantId === grant.grantId && sameIdentity(s.identity, grant.identity) && s.expiresAt <= grant.expiresAt
      && grant.from <= s.grantFrom && grant.to >= s.grantTo, 'ACCESS_DENIED', '会话不属于当前只读授权或授权范围已收窄。');
    this.#projection(grant); return s;
  }
  #budget(s: Session, bytes: number, page = false): void {
    requireValue(Number.isSafeInteger(bytes) && bytes >= 0 && s.usedBytes + s.reservedBytes + bytes <= this.#maxRead && (!page || s.pages < this.#maxPages), 'QUERY_BUDGET', '读取会话预算已耗尽。');
    s.usedBytes += bytes; if (page) s.pages += 1;
  }
  /** 活跃子租约先保留额度，按归档的实际磁盘/解压计数结算，未使用额度在租约不再读取时归还。 */
  #reserveLease(s: Session): LeaseBudget {
    const remaining = this.#maxRead - s.usedBytes - s.reservedBytes;
    requireValue(remaining > 0, 'QUERY_BUDGET', '读取会话总预算已耗尽。');
    const limit = Math.min(this.#maxLeaseRead, remaining); s.reservedBytes += limit;
    return { id: null, limit, accounted: 0, active: 0, released: false };
  }
  #finishLease(s: Session, budget: LeaseBudget, uncertain = false): void {
    if (budget.released) return;
    const remaining = budget.limit - budget.accounted;
    s.reservedBytes -= remaining;
    if (uncertain) s.usedBytes += remaining;
    budget.released = true;
  }
  #syncLease(s: Session, budget: LeaseBudget): void {
    if (budget.released) return;
    try {
      requireValue(budget.id, 'QUERY_ACCOUNTING_UNAVAILABLE', '归档读取租约不存在。');
      const usage = this.options.archive.getReadSessionUsage(budget.id);
      requireValue(Number.isSafeInteger(usage.readBytes) && usage.readBytes >= budget.accounted && usage.readBytes <= budget.limit,
        'QUERY_ACCOUNTING_UNAVAILABLE', '归档读取用量不可信。');
      const delta = usage.readBytes - budget.accounted;
      budget.accounted = usage.readBytes; s.reservedBytes -= delta; s.usedBytes += delta;
    } catch {
      this.#finishLease(s, budget, true);
      throw new HistoryQueryError('QUERY_ACCOUNTING_UNAVAILABLE', '归档读取用量不可用，不能继续查询。');
    }
  }
  async #openLease(s: Session, request: ReadSessionRequest): Promise<{ view: HistoryReadSession; budget: LeaseBudget }> {
    const budget = this.#reserveLease(s); let view: HistoryReadSession | undefined;
    try {
      view = await this.options.archive.openReadSession({ ...request, maxReadBytes: budget.limit });
      budget.id = view.sessionId; this.#syncLease(s, budget); return { view, budget };
    } catch (error) {
      this.#finishLease(s, budget, true);
      if (view) await this.options.archive.closeReadSession(view.sessionId);
      throw error;
    }
  }
  async #readLease<T>(s: Session, budget: LeaseBudget, operation: () => Promise<T>): Promise<T> {
    requireValue(!budget.released, 'SESSION_EXPIRED', '归档读取租约已结束。');
    budget.active += 1;
    try { return await operation(); }
    finally { budget.active -= 1; this.#syncLease(s, budget); }
  }
  async #closeSnapshot(s: Session, snapshot: Snapshot): Promise<void> {
    if (!s.snapshots.delete(snapshot.id)) return;
    this.#snapshotBytes -= snapshot.bytes.length;
    await this.options.archive.closeReadSession(snapshot.lease);
  }
  async #closeWindow(s: Session, window: Window): Promise<void> {
    if (!s.windows.delete(window.id)) return;
    try {
      if (window.budget.active) this.#finishLease(s, window.budget, true);
      else { this.#syncLease(s, window.budget); this.#finishLease(s, window.budget); }
    } finally { await this.options.archive.closeReadSession(window.lease); }
  }
  async #close(s: Session): Promise<void> {
    if (s.closed) return; s.closed = true; this.#sessions.delete(s.id);
    for (const job of s.jobs.values()) job.controller.abort();
    await Promise.all([...s.snapshots.values()].map(x => this.#closeSnapshot(s, x)).concat([...s.windows.values()].map(x => this.#closeWindow(s, x))));
  }
  async #sweep(): Promise<void> { for (const s of [...this.#sessions.values()]) if (s.expiresAt <= Date.now()) await this.#close(s); }
  #current(s: Session, generation: number, signal?: AbortSignal): void {
    requireValue(!signal?.aborted, 'CANCELLED', '请求已取消。');
    requireValue(!s.closed, 'SESSION_CLOSED', '读取会话已关闭。');
    requireValue(s.expiresAt > Date.now(), 'SESSION_EXPIRED', '读取会话已过期。');
    requireValue(s.generation === generation, 'GENERATION_STALE', '请求已被新代次取代。');
  }
  async #execute(grant: ReadGrant, action: ReadAction, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (action === 'coverage') {
      const req = object(input, ['identity', 'range']); requireValue(sameIdentity(identity(req.identity), grant.identity), 'VERSION_MISMATCH', '查询身份不匹配。');
      const r = range(req.range); this.#scope(grant, r); const mark = this.#projection(grant), coverage = await this.options.authority.coverage(grant, r);
      requireValue(coverage && typeof coverage.sourceName === 'string' && coverage.sourceName.length > 0 && coverage.sourceName.length <= 256
        && typeof coverage.sourceQuality === 'string' && coverage.sourceQuality.length > 0 && coverage.sourceQuality.length <= 256
        && Array.isArray(coverage.versionBoundaries) && coverage.versionBoundaries.length <= 128
        && coverage.versionBoundaries.every(b => Number.isSafeInteger(b.time) && b.time >= r.from && b.time <= r.to && typeof b.versionLabel === 'string' && b.versionLabel.length > 0 && b.versionLabel.length <= 256), 'COVERAGE_INDEX_UNAVAILABLE', '版本覆盖索引不可用或不完整。');
      const gaps: { from: number; to: number; reason: string }[] = [];
      if (r.from < mark.retainedFrom) gaps.push({ from: r.from, to: Math.min(r.to, mark.retainedFrom), reason: '早于可恢复留存起点' });
      if (r.to > mark.queryableThrough) { const from = Math.max(r.from, mark.retainedFrom, mark.queryableThrough); if (from < r.to) gaps.push({ from, to: r.to, reason: mark.continuity.status === 'gap' ? mark.continuity.reason : '超过连续可查询水位' }); }
      return { identity: grant.identity, range: r, sourceName: coverage.sourceName, sourceQuality: coverage.sourceQuality, queryableThrough: mark.queryableThrough, gaps, versionBoundaries: coverage.versionBoundaries };
    }
    if (action === 'sessions/open') {
      const req = object(input, ['identity', 'mode', 'range']); requireValue(sameIdentity(identity(req.identity), grant.identity), 'VERSION_MISMATCH', '查询身份不匹配。');
      requireValue(req.mode === 'history' || req.mode === 'live', 'INVALID_REQUEST', '会话模式无效。');
      const selectedRange = req.range === null ? null : range(req.range); requireValue(req.mode === 'live' ? selectedRange === null : selectedRange !== null, 'INVALID_REQUEST', '会话时间范围与模式不匹配。');
      if (selectedRange) this.#scope(grant, selectedRange);
      const mark = this.#projection(grant);
      if (req.mode === 'live') requireValue(!mark.closed && mark.continuity.status === 'complete' && mark.queryableThrough === mark.committedThroughTime && mark.queryableThrough >= grant.from && mark.queryableThrough <= grant.to,
        'LIVE_NOT_READY', '有效投影未连续就绪或不在授权范围。');
      await this.#sweep(); requireValue(this.#sessions.size < this.#maxSessions, 'SESSION_CAPACITY', '读取会话数量已达上限。');
      const s: Session = { id: randomUUID(), grantId: grant.grantId, grantFrom: grant.from, grantTo: grant.to, identity: { ...grant.identity }, mode: req.mode, range: selectedRange,
        expiresAt: Math.min(grant.expiresAt, Date.now() + this.#ttl), generation: -1, usedBytes: 0, reservedBytes: 0, pages: 0,
        snapshots: new Map(), windows: new Map(), openingWindows: 0, cursors: new Set(), jobs: new Map(), closed: false };
      this.#sessions.set(s.id, s);
      return { sessionId: s.id, identity: s.identity, versions: mark.versions, mode: s.mode, readOnly: true, expiresAt: s.expiresAt, replayAbi: this.options.replayAbi,
        limits: { maxSnapshotBytes: this.#maxSnapshot, maxChunks: this.#maxChunks, maxPageBytes: this.#maxPage, maxPages: this.#maxPages } };
    }
    const req = object(input, action === 'state/at' ? ['sessionId', 'generation', 'requestId', 'asOf']
      : action === 'state/chunk' ? ['sessionId', 'generation', 'snapshotId', 'index']
        : action === 'state/cancel' ? ['sessionId', 'requestId']
          : action === 'changes/query' ? ['sessionId', 'generation', 'afterCursor', 'windowId', 'toCursor', 'throughTime']
            : action === 'events/query' ? ['sessionId', 'range', 'queryId', 'cursor', 'limit'] : ['sessionId']);
    const s = this.#session(grant, req.sessionId);
    if (s.mode === 'live' && action !== 'sessions/close' && action !== 'state/cancel') {
      const live = this.#projection(grant);
      requireValue(!live.closed && live.continuity.status === 'complete' && live.queryableThrough === live.committedThroughTime,
        'LIVE_NOT_READY', '实时投影已关闭、断档或不再连续。');
    }
    if (action === 'sessions/close') { await this.#close(s); return { closed: true }; }
    if (action === 'state/cancel') { const job = s.jobs.get(id(req.requestId)); if (job) job.controller.abort(); return { cancelled: Boolean(job) }; }
    if (action === 'events/query') {
      const r = range(req.range); this.#scope(grant, r);
      requireValue(!s.range || r.from >= s.range.from && r.to <= s.range.to, 'ACCESS_DENIED', '事件范围超出会话范围。');
      integer(req.limit, 1, 1000);
      throw new HistoryQueryError('EVENT_INDEX_UNAVAILABLE', '尚无可验证的关键事件索引；不能以空结果表示无事件。');
    }
    const generation = integer(req.generation, 0, Number.MAX_SAFE_INTEGER);
    if (action === 'state/at') return this.#stateAt(s, grant, req, generation, signal);
    if (action === 'changes/query' && generation > s.generation) {
      requireValue(req.windowId === null, 'GENERATION_STALE', '新代次不能沿用旧分页窗口。');
      s.generation = generation;
      for (const job of s.jobs.values()) job.controller.abort();
      await Promise.all([...s.windows.values()].map(x => this.#closeWindow(s, x)));
    }
    this.#current(s, generation, signal);
    if (action === 'state/chunk') {
      const snap = s.snapshots.get(id(req.snapshotId)); requireValue(snap && snap.generation === generation && snap.expiresAt > Date.now(), 'SNAPSHOT_EXPIRED', '快照已过期或不属于当前代次。');
      const index = integer(req.index, 0, this.#maxChunks - 1), start = index * snap.chunkSize;
      requireValue(start < snap.bytes.length, 'CHUNK_NOT_FOUND', '快照分块不存在。');
      const bytes = snap.bytes.subarray(start, Math.min(start + snap.chunkSize, snap.bytes.length));
      const response = { snapshotId: snap.id, index, cursor: snap.cursor, encoding: 'base64', data: bytes.toString('base64') };
      this.#budget(s, Buffer.byteLength(JSON.stringify(response)));
      return response;
    }
    return this.#changes(s, grant, req, generation, signal);
  }
  async #stateAt(s: Session, grant: ReadGrant, req: Record<string, unknown>, generation: number, signal?: AbortSignal): Promise<unknown> {
    const requestId = id(req.requestId);
    const requested = req.asOf === null ? null : integer(req.asOf);
    const mark = this.#projection(grant);
    requireValue(s.mode === 'live' ? requested === null && !mark.closed && mark.continuity.status === 'complete' && mark.queryableThrough === mark.committedThroughTime : requested !== null,
      'LIVE_NOT_READY', '实时状态不可用或历史目标无效。');
    if (generation === s.generation) {
      const pending = s.jobs.get(requestId);
      if (pending && pending.generation === generation && pending.requested === requested && !pending.controller.signal.aborted) return { status: 'pending', retryAfterMs: 100 };
      const cached = [...s.snapshots.values()].find(x => x.requestId === requestId && x.generation === generation && x.requested === requested);
      if (cached && cached.expiresAt > Date.now()) { this.#budget(s, Buffer.byteLength(JSON.stringify(cached.response))); return structuredClone(cached.response); }
      throw new HistoryQueryError('GENERATION_STALE', '恢复身份已失效或请求参数不一致。');
    }
    requireValue(!s.jobs.has(requestId) && generation > s.generation, 'GENERATION_STALE', '请求身份重复或代次已失效。');
    const target = requested ?? mark.queryableThrough;
    requireValue(target >= grant.from && target <= grant.to && (!s.range || target >= s.range.from && target <= s.range.to), 'ACCESS_DENIED', '目标不在会话授权范围。');
    s.generation = generation; for (const job of s.jobs.values()) job.controller.abort();
    const job = new AbortController(); s.jobs.set(requestId, { generation, requested, controller: job });
    const abort = () => job.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) job.abort();
    let lease: HistoryReadSession | null = null, leaseBudget: LeaseBudget | null = null;
    try {
      await Promise.all([...s.snapshots.values()].map(x => this.#closeSnapshot(s, x)).concat([...s.windows.values()].map(x => this.#closeWindow(s, x))));
      s.cursors.clear(); this.#current(s, generation, job.signal);
      const opened = await this.#openLease(s, { mode: 'as-of', projectionId: s.identity.projectionId, targetTime: target,
        ttlMs: Math.max(1, Math.min(s.expiresAt - Date.now(), this.options.archive.limits.maxSessionTtlMs)), maxPageBytes: Math.min(this.#maxPage - 8192, this.options.archive.limits.maxPageBytes),
        maxPages: Math.min(this.#maxPages, this.options.archive.limits.maxPagesPerSession) });
      lease = opened.view; leaseBudget = opened.budget;
      this.#current(s, generation, job.signal);
      requireValue(lease.checkpoint && lease.checkpoint.logicalTime >= grant.from && lease.continuity.status === 'complete', 'BASELINE_OUTSIDE_SCOPE', '恢复检查点超出授权时间或不完整。');
      const checkpoint = await this.#readLease(s, leaseBudget, () => this.options.archive.readCheckpoint(lease!.sessionId, job.signal));
      const bytes = Buffer.from(canonicalStringify(checkpoint), 'utf8');
      requireValue(bytes.length > 0 && bytes.length <= this.#maxSnapshot && Math.ceil(bytes.length / this.#chunk) <= this.#maxChunks
        && this.#snapshotBytes + bytes.length <= this.#maxTotal, 'SNAPSHOT_BUDGET', '完整快照超过容量预算。');
      this.#budget(s, 0, true);
      let next: string | null = lease.pageCursor, resolved = lease.actualTime, last = lease.afterCursor;
      while (next !== null) {
        this.#current(s, generation, job.signal);
        const current: string = next;
        const page: HistoryChangePage = await this.#readLease<HistoryChangePage>(s, leaseBudget, () => this.options.archive.readChanges(lease!.sessionId, current, job.signal));
        this.#budget(s, 0, true); requireValue(sameCursor(last, page.afterCursor), 'REVISION_GAP', '变化读取不连续。');
        last = page.nextStateCursor; resolved = page.actualTime; next = page.nextCursor;
      }
      requireValue(sameCursor(last, lease.toCursor) && resolved <= target && resolved >= lease.checkpoint.logicalTime, 'REVISION_GAP', '目标时刻的固定变化链不完整。');
      this.#finishLease(s, leaseBudget);
      this.#budget(s, bytes.length);
      this.#current(s, generation, job.signal);
      requireValue(this.#snapshotBytes + bytes.length <= this.#maxTotal, 'SNAPSHOT_BUDGET', '完整快照超过容量预算。');
      const snapshotId = randomUUID(), expiresAt = Math.min(s.expiresAt, lease.expiresAt), snapshotCursor = lease.afterCursor;
      const chunks = []; for (let offset = 0, index = 0; offset < bytes.length; offset += this.#chunk, index += 1) { const part = bytes.subarray(offset, Math.min(offset + this.#chunk, bytes.length)); chunks.push({ index, byteLength: part.length, sha256: hash(part) }); }
      const response = { status: 'ready', snapshot: { snapshotId, identity: s.identity, cursor: snapshotCursor, requestedTime: requested,
        checkpointTime: checkpoint.state.metadata.logicalTime, resolvedTime: resolved, coveredThrough: target, throughCursor: last, queryableThrough: lease.queryableThrough,
        expiresAt, byteLength: bytes.length, chunks,
        resume: s.mode === 'live' ? { toCursor: last, throughTime: target, leaseExpiresAt: expiresAt } : null } };
      this.#budget(s, Buffer.byteLength(JSON.stringify(response)));
      const snap: Snapshot = { id: snapshotId, requestId, requested, generation, bytes, chunkSize: this.#chunk, cursor: snapshotCursor, expiresAt, lease: lease.sessionId, response };
      this.#snapshotBytes += bytes.length; s.snapshots.set(snap.id, snap); s.cursors.add(`${snap.cursor.projectionId}:${snap.cursor.stateRevision}`); lease = null;
      return structuredClone(response);
    } finally {
      signal?.removeEventListener('abort', abort); s.jobs.delete(requestId);
      if (leaseBudget) this.#finishLease(s, leaseBudget, leaseBudget.active > 0);
      if (lease) await this.options.archive.closeReadSession(lease.sessionId);
    }
  }
  async #changes(s: Session, grant: ReadGrant, req: Record<string, unknown>, generation: number, signal?: AbortSignal): Promise<unknown> {
    const after = cursor(req.afterCursor), mark = this.#projection(grant);
    const liveTail = req.throughTime === null;
    requireValue(!liveTail || s.mode === 'live' && req.windowId === null && req.toCursor === null
      && !mark.closed && mark.continuity.status === 'complete' && mark.queryableThrough === mark.committedThroughTime,
    'LIVE_NOT_READY', '只有连续就绪的实时首窗口可由服务端选择水位。');
    const through = liveTail ? mark.queryableThrough : integer(req.throughTime);
    requireValue(after.projectionId === s.identity.projectionId && through >= grant.from && through <= grant.to
      && (!s.range || through <= s.range.to), 'ACCESS_DENIED', '变化范围超出会话范围。');
    requireValue(through <= mark.queryableThrough, 'TIME_NOT_QUERYABLE', '变化范围超过连续可查询水位。');
    let window: Window;
    if (req.windowId === null) {
      requireValue(s.cursors.has(`${after.projectionId}:${after.stateRevision}`), 'CURSOR_UNISSUED', '变化起点未由本会话授权发放。');
      const requestedTo = req.toCursor === null ? undefined : cursor(req.toCursor);
      await Promise.all([...s.windows.values()].filter(x => x.expiresAt <= Date.now()).map(x => this.#closeWindow(s, x)));
      this.#current(s, generation, signal);
      requireValue(s.windows.size + s.openingWindows < 4, 'SESSION_CAPACITY', '单个会话的变化窗口数量已达上限。');
      s.openingWindows += 1;
      let opened: { view: HistoryReadSession; budget: LeaseBudget };
      try {
        opened = await this.#openLease(s, { mode: 'changes', projectionId: s.identity.projectionId, afterCursor: after, toCursor: requestedTo, throughTime: through,
          ttlMs: Math.max(1, Math.min(s.expiresAt - Date.now(), this.options.archive.limits.maxSessionTtlMs)), maxPageBytes: Math.min(this.#maxPage - 8192, this.options.archive.limits.maxPageBytes),
          maxPages: Math.min(this.#maxPages, this.options.archive.limits.maxPagesPerSession) });
      } finally { s.openingWindows -= 1; }
      try {
        this.#current(s, generation, signal);
        requireValue(opened.view.continuity.status === 'complete' && (!requestedTo || sameCursor(requestedTo, opened.view.toCursor)), 'CURSOR_RANGE', '固定变化上界不匹配或存在缺口。');
        window = { id: randomUUID(), generation, lease: opened.view.sessionId, budget: opened.budget, expiresAt: Math.min(s.expiresAt, opened.view.expiresAt), pageCursor: opened.view.pageCursor, after, to: opened.view.toCursor, through, done: false }; s.windows.set(window.id, window);
      } catch (error) { this.#finishLease(s, opened.budget); await this.options.archive.closeReadSession(opened.view.sessionId); throw error; }
    } else {
      const existing = s.windows.get(id(req.windowId)); requireValue(existing && !existing.done && existing.generation === generation && existing.expiresAt > Date.now() && sameCursor(existing.after, after)
        && req.toCursor !== null && sameCursor(existing.to, cursor(req.toCursor)) && existing.through === through, 'PAGE_CURSOR', '变化窗口或分页游标不匹配。'); window = existing;
    }
    try {
      const page = await this.#readLease(s, window.budget, () => this.options.archive.readChanges(window.lease, window.pageCursor, signal)); this.#current(s, generation, signal);
      requireValue(sameCursor(after, page.afterCursor) && sameCursor(window.to, page.toCursor) && page.throughTime === through
        && compareDecimal(page.nextStateCursor.stateRevision, window.to.stateRevision) <= 0 && (!page.hasMore || page.nextCursor !== null), 'REVISION_GAP', '变化分页不是固定连续范围。');
      const result = { identity: s.identity, windowId: window.id, afterCursor: after, toCursor: window.to, nextCursor: page.nextStateCursor, throughTime: through,
        hasMore: page.hasMore, batches: page.batches, windowExpiresAt: window.expiresAt, continuity: 'complete' };
      const responseBytes = Buffer.byteLength(JSON.stringify(result));
      requireValue(responseBytes <= this.#maxPage, 'PAGE_BUDGET', '变化响应超过字节预算。');
      if (!page.hasMore) this.#finishLease(s, window.budget);
      this.#budget(s, responseBytes, true);
      s.cursors.add(`${page.nextStateCursor.projectionId}:${page.nextStateCursor.stateRevision}`); window.after = page.nextStateCursor;
      if (page.nextCursor) window.pageCursor = page.nextCursor;
      else window.done = true;
      return result;
    } catch (error) { await this.#closeWindow(s, window); throw error; }
  }
}
