import { Quaternion } from '@babylonjs/core/Maths/math.vector';
import type { Entity } from './Entity';
import type { ChartMarkerClickAction, ChartMarkerClickEvent, ChartMarkerComponent, ChartMarkerThemeScreen, TransformComponent } from './components';
import type { Vector3Data } from './math';
import { createId } from '../../shared/ids';
import { DATA_PLATFORM_SCREEN_DEFAULT_HEIGHT_METERS, DATA_PLATFORM_SCREEN_DEFAULT_WIDTH_METERS } from './dataPlatformScreen';

export const CHART_MARKER_MAX_IMAGE_LENGTH = 3 * 1024 * 1024;

/** 新建立标使用无色背景；旧场景的缺省行为由 resolveChartMarker 单独维护。 */
export const CHART_MARKER_DEFAULTS: Readonly<Required<ChartMarkerComponent>> = Object.freeze({
  geometryBasis: 'upright',
  screenName: '',
  contentType: 'builtin',
  text: '图表立标',
  fontSize: 36,
  marquee: false,
  backgroundImage: '',
  backgroundColor: 'transparent',
  appearance: 'line',
  indicatorSize: 1,
  appearanceColor: '#00cbe6',
  width: 320,
  height: 180,
  floatHeight: 1,
  faceCamera: true,
  driveMode: 'data',
  dataSourceEntityId: '',
  dataField: '',
  clickAction: 'none',
  clickEvents: [],
});

const LEGACY_CHART_MARKER_DEFAULTS: Required<ChartMarkerComponent> = {
  ...CHART_MARKER_DEFAULTS,
  geometryBasis: 'ground',
  contentType: 'screen',
  backgroundColor: '#101827',
  appearanceColor: '#58b9dc',
  appearance: 'none',
  floatHeight: 0,
  faceCamera: false,
};

/** 解析已校验的组件；不把默认值写回旧场景，避免改变旧大屏的朝向和高度。 */
export function resolveChartMarker(component: ChartMarkerComponent): Required<ChartMarkerComponent> {
  const resolved = { ...LEGACY_CHART_MARKER_DEFAULTS };
  for (const key of Object.keys(LEGACY_CHART_MARKER_DEFAULTS) as (keyof ChartMarkerComponent)[]) {
    const value = component[key];
    if (value !== undefined) Object.assign(resolved, { [key]: value });
  }
  return resolved;
}

/** 新事件列表优先；旧版单动作仍可在编辑器和发布 Viewer 中执行。 */
export function getChartMarkerClickEvents(component: ChartMarkerComponent, entityId: string): ChartMarkerClickEvent[] {
  if (component.clickEvents?.length) return component.clickEvents;
  if (component.clickAction === 'focus') return [{ type: 'left-click', actions: [{ type: 'focus', targetEntityId: entityId }] }];
  if (component.clickAction === 'refresh') return [{ type: 'left-click', actions: [{ type: 'refresh' }] }];
  return [];
}

export const CHART_MARKER_MAX_CLICK_EVENTS = 16;
export const CHART_MARKER_MAX_CLICK_ACTIONS = 32;

function readEventObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('图表立标点击事件必须为普通对象');
  }
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) throw new Error('图表立标点击事件不允许访问器');
    if (typeof key !== 'string' || !allowedKeys.includes(key)) throw new Error('图表立标点击事件包含未知字段');
    fields[key] = descriptor.value;
  }
  return fields;
}

function readEventArray(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit) {
    throw new Error('图表立标点击事件列表无效或超过数量限制');
  }
  const entries: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) throw new Error('图表立标点击事件不允许访问器');
    if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
      throw new Error('图表立标点击事件列表包含未知字段');
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) throw new Error('图表立标点击事件列表不能包含空项');
    entries.push(descriptor.value);
  }
  return entries;
}

