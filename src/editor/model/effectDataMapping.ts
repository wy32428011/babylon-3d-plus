import type { PoiEffectComponent } from './components';
import type { EffectDataBinding, EffectParameterDefinition } from './effectConfiguration';
import type { EffectDataResult } from '../../runtime/effects/EffectDataRuntime';
import { DIGITAL_TWIN_EFFECT_NUMBER_LIMITS, createDefaultDigitalTwinEffectConfig } from './digitalTwinEffect';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
type MappingOptions = { parameterDefinitions?: readonly EffectParameterDefinition[] };

/** 支持简单的点分字段和数字下标，禁止执行表达式或访问原型链。 */
export function readEffectField(data: unknown, path: string): unknown {
  if (!path || path === '$') return data;
  const normalized = path.replace(/^\$\./, '').replace(/\[(\d+)\]/g, '.$1');
  if (normalized.length > 512) return undefined;
  const parts = normalized.split('.');
  if (parts.length > 32 || parts.some(part => !part || UNSAFE_KEYS.has(part) || !/^[\w$\u0080-\uffff-]+$/.test(part))) return undefined;
  let value = data;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function readEffectNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function readBoolean(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}
function field(result: EffectDataResult, path: string): unknown {
  if (!path || path === '$') return result.data ?? result.fields;
  const direct = readEffectField(result.fields, path);
  return direct !== undefined ? direct : readEffectField(result.data, path);
}
function range(value: unknown, min: number, max: number, label: string): number {
  const number = readEffectNumber(value);
  if (number === null || number < min || number > max) throw new Error(`${label}必须为 ${min}～${max} 之间的有限数值。`);
  return number;
}
function color(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw new Error(`${label}必须为 #RRGGBB 颜色。`);
  return value;
}
function vector(value: unknown, definition: EffectParameterDefinition, scale = 1, offset = 0): { x: number; y: number; z: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== 3 || Reflect.ownKeys(value).some(key => !['x', 'y', 'z'].includes(String(key)))) {
    throw new Error(`${definition.label}需要仅包含 x、y、z 的普通对象。`);
  }
  if (!Number.isFinite(scale) || !Number.isFinite(offset)) throw new Error(`${definition.label}的倍率或偏移无效。`);
  const axis = (key: 'x' | 'y' | 'z') => {
    // 只读取自有数据属性，不能执行设备数据携带的访问器或读取原型上的轴值。
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const source = descriptor && Object.hasOwn(descriptor, 'value') ? readEffectNumber(descriptor.value) : null;
    if (source === null) throw new Error(`${definition.label}.${key}需要有限数值。`);
    return range(source * scale + offset, definition.min ?? -100000, definition.max ?? 100000, `${definition.label}.${key}`);
  };
  return { x: axis('x'), y: axis('y'), z: axis('z') };
}

/** 只构造运行时覆盖副本，原组件及保存/撤销历史均保持不变。 */
export function applyEffectDataMappings(component: PoiEffectComponent, result: EffectDataResult, options: MappingOptions = {}): { component: PoiEffectComponent; issues: string[] } {
  const binding = component.configuration?.data;
  if (!binding || result.status !== 'online') return { component, issues: [] };
  const next: PoiEffectComponent = { ...component, visual: component.visual ? { ...component.visual } : undefined,
    configuration: component.configuration ? { ...component.configuration, parameters: { ...component.configuration.parameters } } : undefined };
  const issues: string[] = [];
  for (const mapping of binding.mappings.slice(0, 64)) {
    try {
      const source = field(result, mapping.field);
      if (source === undefined || source === null) throw new Error(`字段 ${mapping.field} 缺失或路径无效。`);
      let value: unknown = source;
      if (mapping.values.length) {
        const option = mapping.values.find(entry => entry.value === String(source));
        if (!option) throw new Error(`字段 ${mapping.field} 的值没有配置枚举映射。`);
        value = option.output;
      } else if (mapping.scale !== 1 || mapping.offset !== 0) {
        const definition = mapping.target.startsWith('configuration.parameters.')
          ? options.parameterDefinitions?.find(item => item.key === mapping.target.slice('configuration.parameters.'.length) && item.bindable && item.type === 'vector') : undefined;
        if (definition) value = vector(source, definition, mapping.scale, mapping.offset);
        else {
          const number = readEffectNumber(source);
          if (number === null || !Number.isFinite(mapping.scale) || !Number.isFinite(mapping.offset)) throw new Error(`字段 ${mapping.field} 无法进行数值换算。`);
          value = number * mapping.scale + mapping.offset;
        }
      }
      assignSink(next, mapping.target, value, options.parameterDefinitions ?? []);
    } catch (error) { issues.push(error instanceof Error ? error.message : '字段映射失败。'); }
  }
  if (binding.mappings.length > 64) issues.push('字段映射超过 64 项上限。');
  if (binding.dataset.enabled) applyDataset(next, result, binding, issues);
  return { component: next, issues };
}

