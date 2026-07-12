import type { BuiltInImageAsset } from '../../assets/imageAssets';
import { BUILT_IN_IMAGE_ASSETS } from '../../assets/imageAssets';
import type { LightKind, MeshKind } from '../model/components';
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, formatModelLengthUnit } from '../model/sceneUnits';
import type { AssetEntry, BuiltInAssetDragPayload } from './AssetDatabase';

export type ProjectLibraryKey = 'model' | 'poi' | 'theme' | 'composition' | 'environment' | 'chart' | 'image';

export type ProjectLibraryItemBase = {
  id: string;
  name: string;
  icon: string;
  subtitle?: string;
  thumbnailUrl?: string;
  hasStatusBadge?: boolean;
};

export type BuiltInProjectLibraryItem = ProjectLibraryItemBase & {
  builtIn: BuiltInAssetDragPayload;
};

export type ImportedProjectLibraryItem = ProjectLibraryItemBase & {
  asset: AssetEntry;
};

export type PlaceholderProjectLibraryItem = ProjectLibraryItemBase;

/** 图片库内置图片卡片，保存可拖拽的内置图片资产元数据。 */
export type BuiltInImageProjectLibraryItem = ProjectLibraryItemBase & {
  imageAsset: BuiltInImageAsset;
};

export type ProjectLibraryItem = BuiltInProjectLibraryItem | ImportedProjectLibraryItem | BuiltInImageProjectLibraryItem | PlaceholderProjectLibraryItem;

export type ProjectLibrary = {
  key: ProjectLibraryKey;
  label: string;
  searchLabel: string;
  searchPlaceholder: string;
  items: ProjectLibraryItem[];
};

export type BuiltInProjectLibraryAction =
  | { kind: 'mesh'; meshKind: MeshKind }
  | { kind: 'locator'; locatorKind: 'box-wire' }
  | { kind: 'light'; lightKind: LightKind };

export const BUILT_IN_MODEL_LIBRARY_ITEMS: BuiltInProjectLibraryItem[] = [
  { id: 'builtin-cube', name: '立方体', icon: 'cube', subtitle: '基础对象', builtIn: { kind: 'mesh', meshKind: 'cube' } },
  { id: 'builtin-sphere', name: '球体', icon: 'ring', subtitle: '基础对象', builtIn: { kind: 'mesh', meshKind: 'sphere' } },
  { id: 'builtin-plane', name: '地面', icon: 'panel', subtitle: '基础对象', builtIn: { kind: 'mesh', meshKind: 'plane' } },
  { id: 'builtin-box-wire-locator', name: '虚拟定位线框', icon: 'cube', subtitle: '基础对象', builtIn: { kind: 'locator', locatorKind: 'box-wire' } },
  { id: 'builtin-hemispheric-light', name: '半球光', icon: 'marker', subtitle: '灯光', builtIn: { kind: 'light', lightKind: 'hemispheric' } },
  { id: 'builtin-directional-light', name: '方向光', icon: 'marker', subtitle: '灯光', builtIn: { kind: 'light', lightKind: 'directional' } },
  { id: 'builtin-point-light', name: '点光源', icon: 'marker', subtitle: '灯光', builtIn: { kind: 'light', lightKind: 'point' } },
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
      { id: 'model-generator', name: '模型产生器', icon: 'ring' },
    ],
  },
  {
    key: 'poi',
    label: 'POI库',
    searchLabel: 'POI名称',
    searchPlaceholder: '请输入POI名称...',
    items: [
      { id: 'poi-chart-marker', name: '图表立标', icon: 'marker' },
      { id: 'poi-panel', name: '图表面板', icon: 'panel' },
      { id: 'poi-alarm', name: '报警管理器', icon: 'cube' },
      { id: 'poi-roam', name: '手动漫游', icon: 'person' },
    ],
  },
  {
    key: 'theme',
    label: '主题库',
    searchLabel: '主题名称',
    searchPlaceholder: '请输入主题名称...',
    items: [
      { id: 'theme-tech-blue', name: '科技蓝主题', icon: 'panel' },
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
  if (isImportedProjectLibraryItem(item)) return getImportedModelCardSubtitle(item.asset);
  return library.label.replace(/库$/, '') || '资源';
}

/** 获取资源卡片缩略图地址，内置对象没有缩略图时由图标占位。 */
export function getResourceCardThumbnailUrl(item: ProjectLibraryItem): string | undefined {
  return isImportedProjectLibraryItem(item) ? item.asset.thumbnailUrl : item.thumbnailUrl;
}
