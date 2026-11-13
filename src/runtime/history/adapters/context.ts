import type { DeepReadonly, DeviceState, DeviceType, JsonObject, NumericPose, StateTransactionPort, TelemetryFrame, Vec3 } from '../state/types';
import { DEVICE_TYPES } from '../state/types';
import { draftRecord, identityPose } from '../state/stateOps';
import { compareDecimal, compareText, requireState, stableKey } from '../state/safeJson';
import { samplePose, poseMatrix } from '../state/pose';
import type { Matrix4 } from '../state/pose';
import { portAnchorId } from '../state/validation';
import type { LogisticsDeviceSpec, LogisticsManifest, FrozenLocator, FrozenCell, ConveyorSpec } from './manifest';
import { LOGISTICS_ADAPTER_ID } from './manifest';
import type { LogisticsDriverState } from './runtimeState';
import { wrapLogisticsState } from './runtimeState';
import { V } from './math';
import { CargoOperations } from './cargo';

export type ActorOf<K extends DeviceType> = { kind: K; device: DeviceState; spec: Extract<LogisticsDeviceSpec, { kind: K }>; state: Extract<LogisticsDriverState, { kind: K }> };
export type Actor = { [K in DeviceType]: ActorOf<K> }[DeviceType];
export type DriverFrame = DeepReadonly<TelemetryFrame> & { sourceId: string; assetCode: string; deviceType: string };
export type TargetCell = { locator: FrozenLocator; cell: FrozenCell; position: Vec3 };