function assignSink(component: PoiEffectComponent, target: string, value: unknown, definitions: readonly EffectParameterDefinition[]): void {
  if (target === 'primaryColor' || target === 'secondaryColor') { component[target] = color(value, target); return; }
  if (target === 'enabled') {
    const boolean = readBoolean(value); if (boolean === null) throw new Error('enabled 需要布尔值或 0/1。');
    component.enabled = boolean; return;
  }
  if (target === 'intensity' || target === 'speed' || target === 'density') {
    // 与特效库可编辑上限保持一致，运行态允许 0 表示熄灭或暂停。
    component[target] = range(value, 0, target === 'intensity' ? 3 : target === 'speed' ? 5 : 2, target); return;
  }
  if (target.startsWith('visual.')) {
    const key = target.slice(7);
    if (!Object.hasOwn(DIGITAL_TWIN_EFFECT_NUMBER_LIMITS, key)) throw new Error(`不允许映射 ${target}。`);
    const limits = DIGITAL_TWIN_EFFECT_NUMBER_LIMITS[key as keyof typeof DIGITAL_TWIN_EFFECT_NUMBER_LIMITS];
    const visual = component.visual ?? createDefaultDigitalTwinEffectConfig(component.effectKind);
    component.visual = { ...visual, [key]: range(value, limits.min, limits.max, target) }; return;
  }
  if (target.startsWith('configuration.parameters.')) {
    const key = target.slice('configuration.parameters.'.length);
    const definition = definitions.find(item => item.key === key && item.bindable);
    if (!definition || !component.configuration || UNSAFE_KEYS.has(key)) throw new Error(`参数 ${key} 未开放数据绑定。`);
    let next: number | string | boolean | { x: number; y: number; z: number };
    if (definition.type === 'number') next = range(value, definition.min ?? -1000000, definition.max ?? 1000000, definition.label);
    else if (definition.type === 'color') next = color(value, definition.label);
    else if (definition.type === 'boolean') { const boolean = readBoolean(value); if (boolean === null) throw new Error(`${definition.label}需要布尔值。`); next = boolean; }
    else if (definition.type === 'select' && typeof value === 'string' && definition.options?.some(option => option.value === value)) next = value;
    else if (definition.type === 'string' && typeof value === 'string' && value.length <= 512) next = value;
    else if (definition.type === 'vector') next = vector(value, definition);
    else throw new Error(`${definition.label}不接受当前数据类型。`);
    const error = definition.validate?.(next); if (error) throw new Error(error);
    component.configuration.parameters[key] = next; return;
  }
  throw new Error(`不允许映射 ${target}。`);
}

