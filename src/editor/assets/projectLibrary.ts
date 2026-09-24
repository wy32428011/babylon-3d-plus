import { getConveyorArrowThumbnail } from './conveyorArrowThumbnails';
import { getLightThumbnail } from './lightThumbnails';
import { LIGHT_DESCRIPTIONS } from '../model/lightSettings';
import techBlueNightThumbnailUrl from '../../assets/images/tech-blue-night.svg';
import { SCENE_THEME_PRESET_ID } from '../model/sceneTheme';
import type { BuiltInImageAsset } from '../../assets/imageAssets';
import autoPatrolThumbnailUrl from '../../assets/images/auto-patrol.png';
import { BUILT_IN_IMAGE_ASSETS } from '../../assets/imageAssets';
import { formatBuiltInMeshBaseDimensionsMeters } from '../model/builtInMeshGeometry';
import type { LightKind, MeshKind } from '../model/components';
import { POI_EFFECT_DEFINITIONS, VISIBLE_POI_EFFECT_DEFINITIONS } from '../model/poiEffect';
import { getAlarmEffectThumbnail } from './alarmEffectThumbnails';
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, formatModelLengthUnit } from '../model/sceneUnits';
import type { AssetEntry, BuiltInAssetDragPayload, ProjectSkyboxAssetEntry } from './AssetDatabase';
import { formatSkyboxFileSize } from './skyboxAssets';

export type ProjectLibraryKey = 'model' | 'poi' | 'effect' | 'theme' | 'composition' | 'environment' | 'skybox' | 'chart' | 'image';

export type ProjectLibraryItemBase = {
  id: string;
  name: string;
  icon: string;
  subtitle?: string;
  description?: string;
  thumbnailUrl?: string;
  hasStatusBadge?: boolean;
};

export type BuiltInProjectLibraryItem = ProjectLibraryItemBase & {
  builtIn: BuiltInAssetDragPayload;
};

export type ImportedProjectLibraryItem = ProjectLibraryItemBase & {
  asset: AssetEntry | ProjectSkyboxAssetEntry;
};

export type SceneThemeProjectLibraryItem = ProjectLibraryItemBase & {
  sceneThemePresetId: typeof SCENE_THEME_PRESET_ID;
};

export type EnvironmentLightProjectLibraryItem = ProjectLibraryItemBase & {
  openLibrary: 'skybox';
};

export type PlaceholderProjectLibraryItem = ProjectLibraryItemBase;

/** 图片库内置图片卡片，保存可拖拽的内置图片资产元数据。 */
export type BuiltInImageProjectLibraryItem = ProjectLibraryItemBase & {
  imageAsset: BuiltInImageAsset;
};

/** 图片库中台同步图片卡片，保存可拖拽的同步图片资产元数据。 */
export type SyncedImageProjectLibraryItem = ProjectLibraryItemBase & {
  syncedImage: SyncedImageAssetEntry;
};

export type ProjectLibraryItem = BuiltInProjectLibraryItem | ImportedProjectLibraryItem | BuiltInImageProjectLibraryItem | SyncedImageProjectLibraryItem | SceneThemeProjectLibraryItem | EnvironmentLightProjectLibraryItem | PlaceholderProjectLibraryItem;

export type ProjectLibrary = {
  key: ProjectLibraryKey;
  label: string;
  searchLabel: string;
  searchPlaceholder: string;
  items: ProjectLibraryItem[];
};

export type BuiltInProjectLibraryAction =
  | { kind: 'model-generator' }
  | { kind: 'device-spawner' }
  | { kind: 'auto-patrol' }
  | { kind: 'manual-roam-spawn' }
  | { kind: 'click-event-binding' }
  | { kind: 'chart-marker' }
  | { kind: 'alarm-manager' }
  | { kind: 'poi-effect'; effectKind: (typeof POI_EFFECT_DEFINITIONS)[number]['kind'] }
  | { kind: 'mesh'; meshKind: MeshKind }
  | { kind: 'virtual-conveyor' }
  | { kind: 'locator'; locatorKind: 'box-wire' }
  | { kind: 'light'; lightKind: LightKind };

