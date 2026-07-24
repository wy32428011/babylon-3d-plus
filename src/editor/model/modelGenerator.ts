import type {
  MeshKind,
  ModelAssetComponent,
  ModelAssetTemplate,
  ModelGeneratorComponent,
  ModelGeneratorFetchBinding,
  ModelGeneratorModelTarget,
  ModelGeneratorRule,
  ModelGeneratorTarget,
  ModelScriptAsset,
} from './components';
import { createDefaultModelParameterValues, normalizeModelParameterConfig, sanitizeModelParameterValues } from './modelParameters';
import { createModelLengthUnitInfo, normalizeModelLengthUnitInfo } from './sceneUnits';
import { normalizeModelDataDrivenConfig } from './telemetryBinding';

/** 模型生成器从项目资源库读取的最小资产快照，避免领域模型反向依赖带图片资源的 UI 资产模块。 */
type ModelGeneratorSourceAsset = {
  id: string;
  name: string;
  path: string;
  sourceUrl: string;
  kind: string;
  libraryKind?: 'model' | 'environment';
  assetRevision?: string;
  thumbnailUrl?: string;
  packagePath?: string;
  displayName?: string;
  lengthUnit?: ModelAssetTemplate['lengthUnit'];
  unitScaleToMeters?: number;
  scriptAssets?: ModelScriptAsset[];
  parameterScriptMetadata?: unknown[];
  animationScriptMetadata?: unknown[];
  parameterConfig?: ModelAssetTemplate['parameterConfig'];
  dataDrivenConfig?: ModelAssetTemplate['dataDrivenConfig'];
};

/** 模型生成器默认元数据 TTL，单位秒。 */
export const MODEL_GENERATOR_DEFAULT_TTL_SECONDS = 5;
/** 模型生成器元数据 TTL 最小值。 */
export const MODEL_GENERATOR_TTL_MIN_SECONDS = 1;
/** 模型生成器元数据 TTL 最大值。 */
export const MODEL_GENERATOR_TTL_MAX_SECONDS = 3600;
/** 单个模型生成器允许保存的最大规则数。 */
export const MODEL_GENERATOR_MAX_RULES = 64;
/** 单个模型生成器允许保存的最大绑定数。 */
export const MODEL_GENERATOR_MAX_BINDINGS = 32;

const AUTHORIZED_MODEL_GENERATOR_ASSET_URL_PREFIX = 'editor-asset://local/';
const MODEL_SCRIPT_EXTENSION = '.model.ts';
const MODEL_GENERATOR_ID_MAX_LENGTH = 128;
const MODEL_GENERATOR_TEXT_MAX_LENGTH = 256;

/** 判断值是否为普通 JSON 对象，避免带原型对象进入场景状态。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** 判断字符串是否为编辑器授权的本地资产 URL。 */
function isAuthorizedEditorAssetUrl(value: string): boolean {
  return value.startsWith(AUTHORIZED_MODEL_GENERATOR_ASSET_URL_PREFIX);
}

/** 清理字符串字段，非字符串回退为空字符串。 */
function sanitizeText(value: unknown, maxLength = MODEL_GENERATOR_TEXT_MAX_LENGTH): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** 清理必填 ID 字段，空 ID 表示该条配置无效。 */
function sanitizeId(value: unknown): string {
  return sanitizeText(value, MODEL_GENERATOR_ID_MAX_LENGTH);
}

/** 清理展示名称，非法或空值时使用兜底名称。 */
function sanitizeDisplayName(value: unknown, fallback: string): string {
  return sanitizeText(value) || fallback;
}

/** 清理模型生成器 TTL，始终输出 1..3600 秒范围内的整数。 */
export function sanitizeModelGeneratorMetadataTtlSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MODEL_GENERATOR_DEFAULT_TTL_SECONDS;
  return Math.min(MODEL_GENERATOR_TTL_MAX_SECONDS, Math.max(MODEL_GENERATOR_TTL_MIN_SECONDS, Math.trunc(value)));
}

/** 深拷贝可序列化 JSON 值，用于阻断 UI 与场景文档之间的可变引用。 */
function cloneJsonValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