function applyDataset(component: PoiEffectComponent, result: EffectDataResult, binding: EffectDataBinding, issues: string[]): void {
  const config = binding.dataset, rows = field(result, config.rowsPath);
  if (!Array.isArray(rows)) { issues.push(`数据集路径 ${config.rowsPath || '$'} 不是数组。`); return; }
  const unitScale = config.unitScale ?? 1;
  if (!Number.isFinite(unitScale) || unitScale < .000001 || unitScale > 1000000) { issues.push('数据集坐标倍率必须为 0.000001～1000000 的有限数值。'); return; }
  if (!config.idPath) { issues.push('数据集必须配置稳定记录 ID，避免数据重排时错配位置。'); return; }
  if (rows.length > 64) issues.push(`数据集有 ${rows.length} 条，仅允许最多 64 条记录。`);
  const regions = component.configuration?.parameters.regions;
  const regionGeometry = component.effectKind === 'region-level' && Array.isArray(regions) && regions.length > 0 ? regions : null;
  const seen = new Set<string>();
  const values: { id: string; position: { x: number; y: number; z: number } | null; value: number; label?: string }[] = [];
  for (const [index, row] of rows.slice(0, 64).entries()) {
    const rawId = readEffectField(row, config.idPath);
    const id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : '';
    if (!id || id.length > 128) { issues.push(`数据集第 ${index + 1} 条记录 ID 无效。`); continue; }
    if (seen.has(id)) { issues.push(`数据集记录 ID ${id} 重复。`); continue; }
    seen.add(id);
    const value = readEffectNumber(readEffectField(row, config.valuePath));
    if (value === null || Math.abs(value) > 1000000) { issues.push(`数据集记录 ${id} 的数值缺失、无效或超过允许范围。`); continue; }
    let position: { x: number; y: number; z: number } | null = null;
    // 已绘制的区域按主键取指标即可，几何继续由场景中的原多边形提供。
    if (!regionGeometry) {
      const x = readEffectNumber(readEffectField(row, config.xPath)), y = readEffectNumber(readEffectField(row, config.yPath)), z = readEffectNumber(readEffectField(row, config.zPath));
      if (x === null || y === null || z === null || Math.max(Math.abs(x * unitScale), Math.abs(y * unitScale), Math.abs(z * unitScale)) > 1000000) {
        issues.push(`数据集记录 ${id} 的坐标缺失、无效或超过允许范围。`); continue;
      }
      position = { x: x * unitScale, y: y * unitScale, z: z * unitScale };
    }
    const label = config.labelPath ? readEffectField(row, config.labelPath) : undefined;
    values.push({ id, position, value, ...(label === null || label === undefined ? {} : { label: String(label).slice(0, 128) }) });
  }
  // 坐标、数值、标签作为完整记录共同排序，接口返回顺序改变不会串到其他位置。
  values.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // 显式区域几何通过相同 ID 更新其值，不把全局排序后的值按数组下标套到区域上。
  if (regionGeometry) {
    const byId = new Map(values.map(row => [row.id, row]));
    const regionIds = new Set(regionGeometry.map(region => String(region.id ?? '')));
    for (const row of values) if (!regionIds.has(row.id)) issues.push(`数据集记录 ${row.id} 没有匹配的区域多边形。`);
    component.configuration!.parameters.regions = regionGeometry.map(region => {
      const row = byId.get(String(region.id ?? ''));
      return row ? { ...region, value: row.value, ...(row.label !== undefined ? { name: row.label.slice(0, 80) } : {}) } : region;
    });
    return;
  }
  const visual = component.visual ?? createDefaultDigitalTwinEffectConfig(component.effectKind);
  component.visual = { ...visual, points: values.map(row => row.position!), values: values.map(row => row.value), labels: values.map(row => row.label ?? row.id) };
}

export type EffectTriggerState = { key: string; signature: string; pending: boolean | null; since: number; active: boolean };
export function createEffectTriggerState(): EffectTriggerState { return { key: '', signature: '', pending: null, since: 0, active: false }; }
/** 调用方为每个特效持有状态；只返回计算结果，不写场景 Store。 */
export function evaluateEffectTrigger(binding: EffectDataBinding, result: EffectDataResult, state: EffectTriggerState, now = Date.now()): { active: boolean; state: EffectTriggerState; issue?: string } {
  const trigger = binding.trigger;
  if (!trigger.enabled) return { active: true, state: createEffectTriggerState() };
  const signature = JSON.stringify(trigger);
  const previous = state.key === result.key && state.signature === signature ? state : createEffectTriggerState();
  if (result.status !== 'online') return { active: false, state: { ...createEffectTriggerState(), key: result.key, signature }, issue: '触发条件等待有效数据。' };
  const value = field(result, trigger.field);
  if (value === undefined || value === null || typeof value === 'object') return { active: false, state: { ...createEffectTriggerState(), key: result.key, signature }, issue: `触发字段 ${trigger.field} 缺失或无效。` };
  let matches = false;
  if (trigger.operator === 'eq') matches = String(value) === trigger.value;
  else if (trigger.operator === 'ne') matches = String(value) !== trigger.value;
  else {
    const left = readEffectNumber(value), right = readEffectNumber(trigger.value);
    if (left === null || right === null) return { active: false, state: { ...createEffectTriggerState(), key: result.key, signature }, issue: '触发比较需要有效数值。' };
    matches = trigger.operator === 'gt' ? left > right : trigger.operator === 'gte' ? left >= right : trigger.operator === 'lt' ? left < right : left <= right;
  }
  const since = previous.pending === matches ? previous.since : now;
  const active = now - since >= Math.max(0, Math.min(60000, trigger.debounceMs || 0)) ? matches : previous.active;
  return { active, state: { key: result.key, signature, pending: matches, since, active } };
}
