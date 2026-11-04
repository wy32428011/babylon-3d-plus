import type { DeepReadonly, DeviceType, JsonObject, SchedulePhase, TimerState } from '../state/types';
import type { LogisticsManifest } from './manifest';
import { DEVICE_TYPES } from '../state/types';
import { draftRecord, scheduleTimer } from '../state/stateOps';
import { requireState, stableKey } from '../state/safeJson';
import type { LogisticsContext } from './context';
import type { ClockState } from './runtimeState';
import { wrapLogisticsState } from './runtimeState';
import { stepStacker } from './stacker';
import { pullExternalCargo, reconnectConveyorTopology, stepConveyor } from './conveyor';
import { stepHclift } from './hclift';
import { stepShuttle } from './shuttle';
import { stepRgv } from './rgv';
import { stepLift } from './lift';
import { evaluateAlarms } from './alarms';
import { pollInventory } from './inventory';
import { retireDynamicSubject } from './lifecycle';
import { LOGISTICS_ADAPTER_ID, LOGISTICS_ADAPTER_VERSION } from './manifest';

const FRAME_PHASES = ['topology', ...DEVICE_TYPES, 'external-pull'] as const;
type FramePhase = (typeof FRAME_PHASES)[number];
export type LogisticsClockSpec = { name: string; phase: SchedulePhase; timerType: 'step' | 'alarm-evaluate' | 'fetch-poll'; period: number; payload: JsonObject };
export const logisticsClockId = (name: string): string => stableKey('logistics-clock', name);
const fetchClock = (sourceId: string): string => 'fetch-poll:' + sourceId;

