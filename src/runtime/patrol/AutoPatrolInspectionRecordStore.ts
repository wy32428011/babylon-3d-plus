import type { Vector3Data } from '../../editor/model/math';

export type AutoPatrolInspectionStatus = 'running' | 'completed' | 'stopped' | 'emergency-stopped' | 'failed';

export type AutoPatrolInspectionTrigger =
  | 'region-enter'
  | 'region-leave'
  | 'distance'
  | 'waypoint'
  | 'dwell'
  | 'manual';

export type AutoPatrolTrajectorySample = {
  recordedAtMs: number;
  position: Vector3Data;
  rotation: Vector3Data;
};

export type AutoPatrolInspectionScreenshot = {
  id: string;
  capturedAtMs: number;
  localUrl: string;
  remoteUrl: string | null;
};

export type AutoPatrolInspectionBusinessValue = string | number | boolean | null;

export type AutoPatrolInspectionEventRecord = {
  id: string;
  eventDefinitionId: string;
  name: string;
  trigger: AutoPatrolInspectionTrigger;
  occurredAtMs: number;
  targetEntityId: string | null;
  position: Vector3Data;
  businessData: Record<string, AutoPatrolInspectionBusinessValue>;
  anomaly: boolean;
  screenshot?: AutoPatrolInspectionScreenshot;
};

export type AutoPatrolInspectionRecord = {
  schemaVersion: 1;
  scopeId: string;
  taskId: string;
  routeId: string;
  routeName: string | null;
  operator: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  status: AutoPatrolInspectionStatus;
  trajectory: AutoPatrolTrajectorySample[];
  events: AutoPatrolInspectionEventRecord[];
  screenshots: AutoPatrolInspectionScreenshot[];
  anomalyEventIds: string[];
};

export type AutoPatrolInspectionOutboxItem = {
  id: string;
  scopeId: string;
  taskId: string;
  kind: 'event' | 'record';
  eventId: string | null;
  createdAtMs: number;
  order: number;
  attempts: number;
  nextAttemptAtMs: number;
  lastError: string | null;
};

export type AutoPatrolInspectionReporter = {
  reportEvent: (
    record: AutoPatrolInspectionRecord,
    event: AutoPatrolInspectionEventRecord,
  ) => Promise<void>;
  reportRecord: (record: AutoPatrolInspectionRecord) => Promise<void>;
};

export type AutoPatrolInspectionBackend = {
  saveRecord: (
    record: AutoPatrolInspectionRecord,
    queuedItems?: readonly AutoPatrolInspectionOutboxItem[],
    deletedTaskIds?: readonly string[],
  ) => Promise<void>;
  getRecord: (taskId: string) => Promise<AutoPatrolInspectionRecord | null>;
  listRecords: () => Promise<AutoPatrolInspectionRecord[]>;
  listOutbox: () => Promise<AutoPatrolInspectionOutboxItem[]>;
  putOutbox: (item: AutoPatrolInspectionOutboxItem) => Promise<void>;
  deleteOutbox: (id: string, expectedOrder: number) => Promise<void>;
  deleteRecord: (taskId: string) => Promise<void>;
  close?: () => void;
};

type OnlineEventSource = {
  addEventListener: (type: 'online', listener: () => void) => void;
  removeEventListener: (type: 'online', listener: () => void) => void;
};

export type AutoPatrolInspectionRecordStoreOptions = {
  backend?: AutoPatrolInspectionBackend;
  reporter?: AutoPatrolInspectionReporter;
  onlineEventSource?: OnlineEventSource | null;
  now?: () => number;
  idFactory?: () => string;
  scopeId?: string;
  limits?: Partial<AutoPatrolInspectionRecordStoreLimits>;
};

export type AutoPatrolInspectionRecordStoreLimits = {
  maxTrajectorySamples: number;
  maxEventsPerRecord: number;
  maxScreenshotsPerRecord: number;
  maxBusinessDataFields: number;
  maxBusinessStringLength: number;
  maxScreenshotDataUrlLength: number;
  maxRecordApproxBytes: number;
  maxRecordsPerScope: number;
};

export type StartAutoPatrolInspectionInput = {
  taskId?: string;
  routeId: string;
  routeName?: string | null;
  operator?: string | null;
  startedAtMs?: number;
};

export type CompleteAutoPatrolInspectionInput = {
  status: Exclude<AutoPatrolInspectionStatus, 'running'>;
  endedAtMs?: number;
};

export type AppendAutoPatrolInspectionEventOptions = {
  queueForReport?: boolean;
};

