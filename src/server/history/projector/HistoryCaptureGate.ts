import type { MqttIntegrityEvent } from '../mqtt/types.ts';
import type { CapturedReceipt, DurableHistoryArchive, RawHistoryArrival } from '../storage/index.ts';
import { createHistoryControlArrival } from './HistoryInputNormalizer.ts';
import { HistoryProjector } from './HistoryProjector.ts';

export type HistoryBindingDecision = 'committed' | 'rejected' | 'unknown';
export class HistoryCaptureGateError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HistoryCaptureGateError'; }
}

/**
 * 基线准备前也可先持久记录上游；切换时冻结入队、等待旧投影并追赶原始日志。
 * 外层持久绑定事务返回 unknown 时阻断继续接收，不能擅自选旧或新投影。
 */
export class HistoryCaptureGate {
  readonly #archive: DurableHistoryArchive;
  readonly #contractId: string;
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  #projector: HistoryProjector | null = null;
  #transition: Promise<void> | null = null;
  #blocked = false;
  #closed = false;
  #count = 0;
  #bytes = 0;
  readonly #inflight = new Set<Promise<CapturedReceipt>>();

  constructor(options: { archive: DurableHistoryArchive; sourceContractId: string; maxQueuedRecords?: number; maxQueuedBytes?: number }) {
    this.#archive = options.archive; this.#contractId = options.sourceContractId;
    this.#maxRecords = options.maxQueuedRecords ?? 4096; this.#maxBytes = options.maxQueuedBytes ?? 64 * 1024 * 1024;
    if (!this.#contractId || !Number.isSafeInteger(this.#maxRecords) || this.#maxRecords < 1 || this.#maxRecords > 100_000
      || !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1 || this.#maxBytes > 1024 * 1024 * 1024) {
      throw new HistoryCaptureGateError('CAPTURE_CONFIGURATION', '捕获合同或队列预算无效。');
    }
  }
  get phase(): 'recording' | 'active' | 'transitioning' | 'blocked' | 'closed' {
    return this.#closed ? 'closed' : this.#blocked ? 'blocked' : this.#transition ? 'transitioning' : this.#projector ? 'active' : 'recording';
  }
  get archiveId(): string { return this.#archive.archiveId; }
  get sourceContractId(): string { return this.#contractId; }
  get projector(): HistoryProjector | null { return this.#projector; }

  /** 返回时原始证据已持久；独立的业务状态水位不能从此回执推断。 */
  capture(arrival: RawHistoryArrival): Promise<CapturedReceipt> {
    if (this.#closed || this.#blocked) return Promise.reject(new HistoryCaptureGateError('CAPTURE_UNAVAILABLE', '捕获器已停止或绑定结果待对账，不得确认输入。'));
    if (arrival.sourceContractId !== this.#contractId || !(arrival.rawPayload instanceof Uint8Array)) {
      return Promise.reject(new HistoryCaptureGateError('CAPTURE_CONTRACT', '输入不属于当前捕获合同。'));
    }
    const bytes = arrival.rawPayload.byteLength;
    if (this.#count + 1 > this.#maxRecords || this.#bytes + bytes > this.#maxBytes) {
      return Promise.reject(new HistoryCaptureGateError('CAPTURE_BACKPRESSURE', '捕获切换队列已满，不能确认或丢弃输入。'));
    }
    const owned = structuredClone(arrival), transition = this.#transition;
    this.#count += 1; this.#bytes += bytes;
    const operation = (async () => {
      if (transition) await transition;
      if (this.#closed || this.#blocked) throw new HistoryCaptureGateError('CAPTURE_UNAVAILABLE', '绑定结果未确认，输入不能获得持久确认。');
      return this.#projector ? this.#projector.capture(owned) : this.#archive.appendArrival(owned);
    })();
    this.#inflight.add(operation);
    void operation.then(() => this.#inflight.delete(operation), () => this.#inflight.delete(operation));
    return operation.finally(() => { this.#count -= 1; this.#bytes -= bytes; });
  }

  /**
   * factory 必须基于真实完整基线、固定版本和持久归档恢复候选；commit 必须核验服务端事务回执。
   * rejected 保留旧投影；unknown 强制停止并由外层按操作 ID 对账，不能静默回退。
   */
  async cutover(factory: () => Promise<HistoryProjector>, commit: (candidate: HistoryProjector) => Promise<HistoryBindingDecision>): Promise<HistoryProjector> {
    if (this.#closed || this.#blocked || this.#transition) throw new HistoryCaptureGateError('CAPTURE_UNAVAILABLE', '当前捕获器不可切换。');
    const earlier = [...this.#inflight];
    let release!: () => void;
    this.#transition = new Promise<void>(resolve => { release = resolve; });
    let candidate: HistoryProjector | null = null;
    try {
      await Promise.all(earlier);
      if (this.#projector) await this.#projector.drain();
      candidate = await factory();
      if (candidate.status.phase !== 'running' || candidate.versions.sourceContractId !== this.#contractId)
        throw new HistoryCaptureGateError('PROJECTION_NOT_READY', '候选投影未恢复完整连续状态或来源合同不匹配。');
      if (this.#closed) throw new HistoryCaptureGateError('CAPTURE_UNAVAILABLE', '捕获器已关闭，不能继续提交绑定。');
      let decision: HistoryBindingDecision;
      try { decision = await commit(candidate); } catch { decision = 'unknown'; }
      if (decision === 'unknown') {
        this.#blocked = true;
        throw new HistoryCaptureGateError('BINDING_OUTCOME_UNKNOWN', '绑定事务结果不确定，须按原操作标识对账后再恢复。');
      }
      if (decision !== 'committed') throw new HistoryCaptureGateError('BINDING_REJECTED', '绑定未提交，原有效投影保持不变。');
      const previous = this.#projector;
      this.#projector = candidate;
      if (previous && previous !== candidate) await previous.stop();
      return candidate;
    } catch (error) {
      if (candidate && candidate !== this.#projector) await candidate.stop();
      throw error;
    } finally {
      this.#transition = null; release();
    }
  }

  /** MQTT 接收器只有得到已持久化缺口证明才能继续建立或关闭会话。 */
  async recordMqttGap(event: Readonly<MqttIntegrityEvent>): Promise<{ durable: true }> {
    const scope = this.#archive.scope;
    if (event.sourceContractId !== this.#contractId || event.captureDomainId !== scope.captureDomainId || event.captureEpoch !== scope.captureEpoch
      || !event.requiresGap || !/^[A-Z0-9_]{1,80}$/u.test(event.code)) {
      throw new HistoryCaptureGateError('CAPTURE_CONTRACT', '缺口事件不属于当前来源合同或捕获纪元。');
    }
    const arrival = createHistoryControlArrival({ sourceContractId: this.#contractId, sourceId: event.sourceId,
      at: event.at, kind: 'gap', reason: `MQTT_${event.code}` });
    await this.capture(arrival);
    if (this.#projector) {
      await this.#projector.drain();
      if (this.#projector.status.phase !== 'gap') throw new HistoryCaptureGateError('GAP_NOT_COMMITTED', '缺口尚未进入持久投影，不能确认。');
    }
    return { durable: true };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#transition) await this.#transition;
    await Promise.allSettled([...this.#inflight]);
    if (this.#projector) await this.#projector.stop();
  }
}
