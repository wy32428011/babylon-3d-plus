import type {
  AlarmState, CargoHost, CargoState, DeepReadonly, NumericPose, StateTable, StateTableRecords,
  StateTransactionPort, TelemetryFrame, TimerState, JsonObject,
} from './types';
import { canonicalStringify, compareDecimal, copySafeJson, requireState } from './safeJson';
import { allocateCargoId, compareInputCursor, nextGeneration } from './identity';
import { hostKey } from './validation';

/** 只复制要修改的记录；不要把 view 或其冻结记录直接交给旧驱动改写。 */
export function draftRecord<K extends StateTable>(transaction: StateTransactionPort, table: K, id: string): StateTableRecords[K] {
  const record = transaction.get(table, id);
  requireState(record, 'REFERENCE', `${table} 记录不存在：${id}`);
  return copySafeJson(record) as unknown as StateTableRecords[K];
}
export function identityPose(): NumericPose { return { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }; }

/** 全帧替换，不合并缺失字段；无序号且业务内容未变化的消息只刷新有效心跳。 */
export function acceptTelemetry(transaction: StateTransactionPort, deviceId: string, incoming: TelemetryFrame): 'applied' | 'heartbeat' | 'duplicate' | 'out-of-order' {
  const device = draftRecord(transaction, 'devices', deviceId);
  const frame = copySafeJson(incoming) as unknown as TelemetryFrame;
  requireState(frame.receivedAt === transaction.logicalTime && compareInputCursor(frame.inputCursor, transaction.inputCursor) === 0,
    'TELEMETRY', '遥测须使用当前已记录的观测时间和输入游标。');
  requireState(frame.deviceEpoch === device.ordering.deviceEpoch, 'DEVICE_EPOCH', '设备纪元改变需要已迁移适配器显式重建前后帧和驱动状态。');
  if (frame.eventId !== null && frame.eventId === device.ordering.lastEventId) return 'duplicate';
  if (frame.sequence !== null && device.ordering.lastSequence !== null) {
    const order = compareDecimal(frame.sequence, device.ordering.lastSequence);
    if (order <= 0) return order === 0 ? 'duplicate' : 'out-of-order';
  }
  const current = device.telemetry.current;
  const content = (value: DeepReadonly<TelemetryFrame>): string => canonicalStringify({ fields: value.fields,
    currentLocationKey: value.currentLocationKey, targetLocationKey: value.targetLocationKey, hasTargetLocation: value.hasTargetLocation,
    faulted: value.faulted, topic: value.topic, payloadDeviceCode: value.payloadDeviceCode, spawnerCode: value.spawnerCode, message: value.message });
  const heartbeatOnly = frame.sequence === null && current !== null && content(frame) === content(current);
  if (!heartbeatOnly) { device.telemetry.previous = current; device.telemetry.current = frame; }
  device.telemetry.effectiveHeartbeatAt = transaction.logicalTime;
  device.ordering.lastSequence = frame.sequence ?? device.ordering.lastSequence;
  device.ordering.lastEventId = frame.eventId;
  device.ordering.lastInputCursor = { ...transaction.inputCursor };
  if (device.dynamic) {
    const generator = transaction.logic.generators.find(item => item.id === device.dynamic!.generatorId);
    requireState(generator, 'REFERENCE', '动态设备生成器缺失。');
    device.dynamic.lastHeartbeatAt = transaction.logicalTime;
    if (generator.ttlMs !== null) {
      requireState(device.dynamic.expiryTimerId !== null, 'TTL', '动态 TTL 没有可恢复的到期任务。');
      const timer = draftRecord(transaction, 'timers', device.dynamic.expiryTimerId);
      device.dynamic.expiresAt = transaction.logicalTime + generator.ttlMs;
      timer.dueAt = device.dynamic.expiresAt; transaction.put('timers', timer);
    }
  }
  transaction.put('devices', device);
  return heartbeatOnly ? 'heartbeat' : 'applied';
}

