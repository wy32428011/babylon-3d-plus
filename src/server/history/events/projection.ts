import type { HistoryTimelineEvent } from '../../../runtime/history/historyReplayContract.ts';
import type {
  AlarmState, CargoState, DeepReadonly, DeviceState, FetchRowState, JsonObject, SlotState, StateChangeBatch, StateReadView,
  StateTable, StateTableRecords, TransferState,
} from '../../../runtime/history/state/types.ts';
import { TWIN_FACTS_VERSION } from '../../../runtime/history/state/types.ts';
import { canonicalStringify } from '../../../runtime/history/state/safeJson.ts';
import { jsonHash, need } from '../storage/primitives.ts';

export const EVENT_PROJECTION_VERSION = 'history-key-event/2' as const;

/** 仅描述已提交状态中可证明的边沿；时间是该修订的 UTC 逻辑时间，不是反填的设备源时间。 */
export type HistoryEventType =
  | 'alarm.activated' | 'alarm.cleared' | 'alarm.observed-active' | 'alarm.observed-inactive' | 'alarm.unknown'
  | 'transfer.started' | 'transfer.observed' | 'transfer.phase-changed' | 'transfer.completed' | 'transfer.cancelled' | 'transfer.unavailable' | 'transfer.host-changed' | 'transfer.host-observed'
  | 'cargo.created' | 'cargo.observed' | 'cargo.destroyed' | 'cargo.observed-destroyed' | 'slot.changed' | 'slot.occupied' | 'slot.cleared' | 'slot.observed' | 'slot.unavailable' | 'inventory.revision-changed' | 'inventory.observed-revision' | 'inventory.revision-unavailable'
  | 'device.created' | 'device.observed' | 'device.removed';
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
  'transfer.observed': { kind: 'transfer', label: '观测交接记录' },
  'transfer.phase-changed': { kind: 'transfer', label: '交接阶段变更' },
  'transfer.completed': { kind: 'transfer', label: '货物交接完成' },
  'transfer.cancelled': { kind: 'transfer', label: '在途交接取消' },
  'transfer.unavailable': { kind: 'transfer', label: '交接记录不再可用' },
  'transfer.host-changed': { kind: 'transfer', label: '货物宿主变更' },
  'transfer.host-observed': { kind: 'transfer', label: '首次观测货物宿主' },
  'cargo.created': { kind: 'lifecycle', label: '货物创建' },
  'cargo.observed': { kind: 'lifecycle', label: '首次观测货物' },
  'cargo.destroyed': { kind: 'lifecycle', label: '货物销毁' },
  'cargo.observed-destroyed': { kind: 'lifecycle', label: '观测到货物已销毁' },
  'slot.changed': { kind: 'stock', label: '库位占用变更' },
  'slot.occupied': { kind: 'stock', label: '库位占用' },
  'slot.cleared': { kind: 'stock', label: '库位清空' },
  'slot.observed': { kind: 'stock', label: '观测库位状态' },
  'slot.unavailable': { kind: 'stock', label: '库位状态不再可用' },
  'inventory.revision-changed': { kind: 'stock', label: '库存修订变更' },
  'inventory.observed-revision': { kind: 'stock', label: '首次观测库存修订' },
  'inventory.revision-unavailable': { kind: 'stock', label: '库存修订不再可用' },
  'device.created': { kind: 'lifecycle', label: '动态主体创建' },
  'device.observed': { kind: 'lifecycle', label: '观测动态主体' },
  'device.removed': { kind: 'lifecycle', label: '动态主体移除' },
};

export function eventId(archiveId: string, event: Pick<IndexedHistoryEvent, 'projectionId' | 'versionDigest' | 'revision' | 'ordinal' | 'type' | 'entity'>): string {
  return jsonHash([EVENT_PROJECTION_VERSION, archiveId, event.projectionId, event.versionDigest, event.revision, event.ordinal, event.type, event.entity]);
}

type AtomicFact = { kind: 'alarm' | 'transfer' | 'stock' | 'lifecycle'; action: string; entityId: string; details: DeepReadonly<JsonObject> };
export type IncompleteEventRange = { firstTime: number; lastTime: number };
type ProjectionResult = { events: IndexedHistoryEvent[]; incompleteRanges: IncompleteEventRange[] };

