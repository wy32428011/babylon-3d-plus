import type { HistoryMqttSourceConfig } from '../../../../electron/shared/historySourceConfig.ts';
import { parseDeviceTelemetryTopic } from '../../../runtime/mqtt/deviceTelemetry.ts';
import { LOGISTICS_ADAPTER_ID, LOGISTICS_ADAPTER_VERSION } from '../../../runtime/history/adapters/manifest.ts';
import type { LogisticsRawTelemetryRecord } from '../../../runtime/history/adapters/manifest.ts';
import { copySafeJson } from '../../../runtime/history/state/safeJson.ts';
import { applyHistoryMqttFieldMap, compileHistoryMqttFieldMap, type CompiledHistoryMqttField } from '../../../runtime/history/mqttFieldMap.ts';
import type { JsonObject, StateReadView } from '../../../runtime/history/state/types.ts';
import type { CapturedArrival } from '../storage/index.ts';
import type { HistoryNormalizedInput, HistoryNormalizer } from './HistoryProjector.ts';

export type HistoryMqttNormalizerSource = {
  sourceId: string;
  sourceRevision: string;
  config: HistoryMqttSourceConfig;
};

function pointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  if (!path.startsWith('/') || /~(?![01])/u.test(path)) throw new Error('字段路径必须是有效 JSON Pointer。');
  const segments = path.slice(1).split('/');
  if (segments.length > 16) throw new Error('字段路径超过深度预算。');
  let current = value;
  for (const part of segments) {
    const key = part.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('字段路径包含不安全属性。');
    if (!current || typeof current !== 'object') return undefined;
    if (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/u.test(key)) return undefined;
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function text(value: unknown, field: string, optional = false): string | null {
  if ((value === undefined || value === null) && optional) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${field} 必须是有界的非空文本。`);
  }
  return value;
}
function sequence(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const result = text(value, '设备序号');
  if (!result || !/^(0|[1-9][0-9]{0,255})$/u.test(result)) throw new Error('设备序号必须是无损的非负整数字符串。');
  return result;
}
function timestamp(value: unknown, unit: 'ms' | 's'): number | null {
  if (value === undefined || value === null || value === '') return null;
  let result: number;
  if (typeof value === 'number') result = value * (unit === 's' ? 1000 : 1);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) result = Number(value) * (unit === 's' ? 1000 : 1);
  else if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|\+00:00)$/u.test(value)) result = Date.parse(value);
  else throw new Error('来源时间必须为约定单位的时间戳或明确 UTC 的 ISO 时间。');
  if (!Number.isSafeInteger(result) || result < 0 || result > 8_640_000_000_000_000) throw new Error('来源时间超出可恢复的毫秒范围。');
  return result;
}
function parseJson(bytes: Uint8Array): unknown {
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(content, (key, value: unknown) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('遥测含不安全属性。');
    if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error('遥测包含不能无损表示的数值；大整数须以字符串传输。');
    }
    return value;
  });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('遥测记录或状态必须是 JSON 对象。');
  return value as Record<string, unknown>;
}
/** 与旧 EPV 适配器一样，e/s 仅提取首个有效值，p/v 只接收 e 缺失或匹配主体的点位。 */
function epvFields(data: unknown, assetCode: string): { fields: JsonObject; payloadDeviceCode: string | null; spawnerCode: string | null } {
  if (!Array.isArray(data)) throw new Error('EPV 记录缺少 data 点位数组。');
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let payloadDeviceCode: string | null = null, spawnerCode: string | null = null;
  const code = (value: unknown, name: string): string | null => {
    if (typeof value === 'string') value = value.trim();
    if (value === '' || value === null || value === undefined) return null;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    return text(value, name);
  };
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const point = item as Record<string, unknown>;
    const e = code(point.e, 'EPV 主体编号'), s = code(point.s, 'EPV 产生器编号');
    payloadDeviceCode ??= e; spawnerCode ??= s;
    if (typeof point.p !== 'string' || point.p.trim() === '' || e && e !== assetCode || point.v === undefined) continue;
    fields[point.p] = point.v;
  }
  return { fields: copySafeJson(fields) as JsonObject, payloadDeviceCode, spawnerCode };
}

/**
 * 一条持久到达对应一个受控 batch 输入；数组顺序是冻结的记录顺序，事务在 reducer 内原子执行。
 * 设备序号及事件身份绝不充当来源级水位；原始增量前态只由已提交状态恢复。
 */
export class MqttHistoryNormalizer implements HistoryNormalizer {
  readonly #sources: ReadonlyMap<string, HistoryMqttNormalizerSource & { fieldMap: readonly CompiledHistoryMqttField[] }>;
  constructor(sources: readonly HistoryMqttNormalizerSource[]) {
    const values = new Map<string, HistoryMqttNormalizerSource & { fieldMap: readonly CompiledHistoryMqttField[] }>();
    for (const source of sources) {
      if (!source.sourceId || source.sourceId !== source.config.logicalSourceId || !source.sourceRevision || values.has(source.sourceId)) {
        throw new Error('MQTT 来源身份或修订不完整、重复。');
      }
      const frozen = structuredClone(source);
      values.set(source.sourceId, { ...frozen, fieldMap: compileHistoryMqttFieldMap(frozen.config.parser.fieldMap) });
    }
    this.#sources = values;
  }

  normalize(arrival: Readonly<CapturedArrival>, state: StateReadView): HistoryNormalizedInput {
    if (arrival.transport.kind !== 'mqtt') throw new Error('此规范化器仅接受 MQTT 到达。');
    const source = this.#sources.get(arrival.sourceId);
    if (!source) throw new Error('MQTT 来源不属于冻结合同。');
    const boundary = state.metadata.baseline.sourceBoundaries.find(item => item.sourceId === source.sourceId && item.sourceRevision === source.sourceRevision);
    if (!boundary) throw new Error('MQTT 来源没有与基线对齐的真实边界。');
    const parser = source.config.parser;
    if (!['full', 'delta'].includes(parser.mode) || !['epv-v1', 'json-v1'].includes(parser.adapter)
      || !['ms', 's'].includes(parser.timeUnit) || parser.timeZone !== 'UTC'
      || !['source', 'observed'].includes(parser.timeBasis) || !['field', 'none'].includes(parser.epochMode)
      || parser.epochMode === 'field' && parser.epochPath === undefined) throw new Error('MQTT 解析合同无效。');
    const payload = parseJson(arrival.rawPayload);
    const selected = parser.recordsPath === undefined ? payload : pointer(payload, parser.recordsPath);
    const records = Array.isArray(selected) ? selected : [selected];
    if (records.length === 0) return { kind: 'advance', logicalTime: parser.timeBasis === 'source'
      ? state.metadata.logicalTime : Math.max(state.metadata.logicalTime, arrival.receivedAt) };
    if (records.length > 4096) throw new Error('MQTT 记录数超过单事务预算。');
    const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const topic = arrival.transport.topic;
    const topicInfo = parser.adapter === 'epv-v1' ? parseDeviceTelemetryTopic(topic) : null;
    if (parser.adapter === 'epv-v1' && !topicInfo) throw new Error('EPV topic 不符合已冻结协议。');
    const partial = records.map(item => {
      const record = object(item);
      const eventTime = parser.eventTimePath !== undefined ? pointer(record, parser.eventTimePath) : parser.adapter === 'epv-v1' ? record.ts ?? root.ts : undefined;
      const sourceTimestamp = timestamp(eventTime, parser.timeUnit);
      if (parser.timeBasis === 'source' && sourceTimestamp === null) throw new Error('来源时间口径缺少来源事件时间。');
      const rawSequence = parser.sequencePath !== undefined ? pointer(record, parser.sequencePath) : parser.adapter === 'epv-v1' ? record.seq ?? record.sequence ?? root.seq ?? root.sequence : undefined;
      const sequenceValue = sequence(rawSequence);
      const deviceEpoch = parser.epochMode === 'field' ? text(pointer(record, parser.epochPath!), '设备纪元')! : 'unversioned';
      const eventId = parser.eventIdPath === undefined ? null : text(pointer(record, parser.eventIdPath), '事件身份', true);
      const typeValue = parser.deviceTypePath !== undefined ? pointer(record, parser.deviceTypePath) : parser.deviceType ?? topicInfo?.deviceType;
      const deviceType = text(typeValue, '设备类型')!.toLowerCase();
      const assetCode = text(parser.deviceIdPath !== undefined ? pointer(record, parser.deviceIdPath) : topicInfo?.assetCode, '设备编号')!;
      if (topicInfo && parser.deviceType && parser.deviceTypePath === undefined && parser.deviceType.toLowerCase() !== topicInfo.deviceType) {
        throw new Error('EPV topic 与来源设备类型不匹配。');
      }
      let fields: JsonObject, payloadDeviceCode: string | null, spawnerCode: string | null;
      if (parser.adapter === 'epv-v1') {
        const data = parser.statePath !== undefined ? pointer(record, parser.statePath)
          : Object.hasOwn(record, 'p') && Object.hasOwn(record, 'v') ? [record] : record.data;
        ({ fields, payloadDeviceCode, spawnerCode } = epvFields(data, assetCode));
      } else {
        if (parser.statePath === undefined) throw new Error('JSON 来源未配置状态字段路径。');
        fields = copySafeJson(object(pointer(record, parser.statePath))) as JsonObject;
        payloadDeviceCode = assetCode; spawnerCode = null;
      }
      fields = copySafeJson(applyHistoryMqttFieldMap(fields, source.fieldMap, parser.mode)) as JsonObject;
      return { identity: { projectId: state.logic.versions.projectId, sourceId: source.sourceId, deviceType, assetCode },
        mode: parser.mode, fields, sourceTimestamp, sequence: sequenceValue, deviceEpoch, eventId, topic, payloadDeviceCode, spawnerCode };
    });
    const logicalTime = Math.max(state.metadata.logicalTime, parser.timeBasis === 'source'
      ? Math.max(...partial.map(record => record.sourceTimestamp!)) : arrival.receivedAt);
    const normalized: LogisticsRawTelemetryRecord[] = partial.map(record => ({ ...record, receivedAt: logicalTime, inputCursor: { ...arrival.receipt.inputCursor } }));
    return { kind: 'adapter', logicalTime, adapterId: LOGISTICS_ADAPTER_ID, adapterVersion: LOGISTICS_ADAPTER_VERSION, eventType: 'telemetry-batch',
      sourceEpoch: boundary.sourceEpoch, sourceEventId: null, sourceSequence: null, payload: { records: normalized } as unknown as JsonObject };
  }
}