export type FlushAutoPatrolInspectionOutboxResult = {
  sent: number;
  remaining: number;
};

const MAX_RETRY_DELAY_MS = 60_000;
const RECORD_COMPLETION_RESERVE_BYTES = 128;
const DEFAULT_SCOPE_ID = 'default';
const DEFAULT_LIMITS: Readonly<AutoPatrolInspectionRecordStoreLimits> = {
  maxTrajectorySamples: 100_000,
  maxEventsPerRecord: 10_000,
  maxScreenshotsPerRecord: 50,
  maxBusinessDataFields: 64,
  maxBusinessStringLength: 4_096,
  maxScreenshotDataUrlLength: 8 * 1024 * 1024,
  maxRecordApproxBytes: 64 * 1024 * 1024,
  maxRecordsPerScope: 500,
};
const INSPECTION_TRIGGER_SET = new Set<AutoPatrolInspectionTrigger>([
  'region-enter',
  'region-leave',
  'distance',
  'waypoint',
  'dwell',
  'manual',
]);

/**
 * 保存一次巡检的完整历史，并用持久化 Outbox 保证增量事件和结束全量记录可补报。
 * 所有记录修改串行执行，调用方可以从逐帧回调中直接提交而不会相互覆盖。
 */
export class AutoPatrolInspectionRecordStore {
  private readonly backend: AutoPatrolInspectionBackend;
  private readonly reporter: AutoPatrolInspectionReporter | null;
  private readonly onlineEventSource: OnlineEventSource | null;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly limits: AutoPatrolInspectionRecordStoreLimits;
  private readonly handleOnline = (): void => { this.requestFlush(true); };
  private readonly activeTaskScopes = new Map<string, string>();
  private operationTail: Promise<void> = Promise.resolve();
  private flushPromise: Promise<FlushAutoPatrolInspectionOutboxResult> | null = null;
  private flushRequested = false;
  private forceFlushRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private outboxSequence = 0;
  private readonly recordApproxBytes = new Map<string, number>();
  private scopeId: string;
  private scopeRevision = 0;
  private disposed = false;

  constructor(options: AutoPatrolInspectionRecordStoreOptions = {}) {
    this.backend = options.backend ?? new IndexedDbAutoPatrolInspectionBackend();
    this.reporter = options.reporter ?? null;
    this.onlineEventSource = options.onlineEventSource === undefined
      ? resolveGlobalOnlineEventSource()
      : options.onlineEventSource;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? createUuid;
    this.scopeId = requireScopeIdentifier(options.scopeId ?? DEFAULT_SCOPE_ID);
    this.limits = resolveStoreLimits(options.limits);
    this.onlineEventSource?.addEventListener('online', this.handleOnline);
    if (this.reporter) this.requestFlush();
  }