/** 检查任意 JSON 值是否满足深度和集合规模限制。 */
function isSafeJsonValue(value: unknown, depth = 0, seen: { count: number } = { count: 0 }): boolean {
  seen.count += 1;
  if (depth > 12 || seen.count > 2048) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every((item) => isSafeJsonValue(item, depth + 1, seen));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([key, item]) => key.length > 0 && key.length <= 128 && isSafeJsonValue(item, depth + 1, seen));
}

/** 清理 JSON 数组元数据，非法结构会被视为未提供。 */
function sanitizeJsonArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length > 32 || !isSafeJsonValue(value)) return undefined;
  return cloneJsonValue(value);
}

/** 清理模型脚本资产，只保留授权 URL 和 .model.ts 文件。 */
function sanitizeModelScriptAssets(value: unknown): ModelScriptAsset[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const assets: ModelScriptAsset[] = [];

  for (const item of value.slice(0, 16)) {
    if (!isPlainObject(item)) continue;
    const path = sanitizeText(item.path, 512);
    const sourceUrl = sanitizeText(item.sourceUrl, 512);
    const name = sanitizeText(item.name, 256);
    if (!path || !sourceUrl || !name) continue;
    if (!path.toLowerCase().endsWith(MODEL_SCRIPT_EXTENSION)) continue;
    if (!name.toLowerCase().endsWith(MODEL_SCRIPT_EXTENSION)) continue;
    if (!isAuthorizedEditorAssetUrl(sourceUrl)) continue;
    assets.push({ path, sourceUrl, name });
  }

  return assets.length ? assets : undefined;
}

/** 清理导入模型模板，保证后续转运行时 modelAsset 时结构完整且 URL 安全。 */
export function sanitizeModelAssetTemplate(value: unknown): ModelAssetTemplate | null {
  if (!isPlainObject(value)) return null;
  const sourcePath = sanitizeText(value.sourcePath, 1024);
  const sourceUrl = sanitizeText(value.sourceUrl, 1024);
  if (!sourcePath || !sourceUrl || !isAuthorizedEditorAssetUrl(sourceUrl)) return null;

  let unitInfo;
  try {
    unitInfo = normalizeModelLengthUnitInfo(value.lengthUnit, value.unitScaleToMeters);
  } catch {
    return null;
  }

  const parameterConfig = normalizeModelParameterConfig(value.parameterConfig) ?? undefined;
  const dataDrivenConfig = value.dataDrivenConfig === undefined ? null : normalizeModelDataDrivenConfig(value.dataDrivenConfig);
  if (value.dataDrivenConfig !== undefined && !dataDrivenConfig) return null;
  const scriptAssets = sanitizeModelScriptAssets(value.scriptAssets);
  const parameterScriptMetadata = sanitizeJsonArray(value.parameterScriptMetadata);
  const animationScriptMetadata = sanitizeJsonArray(value.animationScriptMetadata);
  const assetRevision = sanitizeText(value.assetRevision, 128);

  return {
    sourcePath,
    sourceUrl,
    ...(assetRevision ? { assetRevision } : {}),
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    ...(scriptAssets ? { scriptAssets } : {}),
    ...(parameterScriptMetadata?.length ? { parameterScriptMetadata } : {}),
    ...(animationScriptMetadata?.length ? { animationScriptMetadata } : {}),
    ...(parameterConfig
      ? {
          parameterConfig,
          parameterValues: sanitizeModelParameterValues(parameterConfig, value.parameterValues),
        }
      : {}),
    ...(dataDrivenConfig ? { dataDrivenConfig } : {}),
  };
}

