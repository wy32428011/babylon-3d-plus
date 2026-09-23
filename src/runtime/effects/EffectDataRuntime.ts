import type { EffectDataBinding, EffectDeviceIdentity } from '../../editor/model/effectConfiguration';
import { deviceTelemetryStore, parseDeviceTelemetryMessage, type DeviceTelemetryStore } from '../mqtt/deviceTelemetry';
import { effectDataEndpoint, validateEffectDataRequest, type EffectDataRequest } from '../../../electron/shared/effectDataContract';

export type EffectDataResult = {
  status: 'static' | 'waiting' | 'online' | 'stale' | 'missing' | 'invalid' | 'error';
  fields: Record<string, unknown>;
  data?: unknown;
  receivedAt: number | null;
  message: string;
  key: string;
};
export type EffectDataTransport = (request: EffectDataRequest, signal: AbortSignal) => Promise<unknown>;
export type EffectDataTransportContext = { apiBaseUrl?: string | null; transport?: EffectDataTransport };
type Entry = { key: string; request: EffectDataRequest; result: EffectDataResult; sourceTimestamp: number | null;
  nextAt: number; settledAt: number | null; lastUsed: number; pollMs: number; policyObserved: boolean; queued: boolean; controller: AbortController | null };
type Options = { telemetryStore?: Pick<DeviceTelemetryStore, 'getSnapshot'>; transport?: EffectDataTransport;
  clock?: () => number; maxEntries?: number; maxConcurrent?: number };
let transportContext: EffectDataTransportContext = {};
let transportRevision = 0;
let requestSequence = 0;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** 仅由受信任的应用运行配置设置，不能从特效场景配置读取地址。 */
export function configureEffectDataTransport(context: EffectDataTransportContext | null): void {
  if (context?.apiBaseUrl) safeBaseUrl(context.apiBaseUrl);
  transportContext = context ?? {};
  transportRevision++;
}

function safeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('特效服务地址必须是无凭据和查询参数的 HTTP(S) 地址。');
  return url;
}

function empty(status: EffectDataResult['status'], key: string, message: string): EffectDataResult {
  return { status, fields: {}, receivedAt: null, message, key };
}
function bounded(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function identityText(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== 'string' || value.length > MAX_RESPONSE_BYTES) throw new Error(`${label}不是有效的有界 JSON 文本。`);
  try { return JSON.parse(value); } catch { throw new Error(`${label}不是有效 JSON。`); }
}

async function browserTransport(request: EffectDataRequest, signal: AbortSignal): Promise<unknown> {
  if (typeof window !== 'undefined' && window.editorApi?.fetchEffectData) {
    const cancel = () => { void window.editorApi.cancelEffectData?.(request.requestId).catch(() => undefined); };
    signal.throwIfAborted(); signal.addEventListener('abort', cancel, { once: true });
    try { return await window.editorApi.fetchEffectData(request); }
    finally { signal.removeEventListener('abort', cancel); }
  }
  const { path, body } = effectDataEndpoint(request);
  const base = transportContext.apiBaseUrl || (typeof location !== 'undefined' ? location.origin : '');
  if (!base) throw new Error('尚未配置特效数据服务地址。');
  const url = new URL(path, `${safeBaseUrl(base).toString().replace(/\/+$/, '')}/`);
  const response = await fetch(url, { method: 'POST', redirect: 'error', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.body) throw new Error('特效数据服务返回空响应。');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let content = '';
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('特效数据响应超过 2 MB。'); content += decoder.decode(chunk.value, { stream: true }); }
    content += decoder.decode();
  } catch (error) { await reader.cancel(); throw error; } finally { reader.releaseLock(); }
  const envelope = parseJson(content, '特效数据响应');
  if (!response.ok) {
    const code = object(envelope)?.code;
    if (typeof code !== 'string' || !/^(?:DATA_FLOW_MQTT_DATA_|DATA_SOURCE_)[A-Z_]+$/.test(code)) throw new Error(`特效数据服务返回 HTTP ${response.status}。`);
    return { success: false, code };
  }
  return envelope;
}

/** HTTP 请求按设备身份共享，轮询只由活跃 read 推动，销毁或失去引用时取消。 */
export class EffectDataRuntime {
  private readonly options: Options;
  private readonly entries = new Map<string, Entry>();
  private readonly touched = new Set<string>();
  private readonly queue: Entry[] = [];
  private running = 0;
  private disposed = false;
  constructor(options: Options = {}) { this.options = options; }

