import type { ChartMarkerComponent, ChartMarkerThemeScreen, ModelGeneratorTarget } from './components';
import type { Entity } from './Entity';
import type { SceneDocument } from './SceneDocument';
import type { Vector3Data } from './math';
import type { DeviceTelemetrySnapshot } from '../../runtime/mqtt/deviceTelemetry';
import { createId } from '../../shared/ids';
import { CHART_MARKER_DEFAULTS, normalizeChartMarker, normalizeChartMarkerThemeScreen } from './chartMarker';
import { sanitizeModelGeneratorTarget } from './modelGenerator';

export type AlarmTarget = { id: string; model: ModelGeneratorTarget | null; entityId: string };
export type AlarmManagerComponent = {
  listenProperty: 'RUNNING STATE' | 'CUSTOM PROPERTY';
  runningState: 'offline' | 'idle' | 'running' | 'alarm';
  customProperty: string;
  customValue: string;
  overrideColor: string;
  appearanceModel: ModelGeneratorTarget | null;
  theme: ChartMarkerThemeScreen | null;
  showMarker: boolean;
  markerCategory: string;
  associationType: 'chart' | 'third-party' | 'video' | 'builtin';
  markerScreen: ChartMarkerThemeScreen | null;
  contentUrl: string;
  marker: ChartMarkerComponent;
  warehouseAlarm: boolean;
  warehouseTheme: ChartMarkerThemeScreen | null;
  focusCamera: boolean;
  targetType: 'ENTITY' | 'MODEL';
  targets: AlarmTarget[];
};

export const ALARM_MAX_TARGETS = 64;
export function createDefaultAlarmManager(): AlarmManagerComponent {
  return {
    listenProperty: 'RUNNING STATE', runningState: 'running', customProperty: 'fireAlarm', customValue: 'true',
    overrideColor: '#ff1717', appearanceModel: null, theme: null, showMarker: false,
    markerCategory: '人员', associationType: 'chart', markerScreen: null, contentUrl: '',
    marker: { ...CHART_MARKER_DEFAULTS, text: '报警', driveMode: 'none', clickEvents: [] },
    warehouseAlarm: true, warehouseTheme: null, focusCamera: true, targetType: 'ENTITY', targets: [],
  };
}

export function resizeAlarmTargets(targets: AlarmTarget[], size: number): AlarmTarget[] {
  if (!Number.isInteger(size) || size < 0 || size > ALARM_MAX_TARGETS) throw new Error('目标 Size 必须为 0–64 的整数');
  return Array.from({ length: size }, (_, index) => targets[index] ?? { id: createId('alarm_target'), model: null, entityId: '' });
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('报警管理器文本字段无效');
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('报警管理器配置必须为普通对象');
  for (const key of Reflect.ownKeys(value)) if (!('value' in Object.getOwnPropertyDescriptor(value, key)!)) throw new Error('报警管理器不允许访问器');
  return value as Record<string, unknown>;
}
function model(value: unknown): ModelGeneratorTarget | null {
  if (value === null) return null;
  const result = sanitizeModelGeneratorTarget(value);
  if (!result) throw new Error('报警管理器模型引用无效');
  return result;
}
export function normalizeAlarmContentUrl(value: unknown): string {
  const raw = text(value, 2048).trim();
  if (!raw) return '';
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('内容地址仅支持不带凭据的 HTTP(S) 地址');
  return raw;
}