/** 拒绝缺少内容地址或超长的绑定，避免截断后指向另一张大屏。 */
export function normalizeChartMarkerThemeScreen(value: unknown): ChartMarkerThemeScreen {
  const source = readEventObject(value, ['projectId', 'screenId', 'name', 'screenUrl', 'thumbnailUrl']);
  const readText = (key: 'projectId' | 'screenId' | 'name'): string => {
    const field = source[key];
    if (typeof field !== 'string' || field.length > 128 || !field.trim()) {
      throw new Error('图表立标主题大屏字段无效: ' + key);
    }
    return field.trim();
  };
  const readUrl = (key: 'screenUrl' | 'thumbnailUrl'): string => {
    const field = source[key];
    if (typeof field !== 'string' || field.length > 2048 || !field.trim()) {
      throw new Error('图表立标主题大屏地址无效: ' + key);
    }
    const normalized = field.trim();
    let url: URL;
    try { url = new URL(normalized); } catch { throw new Error('图表立标主题大屏地址无效: ' + key); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('图表立标主题大屏仅支持 HTTP(S) 地址');
    return normalized;
  };
  return {
    projectId: readText('projectId'), screenId: readText('screenId'), name: readText('name'),
    screenUrl: readUrl('screenUrl'),
    ...(Object.hasOwn(source, 'thumbnailUrl') ? { thumbnailUrl: readUrl('thumbnailUrl') } : {}),
  };
}

function normalizeClickEvents(value: unknown): ChartMarkerClickEvent[] {
  return readEventArray(value, CHART_MARKER_MAX_CLICK_EVENTS).map((entry) => {
    const event = readEventObject(entry, ['type', 'actions']);
    if (event.type !== 'left-click') throw new Error('图表立标点击事件类型无效');
    const actions = readEventArray(event.actions, CHART_MARKER_MAX_CLICK_ACTIONS).map((entry): ChartMarkerClickAction => {
      const action = readEventObject(entry, ['type', 'targetEntityId', 'screen']);
      if (action.type === 'theme' && !Object.hasOwn(action, 'targetEntityId')) {
        return { type: 'theme', ...(Object.hasOwn(action, 'screen') ? { screen: normalizeChartMarkerThemeScreen(action.screen) } : {}) };
      }
      if (Object.hasOwn(action, 'screen')) throw new Error('图表立标非主题动作不能绑定大屏');
      if (action.type === 'refresh' && !Object.hasOwn(action, 'targetEntityId')) return { type: 'refresh' };
      if ((action.type === 'focus' || action.type === 'select')
        && typeof action.targetEntityId === 'string' && action.targetEntityId.length <= 128) {
        return { type: action.type, targetEntityId: action.targetEntityId };
      }
      throw new Error('图表立标点击动作或目标对象无效');
    });
    return { type: 'left-click', actions };
  });
}

const STRING_LIMITS = { screenName: 128, text: 4096, dataSourceEntityId: 128, dataField: 256 } as const;
const NUMBER_LIMITS = {
  fontSize: [8, 256], indicatorSize: [0.01, 100], width: [16, 4096], height: [16, 4096], floatHeight: [0, 10000],
} as const;
const ENUM_VALUES = {
  geometryBasis: ['ground', 'upright'],
  contentType: ['builtin', 'screen'], appearance: ['line', 'column', 'none'],
  driveMode: ['none', 'data'], clickAction: ['none', 'focus', 'refresh'],
} as const;

/** 严格校验场景或属性更新输入；保留缺省字段，返回独立组件，非法字段抛出错误。 */
export function normalizeChartMarker(value: unknown): ChartMarkerComponent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('图表立标组件必须为普通对象');
  }
  const normalized: ChartMarkerComponent = {};
  for (const key of Object.keys(LEGACY_CHART_MARKER_DEFAULTS) as (keyof ChartMarkerComponent)[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!('value' in descriptor)) throw new Error('图表立标字段不允许访问器: ' + key);
    const field = descriptor.value as unknown;
    if (field === undefined) continue;
    if (key === 'clickEvents') {
      normalized.clickEvents = normalizeClickEvents(field);
      continue;
    }
    let valid = false;
    if (key in STRING_LIMITS) {
      valid = typeof field === 'string' && field.length <= STRING_LIMITS[key as keyof typeof STRING_LIMITS];
    } else if (key in NUMBER_LIMITS) {
      const [min, max] = NUMBER_LIMITS[key as keyof typeof NUMBER_LIMITS];
      valid = typeof field === 'number' && Number.isFinite(field) && field >= min && field <= max;
    } else if (key in ENUM_VALUES) {
      valid = typeof field === 'string' && (ENUM_VALUES[key as keyof typeof ENUM_VALUES] as readonly string[]).includes(field);
    } else if (key === 'backgroundColor' || key === 'appearanceColor') {
      valid = typeof field === 'string' && (/^#[0-9a-f]{6}$/i.test(field) || (key === 'backgroundColor' && field === 'transparent'));
    } else if (key === 'backgroundImage') {
      valid = typeof field === 'string' && (field === '' || (
        field.length <= CHART_MARKER_MAX_IMAGE_LENGTH
        && /^data:image[/](png|jpeg|webp);base64,/.test(field)
        && /^[A-Za-z0-9+/]+={0,2}$/.test(field.slice(field.indexOf(',') + 1))
        && field.slice(field.indexOf(',') + 1).length % 4 === 0
      ));
    } else {
      valid = typeof field === 'boolean';
    }
    if (!valid) throw new Error('图表立标字段无效: ' + key);
    Object.assign(normalized, { [key]: field });
  }
  return normalized;
}

/** 旧 XZ 平面改为直立几何基准，保留任意组合旋转、非等比缩放及世界位置。 */
export function convertLegacyChartMarkerTransform(transform: TransformComponent): TransformComponent {
  const { rotation, scale } = transform;
  const uprightRotation = Quaternion.RotationYawPitchRoll(rotation.y, rotation.x, rotation.z)
    .multiply(Quaternion.RotationYawPitchRoll(0, -Math.PI / 2, 0)).toEulerAngles();
  return {
    position: { ...transform.position },
    rotation: { x: uprightRotation.x, y: uprightRotation.y, z: uprightRotation.z },
    scale: { x: scale.x, y: scale.z, z: scale.y },
  };
}

/** 空立标也具有完整实体身份，底边落在拖入场景的地面点。 */
export function createChartMarkerEntity(position: Vector3Data): Entity {
  return {
    id: createId('entity'),
    name: '图表立标',
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: { ...position, y: position.y + DATA_PLATFORM_SCREEN_DEFAULT_HEIGHT_METERS / 2 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: DATA_PLATFORM_SCREEN_DEFAULT_WIDTH_METERS / 2, y: DATA_PLATFORM_SCREEN_DEFAULT_HEIGHT_METERS / 2, z: 1 },
      },
      meshRenderer: { meshKind: 'plane', materialColor: '#101827' },
      chartMarker: { ...CHART_MARKER_DEFAULTS, clickEvents: [] },
    },
  };
}