function projectFact(fact: AtomicFact, logicalTime: number, strict: boolean): { type: HistoryEventType; table: StateTable } {
  need(fact && typeof fact.entityId === 'string' && fact.entityId.length > 0 && fact.entityId.length <= 2048
    && fact.details && typeof fact.details === 'object' && !Array.isArray(fact.details), 'EVENT_FACT', '原子事件缺少实体或事实详情。');
  const d = fact.details as Readonly<Record<string, unknown>>;
  const validTime = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= logicalTime;
  const nullableId = (value: unknown): boolean => value === null || typeof value === 'string' && value.length > 0;
  if (fact.kind === 'alarm') {
    need(typeof d.ruleId === 'string' && typeof d.deviceId === 'string'
      && ['absent', 'unknown', 'active', 'inactive'].includes(String(d.previousEdge))
      && ['absent', 'unknown', 'active', 'inactive'].includes(String(d.edge)) && d.previousEdge !== d.edge,
    'EVENT_FACT', '告警事实缺少不同的前后知识状态。');
    if (fact.action === 'alarm-activated') { need(d.previousEdge === 'inactive' && d.edge === 'active', 'EVENT_FACT', '告警激活边沿不可证明。'); return { type: 'alarm.activated', table: 'alarms' }; }
    if (fact.action === 'alarm-cleared') { need(d.previousEdge === 'active' && d.edge === 'inactive', 'EVENT_FACT', '告警解除边沿不可证明。'); return { type: 'alarm.cleared', table: 'alarms' }; }
    if (fact.action === 'alarm-observed-active') { need((d.previousEdge === 'unknown' || d.previousEdge === 'absent') && d.edge === 'active', 'EVENT_FACT', '首次活动观测边沿无效。'); return { type: 'alarm.observed-active', table: 'alarms' }; }
    if (fact.action === 'alarm-observed-inactive') { need((d.previousEdge === 'unknown' || d.previousEdge === 'absent') && d.edge === 'inactive', 'EVENT_FACT', '首次未激活观测边沿无效。'); return { type: 'alarm.observed-inactive', table: 'alarms' }; }
    if (fact.action === 'alarm-state-unknown') { need(d.edge === 'unknown' || d.edge === 'absent', 'EVENT_FACT', '告警未知状态边沿无效。'); return { type: 'alarm.unknown', table: 'alarms' }; }
  } else if (fact.kind === 'transfer') {
    if (fact.action === 'cargo-host-changed') {
      need(Object.hasOwn(d, 'from') && Object.hasOwn(d, 'to') && canonicalStringify(d.from) !== canonicalStringify(d.to),
        'EVENT_FACT', '货物宿主变更缺少不同的前后宿主。');
      return { type: 'transfer.host-changed', table: 'cargo' };
    }
    if (fact.action === 'cargo-host-observed') {
      need(d.host !== null && typeof d.host === 'object' && !Array.isArray(d.host), 'EVENT_FACT', '货物宿主观测缺少宿主。');
      return { type: 'transfer.host-observed', table: 'cargo' };
    }
    const phases = ['pending', 'in-flight', 'complete', 'cancelled'];
    need(typeof d.cargoId === 'string' && d.from !== null && typeof d.from === 'object' && d.to !== null && typeof d.to === 'object'
      && (d.previousPhase === null || phases.includes(String(d.previousPhase))) && (d.phase === null || phases.includes(String(d.phase)))
      && (!strict || validTime(d.startedAt) && (d.completedAt === null || validTime(d.completedAt))), 'EVENT_FACT', '交接事实缺少货物、端点、阶段或时间。');
    const currentPhase = d.phase ?? d.previousPhase;
    need(!strict || (currentPhase === 'pending' || currentPhase === 'in-flight' ? d.completedAt === null
      : currentPhase !== null && typeof d.completedAt === 'number' && d.completedAt >= (d.startedAt as number)),
    'EVENT_FACT', '交接阶段与完成时间不一致。');
    if (fact.action === 'transfer-unavailable') { need(d.previousPhase !== null && d.phase === null, 'EVENT_FACT', '交接记录消失边沿无效。'); return { type: 'transfer.unavailable', table: 'transfers' }; }
    if (fact.action === 'transfer-started') { need(d.previousPhase === null && d.phase !== null && (!strict || d.startedAt === logicalTime), 'EVENT_FACT', '交接开始缺少本修订证据。'); return { type: 'transfer.started', table: 'transfers' }; }
    if (fact.action === 'transfer-observed') { need(d.previousPhase === null && d.phase !== null && (!strict || (d.startedAt as number) <= logicalTime), 'EVENT_FACT', '交接首次观测无效。'); return { type: 'transfer.observed', table: 'transfers' }; }
    if (fact.action === 'transfer-phase-changed') { need(d.previousPhase !== null && d.phase !== null && d.previousPhase !== d.phase, 'EVENT_FACT', '交接阶段没有变化。'); return { type: 'transfer.phase-changed', table: 'transfers' }; }
    if (fact.action === 'transfer-completed') { need(d.phase === 'complete' && d.previousPhase !== d.phase && (!strict || d.completedAt === logicalTime), 'EVENT_FACT', '交接完成缺少本修订证据。'); return { type: 'transfer.completed', table: 'transfers' }; }
    if (fact.action === 'transfer-cancelled') { need(d.phase === 'cancelled' && d.previousPhase !== d.phase && (!strict || d.completedAt === logicalTime), 'EVENT_FACT', '交接取消缺少本修订证据。'); return { type: 'transfer.cancelled', table: 'transfers' }; }
  } else if (fact.kind === 'stock') {
    if (fact.action === 'inventory-revision-changed') {
      need((d.recordTable === 'slots' || d.recordTable === 'fetchRows') && nullableId(d.previousRevision)
        && nullableId(d.nextRevision) && d.previousRevision !== d.nextRevision, 'EVENT_FACT', '库存修订事实缺少可证明的前后值。');
      const type = d.previousRevision === null ? 'inventory.observed-revision' : d.nextRevision === null
        ? 'inventory.revision-unavailable' : 'inventory.revision-changed';
      return { type, table: d.recordTable };
    }
    if (fact.action === 'slot-observed' || fact.action === 'slot-unavailable') {
      need(nullableId(d.cargoId) && nullableId(d.inventoryRevision), 'EVENT_FACT', '库位观测缺少占用或库存修订。');
      return { type: fact.action === 'slot-observed' ? 'slot.observed' : 'slot.unavailable', table: 'slots' };
    }
    need(nullableId(d.previousCargoId) && nullableId(d.nextCargoId) && nullableId(d.inventoryRevision)
      && d.previousCargoId !== d.nextCargoId, 'EVENT_FACT', '库位事实缺少不同的前后占用。');
    if (fact.action === 'slot-occupied') { need(d.previousCargoId === null && typeof d.nextCargoId === 'string', 'EVENT_FACT', '库位占用边沿无效。'); return { type: 'slot.occupied', table: 'slots' }; }
    if (fact.action === 'slot-cleared') { need(typeof d.previousCargoId === 'string' && d.nextCargoId === null, 'EVENT_FACT', '库位清空边沿无效。'); return { type: 'slot.cleared', table: 'slots' }; }
    if (fact.action === 'slot-changed') { need(typeof d.previousCargoId === 'string' && typeof d.nextCargoId === 'string', 'EVENT_FACT', '库位替换边沿无效。'); return { type: 'slot.changed', table: 'slots' }; }
  } else if (fact.kind === 'lifecycle') {
    if (fact.action === 'cargo-created' || fact.action === 'cargo-observed') {
      need(nullableId(d.containerCode) && nullableId(d.taskId) && (!strict || validTime(d.createdAt)
        && (fact.action === 'cargo-created' ? d.createdAt === logicalTime : (d.createdAt as number) < logicalTime)), 'EVENT_FACT', '货物身份或创建时间缺少证据。');
      return { type: fact.action === 'cargo-created' ? 'cargo.created' : 'cargo.observed', table: 'cargo' };
    }
    if (fact.action === 'cargo-destroyed' || fact.action === 'cargo-observed-destroyed') {
      need(typeof d.reason === 'string' && d.reason.length > 0 && (!strict || validTime(d.destroyedAt)
        && (fact.action === 'cargo-destroyed' ? d.destroyedAt === logicalTime : (d.destroyedAt as number) < logicalTime)), 'EVENT_FACT', '货物销毁缺少原因或时间证据。');
      return { type: fact.action === 'cargo-destroyed' ? 'cargo.destroyed' : 'cargo.observed-destroyed', table: 'cargo' };
    }
    if (fact.action === 'device-born' || fact.action === 'device-observed' || fact.action === 'device-retired') {
      need(['sourceId', 'deviceType', 'assetCode', 'generatorId', 'generation'].every(key => typeof d[key] === 'string' && (d[key] as string).length > 0)
        && (!strict || validTime(d.bornAt) && (fact.action === 'device-born' ? d.bornAt === logicalTime
          : fact.action === 'device-observed' ? (d.bornAt as number) <= logicalTime : true)), 'EVENT_FACT', '动态主体事实缺少来源身份或时间。');
      return { type: fact.action === 'device-born' ? 'device.created' : fact.action === 'device-observed' ? 'device.observed' : 'device.removed', table: 'devices' };
    }
  }
  need(false, 'EVENT_FACT', '原子事件包含不支持的事实类型或动作，不能伪造标签。');
}

