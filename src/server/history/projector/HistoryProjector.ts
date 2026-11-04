import {
  TwinStateKernel, TwinStateError, type AdapterInput, type DeepReadonly, type InputCursor, type JsonObject,
  type KernelInput, type StateAdapterRegistry, type StateReadView, type VersionManifest,
} from '../../../runtime/history/state/index.ts';
import {
  DurableHistoryArchive, type CapturedArrival, type CapturedReceipt, type HistoryReadSession,
  type RawHistoryArrival,
} from '../storage/index.ts';

/** 规范化器是服务端随投影版本安装的受控代码，不从来源数据或发布包执行脚本。 */
export type HistoryNormalizedInput =
  | { kind: 'adapter'; logicalTime: number; adapterId: string; adapterVersion: string; eventType: string;
      sourceEpoch: string; sourceEventId: string | null; sourceSequence: string | null; payload: JsonObject }
  | { kind: 'advance'; logicalTime: number }
  | { kind: 'gap'; logicalTime: number; reason: string };

export type HistoryNormalizer = {
  /** 相同已记录输入和前态必须产生相同输出；不得执行网络请求、读墙钟或改变状态。 */
  normalize(arrival: Readonly<CapturedArrival>, state: StateReadView): HistoryNormalizedInput;
};
export type ProjectorPhase = 'recovering' | 'running' | 'gap' | 'faulted' | 'stopped';
export type ProjectorStatus = {
  phase: ProjectorPhase;
  projectionId: string;
  capturedThrough: InputCursor;
  committedStateCursor: { projectionId: string; stateRevision: string };
  committedThroughTime: number;
  queuedRecords: number;
  queuedBytes: number;
  /** 不包含原始业务载荷、地址或凭据。 */
  errorCode: string | null;
};
export type HistoryProjectorOptions = {
  archive: DurableHistoryArchive;
  projectionId: string;
  versions: DeepReadonly<VersionManifest>;
  registry: StateAdapterRegistry;
  normalizer: HistoryNormalizer;
  maxQueuedRecords?: number;
  maxQueuedBytes?: number;
  onStatus?: (status: ProjectorStatus) => void;
};

export class HistoryProjectorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'HistoryProjectorError'; this.code = code; }
}
function requireProjector(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new HistoryProjectorError(code, message);
}
function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : 'PROJECTION_FAILED';
}

/**
 * 单投影单写者：原始到达持久化可分组并发，业务演算严格按捕获顺序串行。
 * 此类不创建来源连接、授权租约或基线，也不把本地持久回执冒充中台绑定提交。
 */
export class HistoryProjector {
  readonly #archive: DurableHistoryArchive;
  readonly #normalizer: HistoryNormalizer;
  readonly #projectionId: string;
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  readonly #onStatus?: (status: ProjectorStatus) => void;
  #kernel: TwinStateKernel;
  #phase: ProjectorPhase = 'recovering';
  #errorCode: string | null = null;
  #queuedRecords = 0;
  #queuedBytes = 0;
  #tail: Promise<void> = Promise.resolve();
  #stopping = false;

