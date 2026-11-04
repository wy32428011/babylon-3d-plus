import type { DeepReadonly, FetchRequestState, StateReadView } from '../state/types';
import { draftRecord } from '../state/stateOps';
import { fetchRowId } from '../state/identity';
import { issueFetchRequest, resetFetchOperation, retryFetchRequest } from '../state/fetch';
import { compareText, requireState } from '../state/safeJson';
import type { LogisticsContext, TargetCell } from './context';
import type { FrozenLocator, InventoryContainerRecord } from './manifest';
import { V } from './math';

export type LogisticsFetchRequestPayload = { sourceId: string; operationEpoch: string; scope: 'full' | 'rows'; rows: string[] };
export type LogisticsFetchResultPayload = {
  requestId: string; attemptId: string; operationEpoch: string; outcome: 'succeeded' | 'failed';
  responseRef: string | null; failure: string | null; inventoryRevision: string | null; records: InventoryContainerRecord[];
};
export function requestInventory(ctx: LogisticsContext, payload: LogisticsFetchRequestPayload): string {
  const source = ctx.manifest.fetchSources.find(source => source.sourceId === payload.sourceId);
  requireState(source && payload.rows.length > 0 && payload.rows.every(row => source.rowKeys.includes(row)), 'LOGISTICS_FETCH', '查询排不属于已发布的只读库存来源。');
  if (payload.scope === 'full') requireState(payload.rows.length === source.rowKeys.length
    && source.rowKeys.every(row => payload.rows.includes(row)), 'LOGISTICS_FETCH', '全量查询必须显式覆盖该来源的全部已发布排。');
  return issueFetchRequest(ctx.tx, payload);
}
export function retryInventory(ctx: LogisticsContext, requestId: string): string { return retryFetchRequest(ctx.tx, requestId); }
export function resetInventoryEpoch(ctx: LogisticsContext, sourceId: string, operationEpoch: string): void {
  requireState(ctx.manifest.fetchSources.some(source => source.sourceId === sourceId), 'LOGISTICS_FETCH', '未声明的库存来源。');
  resetFetchOperation(ctx.tx, sourceId, operationEpoch);
}
function templateForRecord(ctx: LogisticsContext, locator: FrozenLocator, record: InventoryContainerRecord): string | null {
  const generator = ctx.manifest.cargoGenerators.find(generator => generator.generatorId === locator.cargoGeneratorId);
  if (!generator) return locator.cargoTemplateId;
  for (const rule of generator.rules) {
    const field = rule.attributeName.trim(), raw = field ? record[field] : record.containerType;
    const value = raw ?? record.containerType ?? '';
    // 业务库存字段的规则比较沿用 trim 字符串匹配；复杂对象不是可用的货箱类型事实。
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const actual = String(value).trim(); if (actual && actual === rule.attributeValue.trim() && rule.templateId) return rule.templateId;
  }
  return generator.defaultTemplateId;
}
function applySlot(ctx: LogisticsContext, sourceId: string, target: TargetCell, record: InventoryContainerRecord | null, revision: string): void {
  const slot = draftRecord(ctx.tx, 'slots', target.cell.slotId), previous = slot.cargoId;
  const templateId = record ? templateForRecord(ctx, target.locator, record) : null;
  requireState(!record || templateId !== null, 'LOGISTICS_GEOMETRY', '非空库存记录没有已冻结的货箱模板，不能把未知占用当作空库位。');
  if (previous && !record) ctx.cargo.dispose(previous, 'inventory-slot-empty');
  else if (record && templateId) {
    ctx.cargo.template(templateId);
    const current = previous ? ctx.tx.get('cargo', previous) : null;
    // 条码只是连续占用期间的对账证据，不能据它合并跨库位或已销毁的生命周期。
    const same = current && (current.containerCode ?? '') === (record.containerCode ?? '').trim();
    let id: string;
    if (same && previous) {
      id = previous;
      const cargo = ctx.cargo.record(id); cargo.containerCode = record.containerCode.trim() || null; ctx.tx.put('cargo', cargo);
      const meta = ctx.cargo.meta(id); meta.templateId = templateId; meta.ownerDeviceId = null; meta.ownerRole = null;
      meta.retained = false; meta.awaitingFetch = false; meta.handoff = null; ctx.cargo.saveMeta(meta);
      ctx.cargo.setWorld(id, target.position, target.cell.pose.rotation, target.cell.pose.scale);
    } else {
      if (previous) ctx.cargo.dispose(previous, 'inventory-slot-replaced');
      id = ctx.cargo.createInventory(sourceId, target, record, templateId);
    }
    const occupied = draftRecord(ctx.tx, 'slots', target.cell.slotId); occupied.cargoId = id; ctx.tx.put('slots', occupied);
  }
  const final = draftRecord(ctx.tx, 'slots', target.cell.slotId); final.inventoryRevision = revision; ctx.tx.put('slots', final);
}
function applyRow(ctx: LogisticsContext, request: FetchRequestState, rowKey: string, records: InventoryContainerRecord[], revision: string): void {
  const id = fetchRowId(request.sourceId, rowKey), before = draftRecord(ctx.tx, 'fetchRows', id);
  const locators = ctx.manifest.locators.filter(locator => locator.fetchSourceId === request.sourceId && locator.fetchRow === rowKey);
  requireState(locators.length > 0, 'LOGISTICS_FETCH', '库存排没有已发布的逻辑库位范围。');
  const rowRecords = records.filter(record => String(record.row ?? '').trim() === rowKey);
  const occupiedCoordinates = new Set(rowRecords.filter(record => !record.isEmpty).map(record => String(record.column) + '-' + String(record.layer)));
  // 全量仅在没有待清算货物时释放已确认空格的瞬态抑制；全量不代替单排清算。
  if (request.scope === 'full' && before.pendingSettlement.length === 0) {
    before.transientSuppressedSlotIds = before.transientSuppressedSlotIds.filter(slotId => {
      const slot = ctx.tx.logic.slots.find(slot => slot.id === slotId); return slot && occupiedCoordinates.has(String(slot.column) + '-' + String(slot.layer));
    });
  } else if (request.scope === 'rows') before.transientSuppressedSlotIds = [];
  ctx.tx.put('fetchRows', before);
  const visible = new Map<string, InventoryContainerRecord>();
  for (const locator of locators) for (const record of rowRecords) {
    if (record.isEmpty) continue;
    const cell = locator.cells.find(cell => cell.column === record.column && cell.layer === record.layer);
    if (!cell) continue; // 同排可跨多个线框；场景没有覆盖的列层不属于本投影。
    requireState(!visible.has(cell.slotId), 'LOGISTICS_FETCH_CONFLICT', '同一逻辑格口出现多条占用记录；需要来源明确层叠/深位身份，不能重叠冒充单一宿主。');
    visible.set(cell.slotId, record);
  }
  for (const locator of locators) for (const cell of locator.cells) {
    if (before.persistentSuppressedSlotIds.includes(cell.slotId) || before.transientSuppressedSlotIds.includes(cell.slotId)) continue;
    applySlot(ctx, request.sourceId, { locator: locator as FrozenLocator, cell: cell as TargetCell['cell'], position: V.copy(cell.pose.position) }, visible.get(cell.slotId) ?? null, revision);
  }
  if (request.scope === 'rows') {
    // 已由相同格口库存接续的实体保留 cargoId；真正被源结果替换/移除的临时表示才留销毁墓碑。
    for (const pending of before.pendingSettlement) {
      const cargo = ctx.tx.get('cargo', pending.cargoId); if (!cargo || cargo.destroyedAt !== null) continue;
      const meta = ctx.cargo.meta(pending.cargoId);
      if (meta.awaitingFetch) ctx.cargo.dispose(pending.cargoId, 'inventory-row-settled');
    }
  }
  const row = draftRecord(ctx.tx, 'fetchRows', id);
  if (request.scope === 'rows') { row.pendingSettlement = []; row.transientSuppressedSlotIds = []; }
  row.appliedRequestId = request.id; row.inventoryRevision = revision; ctx.tx.put('fetchRows', row);
}
/** 已采集的结果事实，绝不重发 HTTP；保留全量和单排两条旧业务路径的不同清算语义。 */
export function completeInventory(ctx: LogisticsContext, payload: LogisticsFetchResultPayload, sourceId: string): void {
  const request = draftRecord(ctx.tx, 'fetchRequests', payload.requestId);
  requireState(request.sourceId === sourceId, 'LOGISTICS_FETCH', '响应来源与查询意图不匹配。');
  if (request.attemptId !== payload.attemptId || request.operationEpoch !== payload.operationEpoch) return;
  if (request.status === 'succeeded' || request.status === 'failed') return;
  const rows = request.rows.filter(item => {
    const row = ctx.tx.get('fetchRows', fetchRowId(request.sourceId, item.row));
    return row?.operationEpoch === request.operationEpoch && row.latestRequestId === request.id && row.latestGeneration === item.generation;
  });
  request.completedAt = ctx.now; request.responseRef = payload.responseRef; request.failure = payload.failure;
  request.status = rows.length === 0 ? 'superseded' : payload.outcome;
  requireState(payload.outcome === 'succeeded' ? payload.responseRef !== null && payload.inventoryRevision !== null : payload.failure !== null,
    'LOGISTICS_FETCH', '查询结果缺少成功证据/库存修订或失败原因。');
  ctx.tx.put('fetchRequests', request);
  if (payload.outcome !== 'succeeded') return;
  for (const row of rows) applyRow(ctx, request, row.row, payload.records, payload.inventoryRevision!);
}
export function pollInventory(ctx: LogisticsContext, sourceId: string): void {
  const source = ctx.manifest.fetchSources.find(source => source.sourceId === sourceId);
  requireState(source, 'LOGISTICS_FETCH', '定时库存来源未声明。');
  // 同一来源任一查询仍在途则跳过本轮，不能抢走单排代际并使它永远不能解除抑制。
  if ([...ctx.tx.values('fetchRequests')].some(request => request.sourceId === sourceId && request.status === 'pending')) return;
  if (source.rowKeys.length === 0) return;
  const rows = source.rowKeys.map(row => draftRecord(ctx.tx, 'fetchRows', fetchRowId(sourceId, row)));
  const epoch = rows[0].operationEpoch;
  requireState(rows.every(row => row.operationEpoch === epoch), 'LOGISTICS_FETCH', '同一来源的排处于不同 worker 操作代次，不能发全量查询。');
  requestInventory(ctx, { sourceId, operationEpoch: epoch, scope: 'full', rows: [...source.rowKeys] });
}
/** 仅返回事实；只有持有 writer fencing 的采集执行器可执行意图，Viewer/seek 不调用网络。 */
export function getPendingLogisticsFetchIntents(view: StateReadView): readonly DeepReadonly<FetchRequestState>[] {
  return [...view.values('fetchRequests')].filter(request => request.status === 'pending').sort((a, b) => a.issuedAt - b.issuedAt || compareText(a.id, b.id));
}