type ProjectedFact = { fact: AtomicFact; table: StateTable; type: HistoryEventType };
type FactShadow = Record<string, unknown> | null;

/** 逐事实校验可见前态、顺序及最终净状态；同修订中间写入仍由受控生产者提供。 */
function assertFactCoverage(facts: readonly ProjectedFact[], changes: DeepReadonly<StateChangeBatch>['revisions'][number]['changes'],
  overlay: Map<string, DeepReadonly<StateTableRecords[StateTable]> | null>, before: StateReadView): void {
  const tracked = new Map<string, { table: StateTable; id: string; value: FactShadow }>();
  const final = new Map<string, DeepReadonly<StateTableRecords[StateTable]> | null>();
  const keyOf = (table: StateTable, id: string): string => JSON.stringify([table, id]);
  const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
  const prior = (table: StateTable, id: string): DeepReadonly<StateTableRecords[StateTable]> | undefined => {
    const key = keyOf(table, id);
    return overlay.has(key) ? overlay.get(key) ?? undefined : before.get(table, id);
  };
  const normalize = (table: StateTable, value: DeepReadonly<StateTableRecords[StateTable]> | undefined): FactShadow => {
    if (table === 'alarms') {
      const a = value as DeepReadonly<AlarmState> | undefined;
      return a ? { ruleId: a.ruleId, deviceId: a.deviceId, edge: a.edge } : null;
    }
    if (table === 'cargo') {
      const a = value as DeepReadonly<CargoState> | undefined;
      return a ? { createdAt: a.createdAt, destroyedAt: a.destroyedAt, destroyReason: a.destroyReason, host: a.host } : null;
    }
    if (table === 'transfers') {
      const a = value as DeepReadonly<TransferState> | undefined;
      return a ? { cargoId: a.cargoId, from: a.from, to: a.to, startedAt: a.startedAt, phase: a.phase, completedAt: a.completedAt } : null;
    }
    if (table === 'slots') {
      const a = value as DeepReadonly<SlotState> | undefined;
      return { present: Boolean(a), cargoId: a?.cargoId ?? null, inventoryRevision: a?.inventoryRevision ?? null };
    }
    if (table === 'fetchRows') return { inventoryRevision: (value as DeepReadonly<FetchRowState> | undefined)?.inventoryRevision ?? null };
    if (table === 'devices') {
      const a = value as DeepReadonly<DeviceState> | undefined;
      return a?.dynamic ? { sourceId: a.identity.sourceId, deviceType: a.identity.deviceType, assetCode: a.identity.assetCode,
        generatorId: a.dynamic.generatorId, generation: a.dynamic.generation, bornAt: a.dynamic.bornAt } : null;
    }
    return null;
  };
  const relevant = new Set<StateTable>(['alarms', 'cargo', 'transfers', 'slots', 'fetchRows', 'devices']);
  const track = (table: StateTable, id: string): { table: StateTable; id: string; value: FactShadow } => {
    const key = keyOf(table, id); let item = tracked.get(key);
    if (!item) { item = { table, id, value: normalize(table, prior(table, id)) }; tracked.set(key, item); }
    return item;
  };
  for (const change of changes) {
    if (!relevant.has(change.table)) continue;
    const id = change.op === 'put' ? change.record.id : change.id;
    track(change.table, id); final.set(keyOf(change.table, id), change.op === 'put' ? change.record : null);
  }
  for (let index = 0; index < facts.length; index += 1) {
    const { fact, table } = facts[index];
    const item = track(table, fact.entityId), d = fact.details as Readonly<Record<string, unknown>>, value = item.value;
    if (fact.kind === 'alarm') {
      need((value?.edge ?? 'absent') === d.previousEdge && (!value || value.ruleId === d.ruleId && value.deviceId === d.deviceId),
        'EVENT_FACT', '告警事实与实际前态或同修订顺序不一致。');
      item.value = d.edge === 'absent' ? null : { ruleId: d.ruleId, deviceId: d.deviceId, edge: d.edge };
    } else if (table === 'transfers') {
      const identity = { cargoId: d.cargoId, from: d.from, to: d.to, startedAt: d.startedAt };
      if (fact.action === 'transfer-started' || fact.action === 'transfer-observed') {
        need(value === null, 'EVENT_FACT', '交接首次观测与实际前态不一致。');
        item.value = { ...identity, phase: d.phase, completedAt: d.completedAt };
      } else {
        const previous = facts[index - 1]?.fact;
        need(value && same({ cargoId: value.cargoId, from: value.from, to: value.to, startedAt: value.startedAt }, identity)
          && (d.previousPhase === null ? value.phase === d.phase && previous?.entityId === fact.entityId
            && (previous.action === 'transfer-started' || previous.action === 'transfer-observed')
            : value.phase === d.previousPhase)
          && (fact.action !== 'transfer-unavailable' || value.completedAt === d.completedAt),
        'EVENT_FACT', '交接事实与实际前态或同修订顺序不一致。');
        item.value = fact.action === 'transfer-unavailable' ? null : { ...identity, phase: d.phase, completedAt: d.completedAt };
      }
    } else if (table === 'cargo') {
      if (fact.action === 'cargo-created' || fact.action === 'cargo-observed') {
        need(value === null, 'EVENT_FACT', '货物首次观测与实际前态不一致。');
        item.value = { createdAt: d.createdAt, destroyedAt: null, destroyReason: null, host: null };
      } else if (fact.action === 'cargo-destroyed' || fact.action === 'cargo-observed-destroyed') {
        need(value && value.destroyedAt === null, 'EVENT_FACT', '货物销毁事实与实际前态不一致。');
        item.value = { ...value, destroyedAt: d.destroyedAt, destroyReason: d.reason };
      } else if (fact.action === 'cargo-host-observed') {
        need(value && value.host === null, 'EVENT_FACT', '货物宿主首次观测与实际前态不一致。');
        item.value = { ...value, host: d.host };
      } else {
        need(value && same(value.host, d.from), 'EVENT_FACT', '货物宿主事实与实际前态或同修订顺序不一致。');
        item.value = { ...value, host: d.to };
      }
    } else if (table === 'slots' || table === 'fetchRows') {
      need(value, 'EVENT_FACT', '库存事实缺少前态。');
      if (table === 'slots' && fact.action !== 'inventory-revision-changed') {
        const following = facts[index + 1]?.fact;
        const followingRevision = fact.action !== 'slot-unavailable' && following?.action === 'inventory-revision-changed'
          && following.entityId === fact.entityId && following.details.recordTable === 'slots'
          ? following.details.nextRevision : value.inventoryRevision;
        need(d.inventoryRevision === value.inventoryRevision || d.inventoryRevision === followingRevision,
          'EVENT_FACT', '库位事实中的库存修订与相邻写入不一致。');
      }
      if (fact.action === 'inventory-revision-changed') {
        need(value.inventoryRevision === d.previousRevision, 'EVENT_FACT', '库存修订事实与实际前态不一致。');
        item.value = { ...value, inventoryRevision: d.nextRevision };
      } else if (fact.action === 'slot-observed') {
        need(value.present === false, 'EVENT_FACT', '库位首次观测与实际前态不一致。');
        item.value = { ...value, present: true, cargoId: d.cargoId };
      } else if (fact.action === 'slot-unavailable') {
        need(value.present === true && value.cargoId === d.cargoId, 'EVENT_FACT', '库位消失事实与实际前态不一致。');
        item.value = { ...value, present: false, cargoId: null };
      } else {
        need(value.present === true && value.cargoId === d.previousCargoId, 'EVENT_FACT', '库位事实与实际前态不一致。');
        item.value = { ...value, cargoId: d.nextCargoId };
      }
    } else if (table === 'devices') {
      const identity = { sourceId: d.sourceId, deviceType: d.deviceType, assetCode: d.assetCode,
        generatorId: d.generatorId, generation: d.generation, bornAt: d.bornAt };
      if (fact.action === 'device-retired') { need(same(value, identity), 'EVENT_FACT', '动态主体移除事实与实际前态不一致。'); item.value = null; }
      else { need(value === null, 'EVENT_FACT', '动态主体首次观测与实际前态不一致。'); item.value = identity; }
    }
  }
  for (const [key, item] of tracked) {
    const target = final.has(key) ? final.get(key) ?? undefined : prior(item.table, item.id);
    need(same(item.value, normalize(item.table, target)), 'EVENT_FACT', '原子事实未覆盖实际净变化或与最终状态不一致。');
  }
}