  setScope(scopeId: string): void {
    this.assertUsable();
    const normalized = requireScopeIdentifier(scopeId);
    if (normalized === this.scopeId) return;
    this.scopeId = normalized;
    this.scopeRevision += 1;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.reporter) this.requestFlush();
  }

  getScopeId(): string {
    this.assertUsable();
    return this.scopeId;
  }

  startInspection(input: StartAutoPatrolInspectionInput): Promise<AutoPatrolInspectionRecord> {
    return this.startInspectionForScope(this.scopeId, input);
  }

  startInspectionForScope(
    scopeId: string,
    input: StartAutoPatrolInspectionInput,
  ): Promise<AutoPatrolInspectionRecord> {
    const normalizedScopeId = requireScopeIdentifier(scopeId);
    return this.enqueue(async () => {
      this.assertUsable();
      const taskId = requireIdentifier(input.taskId ?? this.idFactory(), '任务 ID');
      const routeId = requireIdentifier(input.routeId, '路线 ID');
      const startedAtMs = finiteTimestamp(input.startedAtMs ?? this.now(), '开始时间');
      const record: AutoPatrolInspectionRecord = {
        schemaVersion: 1,
        scopeId: normalizedScopeId,
        taskId,
        routeId,
        routeName: optionalText(input.routeName),
        operator: optionalText(input.operator),
        startedAtMs,
        endedAtMs: null,
        durationMs: null,
        status: 'running',
        trajectory: [],
        events: [],
        screenshots: [],
        anomalyEventIds: [],
      };
      const approximateBytes = this.assertRecordWithinLimits(record);
      if (await this.backend.getRecord(taskId)) throw new Error(`巡检任务 ${taskId} 已存在。`);
      const deletedTaskIds = await this.planHistoryCapacity(normalizedScopeId);
      await this.backend.saveRecord(record, [], deletedTaskIds);
      for (const deletedTaskId of deletedTaskIds) this.recordApproxBytes.delete(deletedTaskId);
      this.recordApproxBytes.set(taskId, approximateBytes);
      this.activeTaskScopes.set(taskId, normalizedScopeId);
      return clone(record);
    });
  }

  appendTrajectory(taskId: string, sample: AutoPatrolTrajectorySample): Promise<void> {
    return this.appendTrajectoryBatch(taskId, [sample]);
  }

  appendTrajectoryBatch(taskId: string, samples: readonly AutoPatrolTrajectorySample[]): Promise<void> {
    if (samples.length === 0) return Promise.resolve();
    return this.enqueue(async () => {
      const record = await this.requireRunningRecord(taskId);
      const normalized = samples.map(normalizeTrajectorySample);
      if (normalized.some((sample) => sample.recordedAtMs < record.startedAtMs)) {
        throw new Error('轨迹时间不能早于巡检开始时间。');
      }
      const existingTimes = new Set(record.trajectory.map((sample) => sample.recordedAtMs));
      const additions: AutoPatrolTrajectorySample[] = [];
      for (const sample of normalized) {
        if (existingTimes.has(sample.recordedAtMs)) continue;
        existingTimes.add(sample.recordedAtMs);
        additions.push(sample);
      }
      if (record.trajectory.length + additions.length > this.limits.maxTrajectorySamples) {
        throw new Error(`巡检轨迹样本超过 ${this.limits.maxTrajectorySamples} 条上限。`);
      }
      if (additions.length === 0) return;
      const approximateBytes = this.resolveRecordApproxBytes(record)
        + estimateTrajectoryAdditionBytes(record.trajectory.length, additions);
      record.trajectory.push(...additions);
      record.trajectory.sort((left, right) => left.recordedAtMs - right.recordedAtMs);
      this.assertRecordWithinLimits(record, approximateBytes);
      await this.backend.saveRecord(record);
      this.recordApproxBytes.set(record.taskId, approximateBytes);
    });
  }

  appendEvent(
    taskId: string,
    event: AutoPatrolInspectionEventRecord,
    options: AppendAutoPatrolInspectionEventOptions = {},
  ): Promise<void> {
    const queueForReport = options.queueForReport ?? true;
    const persisted = this.enqueue(async () => {
      const record = await this.requireRunningRecord(taskId);
      const normalized = normalizeEvent(event, this.limits);
      if (normalized.occurredAtMs < record.startedAtMs) throw new Error('事件时间不能早于巡检开始时间。');
      const existing = record.events.find((item) => item.id === normalized.id);
      if (existing) {
        if (!normalized.screenshot || existing.screenshot?.localUrl === normalized.screenshot.localUrl) return;
        existing.screenshot = clone(normalized.screenshot);
        const existingScreenshot = record.screenshots.find((item) => item.id === normalized.screenshot!.id);
        if (existingScreenshot) {
          Object.assign(existingScreenshot, clone(normalized.screenshot));
        } else {
          if (record.screenshots.length >= this.limits.maxScreenshotsPerRecord) {
            throw new Error(`巡检截图超过 ${this.limits.maxScreenshotsPerRecord} 张上限。`);
          }
          record.screenshots.push(clone(normalized.screenshot));
        }
        const queuedItems = queueForReport
          ? [this.createOutboxItem(record, 'event', normalized.id)]
          : [];
        const approximateBytes = this.assertRecordWithinLimits(record);
        await this.backend.saveRecord(record, queuedItems);
        this.recordApproxBytes.set(record.taskId, approximateBytes);
        return;
      }
      if (record.events.length >= this.limits.maxEventsPerRecord) {
        throw new Error(`巡检事件超过 ${this.limits.maxEventsPerRecord} 条上限。`);
      }
      record.events.push(normalized);
      if (normalized.screenshot && !record.screenshots.some((item) => item.id === normalized.screenshot!.id)) {
        if (record.screenshots.length >= this.limits.maxScreenshotsPerRecord) {
          throw new Error(`巡检截图超过 ${this.limits.maxScreenshotsPerRecord} 张上限。`);
        }
        record.screenshots.push(clone(normalized.screenshot));
      }
      if (normalized.anomaly) record.anomalyEventIds.push(normalized.id);
      const queuedItems = queueForReport
        ? [this.createOutboxItem(record, 'event', normalized.id)]
        : [];
      const approximateBytes = this.assertRecordWithinLimits(record);
      await this.backend.saveRecord(record, queuedItems);
      this.recordApproxBytes.set(record.taskId, approximateBytes);
    });
    return persisted.then(() => { this.requestFlush(); });
  }

  completeInspection(taskId: string, input: CompleteAutoPatrolInspectionInput): Promise<AutoPatrolInspectionRecord> {
    const persisted = this.enqueue(async () => {
      const record = await this.requireRunningRecord(taskId);
      const endedAtMs = finiteTimestamp(input.endedAtMs ?? this.now(), '结束时间');
      if (endedAtMs < record.startedAtMs) throw new Error('结束时间不能早于巡检开始时间。');
      record.status = input.status;
      record.endedAtMs = endedAtMs;
      record.durationMs = Math.max(0, endedAtMs - record.startedAtMs);
      const outboxItem = this.createOutboxItem(record, 'record', null);
      const approximateBytes = this.assertRecordWithinLimits(record);
      await this.backend.saveRecord(record, [outboxItem]);
      this.recordApproxBytes.set(record.taskId, approximateBytes);
      this.activeTaskScopes.delete(record.taskId);
      return clone(record);
    });
    return persisted.then((record) => {
      this.requestFlush();
      return record;
    });
  }

  async getRecord(taskId: string): Promise<AutoPatrolInspectionRecord | null> {
    return this.getRecordForScope(taskId, this.scopeId);
  }

  async getRecordForScope(taskId: string, scopeId: string): Promise<AutoPatrolInspectionRecord | null> {
    this.assertUsable();
    const normalizedTaskId = requireIdentifier(taskId, '任务 ID');
    const normalizedScopeId = requireScopeIdentifier(scopeId);
    const record = await this.backend.getRecord(normalizedTaskId);
    return record?.scopeId === normalizedScopeId ? clone(record) : null;
  }

  async getTaskRecord(taskId: string): Promise<AutoPatrolInspectionRecord | null> {
    this.assertUsable();
    const normalizedTaskId = requireIdentifier(taskId, '任务 ID');
    const expectedScopeId = this.activeTaskScopes.get(normalizedTaskId) ?? this.scopeId;
    const record = await this.backend.getRecord(normalizedTaskId);
    return record?.scopeId === expectedScopeId ? clone(record) : null;
  }

  async listRecords(): Promise<AutoPatrolInspectionRecord[]> {
    this.assertUsable();
    const scopeId = this.scopeId;
    const records = await this.backend.listRecords();
    return records
      .filter((record) => record.scopeId === scopeId)
      .sort((left, right) => right.startedAtMs - left.startedAtMs)
      .map(clone);
  }

  flushOutbox(options: { force?: boolean } = {}): Promise<FlushAutoPatrolInspectionOutboxResult> {
    if (!this.reporter) return this.countPendingOutbox();
    this.flushRequested = true;
    this.forceFlushRequested ||= Boolean(options.force);
    if (!this.flushPromise) {
      this.flushPromise = this.drainFlushRequests().finally(() => {
        this.flushPromise = null;
      });
    }
    return this.flushPromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.onlineEventSource?.removeEventListener('online', this.handleOnline);
    this.recordApproxBytes.clear();
    this.backend.close?.();
  }

  private async performFlush(force: boolean): Promise<FlushAutoPatrolInspectionOutboxResult> {
    let sent = 0;
    const scopeId = this.scopeId;
    const scopeRevision = this.scopeRevision;
    while (true) {
      if (scopeRevision !== this.scopeRevision) break;
      const now = this.now();
      const scopedItems = await this.listScopedOutbox(scopeId);
      if (scopeRevision !== this.scopeRevision) break;
      const item = scopedItems[0];
      if (!item) break;
      if (!force && item.nextAttemptAtMs > now) {
        this.scheduleRetry(item.nextAttemptAtMs);
        break;
      }
      try {
        const record = await this.backend.getRecord(item.taskId);
        if (scopeRevision !== this.scopeRevision) break;
        if (!record || record.scopeId !== scopeId) throw new Error(`巡检任务 ${item.taskId} 不存在。`);
        if (item.kind === 'event') {
          const event = record.events.find((candidate) => candidate.id === item.eventId);
          if (!event) throw new Error(`巡检事件 ${item.eventId ?? ''} 不存在。`);
          await this.reporter!.reportEvent(clone(record), clone(event));
        } else {
          await this.reporter!.reportRecord(clone(record));
        }
        // 上报期间同一事件可能补写截图；只删除本次实际发送的 Outbox 版本。
        await this.backend.deleteOutbox(item.id, item.order);
        sent += 1;
      } catch (error) {
        const attempts = item.attempts + 1;
        const nextAttemptAtMs = now + Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(10, attempts - 1));
        await this.backend.putOutbox({
          ...item,
          attempts,
          nextAttemptAtMs,
          lastError: getErrorMessage(error),
        });
        this.scheduleRetry(nextAttemptAtMs);
        // 事件增量必须先于任务全量记录，失败后停止本轮以维持上报顺序。
        break;
      }
    }
    const remaining = (await this.listScopedOutbox(scopeId)).length;
    return { sent, remaining };
  }

  private async drainFlushRequests(): Promise<FlushAutoPatrolInspectionOutboxResult> {
    let sent = 0;
    let remaining = 0;
    while (this.flushRequested) {
      const force = this.forceFlushRequested;
      this.flushRequested = false;
      this.forceFlushRequested = false;
      const result = await this.performFlush(force);
      sent += result.sent;
      remaining = result.remaining;
    }
    return { sent, remaining };
  }

  private async countPendingOutbox(): Promise<FlushAutoPatrolInspectionOutboxResult> {
    return { sent: 0, remaining: (await this.listScopedOutbox(this.scopeId)).length };
  }

  private requestFlush(force = false): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.flushOutbox({ force }).catch(() => undefined);
  }

  private scheduleRetry(nextAttemptAtMs: number): void {
    if (this.disposed || !this.reporter) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    const delayMs = Math.max(0, nextAttemptAtMs - this.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.requestFlush();
    }, delayMs);
    const timer = this.retryTimer as ReturnType<typeof setTimeout> & { unref?: () => void };
    timer.unref?.();
  }

  private createOutboxItem(
    record: AutoPatrolInspectionRecord,
    kind: AutoPatrolInspectionOutboxItem['kind'],
    eventId: string | null,
  ): AutoPatrolInspectionOutboxItem {
    const createdAtMs = this.now();
    this.outboxSequence = (this.outboxSequence + 1) % 1_000;
    return {
      id: JSON.stringify([record.scopeId, record.taskId, kind, eventId]),
      scopeId: record.scopeId,
      taskId: record.taskId,
      kind,
      eventId,
      createdAtMs,
      order: createdAtMs * 1_000 + this.outboxSequence,
      attempts: 0,
      nextAttemptAtMs: createdAtMs,
      lastError: null,
    };
  }

  private async requireRunningRecord(taskId: string): Promise<AutoPatrolInspectionRecord> {
    this.assertUsable();
    const normalizedTaskId = requireIdentifier(taskId, '任务 ID');
    const record = await this.backend.getRecord(normalizedTaskId);
    const expectedScopeId = this.activeTaskScopes.get(normalizedTaskId) ?? this.scopeId;
    if (!record || record.scopeId !== expectedScopeId) throw new Error(`巡检任务 ${normalizedTaskId} 不存在。`);
    if (record.status !== 'running') throw new Error(`巡检任务 ${normalizedTaskId} 已经结束。`);
    return record;
  }

  private async planHistoryCapacity(scopeId: string): Promise<string[]> {
    const records = (await this.backend.listRecords()).filter((record) => record.scopeId === scopeId);
    if (records.length < this.limits.maxRecordsPerScope) return [];
    const pendingTaskIds = new Set(
      (await this.listScopedOutbox(scopeId)).map((item) => item.taskId),
    );
    const removable = records
      .filter((record) => record.status !== 'running' && !pendingTaskIds.has(record.taskId))
      .sort((left, right) => left.startedAtMs - right.startedAtMs || left.taskId.localeCompare(right.taskId));
    const deletedTaskIds: string[] = [];
    let remaining = records.length;
    for (const record of removable) {
      if (remaining < this.limits.maxRecordsPerScope) break;
      deletedTaskIds.push(record.taskId);
      remaining -= 1;
    }
    if (remaining >= this.limits.maxRecordsPerScope) {
      throw new Error(
        `当前场景巡检历史已达 ${this.limits.maxRecordsPerScope} 条上限，`
        + '且现有记录仍在运行或等待补报。',
      );
    }
    return deletedTaskIds;
  }

  private async listScopedOutbox(scopeId: string): Promise<AutoPatrolInspectionOutboxItem[]> {
    return (await this.backend.listOutbox())
      .filter((item) => item.scopeId === scopeId)
      .sort(compareOutboxItems);
  }

  private assertRecordWithinLimits(
    record: AutoPatrolInspectionRecord,
    approximateBytes = estimateRecordBytes(record),
  ): number {
    if (record.trajectory.length > this.limits.maxTrajectorySamples) {
      throw new Error(`巡检轨迹样本超过 ${this.limits.maxTrajectorySamples} 条上限。`);
    }
    if (record.events.length > this.limits.maxEventsPerRecord) {
      throw new Error(`巡检事件超过 ${this.limits.maxEventsPerRecord} 条上限。`);
    }
    if (record.screenshots.length > this.limits.maxScreenshotsPerRecord) {
      throw new Error(`巡检截图超过 ${this.limits.maxScreenshotsPerRecord} 张上限。`);
    }
    const requiredBytes = approximateBytes
      + (record.status === 'running' ? RECORD_COMPLETION_RESERVE_BYTES : 0);
    if (requiredBytes > this.limits.maxRecordApproxBytes) {
      throw new Error(`单条巡检记录超过 ${this.limits.maxRecordApproxBytes} 字节上限。`);
    }
    return approximateBytes;
  }

  private resolveRecordApproxBytes(record: AutoPatrolInspectionRecord): number {
    return this.recordApproxBytes.get(record.taskId) ?? estimateRecordBytes(record);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('巡检记录存储已释放。');
  }
}

