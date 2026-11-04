import { createHash, randomUUID } from 'node:crypto';
import { MqttClient, Store, type IClientOptions, type IPublishPacket, type Packet } from 'mqtt';
import type { InputCursor } from '../../../runtime/history/state/types.ts';
import type { CapturedArrival, CapturedReceipt, RawHistoryArrival } from '../storage/index.ts';
import { DurableIncomingState, type IncomingEntry, type IncomingStage } from './DurableIncomingState.ts';
import { assertNoMqttDebug, lockedTarget, matchesTopic, PinnedTlsStream, resolveLimits, stableClientId } from './transport.ts';
import { MqttCollectorError, type MqttCollectorLimits, type MqttCollectorOptions, type MqttCollectorStatus, type MqttIntegrityCode } from './types.ts';

type PacketCallback = (error?: Error, packet?: Packet) => void;
type DoneCallback = (error?: Error) => void;
type Connection = {
  id: string; client: MqttClient; password: Buffer | null; closed: boolean;
  barrier: Promise<void>; release(): void; reject(): void; operations: Set<Promise<unknown>>;
};
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
}
function safeText(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !value.includes('\0');
}
function eventCode(error: unknown, fallback: MqttIntegrityCode): MqttIntegrityCode {
  return error instanceof MqttCollectorError ? error.code : fallback;
}
function packetId(packet: Pick<Packet, 'messageId'>): number {
  if (!Number.isInteger(packet.messageId) || packet.messageId! < 1 || packet.messageId! > 65535) {
    throw new MqttCollectorError('PACKET_CONFLICT', 'MQTT packet identifier 无效。');
  }
  return packet.messageId!;
}
function fingerprint(packet: IPublishPacket): string {
  const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
  return hash(canonical([packet.topic, packet.qos, packet.retain, payload.toString('base64')]));
}
function storedPacket(entry: IncomingEntry): IPublishPacket {
  return { cmd: 'publish', messageId: entry.id, qos: entry.qos, topic: entry.kind === 'stage' ? entry.topic : '',
    payload: entry.kind === 'stage' ? Buffer.from(entry.payloadBase64, 'base64') : Buffer.alloc(0),
    retain: entry.kind === 'stage' ? entry.retain : false, dup: entry.kind === 'stage' ? entry.duplicate : true };
}

/** MQTT.js 忽略 put 的错误、get 的错误会发送 PUBCOMP，因此故障时不得调用相应回调。 */
class IncomingAdapter extends Store {
  constructor(readonly collector: MqttHistoryCollector, readonly connection: () => Connection) { super({ clean: false }); }
  override put(packet: Packet, callback: DoneCallback): this {
    const ctx = this.connection();
    this.collector.runPacket(ctx, async () => {
      if (packet.cmd !== 'publish' || packet.qos !== 2) throw new MqttCollectorError('PACKET_CONFLICT', 'QoS2 暂存收到非 PUBLISH。');
      await this.collector.stagePacket(ctx, packet);
    }, () => callback()); return this;
  }
  override get(packet: Pick<Packet, 'messageId'>, callback: PacketCallback): this {
    const ctx = this.connection();
    this.collector.runPacket(ctx, async () => this.collector.getPubrel(packetId(packet)), value => callback(undefined, value));
    return this;
  }
  override del(_packet: Pick<Packet, 'messageId'>, callback: PacketCallback): this {
    // 完成标记已在 handleMessage 返回之前 fsync；保留标记处理重复 PUBREL 和 messageId 复用。
    callback(); return this;
  }
  override close(callback: DoneCallback): void { callback(); }
}

/**
 * 后台只读 MQTT 接收器；公开的 collecting 仅表示接收通路，绝不代表回放基线或业务投影就绪。
 * 单消息串行持久化；MQTT 2 级别在 PUBREC 前持久化 stage、原始证据和回执。
 */
