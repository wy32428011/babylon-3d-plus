import type { DeepReadonly, StateChangeBatch, TwinBaseline, TwinCheckpoint, TwinStateDTO, VersionManifest } from './types';
import { STATE_TABLES } from './types';
import { canonicalStringify, copySafeJson, freezeData, requireState, resolveStateBudgets, stableKey, TwinStateError, utf8Length } from './safeJson';
import type { StateBudgets } from './safeJson';
import type { StateAdapterRegistry } from './adapters';
import { contentChecksum } from './checksum';
import {
  TWIN_BASELINE_JSON_SCHEMA, TWIN_CHANGE_BATCH_JSON_SCHEMA, TWIN_CHECKPOINT_JSON_SCHEMA,
  TWIN_STATE_JSON_SCHEMA, validateJsonSchema,
} from './schema';
import type { JsonSchema } from './schema';
import { StateStore, readOnlyView } from './store';
import { assertVersions, validateLogic, validateStateView } from './validation';
import { compareInputCursor } from './identity';

export type StateCodecOptions = { budgets?: Partial<StateBudgets>; expectedVersions?: DeepReadonly<VersionManifest> };
export function codecBudgets(registry: StateAdapterRegistry, options: StateCodecOptions): Readonly<StateBudgets> {
  return resolveStateBudgets({ ...registry.budgets, ...options.budgets });
}
function parseText(text: string, budgets: Readonly<StateBudgets>): unknown {
  requireState(typeof text === 'string' && utf8Length(text) <= budgets.maxBytes, 'BUDGET', '序列化内容超过字节预算。');
  try { return JSON.parse(text) as unknown; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new TwinStateError('JSON_PARSE', '不是有效的 JSON 状态文档。');
  }
}
function safeDocument<T>(value: unknown, schema: JsonSchema, budgets: Readonly<StateBudgets>): T {
  const data = copySafeJson(value, budgets);
  validateJsonSchema(data, schema, budgets);
  return data as unknown as T;
}
function validateState(state: TwinStateDTO, registry: StateAdapterRegistry, options: StateCodecOptions, budgets: Readonly<StateBudgets>): DeepReadonly<TwinStateDTO> {
  assertVersions(state.versions, state.logic.versions);
  if (options.expectedVersions) assertVersions(state.versions, options.expectedVersions);
  const frozen = freezeData(state);
  validateLogic(frozen.logic, registry);
  for (const table of STATE_TABLES) {
    requireState(state.tables[table].length <= budgets.maxRecordsPerTable, 'BUDGET', `状态表 ${table} 超过记录预算。`);
    // 导入是明确的全态边界；逐记录限制避免小事件后续无法更新过大的 driverState。
    for (const record of state.tables[table]) copySafeJson(record, budgets, true);
  }
  validateStateView(readOnlyView(new StateStore(frozen)), registry, budgets);
  return frozen;
}
export function validateTwinState(value: unknown, registry: StateAdapterRegistry, options: StateCodecOptions = {}): DeepReadonly<TwinStateDTO> {
  const budgets = codecBudgets(registry, options);
  return validateState(safeDocument<TwinStateDTO>(value, TWIN_STATE_JSON_SCHEMA, budgets), registry, options, budgets);
}
/** 必须由调用者提供已对齐、全域的状态；没有“用空表补齐”的初始化捷径。 */
export function createBaseline(value: unknown, registry: StateAdapterRegistry, options: StateCodecOptions = {}): DeepReadonly<TwinBaseline> {
  const state = validateTwinState(value, registry, options), { metadata } = state;
  requireState(metadata.cursor.stateRevision === '0' && metadata.logicalTime === metadata.baseline.asOf
    && compareInputCursor(metadata.inputCursor, metadata.baseline.inputCursor) === 0 && metadata.continuity.status === 'complete',
  'BASELINE', '新基线须开启 revision 0 的已对齐投影，不能冒用推进后的状态。');
  return freezeData({ format: 'twin-baseline/1', state } as unknown as TwinBaseline);
}
export function decodeBaseline(text: string, registry: StateAdapterRegistry, options: StateCodecOptions = {}): DeepReadonly<TwinBaseline> {
  return readBaseline(parseText(text, codecBudgets(registry, options)), registry, options);
}
export function readBaseline(value: unknown, registry: StateAdapterRegistry, options: StateCodecOptions = {}): DeepReadonly<TwinBaseline> {
  const data = safeDocument<TwinBaseline>(value, TWIN_BASELINE_JSON_SCHEMA, codecBudgets(registry, options));
  return createBaseline(data.state, registry, options);
}
export function encodeBaseline(value: unknown, registry: StateAdapterRegistry, options: StateCodecOptions = {}): string {
  return canonicalStringify(readBaseline(value, registry, options));
}
export function createCheckpoint(value: unknown, registry: StateAdapterRegistry, options: StateCodecOptions = {}): DeepReadonly<TwinCheckpoint> {
  const state = validateTwinState(value, registry, options);
  const body = { format: 'twin-checkpoint/1' as const, committed: true as const, state };
  return freezeData({ ...body, checksum: contentChecksum(body) } as unknown as TwinCheckpoint);
}
export function readCheckpoint(value: unknown, registry: StateAdapterRegistry, options: StateCodecOptions = {}): DeepReadonly<TwinCheckpoint> {
  const budgets = codecBudgets(registry, options);
  const checkpoint = safeDocument<TwinCheckpoint>(value, TWIN_CHECKPOINT_JSON_SCHEMA, budgets);
  const { checksum, ...body } = checkpoint;
  requireState(contentChecksum(body).value === checksum.value, 'CHECKSUM', '检查点 SHA-256 不匹配。');
  validateState(checkpoint.state, registry, options, budgets);
  return freezeData(checkpoint);
}
export function decodeCheckpoint(text: string, registry: StateAdapterRegistry, options: StateCodecOptions = {}): DeepReadonly<TwinCheckpoint> {
  return readCheckpoint(parseText(text, codecBudgets(registry, options)), registry, options);
}
export function encodeCheckpoint(value: unknown, registry: StateAdapterRegistry, options: StateCodecOptions = {}): string {
  return canonicalStringify(readCheckpoint(value, registry, options));
}
function assertBatchLimits(batch: StateChangeBatch, budgets: Readonly<StateBudgets>): void {
  requireState(batch.revisions.length > 0 && batch.revisions.length <= budgets.maxRevisionsPerBatch, 'BUDGET', '变化批次必须包含有界的原子修订。');
  for (const revision of batch.revisions) {
    requireState(revision.changes.length <= budgets.maxChangesPerRevision, 'BUDGET', '原子修订变化数超过预算。');
    const identities = new Set<string>();
    for (const change of revision.changes) {
      const key = stableKey(change.table, change.op === 'put' ? change.record.id : change.id);
      requireState(!identities.has(key), 'DUPLICATE', '同一原子修订不能包含重复记录的多个最终值。'); identities.add(key);
      if (change.op === 'put') copySafeJson(change.record, budgets, true);
    }
  }
}
export function readStateChangeBatch(value: unknown, budgets: Readonly<StateBudgets> = resolveStateBudgets()): DeepReadonly<StateChangeBatch> {
  const batch = safeDocument<StateChangeBatch>(value, TWIN_CHANGE_BATCH_JSON_SCHEMA, budgets);
  assertBatchLimits(batch, budgets);
  const { checksum, ...body } = batch;
  requireState(contentChecksum(body).value === checksum.value, 'CHECKSUM', '状态变化批次 SHA-256 不匹配。');
  return freezeData(batch);
}
export function decodeStateChangeBatch(text: string, budgets: Readonly<StateBudgets> = resolveStateBudgets()): DeepReadonly<StateChangeBatch> {
  return readStateChangeBatch(parseText(text, budgets), budgets);
}
export function encodeStateChangeBatch(value: unknown, budgets: Readonly<StateBudgets> = resolveStateBudgets()): string {
  return canonicalStringify(readStateChangeBatch(value, budgets));
}
/** committed 仅表示一个完整原子候选；持久性和 writer fencing 由外层提交协议负责。 */
export function sealStateChangeBatch(body: Omit<DeepReadonly<StateChangeBatch>, 'checksum'>, budgets: Readonly<StateBudgets>): DeepReadonly<StateChangeBatch> {
  const safe = copySafeJson(body, budgets);
  return readStateChangeBatch({ ...safe as object, checksum: contentChecksum(safe) }, budgets);
}
