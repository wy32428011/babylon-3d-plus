/**
 * 模型包 meta.json 顶层扩展字段公共契约：
 * 所有与 dataDriven 平级的未知顶层字段统一保存在 metaExtensions，确保跨中台同步、编辑器资产库、场景持久化与运行时脚本全链路透传。
 */
export const MODEL_METADATA_SCHEMA_VERSION = 2 as const;

export type ModelMetaExtensions = Record<string, unknown>;

/** 已由专用字段承载或仅用于模型卡片展示的 meta.json 顶层键，不重复写入 metaExtensions。 */
export const KNOWN_MODEL_META_KEYS: ReadonlySet<string> = new Set([
  'lengthUnit',
  'thumbnail',
  'cover',
  'modelParameters',
  'parameterScripts',
  'animationScripts',
  'runtimeCapabilities',
  'dataDriven',
  'builtInSlotBinding',
  'layerChangePlatformBinding',
  'cargoContact',
]);

const DISALLOWED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_META_EXTENSION_DEPTH = 16;
const MAX_META_EXTENSION_TOP_LEVEL_KEYS = 128;
const MAX_META_EXTENSION_NODES = 8192;
const MAX_META_EXTENSION_BYTES = 512 * 1024;
const INVALID_OR_OVERSIZE = Symbol('meta-extension-invalid');
const OMIT_VALUE = Symbol('meta-extension-omit');

/** 判断值是否为普通键值对象（允许 null 原型），用于安全过滤非对象扩展配置。 */
export function isPlainMetaRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareCodePoint(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function cloneSerializableJsonValue(
  value: unknown,
  depth: number,
  state: { nodes: number },
): unknown | typeof INVALID_OR_OVERSIZE | typeof OMIT_VALUE {
  state.nodes += 1;
  if (depth > MAX_META_EXTENSION_DEPTH || state.nodes > MAX_META_EXTENSION_NODES) {
    return INVALID_OR_OVERSIZE;
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return OMIT_VALUE;
    return Object.is(value, -0) ? 0 : value;
  }
  if (
    value === undefined
    || typeof value === 'function'
    || typeof value === 'symbol'
    || typeof value === 'bigint'
  ) {
    return OMIT_VALUE;
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !('value' in descriptor)) {
        result.push(null);
        continue;
      }
      const cloned = cloneSerializableJsonValue(descriptor.value, depth + 1, state);
      if (cloned === INVALID_OR_OVERSIZE) return INVALID_OR_OVERSIZE;
      result.push(cloned === OMIT_VALUE ? null : cloned);
    }
    return result;
  }

  if (!isPlainMetaRecord(value)) {
    return OMIT_VALUE;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort(compareCodePoint);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (DISALLOWED_KEYS.has(key)) continue;
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) continue;
    const cloned = cloneSerializableJsonValue(descriptor.value, depth + 1, state);
    if (cloned === INVALID_OR_OVERSIZE) return INVALID_OR_OVERSIZE;
    if (cloned === OMIT_VALUE) continue;
    Object.defineProperty(result, key, {
      value: cloned,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

/** 规范化与边界校验 meta.json 扩展字段；无有效字段或超出安全上限时返回 undefined。 */
export function normalizeModelMetaExtensions(value: unknown): ModelMetaExtensions | undefined {
  if (!isPlainMetaRecord(value)) return undefined;
  const topDescriptors = Object.getOwnPropertyDescriptors(value);
  const topKeys = Object.keys(topDescriptors).filter((key) => !DISALLOWED_KEYS.has(key));
  if (topKeys.length === 0 || topKeys.length > MAX_META_EXTENSION_TOP_LEVEL_KEYS) {
    return undefined;
  }

  const cloned = cloneSerializableJsonValue(value, 0, { nodes: 0 });
  if (cloned === INVALID_OR_OVERSIZE || cloned === OMIT_VALUE || !isPlainMetaRecord(cloned)) {
    return undefined;
  }
  if (Object.keys(cloned).length === 0) {
    return undefined;
  }

  const serialized = JSON.stringify(cloned);
  if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_META_EXTENSION_BYTES) {
    return undefined;
  }
  return cloned;
}

/** 从原始 meta.json 对象提取所有未知顶层扩展字段（与 dataDriven 平级）。 */
export function extractModelMetaExtensions(rawMetadata: unknown): ModelMetaExtensions | undefined {
  if (!isPlainMetaRecord(rawMetadata)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(rawMetadata);
  const candidate: Record<string, unknown> = {};
  for (const key of Object.keys(descriptors)) {
    if (KNOWN_MODEL_META_KEYS.has(key) || DISALLOWED_KEYS.has(key)) continue;
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) continue;
    Object.defineProperty(candidate, key, {
      value: descriptor.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return normalizeModelMetaExtensions(candidate);
}

/** 生成可选的 metaExtensions 属性片段，保持无扩展字段旧资产零额外属性。 */
export function modelMetaExtensionsField(value: unknown): { metaExtensions?: ModelMetaExtensions } {
  const normalized = normalizeModelMetaExtensions(value);
  return normalized ? { metaExtensions: normalized } : {};
}