/** 每个同步回调只为触及的设备建立草稿；共享逻辑来自 checkpoint 内的发布清单。 */
export class LogisticsContext {
  readonly #actors = new Map<string, Actor>();
  #messages = 0;
  topologyChanged = false;
  readonly removed = new Set<string>();
  readonly cargo: CargoOperations;
  constructor(readonly tx: StateTransactionPort, readonly manifest: DeepReadonly<LogisticsManifest>) { this.cargo = new CargoOperations(this); }
  get now(): number { return this.tx.logicalTime; }
  get dt(): number { return this.manifest.fixedStepMs / 1000; }
  chargeMessage(): void { this.#messages += 1; requireState(this.#messages <= 50_000, 'LOGISTICS_BUDGET', '链路传播超过单次事务预算，拒绝未收敛的业务波。'); }
  spec(device: DeepReadonly<DeviceState>): LogisticsDeviceSpec {
    const published = device.logicalDeviceId !== null
      ? this.manifest.devices.find(spec => spec.deviceId === device.logicalDeviceId)
      : this.manifest.dynamicGenerators.find(generator => generator.generatorId === device.dynamic?.generatorId)?.template;
    requireState(published && published.kind !== 'passive', 'LOGISTICS_MANIFEST', `设备 ${device.id} 缺少已冻结的物流几何和业务配置。`);
    // 动态实例复制旧 spawner 的固定模板姿态；只改变稳定身份，不从遥测位置猜测模型几何。
    return { ...published, deviceId: device.id, assetCode: device.identity.assetCode, sourceId: device.identity.sourceId,
      deviceType: device.dynamic ? device.identity.deviceType : published.deviceType } as LogisticsDeviceSpec;
  }
  ids(kind?: DeviceType): string[] {
    return [...this.tx.values('devices')].filter(device => !this.removed.has(device.id)
      && device.driverState.adapterId === LOGISTICS_ADAPTER_ID && DEVICE_TYPES.includes(device.driverState.value.kind as DeviceType)
      && (!kind || device.driverState.value.kind === kind))
      .sort((a, b) => {
        if (Boolean(a.dynamic) !== Boolean(b.dynamic)) return a.dynamic ? 1 : -1;
        if (a.dynamic && b.dynamic) {
          const ao = a.driverState.value.birthOrder, bo = b.driverState.value.birthOrder;
          if (typeof ao === 'string' && typeof bo === 'string') return compareDecimal(ao, bo) || compareText(a.id, b.id);
        }
        return this.spec(a).executionOrder - this.spec(b).executionOrder || compareText(a.id, b.id);
      }).map(device => device.id);
  }
  actor(id: string): Actor {
    const existing = this.#actors.get(id); if (existing) return existing;
    const device = draftRecord(this.tx, 'devices', id), spec = this.spec(device);
    const state = device.driverState.value as unknown as LogisticsDriverState;
    requireState(state.kind === spec.kind && spec.deviceType === device.identity.deviceType, 'LOGISTICS_STATE', '驱动状态类型或实际主体类型与发布绑定不符。');
    const actor = { kind: spec.kind, device, spec, state } as Actor;
    this.#actors.set(id, actor); return actor;
  }
  of<K extends DeviceType>(id: string, kind: K): ActorOf<K> {
    const actor = this.actor(id); requireState(actor.kind === kind, 'LOGISTICS_STATE', '跨设备业务调用命中了错误的设备类型。');
    return actor as ActorOf<K>;
  }
  frame(actor: Actor): DriverFrame | null {
    const current = actor.device.telemetry.current; if (!current) return null;
    return { ...current, receivedAt: actor.device.telemetry.effectiveHeartbeatAt ?? current.receivedAt,
      sourceId: actor.device.identity.sourceId, assetCode: actor.device.identity.assetCode, deviceType: actor.device.identity.deviceType };
  }
  shouldRun(actor: Actor): boolean {
    const frame = this.frame(actor); if (!frame) return false;
    if (this.now - frame.receivedAt <= actor.spec.staleAfterMs) return true;
    return actor.kind === 'stacker' || actor.kind === 'shuttle' || actor.kind === 'hclift'
      || (actor.kind === 'conveyor' && actor.state.selfDriveDirection !== 0);
  }
  issue(actor: Actor, code: string): void { if (!actor.state.diagnostics.includes(code)) actor.state.diagnostics.push(code); }
  locator(id: string): FrozenLocator | null { return this.manifest.locators.find(locator => locator.id === id) as FrozenLocator | undefined ?? null; }
  cell(locator: FrozenLocator, column: number, layer: number): TargetCell | null {
    const cell = locator.cells.find(cell => cell.column === column && cell.layer === layer);
    return cell ? { locator, cell, position: V.copy(cell.pose.position) } : null;
  }
  findCell(assetCode: string, aisleCode: string | null, column: number, layer: number, row: number, depth?: 'near' | 'far'): TargetCell | null {
    for (const locator of this.manifest.locators) {
      if (locator.row !== row || depth !== undefined && locator.depth !== depth) continue;
      if (aisleCode === null ? locator.deviceAssetCode !== assetCode : !aisleCode || locator.aisleCode !== aisleCode) continue;
      const cell = this.cell(locator as FrozenLocator, column, layer); if (cell) return cell;
    }
    return null;
  }
  platform(assetCode: string, aisleCode: string): FrozenLocator | null {
    const locators = this.manifest.locators.filter(locator => locator.kind === 'layer-change');
    return (locators.find(locator => locator.deviceAssetCode !== '' && locator.deviceAssetCode === assetCode)
      ?? (aisleCode ? locators.find(locator => locator.aisleCode === aisleCode) : null) ?? null) as FrozenLocator | null;
  }
  conveyor(id: string | null): ActorOf<'conveyor'> | null {
    if (!id || this.removed.has(id)) return null;
    const record = this.tx.get('devices', id); return record?.driverState.value.kind === 'conveyor' ? this.of(id, 'conveyor') : null;
  }
  conveyorSurface(spec: Pick<ConveyorSpec, 'center' | 'upAxis' | 'surfaceLift'>): Vec3 {
    return V.add(spec.center, V.scale(spec.upAxis, spec.surfaceLift));
  }
  cargoPort(actor: Actor, role: 'front' | 'back' | 'single' | 'step1' | 'step2'): string {
    const port = actor.spec.cargoPorts[role === 'step1' ? 'front' : role === 'step2' ? 'back' : role];
    requireState(port, 'LOGISTICS_MANIFEST', `设备 ${actor.device.id} 没有 ${role} 的逻辑货物端口。`); return port;
  }
  hostMatrix(deviceId: string, portId: string): DeepReadonly<Matrix4> {
    const anchorId = portAnchorId(this.tx, deviceId, portId);
    const sample = samplePose(this.tx, this.now, { deviceIds: [deviceId], cargoIds: [] });
    const anchor = sample.devices[0]?.anchors.find(anchor => anchor.id === anchorId);
    requireState(anchor, 'LOGISTICS_MANIFEST', '货物宿主逻辑锚点不可采样。'); return anchor.worldMatrix;
  }
  slotMatrix(slotId: string): Matrix4 {
    const slot = this.tx.logic.slots.find(slot => slot.id === slotId); requireState(slot, 'LOGISTICS_MANIFEST', '库存库位没有规范化位姿。');
    return poseMatrix(slot.pose);
  }
  publishMotion(actor: Actor, values: { travel?: Vec3; lift?: Vec3; frontFork?: number; backFork?: number; shuttleFork?: number }): void {
    for (const part of actor.spec.motionParts) {
      let world = V.zero();
      if (part.travel && values.travel) world = V.add(world, values.travel);
      if (part.lift && values.lift) world = V.add(world, values.lift);
      const fork = part.frontFork * (values.frontFork ?? 0) + part.backFork * (values.backFork ?? 0) + part.shuttleFork * (values.shuttleFork ?? 0);
      world = V.add(world, V.scale(actor.spec.forkAxis, fork));
      const m = part.worldToParent;
      const local: Vec3 = [m[0] * world[0] + m[3] * world[1] + m[6] * world[2],
        m[1] * world[0] + m[4] * world[1] + m[7] * world[2], m[2] * world[0] + m[5] * world[1] + m[8] * world[2]];
      const id = stableKey('logistics-motion', actor.device.id, part.channel), previous = this.tx.get('motions', id);
      const to: NumericPose = { ...identityPose(), position: local };
      this.tx.put('motions', { id, deviceId: actor.device.id, channel: part.channel,
        startedAt: Math.max(actor.state.lastFrameAt ?? this.now, this.now - this.manifest.fixedStepMs), endsAt: this.now,
        from: previous ? previous.to as NumericPose : to, to, interpolation: 'linear-slerp' });
    }
  }
  flush(): void {
    for (const actor of this.#actors.values()) if (!this.removed.has(actor.device.id)) {
      actor.device.driverState = wrapLogisticsState(actor.state); this.tx.put('devices', actor.device);
    }
  }
  parameterObject(value: unknown): JsonObject { return value as JsonObject; }
}