export type NewCargoFact = {
  sourceId: string; containerCode: string | null; taskId: string | null; host: CargoHost;
  localPose: NumericPose; generatorId: string | null; generation: string | null;
};
/** 每次生命周期分配 cargoId；重复 taskId/assetCode 不会合并两件货物。 */
export function createCargo(transaction: StateTransactionPort, fact: NewCargoFact): string {
  const id = allocateCargoId(transaction, fact.sourceId);
  const cargo: CargoState = { id, containerCode: fact.containerCode, taskId: fact.taskId,
    origin: { sourceId: fact.sourceId, inputCursor: { ...transaction.inputCursor }, generatorId: fact.generatorId, generation: fact.generation },
    host: null, localPose: fact.localPose, handoff: null, createdAt: transaction.logicalTime, destroyedAt: null, destroyReason: null };
  transaction.put('cargo', cargo); moveCargo(transaction, id, fact.host, fact.localPose); return id;
}
/** 只落实规范化宿主事实；转移阶段、交接触发和设备取货规则由已迁移的 adapter 决定。 */
export function moveCargo(transaction: StateTransactionPort, cargoId: string, host: CargoHost, localPose?: NumericPose): void {
  const cargo = draftRecord(transaction, 'cargo', cargoId);
  requireState(cargo.destroyedAt === null, 'CARGO_LIFECYCLE', '已销毁货物不能复活。');
  for (const other of transaction.values('cargo')) requireState(other.id === cargoId || !other.host || hostKey(other.host) !== hostKey(host),
    'HOST_OCCUPIED', '目标宿主已有其他货物，不能隐式覆盖。');
  const destination = host.kind === 'slot' ? draftRecord(transaction, 'slots', host.slotId) : null;
  requireState(!destination || destination.cargoId === null || destination.cargoId === cargoId, 'HOST_OCCUPIED', '目标库位被其他货物占用。');
  if (cargo.host?.kind === 'slot' && (host.kind !== 'slot' || cargo.host.slotId !== host.slotId)) {
    const previous = draftRecord(transaction, 'slots', cargo.host.slotId);
    requireState(previous.cargoId === cargoId, 'INVENTORY', '原库位不持有此货物。'); previous.cargoId = null; transaction.put('slots', previous);
  }
  if (destination) { destination.cargoId = cargoId; transaction.put('slots', destination); }
  cargo.host = host; if (localPose) cargo.localPose = localPose;
  transaction.put('cargo', cargo);
}
export function destroyCargo(transaction: StateTransactionPort, cargoId: string, reason: string): void {
  const cargo = draftRecord(transaction, 'cargo', cargoId);
  requireState(cargo.destroyedAt === null && reason.length > 0, 'CARGO_LIFECYCLE', '只能为活货物记录明确销毁原因。');
  if (cargo.host?.kind === 'slot') {
    const slot = draftRecord(transaction, 'slots', cargo.host.slotId);
    requireState(slot.cargoId === cargoId, 'INVENTORY', '销毁货物不匹配库位占用。'); slot.cargoId = null; transaction.put('slots', slot);
  }
  cargo.host = null; cargo.handoff = null; cargo.destroyedAt = transaction.logicalTime; cargo.destroyReason = reason;
  transaction.put('cargo', cargo);
}
export function scheduleTimer(transaction: StateTransactionPort, timer: Omit<TimerState, 'id' | 'ordinal'>): string {
  requireState(timer.dueAt >= transaction.logicalTime, 'TIME', '不能创建位于当前逻辑时间之前的任务。');
  const id = transaction.allocateId('timer'), ordinal = nextGeneration(transaction, 'timer-order');
  transaction.put('timers', { ...timer, id, ordinal }); return id;
}
/** 报警点位仅更新真实出现的键；缺失键不会被补 null 或当作解除。 */
export function retainAlarmProperties(transaction: StateTransactionPort, alarmId: string, patch: JsonObject): void {
  const alarm = draftRecord(transaction, 'alarms', alarmId), values = copySafeJson(patch) as JsonObject;
  const retained = new Map(alarm.retained.map(item => [item.property, item]));
  for (const [property, value] of Object.entries(values)) retained.set(property,
    { property, value, receivedAt: transaction.logicalTime, inputCursor: { ...transaction.inputCursor } });
  alarm.retained = [...retained.values()].sort((a, b) => a.property < b.property ? -1 : a.property > b.property ? 1 : 0);
  transaction.put('alarms', alarm);
}
/** 求值结果必须由受控规则显式提供；该辅助函数不把未知报警规则默认判为正常。 */
export function setAlarmActive(transaction: StateTransactionPort, alarmId: string, active: boolean): void {
  const alarm: AlarmState = draftRecord(transaction, 'alarms', alarmId);
  if (active && !alarm.active) alarm.activatedAt = transaction.logicalTime;
  if (!active && alarm.active) alarm.clearedAt = transaction.logicalTime;
  alarm.active = active; alarm.edge = active ? 'active' : 'inactive'; alarm.evaluatedAt = transaction.logicalTime;
  transaction.put('alarms', alarm);
}
