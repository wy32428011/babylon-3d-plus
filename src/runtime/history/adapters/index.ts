import type { StateAdapter } from '../state/adapters';
import { StateAdapterRegistry } from '../state/adapters';
import type { AdapterInput, DeepReadonly, DeviceIdentity, TelemetryFrame, TimerState, StateTransactionPort } from '../state/types';
import { DEVICE_TYPES } from '../state/types';
import { readStringField } from '../../mqtt/deviceTelemetry';
import { copySafeJson, requireState } from '../state/safeJson';
import { LogisticsContext } from './context';
import { readLogisticsManifest, validateLogisticsLogic, validateLogisticsState, validateLogisticsView } from './manifestValidation';
import { LOGISTICS_ADAPTER_ID, LOGISTICS_ADAPTER_VERSION, LOGISTICS_STATE_SCHEMA_VERSION } from './manifest';
import type { LogisticsScriptBinding, LogisticsTelemetryBatchPayload, LogisticsTelemetryPayload } from './manifest';
import { LOGISTICS_EVENT_SCHEMAS, LOGISTICS_STATE_VALUE_SCHEMA, LOGISTICS_TIMER_SCHEMAS } from './schemas';
import { applyLogisticsRawTelemetry, applyLogisticsTelemetry, birthDynamicSubject, discardLogisticsRawTelemetry, observeRepeatedLogisticsTelemetry, retireDynamicSubject } from './lifecycle';
import { completeInventory, requestInventory, resetInventoryEpoch, retryInventory } from './inventory';
import type { LogisticsFetchRequestPayload, LogisticsFetchResultPayload } from './inventory';
import { activateLogisticsClocks, assertLogisticsClocks, fireLogisticsTimer, markLogisticsTopologyChanged } from './scheduler';

