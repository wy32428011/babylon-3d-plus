export type CompiledHistoryMqttField = Readonly<{ target: string; segments: readonly string[] }>;

/** 映射路径相对于所选状态对象；输出字段只来自实际收到的值。 */
export function compileHistoryMqttFieldMap(value: unknown): readonly CompiledHistoryMqttField[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('MQTT 点位映射必须是规范字段名到 JSON Pointer 的对象。');
  }
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error('MQTT 点位映射不能超过 128 项。');
  return entries.map(([target, path]) => {
    if (!target || target.length > 256 || target.startsWith(' ') || target.endsWith(' ') || /[\u0000-\u001f\u007f]/u.test(target)
      || ['__proto__', 'constructor', 'prototype'].includes(target)) {
      throw new Error('MQTT 规范点位名无效。');
    }
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 512
      || /[\u0000-\u001f\u007f]/u.test(path) || /~(?![01])/u.test(path)) {
      throw new Error('MQTT 点位路径必须是非空 RFC6901 JSON Pointer。');
    }
    const segments = path.slice(1).split('/').map(segment => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'));
    if (segments.length > 16 || segments.some(segment => ['__proto__', 'constructor', 'prototype'].includes(segment))) {
      throw new Error('MQTT 点位路径超过深度预算或包含不安全字段。');
    }
    return { target, segments };
  });
}

/** 增量帧的嵌套对象按顶层整体替换；无法表达删除别名时必须阻断。 */
export function applyHistoryMqttFieldMap<T extends Record<string, unknown>>(
  fields: T, mapping: readonly CompiledHistoryMqttField[], mode: 'full' | 'delta',
): Record<string, unknown> {
  if (mapping.length === 0) return fields;
  const result: Record<string, unknown> = Object.assign(Object.create(null) as Record<string, unknown>, fields);
  for (const { target } of mapping) delete result[target];
  for (const { target, segments } of mapping) {
    let value: unknown = fields;
    let found = true;
    for (const segment of segments) {
      if (!value || typeof value !== 'object'
        || Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(segment)
        || !Object.hasOwn(value, segment)) { found = false; break; }
      value = (value as Record<string, unknown>)[segment];
    }
    if (found) result[target] = value;
    else if (mode === 'delta' && segments.length > 1 && Object.hasOwn(fields, segments[0])) {
      throw new Error('增量帧替换的状态对象缺少映射点位，无法证明原有点位仍然有效。');
    }
  }
  return result;
}
