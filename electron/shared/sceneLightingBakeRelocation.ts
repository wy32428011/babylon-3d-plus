import { getSceneLightingBakeSignature, lightingContentHash, validateSceneLightingBakeSnapshot } from './sceneLightingBakeContract.js';
import { normalizeSceneLightingPolicy } from './sceneLightingPolicy.js';
import { getSceneLightingConfig, migrateSceneLightingDocument } from './sceneLightingConfig.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const REFERENCE_KEYS = new Set(['sourcePath', 'sourceUrl', 'packagePath', 'metadataPath', 'thumbnailPath', 'thumbnailUrl', 'activeVariantUrl', 'manifestUrl', 'assetUrl', 'url', 'path', 'scriptPaths']);

/** 完整资源身份已决定匹配语义，旧缓存地址只是运输提示，不能变成发布必需文件。 */
export function stripLightingPolicyIdentityLocationHints(value: unknown): void {
  const settings = object(object(value).sceneSettings);
  const rules = object(Object.hasOwn(settings, 'lighting') ? object(settings.lighting).policy : settings.lightingPolicy).rules;
  if (!Array.isArray(rules)) return;
  for (const raw of rules) {
    const target = object(object(raw).target);
    if (target.kind !== 'resource') continue;
    const model = object(target.model);
    const normalized = normalizeSceneLightingPolicy({
      version: 1, defaults: {},
      rules: [{ id: 'transport-reference', enabled: true, target: { kind: 'resource', model }, values: {} }],
    })?.rules[0]?.target;
    if (normalized?.kind !== 'resource' || !normalized.model.identity) continue;
    // 仅移除不参与身份匹配的两项；保留原始扩展字段、规则顺序、节点绑定和所有值。
    delete model.sourcePath;
    delete model.sourceUrl;
  }
}

