import type { DeepReadonly, JsonValue } from './types';

export class TwinStateError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'TwinStateError'; }
}
export function requireState(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new TwinStateError(code, message);
}
export type StateBudgets = {
  maxBytes: number; maxNodes: number; maxDepth: number; maxStringLength: number;
  maxArrayLength: number; maxObjectKeys: number; maxRecordsPerTable: number;
  maxChangesPerRevision: number; maxRevisionsPerBatch: number; maxTimersPerInput: number;
  maxRecordBytes: number; maxRecordNodes: number;
};
export const DEFAULT_STATE_BUDGETS: Readonly<StateBudgets> = Object.freeze({
  maxBytes: 64 * 1024 * 1024, maxNodes: 2_000_000, maxDepth: 48, maxStringLength: 262_144,
  maxArrayLength: 200_000, maxObjectKeys: 4096, maxRecordsPerTable: 100_000,
  maxChangesPerRevision: 20_000, maxRevisionsPerBatch: 20_000, maxTimersPerInput: 10_000,
  maxRecordBytes: 1024 * 1024, maxRecordNodes: 40_000,
});
export function resolveStateBudgets(overrides: Partial<StateBudgets> = {}): Readonly<StateBudgets> {
  const descriptors = Object.getOwnPropertyDescriptors(overrides);
  requireState(Object.getPrototypeOf(overrides) === Object.prototype || Object.getPrototypeOf(overrides) === null,
    'BUDGET', '预算必须是普通对象。');
  requireState(Object.getOwnPropertySymbols(overrides).length === 0, 'BUDGET', '预算不允许 Symbol。');
  const result = { ...DEFAULT_STATE_BUDGETS };
  for (const [key, descriptor] of Object.entries(descriptors)) {
    requireState(Object.prototype.hasOwnProperty.call(result, key) && 'value' in descriptor
      && Number.isSafeInteger(descriptor.value) && descriptor.value > 0, 'BUDGET', '预算必须是已知的正安全整数。');
    result[key as keyof StateBudgets] = descriptor.value as number;
  }
  return Object.freeze(result);
}
export function utf8Length(text: string): number {
  let size = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) size += 1;
    else if (c < 0x800) size += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length
      && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { size += 4; i += 1; }
    else size += 3;
  }
  return size;
}
/** 不读 getter、不执行 toJSON、不接受类实例/稀疏数组/危险键；输入边界仅接受普通 JSON。 */
export function copySafeJson(value: unknown, budget: Readonly<StateBudgets> = DEFAULT_STATE_BUDGETS, record = false): JsonValue {
  let nodes = 0, bytes = 0;
  const maxNodes = record ? budget.maxRecordNodes : budget.maxNodes;
  const maxBytes = record ? budget.maxRecordBytes : budget.maxBytes;
  const ancestors = new Set<object>();
  const charge = (amount: number) => { bytes += amount; requireState(bytes <= maxBytes, 'BUDGET', 'JSON 超过字节预算。'); };
  const visit = (item: unknown, depth: number): JsonValue => {
    nodes += 1;
    requireState(nodes <= maxNodes && depth <= budget.maxDepth, 'BUDGET', 'JSON 超过节点或深度预算。');
    if (item === null || typeof item === 'boolean') { charge(5); return item; }
    if (typeof item === 'number') {
      requireState(Number.isFinite(item), 'JSON_NUMBER', '状态拒绝 NaN 和 Infinity。');
      charge(24); return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item === 'string') {
      requireState(item.length <= budget.maxStringLength, 'BUDGET', 'JSON 字符串超过预算。');
      charge(utf8Length(JSON.stringify(item))); return item;
    }
    requireState(typeof item === 'object' && item !== null, 'JSON_TYPE', '状态只能包含普通 JSON 数据。');
    requireState(!ancestors.has(item), 'JSON_CYCLE', '状态不能包含循环引用。');
    const array = Array.isArray(item);
    requireState(Object.getPrototypeOf(item) === (array ? Array.prototype : Object.prototype)
      || (!array && Object.getPrototypeOf(item) === null), 'JSON_TYPE', '状态不能包含 Mesh、Map、类实例或其他运行时对象。');
    const keys = Reflect.ownKeys(item);
    requireState(keys.length <= (array ? budget.maxArrayLength + 1 : budget.maxObjectKeys), 'BUDGET', 'JSON 字段数超过预算。');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of keys) {
      requireState(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key), 'JSON_KEY', 'JSON 包含不安全字段。');
      const descriptor = descriptors[key];
      requireState(descriptor && 'value' in descriptor && (descriptor.enumerable || (array && key === 'length')),
        'JSON_ACCESSOR', '状态拒绝访问器和非枚举字段。');
      requireState(key.length <= 256, 'BUDGET', 'JSON 字段名过长。');
    }
    ancestors.add(item); charge(2);
    let result: JsonValue;
    if (array) {
      const length = descriptors.length.value as number;
      requireState(length <= budget.maxArrayLength && keys.length === length + 1, 'JSON_ARRAY', '数组必须稠密且不能包含额外属性。');
      const output: JsonValue[] = [];
      for (let i = 0; i < length; i += 1) {
        requireState(Object.prototype.hasOwnProperty.call(descriptors, String(i)), 'JSON_ARRAY', '数组不能包含空缺项。');
        charge(1); output.push(visit(descriptors[String(i)].value, depth + 1));
      }
      result = output;
    } else {
      const output: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
      for (const key of keys as string[]) { charge(utf8Length(JSON.stringify(key)) + 2); output[key] = visit(descriptors[key].value, depth + 1); }
      result = output;
    }
    ancestors.delete(item);
    return result;
  };
  return visit(value, 0);
}
export function freezeData<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeData(item);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
/** 调用前数据必须经过 copySafeJson 或来自已冻结的内核记录。键按 UTF-16 码元顺序而非 locale 排序；数值使用 ECMAScript JSON 表示。 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function compareDecimal(a: string, b: string): number { return a.length - b.length || compareText(a, b); }
export function nextDecimal(value: string): string {
  requireState(/^(0|[1-9][0-9]*)$/u.test(value) && value.length <= 256, 'CURSOR', '游标/计数必须是有界无符号十进制字符串。');
  const next = (BigInt(value) + 1n).toString();
  requireState(next.length <= 256, 'CURSOR', '游标或计数溢出合同上限。');
  return next;
}
export function stableKey(...parts: string[]): string { return JSON.stringify(parts); }
