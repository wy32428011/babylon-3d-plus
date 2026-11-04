import type {
  AnyStateRecord, AtomicStateRevision, DeepReadonly, LogicManifest, StateChange, StateFact, StateMetadata,
  StateReadView, StateTable, StateTableRecords, StateTransactionPort, TwinStateDTO,
} from './types';
import { STATE_TABLES, TWIN_FACTS_VERSION } from './types';
import { canonicalStringify, compareText, copySafeJson, freezeData, requireState, stableKey, utf8Length } from './safeJson';
import type { StateBudgets } from './safeJson';
import type { StateAdapterRegistry } from './adapters';
import { recordSchema, validateJsonSchema } from './schema';
import { nextGeneration } from './identity';
import { validateRecordTransition, validateStateView } from './validation';
import { collectStateFacts } from './facts';

type RecordValue = DeepReadonly<AnyStateRecord>;
type Writes = Map<StateTable, Map<string, RecordValue | null>>;
type ResourceCost = { bytes: number; nodes: number };
/** 已校验 JSON 的成本与 copySafeJson 的保守计费一致，只在导入或触及记录时计算。 */
function resourceCost(value: unknown): ResourceCost {
  let bytes = 0, nodes = 0;
  const visit = (item: unknown): void => {
    nodes += 1;
    if (item === null || typeof item === 'boolean') bytes += 5;
    else if (typeof item === 'number') bytes += 24;
    else if (typeof item === 'string') bytes += utf8Length(JSON.stringify(item));
    else if (Array.isArray(item)) { bytes += 2 + item.length; for (const child of item) visit(child); }
    else { bytes += 2; for (const [key, child] of Object.entries(item as object)) { bytes += utf8Length(JSON.stringify(key)) + 2; visit(child); } }
  };
  visit(value); return { bytes, nodes };
}

