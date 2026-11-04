import type { HistoryTimelineEvent } from '../../../runtime/history/historyReplayContract.ts';
import type {
  AlarmState, CargoState, DeepReadonly, DeviceState, FetchRowState, JsonObject, SlotState, StateChangeBatch, StateReadView,
  StateTable, StateTableRecords, TransferState,
} from '../../../runtime/history/state/types.ts';
import { canonicalStringify } from '../../../runtime/history/state/safeJson.ts';
import { jsonHash, need } from '../storage/primitives.ts';

export const EVENT_PROJECTION_VERSION = 'history-key-event/1' as const;

/** 仅描述已提交状态中可证明的边沿；时间是该修订的 UTC 逻辑时间，不是反填的设备源时间。 */
export type HistoryEventType =
  | 'alarm.activated' | 'alarm.cleared' | 'alarm.observed-active' | 'alarm.observed-inactive' | 'alarm.unknown'
  | 'transfer.started' | 'transfer.phase-changed' | 'transfer.completed' | 'transfer.cancelled' | 'transfer.host-changed'
  | 'cargo.created' | 'cargo.destroyed' | 'slot.changed' | 'slot.occupied' | 'slot.cleared' | 'inventory.revision-changed' | 'inventory.observed-revision' | 'inventory.revision-unavailable'
  | 'device.created' | 'device.removed';
export type IndexedHistoryEvent = HistoryTimelineEvent & {
  type: HistoryEventType; eventProjectionVersion: typeof EVENT_PROJECTION_VERSION; projectionId: string; versionDigest: string;
  revision: string; ordinal: number; entity: { table: StateTable; id: string };
  evidence: { kind: 'atomic-fact'; factIndex: number; details: DeepReadonly<JsonObject> } | { kind: 'net-change' };
};

const details: Record<HistoryEventType, { kind: HistoryTimelineEvent['kind']; label: string }> = {
  'alarm.activated': { kind: 'alarm', label: '告警激活' },
  'alarm.cleared': { kind: 'alarm', label: '告警解除' },
  'alarm.observed-active': { kind: 'alarm', label: '告警首次观测为活动' },
  'alarm.observed-inactive': { kind: 'alarm', label: '告警观测为未激活' },
  'alarm.unknown': { kind: 'alarm', label: '告警状态未知' },
  'transfer.started': { kind: 'transfer', label: '货物交接开始' },
  'transfer.phase-changed': { kind: 'transfer', label: '交接阶段变更' },
  'transfer.completed': { kind: 'transfer', label: '货物交接完成' },
  'transfer.cancelled': { kind: 'transfer', label: '在途交接取消' },
  'transfer.host-changed': { kind: 'transfer', label: '货物宿主变更' },
  'cargo.created': { kind: 'lifecycle', label: '货物创建' },
  'cargo.destroyed': { kind: 'lifecycle', label: '货物销毁' },
  'slot.changed': { kind: 'stock', label: '库位占用变更' },
  'slot.occupied': { kind: 'stock', label: '库位占用' },
  'slot.cleared': { kind: 'stock', label: '库位清空' },
  'inventory.revision-changed': { kind: 'stock', label: '库存修订变更' },
  'inventory.observed-revision': { kind: 'stock', label: '首次观测库存修订' },
  'inventory.revision-unavailable': { kind: 'stock', label: '库存修订不再可用' },
  'device.created': { kind: 'lifecycle', label: '动态主体创建' },
  'device.removed': { kind: 'lifecycle', label: '动态主体移除' },
};

export function eventId(archiveId: string, event: Pick<IndexedHistoryEvent, 'projectionId' | 'versionDigest' | 'revision' | 'ordinal' | 'type' | 'entity'>): string {
  return jsonHash([EVENT_PROJECTION_VERSION, archiveId, event.projectionId, event.versionDigest, event.revision, event.ordinal, event.type, event.entity]);
}

