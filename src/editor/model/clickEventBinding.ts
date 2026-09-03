import type { ClickEventBindingComponent, ClickEventBindingDeviceSlot, ClickEventBindingDeviceType, ClickEventBindingEffect, ClickEventBindingEvent, ClickEventBindingEventType } from './components';
import { normalizeDataPlatformScreenUrl } from './dataPlatformScreen';
import type { SceneDocument } from './SceneDocument';
import { createId } from '../../shared/ids';

/** 点击事件绑定从项目资源库读取的最小资产快照，避免领域模型反向依赖带图片资源的 UI 资产模块。 */
type ClickEventBindingSourceAsset = {
  id: string;
  name: string;
  path: string;
  sourceUrl: string;
  kind: string;
  libraryKind?: 'model' | 'environment';
  assetRevision?: string;
  thumbnailUrl?: string;
  displayName?: string;
};

/** 单个绑定允许配置的最大设备类型数。 */
export const CLICK_EVENT_BINDING_MAX_DEVICE_TYPES = 64;

/** 单个绑定允许配置的最大事件数。 */
export const CLICK_EVENT_BINDING_MAX_EVENTS = 16;

/** 绑定触发的聚焦动画时长（毫秒），比相机默认 200ms 更有推进感。 */
export const CLICK_EVENT_FOCUS_DURATION_MS = 600;

/** 点击事件聚焦距离倍率：恰好容纳目标的基础上再退远约一格，避免相机贴脸。 */
export const CLICK_EVENT_FOCUS_RADIUS_SCALE = 1.4;

const AUTHORIZED_CLICK_EVENT_ASSET_URL_PREFIX = 'editor-asset://local/';
const CLICK_EVENT_BINDING_TEXT_MAX_LENGTH = 256;
const CLICK_EVENT_BINDING_ID_MAX_LENGTH = 128;

const CLICK_EVENT_BINDING_EVENT_TYPES: readonly ClickEventBindingEventType[] = ['click', 'click-cell'];
const CLICK_EVENT_BINDING_EFFECTS: readonly ClickEventBindingEffect[] = ['highlight', 'focus', 'show-chart'];

/** 判断值是否为普通 JSON 对象，避免带原型对象进入场景状态。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** 清理字符串字段，非字符串回退为空字符串。 */
function sanitizeText(value: unknown, maxLength = CLICK_EVENT_BINDING_TEXT_MAX_LENGTH): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** 深拷贝可序列化 JSON 值，用于阻断 UI 与场景文档之间的可变引用。 */
function cloneJsonValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

/** 创建一条事件配置，默认点击 + 高亮。 */
export function createClickEventBindingEvent(): ClickEventBindingEvent {
  return {
    id: createId('click_event'),
    eventType: 'click',
    effects: ['highlight'],
  };
}

/** 创建一份空点击事件绑定组件，默认带一条 点击 + 高亮/聚焦 事件。 */
export function createDefaultClickEventBindingComponent(): ClickEventBindingComponent {
  return {
    deviceSlots: [],
    events: [{ ...createClickEventBindingEvent(), effects: ['highlight', 'focus'] }],
  };
}