/** 从资产库条目构建安全模型模板，参数值总是使用模型包参数默认值。 */
function createModelAssetTemplateFromAsset(asset: ModelGeneratorSourceAsset): ModelAssetTemplate | null {
  if (!asset.sourceUrl.startsWith(AUTHORIZED_MODEL_GENERATOR_ASSET_URL_PREFIX)) return null;
  const parameterConfig = normalizeModelParameterConfig(asset.parameterConfig) ?? undefined;
  const unitInfo = createModelLengthUnitInfo(asset.lengthUnit);
  const dataDrivenConfig = asset.dataDrivenConfig ? normalizeModelDataDrivenConfig(asset.dataDrivenConfig) : null;
  const scriptAssets = sanitizeModelScriptAssets(asset.scriptAssets);
  const parameterScriptMetadata = sanitizeJsonArray(asset.parameterScriptMetadata);
  const animationScriptMetadata = sanitizeJsonArray(asset.animationScriptMetadata);

  return {
    sourcePath: asset.path,
    sourceUrl: asset.sourceUrl,
    ...(asset.assetRevision ? { assetRevision: asset.assetRevision } : {}),
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    ...(scriptAssets?.length ? { scriptAssets } : {}),
    ...(parameterScriptMetadata?.length ? { parameterScriptMetadata } : {}),
    ...(animationScriptMetadata?.length ? { animationScriptMetadata } : {}),
    ...(parameterConfig ? { parameterConfig, parameterValues: createDefaultModelParameterValues(parameterConfig) } : {}),
    ...(dataDrivenConfig ? { dataDrivenConfig: cloneJsonValue(dataDrivenConfig) } : {}),
  };
}

/** 创建一份空模型生成器组件，供新实体和旧场景兜底使用。 */
export function createDefaultModelGeneratorComponent(): ModelGeneratorComponent {
  return {
    defaultTarget: null,
    rules: [],
    metadataTtlSeconds: MODEL_GENERATOR_DEFAULT_TTL_SECONDS,
    fetchBindings: [],
    dataSource: 'mqtt',
  };
}

/** 从导入模型资产创建 kind:model 目标，保留包路径、缩略图与完整模型模板。 */
export function createModelGeneratorTargetFromAsset(asset: ModelGeneratorSourceAsset): ModelGeneratorModelTarget | null {
  if (asset.kind !== 'model' || asset.libraryKind !== 'model') return null;
  const modelAsset = createModelAssetTemplateFromAsset(asset);
  if (!modelAsset) return null;

  return {
    kind: 'model',
    assetId: asset.id,
    displayName: asset.displayName?.trim() || asset.name.trim() || '导入模型',
    ...(asset.packagePath ? { packagePath: asset.packagePath } : {}),
    ...(asset.thumbnailUrl?.startsWith(AUTHORIZED_MODEL_GENERATOR_ASSET_URL_PREFIX) ? { thumbnailUrl: asset.thumbnailUrl } : {}),
    modelAsset,
  };
}

/** 从内置 Mesh 创建 kind:mesh 目标。 */
export function createMeshModelGeneratorTarget(meshKind: MeshKind, displayName?: string): ModelGeneratorTarget {
  return {
    kind: 'mesh',
    meshKind,
    displayName: displayName?.trim() || (meshKind.charAt(0).toUpperCase() + meshKind.slice(1)),
    materialColor: '#8ab4f8',
  };
}

/** 深拷贝模型生成器目标，避免目标模板在调用方之间共享引用。 */
export function cloneModelGeneratorTarget(target: ModelGeneratorTarget): ModelGeneratorTarget {
  return cloneJsonValue(target);
}

/** 深拷贝模型生成器组件，避免规则、绑定和目标数组被外部直接修改。 */
export function cloneModelGeneratorComponent(component: ModelGeneratorComponent): ModelGeneratorComponent {
  return cloneJsonValue(component);
}

