import type { TelemetryMotionChannel } from '../../../editor/model/telemetryBinding';
import type { DeviceTelemetryFields } from '../../mqtt/deviceTelemetry';

export type TelemetryMappedValue = number | string | null;

export type MapTelemetryMotionValueOptions = {
  fields: DeviceTelemetryFields;
  channel: TelemetryMotionChannel;
};

/** 按通道 fields 顺序读取首个有效遥测字段，并执行 actionMap 与数值映射。 */
export function mapTelemetryMotionValue(options: MapTelemetryMotionValueOptions): TelemetryMappedValue {
  const rawValue = readTelemetryFieldValue(options.fields, options.channel.fields);
  if (rawValue === null) return null;
  const mappedValue = mapActionValue(rawValue, options.channel.actionMap);
  if (typeof mappedValue === 'string') return mappedValue;
  const numericValue = typeof mappedValue === 'number' ? mappedValue : Number(mappedValue);
  if (!Number.isFinite(numericValue)) return null;
  const mappedNumber = numericValue * options.channel.scale + options.channel.offset;
  const signedValue = options.channel.invert ? -mappedNumber : mappedNumber;
  return clampTelemetryValue(signedValue, options.channel.min, options.channel.max);
}

/** 从多个候选字段中读取第一个非空值，支持字段重命名期间的安全回退。 */
export function readTelemetryFieldValue(fields: DeviceTelemetryFields, fieldNames: string[]): unknown | null {
  for (const fieldName of fieldNames) {
    const value = fields[fieldName];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

/** 根据 actionMap 把离散状态码映射为数值目标或动画动作字符串。 */
function mapActionValue(value: unknown, actionMap: TelemetryMotionChannel['actionMap']): unknown {
  if (!actionMap) return value;
  const exactKey = String(value);
  if (Object.prototype.hasOwnProperty.call(actionMap, exactKey)) return actionMap[exactKey];
  return value;
}

/** 对通道输出做上下限保护，避免异常遥测把模型推到不可见区域。 */
export function clampTelemetryValue(value: number, min?: number, max?: number): number {
  let nextValue = value;
  if (min !== undefined) nextValue = Math.max(min, nextValue);
  if (max !== undefined) nextValue = Math.min(max, nextValue);
  return nextValue;
}
