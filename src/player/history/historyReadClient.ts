import type {
  HistoryReadApi, HistoryReadCapabilityRequest, HistoryReadCapabilityResponse, HistoryCoverageRequest, HistoryCoverageResponse,
  HistoryOpenRequest, HistoryOpenResponse, HistoryStateAtRequest, HistoryStateAtResponse,
  HistoryStateChunkRequest, HistoryStateChunkResponse, HistoryStateCancelRequest, HistoryStateCancelResponse,
  HistoryChangesRequest, HistoryChangesResponse, HistoryEventsRequest, HistoryEventsResponse, HistoryCloseRequest, HistoryCloseResponse,
} from './historyReadContract';

const PREFIX = '/api/v1/twin-history';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class HistoryAuthorizationError extends Error {
  constructor() { super('历史读取授权不足或已过期。'); this.name = 'HistoryAuthorizationError'; }
}

/** 仅向同源可信网关发送固定读取动作，使用网关的只读会话；不接受 URL、管理密钥或重定向。 */
export class SameOriginHistoryReadApi implements HistoryReadApi {
  #capability: { token: string; expiresAt: number } | null = null;
  async #post<T>(path: string, body: object, signal: AbortSignal, requiresCapability = true): Promise<T> {
    if (requiresCapability && (!this.#capability || this.#capability.expiresAt <= Date.now())) {
      this.#capability = null;
      throw new HistoryAuthorizationError();
    }
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' };
    if (requiresCapability) headers.Authorization = `Bearer ${this.#capability!.token}`;
    const response = await fetch(`${PREFIX}${path}`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) { this.#capability = null; throw new HistoryAuthorizationError(); }
      throw new Error(`历史服务请求失败（HTTP ${response.status}）。`);
    }
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new Error('历史响应超过客户端字节预算。');
    if (!response.body) throw new Error('历史服务未提供可限制大小的响应流。');
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
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('历史响应格式无效。');
    const envelope = parsed as { success?: unknown; data?: unknown };
    if (envelope.success !== true || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
      throw new Error('历史服务未返回有效的只读结果。');
    }
    // 会话边界进一步按各动作验证版本、游标、预算和数据内容。
    return envelope.data as T;
  }
  async capabilities(r: HistoryReadCapabilityRequest, s: AbortSignal): Promise<HistoryReadCapabilityResponse> {
    this.#capability = null;
    const result = await this.#post<HistoryReadCapabilityResponse>('/read/capabilities', r, s, false);
    if (result.projectId !== r.projectId || result.cacheRevision !== r.cacheRevision || result.readOnly !== true
      || result.scope !== 'history:read' || typeof result.capability !== 'string'
      || result.capability.length < 16 || result.capability.length > 4096 || !/^[\x21-\x7e]+$/u.test(result.capability)
      || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) throw new HistoryAuthorizationError();
    this.#capability = { token: result.capability, expiresAt: result.expiresAt };
    return result;
  }
  coverage(r: HistoryCoverageRequest, s: AbortSignal): Promise<HistoryCoverageResponse> { return this.#post('/coverage', r, s); }
  open(r: HistoryOpenRequest, s: AbortSignal): Promise<HistoryOpenResponse> { return this.#post('/sessions/open', r, s); }
  stateAt(r: HistoryStateAtRequest, s: AbortSignal): Promise<HistoryStateAtResponse> { return this.#post('/state/at', r, s); }
  stateChunk(r: HistoryStateChunkRequest, s: AbortSignal): Promise<HistoryStateChunkResponse> { return this.#post('/state/chunk', r, s); }
  cancel(r: HistoryStateCancelRequest, s: AbortSignal): Promise<HistoryStateCancelResponse> { return this.#post('/state/cancel', r, s); }
  changes(r: HistoryChangesRequest, s: AbortSignal): Promise<HistoryChangesResponse> { return this.#post('/changes/query', r, s); }
  events(r: HistoryEventsRequest, s: AbortSignal): Promise<HistoryEventsResponse> { return this.#post('/events/query', r, s); }
  close(r: HistoryCloseRequest, s: AbortSignal): Promise<HistoryCloseResponse> { return this.#post('/sessions/close', r, s); }
}