/** 清理单个模型生成目标；非法导入模板或未知内置类型会被过滤。 */
export function sanitizeModelGeneratorTarget(value: unknown): ModelGeneratorTarget | null {
  if (value === null) return null;
  if (!isPlainObject(value)) return null;

  if (value.kind === 'model') {
    const assetId = sanitizeId(value.assetId);
    const modelAsset = sanitizeModelAssetTemplate(value.modelAsset);
    if (!assetId || !modelAsset) return null;
    const thumbnailUrl = sanitizeText(value.thumbnailUrl, 1024);
    const packagePath = sanitizeText(value.packagePath, 1024);

    return {
      kind: 'model',
      assetId,
      displayName: sanitizeDisplayName(value.displayName, '导入模型'),
      ...(packagePath ? { packagePath } : {}),
      ...(thumbnailUrl && isAuthorizedEditorAssetUrl(thumbnailUrl) ? { thumbnailUrl } : {}),
      modelAsset,
    };
  }

  if (value.kind === 'mesh') {
    if (value.meshKind !== 'cube' && value.meshKind !== 'sphere' && value.meshKind !== 'plane') return null;
    const materialColor = sanitizeText(value.materialColor, 16);
    if (!/^#[0-9a-fA-F]{6}$/.test(materialColor)) return null;
    return {
      kind: 'mesh',
      meshKind: value.meshKind,
      displayName: sanitizeDisplayName(value.displayName, '内置模型'),
      materialColor,
    };
  }

  return null;
}

/** 清理生成规则，目标允许为 null 以保存未选择目标的规则草稿。 */
export function sanitizeModelGeneratorRule(value: unknown): ModelGeneratorRule | null {
  if (!isPlainObject(value)) return null;
  const id = sanitizeId(value.id);
  if (!id) return null;

  return {
    id,
    attributeName: sanitizeText(value.attributeName),
    attributeValue: sanitizeText(value.attributeValue),
    target: sanitizeModelGeneratorTarget(value.target),
  };
}

/** 清理 fetch 定位线框绑定，只保留 id 和 assetCode。 */
export function sanitizeModelGeneratorFetchBinding(value: unknown): ModelGeneratorFetchBinding | null {
  if (!isPlainObject(value)) return null;
  const id = sanitizeId(value.id);
  if (!id) return null;

  return {
    id,
    assetCode: sanitizeText(value.assetCode, 128),
  };
}

/** 清理完整模型生成器组件，限制规则和绑定数量并过滤非法目标。 */
export function sanitizeModelGeneratorComponent(value: unknown): ModelGeneratorComponent | null {
  if (!isPlainObject(value)) return null;
  const rules = Array.isArray(value.rules)
    ? value.rules.slice(0, MODEL_GENERATOR_MAX_RULES).map(sanitizeModelGeneratorRule).filter((rule): rule is ModelGeneratorRule => Boolean(rule))
    : [];
  const fetchBindings = Array.isArray(value.fetchBindings)
    ? value.fetchBindings.slice(0, MODEL_GENERATOR_MAX_BINDINGS).map(sanitizeModelGeneratorFetchBinding).filter((b): b is ModelGeneratorFetchBinding => Boolean(b))
    : [];

  return {
    defaultTarget: sanitizeModelGeneratorTarget(value.defaultTarget),
    rules,
    metadataTtlSeconds: sanitizeModelGeneratorMetadataTtlSeconds(value.metadataTtlSeconds),
    fetchBindings,
    dataSource: value.dataSource === 'fetch' ? 'fetch' : 'mqtt',
  };
}

/** 为目标生成稳定签名，供外部缓存和调试识别同一目标。 */
export function createModelGeneratorTargetSignature(target: ModelGeneratorTarget): string {
  if (target.kind === 'mesh') {
    return JSON.stringify({
      kind: target.kind,
      meshKind: target.meshKind,
      materialColor: target.materialColor,
    });
  }

  return JSON.stringify({
    kind: target.kind,
    assetId: target.assetId,
    sourcePath: target.modelAsset.sourcePath,
    sourceUrl: target.modelAsset.sourceUrl,
    assetRevision: target.modelAsset.assetRevision ?? null,
  });
}

/** 将 kind:model 目标转换成运行时 ModelAssetComponent；kind:mesh 没有模型资产，返回 null。 */
export function createRuntimeModelAssetFromTarget(target: ModelGeneratorTarget, assetCode: string): ModelAssetComponent | null {
  if (target.kind !== 'model') return null;
  const normalizedAssetCode = assetCode.trim();
  if (!normalizedAssetCode) return null;
  return {
    assetCode: normalizedAssetCode,
    ...cloneJsonValue(target.modelAsset),
  };
}
