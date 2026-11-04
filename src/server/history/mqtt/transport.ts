import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { Duplex } from 'node:stream';
import { checkServerIdentity, connect as connectTls } from 'node:tls';
import type { TLSSocket } from 'node:tls';
import type { HistoryMqttSourceConfig } from '../../../../electron/shared/historySourceConfig.ts';
import { MqttCollectorError, type MqttAllowedTarget, type MqttCollectorLimits } from './types.ts';

// mqtt-packet 的 debug 会打印业务载荷和连接字段；允许主机按自己的配置关闭，而不是全局改 DEBUG。
export function assertNoMqttDebug(): void {
  const require = createRequire(import.meta.url);
  const debug = require('debug') as { enabled(namespace: string): boolean };
  if (['mqtt-packet:parser', 'mqtt-packet:writeToStream'].some(name => debug.enabled(name))) {
    throw new MqttCollectorError('STATE_FAILURE', 'MQTT 依赖调试日志可能泄露数据，必须先关闭。');
  }
}
function validateTopicFilter(filter: string): boolean {
  if (!filter || Buffer.byteLength(filter) > 4096 || filter.includes('\0') || filter.startsWith('$share/')) return false;
  const levels = filter.split('/');
  return levels.every((level, index) => {
    if (level.includes('#')) return level === '#' && index === levels.length - 1;
    return !level.includes('+') || level === '+';
  });
}
export function matchesTopic(filter: string, topic: string): boolean {
  if (topic.startsWith('$') && !filter.startsWith('$')) return false;
  const wanted = filter.split('/'), actual = topic.split('/');
  for (let i = 0; i < wanted.length; i += 1) {
    if (wanted[i] === '#') return true;
    if (i >= actual.length || (wanted[i] !== '+' && wanted[i] !== actual[i])) return false;
  }
  return wanted.length === actual.length;
}
export function lockedTarget(source: HistoryMqttSourceConfig, allowed: readonly MqttAllowedTarget[],
  identity: { projectId: string; captureDomainId: string; sourceContractId: string }): {
  hostname: string; port: number; address: string; topics: { filter: string; qos: 0 | 1 | 2 }[];
} {
  let url: URL;
  try { url = new URL(source.brokerUri); } catch { throw new MqttCollectorError('STATE_FAILURE', 'MQTT broker 地址无效。'); }
  const raw = source.brokerUri;
  const authority = /^mqtts:\/\/([^/?#]*)/iu.exec(raw)?.[1] ?? '';
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'mqtts:' || !authority || authority.includes('@') || authority.includes('%') || raw.includes('\\')
    || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')
    || isIP(hostname) !== 0 || hostname.length > 253
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)) {
    throw new MqttCollectorError('STATE_FAILURE', '只允许无 userinfo、路径、查询或重定向的 mqtts 域名地址。');
  }
  const port = url.port ? Number(url.port) : 8883;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Array.isArray(source.topics)
    || !source.topics.length || source.topics.length > 256) throw new MqttCollectorError('STATE_FAILURE', 'MQTT 目标或主题数量无效。');
  if (!Array.isArray(allowed)) throw new MqttCollectorError('STATE_FAILURE', 'MQTT 服务端来源授权无效。');
  const matches = (allowed as readonly MqttAllowedTarget[]).filter(item => item && typeof item.hostname === 'string'
    && item.hostname.toLowerCase() === hostname && item.port === port
    && item.projectId === identity.projectId && item.captureDomainId === identity.captureDomainId
    && item.sourceId === source.logicalSourceId && item.authorityScope === source.authorityScope
    && item.sourceContractId === identity.sourceContractId);
  if (matches.length !== 1) throw new MqttCollectorError('STATE_FAILURE', 'MQTT 目标未被唯一的服务端白名单授权。');
  const rule = matches[0];
  if (!Array.isArray(rule.pinnedAddresses) || !rule.pinnedAddresses.length || rule.pinnedAddresses.length > 64
    || rule.pinnedAddresses.some(ip => !isIP(ip)) || !Array.isArray(rule.topics)) {
    throw new MqttCollectorError('STATE_FAILURE', 'MQTT 服务端白名单地址或主题无效。');
  }
  const seen = new Set<string>();
  const topics = source.topics.map(item => {
    if (!validateTopicFilter(item.filter) || ![0, 1, 2].includes(item.qos) || seen.has(item.filter)
      || !rule.topics.some(permit => permit.filter === item.filter && [0, 1, 2].includes(permit.qos) && item.qos <= permit.qos)) {
      throw new MqttCollectorError('STATE_FAILURE', 'MQTT 主题或 QoS 未被服务端白名单精确授权。');
    }
    seen.add(item.filter); return { filter: item.filter, qos: item.qos };
  });
  return { hostname, port, address: rule.pinnedAddresses[0], topics };
}
export function resolveLimits(input: Partial<MqttCollectorLimits> | undefined, archiveMaxPayload: number): MqttCollectorLimits {
  const limits: MqttCollectorLimits = { maxPacketBytes: Math.min(1024 * 1024, archiveMaxPayload + 8192), maxStateBytes: 256 * 1024 * 1024,
    maxStateEntries: 65535, maxOrphanFiles: 64, maxRecoveryPages: 64, maxRecoveryBytes: 64 * 1024 * 1024,
    reconnectDelayMs: 5000, connectTimeoutMs: 30000, ...input };
  const bounds: Record<keyof MqttCollectorLimits, [number, number]> = {
    maxPacketBytes: [1024, 16 * 1024 * 1024], maxStateBytes: [64 * 1024, 4 * 1024 * 1024 * 1024],
    maxStateEntries: [1, 65535], maxOrphanFiles: [1, 4096], maxRecoveryPages: [1, 10000],
    maxRecoveryBytes: [1024, 4 * 1024 * 1024 * 1024], reconnectDelayMs: [250, 3600000], connectTimeoutMs: [1000, 300000],
  };
  for (const key of Object.keys(bounds) as (keyof MqttCollectorLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < bounds[key][0] || limits[key] > bounds[key][1]) {
      throw new MqttCollectorError('STATE_FAILURE', 'MQTT 接收预算无效。');
    }
  }
  return limits;
}
export function stableClientId(projectId: string, domainId: string, sourceId: string): string {
  const digest = createHash('sha256').update(JSON.stringify([projectId, domainId, sourceId])).digest('hex');
  return `h${BigInt(`0x${digest}`).toString(36).slice(0, 22)}`;
}

