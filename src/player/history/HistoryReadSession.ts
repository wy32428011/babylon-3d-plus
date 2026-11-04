import {
  canonicalStringify, compareDecimal, samplePose, TwinStateKernel,
  type DeepReadonly, type PoseSample, type StateAdapterRegistry, type StateCursor, type StateReadView, type VersionManifest,
} from '../../runtime/history/state';
import type { HistoryTimeRange, HistoryTimelineEvent } from '../../runtime/history/historyReplayContract';
import { HistoryAuthorizationError } from './historyReadClient';
import type {
  HistoryChangesResponse, HistoryCoverageResponse, HistoryOpenResponse, HistoryReadApi, HistoryReadIdentity,
  HistorySnapshotManifest, HistoryStateAtResponse,
} from './historyReadContract';

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_CHUNKS = 1024;
const MAX_PAGES = 1024;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/** prepare 不得改变当前可见画面或触发业务副作用；commit 必须同步、原子地切换全部实体。 */
export interface HistorySceneAdapter {
  /** 提交后 dispose 只释放未采用的暂存资源，不能释放已提交画面。 */
  prepare(view: StateReadView, pose: DeepReadonly<PoseSample>, generation: number, signal: AbortSignal): Promise<{
    commit(): void;
    dispose(): void;
  }>;
  /** 失去授权时同步清除历史画面，不得继续显示无权查看的数据。 */
  clear(): void;
}
export type HistorySessionStatus = 'idle' | 'loading' | 'paused' | 'seeking' | 'buffering' | 'returning-live' | 'live' | 'gap' | 'error';
export type HistorySessionSnapshot = {
  status: HistorySessionStatus; currentTime: number | null; pendingTime: number | null;
  cursor: StateCursor | null; error: string | null; coverage: HistoryCoverageResponse | null; readOnly: true;
};
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value); }
function time(value: unknown): value is number { return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 && value <= 8_640_000_000_000_000; }
function positive(value: unknown, max: number): value is number { return Number.isSafeInteger(value) && typeof value === 'number' && value > 0 && value <= max; }
function cursor(value: StateCursor | null | undefined): value is StateCursor {
  return Boolean(value && identifier(value.projectionId) && typeof value.stateRevision === 'string' && /^(0|[1-9]\d*)$/u.test(value.stateRevision) && value.stateRevision.length <= 128);
}
function sameCursor(a: StateCursor, b: StateCursor): boolean { return a.projectionId === b.projectionId && a.stateRevision === b.stateRevision; }
function sameIdentity(a: HistoryReadIdentity | undefined, b: HistoryReadIdentity): boolean {
  return Boolean(a && a.projectId === b.projectId && a.cacheRevision === b.cacheRevision && a.publishedVersionId === b.publishedVersionId
    && a.bindingRevision === b.bindingRevision && a.projectionId === b.projectionId);
}
function checkIdentity(identity: HistoryReadIdentity): void {
  requireValue(identity && [identity.projectId, identity.cacheRevision, identity.publishedVersionId, identity.bindingRevision, identity.projectionId].every(identifier), '缺少可信的发布包、绑定或投影身份。');
}
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function hashBytes(bytes: Uint8Array): Promise<string> {
  requireValue(globalThis.crypto?.subtle, '当前环境缺少快照 SHA-256 校验能力。');
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function decodeBase64(value: unknown, size: number): Uint8Array {
  requireValue(typeof value === 'string' && value.length <= Math.ceil(size / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value), '历史分块编码无效。');
  let decoded: string;
  try { decoded = atob(value); } catch { throw new Error('历史分块 base64 无效。'); }
  requireValue(decoded.length === size, '历史分块长度不匹配。');
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

/**
 * 只跟随服务器已提交事实，不运行 reducer、旧驱动、MQTT 或业务脚本。
 * 该控制器需要可信注册表、带授权的查询服务及真实原子渲染适配；缺少任何一项都不能上线。
 */
export class HistoryReadSession {
  readonly #api: HistoryReadApi;
  readonly #registry: StateAdapterRegistry;
  readonly #adapter: HistorySceneAdapter;
  readonly #identity: HistoryReadIdentity;
  readonly #versions: VersionManifest;
  readonly #abi: string;
  #generation = 0;
  #abort: AbortController | null = null;
  #liveAbort: AbortController | null = null;
  #session: HistoryOpenResponse | null = null;
  #kernel: TwinStateKernel | null = null;
  #snapshot: HistorySessionSnapshot = { status: 'idle', currentTime: null, pendingTime: null, cursor: null, error: null, coverage: null, readOnly: true };
  #listeners = new Set<() => void>();
  #disposed = false;

  constructor(options: { api: HistoryReadApi; registry: StateAdapterRegistry; adapter: HistorySceneAdapter; identity: HistoryReadIdentity; versions: VersionManifest; replayAbi: string }) {
    checkIdentity(options.identity); requireValue(identifier(options.replayAbi), '缺少已批准的回放 ABI。');
    requireValue(options.versions && options.versions.projectId === options.identity.projectId
      && options.versions.publishedVersionId === options.identity.publishedVersionId
      && options.versions.bindingRevision === options.identity.bindingRevision, '本地发布包缺少可信的版本清单。');
    this.#api = options.api; this.#registry = options.registry.snapshot(); this.#adapter = options.adapter;
    this.#identity = { ...options.identity }; this.#versions = { ...options.versions }; this.#abi = options.replayAbi;
  }
  getSnapshot = (): HistorySessionSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  #publish(patch: Partial<HistorySessionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch, readOnly: true };
    for (const listener of this.#listeners) listener();
  }
  #stopLiveFeed(): void { this.#liveAbort?.abort(); this.#liveAbort = null; }
  #start(status: HistorySessionStatus, pendingTime: number | null): { generation: number; signal: AbortSignal } {
    requireValue(!this.#disposed, '历史会话已关闭。');
    this.#abort?.abort(); this.#abort = new AbortController();
    const generation = ++this.#generation;
    this.#publish({ status, pendingTime, error: null });
    return { generation, signal: this.#abort.signal };
  }
  #current(generation: number, signal: AbortSignal): void {
    signal.throwIfAborted(); requireValue(!this.#disposed && generation === this.#generation, '历史请求代次已失效。');
  }
  #fail(error: unknown, generation: number, signal: AbortSignal): void {
    if (this.#disposed || signal.aborted || generation !== this.#generation) return;
    const message = error instanceof Error ? error.message : '历史读取失败。';
    if (error instanceof HistoryAuthorizationError) {
      this.#stopLiveFeed(); this.#adapter.clear(); this.#kernel = null; this.#session = null;
      this.#publish({ status: 'error', currentTime: null, cursor: null, coverage: null, pendingTime: null, error: message });
      return;
    }
    this.#publish({ status: message.includes('缺口') ? 'gap' : 'error', pendingTime: null, error: message });
  }
  async #open(mode: 'history' | 'live', range: HistoryTimeRange | null, signal: AbortSignal): Promise<HistoryOpenResponse> {
    const capability = await this.#api.capabilities({ projectId: this.#identity.projectId, cacheRevision: this.#identity.cacheRevision }, signal);
    if (!(capability?.readOnly === true && capability.scope === 'history:read' && capability.projectId === this.#identity.projectId
      && capability.cacheRevision === this.#identity.cacheRevision && identifier(capability.capability) && capability.capability.length >= 16
      && time(capability.expiresAt) && capability.expiresAt > Date.now())) throw new HistoryAuthorizationError();
    const session = await this.#api.open({ identity: this.#identity, mode, range }, signal);
    requireValue(session && identifier(session.sessionId) && session.mode === mode && session.readOnly === true
      && sameIdentity(session.identity, this.#identity) && session.replayAbi === this.#abi && time(session.expiresAt) && session.expiresAt > Date.now(), '发布包、有效版本、投影或兼容执行产物不匹配。');
    const v = session.versions, limits = session.limits;
    requireValue(v && canonicalStringify(v) === canonicalStringify(this.#versions)
      && v.projectId === this.#identity.projectId && v.publishedVersionId === this.#identity.publishedVersionId
      && v.bindingRevision === this.#identity.bindingRevision && limits && positive(limits.maxSnapshotBytes, MAX_SNAPSHOT_BYTES)
      && positive(limits.maxChunks, MAX_CHUNKS) && positive(limits.maxPageBytes, MAX_PAGE_BYTES) && positive(limits.maxPages, MAX_PAGES), '会话版本或预算无效。');
    return session;
  }
  async coverage(range: HistoryTimeRange, signal: AbortSignal): Promise<HistoryCoverageResponse> {
    requireValue(time(range.from) && time(range.to) && range.to > range.from, '历史范围无效。');
    const data = await this.#api.coverage({ identity: this.#identity, range }, signal);
    requireValue(sameIdentity(data?.identity, this.#identity) && data.range?.from === range.from && data.range?.to === range.to
      && time(data.queryableThrough) && Array.isArray(data.gaps) && data.gaps.length <= MAX_PAGES
      && data.gaps.every(gap => time(gap.from) && time(gap.to) && gap.to > gap.from && identifier(gap.reason))
      && Array.isArray(data.versionBoundaries) && data.versionBoundaries.length <= MAX_PAGES
      && data.versionBoundaries.every(boundary => time(boundary.time) && identifier(boundary.versionLabel))
      && identifier(data.sourceName) && identifier(data.sourceQuality), '历史覆盖响应无效。');
    // 后续 seek/播放只使用同一份经验证的覆盖证明，不允许界面或调用方改写缺口。
    for (const gap of data.gaps) Object.freeze(gap);
    for (const boundary of data.versionBoundaries) Object.freeze(boundary);
    Object.freeze(data.gaps); Object.freeze(data.versionBoundaries); Object.freeze(data.range); Object.freeze(data.identity);
    return Object.freeze(data);
  }
  async open(range: HistoryTimeRange, target: number): Promise<void> {
    this.#stopLiveFeed();
    const { generation, signal } = this.#start('loading', target);
    let opened: HistoryOpenResponse | null = null;
    try {
      requireValue(time(range.from) && time(range.to) && range.to > range.from && time(target) && target >= range.from && target <= range.to, '历史目标不在所选范围内。');
      const session = await this.#open('history', range, signal); opened = session; this.#current(generation, signal);
      const coverage = await this.coverage(range, signal); this.#current(generation, signal);
      // 首次目标落在缺口时保留可信覆盖和只读会话，让用户显式选择下一可用时刻。
      if (!this.#session) { this.#session = session; opened = null; this.#publish({ coverage }); this.#current(generation, signal); }
      this.#checkTarget(coverage, target);
      const candidate = await this.#restore(session, target, generation, signal);
      await this.#install(candidate.kernel, candidate.time, generation, signal, session.expiresAt);
      const old = this.#session; this.#session = session; opened = null;
      if (old && old.sessionId !== session.sessionId) void this.#api.close({ sessionId: old.sessionId }, new AbortController().signal).catch(() => {});
      this.#publish({ status: 'paused', pendingTime: null, coverage, error: null });
    } catch (error) { this.#fail(error, generation, signal); }
    finally { if (opened) void this.#api.close({ sessionId: opened.sessionId }, new AbortController().signal).catch(() => {}); }
  }
  #checkTarget(coverage: HistoryCoverageResponse, target: number): void {
    requireValue(target <= coverage.queryableThrough, '目标超过可查询水位。');
    requireValue(!coverage.gaps.some(gap => target >= gap.from && target < gap.to), '目标位于历史缺口，不能定位。');
    requireValue(!coverage.versionBoundaries.some(boundary => boundary.time > coverage.range.from && boundary.time <= target), '目标跨越发布版本边界，需选择相应兼容版本。');
  }
  async seek(target: number): Promise<void> {
    this.#stopLiveFeed();
    const { generation, signal } = this.#start('seeking', target);
    try {
      const session = this.#session, coverage = this.#snapshot.coverage;
      requireValue(session?.mode === 'history' && coverage && sameIdentity(coverage.identity, this.#identity)
        && target >= coverage.range.from && target <= coverage.range.to && time(target), '历史会话或目标范围无效。');
      this.#checkTarget(coverage, target);
      const candidate = await this.#restore(session, target, generation, signal);
      await this.#install(candidate.kernel, candidate.time, generation, signal, session.expiresAt);
      this.#publish({ status: 'paused', pendingTime: null, error: null });
    } catch (error) { this.#fail(error, generation, signal); }
  }
  /** 倍速只影响调用者发起的目标；只有服务端证明的连续窗口能推进事实时间。 */
  async advanceTo(target: number): Promise<void> {
    this.#stopLiveFeed();
    const { generation, signal } = this.#start('buffering', target);
    try {
      const session = this.#session, current = this.#kernel, currentTime = this.#snapshot.currentTime;
      requireValue(session && current && currentTime !== null && time(target) && target >= currentTime, '不能从当前状态向后推进。');
      if (session.mode === 'history') {
        const coverage = this.#snapshot.coverage;
        requireValue(coverage && target <= coverage.range.to && target <= coverage.queryableThrough, '目标超过历史范围或查询水位。');
        requireValue(!coverage.gaps.some(gap => gap.from <= target && gap.to > currentTime), '播放遇到数据缺口，不能自动跨越。');
        requireValue(!coverage.versionBoundaries.some(boundary => boundary.time > currentTime && boundary.time <= target), '播放遇到版本边界，不能自动跨越。');
      }
      const candidate = TwinStateKernel.fromCheckpoint(current.checkpoint(), this.#registry, { mode: 'canonical-follower', expectedVersions: session.versions });
      await this.#consume(session, candidate, target, null, generation, signal);
      await this.#install(candidate, target, generation, signal, session.expiresAt);
      this.#publish({ status: session.mode === 'live' ? 'live' : 'paused', pendingTime: null, error: null });
    } catch (error) { this.#fail(error, generation, signal); }
  }
  /** 只能返回与当前包完全匹配的有效版本；新的投影/资源须由兼容宿主先切换。 */
  async returnLive(activeIdentity: HistoryReadIdentity): Promise<void> {
    this.#stopLiveFeed();
    const { generation, signal } = this.#start('returning-live', null);
    let opened: HistoryOpenResponse | null = null;
    try {
      requireValue(sameIdentity(activeIdentity, this.#identity), '当前有效版本与本包或投影不匹配，不能沿用历史场景返回实时。');
      const session = await this.#open('live', null, signal); opened = session; this.#current(generation, signal);
      const candidate = await this.#restore(session, null, generation, signal);
      requireValue(candidate.resume && candidate.resume.leaseExpiresAt > Date.now(), '实时续传租约不可用或已过期。');
      await this.#consume(session, candidate.kernel, candidate.resume.throughTime, candidate.resume.toCursor, generation, signal);
      requireValue(candidate.resume.leaseExpiresAt > Date.now(), '实时续传租约已过期，必须重新取得全态。');
      await this.#install(candidate.kernel, candidate.resume.throughTime, generation, signal, Math.min(session.expiresAt, candidate.resume.leaseExpiresAt));
      const old = this.#session; this.#session = session; opened = null;
      if (old && old.sessionId !== session.sessionId) void this.#api.close({ sessionId: old.sessionId }, new AbortController().signal).catch(() => {});
      this.#publish({ status: 'live', pendingTime: null, error: null });
      this.#startLiveFeed();
    } catch (error) { this.#fail(error, generation, signal); }
    finally { if (opened) void this.#api.close({ sessionId: opened.sessionId }, new AbortController().signal).catch(() => {}); }
  }
  /** 只消费服务端声明的水位；等待只是网络节流，不产生历史事实。 */
  #startLiveFeed(): void {
    this.#stopLiveFeed();
    const controller = new AbortController(); this.#liveAbort = controller;
    const run = async () => {
      while (!controller.signal.aborted && !this.#disposed) {
        try { await abortableDelay(500, controller.signal); } catch { return; }
        if (controller.signal.aborted) return;
        const { generation, signal } = this.#start('buffering', null);
        try {
          const session = this.#session, current = this.#kernel, shownAt = this.#snapshot.currentTime;
          requireValue(session?.mode === 'live' && current && shownAt !== null, '实时 canonical 会话不可用。');
          const candidate = TwinStateKernel.fromCheckpoint(current.checkpoint(), this.#registry, { mode: 'canonical-follower', expectedVersions: session.versions });
          const through = await this.#consume(session, candidate, null, null, generation, signal, shownAt);
          this.#current(generation, signal); controller.signal.throwIfAborted();
          requireValue(session.expiresAt > Date.now(), '实时会话已过期，不能继续显示为实时。');
          if (through !== shownAt || !sameCursor(candidate.metadata.cursor, current.metadata.cursor)) {
            await this.#install(candidate, through, generation, signal, session.expiresAt);
          }
          this.#publish({ status: 'live', pendingTime: null, error: null });
        } catch (error) {
          if (!controller.signal.aborted) this.#fail(error, generation, signal);
          this.#stopLiveFeed(); return;
        }
      }
    };
    void run();
  }
  async #restore(session: HistoryOpenResponse, target: number | null, generation: number, signal: AbortSignal): Promise<{ kernel: TwinStateKernel; time: number; resume: HistorySnapshotManifest['resume'] }> {
    requireValue(session.expiresAt > Date.now(), '历史会话已过期。');
    const requestId = crypto.randomUUID();
    let response: HistoryStateAtResponse;
    try {
      for (let attempt = 0; ; attempt += 1) {
        this.#current(generation, signal);
        response = await this.#api.stateAt({ sessionId: session.sessionId, generation, requestId, asOf: target }, signal);
        if (response.status !== 'pending') break;
        requireValue(attempt < 120 && positive(response.retryAfterMs, 2000), '历史恢复等待超过预算。');
        await abortableDelay(response.retryAfterMs, signal);
      }
    } finally {
      if (signal.aborted) void this.#api.cancel({ sessionId: session.sessionId, requestId }, new AbortController().signal).catch(() => {});
    }
    requireValue(response.status === 'ready', response.status === 'gap' ? '目标位于历史缺口。' : '目标时刻不可恢复。');
    const snapshot = response.snapshot;
    requireValue(snapshot && identifier(snapshot.snapshotId) && sameIdentity(snapshot.identity, this.#identity)
      && cursor(snapshot.cursor) && cursor(snapshot.throughCursor) && snapshot.cursor.projectionId === this.#identity.projectionId
      && snapshot.throughCursor.projectionId === this.#identity.projectionId && compareDecimal(snapshot.throughCursor.stateRevision, snapshot.cursor.stateRevision) >= 0
      && snapshot.requestedTime === target && time(snapshot.checkpointTime) && time(snapshot.resolvedTime) && time(snapshot.coveredThrough)
      && snapshot.checkpointTime <= snapshot.resolvedTime && snapshot.resolvedTime <= snapshot.coveredThrough
      && (target === null || snapshot.coveredThrough === target)
      && time(snapshot.expiresAt) && snapshot.expiresAt > Date.now() && positive(snapshot.byteLength, session.limits.maxSnapshotBytes)
      && Array.isArray(snapshot.chunks) && snapshot.chunks.length > 0 && snapshot.chunks.length <= session.limits.maxChunks,
    '快照身份、游标、时刻或租约无效。');
    const content = new Uint8Array(snapshot.byteLength); let offset = 0;
    for (let index = 0; index < snapshot.chunks.length; index += 1) {
      this.#current(generation, signal); requireValue(snapshot.expiresAt > Date.now(), '快照租约已过期。');
      const part = snapshot.chunks[index];
      requireValue(part && part.index === index && positive(part.byteLength, session.limits.maxPageBytes)
        && offset + part.byteLength <= content.length && /^[0-9a-f]{64}$/u.test(part.sha256), '快照分块清单无效。');
      const result = await this.#api.stateChunk({ sessionId: session.sessionId, generation, snapshotId: snapshot.snapshotId, index }, signal);
      this.#current(generation, signal);
      requireValue(result.snapshotId === snapshot.snapshotId && result.index === index && result.encoding === 'base64'
        && cursor(result.cursor) && sameCursor(result.cursor, snapshot.cursor)
        && new TextEncoder().encode(JSON.stringify(result)).byteLength <= session.limits.maxPageBytes, '分块不属于同一不可变快照或超过分页预算。');
      const bytes = decodeBase64(result.data, part.byteLength);
      requireValue(await hashBytes(bytes) === part.sha256, '快照分块校验失败。');
      this.#current(generation, signal); content.set(bytes, offset); offset += bytes.length;
    }
    requireValue(offset === content.length && snapshot.expiresAt > Date.now(), '快照分块不完整或已过期。');
    const checkpoint: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
    const kernel = TwinStateKernel.fromCheckpoint(checkpoint, this.#registry, { mode: 'canonical-follower', expectedVersions: session.versions });
    requireValue(kernel.metadata.logicalTime === snapshot.checkpointTime && sameCursor(kernel.metadata.cursor, snapshot.cursor)
      && kernel.metadata.continuity.status === 'complete', '检查点实际时间、游标或完整性不匹配。');
    await this.#consume(session, kernel, snapshot.coveredThrough, snapshot.throughCursor, generation, signal);
    requireValue(kernel.metadata.logicalTime === snapshot.resolvedTime, '最后业务修订的实际时间不匹配，不能冒充目标时刻。');
    if (session.mode === 'live') requireValue(snapshot.resume && cursor(snapshot.resume.toCursor)
      && snapshot.resume.toCursor.projectionId === this.#identity.projectionId && time(snapshot.resume.throughTime)
      && snapshot.resume.throughTime >= snapshot.coveredThrough && time(snapshot.resume.leaseExpiresAt), '实时续传握手缺失。');
    return { kernel, time: snapshot.coveredThrough, resume: snapshot.resume };
  }
  async #consume(session: HistoryOpenResponse, kernel: TwinStateKernel, throughTime: number | null, fixedCursor: StateCursor | null, generation: number, signal: AbortSignal, minimumTime = kernel.metadata.logicalTime): Promise<number> {
    let windowId: string | null = null, windowExpiresAt: number | null = null, toCursor = fixedCursor, afterCursor: StateCursor = { ...kernel.metadata.cursor };
    let fixedTime = throughTime;
    for (let page = 0; page < session.limits.maxPages; page += 1) {
      this.#current(generation, signal); requireValue(session.expiresAt > Date.now(), '历史会话已过期。');
      const result: HistoryChangesResponse = await this.#api.changes({ sessionId: session.sessionId, generation, afterCursor, windowId, toCursor, throughTime: fixedTime }, signal);
      this.#current(generation, signal);
      requireValue(result && sameIdentity(result.identity, this.#identity) && identifier(result.windowId)
        && (windowId === null || result.windowId === windowId) && cursor(result.afterCursor) && sameCursor(result.afterCursor, afterCursor)
        && cursor(result.toCursor) && result.toCursor.projectionId === this.#identity.projectionId
        && (!toCursor || sameCursor(result.toCursor, toCursor)) && cursor(result.nextCursor)
        && result.nextCursor.projectionId === this.#identity.projectionId && time(result.throughTime) && result.throughTime >= minimumTime
        && (fixedTime === null || result.throughTime === fixedTime)
        && time(result.windowExpiresAt) && result.windowExpiresAt > Date.now() && (windowExpiresAt === null || result.windowExpiresAt === windowExpiresAt)
        && typeof result.hasMore === 'boolean' && Array.isArray(result.batches)
        && new TextEncoder().encode(JSON.stringify(result)).byteLength <= session.limits.maxPageBytes, '历史变化窗口或分页边界无效。');
      requireValue(result.continuity === 'complete', result.continuity === 'gap' ? '历史变化遇到数据缺口。' : '历史变化跨版本、游标失效或连续性未知。');
      windowId = result.windowId; windowExpiresAt = result.windowExpiresAt; toCursor = result.toCursor; fixedTime = result.throughTime;
      for (const batch of result.batches) {
        requireValue(batch.throughTime <= fixedTime, '变化批次超出目标时刻。');
        kernel.applyChangeBatch(batch);
        requireValue(kernel.metadata.continuity.status === 'complete', '历史变化遇到数据缺口。');
      }
      requireValue(sameCursor(kernel.metadata.cursor, result.nextCursor)
        && compareDecimal(result.nextCursor.stateRevision, toCursor.stateRevision) <= 0, '变化分页不是连续游标。');
      if (!result.hasMore) { requireValue(sameCursor(result.nextCursor, toCursor), '历史变化窗口缺少尾页。'); return fixedTime; }
      requireValue(!sameCursor(result.nextCursor, afterCursor) && !sameCursor(result.nextCursor, toCursor), '历史变化分页没有推进或尾页标记无效。');
      afterCursor = result.nextCursor;
    }
    throw new Error('历史变化分页超过预算。');
  }
  async #install(kernel: TwinStateKernel, factTime: number, generation: number, signal: AbortSignal, validUntil = Number.MAX_SAFE_INTEGER): Promise<void> {
    this.#current(generation, signal);
    const pose = samplePose(kernel.view, factTime);
    const prepared = await this.#adapter.prepare(kernel.view, pose, generation, signal);
    try {
      this.#current(generation, signal);
      requireValue(validUntil > Date.now(), '会话或续传租约已过期，不能提交暂存画面。');
      prepared.commit();
      this.#kernel = kernel;
      this.#publish({ currentTime: factTime, cursor: { ...kernel.metadata.cursor } });
    } finally { prepared.dispose(); }
  }
  /** 暂停只中止未提交请求，不更改最后成功呈现的事实。 */
  pause(): void {
    if (this.#disposed) return;
    this.#stopLiveFeed(); this.#generation += 1; this.#abort?.abort(); this.#abort = null;
    if (this.#snapshot.currentTime !== null) this.#publish({ status: 'paused', pendingTime: null, error: null });
  }
  /** 事件索引不可用时抛错，不把缺失索引伪装成没有事件。 */
  async loadEvents(range: HistoryTimeRange, signal: AbortSignal): Promise<HistoryTimelineEvent[]> {
    const session = this.#session;
    requireValue(session?.mode === 'history' && this.#snapshot.coverage?.range.from === range.from
      && this.#snapshot.coverage.range.to === range.to, '历史事件会话或范围不匹配。');
    const events: HistoryTimelineEvent[] = [], seen = new Set<string>();
    const checkSession = () => {
      signal.throwIfAborted();
      requireValue(!this.#disposed && this.#session === session && this.#snapshot.coverage?.range.from === range.from
        && this.#snapshot.coverage.range.to === range.to, '历史事件会话已失效。');
    };
    let eventCursor: string | null = null, queryId: string | null = null, expiresAt: number | null = null;
    try {
      for (let page = 0; page < session.limits.maxPages; page += 1) {
        checkSession();
        const result = await this.#api.events({ sessionId: session.sessionId, range, queryId, cursor: eventCursor, limit: 256 }, signal);
        checkSession();
        requireValue(result && sameIdentity(result.identity, this.#identity) && result.range?.from === range.from && result.range.to === range.to
          && identifier(result.queryId) && (queryId === null || result.queryId === queryId) && result.cursor === eventCursor
          && time(result.expiresAt) && result.expiresAt > Date.now() && (expiresAt === null || result.expiresAt === expiresAt)
          && Array.isArray(result.items) && result.items.length <= 256 && typeof result.hasMore === 'boolean'
          && (result.nextCursor === null || identifier(result.nextCursor)), '历史事件分页无效。');
        queryId = result.queryId; expiresAt = result.expiresAt;
        for (const event of result.items) {
          requireValue(identifier(event.id) && !seen.has(event.id) && time(event.time) && event.time >= range.from && event.time <= range.to
            && ['alarm', 'transfer', 'stock', 'lifecycle', 'other'].includes(event.kind) && identifier(event.label), '历史事件内容无效。');
          seen.add(event.id); events.push(event);
        }
        requireValue(events.length <= 20_000, '历史事件概览超过预算。');
        if (!result.hasMore) { requireValue(result.nextCursor === null, '历史事件尾页游标无效。'); return events; }
        requireValue(result.nextCursor !== null && result.nextCursor !== eventCursor && result.items.length > 0, '历史事件分页没有推进。');
        eventCursor = result.nextCursor;
      }
      throw new Error('历史事件分页超过预算。');
    } catch (error) {
      if (error instanceof HistoryAuthorizationError && !this.#disposed && this.#session === session) {
        this.#generation += 1; this.#abort?.abort(); this.#adapter.clear(); this.#kernel = null; this.#session = null;
        this.#publish({ status: 'error', currentTime: null, cursor: null, coverage: null, pendingTime: null, error: error.message });
      }
      throw error;
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#stopLiveFeed(); this.#generation += 1; this.#abort?.abort();
    const session = this.#session; this.#session = null; this.#kernel = null; this.#listeners.clear();
    if (session) void this.#api.close({ sessionId: session.sessionId }, new AbortController().signal).catch(() => {});
  }
}