  private constructor(options: HistoryProjectorOptions, kernel: TwinStateKernel) {
    this.#archive = options.archive; this.#normalizer = options.normalizer;
    this.#projectionId = options.projectionId; this.#kernel = kernel; this.#onStatus = options.onStatus;
    this.#maxRecords = options.maxQueuedRecords ?? 4096;
    this.#maxBytes = options.maxQueuedBytes ?? 64 * 1024 * 1024;
    requireProjector(Number.isSafeInteger(this.#maxRecords) && this.#maxRecords >= 1 && this.#maxRecords <= 100_000
      && Number.isSafeInteger(this.#maxBytes) && this.#maxBytes >= 1 && this.#maxBytes <= 1024 * 1024 * 1024,
    'PROJECTOR_BUDGET', '投影接收队列预算无效。');
  }

  /** 恢复先验证已提交全态，再按固定 capturedThrough 追赶原始证据；此时尚不接受新输入。 */
  static async recover(options: HistoryProjectorOptions, signal?: AbortSignal): Promise<HistoryProjector> {
    const recovered = await options.archive.recoverProjection(options.projectionId, signal);
    const kernel = TwinStateKernel.fromCheckpoint(recovered.checkpoint, options.registry, { mode: 'projector', expectedVersions: options.versions });
    const worker = new HistoryProjector(options, kernel);
    if (kernel.metadata.continuity.status === 'gap') { worker.#phase = 'gap'; worker.#notify(); return worker; }
    let session: Awaited<ReturnType<DurableHistoryArchive['openCaptureSession']>> | null = null;
    try {
      session = await worker.#archive.openCaptureSession(recovered.unprocessedAfter, { through: recovered.capturedThrough });
      let cursor: string | null = session.pageCursor;
      while (cursor !== null && worker.#phase === 'recovering') {
        signal?.throwIfAborted();
        const page = await worker.#archive.readCaptured(session.sessionId, cursor, { signal });
        for (const arrival of page.arrivals) {
          signal?.throwIfAborted();
          await worker.#project(arrival);
          if ((worker.#phase as ProjectorPhase) === 'gap') break;
        }
        cursor = page.nextCursor;
      }
      if (worker.#phase === 'recovering') worker.#phase = 'running';
      worker.#notify(); return worker;
    } catch (error) {
      worker.#phase = 'faulted'; worker.#errorCode = errorCode(error); worker.#notify(); throw error;
    } finally { if (session) await worker.#archive.closeReadSession(session.sessionId); }
  }

  get archiveId(): string { return this.#archive.archiveId; }
  get sourceContractId(): string { return this.#kernel.view.logic.versions.sourceContractId; }
  get versions(): DeepReadonly<VersionManifest> { return this.#kernel.view.logic.versions; }

  get status(): ProjectorStatus {
    const watermarks = this.#archive.getWatermarks();
    return { phase: this.#phase, projectionId: this.#projectionId, capturedThrough: watermarks.capturedThrough,
      committedStateCursor: { ...this.#kernel.metadata.cursor }, committedThroughTime: this.#kernel.metadata.logicalTime,
      queuedRecords: this.#queuedRecords, queuedBytes: this.#queuedBytes, errorCode: this.#errorCode };
  }
  #notify(): void {
    try { this.#onStatus?.(this.status); } catch { /* 观察者故障不能改变持久提交结果。 */ }
  }

  /** 返回仅代表原始证据已 fsync；调用方可据此 ACK，业务投影水位另行读取。 */
  capture(value: RawHistoryArrival): Promise<CapturedReceipt> {
    if (this.#stopping || !['running', 'gap'].includes(this.#phase)) return Promise.reject(new HistoryProjectorError('PROJECTOR_UNAVAILABLE', '投影恢复中或已停止，不能确认新到达。'));
    if (!(value.rawPayload instanceof Uint8Array)) return Promise.reject(new HistoryProjectorError('ARRIVAL_FORMAT', '原始载荷必须是字节数组。'));
    const bytes = value.rawPayload.byteLength;
    if (this.#queuedRecords + 1 > this.#maxRecords || this.#queuedBytes + bytes > this.#maxBytes) {
      return Promise.reject(new HistoryProjectorError('PROJECTOR_BACKPRESSURE', '待投影输入达到预算；不得确认或丢弃本次到达。'));
    }
    // 复制接收缓冲，避免 MQTT 客户端复用字节数组后改变已记录证据和确定性输入。
    const input = structuredClone(value);
    this.#queuedRecords += 1; this.#queuedBytes += bytes;
    const receipt = this.#archive.appendArrival(input);
    const task = this.#tail.then(async () => {
      const captured = await receipt;
      if (this.#phase === 'running') await this.#project({ ...input, receipt: captured });
    });
    this.#tail = task.catch(error => {
      this.#phase = 'faulted'; this.#errorCode = errorCode(error); this.#notify();
    }).finally(() => { this.#queuedRecords -= 1; this.#queuedBytes -= bytes; });
    return receipt;
  }

  async #project(arrival: CapturedArrival): Promise<void> {
    const state = this.#kernel.metadata;
    let normalized: HistoryNormalizedInput;
    if (arrival.sourceContractId !== this.#kernel.view.logic.versions.sourceContractId) {
      normalized = { kind: 'gap', logicalTime: Math.max(state.logicalTime, arrival.receipt.receivedAt), reason: '原始输入不属于当前冻结来源合同。' };
    } else {
      try { normalized = this.#normalizer.normalize(arrival, this.#kernel.view); }
      catch { normalized = { kind: 'gap', logicalTime: Math.max(state.logicalTime, arrival.receipt.receivedAt), reason: '原始输入无法按冻结来源合同规范化。' }; }
    }
    requireProjector(Number.isSafeInteger(normalized.logicalTime) && normalized.logicalTime >= state.logicalTime,
      'LOGICAL_TIME', '输入的逻辑时间无效或倒退，不能改写已提交状态。');
    const common = { schemaVersion: '1' as const, id: `capture:${arrival.receipt.inputCursor.offset}`,
      projectionId: this.#projectionId, versions: this.#kernel.view.logic.versions,
      cursor: arrival.receipt.inputCursor, logicalTime: normalized.logicalTime };
    let input: DeepReadonly<KernelInput>;
    if (normalized.kind === 'adapter') input = { ...common, ...normalized, sourceId: arrival.sourceId } as AdapterInput;
    else if (normalized.kind === 'advance') input = { ...common, kind: 'advance' };
    else input = { ...common, kind: 'gap', reason: normalized.reason };

    let candidate;
    try { candidate = this.#kernel.prepareInput(input); }
    catch (error) {
      // reducer/schema 在准备阶段失败时没有安装半态；该事实边界显式标记缺口，不能继续演算。
      if (normalized.kind === 'gap') throw error;
      // 只透传封闭的安全错误码，区分缺失的是原始前态、去重前态、设备纪元、排序证据还是去重容量；不携带原始 payload。
      const SAFE_CODES = ['LOGISTICS_RAW_BASELINE', 'LOGISTICS_DEDUP_BASELINE', 'DEVICE_EPOCH', 'LOGISTICS_ORDER_AMBIGUOUS', 'LOGISTICS_DEDUP_CAPACITY'];
      const code = error instanceof TwinStateError && SAFE_CODES.includes(error.code) ? error.code : 'PROJECTION_CONTRACT';
      input = { ...common, kind: 'gap', reason: `输入或业务状态不符合已冻结的投影合同（${code}）。` };
      candidate = this.#kernel.prepareInput(input);
    }
    const proof = await this.#archive.prepareCommit({ input, batch: candidate.batch });
    await this.#archive.commitPrepared(proof);
    // 之后若内存提交失败，持久结果可能已成功；外层必须重启并恢复，不能重复归约。
    candidate.commit();
    if (input.kind === 'gap') { this.#phase = 'gap'; this.#errorCode = 'CONTINUITY_GAP'; }
    this.#notify();
  }

  async checkpoint(): Promise<void> {
    await this.#tail;
    requireProjector(!this.#stopping && (this.#phase === 'running' || this.#phase === 'gap'), 'PROJECTOR_UNAVAILABLE', '当前投影不能建立检查点。');
    await this.#archive.putCheckpoint(this.#kernel.checkpoint());
  }
  async openHistory(request: Parameters<DurableHistoryArchive['openReadSession']>[0]): Promise<HistoryReadSession> {
    requireProjector(request.projectionId === this.#projectionId, 'PROJECTION_MISMATCH', '查询投影与当前协调者不一致。');
    return this.#archive.openReadSession(request);
  }
  async drain(): Promise<void> {
    await this.#tail;
    requireProjector(this.#phase !== 'faulted', this.#errorCode ?? 'PROJECTION_FAILED', '业务投影未能完成持久提交，必须先恢复。');
  }
  async stop(): Promise<void> { this.#stopping = true; await this.#tail; this.#phase = 'stopped'; this.#notify(); }
}