/** 内部 Map 不暴露给适配器；每条记录在进入存储之前复制并冻结。 */
export class StateStore implements StateReadView {
  readonly #tables = new Map<StateTable, Map<string, RecordValue>>();
  #metadata: DeepReadonly<StateMetadata>;
  #cost: ResourceCost;
  readonly logic: DeepReadonly<LogicManifest>;
  constructor(state: DeepReadonly<TwinStateDTO>) {
    this.logic = state.logic; this.#metadata = state.metadata; this.#cost = resourceCost(state);
    for (const table of STATE_TABLES) {
      const map = new Map<string, RecordValue>();
      for (const record of state.tables[table]) {
        requireState(!map.has(record.id), 'DUPLICATE', `状态表 ${table} 存在重复身份。`);
        map.set(record.id, record);
      }
      this.#tables.set(table, map);
    }
  }
  get metadata(): DeepReadonly<StateMetadata> { return this.#metadata; }
  get<K extends StateTable>(table: K, id: string): DeepReadonly<StateTableRecords[K]> | undefined {
    return this.#tables.get(table)?.get(id) as DeepReadonly<StateTableRecords[K]> | undefined;
  }
  values<K extends StateTable>(table: K): Iterable<DeepReadonly<StateTableRecords[K]>> {
    return this.#tables.get(table)!.values() as Iterable<DeepReadonly<StateTableRecords[K]>>;
  }
  get cost(): Readonly<ResourceCost> { return this.#cost; }
  install(writes: Writes, metadata: DeepReadonly<StateMetadata>, cost: Readonly<ResourceCost>): void {
    // 所有可能失败的校验和序列化均在此之前完成；提交路径不调用用户代码。
    for (const [table, records] of writes) for (const [id, record] of records) {
      if (record === null) this.#tables.get(table)!.delete(id);
      else this.#tables.get(table)!.set(id, record);
    }
    this.#metadata = metadata; this.#cost = { ...cost };
  }
}

export function readOnlyView(source: StateReadView): StateReadView {
  return Object.freeze({
    get metadata() { return source.metadata; }, get logic() { return source.logic; },
    get: <K extends StateTable>(table: K, id: string) => source.get(table, id),
    values: <K extends StateTable>(table: K) => source.values(table),
  });
}
export function snapshotState(source: StateReadView): DeepReadonly<TwinStateDTO> {
  const tables = {} as Record<StateTable, RecordValue[]>;
  for (const table of STATE_TABLES) tables[table] = [...source.values(table)].sort((a, b) => compareText(a.id, b.id));
  return freezeData({ versions: source.logic.versions, logic: source.logic, metadata: source.metadata,
    tables } as unknown as TwinStateDTO);
}

/** 一个输入及它引发的所有截止任务共用 overlay，最后才触及已提交 Map。 */
export class StateStage implements StateReadView {
  readonly writes: Writes = new Map();
  readonly revisions: DeepReadonly<AtomicStateRevision>[] = [];
  #metadata: DeepReadonly<StateMetadata>;
  readonly #cost: ResourceCost;
  readonly #factCost: ResourceCost = { bytes: 0, nodes: 0 };
  constructor(readonly base: StateStore, readonly registry: StateAdapterRegistry, readonly budgets: Readonly<StateBudgets>) {
    this.#metadata = base.metadata; this.#cost = { ...base.cost };
  }
  get cost(): Readonly<ResourceCost> { return this.#cost; }
  get metadata(): DeepReadonly<StateMetadata> { return this.#metadata; }
  get logic(): DeepReadonly<LogicManifest> { return this.base.logic; }
  get<K extends StateTable>(table: K, id: string): DeepReadonly<StateTableRecords[K]> | undefined {
    const writes = this.writes.get(table);
    if (writes?.has(id)) return (writes.get(id) ?? undefined) as DeepReadonly<StateTableRecords[K]> | undefined;
    return this.base.get(table, id);
  }
  *values<K extends StateTable>(table: K): Iterable<DeepReadonly<StateTableRecords[K]>> {
    const writes = this.writes.get(table);
    const baseValues = this.base.values(table) as unknown as Iterable<RecordValue>;
    for (const value of baseValues) {
      const candidate = writes?.has(value.id) ? writes.get(value.id) : value;
      if (candidate) yield candidate as unknown as DeepReadonly<StateTableRecords[K]>;
    }
    if (writes) for (const [id, value] of writes) {
      if (value && !this.base.get(table, id)) yield value as unknown as DeepReadonly<StateTableRecords[K]>;
    }
  }
  runRevision(metadata: DeepReadonly<StateMetadata>, cause: DeepReadonly<AtomicStateRevision['cause']>,
    apply: (transaction: StateTransactionPort) => unknown, captureFacts = true): void {
    requireState(this.revisions.length < this.budgets.maxRevisionsPerBatch, 'BUDGET', '单批状态修订超过预算。');
    const beforeMetadata = resourceCost(this.#metadata), afterMetadata = resourceCost(metadata);
    this.#cost.bytes += afterMetadata.bytes - beforeMetadata.bytes; this.#cost.nodes += afterMetadata.nodes - beforeMetadata.nodes;
    this.#metadata = metadata;
    const touched = new Map<StateTable, Map<string, RecordValue | undefined>>();
    let open = true, writesCount = 0;
    const facts: StateFact[] = [];
    const assertOpen = (): void => requireState(open, 'TRANSACTION_CLOSED', '事务回调已结束，不能异步或延迟写入。');
    const stage = this;
    const touch = (table: StateTable, id: string, record: RecordValue | null): void => {
      assertOpen();
      requireState(STATE_TABLES.includes(table), 'TABLE', '未知状态表。');
      writesCount += 1;
      requireState(writesCount <= stage.budgets.maxChangesPerRevision, 'BUDGET', '事务写入次数超过预算。');
      const before = stage.get(table, id);
      validateRecordTransition(table, before, record ?? undefined);
      if (captureFacts) for (const fact of collectStateFacts(table, before, record ?? undefined, metadata.logicalTime,
        touched.get(table)?.has(id) === true)) {
        const cost = resourceCost(fact);
        stage.#factCost.bytes += cost.bytes + 1; stage.#factCost.nodes += cost.nodes;
        requireState(facts.length < stage.budgets.maxArrayLength && stage.#factCost.bytes <= stage.budgets.maxBytes
          && stage.#factCost.nodes <= stage.budgets.maxNodes, 'BUDGET', '事务事实超过批次预算，不能截断或提交半态。');
        facts.push(fact);
      }
      const beforeCost = before ? resourceCost(before) : { bytes: 0, nodes: 0 };
      const afterCost = record ? resourceCost(record) : { bytes: 0, nodes: 0 };
      stage.#cost.bytes += afterCost.bytes - beforeCost.bytes + (record ? 1 : 0) - (before ? 1 : 0);
      stage.#cost.nodes += afterCost.nodes - beforeCost.nodes;
      if (!touched.has(table)) touched.set(table, new Map());
      if (!touched.get(table)!.has(id)) touched.get(table)!.set(id, before);
      if (!stage.writes.has(table)) stage.writes.set(table, new Map());
      stage.writes.get(table)!.set(id, record);
    };
    const transaction: StateTransactionPort = Object.freeze({
      ...readOnlyView(stage),
      get metadata() { return stage.metadata; }, get logic() { return stage.logic; },
      get logicalTime() { return stage.metadata.logicalTime; }, get inputCursor() { return stage.metadata.inputCursor; },
      put<K extends StateTable>(table: K, record: StateTableRecords[K]): void {
        assertOpen(); requireState(STATE_TABLES.includes(table), 'TABLE', '未知状态表。');
        const copy = copySafeJson(record, { ...stage.budgets, maxDepth: Math.max(1, stage.budgets.maxDepth - 3) }, true) as unknown as StateTableRecords[K];
        validateJsonSchema(copy, recordSchema(table), stage.budgets, table);
        // table 的运行时 schema 已校验记录；在具体联合类型上冻结，避免泛型 K 触发递归 JSON 的无限推导。
        const value: RecordValue = freezeData(copy as AnyStateRecord);
        touch(table, value.id, value);
      },
      remove(table: StateTable, id: string): void {
        assertOpen(); requireState(stage.get(table, id), 'REFERENCE', '不能删除不存在的记录。'); touch(table, id, null);
      },
      allocateId(namespace: string): string {
        assertOpen();
        const generation = nextGeneration(transaction, namespace);
        const id = stableKey('entity', stage.metadata.projectionId, namespace, generation);
        requireState(id.length <= 2048, 'IDENTITY', '生成的稳定身份超过合同上限。');
        requireState(STATE_TABLES.every(table => !stage.get(table, id)), 'COUNTER_COLLISION', '生成计数落后于已有身份，须修复基线而非覆盖实体。');
        return id;
      },
    });
    try {
      requireState(apply(transaction) === undefined, 'ASYNC_TRANSACTION', '事务必须是返回 void 的同步受控回调。');
    } finally { open = false; }
    const changes: StateChange[] = [];
    for (const table of STATE_TABLES) {
      const ids = touched.get(table);
      if (!ids) continue;
      for (const id of [...ids.keys()].sort(compareText)) {
        const before = ids.get(id), after = this.get(table, id);
        validateRecordTransition(table, before, after);
        if (before === after || (before && after && canonicalStringify(before) === canonicalStringify(after))) continue;
        if (!before && !after) continue;
        changes.push((after ? { op: 'put', table, record: after } : { op: 'remove', table, id }) as StateChange);
      }
    }
    requireState(this.#cost.bytes <= this.budgets.maxBytes && this.#cost.nodes <= this.budgets.maxNodes,
      'BUDGET', '候选全态超过可恢复的字节或节点预算，未提交任何记录。');
    validateStateView(readOnlyView(this), this.registry, this.budgets);
    this.revisions.push(freezeData({ revision: metadata.cursor.stateRevision, logicalTime: metadata.logicalTime,
      inputCursor: metadata.inputCursor, continuity: metadata.continuity, cause, changes,
      ...(captureFacts ? { facts, factsVersion: TWIN_FACTS_VERSION } : {}) }));
  }
}
