import { readBooleanField, readIntegerField, readStringField } from '../../mqtt/deviceTelemetry';
import { readConveyorMotionSignal } from '../../babylon/telemetry/conveyorMotionSignal';
import type { ActorOf, DriverFrame, LogisticsContext } from './context';
import type { ConveyorTaskRoute, DownstreamLink, ExternalPull } from './runtimeState';
import type { FrozenLocator } from './manifest';
import { clamp, conveyorHalfRange, perpendicularOffset, V } from './math';

type Conveyor = ActorOf<'conveyor'>;
type LinkMessage = { kind: 'available' | 'taken' | 'subscribe' | 'unsubscribe'; task: string; originId: string;
  recipientId: string | null; hops: number; direction: number; visited: string[] };
const taskOf = (value: number | null): string => value !== null && value !== 0 ? String(value) : '';
export const conveyorFlow = (actor: Conveyor, fallback = 1): number => actor.state.lastMovementDirection !== 0 ? actor.state.lastMovementDirection : fallback;
function neighbor(ctx: LogisticsContext, actor: Conveyor, direction: number): string | null {
  const id = direction < 0 ? actor.spec.probeNeighbors.reverse : actor.spec.probeNeighbors.forward;
  return id && ctx.tx.get('devices', id) && !ctx.removed.has(id) ? id : null;
}
function resolveTaskRoute(ctx: LogisticsContext, actor: Conveyor, cargoTask: string): ConveyorTaskRoute | null {
  if (actor.spec.directionSource !== 'task' || !cargoTask) return null;
  const neighbors = actor.spec.probeNeighbors;
  const resolveLink = (link: DownstreamLink): ConveyorTaskRoute | null => {
    if (link.task !== cargoTask) return null;
    const target = ctx.conveyor(link.subscriberId);
    if (!target || (target.state.pendingTask !== link.task && target.state.waitingTask !== link.task)) return null;
    const nextHopDeviceId = link.nextHopDeviceId ?? link.subscriberId;
    const direction = neighbors.reverse === nextHopDeviceId ? 1 : neighbors.forward === nextHopDeviceId ? -1 : null;
    return direction === null ? null : { task: cargoTask, nextHopDeviceId, direction };
  };
  const locked = actor.state.taskRoute;
  if (locked?.task === cargoTask) {
    for (const link of actor.state.downstreamLinks) {
      if (resolveLink(link)?.nextHopDeviceId === locked.nextHopDeviceId) return locked;
    }
  }
  for (const link of actor.state.downstreamLinks) {
    const route = resolveLink(link);
    if (route) {
      actor.state.taskRoute = route;
      return route;
    }
  }
  actor.state.taskRoute = null;
  return null;
}
function platformOffset(actor: Conveyor, locator: FrozenLocator): number | null {
  const first = locator.cells[0]; return first ? V.dot(V.sub(first.pose.position, actor.spec.center), actor.spec.travelAxis) : null;
}
function upsert<T>(values: T[], value: T, key: (item: T) => string): void {
  const index = values.findIndex(item => key(item) === key(value)); if (index < 0) values.push(value); else values[index] = value;
}
function heldByTask(ctx: LogisticsContext, holderId: string, task: string): string | null {
  if (!task) return null;
  for (const cargo of ctx.tx.values('cargo')) if (cargo.destroyedAt === null && cargo.taskId === task && ctx.cargo.has(cargo.id)) {
    const meta = ctx.cargo.meta(cargo.id); if (!meta.retained && meta.ownerDeviceId === holderId) return cargo.id;
  }
  return null;
}
function externalHoldsTask(ctx: LogisticsContext, task: string): boolean {
  if (!task) return false;
  for (const cargo of ctx.tx.values('cargo')) if (cargo.destroyedAt === null && cargo.taskId === task && ctx.cargo.has(cargo.id)) {
    const meta = ctx.cargo.meta(cargo.id), device = meta.ownerDeviceId && ctx.tx.get('devices', meta.ownerDeviceId);
    if (!meta.retained && device && device.driverState.value.kind !== 'conveyor' && device.driverState.value.kind !== 'hclift' && device.driverState.value.kind !== 'passive') return true;
  }
  return false;
}
function dispatch(ctx: LogisticsContext, targetId: string, message: LinkMessage): void {
  ctx.chargeMessage();
  if (message.visited.includes(targetId)) return;
  const actor = ctx.conveyor(targetId); if (!actor) return;
  const state = actor.state;
  if (message.kind === 'available') {
    const previousId = message.visited[message.visited.length - 1], previous = state.upstreamLinks.find(link => link.deviceId === previousId);
    const newPath = !previous || previous.task !== message.task || previous.holderDeviceId !== message.originId;
    upsert(state.upstreamLinks, { deviceId: previousId, task: message.task, holderDeviceId: message.originId, hops: message.hops + 1, direction: message.direction }, link => link.deviceId);
    if (state.pendingTask === message.task && state.cargoId === null && (state.waitingTask !== message.task || newPath)) {
      state.waitingTask = message.task; subscribe(ctx, actor, message.task, message.direction);
    }
    flood(ctx, actor, { ...message, hops: message.hops + 1, visited: [...message.visited, targetId] });
  } else if (message.kind === 'taken') {
    state.upstreamLinks = state.upstreamLinks.filter(link => link.task !== message.task || link.holderDeviceId !== message.originId);
    if (state.pendingTask === message.task && message.recipientId !== targetId) {
      if (!state.transitedTasks.includes(message.task)) state.transitedTasks.push(message.task);
      state.pendingTask = null;
      if (state.waitingTask !== null) { unsubscribe(ctx, actor, state.waitingTask, message.direction); state.waitingTask = null; }
    }
    flood(ctx, actor, { ...message, hops: message.hops + 1, visited: [...message.visited, targetId] });
  } else if (message.kind === 'subscribe') {
    const hops = message.hops + 1;
    upsert(state.downstreamLinks, { subscriberId: message.originId, task: message.task, hops, direction: message.direction,
      nextHopDeviceId: message.visited[message.visited.length - 1] }, link => link.subscriberId);
    if (state.cargoId !== null && ctx.cargo.task(state.cargoId) === message.task) { tryDeliverHeldCargo(ctx, actor); return; }
    propagate(ctx, actor, { ...message, hops, visited: [...message.visited, targetId] }, hops);
  } else {
    state.downstreamLinks = state.downstreamLinks.filter(link => link.subscriberId !== message.originId);
    state.externalPulls = state.externalPulls.filter(link => link.subscriberId !== message.originId);
    propagate(ctx, actor, { ...message, hops: message.hops + 1, visited: [...message.visited, targetId] }, message.hops + 1);
  }
}
function flood(ctx: LogisticsContext, actor: Conveyor, message: LinkMessage): void {
  const target = neighbor(ctx, actor, -message.direction); if (target && target !== actor.device.id) dispatch(ctx, target, message);
}
function propagate(ctx: LogisticsContext, actor: Conveyor, message: LinkMessage, registrarHops: number): void {
  const targets: string[] = [], entryId = neighbor(ctx, actor, message.direction);
  if (entryId && entryId !== actor.device.id) {
    if (ctx.tx.get('devices', entryId)?.driverState.value.kind === 'conveyor') targets.push(entryId);
    else if (message.kind === 'subscribe') {
      const pull: ExternalPull = { subscriberId: message.originId, holderDeviceId: entryId, task: message.task, hops: registrarHops + 1, direction: message.direction };
      upsert(actor.state.externalPulls, pull, item => item.subscriberId);
    }
  }
  for (const link of actor.state.upstreamLinks) if (!targets.includes(link.deviceId) && ctx.tx.get('devices', link.deviceId)) targets.push(link.deviceId);
  for (const target of targets) dispatch(ctx, target, message);
}
export function notifyAvailable(ctx: LogisticsContext, actor: Conveyor, task: string, direction: number): void {
  if (task) flood(ctx, actor, { kind: 'available', task, originId: actor.device.id, recipientId: null, hops: 0, direction, visited: [actor.device.id] });
}
function takenWave(ctx: LogisticsContext, actor: Conveyor, holderId: string, task: string, recipientId: string | null, direction: number): void {
  if (task) flood(ctx, actor, { kind: 'taken', task, originId: holderId, recipientId, hops: 0, direction, visited: [actor.device.id] });
}
export function notifyTaken(ctx: LogisticsContext, actor: Conveyor, task: string, recipientId: string | null, direction: number): void {
  takenWave(ctx, actor, actor.device.id, task, recipientId, direction);
}
function subscribe(ctx: LogisticsContext, actor: Conveyor, task: string, direction: number): void {
  const directions = actor.spec.directionSource === 'task' ? [1, -1] : [direction];
  if (task) for (const routeDirection of directions) {
    propagate(ctx, actor, { kind: 'subscribe', task, originId: actor.device.id, recipientId: null, hops: 0,
      direction: routeDirection, visited: [actor.device.id] }, 0);
  }
}
function unsubscribe(ctx: LogisticsContext, actor: Conveyor, task: string, direction: number): void {
  const directions = actor.spec.directionSource === 'task' ? [1, -1] : [direction];
  if (task) for (const routeDirection of directions) {
    propagate(ctx, actor, { kind: 'unsubscribe', task, originId: actor.device.id, recipientId: null, hops: 0,
      direction: routeDirection, visited: [actor.device.id] }, 0);
  }
}
function registerTask(ctx: LogisticsContext, actor: Conveyor, task: string): void {
  const state = actor.state; if (!task || task === state.lastTask) return;
  const waiting = state.waitingTask, previous = state.lastTask; state.lastTask = task;
  if (state.transitedTasks.includes(task)) return;
  if (waiting !== null) unsubscribe(ctx, actor, waiting, conveyorFlow(actor));
  state.currentTask = task; state.pendingTask = task; state.pendingTaskAgeSeconds = 0; state.pendingPreviousTask = previous; state.waitingTask = null;
}
function deliveryTarget(ctx: LogisticsContext, actor: Conveyor, cargoId: string): { actor: Conveyor; link: DownstreamLink } | null {
  const task = ctx.cargo.task(cargoId);
  for (const link of [...actor.state.downstreamLinks]) {
    if (link.task !== task) continue;
    const target = ctx.conveyor(link.subscriberId);
    if (!target || (target.state.pendingTask !== link.task && target.state.waitingTask !== link.task)) {
      actor.state.downstreamLinks = actor.state.downstreamLinks.filter(item => item.subscriberId !== link.subscriberId); continue;
    }
    // 原 Map 采用最早登记者优先；首个仍占用时必须等待，不能跳过它把货交给后登记者。
    if (target.state.cargoId !== null) return null;
    return { actor: target, link };
  }
  return null;
}
function settle(ctx: LogisticsContext, cargoId: string, actor: Conveyor, task: string, hops: number, direction: number, preserve = false, upstream: Conveyor | null = null): void {
  const state = actor.state, spec = actor.spec, pose = ctx.cargo.world(cargoId);
  const length = ctx.cargo.axialLength(cargoId, spec.travelAxis, ctx.cargo.templateFor(actor)), half = conveyorHalfRange(spec.span, length);
  let corner: number | null = null;
  if (!preserve && upstream && upstream.device.id !== actor.device.id) {
    const upstreamSpec = upstream.spec;
    corner = perpendicularOffset(
      { center: upstreamSpec.center, axis: upstreamSpec.travelAxis, span: upstreamSpec.span },
      { center: spec.center, axis: spec.travelAxis }, half, Math.max(0, spec.span / 2 - half) + length,
    );
  }
  ctx.cargo.detach(cargoId); ctx.cargo.own(cargoId, actor, 'single'); ctx.cargo.annotate(cargoId, task); ctx.cargo.startHandoff(cargoId, 1 / Math.max(hops, 1));
  state.cargoId = cargoId; state.handoffEntryOffset = corner; state.entryHandoffPending = corner !== null;
  state.taskRoute = null;
  state.cargoTravelOffset = preserve ? clamp(V.dot(V.sub(pose.position, spec.center), spec.travelAxis), -half, half) : corner ?? -direction * spec.forwardSign * half;
  state.pendingTask = null; state.waitingTask = null; state.selfDriveDirection = direction; state.cargoDriveEngaged = false;
  state.platformInboundCargo = 'platformLocatorId' in spec && spec.platformLocatorId !== null;
  state.platformInboundDirection = direction; state.platformPlacedCargo = false;
  unsubscribe(ctx, actor, task, direction);
}
function relay(ctx: LogisticsContext, waveOrigin: Conveyor, originId: string, cargoId: string, holder: Conveyor | null, first: { actor: Conveyor; link: DownstreamLink }): void {
  let target = first, previous = holder;
  while (true) {
    ctx.chargeMessage();
    if (previous) previous.state.downstreamLinks = previous.state.downstreamLinks.filter(link => link.subscriberId !== target.actor.device.id);
    const { task, direction, hops } = target.link;
    settle(ctx, cargoId, target.actor, task, hops, direction, false, previous);
    const next = cargoReadyForDelivery(ctx, target.actor, cargoId) ? deliveryTarget(ctx, target.actor, cargoId) : null;
    if (!next) { takenWave(ctx, waveOrigin, originId, task, target.actor.device.id, direction); notifyAvailable(ctx, target.actor, task, direction); return; }
    previous = target.actor; target = next;
  }
}
function cargoReadyForDelivery(ctx: LogisticsContext, actor: Conveyor, cargoId: string): boolean {
  if (actor.spec.directionSource !== 'task') return true;
  const task = ctx.cargo.task(cargoId), route = resolveTaskRoute(ctx, actor, task);
  if (!route || actor.spec.lift && actor.state.liftPhase === 'home') return false;
  const spec = actor.spec;
  const half = conveyorHalfRange(spec.span, ctx.cargo.axialLength(cargoId, spec.travelAxis, ctx.cargo.templateFor(actor)));
  const exitOffset = route.direction * spec.forwardSign * half;
  return Math.abs(actor.state.cargoTravelOffset - exitOffset) <= 1e-3;
}
export function tryDeliverHeldCargo(ctx: LogisticsContext, actor: Conveyor): void {
  const state = actor.state, id = state.cargoId;
  if (!id || !ctx.cargo.task(id) || state.platformPlacedCargo || !cargoReadyForDelivery(ctx, actor, id)) return;
  const target = deliveryTarget(ctx, actor, id); if (target) relay(ctx, actor, actor.device.id, id, actor, target);
}
export function takePlatformCargo(ctx: LogisticsContext, actor: Conveyor, recipientId: string): string | null {
  const id = actor.state.cargoId; if (!id) return null;
  ctx.cargo.detach(id); notifyTaken(ctx, actor, ctx.cargo.task(id), recipientId, conveyorFlow(actor)); return id;
}
export function acceptPlatformCargo(ctx: LogisticsContext, actor: Conveyor, locator: FrozenLocator, cargoId: string): boolean {
  const state = actor.state, offset = platformOffset(actor, locator); if (state.cargoId !== null || offset === null) return false;
  ctx.cargo.detach(cargoId); ctx.cargo.own(cargoId, actor, 'single'); ctx.cargo.startHandoff(cargoId);
  state.cargoId = cargoId; state.cargoTravelOffset = offset; state.handoffEntryOffset = null; state.entryHandoffPending = false;
  state.platformInboundCargo = false; state.platformPlacedCargo = neighbor(ctx, actor, conveyorFlow(actor)) === null && state.upstreamLinks.length === 0;
  state.cargoDriveEngaged = false;
  let task = ctx.cargo.task(cargoId);
  if (state.waitingTask !== null) {
    const matches = !task || task === state.waitingTask;
    if (matches) { task = state.waitingTask; ctx.cargo.annotate(cargoId, task); }
    unsubscribe(ctx, actor, state.waitingTask, conveyorFlow(actor)); state.waitingTask = null;
    if (!matches) { state.pendingTask = null; notifyAvailable(ctx, actor, task, conveyorFlow(actor)); return true; }
  }
  state.pendingTask = null; if (task) { state.currentTask = task; state.lastTask = task; }
  notifyAvailable(ctx, actor, task, conveyorFlow(actor)); return true;
}
export function acceptColumnCargo(ctx: LogisticsContext, actor: Conveyor, cargoId: string, task: string, preserve = false, requireTaskMatch = true): boolean {
  const state = actor.state;
  if (state.cargoId !== null || requireTaskMatch && (!task || state.pendingTask !== task && state.waitingTask !== task)) return false;
  const holderId = ctx.cargo.meta(cargoId).ownerDeviceId ?? actor.device.id, direction = conveyorFlow(actor);
  const waited = state.pendingTask ?? state.waitingTask, cargoTask = ctx.cargo.task(cargoId);
  const adopts = requireTaskMatch || waited !== null && (cargoTask ? cargoTask === waited : state.snapshotTask === waited);
  if (!requireTaskMatch && !adopts && waited !== null) { unsubscribe(ctx, actor, waited, direction); state.pendingTask = null; state.waitingTask = null; }
  const effectiveTask = requireTaskMatch ? task : adopts ? waited ?? cargoTask : cargoTask;
  settle(ctx, cargoId, actor, effectiveTask, 1, direction, preserve);
  takenWave(ctx, actor, holderId, effectiveTask, actor.device.id, direction); notifyAvailable(ctx, actor, effectiveTask, direction); tryDeliverHeldCargo(ctx, actor); return true;
}

