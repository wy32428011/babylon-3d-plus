import type { AnyStateRecord, DeepReadonly, JsonObject, StateFact, StateTable } from './types';
import type { AlarmState, CargoState, DeviceState, FetchRowState, SlotState, TransferState } from './types';
import { canonicalStringify, requireState } from './safeJson';

/** 从事务中实际发生的逐次写入提取边沿，不能仅依据修订末尾的净状态猜测。 */
export function collectStateFacts(
  table: StateTable, before: DeepReadonly<AnyStateRecord> | undefined, after: DeepReadonly<AnyStateRecord> | undefined,
  logicalTime: number, previouslyTouched = false,
): StateFact[] {
  const facts: StateFact[] = [];
  const push = (kind: StateFact['kind'], action: StateFact['action'], entityId: string, details: JsonObject) => {
    facts.push({ kind, action, entityId, details } as StateFact);
  };
  if (table === 'alarms') {
    const old = before as DeepReadonly<AlarmState> | undefined, next = after as DeepReadonly<AlarmState> | undefined;
    // 可暂时断开跨记录引用，但不能把记录自身互相矛盾的告警状态当作业务边沿。
    if (next) requireState(next.active === (next.edge === 'active'), 'ALARM', '事务中的告警活跃态与知识状态不一致。');
    const sameIdentity = old && next && old.deviceId === next.deviceId && old.ruleId === next.ruleId;
    if (old && !sameIdentity) push('alarm', 'alarm-state-unknown', old.id,
      { ruleId: old.ruleId, deviceId: old.deviceId, previousEdge: old.edge, edge: 'absent' });
    if (next) {
      const previousEdge = sameIdentity ? old.edge : 'absent', edge = next.edge;
      if (previousEdge !== edge) {
        const action = edge === 'active' ? previousEdge === 'inactive' ? 'alarm-activated' : 'alarm-observed-active'
          : edge === 'inactive' ? previousEdge === 'active' ? 'alarm-cleared' : 'alarm-observed-inactive' : 'alarm-state-unknown';
        push('alarm', action, next.id, { ruleId: next.ruleId, deviceId: next.deviceId, previousEdge, edge });
      }
    }
  } else if (table === 'transfers') {
    const old = before as DeepReadonly<TransferState> | undefined, next = after as DeepReadonly<TransferState> | undefined;
    if (next) requireState(next.startedAt <= logicalTime && (next.completedAt === null || next.completedAt <= logicalTime)
      && (next.phase === 'pending' || next.phase === 'in-flight' ? next.completedAt === null
        : next.completedAt !== null && next.completedAt >= next.startedAt), 'TRANSFER', '事务中的交接阶段与开始、完成时间不一致。');
    const sameIdentity = old && next && canonicalStringify([old.cargoId, old.from, old.to, old.startedAt])
      === canonicalStringify([next.cargoId, next.from, next.to, next.startedAt]);
    if (old && next && sameIdentity) {
      requireState(old.phase === next.phase || old.phase === 'pending' && ['in-flight', 'complete', 'cancelled'].includes(next.phase)
        || old.phase === 'in-flight' && ['complete', 'cancelled'].includes(next.phase), 'TRANSFER', '交接阶段不能倒退或复用已结束的身份。');
      if (old.phase === 'complete' || old.phase === 'cancelled')
        requireState(old.completedAt === next.completedAt, 'TRANSFER', '已结束交接的完成时间不能改写。');
    }
    const detail = (value: DeepReadonly<TransferState>, previousPhase: TransferState['phase'] | null, phase: TransferState['phase'] | null): JsonObject => ({
      cargoId: value.cargoId, from: value.from as JsonObject, to: value.to as JsonObject,
      previousPhase, phase, startedAt: value.startedAt, completedAt: value.completedAt,
    });
    if (old && !sameIdentity) push('transfer', 'transfer-unavailable', old.id, detail(old, old.phase, null));
    if (next && !sameIdentity) {
      // 相同记录身份被删除后重现，或身份内容被替换，只能视作重新观测。
      push('transfer', !old && !previouslyTouched && next.startedAt === logicalTime ? 'transfer-started' : 'transfer-observed',
        next.id, detail(next, null, next.phase));
      if (!old && !previouslyTouched && next.completedAt === logicalTime && (next.phase === 'complete' || next.phase === 'cancelled'))
        push('transfer', next.phase === 'complete' ? 'transfer-completed' : 'transfer-cancelled', next.id, detail(next, null, next.phase));
    } else if (old && next && old.phase !== next.phase) {
      const action = next.completedAt === logicalTime && next.phase === 'complete' ? 'transfer-completed'
        : next.completedAt === logicalTime && next.phase === 'cancelled' ? 'transfer-cancelled' : 'transfer-phase-changed';
      push('transfer', action, next.id, detail(next, old.phase, next.phase));
    }
  } else if (table === 'cargo') {
    const old = before as DeepReadonly<CargoState> | undefined, next = after as DeepReadonly<CargoState> | undefined;
    if (!old && next) push('lifecycle', next.createdAt === logicalTime ? 'cargo-created' : 'cargo-observed', next.id,
      { containerCode: next.containerCode, taskId: next.taskId, createdAt: next.createdAt });
    if (next && next.destroyedAt !== null && (!old || old.destroyedAt === null))
      push('lifecycle', next.destroyedAt === logicalTime ? 'cargo-destroyed' : 'cargo-observed-destroyed', next.id,
        { reason: next.destroyReason, destroyedAt: next.destroyedAt });
    if (!old && next?.host) push('transfer', 'cargo-host-observed', next.id, { host: next.host as JsonObject });
    else if (old && next && canonicalStringify(old.host) !== canonicalStringify(next.host))
      push('transfer', 'cargo-host-changed', next.id, { from: old.host as JsonObject | null, to: next.host as JsonObject | null });
  } else if (table === 'devices') {
    const old = before as DeepReadonly<DeviceState> | undefined, next = after as DeepReadonly<DeviceState> | undefined;
    if (!old && next?.dynamic) requireState(next.dynamic.bornAt <= logicalTime, 'TIME', '事务中的动态主体不能出生于未来。');
    const value = !old && next?.dynamic ? next : old?.dynamic && !next ? old : undefined;
    if (value?.dynamic) push('lifecycle', next ? !previouslyTouched && value.dynamic.bornAt === logicalTime ? 'device-born' : 'device-observed' : 'device-retired', value.id, {
      sourceId: value.identity.sourceId, deviceType: value.identity.deviceType, assetCode: value.identity.assetCode,
      generatorId: value.dynamic.generatorId, generation: value.dynamic.generation, bornAt: value.dynamic.bornAt,
    });
  } else if (table === 'slots') {
    const old = before as DeepReadonly<SlotState> | undefined, next = after as DeepReadonly<SlotState> | undefined;
    if (!old && next) push('stock', 'slot-observed', next.id, { cargoId: next.cargoId, inventoryRevision: next.inventoryRevision });
    else if (old && !next) push('stock', 'slot-unavailable', old.id, { cargoId: old.cargoId, inventoryRevision: old.inventoryRevision });
    else if (old && next && old.cargoId !== next.cargoId)
      push('stock', old.cargoId === null ? 'slot-occupied' : next.cargoId === null ? 'slot-cleared' : 'slot-changed', next.id,
        { previousCargoId: old.cargoId, nextCargoId: next.cargoId, inventoryRevision: next.inventoryRevision });
    const previousRevision = old?.inventoryRevision ?? null, nextRevision = next?.inventoryRevision ?? null;
    if (previousRevision !== nextRevision) push('stock', 'inventory-revision-changed', (next ?? old)!.id,
      { recordTable: 'slots', previousRevision, nextRevision });
  } else if (table === 'fetchRows') {
    const old = before as DeepReadonly<FetchRowState> | undefined, next = after as DeepReadonly<FetchRowState> | undefined;
    const previousRevision = old?.inventoryRevision ?? null, nextRevision = next?.inventoryRevision ?? null;
    if (previousRevision !== nextRevision) push('stock', 'inventory-revision-changed', (next ?? old)!.id,
      { recordTable: 'fetchRows', previousRevision, nextRevision });
  }
  return facts;
}