/** 由可信构建代码明确提供支持类型和已迁移脚本摘要，不能从发布清单自动批准。 */
export type LogisticsAdapterOptions = {
  deviceTypes: readonly string[];
  supportedScripts: readonly DeepReadonly<LogisticsScriptBinding>[];
};
function data<T>(input: DeepReadonly<AdapterInput>): T { return copySafeJson(input.payload) as unknown as T; }
function sourceRequest(ctx: LogisticsContext, id: string, sourceId: string): void {
  requireState(ctx.tx.get('fetchRequests', id)?.sourceId === sourceId, 'LOGISTICS_FETCH', '请求不属于当前有序输入来源。');
}
function reduce(input: DeepReadonly<AdapterInput>, transaction: StateTransactionPort): void {
  if (input.eventType === 'telemetry-batch') {
    requireState(input.sourceSequence === null && input.sourceEventId === null, 'LOGISTICS_TELEMETRY', '设备序号和事件身份不能作为来源级去重水位。');
    const payload = data<LogisticsTelemetryBatchPayload>(input);
    const eventKeys = new Set<string>(), mode = payload.records[0].mode;
    for (const record of payload.records) {
      requireState(record.mode === mode, 'LOGISTICS_TELEMETRY', '同一来源报文的记录不能混用完整与增量语义。');
      if (record.eventId !== null) {
        const key = JSON.stringify([record.identity.projectId, record.identity.sourceId, record.identity.deviceType, record.identity.assetCode, record.eventId]);
        requireState(!eventKeys.has(key), 'LOGISTICS_TELEMETRY', '同一主体的单报文记录不能复用事件身份。'); eventKeys.add(key);
      }
    }
    // 同一捕获 offset 仅生成一个状态事务；逐条刷新上下文，避免跨记录草稿覆盖。
    for (const record of payload.records) {
      const ctx = new LogisticsContext(transaction, readLogisticsManifest(transaction.logic));
      assertLogisticsClocks(ctx); applyLogisticsRawTelemetry(ctx, record, input.sourceId);
      markLogisticsTopologyChanged(ctx); ctx.flush();
    }
    return;
  }
  const ctx = new LogisticsContext(transaction, readLogisticsManifest(transaction.logic));
  if (input.eventType !== 'activate') assertLogisticsClocks(ctx);
  switch (input.eventType) {
    case 'activate': activateLogisticsClocks(ctx); break;
    case 'telemetry': {
      const payload = data<LogisticsTelemetryPayload>(input);
      if (applyLogisticsTelemetry(ctx, payload, input.sourceId).disposition === 'applied') discardLogisticsRawTelemetry(ctx, payload.identity);
      break;
    }
    case 'dynamic-birth': {
      const payload = data<{ generatorId: string; identity: DeviceIdentity; frame: TelemetryFrame }>(input);
      const generator = ctx.manifest.dynamicGenerators.find(item => item.generatorId === payload.generatorId);
      requireState(generator && (payload.frame.spawnerCode === null || payload.frame.spawnerCode === generator.spawnerCode)
        && readStringField(payload.frame.fields, 'status')?.trim().toLowerCase() !== 'offline',
        'LOGISTICS_SPAWNER', '出生事实的产生器或消息状态不匹配，离线消息不能创建实例。');
      const deviceId = birthDynamicSubject(ctx, payload.generatorId, payload.identity, payload.frame, input.sourceId);
      if (applyLogisticsTelemetry(ctx, { deviceId, identity: payload.identity, frame: payload.frame }, input.sourceId).disposition === 'applied') {
        discardLogisticsRawTelemetry(ctx, payload.identity);
      }
      break;
    }
    case 'dynamic-remove': {
      const payload = data<{ deviceId: string; reason: string }>(input), device = transaction.get('devices', payload.deviceId);
      requireState(device?.identity.sourceId === input.sourceId && device.dynamic, 'LOGISTICS_LIFECYCLE', '退休事实必须指向当前来源的活动动态实例。');
      retireDynamicSubject(ctx, payload.deviceId, payload.reason); break;
    }
    case 'fetch-request': {
      const payload = data<LogisticsFetchRequestPayload>(input);
      requireState(payload.sourceId === input.sourceId, 'LOGISTICS_FETCH', '请求来源与输入来源不一致。');
      requestInventory(ctx, payload); break;
    }
    case 'fetch-result': completeInventory(ctx, data<LogisticsFetchResultPayload>(input), input.sourceId); break;
    case 'fetch-retry': {
      const { requestId } = data<{ requestId: string }>(input); sourceRequest(ctx, requestId, input.sourceId);
      retryInventory(ctx, requestId); break;
    }
    case 'fetch-reset': {
      const payload = data<{ sourceId: string; operationEpoch: string }>(input);
      requireState(payload.sourceId === input.sourceId, 'LOGISTICS_FETCH', '操作代次重置的来源不一致。');
      resetInventoryEpoch(ctx, payload.sourceId, payload.operationEpoch); break;
    }
    default: requireState(false, 'UNKNOWN_EVENT', '物流适配器未实现此业务事件。');
  }
  markLogisticsTopologyChanged(ctx); ctx.flush();
}
function repeated(input: DeepReadonly<AdapterInput>, transaction: StateTransactionPort): void {
  requireState(input.eventType !== 'telemetry-batch', 'LOGISTICS_TELEMETRY', '设备级遥测不能走来源级去重。');
  if (input.eventType !== 'telemetry') return;
  const ctx = new LogisticsContext(transaction, readLogisticsManifest(transaction.logic));
  assertLogisticsClocks(ctx);
  observeRepeatedLogisticsTelemetry(ctx, data<LogisticsTelemetryPayload>(input), input.sourceId);
  markLogisticsTopologyChanged(ctx); ctx.flush();
}
function onTimer(timer: DeepReadonly<TimerState>, transaction: StateTransactionPort): void {
  const ctx = new LogisticsContext(transaction, readLogisticsManifest(transaction.logic));
  fireLogisticsTimer(ctx, timer); ctx.flush();
}
/** 返回受控、同步的业务 reducer；注册时固定白名单，未知输入和脚本不会退化为通用 patch。 */
export function createLogisticsAdapter(options: LogisticsAdapterOptions): StateAdapter {
  const deviceTypes = copySafeJson(options.deviceTypes) as string[];
  const scripts = copySafeJson(options.supportedScripts) as unknown as LogisticsScriptBinding[];
  const profiles: readonly string[] = [...DEVICE_TYPES, 'storage', 'cargo', 'passive'];
  requireState(deviceTypes.length > 0 && new Set(deviceTypes).size === deviceTypes.length
    && deviceTypes.every(type => typeof type === 'string' && type.length > 0 && type.length <= 2048 && type === type.trim()),
  'LOGISTICS_ADAPTER', '必须显式指定无重复的真实主体类型。');
  requireState(new Set(scripts.map(script => script.id)).size === scripts.length && scripts.every(script =>
    typeof script.id === 'string' && script.id.length > 0 && script.id.length <= 2048
    && typeof script.digest === 'string' && /^[0-9a-f]{64}$/u.test(script.digest) && profiles.includes(script.profile)),
  'LOGISTICS_ADAPTER', '受控脚本须以唯一 ID、精确 SHA-256 和已迁移 profile 显式登记。');
  return {
    adapterId: LOGISTICS_ADAPTER_ID, version: LOGISTICS_ADAPTER_VERSION, stateSchemaVersion: LOGISTICS_STATE_SCHEMA_VERSION,
    capability: 'reducer', deviceTypes, supportedScripts: scripts.map(({ id, digest }) => ({ id, digest })),
    stateSchema: LOGISTICS_STATE_VALUE_SCHEMA, eventSchemas: LOGISTICS_EVENT_SCHEMAS, timerSchemas: LOGISTICS_TIMER_SCHEMAS,
    validateState: validateLogisticsState, validateView: validateLogisticsView,
    validateLogic: logic => {
      validateLogisticsLogic(logic, deviceTypes);
      const manifest = readLogisticsManifest(logic);
      requireState(manifest.scripts.every(script => scripts.some(allowed => allowed.id === script.id
        && allowed.digest === script.digest && allowed.profile === script.profile)),
      'UNSUPPORTED_SCRIPT', '物流脚本摘要或业务 profile 不在可信构建的明确白名单内。');
    },
    reduce, onRepeatedInput: repeated, onTimer,
  };
}
export function registerLogisticsAdapter(registry: StateAdapterRegistry, options: LogisticsAdapterOptions): StateAdapterRegistry {
  return registry.register(createLogisticsAdapter(options));
}

export * from './manifest';
export type * from './runtimeState';
export { createFreshLogisticsDriverState, wrapLogisticsState } from './runtimeState';
export { createFreshLogisticsAlarmState } from './alarms';
export { createLogisticsRawBaselineRecord, logisticsRawTelemetryId } from './lifecycle';
export { withLogisticsManifest, readLogisticsManifest, getLogisticsSubjectTypes } from './manifestValidation';
export { getPendingLogisticsFetchIntents } from './inventory';
export { getLogisticsClockSpecs, logisticsClockId } from './scheduler';
export type { LogisticsClockSpec } from './scheduler';
export { LOGISTICS_STATE_VALUE_SCHEMA, LOGISTICS_MANIFEST_SCHEMA, LOGISTICS_EVENT_SCHEMAS, LOGISTICS_TIMER_SCHEMAS } from './schemas';
