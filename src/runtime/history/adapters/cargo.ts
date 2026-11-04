import type { CargoHost, CargoState, NumericPose, Quaternion, Vec3 } from '../state/types';
import { allocateCargoId, fetchRowId, nextGeneration } from '../state/identity';
import { draftRecord, destroyCargo, identityPose, moveCargo } from '../state/stateOps';
import { issueFetchRequest } from '../state/fetch';
import { compareDecimal, copySafeJson, requireState, stableKey } from '../state/safeJson';
import { poseMatrix } from '../state/pose';
import type { Actor, LogisticsContext, TargetCell } from './context';
import type { CargoRuntimeState, ForkCargoState, PlaceTarget } from './runtimeState';
import { emptyForkCargo, emptyLiftStation, wrapLogisticsState } from './runtimeState';
import type { FrozenCargoTemplate, InventoryContainerRecord } from './manifest';
import { acceptColumnCargo, acceptPlatformCargo, takePlatformCargo } from './conveyor';
import { blendPose, projectedBounds, relativePose, V } from './math';

type Role = NonNullable<CargoRuntimeState['ownerRole']>;
export const cargoRuntimeId = (cargoId: string): string => stableKey('logistics-cargo', cargoId);
export class CargoOperations {
  constructor(readonly ctx: LogisticsContext) {}
  has(cargoId: string): boolean { return this.ctx.tx.get('adapterStates', cargoRuntimeId(cargoId))?.state.value.kind === 'cargo'; }
  meta(cargoId: string): CargoRuntimeState {
    const record = draftRecord(this.ctx.tx, 'adapterStates', cargoRuntimeId(cargoId));
    const value = record.state.value as unknown as CargoRuntimeState;
    requireState(value.kind === 'cargo' && value.cargoId === cargoId, 'LOGISTICS_CARGO', '货物缺少可恢复的物流生命周期状态。'); return value;
  }
  saveMeta(value: CargoRuntimeState): void {
    const cargo = this.ctx.tx.get('cargo', value.cargoId);
    this.ctx.tx.put('adapterStates', { id: cargoRuntimeId(value.cargoId), cargoIds: [value.cargoId],
      deviceIds: cargo?.host?.kind === 'device' ? [cargo.host.deviceId] : [], state: wrapLogisticsState(value) });
  }
  record(id: string): CargoState { return draftRecord(this.ctx.tx, 'cargo', id); }
  template(id: string): FrozenCargoTemplate {
    const template = this.ctx.manifest.cargoTemplates.find(template => template.id === id);
    requireState(template, 'LOGISTICS_GEOMETRY', `货箱模板 ${id} 未冻结实际尺寸。`); return template as FrozenCargoTemplate;
  }
  templateFor(actor: Actor): string {
    let templateId = actor.spec.cargoTemplateId;
    const generator = this.ctx.manifest.cargoGenerators.find(generator => generator.generatorId === actor.spec.cargoGeneratorId);
    if (generator) {
      const frame = this.ctx.frame(actor);
      templateId = generator.defaultTemplateId;
      for (const rule of generator.rules) {
        const field = rule.attributeName.trim(); if (!field || !frame) continue;
        const value = field === 'sourceId' ? frame.sourceId : field === 'deviceType' ? frame.deviceType : field === 'assetCode' ? frame.assetCode : frame.fields[field];
        if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
          && String(value).trim() === rule.attributeValue.trim()) {
          const matched = rule.templateId ?? generator.defaultTemplateId;
          if (matched) { templateId = matched; break; }
        }
      }
      templateId ??= actor.spec.cargoTemplateId;
    }
    requireState(templateId, 'LOGISTICS_GEOMETRY', '持货设备没有已冻结的货箱模板或旧内置回退几何。'); this.template(templateId); return templateId;
  }
  syncTemplate(actor: Actor, cargoId: string): void {
    const meta = this.meta(cargoId), templateId = this.templateFor(actor);
    if (meta.templateId !== templateId) { meta.templateId = templateId; this.saveMeta(meta); }
  }
  create(actor: Actor, role: Role, task: string, containerCode: string): string {
    const portId = this.ctx.cargoPort(actor, role);
    return this.insert(actor.device.identity.sourceId, { kind: 'device', deviceId: actor.device.id, portId }, this.templateFor(actor),
      { ...identityPose(), position: V.copy(actor.spec.basePosition) }, task, containerCode, actor.device.id, role, false);
  }
  createInventory(sourceId: string, target: TargetCell, record: InventoryContainerRecord, templateId: string): string {
    return this.insert(sourceId, { kind: 'slot', slotId: target.cell.slotId }, templateId,
      { position: V.copy(target.position), rotation: [...target.cell.pose.rotation] as Quaternion, scale: V.copy(target.cell.pose.scale) }, '', record.containerCode, null, null, true);
  }
  private insert(sourceId: string, host: CargoHost, templateId: string, worldPose: NumericPose, task: string, containerCode: string, ownerDeviceId: string | null, ownerRole: Role | null, hasPose: boolean): string {
    const id = allocateCargoId(this.ctx.tx, sourceId); this.template(templateId);
    const record: CargoState = { id, containerCode: containerCode || null, taskId: task || null,
      origin: { sourceId, inputCursor: { ...this.ctx.tx.inputCursor }, generatorId: null, generation: null },
      host: null, localPose: identityPose(), handoff: null, createdAt: this.ctx.now, destroyedAt: null, destroyReason: null };
    this.ctx.tx.put('cargo', record); moveCargo(this.ctx.tx, id, host);
    const value: CargoRuntimeState = { kind: 'cargo', cargoId: id, templateId, ownerDeviceId, ownerRole,
      retained: false, awaitingFetch: false, ownershipOrder: nextGeneration(this.ctx.tx, 'logistics-ownership'),
      hasPose, worldPose, lockedWorldRotation: hasPose ? [...worldPose.rotation] as Quaternion : null, handoff: null };
    this.saveMeta(value); this.writeWorld(id, value, worldPose); return id;
  }
  world(cargoId: string): NumericPose { return this.meta(cargoId).worldPose; }
  task(cargoId: string | null): string { return cargoId ? this.ctx.tx.get('cargo', cargoId)?.taskId ?? '' : ''; }
  annotate(cargoId: string, task: string, containerCode?: string): void {
    const cargo = this.record(cargoId); cargo.taskId = task || null;
    if (containerCode) cargo.containerCode = containerCode; this.ctx.tx.put('cargo', cargo);
  }
  setWorld(cargoId: string, position: Vec3, rotation: Quaternion | null = null, scaling: Vec3 | null = null, deltaSeconds = 0): void {
    const meta = this.meta(cargoId);
    let pose: NumericPose = { position: V.copy(position), rotation: rotation ?? meta.lockedWorldRotation ?? [0, 0, 0, 1], scale: scaling ?? [1, 1, 1] };
    if (meta.handoff) {
      meta.handoff.progress = Math.min(1, meta.handoff.progress + deltaSeconds / meta.handoff.durationSeconds);
      const targetScale = pose.scale;
      pose = blendPose(meta.handoff.from, pose, meta.handoff.progress); pose.scale = targetScale;
      if (meta.handoff.progress >= 1) meta.handoff = null;
    }
    meta.hasPose = true; meta.worldPose = pose; meta.lockedWorldRotation ??= [...pose.rotation] as Quaternion;
    this.writeWorld(cargoId, meta, pose); this.saveMeta(meta);
  }
  private writeWorld(cargoId: string, meta: CargoRuntimeState, world: NumericPose): void {
    const cargo = this.record(cargoId), host = cargo.host; requireState(host, 'LOGISTICS_CARGO', '活货物没有唯一宿主。');
    const parent = host.kind === 'device' ? this.ctx.hostMatrix(host.deviceId, host.portId)
      : host.kind === 'slot' ? this.ctx.slotMatrix(host.slotId)
        : poseMatrix(draftRecord(this.ctx.tx, 'transfers', host.transferId).pose);
    cargo.localPose = relativePose(world, parent); cargo.handoff = null;
    meta.worldPose = world; this.ctx.tx.put('cargo', cargo);
  }
  clearHandoff(cargoId: string): void { const meta = this.meta(cargoId); meta.handoff = null; this.saveMeta(meta); }
  startHandoff(cargoId: string, seconds = 1): void {
    const meta = this.meta(cargoId);
    meta.handoff = meta.hasPose ? { from: copySafeJson(meta.worldPose) as unknown as NumericPose, progress: 0, durationSeconds: Math.max(seconds, 0.05) } : null;
    this.saveMeta(meta);
  }
  moveHandoffOrigin(cargoId: string, delta: Vec3): void {
    const meta = this.meta(cargoId); if (!meta.handoff) return;
    meta.handoff.from.position = V.add(meta.handoff.from.position, delta); this.saveMeta(meta);
  }
  own(cargoId: string, actor: Actor, role: Role): void {
    const meta = this.meta(cargoId), pose = meta.worldPose;
    if (meta.awaitingFetch) for (const value of this.ctx.tx.values('fetchRows')) if (value.pendingSettlement.some(item => item.cargoId === cargoId)) {
      const row = draftRecord(this.ctx.tx, 'fetchRows', value.id);
      row.pendingSettlement = row.pendingSettlement.filter(item => item.cargoId !== cargoId); this.ctx.tx.put('fetchRows', row);
    }
    moveCargo(this.ctx.tx, cargoId, { kind: 'device', deviceId: actor.device.id, portId: this.ctx.cargoPort(actor, role) });
    meta.ownerDeviceId = actor.device.id; meta.ownerRole = role; meta.retained = false; meta.awaitingFetch = false;
    meta.ownershipOrder = nextGeneration(this.ctx.tx, 'logistics-ownership');
    this.writeWorld(cargoId, meta, pose); this.saveMeta(meta);
  }
  /** 清理旧承运者引用，不销毁货物；接收方在同一个事务内换宿主。 */
  detach(cargoId: string): void {
    const meta = this.meta(cargoId); if (!meta.ownerDeviceId || !this.ctx.tx.get('devices', meta.ownerDeviceId)) return;
    const actor = this.ctx.actor(meta.ownerDeviceId);
    if (actor.kind === 'stacker') {
      for (const side of ['front', 'back'] as const) if (actor.state[side].cargoId === cargoId) Object.assign(actor.state[side], emptyForkCargo());
    } else if (actor.kind === 'shuttle') {
      if (actor.state.cargoId === cargoId) Object.assign(actor.state, emptyForkCargo());
    } else if (actor.kind === 'rgv') {
      for (const side of ['front', 'back'] as const) if (actor.state[side].cargoId === cargoId) Object.assign(actor.state[side],
        { cargoId: null, onBoard: false, holdPosition: null, holdRotation: null, progress: 0 });
    } else if (actor.kind === 'lift') {
      for (const station of actor.state.stations) if (station.cargoId === cargoId) { Object.assign(station, emptyLiftStation()); actor.state.outgoingHandoffCooldown = 1; }
    } else if (actor.kind === 'conveyor' && actor.state.cargoId === cargoId) {
      Object.assign(actor.state, { cargoId: null, handoffEntryOffset: null, entryHandoffPending: false, platformInboundCargo: false, platformPlacedCargo: false });
    }
  }
  readyForPull(cargoId: string): boolean {
    const meta = this.meta(cargoId); if (!meta.ownerDeviceId || !this.ctx.tx.get('devices', meta.ownerDeviceId)) return false;
    const actor = this.ctx.actor(meta.ownerDeviceId);
    if (actor.kind === 'stacker') return ![actor.state.front, actor.state.back].some(fork => fork.cargoId === cargoId && fork.pendingPlatformLocatorId !== null);
    if (actor.kind === 'shuttle') return actor.state.cargoId !== cargoId || actor.state.pendingPlatformLocatorId === null;
    if (actor.kind === 'rgv') return [actor.state.front, actor.state.back].some(station => station.cargoId === cargoId && station.lastCommand === 2 && actor.state.travelTargetPosition === null);
    if (actor.kind === 'lift') return actor.state.stations.some((station, index) => station.cargoId === cargoId
      && (index !== 0 || actor.state.stations[1].cargoId === null) && actor.state.arrivedTargetKey !== null
      && actor.state.arrivedTargetKey === actor.state.targetKey && station.onBoard && !station.transferActive);
    return false;
  }
  findByTask(task: string, claimant: Actor, role: Role): string | null {
    if (!task) return null;
    const order = ['stacker', 'conveyor', 'rgv', 'shuttle', 'lift'];
    const candidates = [...this.ctx.tx.values('cargo')].filter(cargo => cargo.destroyedAt === null && cargo.taskId === task && this.has(cargo.id))
      .map(cargo => ({ cargo, meta: this.meta(cargo.id) })).filter(({ meta }) => !meta.retained && meta.ownerDeviceId !== null
        && !(meta.ownerDeviceId === claimant.device.id && meta.ownerRole === role))
      .sort((a, b) => {
        const ak = String(this.ctx.tx.get('devices', a.meta.ownerDeviceId!)?.driverState.value.kind ?? 'passive');
        const bk = String(this.ctx.tx.get('devices', b.meta.ownerDeviceId!)?.driverState.value.kind ?? 'passive');
        return order.indexOf(ak) - order.indexOf(bk) || compareDecimal(a.meta.ownershipOrder, b.meta.ownershipOrder);
      });
    for (const { cargo, meta } of candidates) {
      const owner = this.ctx.tx.get('devices', meta.ownerDeviceId!); if (!owner) continue;
      // 原 global task 接管仅对 shuttle 待收叉和 lift 在途加门；RGV/stacker 的更严门控属于帧尾 pull。
      if ((owner.driverState.value.kind === 'shuttle' || owner.driverState.value.kind === 'lift') && !this.readyForPull(cargo.id)) continue;
      return cargo.id;
    }
    return null;
  }
  acquire(actor: Actor, role: Role, task: string, containerCode: string, target?: TargetCell): string {
    let id: string | null = null;
    const slotted = target ? this.ctx.tx.get('slots', target.cell.slotId)?.cargoId ?? null : null;
    if (slotted && this.meta(slotted).retained) id = slotted;
    if (!id && target?.locator.hostDeviceId) {
      const conveyor = this.ctx.conveyor(target.locator.hostDeviceId);
      if (conveyor) id = takePlatformCargo(this.ctx, conveyor, actor.device.id);
    }
    id ??= this.findByTask(task, actor, role);
    // 原 thinInstance 库存升级为规范化货物后，源格已存在的实体直接接管，不能再制造第二件相同实物。
    id ??= slotted;
    if (id) { this.detach(id); this.own(id, actor, role); this.annotate(id, task, containerCode); this.startHandoff(id); }
    else id = this.create(actor, role, task, containerCode);
    return id;
  }
  dispose(cargoId: string, reason: string): void {
    const cargo = this.ctx.tx.get('cargo', cargoId); if (!cargo || cargo.destroyedAt !== null) return;
    this.detach(cargoId);
    for (const value of this.ctx.tx.values('fetchRows')) if (value.pendingSettlement.some(item => item.cargoId === cargoId)) {
      const row = draftRecord(this.ctx.tx, 'fetchRows', value.id); row.pendingSettlement = row.pendingSettlement.filter(item => item.cargoId !== cargoId); this.ctx.tx.put('fetchRows', row);
    }
    destroyCargo(this.ctx.tx, cargoId, reason);
    if (this.ctx.tx.get('adapterStates', cargoRuntimeId(cargoId))) this.ctx.tx.remove('adapterStates', cargoRuntimeId(cargoId));
  }
  disposeLegacyRole(actor: Actor, role: Role): void {
    for (const cargo of this.ctx.tx.values('cargo')) {
      if (cargo.destroyedAt !== null || !this.has(cargo.id)) continue;
      const meta = this.meta(cargo.id);
      if (meta.ownerDeviceId === actor.device.id && meta.ownerRole === role && !meta.retained) this.dispose(cargo.id, 'legacy-role-replaced');
    }
  }
  suppress(target: TargetCell, preserveCargoId: string | null = null): string | null {
    const locator = target.locator; if (locator.fetchSourceId === null || locator.fetchRow === null) return null;
    const id = fetchRowId(locator.fetchSourceId, locator.fetchRow), row = draftRecord(this.ctx.tx, 'fetchRows', id);
    if (!row.transientSuppressedSlotIds.includes(target.cell.slotId)) row.transientSuppressedSlotIds.push(target.cell.slotId);
    this.ctx.tx.put('fetchRows', row);
    const occupant = this.ctx.tx.get('slots', target.cell.slotId)?.cargoId;
    if (occupant && occupant !== preserveCargoId) this.dispose(occupant, 'inventory-representation-suppressed');
    return id;
  }
  releaseRetained(target: TargetCell): void {
    if (target.locator.fetchSourceId === null || target.locator.fetchRow === null) return;
    const id = fetchRowId(target.locator.fetchSourceId, target.locator.fetchRow), row = draftRecord(this.ctx.tx, 'fetchRows', id);
    row.persistentSuppressedSlotIds = row.persistentSuppressedSlotIds.filter(slotId => slotId !== target.cell.slotId); this.ctx.tx.put('fetchRows', row);
  }
  requestRow(rowId: string): string {
    const row = draftRecord(this.ctx.tx, 'fetchRows', rowId);
    return issueFetchRequest(this.ctx.tx, { sourceId: row.sourceId, operationEpoch: row.operationEpoch, scope: 'rows', rows: [row.row] });
  }
  holdAtSlot(cargoId: string, actor: Actor, target: PlaceTarget, rowId: string | null, retained: boolean): void {
    requireState(retained || rowId !== null, 'LOGISTICS_FETCH', '待库存清算的货物必须关联明确的排。');
    const previous = this.ctx.tx.get('slots', target.slotId)?.cargoId;
    if (previous && previous !== cargoId) this.dispose(previous, 'slot-placement-replaced');
    const meta = this.meta(cargoId); this.detach(cargoId);
    moveCargo(this.ctx.tx, cargoId, { kind: 'slot', slotId: target.slotId });
    // 入格后唯一宿主是库位，放货设备只留在待清算事实中，不能继续作为承运者参与 task 接管。
    meta.ownerDeviceId = null; meta.ownerRole = null;
    meta.retained = retained; meta.awaitingFetch = !retained; meta.handoff = null;
    this.writeWorld(cargoId, meta, { ...meta.worldPose, position: V.copy(target.supportPosition) }); this.saveMeta(meta);
    if (rowId) {
      const row = draftRecord(this.ctx.tx, 'fetchRows', rowId);
      if (retained) { if (!row.persistentSuppressedSlotIds.includes(target.slotId)) row.persistentSuppressedSlotIds.push(target.slotId); }
      else if (!row.pendingSettlement.some(item => item.cargoId === cargoId)) row.pendingSettlement.push({ cargoId, slotId: target.slotId, deviceId: actor.device.id, requestId: null });
      this.ctx.tx.put('fetchRows', row);
      const requestId = this.requestRow(rowId), next = draftRecord(this.ctx.tx, 'fetchRows', rowId);
      for (const pending of next.pendingSettlement) if (pending.cargoId === cargoId) pending.requestId = requestId;
      this.ctx.tx.put('fetchRows', next);
    }
  }
  placePlatform(locatorId: string, cargoId: string): boolean {
    const locator = this.ctx.locator(locatorId), receiver = this.ctx.conveyor(locator?.hostDeviceId ?? null);
    return Boolean(locator && receiver && acceptPlatformCargo(this.ctx, receiver, locator, cargoId));
  }
  deliverColumn(deviceId: string | null, cargoId: string, task: string, preserve: boolean, requireTaskMatch = true): boolean {
    const receiver = this.ctx.conveyor(deviceId); return receiver ? acceptColumnCargo(this.ctx, receiver, cargoId, task, preserve, requireTaskMatch) : false;
  }
  axialLength(cargoId: string | null, axis: Vec3, fallbackTemplate: string): number {
    const meta = cargoId ? this.meta(cargoId) : null, template = this.template(meta?.templateId ?? fallbackTemplate);
    const rotation = meta?.lockedWorldRotation ?? [0, 0, 0, 1];
    const transform = poseMatrix({ position: [0, 0, 0], rotation: rotation as Quaternion, scale: meta?.worldPose.scale ?? [1, 1, 1] });
    const localAxis: Vec3 = [transform[0] * axis[0] + transform[1] * axis[1] + transform[2] * axis[2],
      transform[4] * axis[0] + transform[5] * axis[1] + transform[6] * axis[2], transform[8] * axis[0] + transform[9] * axis[1] + transform[10] * axis[2]];
    const bounds = projectedBounds(template.bounds, localAxis); return bounds.max - bounds.min;
  }
  lockedRotation(cargoId: string): Quaternion { return this.meta(cargoId).lockedWorldRotation ?? [0, 0, 0, 1]; }
  placeTarget(target: TargetCell): PlaceTarget { return { locatorId: target.locator.id, slotId: target.cell.slotId,
    column: target.cell.column, layer: target.cell.layer, supportPosition: V.copy(target.position), retainCargo: target.locator.retainCargo }; }
  restoreTarget(value: PlaceTarget | null): TargetCell | null {
    if (!value) return null; const locator = this.ctx.locator(value.locatorId); if (!locator) return null;
    const target = this.ctx.cell(locator, value.column, value.layer); return target ? { ...target, position: V.copy(value.supportPosition) } : null;
  }
  clearFork(fork: ForkCargoState): void { Object.assign(fork, emptyForkCargo()); }
}
