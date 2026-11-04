import { readIntegerField, readStringField } from '../../mqtt/deviceTelemetry';
import type { ActorOf, DriverFrame, LogisticsContext, TargetCell } from './context';
import type { FrozenLocator } from './manifest';
import type { HcliftState } from './runtimeState';
import type { Vec3 } from '../state/types';
import { catchUpSpeed, moveNumber, moveVector, projectTravel, V } from './math';

type Shuttle = ActorOf<'shuttle'>;
type Cell = TargetCell & { platform: boolean; hcliftId: string | null; workState: number | null; hcliftCenter: Vec3 | null;
  deckCenter: Vec3 | null; exit: boolean; exitSupportY: number | null };
type Target = { cell: Cell | null; key: string | null; mismatch: boolean };
const taskOf = (value: number | null): string => value !== null && value !== 0 ? String(value) : '';
const decorate = (cell: TargetCell): Cell => ({ ...cell, platform: false, hcliftId: null, workState: null, hcliftCenter: null, deckCenter: null, exit: false, exitSupportY: null });
function hcliftSurface(ctx: LogisticsContext, locator: FrozenLocator): { id: string; state: HcliftState } | null {
  let byAsset: { id: string; state: HcliftState } | null = null;
  for (const id of ctx.ids('hclift')) {
    const lift = ctx.of(id, 'hclift'), surface = lift.state.surface; if (!surface || ctx.now - surface.updatedAt > 2000) continue;
    if (lift.spec.aisleCode && locator.aisleCode && lift.spec.aisleCode === locator.aisleCode) return { id, state: lift.state };
    if (!byAsset && locator.deviceAssetCode && lift.device.identity.assetCode === locator.deviceAssetCode) byAsset = { id, state: lift.state };
  }
  return byAsset;
}
function loaded(ctx: LogisticsContext, actor: Shuttle, hcliftId: string): boolean {
  const occupancy = ctx.of(hcliftId, 'hclift').state.occupancy;
  return occupancy !== null && occupancy.shuttleId === actor.device.id && ctx.now - occupancy.updatedAt <= 2000 && occupancy.phase === 'loaded';
}
function platformTarget(ctx: LogisticsContext, actor: Shuttle, frame: DriverFrame, x: number): Target {
  const state = actor.state, reportedY = readIntegerField(frame.fields, 'y'), fallbackY = readIntegerField(frame.fields, 'to_y');
  const y = reportedY !== null && reportedY >= 1 ? reportedY : state.lastHcliftLayer ?? fallbackY;
  if (reportedY !== null && reportedY >= 1) state.lastHcliftLayer = reportedY;
  if (y === null || y < 1) { ctx.issue(actor, 'shuttle-platform-layer-missing'); return { cell: null, key: null, mismatch: true }; }
  const locator = ctx.platform(frame.assetCode, actor.spec.aisleCode);
  if (!locator) { ctx.issue(actor, 'shuttle-platform-unbound'); return { cell: null, key: null, mismatch: true }; }
  const base = ctx.cell(locator, locator.startColumn, y); if (!base) return { cell: null, key: null, mismatch: true };
  const cell = decorate(base); cell.platform = true;
  const lift = hcliftSurface(ctx, locator); let exitLevel: number | null = null;
  if (lift) {
    const surface = lift.state.surface!; cell.hcliftId = lift.id; cell.workState = surface.workState; cell.hcliftCenter = V.copy(surface.deckCenter);
    if (x === -2) {
      exitLevel = surface.targetLevel !== null && surface.targetLevel >= 1 ? surface.targetLevel : null;
      const key = exitLevel !== null ? lift.id + ':' + exitLevel : null, deckLoaded = loaded(ctx, actor, lift.id);
      if (deckLoaded && !surface.arrived) state.hcliftLoadedSawMoving = true;
      if (key !== null && state.hcliftExitDoneKey !== key && surface.arrived && deckLoaded && state.hcliftLoadedSawMoving) {
        state.hcliftExitDoneKey = key; state.lastHcliftLayer = exitLevel;
      }
      if (key !== null && state.hcliftExitDoneKey === key && exitLevel !== null) {
        const exit = ctx.cell(locator, locator.startColumn, exitLevel);
        if (exit) {
          cell.position = [exit.position[0], surface.supportY, exit.position[2]]; cell.exitSupportY = exit.position[1]; cell.exit = true; cell.cell = exit.cell;
        }
      }
      if (!cell.exit) { cell.position = [surface.deckCenter[0], surface.supportY, surface.deckCenter[2]]; cell.deckCenter = V.copy(surface.deckCenter); }
    }
  }
  return { cell, key: JSON.stringify(['platform', cell.exit && exitLevel !== null ? exitLevel : y]), mismatch: false };
}
function resolveTarget(ctx: LogisticsContext, actor: Shuttle, frame: DriverFrame): Target {
  const x = readIntegerField(frame.fields, 'x'), y = readIntegerField(frame.fields, 'y');
  if (x === -1 || x === -2) return platformTarget(ctx, actor, frame, x);
  if (x === 255 && (y === null || y < 1) && ctx.platform(frame.assetCode, actor.spec.aisleCode)) return platformTarget(ctx, actor, frame, -2);
  actor.state.hcliftExitDoneKey = null;
  const tx = readIntegerField(frame.fields, 'to_x'), ty = readIntegerField(frame.fields, 'to_y'), tz = readIntegerField(frame.fields, 'to_z'), td = readIntegerField(frame.fields, 'to_Depth');
  if (tx === null && ty === null && tz === null && td === null || tx === 0 && ty === 0 && tz === 0) return { cell: null, key: null, mismatch: false };
  if (tx === null || ty === null || tz === null || td !== 0 && td !== 2 && td !== 8) {
    ctx.issue(actor, 'shuttle-target-fields-invalid:' + JSON.stringify([tx, ty, tz, td])); return { cell: null, key: null, mismatch: true };
  }
  if (y !== null && y >= 1 && ty >= 1 && y !== ty) return { cell: null, key: null, mismatch: false };
  const depth = td === 2 ? 'near' : td === 8 ? 'far' : undefined;
  const base = ctx.findCell(frame.assetCode, null, tx, ty, tz, depth)
    ?? (actor.spec.aisleCode ? ctx.findCell(frame.assetCode, actor.spec.aisleCode, tx, ty, tz, depth) : null);
  if (!base) { ctx.issue(actor, 'shuttle-target-unbound:' + JSON.stringify([tx, ty, tz, td])); return { cell: null, key: null, mismatch: true }; }
  return { cell: decorate(base), key: JSON.stringify([tx, ty, tz, depth ?? base.locator.depth]), mismatch: false };
}
function travelTarget(actor: Shuttle, cell: Cell): Vec3 {
  const spec = actor.spec;
  if (cell.platform) {
    const home = spec.travelBodyHome, middle = (home.axisMin + home.axisMax) / 2;
    if (cell.deckCenter) return projectTravel(spec.basePosition, spec.travelAxis,
      V.add(spec.basePosition, V.scale(spec.travelAxis, V.dot(cell.deckCenter, spec.travelAxis) - middle)), null);
    const center = V.dot(cell.position, spec.travelAxis); let coordinate = center;
    if (cell.locator.platformTrackEndWorld) {
      const end = V.dot(cell.locator.platformTrackEndWorld, spec.travelAxis), direction = Math.sign(end - center) || 1;
      const limit = end - direction * (home.axisMax - home.axisMin) / 2; coordinate = direction > 0 ? Math.min(center, limit) : Math.max(center, limit);
    }
    return projectTravel(spec.basePosition, spec.travelAxis, V.add(spec.basePosition, V.scale(spec.travelAxis, coordinate - middle)), spec.travelLimits);
  }
  return projectTravel(spec.basePosition, spec.travelAxis, V.add(spec.basePosition,
    V.scale(spec.travelAxis, V.dot(V.sub(cell.position, spec.targetReference), spec.travelAxis))), spec.travelLimits);
}
function arrived(actor: Shuttle, cell: Cell | null): boolean { return cell !== null && V.distance(actor.state.rootPosition ?? actor.spec.basePosition, travelTarget(actor, cell)) <= 0.02; }
function earlyDeckMotion(ctx: LogisticsContext, actor: Shuttle, frame: DriverFrame, cell: Cell | null): void {
  if (frame.faulted) return;
  const state = actor.state, onDeck = cell?.platform && cell.hcliftId !== null && (cell.deckCenter !== null || cell.exit);
  if (!onDeck || !cell) {
    if (cell) { state.hcliftExitFlashOutY = null; state.hcliftEntryStartPosition = null; state.hcliftExitStartPosition = null; }
    state.hcliftDeckSupportYId = null; state.hcliftDeckSupportY = null; return;
  }
  const support = V.dot(cell.position, actor.spec.upAxis), moved = state.hcliftDeckSupportYId === cell.hcliftId
    && state.hcliftDeckSupportY !== null && Math.abs(support - state.hcliftDeckSupportY) > 1e-4;
  state.hcliftDeckSupportYId = cell.hcliftId; state.hcliftDeckSupportY = support;
  const lifting = cell.workState === 5 || moved;
  if (!cell.exit) {
    state.hcliftExitFlashOutY = null; state.hcliftExitStartPosition = null;
    if (!cell.deckCenter) { state.hcliftEntryStartPosition = null; return; }
    state.hcliftEntryStartPosition ??= V.copy(state.rootPosition ?? actor.spec.basePosition);
    if (arrived(actor, cell)) return;
    const carrying = cell.workState === 2 || cell.workState === 5 || cell.workState === 6;
    const entered = V.distance(state.rootPosition ?? actor.spec.basePosition, state.hcliftEntryStartPosition) > 0.02;
    if (carrying || entered && lifting) state.rootPosition = travelTarget(actor, cell);
    return;
  }
  state.hcliftEntryStartPosition = null; state.hcliftExitStartPosition ??= V.copy(state.rootPosition ?? actor.spec.basePosition);
  const started = V.distance(state.rootPosition ?? actor.spec.basePosition, state.hcliftExitStartPosition) > 0.02;
  if (state.hcliftExitFlashOutY === null) { if (!started || !lifting) return; state.hcliftExitFlashOutY = cell.exitSupportY ?? support; }
  cell.position[1] = state.hcliftExitFlashOutY; state.rootPosition = travelTarget(actor, cell);
}
function releaseDeck(ctx: LogisticsContext, actor: Shuttle): void {
  const id = actor.state.hcliftOccupancyId;
  if (id && ctx.tx.get('devices', id)) { const lift = ctx.of(id, 'hclift'); if (lift.state.occupancy?.shuttleId === actor.device.id) lift.state.occupancy = null; }
  actor.state.hcliftOccupancyId = null;
}
function syncDeck(ctx: LogisticsContext, actor: Shuttle, frame: DriverFrame, status: number | null, cell: Cell | null): void {
  const state = actor.state, x = readIntegerField(frame.fields, 'x'), id = cell?.hcliftId ?? null;
  const onPlatform = x === -1 || x === -2 || x === 255 && id !== null && cell?.platform === true;
  if (!cell || !id || !onPlatform || cell.exit) { releaseDeck(ctx, actor); return; }
  if (state.hcliftOccupancyId !== null && state.hcliftOccupancyId !== id) releaseDeck(ctx, actor);
  const lift = ctx.of(id, 'hclift'), previous = lift.state.occupancy;
  if (previous && previous.shuttleId !== actor.device.id && ctx.now - previous.updatedAt <= 2000) { ctx.issue(actor, 'hclift-deck-busy:' + id); releaseDeck(ctx, actor); return; }
  if (state.hcliftOccupancyId !== id) state.hcliftLoadedSawMoving = false;
  lift.state.occupancy = { shuttleId: actor.device.id, phase: x === -2 && cell.deckCenter !== null && arrived(actor, cell) ? 'loaded' : 'entering',
    shuttleStatus: status, shuttleFaulted: frame.faulted, updatedAt: frame.receivedAt };
  state.hcliftOccupancyId = id;
}
function bind(ctx: LogisticsContext, actor: Shuttle): void {
  const state = actor.state; if (!state.cargoId || state.bound) return;
  state.bound = true; state.holdPosition = null; state.holdRotation = ctx.cargo.world(state.cargoId).rotation; state.holdScaling = null;
}
function unbind(ctx: LogisticsContext, actor: Shuttle, target: TargetCell | null): void {
  const state = actor.state; if (!state.cargoId || !target || !state.bound) return;
  const id = state.cargoId; state.bound = false; state.holdPosition = V.copy(target.position); state.holdRotation ??= ctx.cargo.world(id).rotation; state.holdScaling = null;
  if (state.placeTarget?.retainCargo) { ctx.cargo.clearHandoff(id); ctx.cargo.setWorld(id, target.position, state.holdRotation); }
  else if (state.fetchRowId === null) { ctx.cargo.setWorld(id, target.position, state.holdRotation); state.pendingPlatformLocatorId = target.locator.id; }
}
function completePlace(ctx: LogisticsContext, actor: Shuttle, current: TargetCell | null): void {
  const state = actor.state, id = state.cargoId; if (!id) return;
  const target = ctx.cargo.restoreTarget(state.placeTarget) ?? current; unbind(ctx, actor, target);
  if (state.pendingPlatformLocatorId !== null && state.forkOffset !== 0) return;
  if (state.placeTarget?.retainCargo) ctx.cargo.holdAtSlot(id, actor, state.placeTarget, state.fetchRowId, true);
  else if (state.fetchRowId !== null && state.placeTarget !== null) ctx.cargo.holdAtSlot(id, actor, state.placeTarget, state.fetchRowId, false);
  else if (state.fetchRowId === null) {
    if (state.pendingPlatformLocatorId !== null) {
      if (ctx.cargo.placePlatform(state.pendingPlatformLocatorId, id)) { ctx.cargo.clearFork(state); return; }
      const locator = ctx.locator(state.pendingPlatformLocatorId), receiver = ctx.conveyor(locator?.hostDeviceId ?? null);
      if (receiver && receiver.state.cargoId !== null) return;
    }
    ctx.cargo.dispose(id, 'shuttle-place-complete');
  } else ctx.issue(actor, 'shuttle-place-target-missing-for-fetch');
  ctx.cargo.clearFork(state);
}
function phaseExit(ctx: LogisticsContext, actor: Shuttle, status: number, cell: Cell | null): void {
  const state = actor.state; if (state.lastStatus === null || status === state.lastStatus) return;
  state.statusActionDone = false;
  if (state.lastStatus === 1) bind(ctx, actor); else if (state.lastStatus === 3) completePlace(ctx, actor, cell);
  if (status !== 1 && status !== 3) state.forkPhase = 'idle';
}
function trackTarget(ctx: LogisticsContext, actor: Shuttle, target: Target, status: number): void {
  const state = actor.state; if (target.key === null) return;
  if (state.lastTargetCellKey === null) {
    state.lastTargetCellKey = target.key; state.lastTargetCellChangedAt = ctx.now;
    if (target.cell) state.rootPosition = travelTarget(actor, target.cell); return;
  }
  if (target.key === state.lastTargetCellKey) return;
  if (state.lastTargetCellChangedAt !== null) state.targetCellChangeIntervalMs = ctx.now - state.lastTargetCellChangedAt;
  state.lastTargetCellChangedAt = ctx.now; state.lastTargetCellKey = target.key;
  if (state.forkCatchUp || Math.abs(state.forkOffset) <= 1e-3 && !(state.cargoId !== null && !state.bound)) return;
  state.forkCatchUp = true; state.forkPhase = 'idle'; state.statusActionDone = true;
  if (state.cargoId) { if (status === 1) bind(ctx, actor); else if (status === 3) { unbind(ctx, actor, ctx.cargo.restoreTarget(state.placeTarget) ?? target.cell); completePlace(ctx, actor, target.cell); } }
}
function travel(ctx: LogisticsContext, actor: Shuttle, frame: DriverFrame, status: number, cell: Cell | null): { moving: boolean; arrived: boolean } {
  const state = actor.state, spec = actor.spec; state.rootPosition ??= V.copy(spec.basePosition);
  const x = readIntegerField(frame.fields, 'x');
  if (cell?.platform && x === -2 && !cell.deckCenter && !cell.exit) return { moving: false, arrived: arrived(actor, cell) };
  const platformTrigger = cell?.platform === true && (x === -1 || cell.exit || (x === -2 || x === 255) && cell.deckCenter !== null);
  const actionTrigger = cell !== null && !cell.platform && (status === 1 || status === 3);
  if (frame.faulted || !cell || status !== 5 && !platformTrigger && !actionTrigger) return { moving: false, arrived: arrived(actor, cell) };
  const destination = travelTarget(actor, cell);
  if (cell.platform && cell.workState !== null) {
    if (cell.deckCenter && cell.workState !== 1) return { moving: false, arrived: arrived(actor, cell) };
    if (!cell.deckCenter && cell.hcliftCenter) {
      const p = state.rootPosition, deckDistance = Math.hypot(p[0] - cell.hcliftCenter[0], p[2] - cell.hcliftCenter[2]);
      const stationDistance = Math.hypot(p[0] - destination[0], p[2] - destination[2]);
      if (deckDistance < stationDistance && cell.workState !== 3) return { moving: false, arrived: arrived(actor, cell) };
    }
  }
  const speed = catchUpSpeed(V.distance(state.rootPosition, destination), spec.travelSpeed, state.lastTargetCellChangedAt, state.targetCellChangeIntervalMs, ctx.now);
  const motionSpeed = cell.platform ? Math.min(speed, cell.deckCenter || cell.exit ? spec.deckTravelSpeed : 0.5) : speed;
  const before = state.rootPosition;
  state.rootPosition = projectTravel(spec.basePosition, spec.travelAxis, moveVector(before, destination, motionSpeed * ctx.dt), cell.deckCenter ? null : spec.travelLimits);
  const moving = V.distance(before, state.rootPosition) > 1e-6; return { moving, arrived: !moving };
}
function retract(actor: Shuttle, speed: number, dt: number): boolean {
  const state = actor.state; state.forkTargetOffset = 0; state.forkOffset = moveNumber(state.forkOffset, 0, speed * dt);
  if (Math.abs(state.forkOffset) < 1e-4) { state.forkOffset = 0; state.forkPhase = 'idle'; return true; } return false;
}
function beginFetch(ctx: LogisticsContext, actor: Shuttle, target: Cell, task: string, code: string): void {
  const state = actor.state; ctx.cargo.disposeLegacyRole(actor, 'single'); ctx.cargo.clearFork(state);
  const slotted = ctx.tx.get('slots', target.cell.slotId)?.cargoId, retained = Boolean(slotted && ctx.cargo.meta(slotted).retained);
  state.cargoId = ctx.cargo.acquire(actor, 'single', task, code, target); ctx.cargo.suppress(target, state.cargoId); if (retained) ctx.cargo.releaseRetained(target);
  state.holdPosition = V.copy(target.position); state.holdRotation = ctx.cargo.lockedRotation(state.cargoId); state.holdScaling = V.copy(target.locator.rootPose.scale);
}
function preparePlace(ctx: LogisticsContext, actor: Shuttle, target: Cell, task: string, code: string): void {
  const state = actor.state;
  if (!state.cargoId) { ctx.cargo.disposeLegacyRole(actor, 'single'); ctx.cargo.clearFork(state); state.cargoId = ctx.cargo.acquire(actor, 'single', task, code); state.bound = true; }
  state.placeTarget = ctx.cargo.placeTarget(target); if (state.fetchRowId === null) state.fetchRowId = ctx.cargo.suppress(target, state.cargoId);
}
function phase(ctx: LogisticsContext, actor: Shuttle, frame: DriverFrame, status: number, target: Target, motion: { moving: boolean; arrived: boolean }): void {
  const state = actor.state, spec = actor.spec; if (frame.faulted) return;
  if (status !== 1 && status !== 3 || state.statusActionDone) { retract(actor, spec.forkSpeed, ctx.dt); return; }
  if (target.mismatch || !target.cell) return;
  if (target.cell.platform) { ctx.issue(actor, 'shuttle-platform-cannot-transfer:' + status); retract(actor, spec.forkSpeed, ctx.dt); return; }
  if (motion.moving || !motion.arrived) { retract(actor, spec.forkSpeed, ctx.dt); return; }
  const cell = target.cell;
  if (state.forkPhase === 'idle') {
    const task = taskOf(readIntegerField(frame.fields, 'task')), code = readStringField(frame.fields, 'containerCode')?.trim() ?? '';
    if (status === 1) { if (!state.cargoId) beginFetch(ctx, actor, cell, task, code); } else preparePlace(ctx, actor, cell, task, code);
    state.forkPhase = 'extending';
  }
  if (state.forkPhase === 'extending') {
    const home = V.add(V.add(spec.forkCenterHome, V.sub(state.rootPosition ?? spec.basePosition, spec.basePosition)), state.lastYFlashOffset ?? V.zero());
    const difference = V.dot(V.sub(cell.position, home), spec.forkAxis), direction = Math.abs(difference) >= 1e-6 ? Math.sign(difference) : 1;
    const needed = direction * difference; state.forkTargetOffset = direction * (needed > 0.001 ? needed : spec.forkStroke);
    state.forkOffset = moveNumber(state.forkOffset, state.forkTargetOffset, spec.forkSpeed * ctx.dt);
    if (Math.abs(state.forkTargetOffset) >= 0.001 && Math.abs(state.forkOffset) >= Math.abs(state.forkTargetOffset) - 0.02) {
      if (status === 1) bind(ctx, actor); else unbind(ctx, actor, cell);
      state.forkPhase = 'retracting'; state.forkTargetOffset = 0;
    }
    return;
  }
  if (retract(actor, spec.forkSpeed, ctx.dt)) { state.statusActionDone = true; if (status === 1) bind(ctx, actor); else completePlace(ctx, actor, cell); }
}
/** 单 Status 全相位机与 x=-1/-2/255 换层联动；完成码缺失仍可依相位退出/收叉归零正确收尾。 */
export function stepShuttle(ctx: LogisticsContext, actor: Shuttle, frame: DriverFrame): void {
  const state = actor.state, spec = actor.spec, status = readIntegerField(frame.fields, 'Status'), target = resolveTarget(ctx, actor, frame);
  earlyDeckMotion(ctx, actor, frame, target.cell);
  if (status !== null) { phaseExit(ctx, actor, status, target.cell); trackTarget(ctx, actor, target, status); }
  const yFlash = target.cell ? V.scale(spec.upAxis, V.dot(target.cell.position, spec.upAxis) - spec.cargoBaseHomeY) : state.lastYFlashOffset ?? V.zero();
  if (target.cell) state.lastYFlashOffset = V.copy(yFlash);
  if (status !== 10) {
    if (state.forkCatchUp) { if (retract(actor, spec.forkSpeed * 4, ctx.dt)) state.forkCatchUp = false; }
    else if (status !== null) phase(ctx, actor, frame, status, target, travel(ctx, actor, frame, status, target.cell));
  }
  if (state.pendingPlatformLocatorId !== null && state.forkOffset === 0) completePlace(ctx, actor, target.cell);
  syncDeck(ctx, actor, frame, status, target.cell);
  ctx.publishMotion(actor, { travel: V.sub(state.rootPosition ?? spec.basePosition, spec.basePosition), lift: yFlash, shuttleFork: state.forkOffset });
  if (state.cargoId) {
    const id = state.cargoId; ctx.cargo.syncTemplate(actor, id);
    const forkPosition = V.add(V.add(V.add(spec.forkAnchor, V.sub(state.rootPosition ?? spec.basePosition, spec.basePosition)), yFlash), V.scale(spec.forkAxis, state.forkOffset));
    ctx.cargo.setWorld(id, state.bound || !state.holdPosition ? forkPosition : state.holdPosition,
      state.holdRotation ?? ctx.cargo.lockedRotation(id), state.bound ? null : state.holdScaling, ctx.dt);
  }
  if (status !== null) state.lastStatus = status;
}
