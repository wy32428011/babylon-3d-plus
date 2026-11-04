import type {
  HistoryReadApi, HistoryReadCapabilityRequest, HistoryReadCapabilityResponse, HistoryCoverageRequest, HistoryCoverageResponse,
  HistoryOpenRequest, HistoryOpenResponse, HistoryStateAtRequest, HistoryStateAtResponse,
  HistoryStateChunkRequest, HistoryStateChunkResponse, HistoryStateCancelRequest, HistoryStateCancelResponse,
  HistoryChangesRequest, HistoryChangesResponse, HistoryEventsRequest, HistoryEventsResponse, HistoryCloseRequest, HistoryCloseResponse,
} from './historyReadContract';

const PREFIX = '/api/v1/twin-history';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CAPABILITY_RENEW_MARGIN_MS = 5_000;

type ReadCapability = { token: string; expiresAt: number; projectId: string; cacheRevision: string };

export class HistoryAuthorizationError extends Error {
  constructor() { super('历史读取授权不足或已过期。'); this.name = 'HistoryAuthorizationError'; }
}

const SERVICE_MESSAGES: Readonly<Record<string, string>> = {
  CONTINUITY_GAP: '历史变化遇到数据缺口，不能继续播放。',
  INPUT_GAP: '历史输入存在数据缺口，不能继续播放。',
  RECOVERY_GAP: '历史恢复存在数据缺口，不能提交画面。',
  REVISION_GAP: '历史修订存在数据缺口，不能提交画面。',
  EVENT_INDEX_UNAVAILABLE: '关键事件索引尚未接入。',
  EVENT_FACTS_MISSING: '所选时间段缺少完整事件事实，不能把空结果当作无事件。',
  EVENT_INDEX_INVALID: '关键事件索引与当前回放不一致，请重新打开。',
  EVENT_BUDGET: '关键事件超过索引处理预算，不能截断后显示。',
  BASELINE_OUTSIDE_SCOPE: '恢复检查点超出只读授权范围，无法加载完整状态。',
  TIME_NOT_QUERYABLE: '所选时间段尚未完成索引或不在可查询范围。',
  HISTORY_READ_AUTHORIZATION_NOT_CONNECTED: '历史只读授权尚未接入。',
  HISTORY_READ_WORKER_NOT_CONNECTED: '历史读取 worker 尚未接入。',
  HISTORY_LIVE_VERSION_MISMATCH: '当前线上发布与有效投影不匹配，不能返回实时。',
  HISTORY_SESSION_EXPIRED: '历史读取会话已过期，需要重新打开所选范围。',
  SESSION_EXPIRED: '历史读取会话已过期，需要重新打开所选范围。',
  SNAPSHOT_EXPIRED: '历史快照租约已过期，需要重新读取。',
  CURSOR_EXPIRED: '历史游标已过期，需要重新读取完整状态。',
  QUERY_BUDGET: '历史读取会话预算已耗尽，需要重新打开所选范围。',
};
const AUTHORIZATION_CODES = new Set([
  'ACCESS_DENIED', 'CAPABILITY_EXPIRED', 'HISTORY_READ_ACCESS_DENIED', 'HISTORY_READ_CAPABILITY_EXPIRED',
  'HISTORY_READ_CAPABILITY_INVALID', 'HISTORY_ACCESS_REVOKED',
]);

/** 仅暴露有界错误码和本地文案，不直接呈现来自网关的任意错误内容。 */
export class HistoryReadServiceError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super((code && SERVICE_MESSAGES[code]) || `历史服务请求失败（HTTP ${status}${code ? `，${code}` : ''}）。`);
    this.name = 'HistoryReadServiceError';
  }
}

/** 仅向同源可信网关发送固定读取动作，使用网关的只读会话；不接受 URL、管理密钥或重定向。 */
export class SameOriginHistoryReadApi implements HistoryReadApi {
  #capability: ReadCapability | null = null;
  #exchangeGeneration = 0;
  readonly #signalCapabilities = new WeakMap<AbortSignal, ReadCapability>();
  readonly #sessionCapabilities = new Map<string, ReadCapability>();