/** 保存与属性修改共用校验；非法资源不能静默降为空槽。 */
export function normalizeAlarmManager(value: unknown): AlarmManagerComponent {
  const source = record(value);
  const c = { ...createDefaultAlarmManager(), ...source } as AlarmManagerComponent;
  const enums = { listenProperty: ['RUNNING STATE', 'CUSTOM PROPERTY'], runningState: ['offline', 'idle', 'running', 'alarm'], associationType: ['chart', 'third-party', 'video', 'builtin'], targetType: ['ENTITY', 'MODEL'] };
  for (const [key, values] of Object.entries(enums)) if (!values.includes(String(c[key as keyof typeof c]))) throw new Error('报警管理器选项无效: ' + key);
  for (const key of ['showMarker', 'warehouseAlarm', 'focusCamera'] as const) if (typeof c[key] !== 'boolean') throw new Error('报警管理器开关无效: ' + key);
  if (!/^#[0-9a-f]{6}$/i.test(c.overrideColor)) throw new Error('报警覆盖颜色无效');
  c.customProperty = text(c.customProperty, 256).trim();
  if (c.customProperty.split('.').some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('火警属性名无效');
  c.customValue = text(c.customValue, 256);
  c.markerCategory = text(c.markerCategory, 128);
  c.contentUrl = normalizeAlarmContentUrl(c.contentUrl);
  c.marker = normalizeChartMarker(c.marker);
  c.appearanceModel = model(c.appearanceModel);
  for (const key of ['theme', 'warehouseTheme', 'markerScreen'] as const) c[key] = c[key] === null ? null : normalizeChartMarkerThemeScreen(c[key]);
  if (!Array.isArray(c.targets) || c.targets.length > ALARM_MAX_TARGETS) throw new Error('目标数量超过 64');
  const ids = new Set<string>();
  c.targets = c.targets.map(value => {
    const slot = record(value);
    const id = text(slot.id, 128);
    if (!id || ids.has(id)) throw new Error('报警目标 ID 为空或重复');
    ids.add(id);
    return { id, model: model(slot.model), entityId: text(slot.entityId, 128) };
  });
  // 只输出公开定义字段，避免输入中的无关字段进入发布文件。
  return Object.fromEntries(Object.keys(createDefaultAlarmManager()).map(key => [key, c[key as keyof typeof c]])) as AlarmManagerComponent;
}

export function createAlarmManagerEntity(position: Vector3Data): Entity {
  return {
    id: createId('entity'), name: '报警管理器', visible: true, locked: false, parentId: null, childrenIds: [],
    components: {
      transform: { position: { ...position }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.5, y: 0.5, z: 0.5 } },
      meshRenderer: { meshKind: 'sphere', materialColor: '#ff1717' }, alarmManager: createDefaultAlarmManager(),
    },
  };
}

export function resolveAlarmTargets(scene: Pick<SceneDocument, 'entityIds' | 'entities'>, c: AlarmManagerComponent): Entity[] {
  const explicitIds = new Set(c.targetType === 'ENTITY' ? c.targets.map(t => t.entityId).filter(Boolean) : []);
  const urls = new Set(c.targets.filter(t => c.targetType === 'MODEL' || !t.entityId).flatMap(t => t.model?.kind === 'model' ? [t.model.modelAsset.sourceUrl] : []));
  return scene.entityIds.flatMap(id => {
    const entity = scene.entities[id];
    return entity?.components.modelAsset && (explicitIds.has(id) || urls.has(entity.components.modelAsset.sourceUrl)) ? [entity] : [];
  });
}

/** 仅监控设备及其已有批次伙伴独立渲染，防止覆盖共享材质时污染正常实例。 */
export function collectAlarmIndependentEntityIds(scene: Pick<SceneDocument, 'entityIds' | 'entities'>): Set<string> {
  const ids = new Set<string>();
  for (const id of scene.entityIds) {
    const c = scene.entities[id]?.components.alarmManager;
    if (c) for (const target of resolveAlarmTargets(scene, c)) ids.add(target.id);
  }
  const sources = new Set([...ids].map(id => scene.entities[id]?.components.modelArrayInstance?.sourceEntityId ?? id));
  for (const id of scene.entityIds) {
    if (sources.has(id) || sources.has(scene.entities[id]?.components.modelArrayInstance?.sourceEntityId ?? '')) ids.add(id);
  }
  return ids;
}

function field(fields: Record<string, unknown>, name: string): unknown {
  let value: unknown = fields;
  for (const key of Object.hasOwn(fields, name) ? [name] : name.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? String(value).trim().toLowerCase() : null;
}

export type AlarmTriggerKind = 'device' | 'fire' | 'warehouse';
export function resolveAlarmTrigger(c: AlarmManagerComponent, entity: Entity, snapshot: DeviceTelemetrySnapshot | null, now: number): AlarmTriggerKind | null {
  const binding = entity.components.telemetryBinding;
  if (binding?.enabled === false || !snapshot) return null;
  const stale = now - snapshot.receivedAt > (binding?.staleAfterMs ?? 10000);
  const actual = c.customProperty ? scalar(field(snapshot.fields, c.customProperty)) : null;
  const expected = scalar(c.customValue);
  const customMatch = expected === 'true' ? actual === 'true' || actual === '1'
    : expected === 'false' ? actual === 'false' || actual === '0' : actual !== null && actual === expected;
  const warehouse = scalar(snapshot.fields.warehouseAlarm);
  if (!stale && c.warehouseAlarm && (warehouse === 'true' || warehouse === '1' || customMatch)) return 'warehouse';
  if (c.listenProperty === 'CUSTOM PROPERTY') {
    return !stale && customMatch ? 'fire' : null;
  }
  const raw = scalar(snapshot.fields.runningState ?? snapshot.fields.running_state ?? snapshot.fields.state ?? snapshot.fields.status);
  const aliases: Record<string, string> = { '0': 'offline', '1': 'idle', '2': 'running', '3': 'alarm', '离线': 'offline', '空闲': 'idle', '运行': 'running', '报警': 'alarm', 'warning': 'alarm', 'fault': 'alarm' };
  const state = stale ? 'offline' : snapshot.faulted ? 'alarm' : raw === null ? null : aliases[raw] ?? raw;
  return state === c.runningState ? 'device' : null;
}

export function isAlarmTriggered(c: AlarmManagerComponent, entity: Entity, snapshot: DeviceTelemetrySnapshot | null, now: number): boolean {
  return resolveAlarmTrigger(c, entity, snapshot, now) !== null;
}