export function getLogisticsClockSpecs(manifest: DeepReadonly<LogisticsManifest>): LogisticsClockSpec[] {
  const result: LogisticsClockSpec[] = FRAME_PHASES.map(phase => ({ name: phase, phase, timerType: 'step',
    period: manifest.fixedStepMs, payload: { phase } }));
  if (manifest.alarmRules.length) result.push({ name: 'alarm', phase: 'alarm', timerType: 'alarm-evaluate', period: 250, payload: {} });
  for (const source of manifest.fetchSources) if (source.syncIntervalMs > 0) result.push({
    name: fetchClock(source.sourceId), phase: 'inventory', timerType: 'fetch-poll', period: source.syncIntervalMs,
    payload: { sourceId: source.sourceId },
  });
  return result;
}
function specs(ctx: LogisticsContext): LogisticsClockSpec[] { return getLogisticsClockSpecs(ctx.manifest); }
function clock(ctx: LogisticsContext, name: string): ClockState {
  const record = draftRecord(ctx.tx, 'adapterStates', logisticsClockId(name));
  const value = record.state.value as unknown as ClockState;
  requireState(value.kind === 'clock' && value.phase === name, 'LOGISTICS_CLOCK', '逻辑时钟身份不匹配。');
  return value;
}
function saveClock(ctx: LogisticsContext, value: ClockState): void {
  ctx.tx.put('adapterStates', { id: logisticsClockId(value.phase), deviceIds: [], cargoIds: [], state: wrapLogisticsState(value) });
}
function schedule(ctx: LogisticsContext, spec: LogisticsClockSpec, dueAt: number): string {
  requireState(Number.isSafeInteger(dueAt) && dueAt > ctx.now && dueAt <= 8_640_000_000_000_000,
    'LOGISTICS_CLOCK', '下一逻辑截止时间超出支持范围或没有前进。');
  return scheduleTimer(ctx.tx, { adapterId: LOGISTICS_ADAPTER_ID, adapterVersion: LOGISTICS_ADAPTER_VERSION,
    timerType: spec.timerType, dueAt, phase: spec.phase, deviceId: null, cargoId: null, payload: spec.payload });
}
/** 固定时钟须由对齐基线提供；activate 只能确认，不能把缺失的定时事实补成 ready。 */
export function activateLogisticsClocks(ctx: LogisticsContext): void { assertLogisticsClocks(ctx); }
export function assertLogisticsClocks(ctx: LogisticsContext): void {
  for (const spec of specs(ctx)) {
    const value = clock(ctx, spec.name), timer = value.timerId && ctx.tx.get('timers', value.timerId);
    requireState(timer && timer.adapterId === LOGISTICS_ADAPTER_ID && timer.timerType === spec.timerType && timer.phase === spec.phase,
      'LOGISTICS_CLOCK', '须先以 activate 安装完整时钟，或从完整检查点恢复。');
  }
}
/** 拓扑变化只登记脏标记，在下一逻辑帧首重连；不能每帧无条件重发链路波。 */
export function markLogisticsTopologyChanged(ctx: LogisticsContext): void {
  if (!ctx.topologyChanged) return;
  const value = clock(ctx, 'topology'); value.topologyDirty = true; saveClock(ctx, value);
}
function stepPhase(ctx: LogisticsContext, phase: FramePhase, value: ClockState): void {
  if (phase === 'topology') {
    if (value.topologyDirty) { reconnectConveyorTopology(ctx); value.topologyDirty = false; }
    return;
  }
  if (phase === 'external-pull') { pullExternalCargo(ctx); return; }
  for (const id of ctx.ids(phase as DeviceType)) {
    const actor = ctx.actor(id), frame = ctx.frame(actor);
    if (!frame || !ctx.shouldRun(actor)) continue;
    switch (actor.kind) {
      case 'stacker': stepStacker(ctx, actor, frame); break;
      case 'conveyor': stepConveyor(ctx, actor, frame); break;
      case 'hclift': stepHclift(ctx, actor, frame); break;
      case 'shuttle': stepShuttle(ctx, actor, frame); break;
      case 'rgv': stepRgv(ctx, actor, frame); break;
      case 'lift': stepLift(ctx, actor, frame); break;
    }
    actor.state.lastFrameAt = ctx.now;
  }
}
/** 调度器只处理已注册的定时事实；设备阶段按内核 SCHEDULE_PHASES 排序，帧尾拉货单独执行。 */
export function fireLogisticsTimer(ctx: LogisticsContext, timer: DeepReadonly<TimerState>): void {
  if (timer.timerType === 'expire') {
    const deviceId = timer.payload.deviceId as string, generation = timer.payload.generation as string;
    const device = ctx.tx.get('devices', deviceId);
    requireState(timer.phase === 'lifecycle' && timer.deviceId === deviceId && timer.cargoId === null
      && device?.dynamic?.generation === generation && device.dynamic.expiryTimerId === timer.id && device.dynamic.expiresAt === ctx.now,
    'LOGISTICS_TTL', '到期任务与活动实例代次或截止时间不一致。');
    retireDynamicSubject(ctx, deviceId, 'timeout'); markLogisticsTopologyChanged(ctx); return;
  }
  const name = timer.timerType === 'step' ? timer.payload.phase as string
    : timer.timerType === 'alarm-evaluate' ? 'alarm'
      : timer.timerType === 'fetch-poll' ? fetchClock(timer.payload.sourceId as string) : '';
  const spec = specs(ctx).find(item => item.name === name && item.timerType === timer.timerType);
  requireState(spec && timer.phase === spec.phase && timer.deviceId === null && timer.cargoId === null,
    'LOGISTICS_CLOCK', '定时任务的阶段、类型或来源不属于冻结清单。');
  const value = clock(ctx, spec.name);
  requireState(value.timerId === timer.id, 'LOGISTICS_CLOCK', '过期时钟任务不能重放业务。');
  value.lastAt = ctx.now;
  value.timerId = schedule(ctx, spec, ctx.now + spec.period);
  if (spec.timerType === 'step') stepPhase(ctx, spec.name as FramePhase, value);
  else if (spec.timerType === 'alarm-evaluate') evaluateAlarms(ctx);
  else pollInventory(ctx, spec.payload.sourceId as string);
  saveClock(ctx, value);
}
