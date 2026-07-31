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
};

/** 货格实体上的绑定标记；hostEntityId 指向声明了绑定的模型实体时视为内置绑定（parentId 不参与绑定身份，仍只用于文件夹分组）。 */
export type LocatorBuiltInBinding = {
  /** 宿主（货架）实体 ID；复制粘贴时按剪贴板 ID 映射重建，宿主不在粘贴集合内则解除绑定 */
  hostEntityId: string;
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

  return {
    enabledParam,
    dimensionMapping,
    columnDirection: record.columnDirection === '-x' ? '-x' : '+x',
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
  return { hostEntityId, originOffset: { x: read(offset.x), y: read(offset.y), z: read(offset.z) } };
}

/** 判断实体是否为已启用的内置货格（绑定标记存在且指向有效宿主）。 */
export function isBuiltInSlotLocator(entity: Entity | null | undefined): boolean {
  return Boolean(entity?.components.locator?.builtInBinding?.hostEntityId);
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
  return result;
}

function sanitizeDimensionValue(key: DimensionKey, value: number): number {
  if (key === 'columns' || key === 'layers') {
    return Math.max(1, Math.min(100, Math.round(value)));
  }
  return Math.max(0.01, value);
}

/** 查找绑定到指定宿主的内置货格实体 ID。 */
export function findBuiltInSlotEntityId(scene: SceneDocument, hostEntityId: string): string | null {
  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    if (entity?.components.locator?.builtInBinding?.hostEntityId === hostEntityId) return entity.id;
  }
  return null;
}

/**
 * 把宿主模型参数派生的货格维度写入其内置货格实体。
 * 宿主未声明绑定、无绑定货格或维度无变化时返回原 scene。
 */
export function patchBuiltInSlotDimensions(scene: SceneDocument, hostEntityId: string): SceneDocument {
  const host = scene.entities[hostEntityId];
  const config = getBuiltInSlotBindingConfig(host);
  if (!host || !config) return scene;

  const slotEntityId = findBuiltInSlotEntityId(scene, hostEntityId);
  const slotEntity = slotEntityId ? scene.entities[slotEntityId] : null;
  const locator = slotEntity?.components.locator;
  if (!slotEntity || !locator) return scene;

  const derived = deriveLocatorDimensionsFromBinding(config, host.components.modelAsset?.parameterValues);
  const entries = Object.entries(derived).filter(([key, value]) => locator[key as DimensionKey] !== value);
  if (entries.length === 0) return scene;

  const nextLocator: LocatorComponent = { ...locator, ...derived };
  return {
    ...scene,
    entities: {
      ...scene.entities,
      [slotEntity.id]: {
        ...slotEntity,
        components: { ...slotEntity.components, locator: nextLocator },
      },
    },
  };
}