/** HDRI 通过唯一天空盒资源提供全局 IBL，不创建重复光源实体。 */
export const ENVIRONMENT_LIGHT_LIBRARY_ITEM: EnvironmentLightProjectLibraryItem = {
  id: 'builtin-environment-light',
  name: '环境光 HDRI / IBL',
  icon: 'ring',
  subtitle: '全局照明与反射',
  description: '使用 HDR/EXR 环境贴图提供全局环境照明和反射，不自动产生投射阴影；IBL Shadows 当前未接入。点击进入天空盒库，导入或选择 HDR/EXR 资源。缩略图为光照概念示意。',
  thumbnailUrl: getLightThumbnail('environment'),
  openLibrary: 'skybox',
};

export const BUILT_IN_LIGHT_LIBRARY_ITEMS: BuiltInProjectLibraryItem[] = [
  {
    id: 'builtin-directional-light', name: '方向光', icon: 'marker', subtitle: '平行光 · 支持投影',
    description: `${LIGHT_DESCRIPTIONS.directional} 旋转改变照射方向；缩略图虚线仅示意光线方向。`,
    thumbnailUrl: getLightThumbnail('directional'), builtIn: { kind: 'light', lightKind: 'directional' },
  },
  {
    id: 'builtin-spot-light', name: '聚光灯', icon: 'marker', subtitle: '锥形光 · 实时阴影',
    description: `${LIGHT_DESCRIPTIONS.spot} 可调锥角、衰减和照射方向；缩略图光束仅示意照射范围，不代表体积光。`,
    thumbnailUrl: getLightThumbnail('spot'), builtIn: { kind: 'light', lightKind: 'spot' },
  },
  {
    id: 'builtin-point-light', name: '点光源', icon: 'marker', subtitle: '全向光 · 实时阴影',
    description: `${LIGHT_DESCRIPTIONS.point} 光源位置和范围影响受光区域；缩略图虚线仅示意光线方向。`,
    thumbnailUrl: getLightThumbnail('point'), builtIn: { kind: 'light', lightKind: 'point' },
  },
  {
    id: 'builtin-hemispheric-light', name: '半球光', icon: 'marker', subtitle: '基础照明 · 不投影',
    description: `${LIGHT_DESCRIPTIONS.hemispheric} 可调整天空和地面颜色；缩略图虚线仅示意环境光方向。`,
    thumbnailUrl: getLightThumbnail('hemispheric'), builtIn: { kind: 'light', lightKind: 'hemispheric' },
  },
  {
    id: 'builtin-rect-area-light', name: '矩形面光', icon: 'panel', subtitle: '柔和面光 · 不投影',
    description: `${LIGHT_DESCRIPTIONS.rectArea} 可调整宽度、高度和朝向；缩略图虚线仅示意光线方向。`,
    thumbnailUrl: getLightThumbnail('rectArea'), builtIn: { kind: 'light', lightKind: 'rectArea' },
  },
];

export const BUILT_IN_MODEL_LIBRARY_ITEMS: BuiltInProjectLibraryItem[] = [
  {
    id: 'builtin-cube',
    name: '立方体',
    icon: 'cube',
    subtitle: formatBuiltInMeshBaseDimensionsMeters('cube'),
    builtIn: { kind: 'mesh', meshKind: 'cube' },
  },
  { id: 'builtin-sphere', name: '球体', icon: 'ring', subtitle: formatBuiltInMeshBaseDimensionsMeters('sphere'), builtIn: { kind: 'mesh', meshKind: 'sphere' } },
  { id: 'builtin-plane', name: '地面', icon: 'panel', subtitle: formatBuiltInMeshBaseDimensionsMeters('plane'), builtIn: { kind: 'mesh', meshKind: 'plane' } },
  { id: 'builtin-virtual-conveyor', name: '虚拟输送线', icon: 'panel', subtitle: '输送设备 · 内置', builtIn: { kind: 'virtual-conveyor' } },
  { id: 'builtin-box-wire-locator', name: '虚拟定位线框', icon: 'cube', subtitle: '基础对象', builtIn: { kind: 'locator', locatorKind: 'box-wire' } },
  ...BUILT_IN_LIGHT_LIBRARY_ITEMS,
];

