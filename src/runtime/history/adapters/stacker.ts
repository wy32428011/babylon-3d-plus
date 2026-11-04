import { readIntegerField, readNumberField, readStringField } from '../../mqtt/deviceTelemetry';
import type { ActorOf, DriverFrame, LogisticsContext, TargetCell } from './context';
import type { ForkSide } from './manifest';
import type { StackerForkState } from './runtimeState';
import { catchUpSpeed, clamp, moveNumber, moveVector, projectTravel, V } from './math';

type Stacker = ActorOf<'stacker'>;
const task = (value: number | null): string => value !== null && value !== 0 ? String(value) : '';
function targetCell(ctx: LogisticsContext, actor: Stacker, frame: DriverFrame, prefix: 'front' | 'to'): { cell: TargetCell | null; key: string | null; mismatch: boolean } {
  const x = readIntegerField(frame.fields, prefix + '_x'), y = readIntegerField(frame.fields, prefix + '_y'), z = readIntegerField(frame.fields, prefix + '_z');
  if (x === null || y === null || z === null || x === 0 && y === 0 && z === 0) return { cell: null, key: null, mismatch: false };
  const cell = ctx.findCell(frame.assetCode, null, x, y, z);
  if (!cell) ctx.issue(actor, prefix + '-cell-missing:' + JSON.stringify([x, y, z]));
  return { cell, key: JSON.stringify([x, y, z]), mismatch: cell === null };
}
function forkPosition(actor: Stacker, side: ForkSide): [number, number, number] {
  return V.add(V.add(V.add(actor.spec.forks[side].anchor, V.sub(actor.state.rootPosition ?? actor.spec.basePosition, actor.spec.basePosition)),
    V.scale(actor.spec.upAxis, actor.state.liftOffset)), V.scale(actor.spec.forkAxis, actor.state[side].offset));
}
function forkSpeed(actor: Stacker, frame: DriverFrame, side: ForkSide): number {
  const rpm = readNumberField(frame.fields, side + '_rpm_z');
  return rpm === null || rpm <= 0 ? actor.spec.forkSpeed : Math.max(actor.spec.forkSpeed * 0.25, rpm * actor.spec.rpmToMetersPerSecond);
}
function sideCommand(actor: Stacker, frame: DriverFrame, side: ForkSide): number | null {
  const raw = readIntegerField(frame.fields, side + '_command'), bits = readNumberField(frame.fields, side + '_signalBits');
  if (bits === null || !Number.isFinite(bits)) return raw;
  const fork = actor.state[side], present = Math.floor(bits / 131072) % 2 === 1, previous = fork.signalCargoPresent ?? present;
  fork.signalCargoPresent = present;
  if (readIntegerField(frame.fields, 'mode') !== 4) return raw;
  const movement = readIntegerField(frame.fields, side + '_movement_z'), extending = movement === 1 || movement === 3, absolute = Math.abs(fork.offset);
  if (extending && absolute < 1e-3) { fork.signalAction = previous ? 'place' : 'fetch'; fork.signalExtended = false; }
  else if (fork.signalAction !== null) {
    if (absolute > 0.05) fork.signalExtended = true;
    else if (fork.signalExtended && absolute < 1e-3 && !extending) { fork.signalAction = null; fork.signalExtended = false; }
  }
  return fork.signalAction === 'fetch' ? 1 : fork.signalAction === 'place' ? 3 : 0;
}
function bindCargo(ctx: LogisticsContext, actor: Stacker, side: ForkSide): void {
  const fork = actor.state[side]; if (!fork.cargoId || fork.bound) return;
  fork.bindOffset = fork.holdPosition ? V.sub(fork.holdPosition, forkPosition(actor, side)) : null;
  fork.bound = true; fork.holdPosition = null; fork.holdRotation = ctx.cargo.world(fork.cargoId).rotation ?? fork.holdRotation; fork.holdScaling = null;
}
function unbindCargo(ctx: LogisticsContext, actor: Stacker, side: ForkSide, target: TargetCell | null, defer = false): void {
  const fork = actor.state[side]; if (!fork.cargoId || !target || !fork.bound) return;
  const id = fork.cargoId;
  fork.bound = false; fork.bindOffset = null; fork.holdPosition = V.copy(target.position);
  fork.holdRotation ??= ctx.cargo.world(id).rotation; fork.holdScaling = null;
  if (fork.placeTarget?.retainCargo) {
    ctx.cargo.clearHandoff(id); ctx.cargo.setWorld(id, target.position, fork.holdRotation);
  } else if (fork.fetchRowId === null) {
    ctx.cargo.setWorld(id, target.position, fork.holdRotation);
    if (defer) fork.pendingPlatformLocatorId = target.locator.id;
    else ctx.cargo.placePlatform(target.locator.id, id);
  }
}
function completePlace(ctx: LogisticsContext, actor: Stacker, side: ForkSide, current: TargetCell | null): void {
  const fork = actor.state[side], id = fork.cargoId; if (!id) return;
  const target = ctx.cargo.restoreTarget(fork.placeTarget) ?? current;
  unbindCargo(ctx, actor, side, target);
  // 立即平台交付可能已清空旧侧引用，不能继续处置已换宿主的货物。
  if (fork.cargoId !== id) return;
  const place = fork.placeTarget, rowId = fork.fetchRowId;
  if (place?.retainCargo) ctx.cargo.holdAtSlot(id, actor, place, rowId, true);
  else if (rowId !== null && place !== null) ctx.cargo.holdAtSlot(id, actor, place, rowId, false);
  else if (rowId === null) {
    if (fork.pendingPlatformLocatorId !== null && ctx.cargo.placePlatform(fork.pendingPlatformLocatorId, id)) { ctx.cargo.clearFork(fork); return; }
    ctx.cargo.dispose(id, 'stacker-place-complete');
  } else ctx.issue(actor, 'place-target-missing-for-fetch:' + rowId);
  ctx.cargo.clearFork(fork);
}
function phaseExit(ctx: LogisticsContext, actor: Stacker, side: ForkSide, command: number | null, target: TargetCell | null): void {
  const fork = actor.state[side];
  if (fork.lastCommand === 1 && command !== 1) { bindCargo(ctx, actor, side); fork.lastMovementZ = null; }
  else if ((fork.lastCommand === 3 || fork.lastCommand === 4) && command !== 3 && command !== 4) { completePlace(ctx, actor, side, target); fork.lastMovementZ = null; }
}
function forceFinish(ctx: LogisticsContext, actor: Stacker, side: ForkSide, command: number | null, target: TargetCell | null): void {
  const fork = actor.state[side]; fork.signalAction = null; fork.signalExtended = false;
  if (!fork.cargoId) return;
  if (command === 1 || command === 2) bindCargo(ctx, actor, side);
  else if (command === 3 || command === 4) { unbindCargo(ctx, actor, side, ctx.cargo.restoreTarget(fork.placeTarget) ?? target); completePlace(ctx, actor, side, target); }
}
function beginFetch(ctx: LogisticsContext, actor: Stacker, side: ForkSide, frame: DriverFrame, target: TargetCell): void {
  const fork = actor.state[side]; ctx.cargo.disposeLegacyRole(actor, side); ctx.cargo.clearFork(fork);
  const oldSlot = ctx.tx.get('slots', target.cell.slotId)?.cargoId, retained = Boolean(oldSlot && ctx.cargo.meta(oldSlot).retained);
  const id = ctx.cargo.acquire(actor, side, task(readIntegerField(frame.fields, side + '_task')), readStringField(frame.fields, side + '_containerCode')?.trim() ?? '', target);
  fork.cargoId = id; ctx.cargo.suppress(target, id); if (retained) ctx.cargo.releaseRetained(target);
  fork.holdPosition = V.copy(target.position); fork.holdRotation = ctx.cargo.lockedRotation(id); fork.holdScaling = V.copy(target.locator.rootPose.scale);
}
function beginPlace(ctx: LogisticsContext, actor: Stacker, side: ForkSide, frame: DriverFrame): void {
  const fork = actor.state[side]; ctx.cargo.disposeLegacyRole(actor, side); ctx.cargo.clearFork(fork);
  fork.cargoId = ctx.cargo.acquire(actor, side, task(readIntegerField(frame.fields, side + '_task')), readStringField(frame.fields, side + '_containerCode')?.trim() ?? '');
  fork.bound = true; fork.bindOffset = V.scale(actor.spec.upAxis, -actor.spec.cargoGapY);
}
function cargoPhase(ctx: LogisticsContext, actor: Stacker, side: ForkSide, frame: DriverFrame, target: TargetCell | null, command: number | null): void {
  const fork = actor.state[side], movement = readIntegerField(frame.fields, side + '_movement_z'), deferred = readIntegerField(frame.fields, 'mode') === 4;
  if (!frame.faulted) {
    if (command === 1 && (movement === 1 || movement === 3) && target && !fork.cargoId) beginFetch(ctx, actor, side, frame, target);
    if ((command === 3 || command === 4) && target) {
      if (!fork.cargoId && fork.lastMovementZ === null) beginPlace(ctx, actor, side, frame);
      fork.placeTarget = ctx.cargo.placeTarget(target);
      if (fork.fetchRowId === null) fork.fetchRowId = ctx.cargo.suppress(target, fork.cargoId);
    }
    const extended = Math.abs(fork.targetOffset) >= 0.001 && Math.abs(fork.offset) >= Math.abs(fork.targetOffset) - 0.02;
    const retryRetract = (fork.lastMovementZ === 1 || fork.lastMovementZ === 3) && (movement === 2 || movement === 4);
    if (!actor.state.forkCatchUp && (extended || retryRetract)) {
      if (command === 1 || command === 2) bindCargo(ctx, actor, side);
      else if (command === 3 || command === 4) unbindCargo(ctx, actor, side, target, deferred);
    }
    if (fork.pendingPlatformLocatorId !== null && (fork.prevRawMovementZ === 2 || fork.prevRawMovementZ === 4) && movement === 0 && fork.cargoId) {
      ctx.cargo.placePlatform(fork.pendingPlatformLocatorId, fork.cargoId);
    }
  }
  if (fork.cargoId) {
    const id = fork.cargoId; ctx.cargo.syncTemplate(actor, id);
    const position = fork.bound || !fork.holdPosition
      ? V.add(forkPosition(actor, side), fork.bound && fork.bindOffset ? fork.bindOffset : V.zero()) : fork.holdPosition;
    ctx.cargo.setWorld(id, position, fork.holdRotation ?? ctx.cargo.lockedRotation(id), fork.bound ? null : fork.holdScaling, ctx.dt);
  }
  fork.lastCommand = command; if (movement === 1 || movement === 3) fork.lastMovementZ = movement; fork.prevRawMovementZ = movement;
}
function updateFork(actor: Stacker, fork: StackerForkState, side: ForkSide, frame: DriverFrame, target: TargetCell | null, blocked: boolean, dt: number): void {
  let movement = readIntegerField(frame.fields, side + '_movement_z');
  if (blocked && (movement === 1 || movement === 3)) movement = null;
  if (frame.faulted) return;
  if (movement === 1 || movement === 3) {
    const home = V.add(V.add(actor.spec.forks[side].centerHome, V.sub(actor.state.rootPosition ?? actor.spec.basePosition, actor.spec.basePosition)), V.scale(actor.spec.upAxis, actor.state.liftOffset));
    const difference = target ? V.dot(V.sub(target.position, home), actor.spec.forkAxis) : 0;
    const direction = Math.abs(difference) >= 1e-6 ? Math.sign(difference) : movement === 1 ? 1 : -1;
    const needed = direction * difference;
    fork.targetOffset = direction * (target && needed > 0.001 ? needed : actor.spec.forks[side].stroke);
    fork.offset = moveNumber(fork.offset, fork.targetOffset, forkSpeed(actor, frame, side) * dt);
  } else if (movement === 2 || movement === 4) { fork.targetOffset = 0; fork.offset = moveNumber(fork.offset, 0, forkSpeed(actor, frame, side) * dt); }
}
/** 原双叉堆垛机状态机；mode=4 signalBits 锁存、缺失完成码与转场 catch-up 均非位置曲线替代。 */
export function stepStacker(ctx: LogisticsContext, actor: Stacker, frame: DriverFrame): void {
  const state = actor.state, spec = actor.spec, front = targetCell(ctx, actor, frame, 'front'), to = targetCell(ctx, actor, frame, 'to');
  const offsets = (cell: TargetCell | null) => cell ? { travel: V.dot(V.sub(cell.position, spec.targetReference), spec.travelAxis), lift: cell.position[1] + spec.cargoGapY - spec.targetReference[1] } : null;
  const currentOffsets = offsets(front.cell), target = offsets(to.cell) ?? currentOffsets;
  const frontCommand = sideCommand(actor, frame, 'front'), backCommand = sideCommand(actor, frame, 'back');
  phaseExit(ctx, actor, 'front', frontCommand, front.cell); phaseExit(ctx, actor, 'back', backCommand, front.cell);
  if (front.key !== null) {
    if (state.lastFrontCellKey === null) {
      state.lastFrontCellKey = front.key; state.lastFrontCellChangedAt = ctx.now;
      const snap = currentOffsets ?? target;
      if (snap) { state.rootPosition = projectTravel(spec.basePosition, spec.travelAxis, V.add(spec.basePosition, V.scale(spec.travelAxis, snap.travel)), spec.travelLimits); state.liftOffset = clamp(snap.lift, spec.liftLimits.min, spec.liftLimits.max); }
    } else if (front.key !== state.lastFrontCellKey) {
      if (state.lastFrontCellChangedAt !== null) state.frontCellChangeIntervalMs = ctx.now - state.lastFrontCellChangedAt;
      state.lastFrontCellChangedAt = ctx.now; state.lastFrontCellKey = front.key;
      if (!state.forkCatchUp && (Math.abs(state.front.offset) > 1e-3 || Math.abs(state.back.offset) > 1e-3
        || state.front.cargoId !== null && !state.front.bound || state.back.cargoId !== null && !state.back.bound)) {
        state.forkCatchUp = true; forceFinish(ctx, actor, 'front', frontCommand, front.cell); forceFinish(ctx, actor, 'back', backCommand, front.cell);
      }
    }
  }
  if (state.forkCatchUp) {
    for (const side of ['front', 'back'] as const) { const fork = state[side]; fork.targetOffset = 0; fork.offset = moveNumber(fork.offset, 0, forkSpeed(actor, frame, side) * 4 * ctx.dt); }
    if (Math.abs(state.front.offset) < 1e-4 && Math.abs(state.back.offset) < 1e-4) { state.front.offset = 0; state.back.offset = 0; state.forkCatchUp = false; }
  } else {
    state.rootPosition ??= V.copy(spec.basePosition);
    let bodyMoving = false;
    if (!frame.faulted && target) {
      const destination = projectTravel(spec.basePosition, spec.travelAxis, V.add(spec.basePosition, V.scale(spec.travelAxis, target.travel)), spec.travelLimits), before = state.rootPosition;
      state.rootPosition = moveVector(before, destination, catchUpSpeed(V.distance(before, destination), spec.travelSpeed, state.lastFrontCellChangedAt, state.frontCellChangeIntervalMs, ctx.now) * ctx.dt);
      bodyMoving = V.distance(before, state.rootPosition) > 1e-6;
      const liftBefore = state.liftOffset, speed = catchUpSpeed(Math.abs(target.lift - liftBefore), spec.liftSpeed, state.lastFrontCellChangedAt, state.frontCellChangeIntervalMs, ctx.now);
      state.liftOffset = clamp(moveNumber(liftBefore, target.lift, speed * ctx.dt), spec.liftLimits.min, spec.liftLimits.max);
      bodyMoving ||= Math.abs(state.liftOffset - liftBefore) > 1e-9;
    }
    state.rootPosition = projectTravel(spec.basePosition, spec.travelAxis, state.rootPosition, spec.travelLimits);
    for (const side of ['front', 'back'] as const) {
      if (bodyMoving) state[side].offset = moveNumber(state[side].offset, 0, forkSpeed(actor, frame, side) * ctx.dt);
      else updateFork(actor, state[side], side, frame, front.cell, front.mismatch, ctx.dt);
    }
  }
  ctx.publishMotion(actor, { travel: V.sub(state.rootPosition ?? spec.basePosition, spec.basePosition), lift: V.scale(spec.upAxis, state.liftOffset), frontFork: state.front.offset, backFork: state.back.offset });
  cargoPhase(ctx, actor, 'front', frame, front.cell, frontCommand); cargoPhase(ctx, actor, 'back', frame, front.cell, backCommand);
}