/** 原 applyConveyorCargoMotion：任务边沿、在机货复用/订阅、自驱、站台出口门控均保留。 */
export function stepConveyor(ctx: LogisticsContext, actor: Conveyor, frame: DriverFrame): void {
  const state = actor.state, fields = frame.fields, mode = readIntegerField(fields, 'mode');
  const spec = actor.spec;
  state.liftPhase ??= 'home';
  if (spec.lift) {
    const lift = readIntegerField(fields, spec.lift.field);
    if (lift === spec.lift.raisedValue) state.liftPhase = 'raised';
    else if (lift === spec.lift.loweringValue) state.liftPhase = 'lowering';
    else state.liftPhase = 'home';
  }
  const reportedMovement = readConveyorMotionSignal(fields, { fields: spec.movementFields, actionMap: spec.actionMap }).direction;
  const taskDrivenTravel = spec.directionSource === 'task';
  const route = taskDrivenTravel ? resolveTaskRoute(ctx, actor, state.cargoId ? ctx.cargo.task(state.cargoId) : state.currentTask ?? '') : null;
  const movement = taskDrivenTravel ? route?.direction ?? 0 : reportedMovement;
  if (frame.receivedAt !== state.lastSnapshotReceivedAt) { state.lastSnapshotReceivedAt = frame.receivedAt; if (movement !== 0) state.selfDriveDirection = 0; }
  const taskValue = readIntegerField(fields, 'task'), task = taskOf(taskValue); state.snapshotTask = taskValue !== null ? task : null;
  const pulses = state.taskPulseQueue; state.taskPulseQueue = []; for (const pulse of pulses) registerTask(ctx, actor, pulse);
  if (taskValue !== null) registerTask(ctx, actor, task);
  const priorDirection = state.lastMovementDirection; if (movement !== 0) state.lastMovementDirection = movement;
  if (!taskDrivenTravel && movement !== 0 && priorDirection !== 0 && movement !== priorDirection) {
    if (state.waitingTask !== null) unsubscribe(ctx, actor, state.waitingTask, priorDirection);
    state.upstreamLinks = []; state.downstreamLinks = []; state.externalPulls = [];
    if (state.waitingTask !== null) subscribe(ctx, actor, state.waitingTask, movement);
  }
  if (mode === 0) {
    if (state.waitingTask !== null) { unsubscribe(ctx, actor, state.waitingTask, movement !== 0 ? movement : conveyorFlow(actor)); state.pendingTask = null; }
    state.waitingTask = null;
  }
  if (mode === 2 && !(readBooleanField(fields, actor.spec.frontHasGoodsField) ?? false)
    && !(readBooleanField(fields, actor.spec.backHasGoodsField) ?? false) && actor.spec.cargoAutoDispose) {
    const id = state.cargoId, heldTask = ctx.cargo.task(id); if (id) ctx.cargo.dispose(id, 'conveyor-auto-dispose');
    state.cargoId = null; state.handoffEntryOffset = null; state.entryHandoffPending = false; state.platformPlacedCargo = false;
    notifyTaken(ctx, actor, heldTask, null, movement !== 0 ? movement : conveyorFlow(actor)); return;
  }
  if (state.pendingTask !== null) state.pendingTaskAgeSeconds += ctx.dt;
  if (taskValue !== null && state.pendingTask) {
    const probeDirection = movement !== 0 ? movement : 1;
    let heldId = state.cargoId;
    if (heldId && state.downstreamLinks.some(link => link.task === ctx.cargo.task(heldId))) { tryDeliverHeldCargo(ctx, actor); heldId = state.cargoId; }
    if (heldId) {
      const flow = movement !== 0 ? movement : conveyorFlow(actor), upstreamId = neighbor(ctx, actor, probeDirection);
      const upstreamHolds = state.upstreamLinks.some(link => link.task === state.pendingTask)
        || Boolean(upstreamId && ctx.tx.get('devices', upstreamId)?.driverState.value.kind !== 'lift' && heldByTask(ctx, upstreamId, state.pendingTask));
      const exitId = neighbor(ctx, actor, -flow), exitType = exitId ? ctx.tx.get('devices', exitId)?.driverState.value.kind : null;
      const queued = exitType === 'conveyor' && ctx.conveyor(exitId)!.state.cargoId !== null;
      const grace = exitType === 'lift' ? 10 : queued ? 30 : 3, oldTask = ctx.cargo.task(heldId);
      const defer = state.platformPlacedCargo && state.downstreamLinks.some(link => link.task === oldTask)
        || !upstreamHolds && (exitType === 'conveyor' || exitType === 'lift') && oldTask === state.pendingPreviousTask && oldTask !== state.pendingTask && state.pendingTaskAgeSeconds < grace;
      if (!defer && upstreamHolds) {
        ctx.cargo.dispose(heldId, 'conveyor-upstream-new-task'); state.cargoId = null; state.handoffEntryOffset = null; state.entryHandoffPending = false; state.platformPlacedCargo = false;
        notifyTaken(ctx, actor, oldTask, null, flow); state.waitingTask = state.pendingTask; subscribe(ctx, actor, state.pendingTask, probeDirection);
      } else if (!defer) {
        const nextTask = state.pendingTask; ctx.cargo.annotate(heldId, nextTask, readStringField(fields, 'containerCode')?.trim() ?? '');
        state.platformInboundCargo = false; state.pendingTask = null; state.waitingTask = null;
        if (oldTask && oldTask !== nextTask) notifyTaken(ctx, actor, oldTask, null, flow);
        notifyAvailable(ctx, actor, nextTask, flow); tryDeliverHeldCargo(ctx, actor); if (state.cargoId !== null && movement === 0) state.selfDriveDirection = 1;
      }
    } else if (state.waitingTask === null) {
      const hasUpstream = neighbor(ctx, actor, probeDirection) !== null || state.upstreamLinks.length > 0;
      if (!hasUpstream && actor.spec.platformLocatorId !== null) state.waitingTask = state.pendingTask;
      else if (!hasUpstream && actor.spec.cargoOriginDevice && !externalHoldsTask(ctx, state.pendingTask)) {
        const newTask = state.currentTask ?? '', templateId = ctx.cargo.templateFor(actor);
        state.pendingTask = null; state.waitingTask = null;
        state.cargoTravelOffset = -probeDirection * spec.forwardSign * conveyorHalfRange(spec.span, ctx.cargo.axialLength(null, spec.travelAxis, templateId));
        state.cargoId = ctx.cargo.create(actor, 'single', newTask, readStringField(fields, 'containerCode')?.trim() ?? '');
        state.handoffEntryOffset = null; state.entryHandoffPending = false; state.platformInboundCargo = false; state.platformPlacedCargo = false; state.cargoDriveEngaged = false;
        if (movement === 0) state.selfDriveDirection = 1;
        notifyAvailable(ctx, actor, newTask, probeDirection); tryDeliverHeldCargo(ctx, actor);
      } else { state.waitingTask = state.pendingTask; subscribe(ctx, actor, state.pendingTask, probeDirection); }
    }
  }
  if (state.waitingTask || !state.cargoId) return;
  tryDeliverHeldCargo(ctx, actor); if (!state.cargoId) return;
  const cargoId = state.cargoId, meta = ctx.cargo.meta(cargoId), half = conveyorHalfRange(spec.span, ctx.cargo.axialLength(cargoId, spec.travelAxis, ctx.cargo.templateFor(actor)));
  let min = -half, max = half;
  if (state.handoffEntryOffset !== null) { min = Math.min(min, state.handoffEntryOffset); max = Math.max(max, state.handoffEntryOffset); }
  if (state.platformInboundCargo && actor.spec.platformLocatorId !== null) {
    const platform = ctx.locator(actor.spec.platformLocatorId), offset = platform ? platformOffset(actor, platform) : null;
    if (offset !== null) { if (state.platformInboundDirection * spec.forwardSign >= 0) max = Math.min(offset, half); else min = Math.max(offset, -half); }
  }
  const exitFlow = movement !== 0 ? movement : state.selfDriveDirection !== 0 ? state.selfDriveDirection : conveyorFlow(actor);
  if (exitFlow * spec.forwardSign > 0 && spec.perpendicularEnds.positive !== null) max = Math.min(max, spec.perpendicularEnds.positive);
  else if (exitFlow * spec.forwardSign < 0 && spec.perpendicularEnds.negative !== null) min = Math.max(min, spec.perpendicularEnds.negative);
  const flow = state.platformInboundCargo && state.platformInboundDirection !== 0 ? state.platformInboundDirection : conveyorFlow(actor);
  const atEnd = (): boolean => flow * spec.forwardSign >= 0 ? state.cargoTravelOffset >= max - 1e-3 : state.cargoTravelOffset <= min + 1e-3;
  if (movement === 0 && state.selfDriveDirection === 0 && state.cargoDriveEngaged && !atEnd()) state.selfDriveDirection = flow;
  const direction = spec.lift && state.liftPhase === 'home' || state.entryHandoffPending && meta.handoff !== null
    ? 0
    : movement !== 0 ? movement : state.selfDriveDirection;
  if (!frame.faulted && direction !== 0) { state.cargoTravelOffset += direction * spec.forwardSign * spec.cargoSpeed * ctx.dt; state.cargoDriveEngaged = true; }
  state.cargoTravelOffset = clamp(state.cargoTravelOffset, min, max);
  if (state.platformPlacedCargo && atEnd()) state.platformPlacedCargo = false;
  if (state.handoffEntryOffset !== null && Math.abs(state.cargoTravelOffset) <= half + 1e-3) state.handoffEntryOffset = null;
  ctx.cargo.syncTemplate(actor, cargoId);
  ctx.cargo.setWorld(cargoId, V.add(ctx.conveyorSurface(spec), V.scale(spec.travelAxis, state.cargoTravelOffset)), ctx.cargo.lockedRotation(cargoId), null, ctx.dt);
  if (state.entryHandoffPending && ctx.cargo.meta(cargoId).handoff === null) state.entryHandoffPending = false;
}
/** 帧尾拉货无论快照是否新鲜都执行；逐个应用真实 holder 就绪门控。 */
export function pullExternalCargo(ctx: LogisticsContext): void {
  for (const id of ctx.ids('conveyor')) {
    const registrar = ctx.of(id, 'conveyor');
    for (const pull of [...registrar.state.externalPulls]) {
      const subscriber = ctx.conveyor(pull.subscriberId);
      if (!subscriber || subscriber.state.pendingTask !== pull.task && subscriber.state.waitingTask !== pull.task) {
        registrar.state.externalPulls = registrar.state.externalPulls.filter(item => item.subscriberId !== pull.subscriberId); continue;
      }
      if (subscriber.state.cargoId !== null) continue;
      const cargoId = heldByTask(ctx, pull.holderDeviceId, pull.task); if (!cargoId || !ctx.cargo.readyForPull(cargoId)) continue;
      registrar.state.externalPulls = registrar.state.externalPulls.filter(item => item.subscriberId !== pull.subscriberId);
      relay(ctx, registrar, pull.holderDeviceId, cargoId, null, { actor: subscriber, link: pull });
    }
  }
}
/** 逻辑拓扑已经由发布器冻结；动态实例出生/离开时补通现有 available 和等待订阅，不等待 Mesh 就绪。 */
export function reconnectConveyorTopology(ctx: LogisticsContext): void {
  for (const id of ctx.ids('conveyor')) { const actor = ctx.of(id, 'conveyor'); if (actor.state.cargoId) notifyAvailable(ctx, actor, ctx.cargo.task(actor.state.cargoId), conveyorFlow(actor)); }
  for (const id of ctx.ids('conveyor')) { const actor = ctx.of(id, 'conveyor'); if (actor.state.cargoId === null && actor.state.waitingTask) subscribe(ctx, actor, actor.state.waitingTask, conveyorFlow(actor)); }
}
