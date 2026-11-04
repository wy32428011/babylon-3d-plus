import type {
  CargoEndpoint, CargoHost, DeepReadonly, InputCursor, LogicManifest, NumericPose, StateReadView,
  StateTable, StateTableRecords, VersionManifest,
} from './types';
import { BASELINE_DOMAINS, STATE_TABLES } from './types';
import { canonicalStringify, compareDecimal, requireState, stableKey } from './safeJson';
import type { StateBudgets } from './safeJson';
import type { StateAdapterRegistry } from './adapters';
import { assertDecimal, compareInputCursor, deviceIdentityKey, dynamicDeviceId, fetchRowId } from './identity';

type Frozen<T> = DeepReadonly<T>;
function unique<T>(items: Iterable<T>, key: (item: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    requireState(!result.has(id), 'DUPLICATE', `${label} 重复：${id}`);
    result.set(id, item);
  }
  return result;
}
export function assertVersions(actual: Frozen<VersionManifest>, expected: Frozen<VersionManifest>): void {
  requireState(canonicalStringify(actual) === canonicalStringify(expected), 'VERSION_MISMATCH', '状态、场景、逻辑或来源合同版本不匹配。');
}
export function assertPose(pose: Frozen<NumericPose>): void {
  requireState(pose.position.every(Number.isFinite) && pose.scale.every(value => Number.isFinite(value) && value !== 0),
    'POSE', '位姿必须有限，缩放不能为零。');
  requireState(Math.abs(Math.hypot(...pose.rotation) - 1) <= 1e-6, 'POSE', '四元数必须归一化。');
}
function noCycles<T>(items: Map<string, T>, parent: (item: T) => string | null, label: string): void {
  const finished = new Set<string>();
  for (const id of items.keys()) {
    const path = new Set<string>(); let cursor: string | null = id;
    while (cursor !== null && !finished.has(cursor)) {
      requireState(!path.has(cursor), 'CYCLE', `${label} 不能包含环。`); path.add(cursor);
      const item = items.get(cursor);
      requireState(item, 'REFERENCE', `${label} 父节点缺失。`); cursor = parent(item);
    }
    for (const key of path) finished.add(key);
  }
}
export function validateLogic(logic: Frozen<LogicManifest>, registry: StateAdapterRegistry): void {
  const sources = unique(logic.sources, item => item.id, '来源');
  const models = unique(logic.models, item => item.id, '模型');
  const devices = unique(logic.devices, item => item.id, '逻辑设备');
  unique(logic.devices, item => deviceIdentityKey(item.identity), '设备业务身份');
  unique(logic.slots, item => item.id, '库位');
  unique(logic.slots, item => stableKey(item.locatorId, item.row, String(item.column), String(item.layer), item.depth), '库位坐标');
  unique(logic.generators, item => item.id, '生成器');
  unique(logic.businessScripts, item => item.id, '业务脚本');
  const adapters = unique(logic.requiredAdapters, item => item.adapterId, '适配器');
  for (const model of models.values()) {
    requireState(model.bounds.min.every((value, i) => value <= model.bounds.max[i]), 'GEOMETRY', '模型包围盒上下界反转。');
    const anchors = unique(model.anchors, item => item.id, '模型锚点');
    noCycles(anchors, item => item.parentAnchorId, '锚点层级');
    for (const anchor of anchors.values()) {
      requireState(anchor.channel !== 'root', 'MOTION', 'root 是设备根运动的保留通道，不能同时作为部件通道。');
      assertPose(anchor.localPose);
    }
  }
  for (const device of devices.values()) {
    const model = models.get(device.modelId), required = adapters.get(device.adapterId);
    requireState(device.identity.projectId === logic.versions.projectId && sources.has(device.identity.sourceId)
      && model && required?.deviceTypes.includes(device.identity.deviceType), 'REFERENCE', '逻辑设备的项目、来源、模型或 driver 声明缺失。');
    unique(device.ports, port => port.id, '设备端口');
    for (const port of device.ports) requireState(model.anchors.some(anchor => anchor.id === port.anchorId), 'REFERENCE', '设备端口缺少数值锚点。');
    assertPose(device.basePose);
  }
  for (const slot of logic.slots) assertPose(slot.pose);
  for (const generator of logic.generators) {
    const adapter = adapters.get(generator.adapterId);
    requireState(sources.has(generator.sourceId) && models.has(generator.modelId) && adapter
      && (generator.deviceType === null || adapter.deviceTypes.includes(generator.deviceType)), 'REFERENCE', '生成器的来源、模型或适配器缺失。');
  }
  unique(logic.links, item => item.id, '逻辑链路');
  for (const link of logic.links) {
    requireState(devices.get(link.fromDeviceId)?.ports.some(port => port.id === link.fromPortId)
      && devices.get(link.toDeviceId)?.ports.some(port => port.id === link.toPortId), 'REFERENCE', '链路端点没有已声明的端口。');
  }
  registry.validateManifest(logic);
}
/** 动态设备端口使用模型锚点 ID；静态设备使用逻辑清单内的命名端口。 */
export function portAnchorId(view: StateReadView, deviceId: string, portId: string): string {
  const device = view.get('devices', deviceId);
  requireState(device, 'REFERENCE', '货物宿主设备不存在。');
  const model = view.logic.models.find(item => item.id === device.modelId);
  const anchorId = device.logicalDeviceId === null ? portId
    : view.logic.devices.find(item => item.id === device.logicalDeviceId)?.ports.find(port => port.id === portId)?.anchorId;
  requireState(anchorId && model?.anchors.some(anchor => anchor.id === anchorId), 'REFERENCE', '设备宿主端口没有已声明的数值锚点。');
  return anchorId;
}
function assertEndpoint(view: StateReadView, endpoint: Frozen<CargoEndpoint>): void {
  if (endpoint.kind === 'device') portAnchorId(view, endpoint.deviceId, endpoint.portId);
  else requireState(view.get('slots', endpoint.slotId), 'REFERENCE', '货物库位不存在。');
}
export function hostKey(host: Frozen<CargoHost>): string {
  return host.kind === 'device' ? stableKey('device', host.deviceId, host.portId)
    : host.kind === 'slot' ? stableKey('slot', host.slotId) : stableKey('transfer', host.transferId);
}
/** 结构检查在每个 put 进行；这里在最终候选视图上检查关系，允许事务内部暂时不一致。 */
export function validateStateView(view: StateReadView, registry: StateAdapterRegistry, budgets: Readonly<StateBudgets>): void {
  const { logic, metadata } = view, now = metadata.logicalTime;
  requireState(metadata.projectionId === metadata.cursor.projectionId, 'CURSOR', '状态游标不属于当前投影。');
  const proof = metadata.baseline;
  requireState(proof.complete && BASELINE_DOMAINS.every(domain => proof.domains[domain])
    && proof.alignment.status === 'aligned' && proof.alignment.evidenceRef !== null,
  'INCOMPLETE_BASELINE', '缺少全域初态或快照/增量对齐证明，不能建立完整状态。');
  requireState(proof.asOf <= now && compareInputCursor(proof.inputCursor, metadata.inputCursor) <= 0,
    'BASELINE', '基线时间或输入边界位于当前状态之后。');
  requireState(metadata.continuity.since >= proof.asOf && metadata.continuity.since <= now
    && (metadata.continuity.status !== 'complete' || metadata.continuity.since === proof.asOf),
  'CONTINUITY', '连续性区间必须从已证明的基线开始；断档不能靠推进自动解除。');
  const requireCounter = (namespace: string, generation: string): void => {
    const counter = view.get('counters', stableKey('counter', namespace));
    requireState(counter && compareDecimal(counter.value, generation) >= 0, 'INCOMPLETE_BASELINE', '生成计数缺失或落后于已有实体，不能安全恢复生成。');
  };
  for (const table of STATE_TABLES) {
    let count = 0;
    for (const record of view.values(table)) {
      requireState(record.id.length > 0, 'IDENTITY', '记录身份不能为空。'); count += 1;
      if (record.id.startsWith('["entity",')) {
        let parts: unknown;
        try { parts = JSON.parse(record.id) as unknown; } catch { requireState(false, 'IDENTITY', '生成身份不是有效元组。'); }
        requireState(Array.isArray(parts) && parts.length === 4 && parts.every(part => typeof part === 'string'), 'IDENTITY', '生成身份元组不完整。');
        assertDecimal(parts[3] as string);
        if (parts[1] === metadata.projectionId) requireCounter(parts[2] as string, parts[3] as string);
      }
    }
    requireState(count <= budgets.maxRecordsPerTable, 'BUDGET', `状态表 ${table} 超过记录预算。`);
  }
  const sources = new Map(logic.sources.map(item => [item.id, item]));
  const models = new Map(logic.models.map(item => [item.id, item]));
  const logicalDevices = new Map(logic.devices.map(item => [item.id, item]));
  const logicalSlots = new Map(logic.slots.map(item => [item.id, item]));
  const generators = new Map(logic.generators.map(item => [item.id, item]));
  const boundaries = unique(proof.sourceBoundaries, item => item.sourceId, '初态来源边界');
  for (const boundary of boundaries.values()) {
    const source = sources.get(boundary.sourceId), current = view.get('sources', boundary.sourceId);
    requireState(source?.revision === boundary.sourceRevision && current?.sourceEpoch === boundary.sourceEpoch,
      'BASELINE', '来源快照边界不匹配来源修订或连接纪元。');
  }
  for (const source of sources.values()) if (source.required) {
    requireState(boundaries.has(source.id) && view.get('sources', source.id), 'INCOMPLETE_BASELINE', '必要来源缺少已对齐初态。');
  }
  const beforeNow = (time: number | null): void => requireState(time === null || time <= now, 'TIME', '状态包含未来观测或完成时间。');
  const cursorBefore = (cursor: Frozen<InputCursor>): void => {
    requireState(compareInputCursor(cursor, metadata.inputCursor) <= 0, 'CURSOR', '记录引用了尚未应用的输入。');
  };
  const devices = unique(view.values('devices'), item => item.id, '设备状态');
  unique(devices.values(), item => deviceIdentityKey(item.identity), '运行中设备身份');
  for (const logical of logicalDevices.values()) {
    requireState(devices.get(logical.id)?.logicalDeviceId === logical.id, 'INCOMPLETE_BASELINE', '静态设备缺少完整 driverState。');
  }
  for (const device of devices.values()) {
    requireState(device.identity.projectId === logic.versions.projectId && sources.has(device.identity.sourceId) && models.has(device.modelId),
      'REFERENCE', '设备项目、来源或数值模型不匹配。');
    assertPose(device.basePose);
    if (device.logicalDeviceId !== null) {
      const logical = logicalDevices.get(device.logicalDeviceId);
      requireState(logical && logical.id === device.id && logical.modelId === device.modelId
        && deviceIdentityKey(logical.identity) === deviceIdentityKey(device.identity) && logical.adapterId === device.driverState.adapterId
        && device.dynamic === null, 'REFERENCE', '静态设备身份或 driverState 与发布清单不符。');
    } else {
      const dynamic = device.dynamic, generator = dynamic && generators.get(dynamic.generatorId);
      requireState(dynamic && generator?.deviceType === device.identity.deviceType && generator.sourceId === device.identity.sourceId
        && generator.modelId === device.modelId && generator.adapterId === device.driverState.adapterId
        && device.id === dynamicDeviceId(device.identity, dynamic.generatorId, dynamic.generation), 'REFERENCE', '动态设备缺少可恢复的生成来源、代次或稳定身份。');
      requireCounter(stableKey('generator', dynamic.generatorId), dynamic.generation);
      beforeNow(dynamic.bornAt); beforeNow(dynamic.lastHeartbeatAt);
      requireState(dynamic.lastHeartbeatAt === null || dynamic.lastHeartbeatAt >= dynamic.bornAt, 'TIME', '动态心跳不能早于生成。');
      if (generator.ttlMs === null) requireState(dynamic.expiresAt === null && dynamic.expiryTimerId === null, 'TTL', '无 TTL 的生成器不能携带到期任务。');
      else {
        const timer = dynamic.expiryTimerId && view.get('timers', dynamic.expiryTimerId);
        requireState(dynamic.expiresAt === (dynamic.lastHeartbeatAt ?? dynamic.bornAt) + generator.ttlMs && timer
          && timer.deviceId === device.id && timer.dueAt === dynamic.expiresAt && timer.phase === 'lifecycle', 'TTL', '动态 TTL 与恢复定时队列不一致。');
      }
    }
    if (device.attachment) {
      const parent = devices.get(device.attachment.deviceId);
      requireState(parent && models.get(parent.modelId)?.anchors.some(anchor => anchor.id === device.attachment!.anchorId), 'REFERENCE', '联动设备的宿主锚点缺失。');
      assertPose(device.attachment.offset);
    }
    const { previous, current, effectiveHeartbeatAt } = device.telemetry;
    requireState(!previous || (current && previous.receivedAt <= current.receivedAt), 'TELEMETRY', '遥测前后帧缺失或次序反转。');
    beforeNow(effectiveHeartbeatAt);
    for (const frame of [previous, current]) if (frame) { beforeNow(frame.receivedAt); cursorBefore(frame.inputCursor); }
    if (current) requireState(effectiveHeartbeatAt !== null && effectiveHeartbeatAt >= current.receivedAt
      && current.deviceEpoch === device.ordering.deviceEpoch, 'TELEMETRY', '当前帧与有效心跳或设备纪元不一致。');
    if (device.ordering.lastInputCursor) cursorBefore(device.ordering.lastInputCursor);
    registry.validateAdapterState(device.driverState, view, device.identity.deviceType);
  }
  noCycles(devices, item => item.attachment?.deviceId ?? null, '设备挂接');
  const occupied = new Map<string, string>();
  for (const cargo of view.values('cargo')) {
    requireState(sources.has(cargo.origin.sourceId), 'REFERENCE', '货物来源缺失。'); cursorBefore(cargo.origin.inputCursor);
    requireState((cargo.origin.generatorId === null) === (cargo.origin.generation === null)
      && (cargo.origin.generatorId === null || generators.has(cargo.origin.generatorId)), 'REFERENCE', '货物生成来源不完整。');
    if (cargo.origin.generatorId !== null && cargo.origin.generation !== null) {
      requireState(generators.get(cargo.origin.generatorId)?.sourceId === cargo.origin.sourceId, 'REFERENCE', '货物生成器与来源不匹配。');
      requireCounter(stableKey('generator', cargo.origin.generatorId), cargo.origin.generation);
    }
    assertPose(cargo.localPose); beforeNow(cargo.createdAt); beforeNow(cargo.destroyedAt);
    requireState(cargo.destroyedAt === null ? cargo.host !== null && cargo.destroyReason === null
      : cargo.destroyedAt >= cargo.createdAt && cargo.host === null && cargo.destroyReason !== null && cargo.handoff === null,
    'CARGO_LIFECYCLE', '活货物必须有唯一宿主；销毁记录必须保留原因且解除宿主。');
    if (cargo.handoff) {
      assertPose(cargo.handoff.fromWorld); beforeNow(cargo.handoff.startedAt);
      requireState(cargo.handoff.endsAt >= cargo.handoff.startedAt, 'TIME', '货物交接展示区间反转。');
    }
    if (!cargo.host) continue;
    const key = hostKey(cargo.host);
    requireState(!occupied.has(key), 'HOST_OCCUPIED', '同一端口、库位或在途交接不能同时持有两件货物。'); occupied.set(key, cargo.id);
    if (cargo.host.kind === 'transfer') {
      const transfer = view.get('transfers', cargo.host.transferId);
      requireState(transfer?.cargoId === cargo.id && transfer.phase === 'in-flight', 'REFERENCE', '在途宿主与交接状态不一致。');
    } else {
      assertEndpoint(view, cargo.host);
      if (cargo.host.kind === 'slot') requireState(view.get('slots', cargo.host.slotId)?.cargoId === cargo.id, 'INVENTORY', '货物宿主与库位占用不一致。');
    }
  }
  for (const slot of logicalSlots.values()) requireState(view.get('slots', slot.id), 'INCOMPLETE_BASELINE', '基线须显式包含空库位，不能把缺项当空库。');
  for (const slot of view.values('slots')) {
    requireState(logicalSlots.has(slot.id), 'REFERENCE', '状态含发布清单之外的库位。');
    if (slot.cargoId !== null) requireState(occupied.get(stableKey('slot', slot.id)) === slot.cargoId, 'INVENTORY', '库位未与唯一货物反向关联。');
  }
  const activeTransfers = new Set<string>();
  for (const transfer of view.values('transfers')) {
    const cargo = view.get('cargo', transfer.cargoId);
    requireState(cargo, 'REFERENCE', '交接货物缺失。'); beforeNow(transfer.startedAt); beforeNow(transfer.completedAt); assertPose(transfer.pose);
    if (transfer.phase === 'pending' || transfer.phase === 'in-flight') {
      requireState(!activeTransfers.has(transfer.cargoId) && transfer.completedAt === null && cargo.destroyedAt === null, 'TRANSFER', '同一货物存在多笔活跃交接或已销毁。');
      activeTransfers.add(transfer.cargoId); assertEndpoint(view, transfer.from); assertEndpoint(view, transfer.to);
      requireState(cargo.host && (transfer.phase === 'pending' ? hostKey(cargo.host) === hostKey(transfer.from)
        : cargo.host.kind === 'transfer' && cargo.host.transferId === transfer.id), 'TRANSFER', '活跃交接与当前宿主不一致。');
    } else requireState(transfer.completedAt !== null && transfer.completedAt >= transfer.startedAt, 'TRANSFER', '已结束交接缺少完成边界。');
    registry.validateAdapterState(transfer.state, view);
  }
  const motionChannels = new Set<string>();
  for (const motion of view.values('motions')) {
    const device = devices.get(motion.deviceId), key = stableKey(motion.deviceId, motion.channel);
    requireState(device && !motionChannels.has(key) && (motion.channel === 'root'
      || models.get(device.modelId)?.anchors.some(anchor => anchor.channel === motion.channel)), 'MOTION', '运动设备、通道缺失或重复。');
    motionChannels.add(key); assertPose(motion.from); assertPose(motion.to); beforeNow(motion.startedAt);
    requireState(motion.endsAt >= motion.startedAt, 'TIME', '运动有效区间反转。');
  }
  for (const request of view.values('fetchRequests')) {
    requireCounter(stableKey('fetch-generation', request.sourceId), request.generation);
    requireState(sources.get(request.sourceId)?.revision === request.sourceRevision
      && request.sourceContractId === logic.versions.sourceContractId && request.rows.length > 0, 'FETCH', '查询来源合同或作用域缺失。');
    unique(request.rows, row => row.row, '查询作用排'); beforeNow(request.issuedAt); beforeNow(request.completedAt);
    requireState(request.status === 'pending' ? request.completedAt === null : request.completedAt !== null && request.completedAt >= request.issuedAt,
      'FETCH', '查询完成状态与时间不一致。');
    requireState(request.status !== 'failed' || request.failure !== null, 'FETCH', '失败查询缺少失败原因。');
    requireState(request.status !== 'succeeded' || request.responseRef !== null, 'FETCH', '成功查询缺少响应证据引用。');
    for (const row of request.rows) {
      const current = view.get('fetchRows', fetchRowId(request.sourceId, row.row));
      requireState(current && (current.operationEpoch !== request.operationEpoch || compareDecimal(row.generation, current.latestGeneration) <= 0), 'FETCH', '查询的逐排代际尚未登记。');
    }
  }
  for (const row of view.values('fetchRows')) {
    requireState(row.id === fetchRowId(row.sourceId, row.row) && sources.has(row.sourceId)
      && logic.slots.some(slot => slot.row === row.row), 'FETCH', '库存排身份或来源不匹配。');
    if (row.latestRequestId !== null) {
      const request = view.get('fetchRequests', row.latestRequestId);
      requireState(request?.sourceId === row.sourceId && request.operationEpoch === row.operationEpoch
        && request.rows.some(item => item.row === row.row && item.generation === row.latestGeneration), 'FETCH', '逐排最新请求与代际不一致。');
    }
    if (row.appliedRequestId !== null) {
      const applied = view.get('fetchRequests', row.appliedRequestId);
      requireState(applied?.sourceId === row.sourceId && applied.rows.some(item => item.row === row.row)
        && (applied.status === 'succeeded' || applied.status === 'superseded'), 'FETCH', '已应用库存没有完成的响应证据。');
    }
    for (const ids of [row.transientSuppressedSlotIds, row.persistentSuppressedSlotIds]) {
      unique(ids, id => id, '库存抑制格口');
      for (const id of ids) requireState(logicalSlots.get(id)?.row === row.row, 'FETCH', '抑制格口不属于当前排。');
    }
    unique(row.pendingSettlement, item => item.cargoId, '待清算货物');
    for (const pending of row.pendingSettlement) {
      const cargo = view.get('cargo', pending.cargoId);
      requireState(cargo && cargo.destroyedAt === null && logicalSlots.get(pending.slotId)?.row === row.row
        && (pending.deviceId === null || devices.has(pending.deviceId))
        && (pending.requestId === null || view.get('fetchRequests', pending.requestId)?.sourceId === row.sourceId), 'FETCH', '待清算货物引用缺失或不属于本排来源。');
    }
  }
  for (const alarm of view.values('alarms')) {
    requireState(devices.has(alarm.deviceId), 'REFERENCE', '告警设备缺失。'); unique(alarm.retained, item => item.property, '告警保留点位');
    for (const item of alarm.retained) { beforeNow(item.receivedAt); cursorBefore(item.inputCursor); }
    beforeNow(alarm.activatedAt); beforeNow(alarm.clearedAt); beforeNow(alarm.evaluatedAt);
    requireState(alarm.active ? alarm.edge === 'active' && alarm.activatedAt !== null : alarm.edge !== 'active', 'ALARM', '告警活跃态与边沿不一致。');
    registry.validateAdapterState(alarm.state, view);
  }
  for (const timer of view.values('timers')) {
    requireCounter('timer-order', timer.ordinal);
    requireState((metadata.continuity.status === 'gap' || timer.dueAt >= now) && (timer.deviceId === null || devices.has(timer.deviceId))
      && (timer.cargoId === null || view.get('cargo', timer.cargoId)?.destroyedAt === null), 'TIMER', '定时任务已过期或关联实体缺失。');
    registry.validateTimer(timer, logic);
  }
  for (const source of view.values('sources')) {
    requireState(sources.get(source.id)?.revision === source.sourceRevision, 'SOURCE', '来源状态与发布修订不匹配。'); cursorBefore(source.lastInputCursor);
    unique(source.recentEvents, item => item.eventId, '来源去重窗口');
    for (const event of source.recentEvents) requireState(compareDecimal(event.offset, source.lastInputCursor.offset) <= 0, 'CURSOR', '去重记录越过来源处理水位。');
  }
  for (const record of view.values('adapterStates')) {
    unique(record.deviceIds, id => id, '脚本设备引用'); unique(record.cargoIds, id => id, '脚本货物引用');
    requireState(record.deviceIds.every(id => devices.has(id)) && record.cargoIds.every(id => view.get('cargo', id)), 'REFERENCE', '受控脚本引用的实体缺失。');
    registry.validateAdapterState(record.state, view);
  }
  registry.validateView(view);
}
/** 不可变身份与销毁墓碑不能被一个普通业务输入重写。 */
export function validateRecordTransition<K extends StateTable>(table: K, before: Frozen<StateTableRecords[K]> | undefined, after: Frozen<StateTableRecords[K]> | undefined): void {
  if (!before) return;
  requireState(after || (table !== 'cargo' && table !== 'counters' && table !== 'sources'), 'IDENTITY', '货物墓碑、来源水位和生成计数不能删除。');
  if (!after) return;
  const same = (a: unknown, b: unknown): void => requireState(canonicalStringify(a) === canonicalStringify(b), 'IDENTITY', '稳定身份或生成来源不能在原记录内改写。');
  if (table === 'devices') {
    const a = before as Frozen<StateTableRecords['devices']>, b = after as Frozen<StateTableRecords['devices']>;
    same([a.identity, a.logicalDeviceId, a.modelId, a.driverState.adapterId], [b.identity, b.logicalDeviceId, b.modelId, b.driverState.adapterId]);
    if (a.dynamic) {
      requireState(b.dynamic, 'IDENTITY', '动态设备不能在原记录内变成静态设备。');
      same([a.dynamic.generatorId, a.dynamic.generation, a.dynamic.bornAt], [b.dynamic.generatorId, b.dynamic.generation, b.dynamic.bornAt]);
    }
  } else if (table === 'cargo') {
    const a = before as Frozen<StateTableRecords['cargo']>, b = after as Frozen<StateTableRecords['cargo']>;
    same([a.origin, a.createdAt], [b.origin, b.createdAt]);
    if (a.destroyedAt !== null) same(a, b);
  } else if (table === 'counters') {
    requireState(compareDecimal((before as Frozen<StateTableRecords['counters']>).value, (after as Frozen<StateTableRecords['counters']>).value) <= 0,
      'COUNTER', '生成计数不能倒退。');
  } else if (table === 'sources') {
    const a = before as Frozen<StateTableRecords['sources']>, b = after as Frozen<StateTableRecords['sources']>;
    same([a.sourceRevision, a.sourceEpoch], [b.sourceRevision, b.sourceEpoch]);
    requireState(compareInputCursor(a.lastInputCursor, b.lastInputCursor) <= 0 && (a.lastSequence === null
      || b.lastSequence !== null && compareDecimal(a.lastSequence, b.lastSequence) <= 0), 'SOURCE', '来源水位不能倒退。');
  } else if (table === 'fetchRequests') {
    const a = before as Frozen<StateTableRecords['fetchRequests']>, b = after as Frozen<StateTableRecords['fetchRequests']>;
    same([a.sourceId, a.sourceRevision, a.sourceContractId, a.operationEpoch, a.generation, a.scope, a.rows],
      [b.sourceId, b.sourceRevision, b.sourceContractId, b.operationEpoch, b.generation, b.scope, b.rows]);
    requireState(a.attemptId === b.attemptId ? a.issuedAt === b.issuedAt
      : (a.status === 'pending' || a.status === 'failed') && b.status === 'pending' && b.completedAt === null && b.issuedAt >= a.issuedAt,
    'FETCH', '重试必须建立新的 attempt 和发起边界，不能改写已完成结果。');
  }
}
