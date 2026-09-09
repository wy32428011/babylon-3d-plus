import type { ModelAssetTemplate } from '../model/components';
import type { ModelParameterDefinition, ModelParameterValue, ModelParameterValues } from '../model/modelParameters';
import { isAllowedTextureReference } from '../model/textureReferences';

const RESOURCE_FIELDS = [
  'sourcePath', 'sourceUrl', 'sourceSnapshot', 'assetRevision', 'lengthUnit', 'unitScaleToMeters',
  'scriptAssets', 'parameterScriptMetadata', 'animationScriptMetadata', 'parameterConfig',
  'parameterValues', 'dataDrivenConfig', 'builtInSlotBindingConfig', 'dataPlatformModel',
] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function referencesParameter(value: unknown, key?: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if ('param' in value && typeof value.param === 'string' && (key === undefined || value.param === key)) return true;
  return Object.values(value).some((item) => referencesParameter(item, key));
}

function bindingSemantics(asset: ModelAssetTemplate, key: string): string {
  const config = asset.parameterConfig;
  return canonical({
    bindings: (config?.bindings ?? []).filter((binding) => referencesParameter(binding, key)),
    rules: (config?.rules ?? []).filter((rule) => referencesParameter(rule, key)),
  });
}

function isNumberInRange(value: unknown, definition: { min?: number; max?: number }): boolean {
  return typeof value === 'number' && Number.isFinite(value)
    && (definition.min === undefined || value >= definition.min)
    && (definition.max === undefined || value <= definition.max);
}

function isCompatibleValue(definition: ModelParameterDefinition, value: unknown): value is ModelParameterValue {
  switch (definition.type) {
    case 'number': return isNumberInRange(value, definition);
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'color': return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
    case 'enum': return typeof value === 'string' && definition.options.some((option) => option.value === value);
    case 'texture': return typeof value === 'string' && isAllowedTextureReference(value, definition.allowedExtensions);
    case 'vector3': return !!value && typeof value === 'object' && ['x', 'y', 'z'].every(
      (axis) => isNumberInRange((value as Record<string, unknown>)[axis], definition),
    );
  }
}

/**
 * 将已校验的新资源合并到场景实例；兼容性冲突抛错，由调用方统一取消整批场景更新。
 * 不清洗旧值、不猜测参数迁移；无包文件清单时，仅静态检查贴图引用格式和声明选项。
 */
export function mergeModelAssetUpdate<T extends ModelAssetTemplate>(
  previous: T,
  next: ModelAssetTemplate,
  context = previous.sourcePath,
): T {
  const conflict = (key: string, reason: string): never => {
    throw new Error(`模型同步冲突 [${context}]${key ? ` 参数 "${key}"` : ''}：${reason}；已保留原场景配置。`);
  };
  if (previous.lengthUnit !== next.lengthUnit || previous.unitScaleToMeters !== next.unitScaleToMeters) {
    conflict('', '模型源单位或米制缩放发生变化，需要明确迁移规则');
  }

  const collectDefinitions = (asset: ModelAssetTemplate): Map<string, ModelParameterDefinition> => {
    const definitions = new Map<string, ModelParameterDefinition>();
    for (const definition of asset.parameterConfig?.parameters ?? []) {
      if (definitions.has(definition.key)) conflict(definition.key, '参数定义重复');
      definitions.set(definition.key, definition);
    }
    return definitions;
  };
  const oldDefinitions = collectDefinitions(previous);
  const newDefinitions = collectDefinitions(next);
  const constantBindings = (asset: ModelAssetTemplate): unknown[] => [
    ...(asset.parameterConfig?.bindings ?? []), ...(asset.parameterConfig?.rules ?? []),
  ].filter((item) => !referencesParameter(item));
  const oldConstants = constantBindings(previous);
  if (oldConstants.length && canonical(oldConstants) !== canonical(constantBindings(next))) {
    conflict('', '模型常量绑定或规则语义发生变化');
  }
  const oldValues = previous.parameterValues ?? {};
  for (const key of new Set([...oldDefinitions.keys(), ...Object.keys(oldValues)])) {
    if (!newDefinitions.has(key)) conflict(key, '新版模型删除了已有参数');
  }

  const values: ModelParameterValues = {};
  for (const [key, definition] of newDefinitions) {
    const oldDefinition = oldDefinitions.get(key);
    if (oldDefinition) {
      if (oldDefinition.type !== definition.type) conflict(key, `类型由 ${oldDefinition.type} 变为 ${definition.type}`);
      if ((oldDefinition.unit ?? '') !== (definition.unit ?? '')) conflict(key, '参数单位发生变化');
      if (bindingSemantics(previous, key) !== bindingSemantics(next, key)) conflict(key, '参数绑定或规则语义发生变化');
      if (oldDefinition.type === 'enum' && definition.type === 'enum'
        && oldDefinition.options.some((option) => !definition.options.some((nextOption) => nextOption.value === option.value))) {
        conflict(key, '新版模型删除了枚举选项');
      }
    }

    // 旧工程可能省略默认值；此时保留旧定义的默认值，避免新版默认值改变实例行为。
    const value: unknown = Object.prototype.hasOwnProperty.call(oldValues, key)
      ? oldValues[key]
      : oldDefinition?.defaultValue ?? definition.defaultValue;
    if (!isCompatibleValue(definition, value)) conflict(key, '保留值或新增默认值不满足新版类型、范围、枚举或纹理引用要求');
    if (definition.type === 'texture' && oldDefinition?.type === 'texture'
      && oldDefinition.options?.some((option) => option.value === value)
      && !definition.options?.some((option) => option.value === value)) {
      conflict(key, '新版模型未保留当前使用的声明纹理引用');
    }
    Object.defineProperty(values, key, { value: structuredClone(value), writable: true, enumerable: true, configurable: true });
  }

  // 仅资源字段由新包接管，未知场景扩展以及实例 assetCode 始终来自原实例。
  const result = structuredClone(previous) as T & Record<string, unknown>;
  const resource = next as ModelAssetTemplate & Record<string, unknown>;
  for (const field of RESOURCE_FIELDS) {
    delete result[field];
    if (field !== 'parameterValues' && resource[field] !== undefined) {
      Object.defineProperty(result, field, { value: structuredClone(resource[field]), writable: true, enumerable: true, configurable: true });
    }
  }
  if (next.parameterConfig) result.parameterValues = values;
  return result;
}