/** 从 follower 的实际前态和逐修订 overlay 推导；不在 Viewer 执行业务规则。 */
export function deriveEvents(archiveId: string, versionDigest: string, batch: DeepReadonly<StateChangeBatch>, before: StateReadView,
  maxEvents: number): ProjectionResult {
  const overlay = new Map<string, DeepReadonly<StateTableRecords[StateTable]> | null>();
  const result: IndexedHistoryEvent[] = [], incompleteRanges: IncompleteEventRange[] = [];
  for (const revision of batch.revisions) {
    need(revision.continuity.status === 'complete' && revision.cause.kind !== 'gap', 'CONTINUITY_GAP', '关键事件不能跨越未修复的状态缺口。');
    let ordinal = 0;
    const emit = (type: HistoryEventType, table: StateTable, id: string, evidence: IndexedHistoryEvent['evidence']): void => {
      need(result.length < maxEvents, 'EVENT_BUDGET', '单次事件投影超过上限，未推进索引。');
      const core = { eventProjectionVersion: EVENT_PROJECTION_VERSION, projectionId: batch.projectionId, versionDigest, revision: revision.revision, ordinal: ordinal++, type, entity: { table, id } };
      result.push({ ...core, id: eventId(archiveId, core), time: revision.logicalTime, ...details[type], evidence });
    };
    // 老批次和旧语义事实都无法证明覆盖；不要从最终净状态猜测缺失的中间事件。
    const complete = revision.facts !== undefined && revision.factsVersion === TWIN_FACTS_VERSION;
    if (!complete) {
      const last = incompleteRanges[incompleteRanges.length - 1];
      if (last && revision.logicalTime <= last.lastTime + 1) last.lastTime = revision.logicalTime;
      else incompleteRanges.push({ firstTime: revision.logicalTime, lastTime: revision.logicalTime });
    }
    if (revision.facts !== undefined) {
      need(Array.isArray(revision.facts), 'EVENT_FACT', '原子事实不是有效数组。');
      need(revision.facts.length <= maxEvents - result.length, 'EVENT_BUDGET', '单次事件投影超过上限，未推进索引。');
      const projected = revision.facts.map(fact => ({ fact, ...projectFact(fact, revision.logicalTime, complete) }));
      if (complete) assertFactCoverage(projected, revision.changes, overlay, before);
      for (let index = 0; index < projected.length; index += 1) {
        const { fact, type, table } = projected[index];
        emit(type, table, fact.entityId, { kind: 'atomic-fact', factIndex: index, details: fact.details });
      }
    }
    for (const change of revision.changes) {
      const id = change.op === 'put' ? change.record.id : change.id;
      overlay.set(JSON.stringify([change.table, id]), change.op === 'put' ? change.record : null);
    }
  }
  return { events: result, incompleteRanges };
}

