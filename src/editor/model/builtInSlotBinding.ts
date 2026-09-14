import type { Vector3Data } from './math';
import type { ModelParameterValues } from './modelParameters';
import type { Entity } from './Entity';
import type { SceneDocument } from './SceneDocument';
import type { LocatorComponent } from './components';

/** 内置货格列拓展方向（宿主模型局部轴）。 */
export type BuiltInSlotColumnDirection = '+x' | '-x';

/**
 * 模型包声明的内置货格绑定映射。
 * 由模型开发者在 .model.ts 中导出同名常量并同步到 meta.json 的 builtInSlotBinding 字段；
 * 对最终用户透明，编辑器/运行时按声明执行派生与对齐。
 */
export type BuiltInSlotBindingConfig = {
  /** 启用开关的模型参数 key（boolean 类型参数） */
  enabledParam: string;
  /** 货格维度字段 ← 模型参数 key；缺省的字段保持货格自身值 */
  dimensionMapping: Partial<Record<'columns' | 'layers' | 'length' | 'height' | 'width', string>>;
  /** 列拓展方向（与参数化脚本克隆方向一致），默认 '+x' */
  columnDirection?: BuiltInSlotColumnDirection;
  /** 列向分裂比例的模型参数 key（可选）：1 个实物货格分裂为 N 个逻辑列，缺省为 1 */
  columnSplitParam?: string;
  /** 排数的模型参数 key（可选）：一个宿主生成 N 个绑定货格，缺省为 1 排 */
  rowCountParam?: string;
};

/** 货格实体上的绑定标记；hostEntityId 指向声明了绑定的模型实体时视为内置绑定（parentId 不参与绑定身份，仍只用于文件夹分组）。 */
export type LocatorBuiltInBinding = {
  /** 宿主（货架）实体 ID；复制粘贴时按剪贴板 ID 映射重建，宿主不在粘贴集合内则解除绑定 */
  hostEntityId: string;
  /** 排索引（0 基）：对应宿主脚本写入 builtInSlotLayout 的排数组下标，缺省 0 */
  rowIndex: number;
  /** 基点微调（米，宿主模型局部米空间，叠加在自动对齐结果上） */
  originOffset: Vector3Data;
};

const DIMENSION_KEYS = ['columns', 'layers', 'length', 'height', 'width'] as const;
type DimensionKey = (typeof DIMENSION_KEYS)[number];

/** 校验并归一化来自 meta.json 的内置货格绑定声明；非法输入返回 undefined。 */
export function normalizeBuiltInSlotBindingConfig(source: unknown): BuiltInSlotBindingConfig | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const enabledParam = typeof record.enabledParam === 'string' ? record.enabledParam.trim() : '';
  if (!enabledParam) return undefined;

  const mappingSource = record.dimensionMapping;
  const dimensionMapping: BuiltInSlotBindingConfig['dimensionMapping'] = {};
  if (mappingSource && typeof mappingSource === 'object') {
    for (const key of DIMENSION_KEYS) {
      const paramKey = (mappingSource as Record<string, unknown>)[key];
      if (typeof paramKey === 'string' && paramKey.trim()) {
        dimensionMapping[key] = paramKey.trim();
      }
    }
  }

  const columnSplitParam = typeof record.columnSplitParam === 'string' ? record.columnSplitParam.trim() : '';
  const rowCountParam = typeof record.rowCountParam === 'string' ? record.rowCountParam.trim() : '';

  return {
    enabledParam,
    dimensionMapping,
    columnDirection: record.columnDirection === '-x' ? '-x' : '+x',
    ...(columnSplitParam ? { columnSplitParam } : {}),
    ...(rowCountParam ? { rowCountParam } : {}),
  };
}

/** 读取实体模型资产上声明的内置货格绑定配置。 */
export function getBuiltInSlotBindingConfig(entity: Entity | null | undefined): BuiltInSlotBindingConfig | undefined {
  return entity?.components.modelAsset?.builtInSlotBindingConfig;
}

/** 校验并归一化货格实体上的内置绑定标记；结构非法时返回 undefined（视为未绑定）。 */
export function normalizeLocatorBuiltInBinding(source: unknown): LocatorBuiltInBinding | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const hostEntityId = typeof record.hostEntityId === 'string' ? record.hostEntityId.trim() : '';
  if (!hostEntityId) return undefined;
  const offsetSource = record.originOffset;
  const offset = offsetSource && typeof offsetSource === 'object' ? offsetSource as Record<string, unknown> : {};
  const read = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const rawRowIndex = record.rowIndex;
  const rowIndex = typeof rawRowIndex === 'number' && Number.isInteger(rawRowIndex) && rawRowIndex >= 0 ? rawRowIndex : 0;
  return { hostEntityId, rowIndex, originOffset: { x: read(offset.x), y: read(offset.y), z: read(offset.z) } };
}

