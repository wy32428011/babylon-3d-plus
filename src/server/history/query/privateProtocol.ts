import { createHmac, timingSafeEqual } from 'node:crypto';
import { HistoryQueryError } from './types.ts';
import type { ReadAction, ReadGrant } from './types.ts';
import { HistoryQueryService } from './HistoryQueryService.ts';

/**
 * 一条已被持久 owner 接管的私有双向通道使用独立随机密钥；密钥只能经受保护的继承句柄传递。
 * 本类不启动进程、不监听端口；监督者负责进程生命周期、fencing、帧读写和硬截止。
 * 换进程/重连必须换密钥和实例；帧、认证或序号错误须由监督者关闭通道并废弃密钥。
 * 旧 worker 不得继续读；接口不证明外层 owner 已接入。
 */
export class HistoryPrivateProtocol {
  readonly #secret: Buffer;
  readonly #active = new Set<AbortController>();
  #lastSequence = 0;
  #closed = false;
  constructor(readonly service: HistoryQueryService, secret: Uint8Array) {
    if (!service || !(secret instanceof Uint8Array) || secret.byteLength < 32 || secret.byteLength > 128) throw new HistoryQueryError('CHANNEL_KEY_REQUIRED', '私有查询通道缺少独立密钥。');
    this.#secret = Buffer.from(secret);
  }
  #mac(prefix: string, data: string): Buffer {
    if (this.#closed) throw new HistoryQueryError('CHANNEL_CLOSED', '私有查询通道已关闭。');
    return createHmac('sha256', this.#secret).update(`${prefix}.${data}`, 'utf8').digest();
  }
  async handle(line: string): Promise<string> {
    if (this.#closed || typeof line !== 'string' || Buffer.byteLength(line) > 262_144) throw new HistoryQueryError('CHANNEL_FRAME', '私有查询帧无效。');
    let frame: { payload?: unknown; mac?: unknown };
    try { frame = JSON.parse(line); } catch { throw new HistoryQueryError('CHANNEL_FRAME', '私有查询帧无效。'); }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || Object.keys(frame).sort().join(',') !== 'mac,payload'
      || typeof frame.payload !== 'string' || typeof frame.mac !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(frame.payload) || !/^[A-Za-z0-9_-]{43}$/u.test(frame.mac))
      throw new HistoryQueryError('CHANNEL_FRAME', '私有查询帧无效。');
    const supplied = Buffer.from(frame.mac, 'base64url'), expected = this.#mac('request', frame.payload);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || supplied.toString('base64url') !== frame.mac) throw new HistoryQueryError('CHANNEL_AUTH', '私有查询通道认证失败。');
    let request: { sequence: number; deadline: number; grant: ReadGrant; action: ReadAction; body: unknown };
    try {
      const data = Buffer.from(frame.payload, 'base64url');
      if (data.toString('base64url') !== frame.payload) throw new Error();
      request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    } catch { throw new HistoryQueryError('CHANNEL_FRAME', '私有查询帧内容无效。'); }
    if (!request || typeof request !== 'object' || Object.keys(request).sort().join(',') !== 'action,body,deadline,grant,sequence'
      || !Number.isSafeInteger(request.sequence) || request.sequence !== this.#lastSequence + 1
      || !Number.isSafeInteger(request.deadline) || request.deadline <= Date.now() || request.deadline > Date.now() + 30_000)
      throw new HistoryQueryError('CHANNEL_SEQUENCE', '私有查询帧重放、乱序或超时。');
    if (this.#active.size >= 32) throw new HistoryQueryError('CHANNEL_CAPACITY', '私有查询通道并发已达上限。');
    this.#lastSequence = request.sequence;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, request.deadline - Date.now()));
    this.#active.add(controller);
    let result: unknown;
    try {
      const data = await this.service.dispatch(request.grant, request.action, request.body, controller.signal);
      if (controller.signal.aborted || Date.now() >= request.deadline) throw new HistoryQueryError('QUERY_TIMEOUT', '查询超过期限。');
      result = { sequence: request.sequence, ok: true, data };
    } catch (error) {
      const possible = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : null;
      const code = typeof possible === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(possible) ? possible : 'QUERY_FAILED';
      result = { sequence: request.sequence, ok: false, code };
    } finally { clearTimeout(timer); this.#active.delete(controller); }
    if (this.#closed) throw new HistoryQueryError('CHANNEL_CLOSED', '私有查询通道已关闭。');
    const data = Buffer.from(JSON.stringify(result), 'utf8');
    if (data.length > 4 * 1024 * 1024) throw new HistoryQueryError('CHANNEL_FRAME', '私有查询响应超过预算。');
    const payload = data.toString('base64url');
    return JSON.stringify({ payload, mac: this.#mac('response', payload).toString('base64url') });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#active) controller.abort();
    this.#secret.fill(0);
  }
}
