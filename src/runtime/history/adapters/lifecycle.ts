import type { AdapterStateRecord, DeviceIdentity, DeviceState, JsonObject, StateReadView, TelemetryFrame } from '../state/types';
import { canonicalStringify, compareDecimal, copySafeJson, requireState, stableKey } from '../state/safeJson';
import { compareInputCursor, deviceIdentityKey, dynamicDeviceId, nextGeneration, nextGeneratorGeneration } from '../state/identity';
import { draftRecord, scheduleTimer } from '../state/stateOps';
import { createDeviceTelemetrySnapshot, readStringField } from '../../mqtt/deviceTelemetry';
import type { LogisticsContext } from './context';
import type { FrozenDynamicGenerator, LogisticsRawTelemetryRecord, LogisticsTelemetryPayload } from './manifest';
import { LOGISTICS_ADAPTER_ID, LOGISTICS_ADAPTER_VERSION } from './manifest';
import type { ConveyorState, PassiveSubjectState, RawTelemetryState, UninstantiatedTelemetryState } from './runtimeState';
import { createFreshLogisticsDriverState, wrapLogisticsState } from './runtimeState';
import { captureAlarmProperties } from './alarms';
import { readIntegerField } from '../../mqtt/deviceTelemetry';

export type TelemetryDisposition = 'applied' | 'heartbeat' | 'duplicate' | 'out-of-order';
const parkedId = (identity: DeviceIdentity): string => stableKey('logistics-uninstantiated', deviceIdentityKey(identity));
/** 每主体原始字段独立持久化，既不借用完整业务快照，也不依赖进程内缓存。 */
export const logisticsRawTelemetryId = (identity: DeviceIdentity): string => stableKey('logistics-raw-telemetry', deviceIdentityKey(identity));
function assertLosslessIntegers(value: unknown): void {
  if (typeof value === 'number') requireState(!Number.isInteger(value) || Number.isSafeInteger(value), 'LOGISTICS_RAW_NUMBER', '原始大整数必须使用字符串。');
  else if (Array.isArray(value)) for (const item of value) assertLosslessIntegers(item);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) assertLosslessIntegers(item);
}
export function createLogisticsRawBaselineRecord(value: Omit<RawTelemetryState, 'kind' | 'basis'>,
  basis: Omit<RawTelemetryState['basis'], 'kind'>): AdapterStateRecord {
  const state: RawTelemetryState = { ...value, kind: 'raw-telemetry', basis: { ...basis, kind: 'baseline' } };
  return { id: logisticsRawTelemetryId(state.identity), deviceIds: [], cargoIds: [], state: wrapLogisticsState(state) };
}
/** 基线提供者负责给出权威原始值；此处核对证明、身份、顺序与已保存的业务完整帧。 */
export function assertLogisticsRawTelemetry(state: RawTelemetryState, view: StateReadView): void {
  assertLosslessIntegers(state.fields);
  const record = view.get('adapterStates', logisticsRawTelemetryId(state.identity));
  const boundary = view.metadata.baseline.sourceBoundaries.find(item => item.sourceId === state.identity.sourceId);
  requireState(record && record.state.value === state as unknown && record.deviceIds.length === 0 && record.cargoIds.length === 0
    && state.identity.projectId === view.logic.versions.projectId && boundary
    && state.basis.sourceRevision === boundary.sourceRevision && state.basis.snapshotRevision === boundary.snapshotRevision
    && state.basis.evidenceRef === boundary.evidenceRef && view.metadata.baseline.complete
    && view.metadata.baseline.alignment.status === 'aligned' && view.metadata.baseline.domains.telemetry,
  'LOGISTICS_RAW_BASELINE', '原始字段缺少匹配且已对齐的来源基线证明。');
  requireState(new Set(state.seenEventIds).size === state.seenEventIds.length
    && (state.eventId === null || state.seenEventIds.includes(state.eventId)),
  'LOGISTICS_RAW_BASELINE', '设备事件去重证据缺失或重复。');
  const baselineCursor = view.metadata.baseline.inputCursor;
  requireState((state.basis.kind === 'baseline' ? compareInputCursor(state.basis.inputCursor, baselineCursor) === 0
    : compareInputCursor(state.basis.inputCursor, baselineCursor) > 0 && compareInputCursor(state.inputCursor, state.basis.inputCursor) >= 0)
    && compareInputCursor(state.inputCursor, view.metadata.inputCursor) <= 0 && state.receivedAt <= view.metadata.logicalTime,
  'LOGISTICS_RAW_BASELINE', '原始字段的证明游标或更新游标无效。');
  const identityKey = deviceIdentityKey(state.identity);
  const device = [...view.values('devices')].find(item => deviceIdentityKey(item.identity) === identityKey);
  const parked = view.get('adapterStates', parkedId(state.identity))?.state.value as unknown as UninstantiatedTelemetryState | undefined;
  const current = device?.telemetry.current ?? parked?.telemetry.current;
  const ordering = device?.ordering ?? parked?.ordering;
  requireState(current && ordering && ordering.deviceEpoch === state.deviceEpoch && ordering.lastSequence === state.sequence
    && current.deviceEpoch === state.deviceEpoch && current.sequence === state.sequence
    && current.sourceTimestamp === state.sourceTimestamp && current.eventId === state.eventId
    && current.receivedAt === state.receivedAt && compareInputCursor(current.inputCursor, state.inputCursor) === 0,
  'LOGISTICS_RAW_BASELINE', '原始前态与主体当前帧或排序水位不一致。');
  const snapshot = createDeviceTelemetrySnapshot({ sourceId: state.identity.sourceId, topic: current.topic,
    deviceType: state.identity.deviceType, assetCode: state.identity.assetCode, payloadDeviceCode: current.payloadDeviceCode,
    spawnerCode: current.spawnerCode, sourceTimestamp: current.sourceTimestamp, sequence: null,
    fields: copySafeJson(state.fields) as unknown as Record<string, unknown> }, current.receivedAt);
  requireState(canonicalStringify(snapshot.fields) === canonicalStringify(current.fields)
    && snapshot.currentLocationKey === current.currentLocationKey && snapshot.targetLocationKey === current.targetLocationKey
    && snapshot.hasTargetLocation === current.hasTargetLocation && snapshot.faulted === current.faulted && snapshot.message === current.message,
  'LOGISTICS_RAW_BASELINE', '原始前态重算结果与完整业务帧不一致；不能由派生快照倒推原值。');
}
export function discardLogisticsRawTelemetry(ctx: LogisticsContext, identity: DeviceIdentity): void {
  const id = logisticsRawTelemetryId(identity); if (ctx.tx.get('adapterStates', id)) ctx.tx.remove('adapterStates', id);
}
export function applyLogisticsRawTelemetry(ctx: LogisticsContext, record: LogisticsRawTelemetryRecord, sourceId: string): void {
  assertLosslessIntegers(record.fields);
  const { identity } = record, id = logisticsRawTelemetryId(identity);
  const previousRecord = ctx.tx.get('adapterStates', id);
  const previous = previousRecord?.state.value as unknown as RawTelemetryState | undefined;
  requireState(!previous || previous.kind === 'raw-telemetry', 'LOGISTICS_RAW_BASELINE', '原始前态身份碰撞。');
  if (previous) {
    assertLogisticsRawTelemetry(previous, ctx.tx);
    requireState(previous.deviceEpoch === record.deviceEpoch, 'DEVICE_EPOCH', '设备纪元变化必须先重新对齐，不能沿用旧去重证据。');
  }
  requireState(record.mode === 'full' || previous, 'LOGISTICS_RAW_BASELINE', '增量输入缺少已证明的原始字段前态。');
  if (!previous && record.eventId !== null && record.sequence === null) {
    const device = [...ctx.tx.values('devices')].find(item => deviceIdentityKey(item.identity) === deviceIdentityKey(identity));
    const parked = readParked(ctx, identity);
    requireState(!device?.telemetry.current && !parked?.telemetry.current, 'LOGISTICS_DEDUP_BASELINE',
      '无设备序号的事件身份去重需要来源证明的既有主体事件集合。');
  }
  const fields = copySafeJson(record.mode === 'delta' ? { ...previous!.fields, ...record.fields } : record.fields) as JsonObject;
  const snapshot = createDeviceTelemetrySnapshot({ sourceId, topic: record.topic, deviceType: identity.deviceType,
    assetCode: identity.assetCode, payloadDeviceCode: record.payloadDeviceCode, spawnerCode: record.spawnerCode,
    sourceTimestamp: record.sourceTimestamp, sequence: null, fields: copySafeJson(fields) as unknown as Record<string, unknown> }, record.receivedAt);
  const frame: TelemetryFrame = { fields: snapshot.fields as JsonObject, receivedAt: record.receivedAt, sourceTimestamp: record.sourceTimestamp,
    sequence: record.sequence, deviceEpoch: record.deviceEpoch, eventId: record.eventId, inputCursor: record.inputCursor,
    currentLocationKey: snapshot.currentLocationKey, targetLocationKey: snapshot.targetLocationKey, hasTargetLocation: snapshot.hasTargetLocation,
    faulted: snapshot.faulted, topic: record.topic, payloadDeviceCode: record.payloadDeviceCode, spawnerCode: record.spawnerCode, message: snapshot.message };
  if (record.eventId !== null && previous?.seenEventIds.includes(record.eventId)) {
    observeRepeatedLogisticsTelemetry(ctx, { deviceId: null, identity, frame }, sourceId); return;
  }
  const result = applyLogisticsTelemetry(ctx, { deviceId: null, identity, frame }, sourceId, record.fields, true);
  if (result.disposition !== 'applied') return;
  const seenEventIds = [...(previous?.seenEventIds ?? [])];
  if (record.eventId !== null) {
    requireState(seenEventIds.length < 4096, 'LOGISTICS_DEDUP_CAPACITY', '设备事件去重证据已达上限，不能静默淘汰。');
    seenEventIds.push(record.eventId);
  }
  const boundary = ctx.tx.metadata.baseline.sourceBoundaries.find(item => item.sourceId === sourceId);
  requireState(boundary, 'LOGISTICS_RAW_BASELINE', '来源没有对齐边界。');
  const basis: RawTelemetryState['basis'] = record.mode === 'full' ? { kind: 'full', sourceRevision: boundary.sourceRevision,
    snapshotRevision: boundary.snapshotRevision, evidenceRef: boundary.evidenceRef, inputCursor: { ...record.inputCursor } } : previous!.basis;
  const raw: RawTelemetryState = { kind: 'raw-telemetry', identity, fields, deviceEpoch: record.deviceEpoch, sequence: record.sequence,
    sourceTimestamp: record.sourceTimestamp, eventId: record.eventId, seenEventIds, inputCursor: record.inputCursor, receivedAt: record.receivedAt, basis };
  ctx.tx.put('adapterStates', { id, deviceIds: [], cargoIds: [], state: wrapLogisticsState(raw) });
}
type TelemetryHolder = Pick<DeviceState, 'telemetry' | 'ordering'>;
function emptyTelemetry(epoch: string): TelemetryHolder {
  return { telemetry: { previous: null, current: null, effectiveHeartbeatAt: null },
    ordering: { deviceEpoch: epoch, lastSequence: null, lastEventId: null, lastInputCursor: null } };
}
function content(frame: TelemetryFrame): string {
  return canonicalStringify({ topic: frame.topic, payloadDeviceCode: frame.payloadDeviceCode, fields: frame.fields,
    currentLocationKey: frame.currentLocationKey, targetLocationKey: frame.targetLocationKey, hasTargetLocation: frame.hasTargetLocation,
    faulted: frame.faulted, message: frame.message });
}
/** 逐字义迁移 DeviceTelemetryStore 的时序优先级；大序号改用十进制字符串比较，绝不退回 Number。 */
function applyNativeFrame(holder: TelemetryHolder, frame: TelemetryFrame, preserveSameTime = false): TelemetryDisposition {
  requireState(holder.ordering.deviceEpoch === frame.deviceEpoch, 'DEVICE_EPOCH', '活动主体的设备纪元改变必须先重建对齐边界。');
  const current = holder.telemetry.current;
  const untimed = (value: TelemetryFrame): boolean => value.sequence === null && value.sourceTimestamp === null;
  if (current && frame.eventId !== null && frame.eventId === current.eventId) return 'duplicate';
  // 一旦设备已经提供序号，缺号不能降级为接收时间排序；否则旧帧可覆盖较新的序号水位。
  if (holder.ordering.lastSequence !== null) {
    requireState(frame.sequence !== null, 'LOGISTICS_ORDER_AMBIGUOUS', '已有设备序号水位时收到缺序号消息，不能证明增量顺序。');
    const order = compareDecimal(frame.sequence, holder.ordering.lastSequence);
    if (order <= 0) return order === 0 ? 'duplicate' : 'out-of-order';
  }
  if (current && content(frame) === content(current)) {
    // 无事件身份的同毫秒报文不能证明为重传；它们可能是不同的业务脉冲。
    const duplicate = frame.sequence !== null && current.sequence !== null ? frame.sequence === current.sequence
      : untimed(frame) && untimed(current) && !(preserveSameTime && frame.receivedAt === (holder.telemetry.effectiveHeartbeatAt ?? current.receivedAt));
    if (duplicate) {
      if (untimed(frame) && untimed(current) && frame.receivedAt > (holder.telemetry.effectiveHeartbeatAt ?? current.receivedAt)) {
        holder.telemetry.effectiveHeartbeatAt = frame.receivedAt; holder.ordering.lastInputCursor = { ...frame.inputCursor };
        holder.ordering.lastEventId = frame.eventId; return 'heartbeat';
      }
      return 'duplicate';
    }
  }
  if (current) {
    const effectiveAt = holder.telemetry.effectiveHeartbeatAt ?? current.receivedAt;
    const newer = frame.sequence !== null && holder.ordering.lastSequence !== null ? true
      : frame.sequence !== null && current.sequence !== null ? compareDecimal(frame.sequence, current.sequence) > 0
      : frame.sourceTimestamp !== null && current.sourceTimestamp !== null ? frame.sourceTimestamp >= current.sourceTimestamp
        : untimed(frame) && untimed(current) ? frame.receivedAt >= effectiveAt : frame.receivedAt > effectiveAt;
    if (!newer) return 'out-of-order';
  }
  holder.telemetry.previous = current; holder.telemetry.current = frame; holder.telemetry.effectiveHeartbeatAt = frame.receivedAt;
  holder.ordering.lastSequence = frame.sequence ?? holder.ordering.lastSequence; holder.ordering.lastEventId = frame.eventId; holder.ordering.lastInputCursor = { ...frame.inputCursor };
  return 'applied';
}
function assertObservation(ctx: LogisticsContext, identity: DeviceIdentity, frame: TelemetryFrame, sourceId: string): void {
  requireState(identity.projectId === ctx.tx.logic.versions.projectId && identity.sourceId === sourceId
    && frame.receivedAt === ctx.now && compareInputCursor(frame.inputCursor, ctx.tx.inputCursor) === 0,
  'LOGISTICS_TELEMETRY', '遥测身份、观测时间或顺序器游标不属于当前输入。');
}
function readParked(ctx: LogisticsContext, identity: DeviceIdentity): UninstantiatedTelemetryState | null {
  const record = ctx.tx.get('adapterStates', parkedId(identity));
  return record ? copySafeJson(record.state.value) as unknown as UninstantiatedTelemetryState : null;
}
function saveParked(ctx: LogisticsContext, value: UninstantiatedTelemetryState): void {
  ctx.tx.put('adapterStates', { id: parkedId(value.identity), deviceIds: [], cargoIds: [], state: wrapLogisticsState(value) });
}
function parkObservation(ctx: LogisticsContext, identity: DeviceIdentity, frame: TelemetryFrame, reason: string, preserveSameTime: boolean): TelemetryDisposition {
  const previous = readParked(ctx, identity), value: UninstantiatedTelemetryState = previous ?? {
    kind: 'uninstantiated', identity, ...emptyTelemetry(frame.deviceEpoch), lastDeviceId: null, generatorId: null,
    generation: null, retiredAt: null, lastReceiptAt: frame.receivedAt, reason,
  };
  value.lastReceiptAt = frame.receivedAt; const disposition = applyNativeFrame(value, frame, preserveSameTime); saveParked(ctx, value); return disposition;
}
function generatorFor(ctx: LogisticsContext, identity: DeviceIdentity, spawnerCode: string): FrozenDynamicGenerator | null {
  return ctx.manifest.dynamicGenerators.find(generator => generator.sourceId === identity.sourceId && generator.deviceType === identity.deviceType
    && generator.spawnerCode === spawnerCode) as FrozenDynamicGenerator | undefined ?? null;
}
export function birthDynamicSubject(ctx: LogisticsContext, generatorId: string, identity: DeviceIdentity, frame: TelemetryFrame, sourceId: string, preserveSameTime = false): string {
  assertObservation(ctx, identity, frame, sourceId);
  const generator = ctx.manifest.dynamicGenerators.find(generator => generator.generatorId === generatorId);
  requireState(generator && generator.sourceId === identity.sourceId && generator.deviceType === identity.deviceType,
    'LOGISTICS_SPAWNER', '新生主体不匹配已发布的产生器和真实遥测类型。');
  requireState(![...ctx.tx.values('devices')].some(device => deviceIdentityKey(device.identity) === deviceIdentityKey(identity)), 'LOGISTICS_SPAWNER', '现有主体不能被重复生成或覆盖。');
  const previous = readParked(ctx, identity);
  if (previous) {
    requireState(previous.ordering.deviceEpoch === frame.deviceEpoch, 'DEVICE_EPOCH', '退休主体的设备纪元变化必须重新对齐。');
    const probe = copySafeJson({ telemetry: previous.telemetry, ordering: previous.ordering }) as unknown as TelemetryHolder;
    requireState(applyNativeFrame(probe, frame, preserveSameTime) === 'applied', 'LOGISTICS_SPAWNER', '重复或乱序遥测不能生成新主体。');
  }
  const generation = nextGeneratorGeneration(ctx.tx, generatorId), id = dynamicDeviceId(identity, generatorId, generation);
  const history = previous ? { telemetry: previous.telemetry, ordering: previous.ordering } : emptyTelemetry(frame.deviceEpoch);
  const driverState = createFreshLogisticsDriverState(generator.template as FrozenDynamicGenerator['template']);
  driverState.value.birthOrder = nextGeneration(ctx.tx, 'logistics-birth');
  const expiresAt = generator.ttlMs === null ? null : ctx.now + generator.ttlMs;
  const expiryTimerId = expiresAt === null ? null : scheduleTimer(ctx.tx, { adapterId: LOGISTICS_ADAPTER_ID, adapterVersion: LOGISTICS_ADAPTER_VERSION,
    timerType: 'expire', dueAt: expiresAt, phase: 'lifecycle', deviceId: id, cargoId: null, payload: { deviceId: id, generation } });
  const record: DeviceState = { id, identity, logicalDeviceId: null, modelId: generator.modelId,
    basePose: copySafeJson(generator.template.basePose) as unknown as DeviceState['basePose'], attachment: null,
    ...history, dynamic: { generatorId, generation, bornAt: ctx.now, lastHeartbeatAt: ctx.now, expiresAt, expiryTimerId }, driverState };
  if (previous) ctx.tx.remove('adapterStates', parkedId(identity));
    ctx.tx.put('devices', record); ctx.topologyChanged = true; return id;
}
function refreshDynamicHeartbeat(ctx: LogisticsContext, device: DeviceState): void {
  if (!device.dynamic) return;
  const generator = ctx.tx.logic.generators.find(generator => generator.id === device.dynamic!.generatorId);
  requireState(generator, 'LOGISTICS_SPAWNER', '动态实例的生成器合同已经缺失。');
  device.dynamic.lastHeartbeatAt = ctx.now;
  if (generator.ttlMs !== null) {
    requireState(device.dynamic.expiryTimerId, 'LOGISTICS_TTL', '动态实例缺少 TTL 截止任务。');
    const timer = draftRecord(ctx.tx, 'timers', device.dynamic.expiryTimerId);
    timer.dueAt = ctx.now + generator.ttlMs; device.dynamic.expiresAt = timer.dueAt; ctx.tx.put('timers', timer);
  }
}
/** 原 spawner 先按逐消息更新寿命，Store 再决定前后帧/有效心跳；两种心跳不可混为一种。 */
export function applyLogisticsTelemetry(ctx: LogisticsContext, payload: LogisticsTelemetryPayload, sourceId: string,
  updatedFields: TelemetryFrame['fields'] = payload.frame.fields, preserveSameTime = false): { deviceId: string | null; disposition: TelemetryDisposition } {
  const { identity, frame } = payload; assertObservation(ctx, identity, frame, sourceId);
  let device = payload.deviceId !== null ? ctx.tx.get('devices', payload.deviceId)
    : [...ctx.tx.values('devices')].find(candidate => deviceIdentityKey(candidate.identity) === deviceIdentityKey(identity));
  requireState(payload.deviceId === null || device, 'LOGISTICS_STALE_DEVICE', '遥测显式引用已退休的设备代次，不能改写新实例。');
  if (device) requireState(deviceIdentityKey(device.identity) === deviceIdentityKey(identity), 'LOGISTICS_TELEMETRY', '设备 ID 与来源/类型/资产身份不符。');
  // 生命周期只观察本次实际点位；不能把合并前态中的 offline 当作新消息。
  const offline = readStringField(updatedFields, 'status')?.trim().toLowerCase() === 'offline';
  if (device?.dynamic && offline) {
    const probe = copySafeJson({ telemetry: device.telemetry, ordering: device.ordering }) as unknown as TelemetryHolder;
    const disposition = applyNativeFrame(probe, frame, preserveSameTime);
    if (disposition === 'applied') retireDynamicSubject(ctx, device.id, 'offline', frame, false, preserveSameTime);
    else {
      const updated = draftRecord(ctx.tx, 'devices', device.id);
      refreshDynamicHeartbeat(ctx, updated); ctx.tx.put('devices', updated);
    }
    return { deviceId: disposition === 'applied' ? null : device.id, disposition };
  }
  if (!device) {
    const candidates = ctx.manifest.dynamicGenerators.filter(generator => generator.sourceId === identity.sourceId && generator.deviceType === identity.deviceType);
    requireState(candidates.length > 0, 'LOGISTICS_UNBOUND_SUBJECT', '未绑定主体且没有该来源/类型的已注册产生器；不能默认创建被动或物流设备。');
    if (offline || !frame.spawnerCode) return { deviceId: null,
      disposition: parkObservation(ctx, identity, frame, offline ? 'offline-before-birth' : 'awaiting-spawner', preserveSameTime) };
    const parked = readParked(ctx, identity);
    if (parked) {
      const probe = copySafeJson({ telemetry: parked.telemetry, ordering: parked.ordering }) as unknown as TelemetryHolder;
      const disposition = applyNativeFrame(probe, frame, preserveSameTime);
      if (disposition !== 'applied') {
        parked.lastReceiptAt = ctx.now; saveParked(ctx, parked);
        return { deviceId: null, disposition };
      }
    }
    const generator = generatorFor(ctx, identity, frame.spawnerCode);
    requireState(generator, 'LOGISTICS_SPAWNER', 'spawnerCode 未命中已发布产生器，不能猜测模板。');
    const id = birthDynamicSubject(ctx, generator.generatorId, identity, frame, sourceId, preserveSameTime); device = ctx.tx.get('devices', id)!;
  }
  const updated = draftRecord(ctx.tx, 'devices', device.id);
  refreshDynamicHeartbeat(ctx, updated);
  const disposition = applyNativeFrame(updated, frame, preserveSameTime);
  if (updated.driverState.value.kind === 'passive') {
    const state = updated.driverState.value as unknown as PassiveSubjectState;
    state.lastReceiptAt = ctx.now; state.lastDisposition = disposition;
    if (disposition === 'applied' || disposition === 'heartbeat') state.lastAppliedAt = ctx.now;
  }
  ctx.tx.put('devices', updated);
  if (disposition === 'applied') {
    captureAlarmProperties(ctx, updated.id, frame, updatedFields);
    if (updated.driverState.value.kind === 'conveyor') {
      const actor = ctx.of(updated.id, 'conveyor'), state: ConveyorState = actor.state, raw = readIntegerField(updatedFields, 'task');
      const exactTask = typeof updatedFields.task === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(updatedFields.task)
        ? updatedFields.task : raw === null ? null : String(raw);
      if (exactTask !== null && !/^0+$/u.test(exactTask)) {
        // task 是逐消息脉冲；字符串整数保留精度，合并前态中的旧 task 不能再次入队。
        requireState(state.taskPulseQueue.length < 64, 'LOGISTICS_TASK_PULSE_CAPACITY', '同一逻辑帧前的 task 脉冲超过 64，不能静默丢掉早到任务。');
        state.taskPulseQueue.push(exactTask);
      }
    }
  }
  return { deviceId: updated.id, disposition };
}
/** 来源级去重只保留逐消息产生器语义，不再次推进遥测、任务脉冲或报警点位。 */
export function observeRepeatedLogisticsTelemetry(ctx: LogisticsContext, payload: LogisticsTelemetryPayload, sourceId: string): void {
  const { identity, frame } = payload; assertObservation(ctx, identity, frame, sourceId);
  const device = payload.deviceId !== null ? ctx.tx.get('devices', payload.deviceId)
    : [...ctx.tx.values('devices')].find(candidate => deviceIdentityKey(candidate.identity) === deviceIdentityKey(identity));
  // 指向已退休代次的重传不能影响同身份的后来实例，也不能凭旧 ID 重新生成。
  if (payload.deviceId !== null && !device) return;
  if (device) requireState(deviceIdentityKey(device.identity) === deviceIdentityKey(identity), 'LOGISTICS_TELEMETRY', '设备 ID 与来源/类型/资产身份不符。');
  if (device?.dynamic) {
    const updated = draftRecord(ctx.tx, 'devices', device.id);
    refreshDynamicHeartbeat(ctx, updated); ctx.tx.put('devices', updated);
    return;
  }
  if (!device) {
    const parked = readParked(ctx, identity);
    if (parked) { parked.lastReceiptAt = ctx.now; saveParked(ctx, parked); }
  }
}
/** 退休保留原 Store 的遥测历史；未来同身份新生命周期不会遗失原有序号/时间戳去重上下文。 */
export function retireDynamicSubject(ctx: LogisticsContext, deviceId: string, reason: string, finalFrame?: TelemetryFrame, lifecycleOnly = false, preserveSameTime = false): void {
  const device = draftRecord(ctx.tx, 'devices', deviceId); requireState(device.dynamic, 'LOGISTICS_LIFECYCLE', '静态主体不能由产生器生命周期移除。');
  requireState(![...ctx.tx.values('devices')].some(child => child.attachment?.deviceId === deviceId),
    'LOGISTICS_LIFECYCLE_DEPENDENCY', '存在其他业务模块的挂接主体，必须先提供显式解绑事实；不能偷偷级联删除。');
  for (const cargo of [...ctx.tx.values('cargo')]) if (cargo.destroyedAt === null && ctx.cargo.has(cargo.id)) {
    const meta = ctx.cargo.meta(cargo.id); if (cargo.host?.kind === 'device' && cargo.host.deviceId === deviceId && meta.ownerDeviceId === deviceId) ctx.cargo.dispose(cargo.id, 'dynamic-device-' + reason);
  }
  // 已入格货物不属于退休设备；保留清算关联，仅释放失效的发起设备引用。
  for (const value of ctx.tx.values('fetchRows')) if (value.pendingSettlement.some(item => item.deviceId === deviceId)) {
    const row = draftRecord(ctx.tx, 'fetchRows', value.id);
    for (const pending of row.pendingSettlement) if (pending.deviceId === deviceId) pending.deviceId = null;
    ctx.tx.put('fetchRows', row);
  }
  for (const id of ctx.ids('hclift')) {
    const lift = ctx.of(id, 'hclift'); if (lift.state.occupancy?.shuttleId === deviceId) lift.state.occupancy = null;
  }
  for (const id of ctx.ids('shuttle')) {
    const shuttle = ctx.of(id, 'shuttle'); if (shuttle.state.hcliftOccupancyId === deviceId) shuttle.state.hcliftOccupancyId = null;
  }
  for (const id of ctx.ids('conveyor')) {
    const state = ctx.of(id, 'conveyor').state;
    state.upstreamLinks = state.upstreamLinks.filter(link => link.deviceId !== deviceId && link.holderDeviceId !== deviceId);
    state.downstreamLinks = state.downstreamLinks.filter(link => link.subscriberId !== deviceId);
    state.externalPulls = state.externalPulls.filter(link => link.subscriberId !== deviceId && link.holderDeviceId !== deviceId);
  }
  for (const timer of [...ctx.tx.values('timers')]) if (timer.deviceId === deviceId) {
    requireState(timer.adapterId === LOGISTICS_ADAPTER_ID, 'LOGISTICS_LIFECYCLE_DEPENDENCY', '退休主体仍有其他适配器的定时依赖。'); ctx.tx.remove('timers', timer.id);
  }
  for (const motion of [...ctx.tx.values('motions')]) if (motion.deviceId === deviceId) ctx.tx.remove('motions', motion.id);
  for (const alarm of [...ctx.tx.values('alarms')]) if (alarm.deviceId === deviceId) ctx.tx.remove('alarms', alarm.id);
  const value: UninstantiatedTelemetryState = { kind: 'uninstantiated', identity: device.identity, telemetry: device.telemetry, ordering: device.ordering,
    lastDeviceId: device.id, generatorId: device.dynamic.generatorId, generation: device.dynamic.generation, retiredAt: ctx.now,
    lastReceiptAt: finalFrame?.receivedAt ?? device.dynamic.lastHeartbeatAt ?? device.dynamic.bornAt, reason };
  if (finalFrame && !lifecycleOnly) applyNativeFrame(value, finalFrame, preserveSameTime);
  ctx.removed.add(deviceId); ctx.tx.remove('devices', deviceId); saveParked(ctx, value); ctx.topologyChanged = true;
}