/** 用于单元测试或无 IndexedDB 的宿主环境。 */
export class MemoryAutoPatrolInspectionBackend implements AutoPatrolInspectionBackend {
  private readonly records = new Map<string, AutoPatrolInspectionRecord>();
  private readonly outbox = new Map<string, AutoPatrolInspectionOutboxItem>();

  async saveRecord(
    record: AutoPatrolInspectionRecord,
    queuedItems: readonly AutoPatrolInspectionOutboxItem[] = [],
    deletedTaskIds: readonly string[] = [],
  ): Promise<void> {
    for (const taskId of deletedTaskIds) this.records.delete(taskId);
    this.records.set(record.taskId, clone(record));
    for (const item of queuedItems) this.outbox.set(item.id, clone(item));
  }

  async getRecord(taskId: string): Promise<AutoPatrolInspectionRecord | null> {
    const record = this.records.get(taskId);
    return record ? clone(record) : null;
  }

  async listRecords(): Promise<AutoPatrolInspectionRecord[]> {
    return [...this.records.values()].map(clone);
  }

  async listOutbox(): Promise<AutoPatrolInspectionOutboxItem[]> {
    return [...this.outbox.values()].map(clone).sort(compareOutboxItems);
  }

  async putOutbox(item: AutoPatrolInspectionOutboxItem): Promise<void> {
    this.outbox.set(item.id, clone(item));
  }

