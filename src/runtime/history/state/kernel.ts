import type {
  AdapterInput, AdvanceInput, AtomicStateRevision, DeepReadonly, InputCursor, KernelInput, KernelMode,
  StateChange, StateChangeBatch, StateMetadata, StateReadView, StateTableRecords, StateTable,
  StateTransactionPort, TimerState, TwinBaseline, TwinCheckpoint, TwinStateDTO,
} from './types';
import { SCHEDULE_PHASES } from './types';
import { canonicalStringify, compareDecimal, compareText, copySafeJson, freezeData, nextDecimal, requireState } from './safeJson';
import type { StateBudgets } from './safeJson';
import { StateAdapterRegistry } from './adapters';
import { TWIN_INPUT_JSON_SCHEMA, validateJsonSchema } from './schema';
import { compareInputCursor } from './identity';
import { assertVersions } from './validation';
import {
  codecBudgets, createCheckpoint, decodeBaseline, decodeCheckpoint, decodeStateChangeBatch,
  readBaseline, readCheckpoint, readStateChangeBatch, sealStateChangeBatch,
} from './codec';
import type { StateCodecOptions } from './codec';
import { readOnlyView, snapshotState, StateStage, StateStore } from './store';

export type TwinKernelOptions = StateCodecOptions & { mode: KernelMode };
export type PreparedStateCommit = {
  readonly batch: DeepReadonly<StateChangeBatch>;
  /** 先由宿主完成不可变批次持久化及 writer fencing，再提交此内存候选。 */
  commit(): DeepReadonly<StateChangeBatch>;
  abort(): void;
};
function timerOrder(a: DeepReadonly<TimerState>, b: DeepReadonly<TimerState>): number {
  return a.dueAt - b.dueAt || SCHEDULE_PHASES.indexOf(a.phase) - SCHEDULE_PHASES.indexOf(b.phase)
    || compareDecimal(a.ordinal, b.ordinal) || compareText(a.id, b.id);
}
function applyChanges(transaction: StateTransactionPort, changes: readonly DeepReadonly<StateChange>[]): void {
  for (const change of changes) {
    if (change.op === 'remove') transaction.remove(change.table, change.id);
    else transaction.put(change.table, change.record as unknown as StateTableRecords[StateTable]);
  }
}
function revisionMetadata(stage: StateStage, time: number, inputCursor: DeepReadonly<InputCursor>, continuity = stage.metadata.continuity): DeepReadonly<StateMetadata> {
  return freezeData({ ...stage.metadata, logicalTime: time, inputCursor, continuity,
    cursor: { projectionId: stage.metadata.projectionId, stateRevision: nextDecimal(stage.metadata.cursor.stateRevision) } });
}
/**
 * input-boundary/1：先处理严格早于输入的截止任务，再应用输入，再处理同刻任务。
 * 每个截止时刻依 SCHEDULE_PHASES、ordinal、id 排序；hclift 在 shuttle 前，external-pull 最后。
 * 相同 logicalTime 的多条输入仍按采集 offset 逐边界处理，不能按渲染帧重新分组。
 */