  #currentCapability(): ReadCapability {
    const capability = this.#capability;
    if (!capability || capability.expiresAt <= Date.now()) throw new HistoryAuthorizationError();
    return capability;
  }
  #forSignal(signal: AbortSignal): ReadCapability {
    const capability = this.#signalCapabilities.get(signal) ?? this.#currentCapability();
    if (capability.expiresAt <= Date.now()) throw new HistoryAuthorizationError();
    return capability;
  }
  #forSession(sessionId: string): ReadCapability {
    const capability = this.#sessionCapabilities.get(sessionId);
    if (!capability || capability.expiresAt <= Date.now()) throw new HistoryAuthorizationError();
    return capability;
  }
  #rejectCapability(capability: ReadCapability | null): never {
    if (this.#capability === capability) this.#capability = null;
    throw new HistoryAuthorizationError();
  }
  async #post<T>(path: string, body: object, signal: AbortSignal, capability: ReadCapability | null): Promise<T> {
    if (capability && capability.expiresAt <= Date.now()) this.#rejectCapability(capability);
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' };
    if (capability) headers.Authorization = `Bearer ${capability.token}`;
    const response = await fetch(`${PREFIX}${path}`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
      headers,
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) this.#rejectCapability(capability);
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new Error('历史响应超过客户端字节预算。');
    if (!response.body) {
      if (!response.ok) throw new HistoryReadServiceError(response.status, null);
      throw new Error('历史服务未提供可限制大小的响应流。');
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('历史响应超过客户端字节预算。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch {
      if (!response.ok) throw new HistoryReadServiceError(response.status, null);
      throw new Error('历史响应格式无效。');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (!response.ok) throw new HistoryReadServiceError(response.status, null);
      throw new Error('历史响应格式无效。');
    }
    const envelope = parsed as { success?: unknown; code?: unknown; data?: unknown };
    if (!response.ok || envelope.success !== true) {
      const code = typeof envelope.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(envelope.code) ? envelope.code : null;
      if (code && AUTHORIZATION_CODES.has(code)) this.#rejectCapability(capability);
      throw new HistoryReadServiceError(response.status, code);
    }
    if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) throw new Error('历史服务未返回有效的只读结果。');
    // 会话边界进一步按各动作验证版本、游标、预算和数据内容。
    return envelope.data as T;
  }
  async capabilities(r: HistoryReadCapabilityRequest, s: AbortSignal): Promise<HistoryReadCapabilityResponse> {
    s.throwIfAborted();
    const cached = this.#capability;
    if (cached && cached.projectId === r.projectId && cached.cacheRevision === r.cacheRevision
      && cached.expiresAt > Date.now() + CAPABILITY_RENEW_MARGIN_MS) {
      this.#signalCapabilities.set(s, cached);
      return { projectId: cached.projectId, cacheRevision: cached.cacheRevision, readOnly: true, scope: 'history:read',
        capability: cached.token, expiresAt: cached.expiresAt };
    }
    const generation = ++this.#exchangeGeneration;
    const result = await this.#post<HistoryReadCapabilityResponse>('/read/capabilities', r, s, null);
    s.throwIfAborted();
    if (generation !== this.#exchangeGeneration) throw new DOMException('历史授权交换已被新请求取代。', 'AbortError');
    if (result.projectId !== r.projectId || result.cacheRevision !== r.cacheRevision || result.readOnly !== true
      || result.scope !== 'history:read' || typeof result.capability !== 'string'
      || result.capability.length < 16 || result.capability.length > 4096 || !/^[\x21-\x7e]+$/u.test(result.capability)
      || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) throw new HistoryAuthorizationError();
    this.#capability = { token: result.capability, expiresAt: result.expiresAt, projectId: r.projectId, cacheRevision: r.cacheRevision };
    // 同一代次的 open/coverage 固定使用本次交换结果，后来的交换不能替换在途请求的 grant。
    this.#signalCapabilities.set(s, this.#capability);
    return result;
  }
  coverage(r: HistoryCoverageRequest, s: AbortSignal): Promise<HistoryCoverageResponse> {
    const capability = this.#forSignal(s);
    if (capability.projectId !== r.identity.projectId || capability.cacheRevision !== r.identity.cacheRevision) throw new HistoryAuthorizationError();
    return this.#post('/coverage', r, s, capability);
  }
  async open(r: HistoryOpenRequest, s: AbortSignal): Promise<HistoryOpenResponse> {
    const capability = this.#forSignal(s);
    if (capability.projectId !== r.identity.projectId || capability.cacheRevision !== r.identity.cacheRevision) throw new HistoryAuthorizationError();
    const result = await this.#post<HistoryOpenResponse>('/sessions/open', r, s, capability);
    if (typeof result.sessionId === 'string' && result.sessionId.length > 0 && result.sessionId.length <= 2048) {
      // 网关按 grantId 绑定会话；后续交换的新能力不能用于旧会话或旧会话的 close/cancel。
      this.#sessionCapabilities.set(result.sessionId, capability);
    }
    return result;
  }
  stateAt(r: HistoryStateAtRequest, s: AbortSignal): Promise<HistoryStateAtResponse> { return this.#post('/state/at', r, s, this.#forSession(r.sessionId)); }
  stateChunk(r: HistoryStateChunkRequest, s: AbortSignal): Promise<HistoryStateChunkResponse> { return this.#post('/state/chunk', r, s, this.#forSession(r.sessionId)); }
  cancel(r: HistoryStateCancelRequest, s: AbortSignal): Promise<HistoryStateCancelResponse> { return this.#post('/state/cancel', r, s, this.#forSession(r.sessionId)); }
  changes(r: HistoryChangesRequest, s: AbortSignal): Promise<HistoryChangesResponse> { return this.#post('/changes/query', r, s, this.#forSession(r.sessionId)); }
  events(r: HistoryEventsRequest, s: AbortSignal): Promise<HistoryEventsResponse> { return this.#post('/events/query', r, s, this.#forSession(r.sessionId)); }
  async close(r: HistoryCloseRequest, s: AbortSignal): Promise<HistoryCloseResponse> {
    try { return await this.#post('/sessions/close', r, s, this.#forSession(r.sessionId)); }
    finally { this.#sessionCapabilities.delete(r.sessionId); }
  }
}