  async deleteOutbox(id: string, expectedOrder: number): Promise<void> {
    const current = this.outbox.get(id);
    if (current?.order === expectedOrder) this.outbox.delete(id);
  }

  async deleteRecord(taskId: string): Promise<void> {
    this.records.delete(taskId);
  }
}

const DATABASE_NAME = 'zending-auto-patrol-inspection';
const DATABASE_VERSION = 1;
const RECORD_STORE_NAME = 'records';
const OUTBOX_STORE_NAME = 'outbox';

/** 浏览器生产环境使用的 IndexedDB 后端。 */
export class IndexedDbAutoPatrolInspectionBackend implements AutoPatrolInspectionBackend {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private readonly databaseName: string;
  private readonly indexedDb: IDBFactory | undefined;

  constructor(
    databaseName = DATABASE_NAME,
    indexedDb: IDBFactory | undefined = globalThis.indexedDB,
  ) {
    this.databaseName = databaseName;
    this.indexedDb = indexedDb;
  }

  async saveRecord(
    record: AutoPatrolInspectionRecord,
    queuedItems: readonly AutoPatrolInspectionOutboxItem[] = [],
    deletedTaskIds: readonly string[] = [],
  ): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction([RECORD_STORE_NAME, OUTBOX_STORE_NAME], 'readwrite');
    const completion = transactionDone(transaction);
    const records = transaction.objectStore(RECORD_STORE_NAME);
    records.put(clone(record));
    for (const taskId of deletedTaskIds) records.delete(taskId);
    const outbox = transaction.objectStore(OUTBOX_STORE_NAME);
    for (const item of queuedItems) outbox.put(clone(item));
    await completion;
  }

  async getRecord(taskId: string): Promise<AutoPatrolInspectionRecord | null> {
    const database = await this.getDatabase();
    const transaction = database.transaction(RECORD_STORE_NAME, 'readonly');
    const completion = transactionDone(transaction);
    const record = await requestResult<AutoPatrolInspectionRecord | undefined>(
      transaction.objectStore(RECORD_STORE_NAME).get(taskId),
    );
    await completion;
    return record ? clone(record) : null;
  }

  async listRecords(): Promise<AutoPatrolInspectionRecord[]> {
    const database = await this.getDatabase();
    const transaction = database.transaction(RECORD_STORE_NAME, 'readonly');
    const completion = transactionDone(transaction);
    const records = await requestResult<AutoPatrolInspectionRecord[]>(
      transaction.objectStore(RECORD_STORE_NAME).getAll(),
    );
    await completion;
    return records.map(clone);
  }

  async listOutbox(): Promise<AutoPatrolInspectionOutboxItem[]> {
    const database = await this.getDatabase();
    const transaction = database.transaction(OUTBOX_STORE_NAME, 'readonly');
    const completion = transactionDone(transaction);
    const items = await requestResult<AutoPatrolInspectionOutboxItem[]>(
      transaction.objectStore(OUTBOX_STORE_NAME).getAll(),
    );
    await completion;
    return items.map(clone).sort(compareOutboxItems);
  }

  async putOutbox(item: AutoPatrolInspectionOutboxItem): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(OUTBOX_STORE_NAME, 'readwrite');
    const completion = transactionDone(transaction);
    transaction.objectStore(OUTBOX_STORE_NAME).put(clone(item));
    await completion;
  }

  async deleteOutbox(id: string, expectedOrder: number): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(OUTBOX_STORE_NAME, 'readwrite');
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(OUTBOX_STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as AutoPatrolInspectionOutboxItem | undefined;
      if (current?.order === expectedOrder) store.delete(id);
    };
    await completion;
  }

  async deleteRecord(taskId: string): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(RECORD_STORE_NAME, 'readwrite');
    const completion = transactionDone(transaction);
    transaction.objectStore(RECORD_STORE_NAME).delete(taskId);
    await completion;
  }

  close(): void {
    if (!this.databasePromise) return;
    void this.databasePromise.then((database) => database.close(), () => undefined);
  }

  private getDatabase(): Promise<IDBDatabase> {
    this.databasePromise ??= openDatabase(this.databaseName, this.indexedDb);
    return this.databasePromise;
  }
}

