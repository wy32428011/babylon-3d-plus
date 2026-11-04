import { readIntegerField } from '../../mqtt/deviceTelemetry';
import type { ActorOf, DriverFrame, LogisticsContext } from './context';
import type { LiftStationState } from './runtimeState';
import { emptyLiftStation } from './runtimeState';
import type { Vec3 } from '../state/types';
import { takePlatformCargo } from './conveyor';
import { clamp, moveNumber, V } from './math';

type Lift = ActorOf<'lift'>;
function stationPosition(actor: Lift, index: 0 | 1): Vec3 {
  const base = V.add(actor.spec.deckCenterBase, V.scale(actor.spec.upAxis, actor.state.liftOffset));
  return actor.spec.cargoAxis ? V.add(base, V.scale(actor.spec.cargoAxis, (index === 0 ? -1 : 1) * actor.spec.stationOffset)) : base;
}
function candidate(ctx: LogisticsContext, actor: Lift, side: 0 | 1, layer: number): ActorOf<'conveyor'> | null {
  const table = side === 0 ? actor.spec.incomingLayers : actor.spec.outgoingLayers;
  const binding = table.find(item => item.layer === layer), choices = binding?.targets.map(item => ctx.conveyor(item.deviceId)).filter((item): item is ActorOf<'conveyor'> => item !== null) ?? [];
  if (!choices.length) { ctx.issue(actor, 'lift-layer-unbound:' + side + ':' + layer); return null; }
  return choices.find(item => side === 0 ? item.state.cargoId !== null : item.state.cargoId === null) ?? choices[0];
}
function taskAnnotation(ctx: LogisticsContext, actor: Lift, frame: DriverFrame, index: 0 | 1, field: string): void {
  const value = readIntegerField(frame.fields, field), station = actor.state.stations[index];
  if (value === null || value === 0 || !station.cargoId) return;
  const task = String(value), otherId = actor.state.stations[index === 0 ? 1 : 0].cargoId;
  if (otherId && ctx.cargo.task(otherId) === task) return;
  station.taskAnnotationSeen = true; ctx.cargo.annotate(station.cargoId, task);
}
function finishPickup(station: LiftStationState): void {
  station.transferProgress = 1; station.onBoard = true; station.transferActive = false; station.holdPosition = null; station.holdRotation = null;
}
function adoptIncoming(ctx: LogisticsContext, actor: Lift, deviceId: string, index: 0 | 1): void {
  const source = ctx.conveyor(deviceId); if (!source) return;
  const id = takePlatformCargo(ctx, source, actor.device.id); if (!id) return;
  const station = actor.state.stations[index], oldId = station.cargoId; if (oldId && oldId !== id) ctx.cargo.dispose(oldId, 'lift-station-replaced');
  ctx.cargo.own(id, actor, index === 0 ? 'step1' : 'step2'); ctx.cargo.startHandoff(id);
  station.cargoId = id; station.onBoard = false; station.holdPosition = V.copy(ctx.cargo.world(id).position);
  station.holdRotation = null; station.transferProgress = 0; station.transferDirection = 1; station.transferActive = true;
}
function processOutgoing(ctx: LogisticsContext, actor: Lift, deviceId: string): void {
  const state = actor.state, front = state.stations[0], back = state.stations[1];
  if (back.cargoId === null && front.cargoId !== null && front.onBoard && !front.transferActive && state.outgoingHandoffCooldown <= 0) {
    const id = front.cargoId, outgoing = front.outgoingDeviceId, seen = front.taskAnnotationSeen, reached = front.reachedOutgoing;
    const start = stationPosition(actor, 0);
    // 同台排队改端口不调用“离台 detach”，否则会错误地再次启动出站冷却。
    ctx.cargo.own(id, actor, 'step2'); Object.assign(front, emptyLiftStation());
    back.cargoId = id; back.onBoard = false; back.holdPosition = start; back.holdRotation = null;
    back.transferProgress = 0; back.transferDirection = 1; back.transferActive = true;
    back.outgoingDeviceId ??= outgoing; back.taskAnnotationSeen ||= seen; back.reachedOutgoing ||= reached;
  }
  if (back.cargoId && back.onBoard && ctx.cargo.deliverColumn(deviceId, back.cargoId, '', false, false)) Object.assign(back, emptyLiftStation());
}
function updateCargoPoses(ctx: LogisticsContext, actor: Lift): void {
  for (const index of [0, 1] as const) {
    const station = actor.state.stations[index], id = station.cargoId; if (!id) continue;
    ctx.cargo.syncTemplate(actor, id);
    const anchor = stationPosition(actor, index), delta = station.anchorPosition ? V.sub(anchor, station.anchorPosition) : null;
    station.anchorPosition = V.copy(anchor);
    if (delta && V.dot(delta, delta) > 1e-12) {
      if (station.holdPosition) station.holdPosition = V.add(station.holdPosition, delta);
      ctx.cargo.moveHandoffOrigin(id, delta);
    }
    // 提前升降时立即落到工位；不能把未收敛的上台动画拖成斜线。
    if (delta && Math.abs(V.dot(delta, actor.spec.upAxis)) > 1e-4) {
      if (station.transferActive) finishPickup(station);
      ctx.cargo.clearHandoff(id);
    }
    const target = !station.onBoard && station.holdPosition ? V.lerp(station.holdPosition, anchor, station.transferProgress) : anchor;
    ctx.cargo.setWorld(id, target, ctx.cargo.lockedRotation(id), null, ctx.dt);
  }
}
/** 旧双工位 lift：step2 优先收/出、1s 离台冷却、1.5s 排队平移以及 PLC 标注归零对账。 */
export function stepLift(ctx: LogisticsContext, actor: Lift, frame: DriverFrame): void {
  const state = actor.state, spec = actor.spec;
  state.workState = readIntegerField(frame.fields, 'work_state');
  taskAnnotation(ctx, actor, frame, 0, 'task_num_fin_first_up'); taskAnnotation(ctx, actor, frame, 1, 'task_num_fin_second_up');
  const frozen = frame.faulted || state.workState === 10;
  const sideValue = readIntegerField(frame.fields, 'reference_upper_step'), side = sideValue === 1 ? 0 : sideValue === 2 ? 1 : null;
  const layerValue = readIntegerField(frame.fields, 'level_upper'), layer = layerValue !== null && layerValue > 0 ? layerValue : null;
  const key = side !== null && layer !== null ? side + ':' + layer : null;
  if (!frozen && key !== null && key !== state.targetKey) {
    const target = candidate(ctx, actor, side as 0 | 1, layer as number);
    if (target) {
      state.targetKey = key; state.targetSide = side; state.targetLayer = layer; state.targetDeviceId = target.device.id; state.arrivedTargetKey = null;
      state.liftTargetOffset = clamp(V.dot(ctx.conveyorSurface(target.spec), spec.upAxis) - spec.deckTopBase, spec.liftLimits.min, spec.liftLimits.max);
    }
  }
  if (!frozen && state.liftTargetOffset !== null) {
    const rush = (state.workState === 1 || state.workState === 3) && state.arrivedTargetKey !== state.targetKey;
    state.liftOffset = moveNumber(state.liftOffset, state.liftTargetOffset, spec.liftSpeed * (rush ? 4 : 1) * ctx.dt);
    if (state.liftOffset === state.liftTargetOffset && state.arrivedTargetKey !== state.targetKey) state.arrivedTargetKey = state.targetKey;
  }
  state.liftOffset = clamp(state.liftOffset, spec.liftLimits.min, spec.liftLimits.max);
  ctx.publishMotion(actor, { lift: V.scale(spec.upAxis, state.liftOffset) });
  state.outgoingHandoffCooldown = Math.max(0, state.outgoingHandoffCooldown - ctx.dt);
  const arrived = !frozen && state.arrivedTargetKey !== null && state.arrivedTargetKey === state.targetKey && state.targetDeviceId !== null;
  const work = state.workState, pickupAllowed = arrived && state.targetSide === 0 && (work === null || work === 1 || work === 2);
  const hasCargo = state.stations.some(station => station.cargoId !== null);
  if (state.targetSide !== 1 || !hasCargo) state.outgoingHandoffActive = false;
  else if (arrived && (work === null || work === 3 || work === 5)) state.outgoingHandoffActive = true;
  const deliveryAllowed = arrived && state.targetSide === 1 && (work === null || work === 3 || work === 5 || state.outgoingHandoffActive);
  if (arrived && state.targetSide === 1) for (const station of state.stations) if (station.cargoId !== null) {
    station.reachedOutgoing = true; station.outgoingDeviceId = state.targetDeviceId;
  }
  const reconcilable = (index: 0 | 1, field: string): boolean => {
    const station = state.stations[index]; return station.cargoId !== null && station.taskAnnotationSeen && station.reachedOutgoing && readIntegerField(frame.fields, field) === 0;
  };
  const forceBack = arrived && state.targetSide === 1 && reconcilable(1, 'task_num_fin_second_up');
  const forceFront = arrived && state.targetSide === 1 && reconcilable(0, 'task_num_fin_first_up');
  if (pickupAllowed) {
    const index = state.stations[1].cargoId === null ? 1 : state.stations[0].cargoId === null ? 0 : null;
    if (index !== null) adoptIncoming(ctx, actor, state.targetDeviceId!, index);
  }
  if (work === 2) for (const station of state.stations) if (station.cargoId !== null && station.transferActive && station.transferDirection === 1) finishPickup(station);
  if (!frozen) for (const station of state.stations) if (station.cargoId !== null && station.transferActive) {
    station.transferProgress = clamp(station.transferProgress + station.transferDirection * ctx.dt / 1.5, 0, 1);
    if (station.transferDirection === 1 && station.transferProgress >= 1) finishPickup(station);
  }
  if (deliveryAllowed) processOutgoing(ctx, actor, state.targetDeviceId!);
  else if (forceBack || forceFront) {
    const target = (forceBack ? state.stations[1].outgoingDeviceId : null) ?? (forceFront ? state.stations[0].outgoingDeviceId : null);
    if (target !== null) { ctx.issue(actor, 'lift-task-zero-reconcile:' + (state.stations[1].cargoId ?? state.stations[0].cargoId)); processOutgoing(ctx, actor, target); }
  }
  updateCargoPoses(ctx, actor);
}
