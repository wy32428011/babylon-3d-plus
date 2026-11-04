import type { AnyStateRecord, DeepReadonly, JsonObject, StateFact, StateTable } from './types';
import type { AlarmState, CargoState, DeviceState, FetchRowState, SlotState, TransferState } from './types';
import { canonicalStringify } from './safeJson';

/** 从事务中实际发生的逐次写入提取边沿，不能仅依据修订末尾的净状态猜测。 */
export function collectStateFacts(
  table: StateTable, before: DeepReadonly<AnyStateRecord> | undefined, after: DeepReadonly<AnyStateRecord> | undefined,
): StateFact[] {
  const facts: StateFact[] = [];
  const push = (kind: StateFact['kind'], action: StateFact['action'], entityId: string, details: JsonObject) => {
    facts.push({ kind, action, entityId, details } as StateFact);
  };
  if (table === 'alarms') {
    const old = before as DeepReadonly<AlarmState> | undefined, next = after as DeepReadonly<AlarmState> | undefined;
    if (!next) return facts;
    const previousEdge = old?.edge ?? 'absent', edge = next.edge;
    if (previousEdge !== edge) {
      const action = edge === 'active' ? previousEdge === 'inactive' ? 'alarm-activated' : 'alarm-observed-active'
        : edge === 'inactive' ? previousEdge === 'active' ? 'alarm-cleared' : 'alarm-observed-inactive' : 'alarm-state-unknown';
      push('alarm', action, next.id, { ruleId: next.ruleId, deviceId: next.deviceId, previousEdge, edge });
    }
  } else if (table === 'transfers') {
    const old = before as DeepReadonly<TransferState> | undefined, next = after as DeepReadonly<TransferState> | undefined;
    if (next && (!old || old.phase !== next.phase)) {
      const action = !old ? 'transfer-started' : next.phase === 'complete' ? 'transfer-completed'
        : next.phase === 'cancelled' ? 'transfer-cancelled' : 'transfer-phase-changed';
      push('transfer', action, next.id, { cargoId: next.cargoId, from: next.from as JsonObject, to: next.to as JsonObject,
        previousPhase: old?.phase ?? null, phase: next.phase });
    }
  } else if (table === 'cargo') {
    const old = before as DeepReadonly<CargoState> | undefined, next = after as DeepReadonly<CargoState> | undefined;
    if (!old && next) push('lifecycle', 'cargo-created', next.id, { containerCode: next.containerCode, taskId: next.taskId });
    if (old && next && old.destroyedAt === null && next.destroyedAt !== null) push('lifecycle', 'cargo-destroyed', next.id, { reason: next.destroyReason });
    if (next && canonicalStringify(old?.host ?? null) !== canonicalStringify(next.host)) {
      push('transfer', 'cargo-host-changed', next.id, { from: (old?.host ?? null) as JsonObject | null, to: next.host as JsonObject | null });
    }
  } else if (table === 'devices') {
    const old = before as DeepReadonly<DeviceState> | undefined, next = after as DeepReadonly<DeviceState> | undefined;
    const value = !old && next?.dynamic ? next : old?.dynamic && !next ? old : undefined;
    if (value?.dynamic) push('lifecycle', next ? 'device-born' : 'device-retired', value.id, {
      sourceId: value.identity.sourceId, deviceType: value.identity.deviceType, assetCode: value.identity.assetCode,
      generatorId: value.dynamic.generatorId, generation: value.dynamic.generation,
    });
  } else if (table === 'slots') {
    const old = before as DeepReadonly<SlotState> | undefined, next = after as DeepReadonly<SlotState> | undefined;
    if (!next) return facts;
    const previousCargoId = old?.cargoId ?? null, nextCargoId = next.cargoId;
    if (previousCargoId !== nextCargoId) push('stock', previousCargoId === null ? 'slot-occupied' : nextCargoId === null ? 'slot-cleared' : 'slot-changed', next.id,
      { previousCargoId, nextCargoId, inventoryRevision: next.inventoryRevision });
    const previousRevision = old?.inventoryRevision ?? null, nextRevision = next.inventoryRevision;
    if (previousRevision !== nextRevision) push('stock', 'inventory-revision-changed', next.id, { recordTable: 'slots', previousRevision, nextRevision });
  } else if (table === 'fetchRows') {
    const old = before as DeepReadonly<FetchRowState> | undefined, next = after as DeepReadonly<FetchRowState> | undefined;
    if (next && (old?.inventoryRevision ?? null) !== next.inventoryRevision) push('stock', 'inventory-revision-changed', next.id,
      { recordTable: 'fetchRows', previousRevision: old?.inventoryRevision ?? null, nextRevision: next.inventoryRevision });
  }
  return facts;
}