/** 示意图中的业务交互复用已有组件；卡片副标题明确实际创建入口。 */
const EXISTING_EFFECT_COMPONENT_ITEMS: BuiltInProjectLibraryItem[] = [
  { id: 'effect-status-color', name: '状态变色', icon: 'cube', subtitle: '设备状态 · 报警管理器', builtIn: { kind: 'alarm-manager' } },
  { id: 'effect-alarm-breathing', name: '告警呼吸', icon: 'ring', subtitle: '设备状态 · 报警管理器', builtIn: { kind: 'alarm-manager' } },
  { id: 'effect-poi-label', name: 'POI 悬浮标签', icon: 'marker', subtitle: '交互信息 · 图表立标', builtIn: { kind: 'chart-marker' } },
  { id: 'effect-callout', name: '引线标注', icon: 'marker', subtitle: '交互信息 · 图表立标线形外观', builtIn: { kind: 'chart-marker' } },
  { id: 'effect-info-card', name: '点击信息卡', icon: 'panel', subtitle: '交互信息 · 点击事件绑定', builtIn: { kind: 'click-event-binding' } },
  { id: 'effect-camera-flight', name: '镜头飞行', icon: 'ring', subtitle: '镜头动画 · 自动巡检', thumbnailUrl: autoPatrolThumbnailUrl, builtIn: { kind: 'auto-patrol' } },
];

export const PROJECT_LIBRARIES: ProjectLibrary[] = [
  {
    key: 'model',
    label: '模型库',
    searchLabel: '模型名称',
    searchPlaceholder: '请输入模型名称...',
    items: [
      { id: 'model-trigger', name: '事件触发器', icon: 'cube' },
      { id: 'model-sender', name: '发送器', icon: 'cube' },
      { id: 'model-receiver', name: '回收器', icon: 'cube' },
    ],
  },
  {
    key: 'poi',
    label: 'POI库',
    searchLabel: 'POI名称',
    searchPlaceholder: '请输入POI名称...',
    items: [
      { id: 'poi-auto-patrol', name: '自动巡检', icon: 'ring', subtitle: '内置POI', thumbnailUrl: autoPatrolThumbnailUrl, builtIn: { kind: 'auto-patrol' } },
      { id: 'poi-model-generator', name: '模型生成器', icon: 'ring', subtitle: '内置POI', builtIn: { kind: 'model-generator' } },
      { id: 'poi-device-spawner', name: '设备产生器', icon: 'ring', subtitle: '内置POI', builtIn: { kind: 'device-spawner' } },
      { id: 'poi-click-event-binding', name: '点击事件绑定', icon: 'marker', subtitle: '内置POI', builtIn: { kind: 'click-event-binding' } },
      { id: 'poi-chart-marker', name: '图表立标', icon: 'marker', subtitle: '拖入大屏实时展示', builtIn: { kind: 'chart-marker' } },
      { id: 'poi-panel', name: '图表面板', icon: 'panel' },
      { id: 'poi-alarm', name: '报警管理器', icon: 'cube', subtitle: '设备 / 火警监听', builtIn: { kind: 'alarm-manager' } },
      { id: 'poi-roam', name: '手动漫游', icon: 'person', subtitle: '初始位置', builtIn: { kind: 'manual-roam-spawn' } },
    ],
  },
  {
    key: 'effect',
    label: '特效库',
    searchLabel: '特效名称',
    searchPlaceholder: '请输入特效名称...',
    items: createPoiEffectLibraryItems(),
  },
  {
    key: 'theme',
    label: '主题库',
    searchLabel: '主题名称',
    searchPlaceholder: '请输入主题名称...',
    items: [
      { id: 'theme-tech-blue', name: '科技蓝夜景', icon: 'panel', subtitle: '冷蓝底光 · 清晰夜景', thumbnailUrl: techBlueNightThumbnailUrl, sceneThemePresetId: SCENE_THEME_PRESET_ID },
      { id: 'theme-dark-city', name: '暗色城市', icon: 'ring' },
      { id: 'theme-energy', name: '能源监控', icon: 'marker' },
      { id: 'theme-command', name: '指挥中心', icon: 'panel' },
    ],
  },
  {
    key: 'composition',
    label: '组合库',
    searchLabel: '组合名称',
    searchPlaceholder: '请输入组合名称...',
    items: [
      { id: 'composition-device', name: '设备组合', icon: 'cube' },
      { id: 'composition-dashboard', name: '看板组合', icon: 'panel' },
      { id: 'composition-alarm', name: '告警组合', icon: 'marker' },
      { id: 'composition-scene', name: '场景组合', icon: 'ring' },
    ],
  },
  {
    key: 'environment',
    label: '环境库',
    searchLabel: '环境名称',
    searchPlaceholder: '请输入环境名称...',
    items: [
      { id: 'environment-sky', name: '天空环境', icon: 'ring' },
      { id: 'environment-ground', name: '地面环境', icon: 'marker' },
      { id: 'environment-light', name: '灯光环境', icon: 'panel' },
      { id: 'environment-weather', name: '天气环境', icon: 'cube' },
    ],
  },
  {
    key: 'skybox',
    label: '天空盒库',
    searchLabel: '天空盒名称',
    searchPlaceholder: '请输入天空盒名称...',
    items: [],
  },
  {
    key: 'chart',
    label: '图表库',
    searchLabel: '图表名称',
    searchPlaceholder: '请输入图表名称...',
    items: [
      { id: 'chart-board', name: '图表面板', icon: 'panel' },
      { id: 'chart-column', name: '柱状图', icon: 'marker' },
      { id: 'chart-line', name: '折线图', icon: 'panel' },
      { id: 'chart-ring', name: '环形图', icon: 'ring' },
    ],
  },
  {
    key: 'image',
    label: '图片库',
    searchLabel: '图片名称',
    searchPlaceholder: '请输入图片名称...',
    items: createImageLibraryItems(),
  },
];