export class TwinStateKernel {
  readonly #store: StateStore;
  readonly #registry: StateAdapterRegistry;
  readonly #budgets: Readonly<StateBudgets>;
  #preparing = false;
  readonly mode: KernelMode;
  readonly view: StateReadView;
  private constructor(state: DeepReadonly<TwinStateDTO>, registry: StateAdapterRegistry, options: TwinKernelOptions) {
    requireState(options.mode === 'projector' || options.mode === 'canonical-follower', 'MODE', '必须显式选择唯一业务写入者或 canonical 只读跟随者。');
    this.#registry = registry.snapshot(); this.#budgets = codecBudgets(registry, options); this.mode = options.mode;
    if (this.mode === 'projector') this.#registry.assertReducerManifest(state.logic);
    this.#store = new StateStore(state); this.view = readOnlyView(this.#store); Object.freeze(this);
  }
  static fromBaseline(value: unknown, registry: StateAdapterRegistry, options: TwinKernelOptions): TwinStateKernel {
    const baseline = typeof value === 'string' ? decodeBaseline(value, registry, options) : readBaseline(value, registry, options);
    return new TwinStateKernel(baseline.state, registry, options);
  }
  /** 解码或恢复失败不会替换调用者已有内核；版本不兼容必须另建投影，禁止静默迁移。 */
  static fromCheckpoint(value: unknown, registry: StateAdapterRegistry, options: TwinKernelOptions): TwinStateKernel {
    const checkpoint = typeof value === 'string' ? decodeCheckpoint(value, registry, options) : readCheckpoint(value, registry, options);
    return new TwinStateKernel(checkpoint.state, registry, options);
  }
  get metadata(): DeepReadonly<StateMetadata> { return this.#store.metadata; }
  snapshot(): DeepReadonly<TwinStateDTO> { return snapshotState(this.#store); }
  checkpoint(): DeepReadonly<TwinCheckpoint> {
    return createCheckpoint(this.snapshot(), this.#registry, { budgets: this.#budgets, expectedVersions: this.#store.logic.versions });
  }
  /** 完整基线只能单独建新投影，不把补采库存伪装成旧投影的普通增量。 */
  static fromAlignedBaseline(value: DeepReadonly<TwinBaseline>, previous: TwinStateKernel, registry: StateAdapterRegistry, options: TwinKernelOptions): TwinStateKernel {
    const next = TwinStateKernel.fromBaseline(value, registry, options);
    requireState(next.metadata.projectionId !== previous.metadata.projectionId, 'STATE_RESET_REQUIRED', '重新对齐必须使用新的 projectionId。');
    return next;
  }
  prepareInput(value: unknown): PreparedStateCommit { return this.#guardPreparation(() => this.#prepareInput(value)); }
  #prepareInput(value: unknown): PreparedStateCommit {
    const input = copySafeJson(value, this.#budgets) as unknown as KernelInput;
    validateJsonSchema(input, TWIN_INPUT_JSON_SCHEMA, this.#budgets, 'input');
    const event = freezeData(input), before = this.#store.metadata;
    assertVersions(event.versions, this.#store.logic.versions);
    requireState(event.projectionId === before.projectionId, 'STATE_RESET_REQUIRED', '输入不属于当前投影代次。');
    requireState(compareInputCursor(event.cursor, before.inputCursor) > 0 && event.cursor.offset === nextDecimal(before.inputCursor.offset),
      'INPUT_ORDER', '输入必须是同关联域的下一条观测；重复、倒序和跳号不能静默应用。');
    requireState(event.logicalTime >= before.logicalTime, 'TIME', '迟到数据只能作为新的有序观测，不能回写已提交的逻辑时间。');
    requireState(before.continuity.status === 'complete' || event.kind === 'gap', 'CONTINUITY_GAP', '断档后停止业务推演；补齐证明或新投影基线须由外层协议提供。');
    if (event.kind === 'canonical') requireState(this.mode === 'canonical-follower', 'WRITER_AUTHORITY', 'projector 不接受 canonical 绕过业务规则。');
    if (event.kind === 'adapter' || event.kind === 'advance') requireState(this.mode === 'projector', 'WRITER_AUTHORITY', 'Viewer 跟随者不得再次执行原始输入或时间推演。');
    if (event.kind === 'adapter') this.#registry.validateInput(event, this.#store.logic);
    const stage = new StateStage(this.#store, this.#registry, this.#budgets);
    let timerCount = 0;
    let lastTimer: DeepReadonly<TimerState> | null = null;
    const drain = (inclusive: boolean): void => {
      while (true) {
        let next: DeepReadonly<TimerState> | undefined;
        for (const candidate of stage.values('timers')) {
          if (candidate.dueAt > event.logicalTime || (!inclusive && candidate.dueAt === event.logicalTime)) continue;
          if (!next || timerOrder(candidate, next) < 0) next = candidate;
        }
        if (!next) return;
        timerCount += 1;
        requireState(timerCount <= this.#budgets.maxTimersPerInput, 'BUDGET', '到期任务超过单输入预算，未提交任何半态。');
        requireState(!lastTimer || timerOrder(lastTimer, next) < 0, 'SCHEDULE_REGRESSION', '任务不得倒插到同刻已执行的阶段之前；帧尾拉货不能触发反向重排。');
        const timer = next;
        stage.runRevision(revisionMetadata(stage, timer.dueAt, stage.metadata.inputCursor), { kind: 'timer', id: timer.id }, transaction => {
          transaction.remove('timers', timer.id);
          this.#registry.fire(timer, transaction);
        });
        lastTimer = timer;
      }
    };
    if (event.kind !== 'gap' && this.mode === 'projector') drain(false);
    const continuity = event.kind === 'gap'
      ? (before.continuity.status === 'gap' ? before.continuity : { status: 'gap' as const, since: before.logicalTime, reason: event.reason })
      : stage.metadata.continuity;
    const cause: AtomicStateRevision['cause'] = { kind: event.kind === 'gap' ? 'gap' : event.kind === 'advance' ? 'advance' : 'input', id: event.id };
    stage.runRevision(revisionMetadata(stage, event.logicalTime, event.cursor, continuity), cause, transaction => {
      if (event.kind === 'canonical') applyChanges(transaction, event.changes);
      else if (event.kind === 'adapter') this.#applyAdapterInput(event, transaction);
    }, event.kind !== 'canonical');
    if (event.kind !== 'gap' && this.mode === 'projector') drain(true);
    const batch = sealStateChangeBatch({ format: 'twin-changes/1', committed: true, versions: stage.logic.versions,
      projectionId: before.projectionId, fromRevision: before.cursor.stateRevision, toRevision: stage.metadata.cursor.stateRevision,
      throughTime: stage.metadata.logicalTime, inputCursor: stage.metadata.inputCursor, revisions: stage.revisions }, this.#budgets);
    return this.#prepareCommit(stage, before, batch);
  }
  applyInput(value: unknown): DeepReadonly<StateChangeBatch> { return this.prepareInput(value).commit(); }
  /** advance 也必须带顺序器分配的完整 envelope；没有隐藏的墙钟或不落日志的 tick。 */
  advanceTo(input: AdvanceInput): DeepReadonly<StateChangeBatch> {
    requireState(input.kind === 'advance', 'INPUT', 'advanceTo 只接受已记录的 advance 输入。'); return this.applyInput(input);
  }
  prepareChangeBatch(value: unknown): PreparedStateCommit { return this.#guardPreparation(() => this.#prepareChangeBatch(value)); }
  #prepareChangeBatch(value: unknown): PreparedStateCommit {
    requireState(this.mode === 'canonical-follower', 'WRITER_AUTHORITY', '只有 canonical-follower 可以应用已推演的状态批次。');
    const batch = typeof value === 'string' ? decodeStateChangeBatch(value, this.#budgets) : readStateChangeBatch(value, this.#budgets);
    const before = this.#store.metadata;
    assertVersions(batch.versions, this.#store.logic.versions);
    requireState(batch.projectionId === before.projectionId, 'STATE_RESET_REQUIRED', '变化批次要求重新加载全态。');
    requireState(batch.fromRevision === before.cursor.stateRevision, 'REVISION_ORDER', '变化批次必须紧接已提交修订；重叠或缺失均拒绝。');
    const stage = new StateStage(this.#store, this.#registry, this.#budgets);
    for (const revision of batch.revisions) {
      const prior = stage.metadata;
      requireState(revision.revision === nextDecimal(prior.cursor.stateRevision) && revision.logicalTime >= prior.logicalTime,
        'REVISION_ORDER', '原子修订存在跳号或逻辑时间倒退。');
      const cursorOrder = compareInputCursor(revision.inputCursor, prior.inputCursor);
      requireState(revision.cause.kind === 'timer' ? cursorOrder === 0
        : cursorOrder > 0 && revision.inputCursor.offset === nextDecimal(prior.inputCursor.offset), 'INPUT_ORDER', '修订的输入边界不连续。');
      requireState(prior.continuity.status === 'gap' ? revision.cause.kind === 'gap' && revision.changes.length === 0
        && canonicalStringify(prior.continuity) === canonicalStringify(revision.continuity)
        : revision.cause.kind === 'gap' ? revision.continuity.status === 'gap' && revision.continuity.since === prior.logicalTime
          : canonicalStringify(prior.continuity) === canonicalStringify(revision.continuity), 'CONTINUITY', '断档只能通过新基线恢复，不能由增量静默抹除。');
      // 已提交批次的 changes 是净状态，不能重新推导并冒充原始逐次写入事实。
      stage.runRevision(revisionMetadata(stage, revision.logicalTime, revision.inputCursor, revision.continuity), revision.cause,
        transaction => { applyChanges(transaction, revision.changes); }, false);
    }
    requireState(batch.toRevision === stage.metadata.cursor.stateRevision && batch.throughTime === stage.metadata.logicalTime
      && compareInputCursor(batch.inputCursor, stage.metadata.inputCursor) === 0, 'BATCH_BOUNDARY', '批次尾游标或时间不匹配实际原子修订。');
    return this.#prepareCommit(stage, before, batch);
  }
  applyChangeBatch(value: unknown): DeepReadonly<StateChangeBatch> { return this.prepareChangeBatch(value).commit(); }
  #applyAdapterInput(input: DeepReadonly<AdapterInput>, transaction: StateTransactionPort): void {
    const definition = transaction.logic.sources.find(source => source.id === input.sourceId);
    requireState(definition, 'SOURCE', '输入来源不属于当前逻辑清单。');
    const previous = transaction.get('sources', input.sourceId);
    requireState(!previous || previous.sourceEpoch === input.sourceEpoch, 'SOURCE_RESET_REQUIRED', '来源纪元改变须显式重新对齐，不能重置去重状态继续推演。');
    const duplicate = Boolean(input.sourceEventId && previous?.recentEvents.some(item => item.eventId === input.sourceEventId))
      || (input.sourceSequence !== null && previous?.lastSequence !== null && previous?.lastSequence !== undefined
        && compareDecimal(input.sourceSequence, previous.lastSequence) <= 0);
    const events = [...(previous?.recentEvents ?? [])];
    if (input.sourceEventId && !events.some(item => item.eventId === input.sourceEventId)) events.push({ eventId: input.sourceEventId, offset: input.cursor.offset });
    requireState(events.length <= this.#budgets.maxArrayLength, 'DEDUP_CAPACITY', '来源去重证据超过容量，不能静默驱逐旧身份后重复执行业务。');
    transaction.put('sources', { id: input.sourceId, sourceRevision: definition.revision, sourceEpoch: input.sourceEpoch,
      lastSequence: duplicate ? previous?.lastSequence ?? null : input.sourceSequence ?? previous?.lastSequence ?? null,
      lastInputCursor: { ...input.cursor }, recentEvents: events });
    // 未知事件在去重前拒绝；重传不重复运行 reducer，仅允许显式注册的逐消息生命周期观察。
    if (!duplicate) this.#registry.apply(input, transaction);
    else this.#registry.observeRepeated(input, transaction);
  }
  #guardPreparation<T>(prepare: () => T): T {
    requireState(!this.#preparing, 'REENTRANT_TRANSACTION', '受控回调不能递归启动同一内核的事务。');
    this.#preparing = true;
    try { return prepare(); } finally { this.#preparing = false; }
  }
  #prepareCommit(stage: StateStage, before: DeepReadonly<StateMetadata>, batch: DeepReadonly<StateChangeBatch>): PreparedStateCommit {
    let status: 'prepared' | 'committed' | 'aborted' = 'prepared';
    return Object.freeze({ batch,
      commit: () => {
        requireState(status !== 'aborted', 'TRANSACTION_CLOSED', '候选事务已放弃。');
        if (status === 'committed') return batch;
        requireState(!this.#preparing, 'REENTRANT_TRANSACTION', '事务校验期间不能提交另一个候选。');
        requireState(this.#store.metadata === before, 'STALE_TRANSACTION', '候选事务基于过期状态，不能覆盖较新的提交。');
        this.#store.install(stage.writes, stage.metadata, stage.cost); status = 'committed'; return batch;
      },
      abort: () => { requireState(status !== 'committed', 'TRANSACTION_CLOSED', '已提交事务不能作为未提交候选撤销。'); status = 'aborted'; },
    });
  }
}