  read(binding: EffectDataBinding, identity: EffectDeviceIdentity | null, active: boolean, now = this.now()): EffectDataResult {
    if (binding.mode === 'none') return empty('static', '', '静态配置');
    if (this.disposed) return empty('waiting', '', '特效数据运行时已停止。');
    const resolved = binding.mode === 'inherit' ? identity : { sourceId: binding.sourceId, deviceType: binding.deviceType, assetCode: binding.assetCode };
    if (binding.mode === 'http') return this.readHttp(binding, identity, active, now);
    if (binding.mode !== 'mqtt' && binding.mode !== 'inherit') return empty('invalid', '', '不支持的数据源类型。');
    const sourceId = identityText(resolved?.sourceId), deviceType = identityText(resolved?.deviceType).toLowerCase(), assetCode = identityText(resolved?.assetCode);
    const key = JSON.stringify(['mqtt', sourceId, deviceType, assetCode]);
    if (!sourceId || !deviceType || !assetCode) return empty('invalid', key, '请完整配置数据源、设备类型和资产编号，或绑定可继承数据身份的模型。');
    const snapshot = (this.options.telemetryStore ?? deviceTelemetryStore).getSnapshot(assetCode, deviceType, sourceId);
    if (!snapshot) return empty('waiting', key, '等待对应设备的 MQTT 数据。');
    // Store 的旧键以冒号拼接，再核对三段身份，避免包含冒号的标识发生碰撞。
    if (snapshot.sourceId !== sourceId || snapshot.deviceType.toLowerCase() !== deviceType || snapshot.assetCode !== assetCode) return empty('invalid', key, '设备快照身份不匹配。');
    const stale = this.isStale(binding, now, snapshot.receivedAt, snapshot.sourceTimestamp);
    return { status: stale ? 'stale' : 'online', fields: snapshot.fields, data: snapshot.fields,
      receivedAt: snapshot.receivedAt, message: stale ? '设备数据已过期。' : '已收到设备数据。', key };
  }

  /** 一轮活跃读取结束时调用；下一轮重新聚合策略，使移除快读者后可恢复较慢轮询。 */
  releaseUnused(keys?: Iterable<string>): void {
    const keep = keys ? new Set(keys) : this.touched;
    for (const [key, entry] of this.entries) {
      if (!keep.has(key)) { this.entries.delete(key); entry.controller?.abort(); entry.queued = false; }
      else entry.policyObserved = false;
    }
    for (let i = this.queue.length - 1; i >= 0; i--) if (!this.entries.has(this.queue[i].key)) this.queue.splice(i, 1);
    this.touched.clear();
  }

  dispose(): void { this.disposed = true; this.releaseUnused([]); this.queue.length = 0; }

  private now(): number { return (this.options.clock ?? Date.now)(); }
  private isStale(binding: EffectDataBinding, now: number, receivedAt: number, sourceTimestamp: number | null): boolean {
    const ttl = bounded(binding.staleAfterMs, Math.max(1000, binding.expectedIntervalMs * 3), 100, 86400000);
    return !Number.isFinite(receivedAt) || now - receivedAt > ttl || (sourceTimestamp !== null && Number.isFinite(sourceTimestamp) && now - sourceTimestamp > ttl);
  }