/** 判断实体是否为已启用的内置货格（绑定标记存在且指向有效宿主）。 */
export function isBuiltInSlotLocator(entity: Entity | null | undefined): boolean {
  return Boolean(entity?.components.locator?.builtInBinding?.hostEntityId);
}

const MIN_COLUMN_SPLIT = 1;
const MAX_COLUMN_SPLIT = 8;

/** 读取声明的列向分裂比例参数；缺参/非法值返回 1（不分裂）。 */
export function deriveColumnSplitFromBinding(
  config: BuiltInSlotBindingConfig,
  parameterValues: ModelParameterValues | undefined,
): number {
  const paramKey = config.columnSplitParam;
  if (!paramKey || !parameterValues) return 1;
  const raw = parameterValues[paramKey];
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.max(MIN_COLUMN_SPLIT, Math.min(MAX_COLUMN_SPLIT, Math.round(value)));
}

/**
 * 读取声明的排数参数；未声明 rowCountParam 时返回 1（单个货格，现状不变）。
 * 声明后只认 4 排，其余取值（含空/非数）按 2 排兜底——排数参数只承载 2 / 4 两种语义。
 */
export function deriveBuiltInSlotRowCountFromBinding(
  config: BuiltInSlotBindingConfig,
  parameterValues: ModelParameterValues | undefined,
): number {
  const paramKey = config.rowCountParam;
  if (!paramKey) return 1;
  const raw = parameterValues?.[paramKey];
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) && Math.round(value) === 4 ? 4 : 2;
}

/** 按声明的维度映射从宿主模型参数值派生货格维度。 */
export function deriveLocatorDimensionsFromBinding(
  config: BuiltInSlotBindingConfig,
  parameterValues: ModelParameterValues | undefined,
): Partial<Pick<LocatorComponent, 'columns' | 'layers' | 'length' | 'width' | 'height'>> {
  const result: Partial<Pick<LocatorComponent, 'columns' | 'layers' | 'length' | 'width' | 'height'>> = {};
  if (!parameterValues) return result;

  for (const key of DIMENSION_KEYS) {
    const paramKey = config.dimensionMapping[key];
    if (!paramKey) continue;
    const raw = parameterValues[paramKey];
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) continue;
    result[key] = sanitizeDimensionValue(key, value);
  }

  // 列向分裂：逻辑列数 ×N、逻辑格宽 ÷N；货架物理结构不变
  const columnSplit = deriveColumnSplitFromBinding(config, parameterValues);
  if (columnSplit > 1) {
    if (result.columns !== undefined) {
      result.columns = Math.max(1, Math.min(100, result.columns * columnSplit));
    }
    if (result.length !== undefined) {
      result.length = Math.max(0.01, result.length / columnSplit);
    }
  }
  return result;
}

function sanitizeDimensionValue(key: DimensionKey, value: number): number {
  if (key === 'columns' || key === 'layers') {
    return Math.max(1, Math.min(100, Math.round(value)));
  }
  return Math.max(0.01, value);
}

/** 查找绑定到指定宿主的全部内置货格实体，按排索引升序（排索引相同则保持场景顺序）。 */
export function findBuiltInSlotEntities(scene: SceneDocument, hostEntityId: string): Entity[] {
  const matched: Entity[] = [];
  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    if (entity?.components.locator?.builtInBinding?.hostEntityId === hostEntityId) matched.push(entity);
  }
  return matched.sort((left, right) => (
    (left.components.locator?.builtInBinding?.rowIndex ?? 0) - (right.components.locator?.builtInBinding?.rowIndex ?? 0)
  ));
}

/** 查找绑定到指定宿主的内置货格实体 ID（取排索引最小的一排）。 */
export function findBuiltInSlotEntityId(scene: SceneDocument, hostEntityId: string): string | null {
  return findBuiltInSlotEntities(scene, hostEntityId)[0]?.id ?? null;
}

/**
 * 把宿主模型参数派生的货格维度写入其全部内置货格实体。
 * 宿主未声明绑定、无绑定货格或维度无变化时返回原 scene。
 */
export function patchBuiltInSlotDimensions(scene: SceneDocument, hostEntityId: string): SceneDocument {
  const host = scene.entities[hostEntityId];
  const config = getBuiltInSlotBindingConfig(host);
  if (!host || !config) return scene;

  const slots = findBuiltInSlotEntities(scene, hostEntityId);
  if (slots.length === 0) return scene;

  const derived = deriveLocatorDimensionsFromBinding(config, host.components.modelAsset?.parameterValues);
  let changed = false;
  const entities = { ...scene.entities };

  for (const slotEntity of slots) {
    const locator = slotEntity.components.locator;
    if (!locator) continue;
    const entries = Object.entries(derived).filter(([key, value]) => locator[key as DimensionKey] !== value);
    if (entries.length === 0) continue;
    changed = true;
    entities[slotEntity.id] = {
      ...slotEntity,
      components: { ...slotEntity.components, locator: { ...locator, ...derived } },
    };
  }

  return changed ? { ...scene, entities } : scene;
}
