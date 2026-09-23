import { getClickEventModelResourceKey } from './clickEventModelIdentity.js';
import type { DataPlatformModelIdentity } from './sceneModelUpdatePlan.js';

type ModelSource = { sourcePath?: unknown; sourceUrl?: unknown; dataPlatformModel?: DataPlatformModelIdentity };
type ModelReference = { sourcePath?: unknown; sourceUrl?: unknown; identity?: DataPlatformModelIdentity };

/** 类型引用与生产者共用资源位置规范；缓存修订不改变模型类型。 */
export function modelTypePathKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  let result = value.trim().split(/[?#]/, 1)[0];
  if (result.startsWith('editor-asset://local/')) {
    try { result = decodeURIComponent(result.slice('editor-asset://local/'.length)); }
    catch { return ''; }
  }
  return result.replace(/\\/g, '/').toLowerCase();
}

/** 模型库条目可独立形成身份，不依赖场景中已摆放的模型。 */
export function createModelTypeIdentityFromAsset(asset: { sourceUrl?: unknown; dataPlatformSourceKey?: unknown }): DataPlatformModelIdentity | undefined {
  const sourceKey = asset.dataPlatformSourceKey;
  if (typeof sourceKey !== 'string' || !/^[a-f0-9]{64}$/.test(sourceKey)) return undefined;
  const key = getClickEventModelResourceKey(asset.sourceUrl);
  if (!key) return undefined;
  const [kind, resourceId, ...parts] = key.split(':');
  return { sourceKey, kind: kind as 'model' | 'combo', resourceId, modelPath: parts.join(':') };
}

/** 中台身份优先且必须完整一致，本地模型仅匹配精确资源位置。 */
export function matchesModelTypeReference(asset: ModelSource, reference: ModelReference): boolean {
  if (reference.identity) {
    const identity = asset.dataPlatformModel;
    return !!identity && identity.sourceKey === reference.identity.sourceKey && identity.kind === reference.identity.kind
      && identity.resourceId === reference.identity.resourceId && modelTypePathKey(identity.modelPath) === modelTypePathKey(reference.identity.modelPath);
  }
  const paths = new Set([modelTypePathKey(asset.sourcePath), modelTypePathKey(asset.sourceUrl)].filter(Boolean));
  return [modelTypePathKey(reference.sourcePath), modelTypePathKey(reference.sourceUrl)].some(value => !!value && paths.has(value));
}
