import type { ChartMarkerComponent, ChartMarkerThemeScreen, ModelAssetTemplate, ModelGeneratorTarget, PoiEffectComponent, PoiEffectKind } from './components';
import type { Entity } from './Entity';
import type { SceneDocument } from './SceneDocument';
import type { Vector3Data } from './math';
import { DEFAULT_TELEMETRY_SOURCE_ID, type DeviceTelemetrySnapshot } from '../../runtime/mqtt/deviceTelemetry';
import { createId } from '../../shared/ids';
import { CHART_MARKER_DEFAULTS, normalizeChartMarker, normalizeChartMarkerThemeScreen } from './chartMarker';
import { sanitizeModelGeneratorTarget } from './modelGenerator';
import { isPoiEffectKind, sanitizePoiEffectComponent } from './poiEffect';
import { matchesModelTypeReference, modelTypePathKey } from '../../../electron/shared/modelTypeIdentity';
import { getClickEventModelResourceKey } from '../../../electron/shared/clickEventModelIdentity';

export type AlarmTarget = { id: string; model: ModelGeneratorTarget | null; entityId: string };
export type AlarmManagerComponent = {
  listenProperty: 'RUNNING STATE' | 'CUSTOM PROPERTY';
  runningState: 'offline' | 'idle' | 'running' | 'alarm';
  customProperty: string;
  customValue: string;
  overrideColor: string;
  overrideColorEnabled: boolean;
  /** 兼容旧场景；新配置从特效库选择 appearanceEffect。 */
  appearanceModel: ModelGeneratorTarget | null;
  appearanceEffect: PoiEffectComponent | null;
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

/** 场景雾、昼夜和镜头跟随不能作为设备局部外观。 */
export function isAlarmAppearanceEffectKind(value: unknown): value is PoiEffectKind {
  return isPoiEffectKind(value) && !['environment-fog', 'day-night', 'target-follow'].includes(value);
}

export const ALARM_MAX_TARGETS = 64;
export function createDefaultAlarmManager(): AlarmManagerComponent {
  return {
    listenProperty: 'RUNNING STATE', runningState: 'running', customProperty: 'fireAlarm', customValue: 'true',
    overrideColor: '#ff1717', overrideColorEnabled: true, appearanceModel: null, appearanceEffect: null, theme: null, showMarker: false,
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
  for (const key of ['showMarker', 'warehouseAlarm', 'focusCamera', 'overrideColorEnabled'] as const) if (typeof c[key] !== 'boolean') throw new Error('报警管理器开关无效: ' + key);
  if (!/^#[0-9a-f]{6}$/i.test(c.overrideColor)) throw new Error('报警覆盖颜色无效');
  c.customProperty = text(c.customProperty, 256).trim();
  if (c.customProperty.split('.').some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('火警属性名无效');
  c.customValue = text(c.customValue, 256);
  c.markerCategory = text(c.markerCategory, 128);
  c.contentUrl = normalizeAlarmContentUrl(c.contentUrl);
  c.marker = normalizeChartMarker(c.marker);
  if (c.appearanceEffect !== null) {
    const effect = record(c.appearanceEffect);
    if (!isAlarmAppearanceEffectKind(effect.effectKind)) throw new Error('请选择可依附设备的 EFF 特效');
    c.appearanceEffect = sanitizePoiEffectComponent(effect as unknown as PoiEffectComponent);
    // 实际目标由报警绑定决定，不能将库预设中的其它实体引用带入报警外观。
    if (c.appearanceEffect.visual) c.appearanceEffect.visual.targetEntityId = null;
  }
  c.appearanceModel = c.appearanceEffect ? null : model(c.appearanceModel);
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

type AlarmModelSource = Pick<ModelAssetTemplate, 'sourcePath' | 'sourceUrl' | 'dataPlatformModel'>;

/** 普通库旧条目可能没有身份；固定版本缓存目录仍记录了真实来源，不能跨来源兜底。 */
function alarmModelSourceKey(asset: AlarmModelSource): string | undefined {
  if (asset.dataPlatformModel) return asset.dataPlatformModel.sourceKey;
  for (const path of [asset.sourcePath, asset.sourceUrl]) {
    const source = /(?:^|\/)\.babylon-editor\/scene-model-versions\/([a-f0-9]{64})\/[a-f0-9]{64}\//.exec(modelTypePathKey(path))?.[1];
    if (source) return source;
  }
  return undefined;
}

function alarmModelResourceKey(asset: AlarmModelSource): string | null {
  const identity = asset.dataPlatformModel;
  return identity ? `${identity.kind}:${identity.resourceId}:${modelTypePathKey(identity.modelPath)}`
    : getClickEventModelResourceKey(asset.sourceUrl);
}

function matchesAlarmModelPath(asset: AlarmModelSource, reference: AlarmModelSource): boolean {
  return matchesModelTypeReference(asset, { sourcePath: reference.sourcePath, sourceUrl: reference.sourceUrl });
}

/** 模型库与场景快照路径不同也可匹配；完整身份优先，旧条目兼容资源类别、ID和包内路径。 */
export function matchesAlarmTargetModel(entity: Entity, target: ModelGeneratorTarget | null): boolean {
  const asset = entity.components.modelAsset;
  if (!asset || target?.kind !== 'model') return false;
  const reference = target.modelAsset;
  const sourceKey = alarmModelSourceKey(asset), targetSourceKey = alarmModelSourceKey(reference);
  if (sourceKey && targetSourceKey && sourceKey !== targetSourceKey) return false;
  if (asset.dataPlatformModel && reference.dataPlatformModel) {
    return matchesModelTypeReference(asset, { identity: reference.dataPlatformModel });
  }
  if (matchesAlarmModelPath(asset, reference)) return true;
  const resourceKey = alarmModelResourceKey(asset);
  return resourceKey !== null && resourceKey === alarmModelResourceKey(reference);
}

export function resolveAlarmTargets(scene: Pick<SceneDocument, 'entityIds' | 'entities'>, c: AlarmManagerComponent): Entity[] {
  const ids = new Set(c.targetType === 'ENTITY' ? c.targets.map(t => t.entityId).filter(Boolean) : []);
  const entities = scene.entityIds.flatMap(id => scene.entities[id]?.components.modelAsset ? [scene.entities[id]] : []);
  for (const slot of c.targets) {
    if ((c.targetType === 'ENTITY' && slot.entityId) || slot.model?.kind !== 'model') continue;
    const model = slot.model;
    let candidates = entities.filter(entity => matchesAlarmTargetModel(entity, model));
    if (!alarmModelSourceKey(model.modelAsset)) {
      const sources = new Set(candidates.map(entity => alarmModelSourceKey(entity.components.modelAsset!)).filter(Boolean));
      if (sources.size > 1) {
        // 来源缺失且同一资源出现在多个来源时，只保留有精确路径证据的设备；用户也可明确选择单台实体。
        candidates = candidates.filter(entity => matchesAlarmModelPath(entity.components.modelAsset!, model.modelAsset));
        if (new Set(candidates.map(entity => alarmModelSourceKey(entity.components.modelAsset!)).filter(Boolean)).size > 1) candidates = [];
      }
    }
    for (const entity of candidates) ids.add(entity.id);
  }
  return entities.filter(entity => ids.has(entity.id));
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

/** 面板与报警运行时共用设备身份，避免诊断读到其它实例或数据源。 */
export function resolveAlarmDeviceBinding(entity: Entity): { assetCode: string; deviceType: string; sourceId: string } {
  const binding = entity.components.telemetryBinding;
  const asset = entity.components.modelAsset;
  return {
    assetCode: binding?.assetCode || asset?.assetCode || '',
    deviceType: binding?.deviceType || asset?.dataDrivenConfig?.device.devType || '',
    sourceId: binding?.sourceId || DEFAULT_TELEMETRY_SOURCE_ID,
  };
}

export function readAlarmProperty(fields: Record<string, unknown>, name: string): unknown {
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

/** 保留旧场景的单向布尔兼容：true/false 接受 1/0，反向不扩大匹配。 */
function matchesCustomValue(value: unknown, expectedValue: string): boolean {
  const actual = scalar(value);
  const expected = scalar(expectedValue);
  return expected === 'true' ? actual === 'true' || actual === '1'
    : expected === 'false' ? actual === 'false' || actual === '0' : actual !== null && actual === expected;
}

export type AlarmCustomPropertyStatus = 'disabled' | 'unbound' | 'unconfigured' | 'waiting' | 'stale' | 'missing' | 'invalid' | 'matched' | 'unmatched';

/** 自定义点位以最后一次值判断，收到新值前不因时间流逝解除报警。 */
export function getAlarmCustomPropertyDiagnostic(c: AlarmManagerComponent, entity: Entity, snapshot: DeviceTelemetrySnapshot | null, now: number): {
  status: AlarmCustomPropertyStatus; value: unknown; trigger: AlarmTriggerKind | null;
} {
  const binding = resolveAlarmDeviceBinding(entity);
  const value = snapshot && c.customProperty ? readAlarmProperty(snapshot.fields, c.customProperty) : undefined;
  const status: AlarmCustomPropertyStatus = entity.components.telemetryBinding?.enabled === false ? 'disabled'
    : !binding.assetCode || !binding.deviceType ? 'unbound'
    : !c.customProperty ? 'unconfigured'
    : !snapshot ? 'waiting'
    : c.listenProperty !== 'CUSTOM PROPERTY' && now - snapshot.receivedAt > (entity.components.telemetryBinding?.staleAfterMs ?? 10000) ? 'stale'
    : value === undefined ? 'missing'
    : scalar(value) === null ? 'invalid'
    : matchesCustomValue(value, c.customValue) ? 'matched' : 'unmatched';
  return { status, value, trigger: status === 'unbound' ? null : resolveAlarmTrigger(c, entity, snapshot, now) };
}

export type AlarmTriggerKind = 'device' | 'fire' | 'warehouse';
export function resolveAlarmTrigger(c: AlarmManagerComponent, entity: Entity, snapshot: DeviceTelemetrySnapshot | null, now: number): AlarmTriggerKind | null {
  const binding = entity.components.telemetryBinding;
  if (binding?.enabled === false || !snapshot) return null;
  const stale = now - snapshot.receivedAt > (binding?.staleAfterMs ?? 10000);
  const customMatch = matchesCustomValue(c.customProperty ? readAlarmProperty(snapshot.fields, c.customProperty) : undefined, c.customValue);
  const warehouse = scalar(snapshot.fields.warehouseAlarm);
  if ((!stale || c.listenProperty === 'CUSTOM PROPERTY') && c.warehouseAlarm && (warehouse === 'true' || warehouse === '1' || customMatch)) return 'warehouse';
  if (c.listenProperty === 'CUSTOM PROPERTY') {
    return customMatch ? 'fire' : null;
  }
  const raw = scalar(snapshot.fields.runningState ?? snapshot.fields.running_state ?? snapshot.fields.state ?? snapshot.fields.status);
  const aliases: Record<string, string> = { '0': 'offline', '1': 'idle', '2': 'running', '3': 'alarm', '离线': 'offline', '空闲': 'idle', '运行': 'running', '报警': 'alarm', 'warning': 'alarm', 'fault': 'alarm' };
  const state = stale ? 'offline' : snapshot.faulted ? 'alarm' : raw === null ? null : aliases[raw] ?? raw;
  return state === c.runningState ? 'device' : null;
}

export function isAlarmTriggered(c: AlarmManagerComponent, entity: Entity, snapshot: DeviceTelemetrySnapshot | null, now: number): boolean {
  return resolveAlarmTrigger(c, entity, snapshot, now) !== null;
}