function openDatabase(databaseName: string, indexedDb: IDBFactory | undefined): Promise<IDBDatabase> {
  if (!indexedDb) return Promise.reject(new Error('当前环境不支持 IndexedDB。'));
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(databaseName, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RECORD_STORE_NAME)) {
        database.createObjectStore(RECORD_STORE_NAME, { keyPath: 'taskId' });
      }
      if (!database.objectStoreNames.contains(OUTBOX_STORE_NAME)) {
        database.createObjectStore(OUTBOX_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打开巡检 IndexedDB 失败。'));
    request.onblocked = () => reject(new Error('巡检 IndexedDB 升级被其他页面阻塞。'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('巡检 IndexedDB 请求失败。'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('巡检 IndexedDB 事务失败。'));
    transaction.onabort = () => reject(transaction.error ?? new Error('巡检 IndexedDB 事务已中止。'));
  });
}

function normalizeTrajectorySample(sample: AutoPatrolTrajectorySample): AutoPatrolTrajectorySample {
  return {
    recordedAtMs: finiteTimestamp(sample.recordedAtMs, '轨迹时间'),
    position: normalizeVector(sample.position, '轨迹位置'),
    rotation: normalizeVector(sample.rotation, '轨迹旋转'),
  };
}

function normalizeEvent(
  event: AutoPatrolInspectionEventRecord,
  limits: AutoPatrolInspectionRecordStoreLimits,
): AutoPatrolInspectionEventRecord {
  if (!INSPECTION_TRIGGER_SET.has(event.trigger)) throw new Error('事件触发类型无效。');
  const screenshotLocalUrl = event.screenshot
    ? requireIdentifier(
      event.screenshot.localUrl,
      '截图本地 URL',
      limits.maxScreenshotDataUrlLength,
      '巡检截图数据超过允许的长度上限。',
    )
    : null;
  if (screenshotLocalUrl && !screenshotLocalUrl.startsWith('data:image/png;base64,')) {
    throw new Error('巡检截图必须是 PNG Data URL。');
  }
  const screenshot = event.screenshot && screenshotLocalUrl
    ? {
      id: requireIdentifier(event.screenshot.id, '截图 ID', 512),
      capturedAtMs: finiteTimestamp(event.screenshot.capturedAtMs, '截图时间'),
      localUrl: screenshotLocalUrl,
      remoteUrl: optionalText(event.screenshot.remoteUrl, limits.maxScreenshotDataUrlLength),
    }
    : undefined;
  return {
    id: requireIdentifier(event.id, '事件 ID', 512),
    eventDefinitionId: requireIdentifier(event.eventDefinitionId, '事件定义 ID', 512),
    name: requireIdentifier(event.name, '事件名称', 512),
    trigger: event.trigger,
    occurredAtMs: finiteTimestamp(event.occurredAtMs, '事件时间'),
    targetEntityId: optionalText(event.targetEntityId, 512),
    position: normalizeVector(event.position, '事件位置'),
    businessData: normalizeBusinessData(event.businessData, limits),
    anomaly: Boolean(event.anomaly),
    ...(screenshot ? { screenshot } : {}),
  };
}

function normalizeBusinessData(
  value: Record<string, AutoPatrolInspectionBusinessValue>,
  limits: AutoPatrolInspectionRecordStoreLimits,
): Record<string, AutoPatrolInspectionBusinessValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('事件业务数据无效。');
  const entries = Object.entries(value);
  if (entries.length > limits.maxBusinessDataFields) {
    throw new Error(`事件业务数据超过 ${limits.maxBusinessDataFields} 个字段上限。`);
  }
  const normalized: Record<string, AutoPatrolInspectionBusinessValue> = {};
  for (const [key, fieldValue] of entries) {
    if (!key.trim() || key.length > 128) throw new Error('事件业务数据字段名无效。');
    if (!(
      fieldValue === null
      || typeof fieldValue === 'string'
      || typeof fieldValue === 'boolean'
      || (typeof fieldValue === 'number' && Number.isFinite(fieldValue))
    )) throw new Error(`事件业务数据字段 ${key} 无效。`);
    if (typeof fieldValue === 'string' && fieldValue.length > limits.maxBusinessStringLength) {
      throw new Error(`事件业务数据字符串超过 ${limits.maxBusinessStringLength} 字符上限。`);
    }
    normalized[key] = fieldValue;
  }
  return normalized;
}