/** 隐藏旧版入口；加载和编辑旧场景仍由完整定义表提供兼容。 */
export function createPoiEffectLibraryItems(): BuiltInProjectLibraryItem[] {
  return [
    ...VISIBLE_POI_EFFECT_DEFINITIONS.map((definition): BuiltInProjectLibraryItem => ({
      id: `poi-eff-${definition.kind}`,
      name: definition.name,
      icon: definition.icon,
      thumbnailUrl: getAlarmEffectThumbnail(definition.kind) ?? getConveyorArrowThumbnail(definition.kind),
      subtitle: `EFF · ${definition.subtitle}`,
      hasStatusBadge: true,
      builtIn: { kind: 'poi-effect', effectKind: definition.kind },
    })),
    ...EXISTING_EFFECT_COMPONENT_ITEMS,
  ];
}

/** 将内置图片资产转成 Project 图片库卡片展示数据。 */
export function createImageLibraryItems(): BuiltInImageProjectLibraryItem[] {
  return BUILT_IN_IMAGE_ASSETS.map((asset) => ({
    id: asset.id,
    name: asset.name,
    icon: 'panel',
    subtitle: '内置图片',
    thumbnailUrl: asset.sourceUrl,
    imageAsset: asset,
  }));
}

/** 将数据中台同步图片转成 Project 图片库卡片展示数据，分类作为副标题。 */
export function createSyncedImageLibraryItems(syncedImages: SyncedImageAssetEntry[]): SyncedImageProjectLibraryItem[] {
  return syncedImages.map((asset) => ({
    id: asset.reference,
    name: asset.name,
    icon: 'panel',
    subtitle: asset.category?.trim() ? asset.category.trim() : '数据中台图片',
    thumbnailUrl: asset.sourceUrl,
    syncedImage: asset,
  }));
}

/** 将项目模型资产转成 Project 资源库卡片展示数据。 */
export function createModelLibraryItems(modelAssets: AssetEntry[]): ImportedProjectLibraryItem[] {
  return modelAssets.map((asset) => ({
    id: asset.id,
    name: asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, ''),
    icon: 'cube',
    subtitle: getImportedModelCardSubtitle(asset),
    thumbnailUrl: asset.thumbnailUrl,
    asset,
  }));
}

