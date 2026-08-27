import type { ClickEventBindingComponent, ClickEventBindingDeviceSlot, ClickEventBindingDeviceType, ClickEventBindingEffect, ClickEventBindingEventType } from './components';
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

const AUTHORIZED_CLICK_EVENT_ASSET_URL_PREFIX = 'editor-asset://local/';
const CLICK_EVENT_BINDING_TEXT_MAX_LENGTH = 256;
const CLICK_EVENT_BINDING_ID_MAX_LENGTH = 128;

const CLICK_EVENT_BINDING_EVENT_TYPES: readonly ClickEventBindingEventType[] = ['click', 'click-cell'];
const CLICK_EVENT_BINDING_EFFECTS: readonly ClickEventBindingEffect[] = ['highlight', 'focus'];

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

/** 创建一份空点击事件绑定组件，默认事件为点击、效果为高亮加聚焦。 */
export function createDefaultClickEventBindingComponent(): ClickEventBindingComponent {
  return {
    deviceSlots: [],
    eventType: 'click',
    effects: ['highlight', 'focus'],
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

/** 清理点击事件绑定组件，非法槽位与枚举值会被过滤并回退默认。 */
export function sanitizeClickEventBindingComponent(value: unknown): ClickEventBindingComponent {
  if (!isPlainObject(value)) return createDefaultClickEventBindingComponent();

  const deviceSlots = Array.isArray(value.deviceSlots)
    ? value.deviceSlots
        .slice(0, CLICK_EVENT_BINDING_MAX_DEVICE_TYPES)
        .map(sanitizeClickEventBindingDeviceSlot)
        .filter((item): item is ClickEventBindingDeviceSlot => item !== null)
    : [];

  const eventType = CLICK_EVENT_BINDING_EVENT_TYPES.includes(value.eventType as ClickEventBindingEventType)
    ? value.eventType as ClickEventBindingEventType
    : 'click';

  const effects = Array.isArray(value.effects)
    ? CLICK_EVENT_BINDING_EFFECTS.filter((effect) => (value.effects as unknown[]).includes(effect))
    : [];

  return { deviceSlots, eventType, effects };
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