/** 从导入模型资产创建设备类型条目；内置基础网格没有模型包来源，不接受。 */
export function createClickEventBindingDeviceTypeFromAsset(
  asset: ClickEventBindingSourceAsset,
): ClickEventBindingDeviceType | null {
  if (asset.kind !== 'model' || asset.libraryKind !== 'model') return null;
  if (!asset.sourceUrl.startsWith(AUTHORIZED_CLICK_EVENT_ASSET_URL_PREFIX)) return null;
  const thumbnailUrl = asset.thumbnailUrl?.startsWith(AUTHORIZED_CLICK_EVENT_ASSET_URL_PREFIX)
    ? asset.thumbnailUrl
    : undefined;

  return {
    id: createId('click_event_device'),
    assetId: asset.id,
    displayName: asset.displayName?.trim() || asset.name.trim() || '导入模型',
    sourcePath: asset.path,
    sourceUrl: asset.sourceUrl,
    ...(asset.assetRevision ? { assetRevision: asset.assetRevision } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

/** 清理单个设备类型条目；缺失匹配主键 sourceUrl 的条目会被过滤。 */
function sanitizeClickEventBindingDeviceType(value: unknown): ClickEventBindingDeviceType | null {
  if (!isPlainObject(value)) return null;
  const assetId = sanitizeText(value.assetId, CLICK_EVENT_BINDING_ID_MAX_LENGTH);
  const sourcePath = sanitizeText(value.sourcePath, 1024);
  const sourceUrl = sanitizeText(value.sourceUrl, 1024);
  if (!assetId || !sourcePath || !sourceUrl || !sourceUrl.startsWith(AUTHORIZED_CLICK_EVENT_ASSET_URL_PREFIX)) {
    return null;
  }

  const id = sanitizeText(value.id, CLICK_EVENT_BINDING_ID_MAX_LENGTH) || createId('click_event_device');
  const thumbnailUrl = sanitizeText(value.thumbnailUrl, 1024);
  const assetRevision = sanitizeText(value.assetRevision, 128);

  return {
    id,
    assetId,
    displayName: sanitizeText(value.displayName) || '导入模型',
    sourcePath,
    sourceUrl,
    ...(assetRevision ? { assetRevision } : {}),
    ...(thumbnailUrl && thumbnailUrl.startsWith(AUTHORIZED_CLICK_EVENT_ASSET_URL_PREFIX) ? { thumbnailUrl } : {}),
  };
}

/** 清理单个设备类型槽位；deviceType 为 null 的空槽合法保留，非法条目降级为空槽。 */
function sanitizeClickEventBindingDeviceSlot(value: unknown): ClickEventBindingDeviceSlot | null {
  if (!isPlainObject(value)) return null;
  const id = sanitizeText(value.id, CLICK_EVENT_BINDING_ID_MAX_LENGTH) || createId('click_event_slot');
  if (value.deviceType === null || value.deviceType === undefined) {
    return { id, deviceType: null };
  }
  return { id, deviceType: sanitizeClickEventBindingDeviceType(value.deviceType) };
}

/** 清理单条事件配置；非法事件类型回退 click，效果数组限枚举且去重。chart 仅在含 show-chart 效果时保留。 */
function sanitizeClickEventBindingEvent(value: unknown): ClickEventBindingEvent | null {
  if (!isPlainObject(value)) return null;
  const eventType = CLICK_EVENT_BINDING_EVENT_TYPES.includes(value.eventType as ClickEventBindingEventType)
    ? value.eventType as ClickEventBindingEventType
    : 'click';
  const effects = Array.isArray(value.effects)
    ? CLICK_EVENT_BINDING_EFFECTS.filter((effect) => (value.effects as unknown[]).includes(effect))
    : [];
  let chart: ClickEventBindingEvent['chart'];
  if (effects.includes('show-chart') && isPlainObject(value.chart)) {
    const chartId = sanitizeText(value.chart.id, CLICK_EVENT_BINDING_ID_MAX_LENGTH);
    if (chartId) {
      const thumbnailUrl = normalizeDataPlatformScreenUrl(value.chart.thumbnailUrl);
      chart = {
        id: chartId,
        name: sanitizeText(value.chart.name) || '数据中台大屏',
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
      };
    }
  }
  return {
    id: sanitizeText(value.id, CLICK_EVENT_BINDING_ID_MAX_LENGTH) || createId('click_event'),
    eventType,
    effects,
    ...(chart ? { chart } : {}),
  };
}

/**
 * 清理点击事件绑定组件，非法槽位与事件会被过滤。
 * 兼容旧版单事件格式：无 events 但存在顶层 eventType/effects 时迁移为单条事件。
 */
export function sanitizeClickEventBindingComponent(value: unknown): ClickEventBindingComponent {
  if (!isPlainObject(value)) return createDefaultClickEventBindingComponent();

  const deviceSlots = Array.isArray(value.deviceSlots)
    ? value.deviceSlots
        .slice(0, CLICK_EVENT_BINDING_MAX_DEVICE_TYPES)
        .map(sanitizeClickEventBindingDeviceSlot)
        .filter((item): item is ClickEventBindingDeviceSlot => item !== null)
    : [];

  let events: ClickEventBindingEvent[];
  if (Array.isArray(value.events)) {
    events = value.events
      .slice(0, CLICK_EVENT_BINDING_MAX_EVENTS)
      .map(sanitizeClickEventBindingEvent)
      .filter((item): item is ClickEventBindingEvent => item !== null);
  } else if (value.eventType !== undefined || value.effects !== undefined) {
    events = [sanitizeClickEventBindingEvent(value)].filter((item): item is ClickEventBindingEvent => item !== null);
  } else {
    events = [];
  }

  return { deviceSlots, events };
}

/** 深拷贝点击事件绑定组件，避免设备类型数组被外部直接修改。 */
export function cloneClickEventBindingComponent(component: ClickEventBindingComponent): ClickEventBindingComponent {
  return cloneJsonValue(component);
}

/**
 * 运行态查找命中的点击事件绑定：按模型包 sourceUrl 匹配被点击实体，
 * 多个绑定覆盖同一设备类型时按场景实体顺序取第一个。
 */
export function findClickEventBindingForEntity(
  scene: SceneDocument,
  entityId: string,
): { bindingEntityId: string; component: ClickEventBindingComponent } | null {
  const sourceUrl = scene.entities[entityId]?.components.modelAsset?.sourceUrl;
  if (!sourceUrl) return null;

  for (const entity of Object.values(scene.entities)) {
    const component = entity.components.clickEventBinding;
    if (!component) continue;
    if (component.deviceSlots.some((slot) => slot.deviceType?.sourceUrl === sourceUrl)) {
      return { bindingEntityId: entity.id, component };
    }
  }
  return null;
}

/** 命中货格反解结果：locatorEntityId 为内置货格（虚拟定位线框）实体，坐标为业务 排-列-层。 */
export type ClickEventBindingPickedCell = {
  locatorEntityId: string;
  row: number;
  column: number;
  layer: number;
};

/** 运行/发布态点击决策：场景存在已注册设备类型的绑定时点击行为全接管。chartId 为命中事件中 show-chart 效果的图表参数。 */
export type ClickEventBindingClickResolution =
  | { kind: 'pass-through' }
  | { kind: 'clear' }
  | { kind: 'ignore' }
  | { kind: 'trigger'; entityId: string; effects: ClickEventBindingEffect[]; chartId?: string }
  | {
    kind: 'trigger-cell';
    entityId: string;
    locatorEntityId: string;
    cell: { row: number; column: number; layer: number };
    effects: ClickEventBindingEffect[];
    chartId?: string;
  };

/**
 * 只有货架类宿主的内置货格才算可点击单元：其绑定声明了列+层维度映射（多格货位）；
 * conveyor 类模型的站台（如 enablePlatform）也是内置绑定但只有单一台面，不算单元。
 */
function isShelfCellLocator(scene: SceneDocument, locatorEntityId: string): boolean {
  const hostEntityId = scene.entities[locatorEntityId]?.components.locator?.builtInBinding?.hostEntityId;
  if (!hostEntityId) return false;
  const config = scene.entities[hostEntityId]?.components.modelAsset?.builtInSlotBindingConfig;
  return Boolean(config?.dimensionMapping.columns && config.dimensionMapping.layers);
}

/**
 * 判定一次运行/发布态点击的行为：
 * 场景无有效注册（无绑定或全部空槽）→ pass-through 走默认点击；
 * 接管中点空白 → clear 清除高亮；点未注册模型 → ignore 无任何效果；
 * 命中注册设备时点击单元优先：配了 click-cell 且反解到货架类货格 → trigger-cell 按事件效果执行；
 * 否则配了 click → trigger 按事件效果执行；两者都没配 → ignore。
 */
export function resolveClickEventBindingClick(
  scene: SceneDocument,
  pickedEntityId: string | null,
  pickedCell?: ClickEventBindingPickedCell | null,
): ClickEventBindingClickResolution {
  const takeoverActive = Object.values(scene.entities).some((entity) => (
    entity.components.clickEventBinding?.deviceSlots.some((slot) => slot.deviceType !== null) ?? false
  ));
  if (!takeoverActive) return { kind: 'pass-through' };
  if (!pickedEntityId) return { kind: 'clear' };

  const hit = findClickEventBindingForEntity(scene, pickedEntityId);
  if (!hit) return { kind: 'ignore' };

  const cellEvent = hit.component.events.find((event) => event.eventType === 'click-cell');
  if (cellEvent && pickedCell && isShelfCellLocator(scene, pickedCell.locatorEntityId)) {
    return {
      kind: 'trigger-cell',
      entityId: pickedEntityId,
      locatorEntityId: pickedCell.locatorEntityId,
      cell: { row: pickedCell.row, column: pickedCell.column, layer: pickedCell.layer },
      effects: cellEvent.effects,
      ...(cellEvent.chart ? { chartId: cellEvent.chart.id } : {}),
    };
  }

  const matchedEvent = hit.component.events.find((event) => event.eventType === 'click');
  if (!matchedEvent) return { kind: 'ignore' };
  return {
    kind: 'trigger',
    entityId: pickedEntityId,
    effects: matchedEvent.effects,
    ...(matchedEvent.chart ? { chartId: matchedEvent.chart.id } : {}),
  };
}

/** 命中后需通知宿主页面的点击事件载荷：模型资产编号、货格库位（点击单元时的 排-列-层）与 show-chart 图表id。 */
export type ClickEventAssetClickedPayload = {
  assetCode?: string;
  slot?: { row: number; column: number; layer: number };
  chartId?: string;
};

/**
 * 由点击决策构造发送给宿主页面的 show-chart 事件载荷；
 * 仅在 trigger/trigger-cell 且效果含 show-chart 时返回载荷，其余情况返回 null。
 */
export function buildClickEventAssetClickedPayload(
  scene: SceneDocument,
  resolution: ClickEventBindingClickResolution,
): ClickEventAssetClickedPayload | null {
  if (resolution.kind !== 'trigger' && resolution.kind !== 'trigger-cell') return null;
  if (!resolution.effects.includes('show-chart')) return null;
  const assetCode = scene.entities[resolution.entityId]?.components.modelAsset?.assetCode?.trim();
  return {
    ...(assetCode ? { assetCode } : {}),
    ...(resolution.kind === 'trigger-cell' ? { slot: { ...resolution.cell } } : {}),
    ...(resolution.chartId ? { chartId: resolution.chartId } : {}),
  };
}