export class MqttHistoryCollector {
  readonly #options: MqttCollectorOptions;
  readonly #state: DurableIncomingState;
  readonly #target: ReturnType<typeof lockedTarget>;
  readonly #limits: MqttCollectorLimits;
  readonly #clientId: string;
  #status: MqttCollectorStatus;
  #connection: Connection | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopping = false;
  #startCalled = false;
  #attempting = false;
  #pendingBlock: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;
  private constructor(options: MqttCollectorOptions, state: DurableIncomingState, target: ReturnType<typeof lockedTarget>,
    limits: MqttCollectorLimits, clientId: string) {
    this.#options = options; this.#state = state; this.#target = target; this.#limits = limits; this.#clientId = clientId;
    this.#status = { phase: 'starting', sourceId: options.source.logicalSourceId, clientId, code: null, historicalReadiness: 'not-established' };
  }
  /** 恢复和配置冻结均在连接前完成；需要外层同时持有 archive 的 fenced writer。 */
  static async open(input: MqttCollectorOptions): Promise<MqttHistoryCollector> {
    const source = structuredClone(input.source), scope = input.archive.scope;
    if (source.version !== 1 || !safeText(source.logicalSourceId) || !safeText(source.authorityScope)
      || !safeText(input.sourceContractId) || ![4, 5].includes(input.protocolVersion)
      || !Number.isInteger(input.sessionExpirySeconds) || input.sessionExpirySeconds < 1 || input.sessionExpirySeconds > 0xffffffff
      || typeof input.onIntegrityEvent !== 'function' || typeof input.getCredential !== 'function'
      || !input.fencing || typeof input.fencing.runExclusive !== 'function' || !input.archive.usesFencing(input.fencing)
      || input.projector.archiveId !== input.archive.archiveId || input.projector.sourceContractId !== input.sourceContractId) {
      throw new MqttCollectorError('STATE_FAILURE', 'MQTT 来源、持久会话或协调者合同无效。');
    }
    const options: MqttCollectorOptions = { ...input, source, allowedTargets: structuredClone(input.allowedTargets) };
    const target = lockedTarget(source, options.allowedTargets, { projectId: scope.projectId, captureDomainId: scope.captureDomainId,
      sourceContractId: options.sourceContractId });
    const limits = resolveLimits(options.limits, options.archive.limits.maxRawPayloadBytes);
    const durability = options.durability ?? options.archive.durability;
    if (durability !== options.archive.durability) throw new MqttCollectorError('STATE_FAILURE', 'MQTT 和归档持久性合同必须一致。');
    const clientId = stableClientId(scope.projectId, scope.captureDomainId, source.logicalSourceId);
    const identity = hash(canonical({ scope, clientId, source, sourceContractId: options.sourceContractId,
      protocolVersion: options.protocolVersion, expiry: options.sessionExpirySeconds, target, durability }));
    const directoryKey = canonical([scope.projectId, scope.captureDomainId, source.logicalSourceId]);
    let state: DurableIncomingState;
    try {
      state = await DurableIncomingState.open({ root: options.stateRootDirectory, scope, writer: options.archive.writer,
        fencing: options.fencing, durability, limits, identity, directoryKey, reclaim: options.reclaimAbandonedWriter });
    } catch {
      // 状态不可读取或锁不可取得时不会启动或确认；协调者也应关闭该来源的完整性。
      await MqttHistoryCollector.reportOpenFailure(options, 'STATE_FAILURE');
      throw new MqttCollectorError('STATE_FAILURE', 'MQTT 接收状态无法安全打开。');
    }
    const collector = new MqttHistoryCollector(options, state, target, limits, clientId);
    try {
      if (state.session.online) await collector.#integrity('UNCLEAN_RESTART');
      await collector.#recoverStages();
      return collector;
    } catch (error) {
      try { await collector.#integrity(eventCode(error, 'RECOVERY_UNPROVABLE')); } catch { /* 仍阻断连接。 */ }
      try { await state.close(); } catch { /* 只允许外层持久换代后显式恢复。 */ }
      throw new MqttCollectorError(eventCode(error, 'RECOVERY_UNPROVABLE'), 'MQTT 接收状态无法证明安全恢复。');
    }
  }
  static async reportOpenFailure(options: MqttCollectorOptions, code: MqttIntegrityCode): Promise<void> {
    const scope = options.archive.scope;
    try {
      await options.onIntegrityEvent({ eventId: randomUUID(), sourceId: options.source.logicalSourceId, sourceContractId: options.sourceContractId,
        captureDomainId: scope.captureDomainId, captureEpoch: scope.captureEpoch, at: Date.now(), code, requiresGap: true });
    } catch { /* 打开失败本身已阻止就绪和 ACK。 */ }
  }
  get status(): MqttCollectorStatus { return { ...this.#status }; }
  #setStatus(phase: MqttCollectorStatus['phase'], code: MqttIntegrityCode | null = null): void {
    this.#status = { ...this.#status, phase, code };
    try { this.#options.onStatus?.(this.status); } catch { /* 观察者不改变已提交状态。 */ }
  }
  async #integrity(code: MqttIntegrityCode): Promise<void> {
    const scope = this.#options.archive.scope;
    const proof = await this.#options.onIntegrityEvent({ eventId: randomUUID(), sourceId: this.#options.source.logicalSourceId,
      sourceContractId: this.#options.sourceContractId, captureDomainId: scope.captureDomainId, captureEpoch: scope.captureEpoch,
      at: Date.now(), code, requiresGap: true });
    if (!proof || proof.durable !== true) throw new MqttCollectorError('STATE_FAILURE', '协调者没有持久化采集缺口。');
  }
  async start(): Promise<void> {
    if (this.#startCalled || this.#stopping) throw new MqttCollectorError('STATE_FAILURE', 'MQTT 采集器不能重复启动。');
    this.#startCalled = true;
    try {
      assertNoMqttDebug(); await this.#state.saveSession({ ...this.#state.session, online: true });
      void this.#attempt();
    } catch (error) {
      this.#setStatus('blocked', eventCode(error, 'STATE_FAILURE'));
      try { await this.#integrity(eventCode(error, 'STATE_FAILURE')); } catch { /* 无持久缺口时保持阻断。 */ }
      throw new MqttCollectorError(eventCode(error, 'STATE_FAILURE'), 'MQTT 采集器无法安全启动。');
    }
  }
  async #attempt(): Promise<void> {
    if (this.#stopping || this.#attempting || this.#connection || this.#status.phase === 'blocked') return;
    this.#attempting = true; this.#setStatus('connecting');
    let password: Buffer | null = null;
    try {
      assertNoMqttDebug();
      const credential = await this.#options.getCredential();
      if (this.#stopping || this.status.phase === 'blocked') return;
      if (!credential || !['none', 'mqtt'].includes(credential.type)) throw new MqttCollectorError('STATE_FAILURE', 'MQTT 凭据类型无效。');
      const username = credential.type === 'mqtt' ? credential.username : undefined;
      if (credential.type === 'mqtt') {
        if (!safeText(credential.username, 65535) || typeof credential.password !== 'string' || Buffer.byteLength(credential.password) > 65535) {
          throw new MqttCollectorError('STATE_FAILURE', 'MQTT 凭据格式无效。');
        }
        password = Buffer.from(credential.password, 'utf8');
      }
      let release!: () => void, reject!: () => void;
      const barrier = new Promise<void>((resolve, rejectPromise) => { release = resolve; reject = () => rejectPromise(new Error('CONNECTION_CLOSED')); });
      void barrier.catch(() => undefined);
      let ctx!: Connection;
      const incoming = new IncomingAdapter(this, () => ctx);
      const clientOptions: IClientOptions = { manualConnect: true, reconnectPeriod: 0, resubscribe: false, clean: false,
        clientId: this.#clientId, protocolVersion: this.#options.protocolVersion, keepalive: 60,
        connectTimeout: this.#limits.connectTimeoutMs, incomingStore: incoming, queueQoSZero: false,
        username, password: password ?? undefined, log: () => undefined,
        ...(this.#options.protocolVersion === 5 ? { properties: { sessionExpiryInterval: this.#options.sessionExpirySeconds,
          receiveMaximum: 1, maximumPacketSize: this.#limits.maxPacketBytes, topicAliasMaximum: 0 } } : {}) };
      const client = new MqttClient(() => new PinnedTlsStream(this.#target, this.#limits.maxPacketBytes), clientOptions);
      ctx = { id: randomUUID(), client, password, closed: false, barrier, release, reject, operations: new Set() };
      this.#connection = ctx; password = null;
      client.handleMessage = (packet, callback) => this.runPacket(ctx, async () => this.#handleMessage(ctx, packet), () => callback());
      client.on('connect', packet => { this.#track(ctx, this.#connected(ctx, packet)); });
      client.on('packetreceive', packet => {
        if (packet.cmd === 'publish' && packet.properties?.topicAlias !== undefined) {
          // 已声明 topicAliasMaximum=0；先阻断，再避免 MQTT.js 对不存在的别名表解引用。
          this.#block('PACKET_CONFLICT', ctx);
          delete packet.properties.topicAlias;
        }
        if (packet.cmd === 'pubrel' && packet.reasonCode && packet.reasonCode !== 0) {
          this.#block('PACKET_CONFLICT', ctx);
        }
      });
      client.on('disconnect', () => { client.stream.destroy(); });
      client.on('error', error => {
        if (error.message === 'MQTT_PACKET_LIMIT') this.#block('PACKET_LIMIT', ctx);
        else if (client.stream && !client.stream.destroyed) client.stream.destroy();
      });
      client.on('close', () => { void this.#closed(ctx); });
      client.connect();
    } catch (error) {
      password?.fill(0);
      if (error instanceof MqttCollectorError) this.#block(error.code, this.#connection ?? undefined);
      else if (!this.#stopping) {
        try { await this.#integrity('DISCONNECTED'); this.#setStatus('disconnected', 'DISCONNECTED'); this.#schedule(); }
        catch { this.#setStatus('blocked', 'STATE_FAILURE'); }
      }
    } finally { this.#attempting = false; }
  }
  #track(ctx: Connection, operation: Promise<unknown>): void {
    ctx.operations.add(operation); void operation.catch(error => {
      if (!ctx.closed && !this.#stopping) this.#block(eventCode(error, 'STATE_FAILURE'), ctx);
    }).finally(() => ctx.operations.delete(operation));
  }
  async #connected(ctx: Connection, packet: { sessionPresent: boolean; properties?: { sessionExpiryInterval?: number } }): Promise<void> {
    if (ctx.closed || this.#stopping) return;
    let session = this.#state.session;
    if (packet.properties?.sessionExpiryInterval !== undefined && packet.properties.sessionExpiryInterval < this.#options.sessionExpirySeconds) {
      throw new MqttCollectorError('SESSION_EXPIRY_SHORTENED', '服务端缩短了持久会话期限。');
    }
    if (packet.sessionPresent && !session.hadSession) throw new MqttCollectorError('SESSION_STATE_UNKNOWN', 'broker 会话存在但本地没有接续证明。');
    if (!packet.sessionPresent) {
      await this.#integrity('SESSION_NOT_PRESENT');
      session = { ...session, epoch: randomUUID(), hadSession: true, subscribed: false };
      await this.#state.saveSession(session);
    } else if (!session.subscribed) {
      // SUBACK 与本地标记之间崩溃时重订阅可能重发 retained，不能声称连续。
      await this.#integrity('SUBSCRIPTION_RECOVERY_UNCERTAIN');
    }
    if (ctx.closed || this.#stopping) return;
    ctx.release();
    if (session.subscribed) { this.#setStatus('collecting'); return; }
    this.#setStatus('subscribing');
    const request: Record<string, { qos: 0 | 1 | 2 }> = Object.create(null) as Record<string, { qos: 0 | 1 | 2 }>;
    for (const item of this.#target.topics) request[item.filter] = { qos: item.qos };
    ctx.client.subscribe(request, (error, grants) => {
      if (ctx.closed || this.#stopping) return;
      if (error || !grants || grants.length !== this.#target.topics.length || this.#target.topics.some(item =>
        !grants.some(grant => grant.topic === item.filter && grant.qos === item.qos))) {
        this.#block('SUBSCRIPTION_REJECTED', ctx); return;
      }
      this.#track(ctx, (async () => {
        await this.#state.saveSession({ ...this.#state.session, subscribed: true });
        if (!ctx.closed && !this.#stopping) this.#setStatus('collecting');
      })());
    });
  }
  #schedule(): void {
    if (this.#stopping || this.#status.phase === 'blocked' || this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.#attempt(); }, this.#limits.reconnectDelayMs);
  }
  async #closed(ctx: Connection): Promise<void> {
    if (ctx.closed) return; ctx.closed = true; ctx.reject();
    ctx.client.options.password = undefined; ctx.client.options.username = undefined; ctx.password?.fill(0); ctx.password = null;
    await Promise.allSettled([...ctx.operations]);
    if (this.#connection === ctx) this.#connection = null;
    if (this.#stopping || this.#status.phase === 'blocked') return;
    this.#setStatus('disconnected', 'DISCONNECTED');
    try { await this.#integrity('DISCONNECTED'); this.#schedule(); }
    catch { this.#setStatus('blocked', 'STATE_FAILURE'); }
  }
  #block(code: MqttIntegrityCode, ctx?: Connection): void {
    if (this.#status.phase === 'blocked' || this.#stopping) return;
    this.#setStatus('blocked', code);
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    ctx?.reject(); ctx?.client.stream?.destroy();
    this.#pendingBlock = this.#integrity(code).catch(() => {
      this.#setStatus('blocked', 'STATE_FAILURE');
      throw new MqttCollectorError('STATE_FAILURE', '采集故障的缺口未能持久化。');
    });
    void this.#pendingBlock.catch(() => undefined);
  }
  /** MQTT.js 在一个流中按回调顺序处理包；拒绝时毁流，绝不调用会产生 ACK 的回调。 */
  runPacket<T>(ctx: Connection, work: () => Promise<T>, callback: (value: T) => void): void {
    const operation = (async () => {
      await ctx.barrier;
      if (ctx.closed || this.#stopping || this.#status.phase === 'blocked') return;
      const result = await work();
      if (!ctx.closed && !this.#stopping && this.status.phase !== 'blocked') callback(result);
    })();
    this.#track(ctx, operation);
  }
  #validatePacket(packet: IPublishPacket): void {
    const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
    if (!safeText(packet.topic, 4096) || packet.topic.includes('+') || packet.topic.includes('#')
      || !this.#target.topics.some(item => matchesTopic(item.filter, packet.topic) && packet.qos <= item.qos) || payload.length > this.#options.archive.limits.maxRawPayloadBytes
      || payload.length > this.#limits.maxPacketBytes || ![0, 1, 2].includes(packet.qos)
      || typeof packet.dup !== 'boolean' || typeof packet.retain !== 'boolean') {
      throw new MqttCollectorError('PACKET_CONFLICT', 'MQTT 消息不属于已锁定来源或超过预算。');
    }
  }
  async #handleMessage(ctx: Connection, packet: IPublishPacket): Promise<void> {
    if (packet.qos === 2) {
      const entry = this.getPubrel(packetId(packet));
      const state = this.#state.entry(packetId(entry));
      if (state?.kind === 'stage') {
        if (!state.receipt) throw new MqttCollectorError('RECOVERY_UNPROVABLE', 'QoS2 原始捕获回执缺失。');
        await this.#state.saveEntry({ kind: 'complete', id: state.id, qos: state.qos, epoch: state.epoch,
          connection: ctx.id, fingerprint: state.fingerprint });
      }
      return;
    }
    this.#validatePacket(packet);
    if (packet.qos === 1) {
      const entry = await this.stagePacket(ctx, packet);
      if (entry.kind === 'stage') await this.#state.saveEntry({ kind: 'complete', id: entry.id, qos: entry.qos,
        epoch: entry.epoch, connection: ctx.id, fingerprint: entry.fingerprint });
      return;
    }
    const receipt = await this.#capture(this.#arrival(packet, Date.now(), null));
    this.#receipt(receipt);
  }
  async stagePacket(ctx: Connection, packet: IPublishPacket): Promise<IncomingEntry> {
    this.#validatePacket(packet);
    if (packet.qos !== 1 && packet.qos !== 2) throw new MqttCollectorError('PACKET_CONFLICT', '仅 QoS1/2 使用持久消息标识。');
    const id = packetId(packet), epoch = this.#state.session.epoch, digest = fingerprint(packet);
    const previous = this.#state.entry(id);
    if (previous && previous.epoch !== epoch && packet.dup) {
      throw new MqttCollectorError('RECOVERY_UNPROVABLE', '新会话中的重复标识无法与旧会话的重传区分。');
    }
    if (previous && previous.epoch === epoch) {
      if (previous.kind === 'stage') {
        if (!packet.dup || previous.qos !== packet.qos || previous.fingerprint !== digest) {
          throw new MqttCollectorError('PACKET_CONFLICT', '未完成的 packet identifier 被不兼容地复用。');
        }
        if (!previous.receipt) throw new MqttCollectorError('RECOVERY_UNPROVABLE', '重传消息缺少已持久的捕获回执。');
        return previous;
      }
      if (packet.dup) {
        // 完成后 ACK 可能已送达；同标识的重传也可能是后续复用，不能靠相同内容猜测去重。
        throw new MqttCollectorError('RECOVERY_UNPROVABLE', '已完成标识的重复包无法与后续复用区分。');
      }
    }
    const after = this.#options.archive.getWatermarks().capturedThrough;
    const stage: IncomingStage = { kind: 'stage', epoch, connection: ctx.id, id, qos: packet.qos, fingerprint: digest,
      transactionId: randomUUID(), after, receivedAt: Date.now(), topic: packet.topic,
      payloadBase64: Buffer.from(packet.payload).toString('base64'), retain: packet.retain, duplicate: packet.dup, receipt: null };
    await this.#state.saveEntry(stage);
    const receipt = await this.#capture(this.#stageArrival(stage), stage.after);
    const captured = { ...stage, receipt };
    await this.#state.saveEntry(captured); this.#receipt(receipt); return captured;
  }
  getPubrel(id: number): IPublishPacket {
    const entry = this.#state.entry(id);
    if (!entry || entry.epoch !== this.#state.session.epoch || entry.qos !== 2 || (entry.kind === 'stage' && !entry.receipt)) {
      throw new MqttCollectorError('RECOVERY_UNPROVABLE', 'PUBREL 缺少可证明的持久 QoS2 接收状态。');
    }
    return storedPacket(entry);
  }
  #arrival(packet: IPublishPacket, receivedAt: number, transactionId: string | null): RawHistoryArrival {
    return { sourceId: this.#options.source.logicalSourceId, sourceContractId: this.#options.sourceContractId, receivedAt,
      transport: { kind: 'mqtt', topic: packet.topic, qos: packet.qos, retain: packet.retain, duplicate: packet.dup,
        packetId: packet.qos ? String(packetId(packet)) : null, ...(transactionId ? { captureTransactionId: transactionId } : {}) },
      rawPayload: Buffer.from(packet.payload) };
  }
  #stageArrival(stage: IncomingStage): RawHistoryArrival { return this.#arrival(storedPacket(stage), stage.receivedAt, stage.transactionId); }
  #receipt(receipt: CapturedReceipt): void { try { this.#options.onReceipt?.(structuredClone(receipt)); } catch { /* 观察者不影响持久 ACK。 */ } }
  #assertReceipt(receipt: CapturedReceipt, receivedAt: number, after?: InputCursor): void {
    const archive = this.#options.archive, through = archive.getWatermarks().capturedThrough;
    const cursor = receipt?.inputCursor;
    if (!receipt || receipt.kind !== 'captured' || receipt.archiveId !== archive.archiveId || receipt.durability !== archive.durability
      || receipt.receivedAt !== receivedAt || !cursor || cursor.captureDomainId !== archive.scope.captureDomainId
      || cursor.captureEpoch !== archive.scope.captureEpoch || typeof cursor.offset !== 'string' || !/^(0|[1-9][0-9]{0,39})$/u.test(cursor.offset)
      || through.captureDomainId !== cursor.captureDomainId || through.captureEpoch !== cursor.captureEpoch
      || BigInt(cursor.offset) > BigInt(through.offset) || (after && BigInt(cursor.offset) <= BigInt(after.offset))) {
      throw new MqttCollectorError('RECOVERY_UNPROVABLE', '捕获回执不属于指定归档或不在暂存水位之后。');
    }
  }
  async #capture(arrival: RawHistoryArrival, after?: InputCursor): Promise<CapturedReceipt> {
    let receipt: CapturedReceipt;
    try { receipt = await this.#options.projector.capture(arrival); }
    catch { throw new MqttCollectorError('CAPTURE_FAILURE', '原始到达未能获得持久捕获回执。'); }
    this.#assertReceipt(receipt, arrival.receivedAt, after);
    return receipt;
  }
  async #recoverStages(): Promise<void> {
    const stages = this.#state.entries().filter((entry): entry is IncomingStage => entry.kind === 'stage');
    if (!stages.length) return;
    const archive = this.#options.archive, through = archive.getWatermarks().capturedThrough;
    const byTransaction = new Map<string, IncomingStage>(), found = new Map<string, CapturedArrival>();
    let after = stages[0].after;
    for (const stage of stages) {
      if (byTransaction.has(stage.transactionId) || stage.after.captureDomainId !== through.captureDomainId
        || stage.after.captureEpoch !== through.captureEpoch || BigInt(stage.after.offset) > BigInt(through.offset)) {
        throw new MqttCollectorError('RECOVERY_UNPROVABLE', '暂存事务重复或原始捕获水位不能接续。');
      }
      byTransaction.set(stage.transactionId, stage);
      if (BigInt(stage.after.offset) < BigInt(after.offset)) after = stage.after;
    }
    // 对全部暂存共享一个固定上界和一套预算，不能每条记录各自无限扫描。
    if (after.offset !== through.offset) {
      const session = await archive.openCaptureSession(after, { through,
        maxPages: Math.min(this.#limits.maxRecoveryPages, archive.limits.maxPagesPerSession),
        maxReadBytes: Math.min(this.#limits.maxRecoveryBytes, archive.limits.maxReadBytesPerSession) });
      try {
        let cursor: string | null = session.pageCursor;
        while (cursor !== null) {
          const page = await archive.readCaptured(session.sessionId, cursor);
          for (const item of page.arrivals) {
            if (item.sourceId !== this.#options.source.logicalSourceId || item.sourceContractId !== this.#options.sourceContractId
              || item.transport.kind !== 'mqtt' || !item.transport.captureTransactionId) continue;
            const stage = byTransaction.get(item.transport.captureTransactionId);
            if (!stage) continue;
            this.#assertReceipt(item.receipt, stage.receivedAt, stage.after);
            if (found.has(stage.transactionId) || item.receivedAt !== stage.receivedAt || item.transport.topic !== stage.topic
              || item.transport.packetId !== String(stage.id) || item.transport.qos !== stage.qos || item.transport.retain !== stage.retain
              || item.transport.duplicate !== stage.duplicate || !Buffer.from(item.rawPayload).equals(Buffer.from(stage.payloadBase64, 'base64'))) {
              throw new MqttCollectorError('RECOVERY_UNPROVABLE', '捕获事务存在冲突或不唯一。');
            }
            found.set(stage.transactionId, item);
          }
          cursor = page.nextCursor;
        }
      } finally { await archive.closeReadSession(session.sessionId); }
    }
    for (const stage of stages) {
      const match = found.get(stage.transactionId)?.receipt;
      if (stage.receipt) {
        if (!match || canonical(match) !== canonical(stage.receipt)) {
          throw new MqttCollectorError('RECOVERY_UNPROVABLE', '暂存回执没有唯一对应的原始证据。');
        }
        continue;
      }
      const receipt = match ?? await this.#capture(this.#stageArrival(stage), stage.after);
      await this.#state.saveEntry({ ...stage, receipt }); this.#receipt(receipt);
    }
  }
  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    this.#stopPromise = (async () => {
      if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
      const ctx = this.#connection; if (ctx) { ctx.closed = true; ctx.reject(); }
      let failure = false;
      try { if (this.#startCalled) await this.#integrity('COLLECTOR_STOPPED'); } catch { failure = true; }
      if (ctx) {
        try { await ctx.client.endAsync(true); } catch { failure = true; }
        ctx.client.options.password = undefined; ctx.client.options.username = undefined; ctx.password?.fill(0); ctx.password = null;
        await Promise.allSettled([...ctx.operations]); if (this.#connection === ctx) this.#connection = null;
      }
      if (this.#pendingBlock) { try { await this.#pendingBlock; } catch { failure = true; } }
      if (!failure) {
        try { await this.#state.saveSession({ ...this.#state.session, online: false }); } catch { failure = true; }
      }
      try { await this.#state.close(); } catch { failure = true; }
      this.#setStatus(failure ? 'blocked' : 'stopped', failure ? 'STATE_FAILURE' : null);
      if (failure) throw new MqttCollectorError('STATE_FAILURE', 'MQTT 退出时未能证明缺口或释放自身状态锁。');
    })();
    return this.#stopPromise;
  }
}