type AtomicFact = { kind: 'alarm' | 'transfer' | 'stock' | 'lifecycle'; action: string; entityId: string; details: DeepReadonly<JsonObject> };
type ProjectionResult = { events: IndexedHistoryEvent[]; incompleteFrom: number | null; incompleteThrough: number | null };

function projectFact(fact: AtomicFact): { type: HistoryEventType; table: StateTable } {
  need(fact && typeof fact.entityId === 'string' && fact.entityId.length > 0 && fact.entityId.length <= 2048
    && fact.details && typeof fact.details === 'object' && !Array.isArray(fact.details), 'EVENT_FACT', '原子事件缺少实体或事实详情。');
  const d = fact.details as Readonly<Record<string, unknown>>;
  if (fact.kind === 'alarm') {
    need(typeof d.ruleId === 'string' && typeof d.deviceId === 'string'
      && ['absent', 'unknown', 'active', 'inactive'].includes(String(d.previousEdge))
      && ['absent', 'unknown', 'active', 'inactive'].includes(String(d.edge)), 'EVENT_FACT', '告警事实缺少前后知识状态。');
    if (fact.action === 'alarm-activated') { need(d.previousEdge === 'inactive' && d.edge === 'active', 'EVENT_FACT', '告警激活边沿不可证明。'); return { type: 'alarm.activated', table: 'alarms' }; }
    if (fact.action === 'alarm-cleared') { need(d.previousEdge === 'active' && d.edge === 'inactive', 'EVENT_FACT', '告警解除边沿不可证明。'); return { type: 'alarm.cleared', table: 'alarms' }; }
    if (fact.action === 'alarm-observed-active') { need((d.previousEdge === 'unknown' || d.previousEdge === 'absent') && d.edge === 'active', 'EVENT_FACT', '首次活动观测边沿无效。'); return { type: 'alarm.observed-active', table: 'alarms' }; }
    if (fact.action === 'alarm-observed-inactive') { need((d.previousEdge === 'unknown' || d.previousEdge === 'absent') && d.edge === 'inactive', 'EVENT_FACT', '首次未激活观测边沿无效。'); return { type: 'alarm.observed-inactive', table: 'alarms' }; }
    if (fact.action === 'alarm-state-unknown') { need(d.edge === 'unknown' || d.edge === 'absent', 'EVENT_FACT', '告警未知状态边沿无效。'); return { type: 'alarm.unknown', table: 'alarms' }; }
  } else if (fact.kind === 'transfer') {
    if (fact.action === 'cargo-host-changed') {
      need(Object.hasOwn(d, 'from') && Object.hasOwn(d, 'to') && d.from !== null && d.to !== null
        && canonicalStringify(d.from) !== canonicalStringify(d.to), 'EVENT_FACT', '货物宿主变更缺少不同的前后宿主。');
      return { type: 'transfer.host-changed', table: 'cargo' };
    }
    need(typeof d.cargoId === 'string' && Object.hasOwn(d, 'from') && Object.hasOwn(d, 'to')
      && Object.hasOwn(d, 'previousPhase') && Object.hasOwn(d, 'phase'), 'EVENT_FACT', '交接事实缺少货物、端点或阶段。');
    if (fact.action === 'transfer-started') return { type: 'transfer.started', table: 'transfers' };
    if (fact.action === 'transfer-phase-changed') return { type: 'transfer.phase-changed', table: 'transfers' };
    if (fact.action === 'transfer-completed') return { type: 'transfer.completed', table: 'transfers' };
    if (fact.action === 'transfer-cancelled') return { type: 'transfer.cancelled', table: 'transfers' };
  } else if (fact.kind === 'stock') {
    if (fact.action === 'inventory-revision-changed') {
      need((d.recordTable === 'slots' || d.recordTable === 'fetchRows') && Object.hasOwn(d, 'previousRevision')
        && Object.hasOwn(d, 'nextRevision') && d.previousRevision !== d.nextRevision, 'EVENT_FACT', '库存修订事实缺少可证明的前后值。');
      const type = d.previousRevision === null ? 'inventory.observed-revision' : d.nextRevision === null
        ? 'inventory.revision-unavailable' : 'inventory.revision-changed';
      return { type, table: d.recordTable };
    }
    need(Object.hasOwn(d, 'previousCargoId') && Object.hasOwn(d, 'nextCargoId') && Object.hasOwn(d, 'inventoryRevision')
      && d.previousCargoId !== d.nextCargoId, 'EVENT_FACT', '库位事实缺少不同的前后占用。');
    if (fact.action === 'slot-occupied') { need(d.previousCargoId === null && typeof d.nextCargoId === 'string', 'EVENT_FACT', '库位占用边沿无效。'); return { type: 'slot.occupied', table: 'slots' }; }
    if (fact.action === 'slot-cleared') { need(typeof d.previousCargoId === 'string' && d.nextCargoId === null, 'EVENT_FACT', '库位清空边沿无效。'); return { type: 'slot.cleared', table: 'slots' }; }
    if (fact.action === 'slot-changed') return { type: 'slot.changed', table: 'slots' };
  } else if (fact.kind === 'lifecycle') {
    if (fact.action === 'cargo-created') { need(Object.hasOwn(d, 'containerCode') && Object.hasOwn(d, 'taskId'), 'EVENT_FACT', '货物创建事实缺少身份字段。'); return { type: 'cargo.created', table: 'cargo' }; }
    if (fact.action === 'cargo-destroyed') { need(typeof d.reason === 'string' && d.reason.length > 0, 'EVENT_FACT', '货物销毁事实缺少原因。'); return { type: 'cargo.destroyed', table: 'cargo' }; }
    if (fact.action === 'device-born' || fact.action === 'device-retired') {
      need(['sourceId', 'deviceType', 'assetCode', 'generatorId', 'generation'].every(key => Object.hasOwn(d, key)), 'EVENT_FACT', '动态主体事实缺少来源身份。');
      return { type: fact.action === 'device-born' ? 'device.created' : 'device.removed', table: 'devices' };
    }
  }
  need(false, 'EVENT_FACT', '原子事件包含不支持的事实类型或动作，不能伪造标签。');
}