/** 只比较受控资源搬迁：保留目录以下身份、版本和真实参数，普通参数文本不视作路径。 */
export function normalizeLightingBakeResourceLocations(value: unknown, field = '', parameterValue = false): unknown {
  if (typeof value === 'string') {
    const isUrl = value.startsWith('editor-asset://local/');
    if (!isUrl && (parameterValue || !REFERENCE_KEYS.has(field))) return value;
    let reference = value, suffix = '';
    if (isUrl) {
      try {
        const parsed = new URL(value);
        reference = decodeURIComponent(parsed.pathname.slice(1));
        suffix = parsed.search + parsed.hash;
      } catch { return value; }
    } else if (/^[a-z][a-z\d+.-]*:/i.test(reference) && !/^[a-z]:[\\/]/i.test(reference)) return value;
    reference = reference.replace(/\\/g, '/').replace(/\/$/, '');
    const cachedEnvironment = /(?:^|\/)\.babylon-editor\/data-platform-cache\/environments\/[^/]+\/([^/]+)\/[^/]+(?:\/(.*))?$/i.exec(reference);
    if (cachedEnvironment) return 'Assets/Environments/Env-' + cachedEnvironment[1] + (cachedEnvironment[2] ? '/' + cachedEnvironment[2] : '');
    const portable = /(?:^|\/)(Assets\/(?:Models|Environments|Skyboxes|Cad|Images|Compositions|OpeningPackages|OpeningAssets|LightingBakes)(?:\/.*|$))/i.exec(reference);
    if (!portable || portable[1].split('/').includes('..')) return value;
    // 环境版本由修订字段和受控缓存校验确定，SOURCE 的环境 URL 不保留缓存查询参数。
    return portable[1] + (/^Assets\/Environments\//i.test(portable[1]) ? '' : suffix);
  }
  if (Array.isArray(value)) return value.map(item => normalizeLightingBakeResourceLocations(item, field, parameterValue));
  if (value !== null && typeof value === 'object') {
    const snapshot = object(value);
    const fixedComposition = field === 'sourceSnapshot' && snapshot.composition === true
      && typeof snapshot.contentSha256 === 'string' && /^[a-f\d]{64}$/i.test(snapshot.contentSha256);
    return Object.fromEntries(Object.entries(value).filter(([key]) => !fixedComposition || key !== 'compositionResource').map(([key, child]) => [
      key, normalizeLightingBakeResourceLocations(child, key, parameterValue || key === 'parameterValues'),
    ]));
  }
  return value;
}

/** 输入与产物均需等价；已经过期的结果不会因为另存为或换工作区被重新签成有效。 */
export function captureSceneLightingBakeRelocation(value: unknown): ((relocated: unknown) => boolean) | null {
  const original = migrateSceneLightingDocument(object(value));
  const result = validateSceneLightingBakeSnapshot(original.sceneSettings.lighting.result);
  if (!result || !result.signature.startsWith('lighting-v2-') || result.signature !== getSceneLightingBakeSignature(original)) return null;
  const expectedInput = getSceneLightingBakeSignature(normalizeLightingBakeResourceLocations(original));
  const expectedResult = lightingContentHash(normalizeLightingBakeResourceLocations({ ...result, signature: undefined }));
  return relocated => {
    const canonical = migrateSceneLightingDocument(object(relocated));
    const targetSettings = canonical.sceneSettings;
    const target = validateSceneLightingBakeSnapshot(targetSettings.lighting.result);
    if (!target || target.signature !== result.signature
      || getSceneLightingBakeSignature(normalizeLightingBakeResourceLocations(canonical)) !== expectedInput
      || lightingContentHash(normalizeLightingBakeResourceLocations({ ...target, signature: undefined })) !== expectedResult) return false;
    object(relocated).sceneSettings = { ...targetSettings, lighting: { ...targetSettings.lighting,
      result: { ...getSceneLightingConfig(canonical).result!, signature: getSceneLightingBakeSignature(canonical) } } };
    return true;
  };
}

/** 部署目录可以改名；只有本轮实际资源清单中的一对一地址重写允许逆向比较。 */
export function restoreSceneLightingBakeAfterMappedRewrite(
  original: unknown,
  rewritten: unknown,
  referenceMap: ReadonlyMap<string, string>,
): boolean {
  const source = migrateSceneLightingDocument(object(original));
  const restore = captureSceneLightingBakeRelocation(source);
  if (!restore) return false;
  const canonical = migrateSceneLightingDocument(object(rewritten));
  const comparison = structuredClone(canonical);
  const invert = (before: unknown, after: unknown, parameterValue = false): unknown => {
    if (typeof before === 'string' && typeof after === 'string' && referenceMap.get(before) === after) return before;
    if (Array.isArray(before) && Array.isArray(after)) return after.map((item, index) => invert(before[index], item, parameterValue));
    if (!before || typeof before !== 'object' || !after || typeof after !== 'object') return after;
    const source = before as JsonObject, target = after as JsonObject;
    for (const [key, item] of Object.entries(target)) target[key] = invert(source[key], item, parameterValue || key === 'parameterValues');
    // 这些字段只用于编辑器索引/缩略图；真实资源 URL、内容快照和全部参数仍严格比较。
    if (!parameterValue && source.thumbnailUrl !== undefined && target.thumbnailUrl === undefined) target.thumbnailUrl = source.thumbnailUrl;
    if (!parameterValue && source.assetId !== undefined && target.assetId !== source.assetId
      && (source.sourceUrl || source.modelAsset)) target.assetId = source.assetId;
    const sourceSnapshot = object(source.sourceSnapshot), targetSnapshot = object(target.sourceSnapshot);
    if (sourceSnapshot.compositionResource !== undefined && targetSnapshot.compositionResource === undefined
      && sourceSnapshot.contentSha256 === targetSnapshot.contentSha256) targetSnapshot.compositionResource = sourceSnapshot.compositionResource;
    return target;
  };
  if (!restore(invert(source, comparison))) return false;
  const settings = canonical.sceneSettings;
  object(rewritten).sceneSettings = { ...settings, lighting: { ...settings.lighting,
    result: { ...settings.lighting.result!, signature: getSceneLightingBakeSignature(canonical) } } };
  return true;
}