export function validateIndexedEvent(archiveId: string, event: IndexedHistoryEvent, projectionId: string, versionDigest: string): void {
  need(event && typeof event.type === 'string', 'CORRUPT_EVENT', '事件类型无效。');
  const spec = details[event.type];
  const tableValid = event.type.startsWith('alarm.') ? event.entity?.table === 'alarms'
    : event.type.startsWith('transfer.host-') ? event.entity?.table === 'cargo'
      : event.type.startsWith('transfer.') ? event.entity?.table === 'transfers'
        : event.type.startsWith('cargo.') ? event.entity?.table === 'cargo'
          : event.type.startsWith('slot.') ? event.entity?.table === 'slots'
            : event.type.startsWith('inventory.') ? event.entity?.table === 'slots' || event.entity?.table === 'fetchRows'
              : event.type.startsWith('device.') && event.entity?.table === 'devices';
  need(spec && tableValid && event.eventProjectionVersion === EVENT_PROJECTION_VERSION && event.projectionId === projectionId && event.versionDigest === versionDigest && event.kind === spec.kind
    && event.label === spec.label && event.id === eventId(archiveId, event)
    && Number.isSafeInteger(event.time) && event.time >= 0 && event.time <= 8_640_000_000_000_000
    && Number.isSafeInteger(event.ordinal) && event.ordinal >= 0
    && typeof event.entity?.id === 'string' && event.entity.id.length > 0 && event.entity.id.length <= 2048
    && event.evidence?.kind === 'atomic-fact' && event.evidence.factIndex === event.ordinal
    && event.evidence.details !== null && typeof event.evidence.details === 'object' && !Array.isArray(event.evidence.details),
  'CORRUPT_EVENT', '事件身份、类型或时间无效。');
}
