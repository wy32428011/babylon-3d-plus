import type { DeepReadonly, FetchRequestState, FetchRowState, StateTransactionPort } from './types';
import { compareText, copySafeJson, nextDecimal, requireState, stableKey } from './safeJson';
import { fetchRowId, nextGeneration } from './identity';
import { draftRecord } from './stateOps';

export type FetchIntent = { sourceId: string; operationEpoch: string; scope: 'full' | 'rows'; rows: readonly string[] };
export type FetchCompletion = {
  requestId: string; attemptId: string; operationEpoch: string;
  outcome: 'succeeded' | 'failed'; responseRef: string | null; failure: string | null;
};
export type FetchRowApplication = { inventoryRevision: string; settledCargoIds: string[] };
export type FetchCompletionResult = { status: 'applied' | 'failed' | 'superseded' | 'stale-attempt' | 'already-completed'; appliedRows: string[] };

/** 只产生查询意图；这里不会发 HTTP、重试网络，也不将 full 响应擅自扩展成请求外的排。 */
export function issueFetchRequest(transaction: StateTransactionPort, intent: FetchIntent): string {
  const source = transaction.logic.sources.find(item => item.id === intent.sourceId);
  requireState(source && intent.operationEpoch.length > 0 && intent.rows.length > 0 && new Set(intent.rows).size === intent.rows.length,
    'FETCH', '查询须声明已配置来源、操作代次和无重复的作用排。');
  const rows = [...intent.rows].sort(compareText);
  const current: FetchRowState[] = rows.map(row => {
    requireState(transaction.logic.slots.some(slot => slot.row === row), 'FETCH', '查询作用排没有已发布的逻辑库位。');
    const id = fetchRowId(intent.sourceId, row), old = transaction.get('fetchRows', id);
    requireState(!old || old.operationEpoch === intent.operationEpoch, 'FETCH_EPOCH', '查询操作代次改变须先显式 supersede 旧意图。');
    return old ? draftRecord(transaction, 'fetchRows', id) : { id, sourceId: intent.sourceId, row, operationEpoch: intent.operationEpoch,
      latestGeneration: '0', latestRequestId: null, appliedRequestId: null, inventoryRevision: null,
      transientSuppressedSlotIds: [], persistentSuppressedSlotIds: [], pendingSettlement: [] } satisfies FetchRowState;
  });
  const id = transaction.allocateId(stableKey('fetch', intent.sourceId));
  const request: FetchRequestState = { id, attemptId: transaction.allocateId('fetch-attempt'), sourceId: source.id,
    sourceRevision: source.revision, sourceContractId: transaction.logic.versions.sourceContractId,
    operationEpoch: intent.operationEpoch, generation: nextGeneration(transaction, stableKey('fetch-generation', source.id)),
    scope: intent.scope, rows: [], issuedAt: transaction.logicalTime, completedAt: null, status: 'pending', responseRef: null, failure: null };
  const superseded = new Set<string>();
  for (const row of current) {
    if (row.latestRequestId) superseded.add(row.latestRequestId);
    row.latestGeneration = nextDecimal(row.latestGeneration); row.latestRequestId = id;
    request.rows.push({ row: row.row, generation: row.latestGeneration }); transaction.put('fetchRows', row);
  }
  transaction.put('fetchRequests', request);
  // 全量请求被单排请求部分取代时仍保留其余排的有效结果，不能整笔提前取消。
  for (const oldId of superseded) {
    const old = draftRecord(transaction, 'fetchRequests', oldId);
    if (old.status === 'pending' && old.rows.every(row => transaction.get('fetchRows', fetchRowId(old.sourceId, row.row))?.latestRequestId !== oldId)) {
      old.status = 'superseded'; old.completedAt = transaction.logicalTime; transaction.put('fetchRequests', old);
    }
  }
  return id;
}

/** worker 代次切换只取消尚在途的意图；不清除持久抑制、未清算货物或已应用库存。 */
export function resetFetchOperation(transaction: StateTransactionPort, sourceId: string, operationEpoch: string): void {
  requireState(operationEpoch.length > 0 && transaction.logic.sources.some(source => source.id === sourceId), 'FETCH', '新的操作代次或来源无效。');
  for (const value of transaction.values('fetchRequests')) if (value.sourceId === sourceId && value.status === 'pending') {
    const request = draftRecord(transaction, 'fetchRequests', value.id);
    request.status = 'superseded'; request.completedAt = transaction.logicalTime; transaction.put('fetchRequests', request);
  }
  for (const value of transaction.values('fetchRows')) if (value.sourceId === sourceId) {
    const row = draftRecord(transaction, 'fetchRows', value.id);
    requireState(row.operationEpoch !== operationEpoch, 'FETCH_EPOCH', '操作代次必须实际改变。');
    row.operationEpoch = operationEpoch; row.latestRequestId = null; transaction.put('fetchRows', row);
  }
}
/** 同一请求重试只更换 attemptId；迟到的旧 attempt 不能完成新尝试。 */
export function retryFetchRequest(transaction: StateTransactionPort, requestId: string): string {
  const request = draftRecord(transaction, 'fetchRequests', requestId);
  requireState(request.status === 'pending' || request.status === 'failed', 'FETCH', '已应用或被取代的请求不能重试。');
  requireState(request.rows.some(item => {
    const row = transaction.get('fetchRows', fetchRowId(request.sourceId, item.row));
    return row?.operationEpoch === request.operationEpoch && row.latestRequestId === request.id && row.latestGeneration === item.generation;
  }), 'FETCH', '所有请求排均已被取代，不能重新发出意图。');
  request.attemptId = transaction.allocateId('fetch-attempt'); request.issuedAt = transaction.logicalTime; request.completedAt = null;
  request.status = 'pending'; request.failure = null; request.responseRef = null; transaction.put('fetchRequests', request);
  return request.attemptId;
}

