import type { AlarmState, JsonValue, TelemetryFrame } from '../state/types';
import { draftRecord } from '../state/stateOps';
import { copySafeJson } from '../state/safeJson';
import type { LogisticsContext } from './context';
import type { FrozenAlarmRule } from './manifest';
import type { AlarmRuleState } from './runtimeState';
import { wrapLogisticsState } from './runtimeState';

function property(fields: unknown, name: string): JsonValue | undefined {
  if (!fields || typeof fields !== 'object') return undefined;
  let value: unknown = fields;
  const keys = Object.hasOwn(fields, name) ? [name] : name.split('.');
  for (const key of keys) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value as JsonValue | undefined;
}
function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? String(value).trim().toLowerCase() : null;
}
function matches(value: unknown, expectedValue: string): boolean {
  const actual = scalar(value), expected = scalar(expectedValue);
  return expected === 'true' ? actual === 'true' || actual === '1'
    : expected === 'false' ? actual === 'false' || actual === '0' : actual !== null && actual === expected;
}
/** 新规则/权威新生主体的 unknown 初态；不得替代已存在报警的真实保留值和 activatedAt。 */
export function createFreshLogisticsAlarmState(rule: FrozenAlarmRule): AlarmState {
  return { id: rule.id, deviceId: rule.deviceId, ruleId: rule.id, retained: [], active: false,
    activatedAt: null, clearedAt: null, evaluatedAt: null, edge: 'unknown',
    state: wrapLogisticsState({ kind: 'alarm', trigger: null, status: 'waiting' }) };
}
/** 对应 AlarmTelemetryTracker.capture：按已订阅点位逐消息保留，缺失键不覆盖，显式 null/对象照实保留为无效值。 */
export function captureAlarmProperties(ctx: LogisticsContext, deviceId: string, frame: TelemetryFrame, updatedFields: TelemetryFrame['fields'] = frame.fields): void {
  for (const rule of ctx.manifest.alarmRules) {
    if (rule.deviceId !== deviceId || rule.listenProperty !== 'CUSTOM PROPERTY') continue;
    const alarm = draftRecord(ctx.tx, 'alarms', rule.id), names = new Set([rule.customProperty, ...(rule.warehouseAlarm ? ['warehouseAlarm'] : [])].filter(Boolean));
    for (const name of names) {
      const value = property(updatedFields, name); if (value === undefined) continue;
      const index = alarm.retained.findIndex(item => item.property === name);
      const item = { property: name, value: copySafeJson(value), receivedAt: frame.receivedAt, inputCursor: { ...frame.inputCursor } };
      if (index < 0) alarm.retained.push(item); else alarm.retained[index] = item;
    }
    ctx.tx.put('alarms', alarm);
  }
}
/** resolveAlarmTrigger 的原优先级：warehouse 优先，再 CUSTOM PROPERTY/fire，最后 running-state/device。 */
export function evaluateAlarms(ctx: LogisticsContext): void {
  for (const rule of ctx.manifest.alarmRules) {
    const alarm = draftRecord(ctx.tx, 'alarms', rule.id), device = ctx.tx.get('devices', rule.deviceId);
    const frame = device?.telemetry.current ?? null;
    let trigger: AlarmRuleState['trigger'] = null, status: AlarmRuleState['status'] = 'unmatched';
    if (!rule.enabled || !rule.telemetryEnabled) status = 'disabled';
    else if (!frame) status = 'waiting';
    else {
      const fields: Record<string, unknown> = rule.listenProperty === 'CUSTOM PROPERTY'
        ? Object.fromEntries(alarm.retained.map(item => [item.property, item.value])) : frame.fields;
      const custom = rule.customProperty ? property(fields, rule.customProperty) : undefined;
      const customMatch = matches(custom, rule.customValue), warehouse = scalar(fields.warehouseAlarm);
      const receivedAt = device?.telemetry.effectiveHeartbeatAt ?? frame.receivedAt;
      const stale = ctx.now - receivedAt > rule.staleAfterMs;
      if ((!stale || rule.listenProperty === 'CUSTOM PROPERTY') && rule.warehouseAlarm && (warehouse === 'true' || warehouse === '1' || customMatch)) trigger = 'warehouse';
      else if (rule.listenProperty === 'CUSTOM PROPERTY') trigger = customMatch ? 'fire' : null;
      else {
        const raw = scalar(fields.runningState ?? fields.running_state ?? fields.state ?? fields.status);
        const aliases: Record<string, string> = { '0': 'offline', '1': 'idle', '2': 'running', '3': 'alarm', '离线': 'offline', '空闲': 'idle', '运行': 'running', '报警': 'alarm', warning: 'alarm', fault: 'alarm' };
        const running = stale ? 'offline' : frame.faulted ? 'alarm' : raw === null ? null : aliases[raw] ?? raw;
        if (running === rule.runningState) trigger = 'device';
        else if (running === null) status = 'missing';
        else if (!['offline', 'idle', 'running', 'alarm'].includes(running)) status = 'invalid';
      }
      status = trigger !== null ? 'matched' : rule.listenProperty === 'CUSTOM PROPERTY'
        ? custom === undefined ? 'missing' : scalar(custom) === null ? 'invalid' : 'unmatched'
        : status === 'missing' || status === 'invalid' ? status : 'unmatched';
    }
    const active = trigger !== null;
    const edge = active ? 'active' : status === 'disabled' || status === 'waiting' || status === 'missing' || status === 'invalid' ? 'unknown' : 'inactive';
    if (active && !alarm.active) alarm.activatedAt = ctx.now;
    if (alarm.edge === 'active' && edge === 'inactive') alarm.clearedAt = ctx.now;
    alarm.active = active; alarm.evaluatedAt = ctx.now; alarm.edge = edge;
    alarm.state = wrapLogisticsState({ kind: 'alarm', trigger, status }); ctx.tx.put('alarms', alarm);
  }
}
