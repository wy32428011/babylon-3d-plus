import { getClickEventModelResourceKey } from './clickEventModelIdentity.js';
import { collectPublishModelReferences } from './publishModelRecovery.js';
import { getRequiredEnvironmentResourceIds } from './sceneEnvironmentReferences.js';

export type DataPlatformModelIdentity = {
  sourceKey: string;
  kind: 'model' | 'combo';
  resourceId: string;
  modelPath: string;
};
export type SceneModelUpdateItem = Omit<DataPlatformModelIdentity, 'sourceKey'> & { sourceUrls: string[] };
export type SceneModelUpdateIssue = { resourceKind: 'model' | 'combo' | 'environment'; resourceId?: string; message: string };

/** 兼容明确的历史 Env-ID 目录；受管环境缺少身份时不能被当作已同步本地环境。 */
export function getSceneEnvironmentUpdateReference(scene: unknown): { resourceId: string } | undefined {
  const environment = (scene as { sceneSettings?: { environment?: Record<string, unknown> } })?.sceneSettings?.environment;
  if (!environment) return undefined;
  const resourceId = getRequiredEnvironmentResourceIds(scene)?.[0];
  if (resourceId) return { resourceId };
  const identities = new Set<string>();
  for (const value of [environment.packagePath, environment.activeVariantUrl]) {
    if (typeof value !== 'string') continue;
    let decoded: string;
    try { decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]).replace(/\\/g, '/'); } catch { continue; }
    if (decoded.split('/').some(part => part === '..' || part === '.')) throw new Error('环境模型包内引用无效。');
    const id = /(?:^|\/)Env-([1-9]\d{0,63})(?:-[^/]+)?(?:\/|$)/i.exec(decoded)?.[1];
    if (id) identities.add(id);
  }
  if (identities.size === 1) return { resourceId: [...identities][0] };
  if (identities.size > 1 || environment.source === 'data-platform' || environment.dataPlatformResourceId) {
    throw new Error('场景环境模型缺少唯一的数据中台资源身份，请核对后重新同步。');
  }
  return undefined;
}

export function normalizeDataPlatformModelIdentity(value: unknown): DataPlatformModelIdentity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('数据中台模型身份无效。');
  const record = value as Record<string, unknown>;
  if (typeof record.sourceKey !== 'string' || !/^[0-9a-f]{64}$/.test(record.sourceKey)
    || (record.kind !== 'model' && record.kind !== 'combo')
    || typeof record.resourceId !== 'string' || !/^[1-9]\d{0,63}$/.test(record.resourceId)
    || typeof record.modelPath !== 'string' || !/\.(glb|gltf)$/i.test(record.modelPath)
    || /[\\:?#\x00-\x1f]/.test(record.modelPath) || record.modelPath.startsWith('/')
    || record.modelPath.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error('数据中台模型身份或包内引用无效。');
  }
  return { sourceKey: record.sourceKey, kind: record.kind, resourceId: record.resourceId, modelPath: record.modelPath };
}

/** 只查询场景实际引用的中台模型；本地资产不按名称猜测，间接引用也不能漏掉。 */
export function planSceneModelUpdates(scene: unknown, sourceKey: string, options: {
  allowSourceRebind?: boolean;
  onIssue?: (issue: SceneModelUpdateIssue) => void;
} = {}): SceneModelUpdateItem[] {
  const { models, devices } = collectPublishModelReferences(scene);
  const plan = new Map<string, SceneModelUpdateItem>();
  const blocked = new Set<string>();
  for (const asset of [...models.map(reference => reference.asset), ...devices]) {
    const pathKey = getClickEventModelResourceKey(asset.sourceUrl);
    const [pathKind, pathId] = pathKey?.split(':') ?? [];
    const resourceKey = pathKey ? `${pathKind}:${pathId}` : undefined;
    if (resourceKey && blocked.has(resourceKey)) continue;
    try {
      const identity = normalizeDataPlatformModelIdentity(asset.dataPlatformModel);
      if (identity && identity.sourceKey !== sourceKey && !options.allowSourceRebind) throw new Error('场景模型的数据中台来源与当前项目不一致，请核对模型来源后同步。');
      if (!pathKey) {
        if (identity || /(?:model|combo)-[1-9]\d*/i.test(String(asset.sourceUrl))) {
          throw new Error('场景中存在无效的中台模型引用，无法确认资源身份。');
        }
        continue;
      }
      const [kind, resourceId, modelPath] = pathKey.split(':') as ['model' | 'combo', string, string];
      if (identity && (identity.kind !== kind || identity.resourceId !== resourceId
        || identity.modelPath.toLowerCase() !== modelPath)) throw new Error('模型身份与包内引用不一致，已停止更新。');
      const key = `${kind}:${resourceId}`;
      const previous = plan.get(key);
      if (previous && previous.modelPath !== modelPath) throw new Error(`模型 ${key} 引用了多个包内变体，无法自动替换为同一主模型。`);
      const item = previous ?? { kind, resourceId, modelPath, sourceUrls: [] };
      const sourceUrl = String(asset.sourceUrl);
      if (!item.sourceUrls.includes(sourceUrl)) item.sourceUrls.push(sourceUrl);
      plan.set(key, item);
    } catch (error) {
      if (!options.onIssue) throw error;
      // 同一资源任一引用有歧义时整体保留，后续重复实例也不能重新进入计划。
      if (resourceKey) { blocked.add(resourceKey); plan.delete(resourceKey); }
      options.onIssue({ resourceKind: pathKind === 'combo' ? 'combo' : 'model', resourceId: pathId,
        message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (plan.size > 1000) throw new Error('场景引用的模型种类超过 1000 项，请拆分场景后同步。');
  return [...plan.values()];
}

/** 同资源的主文件可以明确改名，子模型必须按原包内路径匹配。 */
export function matchSceneModelUpdates<T extends { sourceUrl: string }>(
  plan: SceneModelUpdateItem[], assets: T[],
): Array<{ sourceUrls: string[]; asset: T }> {
  const byResource = new Map<string, Array<{ asset: T; modelPath: string }>>();
  for (const asset of assets) {
    const key = getClickEventModelResourceKey(asset.sourceUrl);
    if (!key) continue;
    const [kind, resourceId, modelPath] = key.split(':');
    const resourceKey = `${kind}:${resourceId}`;
    const entries = byResource.get(resourceKey) ?? [];
    entries.push({ asset, modelPath });
    byResource.set(resourceKey, entries);
  }
  return plan.map(item => {
    const candidates = byResource.get(`${item.kind}:${item.resourceId}`) ?? [];
    const exact = candidates.filter(candidate => candidate.modelPath === item.modelPath);
    const chosen = exact.length === 1 ? exact[0] : candidates.length === 1
      && !item.modelPath.includes('/') && !candidates[0].modelPath.includes('/') ? candidates[0] : null;
    if (!chosen) throw new Error(`模型 ${item.kind}:${item.resourceId} 的包内模型 ${item.modelPath} 缺失或存在变体歧义，原场景保持不变。`);
    return { sourceUrls: item.sourceUrls, asset: chosen.asset };
  });
}