  private readHttp(binding: EffectDataBinding, identity: EffectDeviceIdentity | null, active: boolean, now: number): EffectDataResult {
    let request: EffectDataRequest;
    try {
      request = validateEffectDataRequest({ requestId: 'validate', mode: binding.http.mode,
        assetCode: identityText(binding.assetCode) || identity?.assetCode || '',
        ...(binding.http.mode === 'data-source' ? { dataSourceId: binding.http.dataSourceId } : { namespace: binding.http.namespace, deviceType: identityText(binding.deviceType) || identity?.deviceType || '' }),
        timeoutMs: Math.round(bounded(binding.http.timeoutMs, 10000, 100, 30000)) });
    } catch (error) { return empty('invalid', '', error instanceof Error ? error.message : 'HTTP 配置无效。'); }
    const key = JSON.stringify(['http', transportRevision, request.mode, request.dataSourceId ?? '', request.namespace ?? '', request.deviceType ?? '', request.assetCode]);
    let entry = this.entries.get(key);
    if (!entry && !active) return empty('waiting', key, '进入运行预览后读取数据。');
    if (!entry) {
      const limit = Math.floor(bounded(this.options.maxEntries ?? 128, 128, 1, 512));
      if (this.entries.size >= limit) {
        const oldest = [...this.entries.values()].filter(value => !this.touched.has(value.key)).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!oldest) return empty('invalid', key, `特效数据请求超过 ${limit} 个共享设备上限。`);
        this.entries.delete(oldest.key); oldest.controller?.abort(); oldest.queued = false;
      }
      entry = { key, request, result: empty('waiting', key, '正在读取设备数据。'), sourceTimestamp: null, nextAt: 0, settledAt: null, lastUsed: now,
        pollMs: bounded(binding.http.pollIntervalMs, 1000, 250, 3600000), policyObserved: false, queued: false, controller: null };
      this.entries.set(key, entry);
    }
    if (active) {
      this.touched.add(key); entry.lastUsed = now; this.updatePolicy(entry, request, binding, now);
      if (!entry.controller && !entry.queued && now >= entry.nextAt) { entry.queued = true; this.queue.push(entry); this.pump(); }
    }
    const result = entry.result;
    return result.status === 'online' && result.receivedAt !== null && this.isStale(binding, now, result.receivedAt, entry.sourceTimestamp)
      ? { ...result, status: 'stale', message: '设备数据已过期。' } : result;
  }

  private updatePolicy(entry: Entry, request: EffectDataRequest, binding: EffectDataBinding, now: number): void {
    const pollMs = bounded(binding.http.pollIntervalMs, 1000, 250, 3600000);
    // 同一读取周期采用活跃读者中最短的轮询间隔和超时；在途请求保留启动时的超时。
    entry.pollMs = entry.policyObserved ? Math.min(entry.pollMs, pollMs) : pollMs;
    entry.request = { ...entry.request, timeoutMs: entry.policyObserved ? Math.min(entry.request.timeoutMs, request.timeoutMs) : request.timeoutMs };
    entry.policyObserved = true;
    entry.nextAt = entry.settledAt === null ? 0 : entry.settledAt + entry.pollMs;
    if (entry.queued && now < entry.nextAt) {
      const index = this.queue.indexOf(entry); if (index >= 0) this.queue.splice(index, 1);
      entry.queued = false;
    }
  }

  private pump(): void {
    const limit = Math.floor(bounded(this.options.maxConcurrent ?? 4, 4, 1, 8));
    while (!this.disposed && this.running < limit && this.queue.length) {
      const entry = this.queue.shift()!; entry.queued = false;
      if (this.entries.get(entry.key) !== entry) continue;
      this.running++; void this.fetchEntry(entry).finally(() => { this.running--; this.pump(); });
    }
  }

  private async fetchEntry(entry: Entry): Promise<void> {
    const controller = new AbortController(); entry.controller = controller;
    const timeout = setTimeout(() => controller.abort(new Error('特效数据请求超时。')), entry.request.timeoutMs);
    const request = { ...entry.request, requestId: `effect_${Date.now()}_${++requestSequence}` };
    try {
      const transport = this.options.transport ?? transportContext.transport ?? browserTransport;
      const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? new Error('请求已取消。')), { once: true }));
      const raw = await Promise.race([transport(request, controller.signal), aborted]);
      if (controller.signal.aborted || this.entries.get(entry.key) !== entry) return;
      const parsed = parseEffectDataResponse(raw, request);
      entry.sourceTimestamp = parsed.sourceTimestamp;
      entry.result = { status: 'online', fields: parsed.fields, data: parsed.data, receivedAt: this.now(), message: '已收到设备数据。', key: entry.key };
    } catch (error) {
      if (this.entries.get(entry.key) !== entry || this.disposed) return;
      const message = error instanceof Error ? error.message : '特效取数失败。';
      entry.result = { ...entry.result, status: message.includes('DATA_FLOW_MQTT_DATA_NOT_FOUND') ? 'missing' : 'error', message: message.slice(0, 500) };
    } finally { clearTimeout(timeout); entry.controller = null; entry.settledAt = this.now(); entry.nextAt = entry.settledAt + entry.pollMs; }
  }
}

/** 适配中台两个只读取数协议，保留原始解析结果供数据集字段路径读取。 */
export function parseEffectDataResponse(raw: unknown, request: EffectDataRequest): { fields: Record<string, unknown>; data: unknown; sourceTimestamp: number | null } {
  const envelope = object(raw);
  if (!envelope || envelope.success !== true) {
    const code = typeof envelope?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(envelope.code) ? envelope.code : 'EFFECT_DATA_FETCH_FAILED';
    // 中台错误只显示业务码，不能把底层 URL、请求头或凭据回显到特效诊断。
    throw new Error(`${code}：特效取数失败，请检查数据源、设备身份和访问权限。`);
  }
  const body = object(envelope.data);
  if (!body) throw new Error('特效取数响应缺少 data。');
  if (request.mode === 'data-source') {
    if (typeof body.statusCode !== 'number' || body.statusCode < 200 || body.statusCode >= 300) throw new Error(`托管数据源返回 HTTP ${typeof body.statusCode === 'number' ? body.statusCode : '未知'}。`);
    const data = parseJson(body.responseBody, '托管数据源响应');
    return { fields: object(data) ?? {}, data, sourceTimestamp: null };
  }
  const device = object(body.device);
  if (!device || device.namespace !== request.namespace || device.deviceType !== request.deviceType || device.deviceNo !== request.assetCode) throw new Error('最新遥测返回的设备身份与请求不匹配。');
  const data = parseJson(body.payloadJson, '最新遥测 payloadJson'); const payload = object(data);
  const parsed = payload && Array.isArray(payload.data)
    ? parseDeviceTelemetryMessage(`dt/factory/logistics/${request.deviceType}/${request.assetCode}/twindatadriven/joint`, body.payloadJson as string, { kind: 'epv', sourceId: 'http-latest' }) : null;
  const persistedAt = typeof device.lastSuccessAt === 'string' ? Date.parse(device.lastSuccessAt) : NaN;
  return { fields: parsed?.fields ?? payload ?? {}, data,
    sourceTimestamp: parsed?.sourceTimestamp ?? (Number.isFinite(persistedAt) ? persistedAt : null) };
}
