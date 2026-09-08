import type { DeviceTelemetryFields } from './deviceTelemetry';

/**
 * 高频点位的无分配比较；保留 JSON 字段顺序。复杂值交回原序列化路径，
 * 避免嵌套对象、toJSON 或脚本原位修改被引用相等掩盖。
 */
export function areFlatTelemetryFieldsEqual(
  fields: DeviceTelemetryFields,
  previous: DeviceTelemetryFields,
  previousKeys: readonly string[],
): boolean {
  let previousIndex = 0;
  for (const key in previous) {
    if (Object.hasOwn(previous, key) && previousKeys[previousIndex++] !== key) return false;
  }
  if (previousIndex !== previousKeys.length) return false;
  let index = 0;
  for (const key in fields) {
    if (!Object.hasOwn(fields, key)) continue;
    if (previousKeys[index++] !== key) return false;
    const value = fields[key];
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') return false;
    if (!Object.is(value, previous[key])) return false;
  }
  return index === previousKeys.length;
}

export function areTelemetryStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