/** 不缓存整包：检查剩余长度后再交给 MQTT.js 解析，避免 MQTT 3 不受控包长。 */
class FrameGuard {
  #phase: 'header' | 'length' | 'body' = 'header';
  #remaining = 0;
  #multiplier = 1;
  #lengthBytes = 0;
  constructor(readonly max: number, readonly outbound: boolean) {}
  inspect(chunk: Buffer): void {
    let position = 0;
    while (position < chunk.length) {
      if (this.#phase === 'header') {
        const type = chunk[position++] >>> 4;
        if (this.outbound && ![1, 4, 5, 7, 8, 12, 14].includes(type)) throw new Error('MQTT_OUTBOUND_FORBIDDEN');
        this.#phase = 'length'; this.#remaining = 0; this.#multiplier = 1; this.#lengthBytes = 0;
      } else if (this.#phase === 'length') {
        const value = chunk[position++]; this.#lengthBytes += 1;
        if (this.#lengthBytes > 4) throw new Error('MQTT_PACKET_LIMIT');
        this.#remaining += (value & 127) * this.#multiplier;
        if (this.#remaining + this.#lengthBytes + 1 > this.max) throw new Error('MQTT_PACKET_LIMIT');
        if (value & 128) { if (this.#lengthBytes === 4) throw new Error('MQTT_PACKET_LIMIT'); this.#multiplier *= 128; }
        else this.#phase = this.#remaining ? 'body' : 'header';
      } else {
        const consumed = Math.min(this.#remaining, chunk.length - position); position += consumed; this.#remaining -= consumed;
        if (this.#remaining === 0) this.#phase = 'header';
      }
    }
  }
}

/** TCP 只连白名单里的固定 IP；TLS 验证、SNI 均使用原始 broker 域名。 */
export class PinnedTlsStream extends Duplex {
  readonly #socket: TLSSocket;
  readonly #incoming: FrameGuard;
  readonly #outgoing: FrameGuard;
  constructor(target: { hostname: string; port: number; address: string }, maxPacketBytes: number) {
    super({ highWaterMark: 64 * 1024 });
    this.#incoming = new FrameGuard(maxPacketBytes, false); this.#outgoing = new FrameGuard(maxPacketBytes, true);
    this.#socket = connectTls({ host: target.address, port: target.port, servername: target.hostname, rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(target.hostname, certificate) });
    this.#socket.setNoDelay(true);
    this.#socket.on('data', (chunk: Buffer) => {
      try { this.#incoming.inspect(chunk); if (!this.push(chunk)) this.#socket.pause(); }
      catch { this.destroy(new Error('MQTT_PACKET_LIMIT')); }
    });
    this.#socket.on('end', () => this.push(null));
    this.#socket.on('error', () => this.destroy(new Error('MQTT_TRANSPORT_ERROR')));
    this.#socket.on('close', () => { if (!this.destroyed) this.destroy(); });
  }
  override _read(): void { this.#socket.resume(); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); this.#outgoing.inspect(bytes);
      this.#socket.write(bytes, callback);
    } catch { callback(new Error('MQTT_OUTBOUND_FORBIDDEN')); }
  }
  override _final(callback: (error?: Error | null) => void): void { this.#socket.end(callback); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#socket.destroy(); callback(error);
  }
}
