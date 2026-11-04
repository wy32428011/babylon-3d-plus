import { readIntegerField, readStringField } from '../../mqtt/deviceTelemetry';
import type { ActorOf, DriverFrame, LogisticsContext } from './context';
import type { ForkSide, FrozenTarget } from './manifest';
import { clamp, moveVector, projectedBounds, projectTravel, V } from './math';
import type { Vec3 } from '../state/types';

type Rgv = ActorOf<'rgv'>;
const taskOf = (value: number | null): string => value !== null && value !== 0 ? String(value) : '';
const positive = (frame: DriverFrame, key: string): number | null => { const n = readIntegerField(frame.fields, key); return n !== null && n > 0 ? n : null; };
function stationPosition(actor: Rgv, side: ForkSide): Vec3 {
  return V.add(actor.spec.stations[side].anchor, V.sub(actor.state.rootPosition ?? actor.spec.basePosition, actor.spec.basePosition));
}
function candidates(ctx: LogisticsContext, actor: Rgv, column: number): FrozenTarget[] {
  const binding = actor.spec.columns.find(binding => binding.column === column);
  if (!binding?.targets.length) { ctx.issue(actor, 'rgv-column-unbound:' + column); return []; }
  return binding.targets.filter(target => target.deviceId === null || ctx.tx.get('devices', target.deviceId)).map(target => {
    const conveyor = ctx.conveyor(target.deviceId);
    return conveyor ? { ...target, pose: { ...target.pose, position: V.copy(conveyor.spec.center) } } : target;
  });
}
function preferred(ctx: LogisticsContext, actor: Rgv, column: number, task: string, mode: 'fetch' | 'place' | null): FrozenTarget | null {
  const choices = candidates(ctx, actor, column); if (!choices.length) return null;
  if (task && mode) for (const choice of choices) {
    const conveyor = ctx.conveyor(choice.deviceId); if (!conveyor) continue;
    if (mode === 'place' ? conveyor.state.cargoId === null && (conveyor.state.pendingTask === task || conveyor.state.waitingTask === task)
      : conveyor.state.cargoId !== null && ctx.cargo.task(conveyor.state.cargoId) === task) return choice;
  }
  return choices[0];
}
function edgePosition(actor: Rgv, side: ForkSide, column: Vec3): Vec3 {
  const station = stationPosition(actor, side), delta = V.sub(actor.state.rootPosition ?? actor.spec.basePosition, actor.spec.basePosition);
  const bounds = actor.spec.stations[side].bounds, projected = projectedBounds({ min: V.add(bounds.min, delta), max: V.add(bounds.max, delta) }, actor.spec.forkAxis);
  const sign = V.dot(V.sub(column, station), actor.spec.forkAxis) >= 0 ? 1 : -1;
  const edge = (projected.min + projected.max) / 2 + sign * (projected.max - projected.min);
  return V.add(station, V.scale(actor.spec.forkAxis, edge - V.dot(station, actor.spec.forkAxis)));
}
function lockTransfer(actor: Rgv, side: ForkSide, column: number, task: string, mode: 'fetch' | 'place', target: Vec3, edge: Vec3): void {
  const station = stationPosition(actor, side), columnOffset = V.dot(V.sub(target, station), actor.spec.forkAxis), transfer = V.dot(V.sub(edge, station), actor.spec.forkAxis);
  if (Math.abs(columnOffset) <= 1e-7 || Math.abs(transfer) <= 1e-7) return;
  actor.state[side].transferMotion = { column, task, mode, velocity: transfer * (mode === 'fetch' ? -1 : 1) / 1.5 };
}
function disposeStation(ctx: LogisticsContext, actor: Rgv, side: ForkSide): void {
  const id = actor.state[side].cargoId; if (id) ctx.cargo.dispose(id, 'rgv-transfer-complete');
}
function onboard(ctx: LogisticsContext, actor: Rgv, side: ForkSide, task: string, code: string): void {
  ctx.cargo.disposeLegacyRole(actor, side);
  const id = ctx.cargo.acquire(actor, side, task, code), station = actor.state[side];
  station.cargoId = id; station.onBoard = true; station.progress = 1;
}
function beginFetch(ctx: LogisticsContext, actor: Rgv, side: ForkSide, column: number | null, task: string, code: string): void {
  const station = actor.state[side]; station.transferMotion = null; disposeStation(ctx, actor, side);
  if (column === null) { ctx.issue(actor, 'rgv-fetch-column-missing:' + side); return; }
  const target = preferred(ctx, actor, column, task, 'fetch'); if (!target) return;
  const id = ctx.cargo.acquire(actor, side, task, code), edge = edgePosition(actor, side, target.pose.position);
  lockTransfer(actor, side, column, task, 'fetch', target.pose.position, edge);
  station.cargoId = id; station.holdPosition = edge; station.holdRotation = ctx.cargo.lockedRotation(id); station.progress = 0; station.onBoard = false;
}
function beginPlace(ctx: LogisticsContext, actor: Rgv, side: ForkSide, column: number | null, task: string): void {
  const station = actor.state[side]; station.transferMotion = null; if (!station.cargoId) return;
  if (column === null) { ctx.issue(actor, 'rgv-place-column-missing:' + side); return; }
  const target = preferred(ctx, actor, column, ctx.cargo.task(station.cargoId), 'place'); if (!target) return;
  const edge = edgePosition(actor, side, target.pose.position);
  lockTransfer(actor, side, column, task, 'place', target.pose.position, edge);
  station.holdPosition = edge; station.holdRotation = ctx.cargo.lockedRotation(station.cargoId); station.progress = 1; station.onBoard = false;
}
function deliver(ctx: LogisticsContext, actor: Rgv, side: ForkSide, column: number | null): boolean {
  const station = actor.state[side], id = station.cargoId; if (!id || column === null) return false;
  const task = ctx.cargo.task(id); if (!task) return false;
  for (const candidate of candidates(ctx, actor, column)) if (ctx.cargo.deliverColumn(candidate.deviceId, id, task, station.progress < 1)) return true;
  return false;
}
function cargoStep(ctx: LogisticsContext, actor: Rgv, side: ForkSide, frame: DriverFrame): void {
  const station = actor.state[side], command = readIntegerField(frame.fields, side + '_command'), movement = readIntegerField(frame.fields, side + '_movement_z');
  const column = positive(frame, side + '_y'), task = taskOf(readIntegerField(frame.fields, side + '_task')), code = readStringField(frame.fields, side + '_containerCode')?.trim() ?? '';
  const transfer = station.transferMotion, mode = command === 1 || command === 3 ? 'fetch' : command === 2 ? 'place' : null;
  const rollerRunning = movement === 1 || movement === 2;
  if (frame.faulted || !rollerRunning || !mode || column === null || transfer && (transfer.column !== column || transfer.mode !== mode || transfer.task !== task)) station.transferMotion = null;
  if (!frame.faulted) {
    if ((command === 1 || command === 3) && station.lastCommand !== 1 && station.lastCommand !== 3) disposeStation(ctx, actor, side);
    if (command === 2 && station.lastCommand !== 2 && !station.cargoId) onboard(ctx, actor, side, task, code);
    if (movement !== null && movement !== 0 && (station.lastMovementZ === null || station.lastMovementZ === 0)) {
      if (command === 1 || command === 3) beginFetch(ctx, actor, side, column, task, code);
      else if (command === 2) { beginPlace(ctx, actor, side, column, task); deliver(ctx, actor, side, column ?? actor.state.travelTargetColumn); }
    }
    if (movement !== null && movement !== 0 && station.cargoId && station.holdPosition) {
      if (command === 1 || command === 3) station.progress = clamp(station.progress + ctx.dt / 1.5, 0, 1);
      else if (command === 2) station.progress = clamp(station.progress - ctx.dt / 1.5, 0, 1);
    }
    if (command === 2 && movement === 0 && station.lastMovementZ !== null && station.lastMovementZ !== 0) {
      if (!deliver(ctx, actor, side, column ?? actor.state.travelTargetColumn)) disposeStation(ctx, actor, side);
    }
    if (command === 0 && (station.lastCommand === 1 || station.lastCommand === 3)) {
      if (!station.cargoId && station.lastCommand === 1) onboard(ctx, actor, side, task, code);
      if (station.cargoId) { station.progress = 1; station.onBoard = true; station.holdPosition = null; station.holdRotation = null; }
    }
    if (command === 0 && station.lastCommand === 2 && !deliver(ctx, actor, side, column ?? actor.state.travelTargetColumn)) disposeStation(ctx, actor, side);
  }
  if (!rollerRunning) station.transferMotion = null;
  if (station.cargoId) {
    const id = station.cargoId; ctx.cargo.syncTemplate(actor, id);
    const position = stationPosition(actor, side), target = !station.onBoard && station.holdPosition && station.progress < 1 ? V.lerp(station.holdPosition, position, station.progress) : position;
    ctx.cargo.setWorld(id, target, ctx.cargo.lockedRotation(id), null, ctx.dt);
  }
  station.lastCommand = command; station.lastMovementZ = movement;
}
/** go_column 优先、起转吸附、双侧命令边沿及交付失败后的销毁兜底，按旧驱动执行顺序迁移。 */
export function stepRgv(ctx: LogisticsContext, actor: Rgv, frame: DriverFrame): void {
  const state = actor.state, spec = actor.spec; state.rootPosition ??= V.copy(spec.basePosition);
  const frontColumn = positive(frame, 'front_y'), backColumn = positive(frame, 'back_y'), goColumn = positive(frame, 'go_column');
  const frontCommand = readIntegerField(frame.fields, 'front_command'), backCommand = readIntegerField(frame.fields, 'back_command');
  const frontActive = frontCommand === 1 || frontCommand === 2 || frontCommand === 3, backActive = backCommand === 1 || backCommand === 2 || backCommand === 3;
  const side: ForkSide = frontActive && frontColumn !== null ? 'front' : backActive && backColumn !== null ? 'back' : frontColumn !== null ? 'front' : 'back';
  const fieldColumn = frontActive && frontColumn !== null ? frontColumn : backActive && backColumn !== null ? backColumn : frontColumn ?? backColumn;
  const column = goColumn ?? fieldColumn;
  if (!frame.faulted && column !== null && column !== state.travelTargetColumn) {
    const command = side === 'front' ? frontCommand : backCommand, task = taskOf(readIntegerField(frame.fields, side + '_task'));
    const target = preferred(ctx, actor, column, task, command === 2 ? 'place' : command === 1 || command === 3 ? 'fetch' : null);
    if (target) {
      state.travelTargetColumn = column;
      const delta = V.dot(V.sub(target.pose.position, spec.stations[side].anchor), spec.travelAxis);
      state.travelTargetPosition = projectTravel(spec.basePosition, spec.travelAxis, V.add(spec.basePosition, V.scale(spec.travelAxis, delta)), spec.travelLimits);
    }
  }
  if (!frame.faulted && state.travelTargetPosition) {
    const running = (readIntegerField(frame.fields, 'front_movement_z') ?? 0) !== 0 || (readIntegerField(frame.fields, 'back_movement_z') ?? 0) !== 0;
    if (running) { state.rootPosition = V.copy(state.travelTargetPosition); state.travelTargetPosition = null; }
    else {
      state.rootPosition = moveVector(state.rootPosition, state.travelTargetPosition, spec.travelSpeed * ctx.dt);
      if (V.distance(state.rootPosition, state.travelTargetPosition) <= 1e-6) state.travelTargetPosition = null;
    }
  }
  state.rootPosition = projectTravel(spec.basePosition, spec.travelAxis, state.rootPosition, spec.travelLimits);
  ctx.publishMotion(actor, { travel: V.sub(state.rootPosition, spec.basePosition) });
  cargoStep(ctx, actor, 'front', frame); cargoStep(ctx, actor, 'back', frame);
}
