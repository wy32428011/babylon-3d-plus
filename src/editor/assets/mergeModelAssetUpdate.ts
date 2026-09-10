import { reconcileSceneParameterValues } from '../../../electron/shared/sceneModelInstanceConfig';
import type { ModelAssetTemplate } from '../model/components';
import type { ModelParameterDefinition, ModelParameterValue } from '../model/modelParameters';
import { isAllowedTextureReference } from '../model/textureReferences';

const RESOURCE_FIELDS = [
  'sourcePath', 'sourceUrl', 'sourceSnapshot', 'assetRevision', 'lengthUnit', 'unitScaleToMeters',
  'scriptAssets', 'parameterScriptMetadata', 'animationScriptMetadata', 'parameterConfig',
  'parameterValues', 'dataDrivenConfig', 'builtInSlotBindingConfig', 'dataPlatformModel',
] as const;

function acceptsValue(definition: ModelParameterDefinition, value: unknown): boolean {
  const min = 'min' in definition ? definition.min : undefined;
  const max = 'max' in definition ? definition.max : undefined;
  const inRange = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate)
    && (min === undefined || candidate >= min) && (max === undefined || candidate <= max);
  switch (definition.type) {
    case 'number': return inRange(value);
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'color': return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
    case 'enum': return typeof value === 'string' && definition.options.some(option => option.value === value);
    case 'texture': return typeof value === 'string' && isAllowedTextureReference(value, definition.allowedExtensions);
    case 'vector3': return !!value && typeof value === 'object' && ['x', 'y', 'z'].every(axis => inRange((value as Record<string, unknown>)[axis]));
  }
}

/** 新版资源和参数规则直接替换，仅保留同 key 的实例值；配置差异只返回日志。 */
export function mergeSceneModelAssetUpdate<T extends ModelAssetTemplate>(
  previous: T, next: ModelAssetTemplate, context = previous.sourcePath, onWarning?: (message: string) => void,
): T {
  const result = structuredClone(previous) as T & Record<string, unknown>;
  for (const field of RESOURCE_FIELDS) {
    delete result[field];
    if (field !== 'parameterValues' && next[field] !== undefined) {
      Object.defineProperty(result, field, { value: structuredClone(next[field]), writable: true, enumerable: true, configurable: true });
    }
  }
  if (previous.lengthUnit !== next.lengthUnit || previous.unitScaleToMeters !== next.unitScaleToMeters) {
    onWarning?.(`模型同步 [${context}]：源单位发生变化，已采用新版单位并保留实例摆放。`);
  }
  for (const field of ['dataDrivenConfig', 'builtInSlotBindingConfig'] as const) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) {
      onWarning?.(`模型同步 [${context}]：${field} 已采用新版模型配置，场景业务关联保持。`);
    }
  }
  const oldDefinitions = new Map(previous.parameterConfig?.parameters.map(definition => [definition.key, definition]) ?? []);
  const newDefinitions = next.parameterConfig?.parameters ?? [];
  const newKeys = new Set(newDefinitions.map(definition => definition.key));
  if (JSON.stringify(previous.parameterConfig) !== JSON.stringify(next.parameterConfig)) {
    const added = newDefinitions.filter(definition => !oldDefinitions.has(definition.key)).length;
    const removed = [...oldDefinitions.keys()].filter(key => !newKeys.has(key)).length;
    onWarning?.(`模型同步 [${context}]：参数脚本配置已采用新版，新增 ${added} 项使用默认值，删除 ${removed} 项，同 key 保留场景保存值。`);
  }
  if (next.parameterConfig) {
    result.parameterValues = reconcileSceneParameterValues<ModelParameterValue>(newDefinitions, previous.parameterValues);
    for (const definition of newDefinitions) {
      const old = oldDefinitions.get(definition.key);
      if ((old && (old.type !== definition.type || (old.unit ?? '') !== (definition.unit ?? '')))
        || !acceptsValue(definition, result.parameterValues[definition.key])) {
        onWarning?.(`模型同步 [${context}] 参数 ${definition.key} 与新版类型、单位或约束存在差异，已保留场景值并应用新版模型。`);
      }
    }
  }
  return result;
}

/** 旧调用入口同样使用统一的新模型参数规则。 */
export const mergeModelAssetUpdate = mergeSceneModelAssetUpdate;