/** 从 follower 的实际前态和逐修订 overlay 推导；不在 Viewer 执行业务规则。 */
export function deriveEvents(archiveId: string, versionDigest: string, batch: DeepReadonly<StateChangeBatch>, before: StateReadView,
  maxEvents: number): ProjectionResult {
  const overlay = new Map<string, DeepReadonly<StateTableRecords[StateTable]> | null>();
  const result: IndexedHistoryEvent[] = [];
  let incompleteFrom: number | null = null, incompleteThrough: number | null = null;
  for (const revision of batch.revisions) {
    need(revision.continuity.status === 'complete' && revision.cause.kind !== 'gap', 'CONTINUITY_GAP', '关键事件不能跨越未修复的状态缺口。');
    let ordinal = 0;
    const emit = (type: HistoryEventType, table: StateTable, id: string, evidence: IndexedHistoryEvent['evidence'] = { kind: 'net-change' }): void => {
      need(result.length < maxEvents, 'EVENT_BUDGET', '单次事件投影超过上限，未推进索引。');
      const core = { eventProjectionVersion: EVENT_PROJECTION_VERSION, projectionId: batch.projectionId, versionDigest, revision: revision.revision, ordinal: ordinal++, type, entity: { table, id } };
      result.push({ ...core, id: eventId(archiveId, core), time: revision.logicalTime, ...details[type], evidence });
    };
    // facts 字段存在（包括空数组）表示该修订的受支持边沿已完整记录；缺失是旧格式，不能将净差异冒充完整事实。
    const facts = (revision as unknown as { facts?: readonly AtomicFact[] }).facts;
    if (facts !== undefined) {
      need(Array.isArray(facts), 'EVENT_FACT', '原子事实不是有效数组。');
      for (let index = 0; index < facts.length; index += 1) {
        const fact = facts[index], projected = projectFact(fact);
        emit(projected.type, projected.table, fact.entityId, { kind: 'atomic-fact', factIndex: index, details: fact.details });
      }
      for (const change of revision.changes) {
        const id = change.op === 'put' ? change.record.id : change.id;
        overlay.set(JSON.stringify([change.table, id]), change.op === 'put' ? change.record : null);
      }
      continue;
    }
    incompleteFrom ??= revision.logicalTime; incompleteThrough = revision.logicalTime;
    for (const change of revision.changes) {
      const id = change.op === 'put' ? change.record.id : change.id, key = JSON.stringify([change.table, id]);
      const old = overlay.has(key) ? overlay.get(key) ?? undefined : before.get(change.table, id);
      const next = change.op === 'put' ? change.record : undefined;
      if (change.table === 'alarms') {
        const a = old as DeepReadonly<AlarmState> | undefined, b = next as DeepReadonly<AlarmState> | undefined;
        if (a && !b && a.active) need(false, 'UNPROVEN_EDGE', '活动告警记录被移除，无法证明已经解除。');
        if (b) {
          if (b.active && !a?.active) {
            need(b.activatedAt === revision.logicalTime, 'UNPROVEN_EDGE', '活动告警缺少本修订的激活观测。');
            emit(a?.edge === 'inactive' ? 'alarm.activated' : 'alarm.observed-active', change.table, id);
          } else if (a?.active && !b.active) {
            need(b.clearedAt === revision.logicalTime, 'UNPROVEN_EDGE', '告警活动状态变化缺少本修订的观测。');
            emit(b.edge === 'inactive' ? 'alarm.cleared' : 'alarm.unknown', change.table, id);
          } else if (a?.edge === 'unknown' && b.edge === 'inactive') emit('alarm.observed-inactive', change.table, id);
        }
      } else if (change.table === 'cargo') {
        const a = old as DeepReadonly<CargoState> | undefined, b = next as DeepReadonly<CargoState> | undefined;
        if (!a && b) {
          need(b.createdAt === revision.logicalTime, 'UNPROVEN_EDGE', '新增货物创建时间不在该修订，无法定位事件。');
          emit('cargo.created', change.table, id);
          if (b.destroyedAt !== null) {
            need(b.destroyedAt === revision.logicalTime, 'UNPROVEN_EDGE', '同修订创建和销毁的时间不明确。'); emit('cargo.destroyed', change.table, id);
          }
        } else if (a && !b) need(a.destroyedAt !== null, 'UNPROVEN_EDGE', '活货物记录被移除，不能推断销毁。');
        else if (a && b) {
          if (a.destroyedAt === null && b.destroyedAt !== null) {
            need(b.destroyedAt === revision.logicalTime, 'UNPROVEN_EDGE', '货物销毁时间不在该修订。'); emit('cargo.destroyed', change.table, id);
          } else if (a.destroyedAt === null && b.destroyedAt === null && a.host && b.host
            && canonicalStringify(a.host) !== canonicalStringify(b.host)) emit('transfer.host-changed', change.table, id);
        }
      } else if (change.table === 'transfers') {
        const a = old as DeepReadonly<TransferState> | undefined, b = next as DeepReadonly<TransferState> | undefined;
        if (a && !b) need(a.phase === 'complete' || a.phase === 'cancelled', 'UNPROVEN_EDGE', '未完成交接被移除，无法证明实际结果。');
        if (a && b) {
          need(canonicalStringify([a.cargoId, a.from, a.to, a.startedAt]) === canonicalStringify([b.cargoId, b.from, b.to, b.startedAt]),
            'UNPROVEN_EDGE', '同一交接身份的来源、目标或起点发生变化。');
          need(a.phase === b.phase || (a.phase === 'pending' && ['in-flight', 'complete', 'cancelled'].includes(b.phase))
            || (a.phase === 'in-flight' && ['complete', 'cancelled'].includes(b.phase)), 'UNPROVEN_EDGE', '交接阶段倒退或终态复用，不能推断新事件。');
        }
        if (b && a?.phase !== b.phase) {
          if (b.phase === 'in-flight') { need(a ? b.startedAt <= revision.logicalTime : b.startedAt === revision.logicalTime,
            'UNPROVEN_EDGE', '新增在途交接缺少本修订的开始证据。'); emit('transfer.started', change.table, id); }
          if (b.phase === 'complete') { need(b.completedAt === revision.logicalTime, 'UNPROVEN_EDGE', '交接完成时间不在该修订。'); emit('transfer.completed', change.table, id); }
          if (b.phase === 'cancelled' && a?.phase === 'in-flight') { need(b.completedAt === revision.logicalTime, 'UNPROVEN_EDGE', '交接取消时间不在该修订。'); emit('transfer.cancelled', change.table, id); }
        }
      } else if (change.table === 'slots') {
        const a = old as DeepReadonly<SlotState> | undefined, b = next as DeepReadonly<SlotState> | undefined;
        need(a && b, 'UNPROVEN_EDGE', '库位状态缺少真实前态或后态，不能按空库推断。');
        if (a.cargoId !== b.cargoId) emit('slot.changed', change.table, id);
        if (a.inventoryRevision !== b.inventoryRevision) {
          need(b.inventoryRevision !== null, 'UNPROVEN_EDGE', '已观测的库位库存修订消失，不能推断库存状态。');
          emit(a.inventoryRevision === null ? 'inventory.observed-revision' : 'inventory.revision-changed', change.table, id);
        }
      } else if (change.table === 'fetchRows') {
        const a = old as DeepReadonly<FetchRowState> | undefined, b = next as DeepReadonly<FetchRowState> | undefined;
        if (a?.inventoryRevision !== null && a?.inventoryRevision !== undefined && (!b || b.inventoryRevision === null))
          need(false, 'UNPROVEN_EDGE', '已观测的库存修订消失，不能推断库存状态。');
        if (b?.inventoryRevision !== null && b?.inventoryRevision !== undefined && a?.inventoryRevision !== b.inventoryRevision)
          emit(a?.inventoryRevision == null ? 'inventory.observed-revision' : 'inventory.revision-changed', change.table, id);
      } else if (change.table === 'devices') {
        const a = old as DeepReadonly<DeviceState> | undefined, b = next as DeepReadonly<DeviceState> | undefined;
        if (!a && b?.dynamic) { need(b.dynamic.bornAt === revision.logicalTime, 'UNPROVEN_EDGE', '动态主体出生时间不在该修订。'); emit('device.created', change.table, id); }
        else if (a?.dynamic && !b) emit('device.removed', change.table, id);
      }
      overlay.set(key, next ?? null);
    }
  }
  return { events: result, incompleteFrom, incompleteThrough };
}

export function validateIndexedEvent(archiveId: string, event: IndexedHistoryEvent, projectionId: string, versionDigest: string): void {
  const spec = details[event.type];
  need(spec && event.eventProjectionVersion === EVENT_PROJECTION_VERSION && event.projectionId === projectionId && event.versionDigest === versionDigest && event.kind === spec.kind
    && event.label === spec.label && event.id === eventId(archiveId, event)
    && Number.isSafeInteger(event.time) && event.time >= 0 && event.time <= 8_640_000_000_000_000
    && Number.isSafeInteger(event.ordinal) && event.ordinal >= 0
    && typeof event.entity?.id === 'string' && event.entity.id.length > 0
    && (event.evidence?.kind === 'net-change' || event.evidence?.kind === 'atomic-fact'
      && Number.isSafeInteger(event.evidence.factIndex) && event.evidence.factIndex >= 0
      && event.evidence.details !== null && typeof event.evidence.details === 'object' && !Array.isArray(event.evidence.details)),
  'CORRUPT_EVENT', '事件身份、类型或时间无效。');
}