/**
 * 行业务变更、解除瞬态抑制和货物清算由同一个外层原子事务提交。
 * applyRow 必须由已迁移适配器提供真实规则；基础内核不猜测旧库存/设备持货算法。
 * 回调只能结算明确返回的 cargoId，未结算项继续持久保留，持久抑制不自动解除。
 */
export function completeFetchRequest(
  transaction: StateTransactionPort,
  completion: FetchCompletion,
  applyRow?: (row: DeepReadonly<FetchRowState>, transaction: StateTransactionPort) => FetchRowApplication,
): FetchCompletionResult {
  const request = draftRecord(transaction, 'fetchRequests', completion.requestId);
  if (request.attemptId !== completion.attemptId || request.operationEpoch !== completion.operationEpoch) return { status: 'stale-attempt', appliedRows: [] };
  if (request.status === 'succeeded' || request.status === 'failed') return { status: 'already-completed', appliedRows: [] };
  requireState(completion.outcome === 'succeeded' || completion.outcome === 'failed', 'FETCH', '未知查询完成类型。');
  requireState(completion.outcome === 'succeeded' ? completion.responseRef !== null : completion.failure !== null,
    'FETCH', '成功结果须有响应证据，失败结果须有明确原因。');
  const applicable = request.rows.filter(item => {
    const row = transaction.get('fetchRows', fetchRowId(request.sourceId, item.row));
    return row?.operationEpoch === request.operationEpoch && row.latestGeneration === item.generation && row.latestRequestId === request.id;
  });
  request.completedAt = transaction.logicalTime; request.responseRef = completion.responseRef; request.failure = completion.failure;
  request.status = applicable.length === 0 ? 'superseded' : completion.outcome;
  transaction.put('fetchRequests', request);
  if (applicable.length === 0) return { status: 'superseded', appliedRows: [] };
  if (completion.outcome === 'failed') return { status: 'failed', appliedRows: [] };
  requireState(typeof applyRow === 'function', 'UNIMPLEMENTED_REDUCER', '成功库存响应缺少已迁移的逐排应用/清算规则。');
  const appliedRows: string[] = [];
  for (const item of applicable) {
    const id = fetchRowId(request.sourceId, item.row), before = transaction.get('fetchRows', id)!;
    const result = copySafeJson(applyRow(before, transaction)) as unknown as FetchRowApplication;
    requireState(result && typeof result.inventoryRevision === 'string' && result.inventoryRevision.length > 0
      && Array.isArray(result.settledCargoIds) && result.settledCargoIds.every(id => typeof id === 'string')
      && new Set(result.settledCargoIds).size === result.settledCargoIds.length, 'FETCH', '逐排应用须同步返回库存修订及明确结算的货物身份。');
    const row = draftRecord(transaction, 'fetchRows', id);
    requireState(row.latestRequestId === request.id && row.latestGeneration === item.generation && row.operationEpoch === request.operationEpoch,
      'FETCH', '逐排应用不能改写当前请求仲裁边界。');
    requireState(before.persistentSuppressedSlotIds.every(slotId => row.persistentSuppressedSlotIds.includes(slotId)),
      'FETCH', '完成查询不能把持久保留格口作为瞬态抑制清空。');
    requireState(result.settledCargoIds.every(cargoId => before.pendingSettlement.some(pending => pending.cargoId === cargoId))
      && before.pendingSettlement.every(pending => result.settledCargoIds.includes(pending.cargoId)
        || row.pendingSettlement.some(current => current.cargoId === pending.cargoId)),
      'FETCH', '清算结果引用了本排之外的货物，或静默丢弃了未结算关联。');
    row.appliedRequestId = request.id; row.inventoryRevision = result.inventoryRevision; row.transientSuppressedSlotIds = [];
    row.pendingSettlement = row.pendingSettlement.filter(pending => !result.settledCargoIds.includes(pending.cargoId));
    transaction.put('fetchRows', row); appliedRows.push(row.row);
  }
  return { status: 'applied', appliedRows };
}