function formatSkyboxLibrarySubtitle(asset: ProjectSkyboxAssetEntry): string {
  const sourceLabel = asset.source === 'data-platform' ? '数据中台' : '项目本地';
  return `${sourceLabel} · ${asset.format.toUpperCase()} · ${formatSkyboxFileSize(asset.fileSizeBytes)}`;
}

/** 将 active 项目天空盒资产转成无缩略图的格式化资源卡片。 */
export function createSkyboxLibraryItems(skyboxAssets: ProjectSkyboxAssetEntry[]): ImportedProjectLibraryItem[] {
  return skyboxAssets
    .filter((asset) => asset.availability === 'active')
    .map((asset) => ({
      id: asset.id,
      name: asset.displayName,
      icon: 'ring',
      subtitle: formatSkyboxLibrarySubtitle(asset),
      asset,
    }));
}

/** 主题卡片应用场景配置，不创建层级实体。 */
export function isSceneThemeProjectLibraryItem(item: ProjectLibraryItem): item is SceneThemeProjectLibraryItem {
  return 'sceneThemePresetId' in item && item.sceneThemePresetId === SCENE_THEME_PRESET_ID;
}

export function isEnvironmentLightProjectLibraryItem(item: ProjectLibraryItem): item is EnvironmentLightProjectLibraryItem {
  return 'openLibrary' in item && item.openLibrary === 'skybox';
}

/** 判断资源库卡片是否对应可直接创建的内置对象。 */
export function isBuiltInProjectLibraryItem(item: ProjectLibraryItem): item is BuiltInProjectLibraryItem {
  return 'builtIn' in item;
}

/** 判断资源库卡片是否对应项目内导入模型。 */
export function isImportedProjectLibraryItem(item: ProjectLibraryItem): item is ImportedProjectLibraryItem {
  return 'asset' in item;
}

/** 判断资源库卡片是否对应可拖拽的内置图片。 */
export function isBuiltInImageProjectLibraryItem(item: ProjectLibraryItem): item is BuiltInImageProjectLibraryItem {
  return 'imageAsset' in item;
}

/** 判断资源库卡片是否对应可拖拽的数据中台同步图片。 */
export function isSyncedImageProjectLibraryItem(item: ProjectLibraryItem): item is SyncedImageProjectLibraryItem {
  return 'syncedImage' in item;
}

/** 生成人类可读的模型单位提示，用于卡片标题和无障碍说明。 */
export function getModelUnitTitle(asset: AssetEntry): string {
  const lengthUnit = asset.lengthUnit ?? DEFAULT_MODEL_LENGTH_UNIT_INFO.lengthUnit;
  return `源单位：${formatModelLengthUnit(lengthUnit)} → m`;
}

/** 生成导入模型卡片副标题，优先暴露非默认源单位。 */
export function getImportedModelCardSubtitle(asset: AssetEntry): string {
  if (asset.lengthUnit && asset.lengthUnit !== DEFAULT_MODEL_LENGTH_UNIT_INFO.lengthUnit) {
    return formatModelLengthUnit(asset.lengthUnit);
  }

  return '模型';
}

/** 生成资源卡片副标题，避免不同入口出现不一致的兜底文案。 */
export function getResourceCardSubtitle(item: ProjectLibraryItem, library: ProjectLibrary): string {
  if (item.subtitle) return item.subtitle;
  if (isImportedProjectLibraryItem(item)) {
    return item.asset.kind === 'skybox'
      ? formatSkyboxLibrarySubtitle(item.asset)
      : getImportedModelCardSubtitle(item.asset);
  }
  return library.label.replace(/库$/, '') || '资源';
}

/** 获取资源卡片缩略图地址，内置对象没有缩略图时由图标占位。 */
export function getResourceCardThumbnailUrl(item: ProjectLibraryItem): string | undefined {
  return isImportedProjectLibraryItem(item)
    ? item.asset.kind === 'skybox' ? undefined : item.asset.thumbnailUrl
    : item.thumbnailUrl;
}