function normalizeVector(value: Vector3Data, label: string): Vector3Data {
  if (![value.x, value.y, value.z].every(Number.isFinite)) throw new Error(`${label}无效。`);
  return { x: value.x, y: value.y, z: value.z };
}

function finiteTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label}无效。`);
  return value;
}

function requireIdentifier(
  value: string,
  label: string,
  maximumLength = 512,
  overflowMessage = `${label}超过允许的长度上限。`,
): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空。`);
  if (normalized.length > maximumLength) throw new Error(overflowMessage);
  return normalized;
}

function requireScopeIdentifier(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('巡检场景作用域不能为空。');
  if (value.length > 512) throw new Error('巡检场景作用域超过允许的长度上限。');
  return value;
}

function optionalText(value: string | null | undefined, maximumLength = 512): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length > maximumLength) throw new Error('文本超过允许的长度上限。');
  return normalized || null;
}

function resolveStoreLimits(
  overrides: Partial<AutoPatrolInspectionRecordStoreLimits> | undefined,
): AutoPatrolInspectionRecordStoreLimits {
  const resolved = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`巡检存储限制 ${name} 无效。`);
  }
  return resolved;
}

function estimateRecordBytes(record: AutoPatrolInspectionRecord): number {
  return JSON.stringify(record).length * 2;
}

function estimateTrajectoryAdditionBytes(
  existingSampleCount: number,
  additions: readonly AutoPatrolTrajectorySample[],
): number {
  const commaCount = additions.length - 1 + (existingSampleCount > 0 ? 1 : 0);
  const characterCount = additions.reduce((total, sample) => total + JSON.stringify(sample).length, commaCount);
  return characterCount * 2;
}

function compareOutboxItems(left: AutoPatrolInspectionOutboxItem, right: AutoPatrolInspectionOutboxItem): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

function resolveGlobalOnlineEventSource(): OnlineEventSource | null {
  const candidate = globalThis as typeof globalThis & Partial<OnlineEventSource>;
  return typeof candidate.addEventListener === 'function' && typeof candidate.removeEventListener === 'function'
    ? candidate as OnlineEventSource
    : null;
}

function createUuid(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `inspection_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
