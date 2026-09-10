import { getClickEventModelResourceKey } from './clickEventModelIdentity.js';
import { collectPublishModelReferences } from './publishModelRecovery.js';
import { getRequiredEnvironmentResourceIds } from './sceneEnvironmentReferences.js';

export type DataPlatformModelIdentity = {
  sourceKey: string;
  kind: 'model' | 'combo';
  resourceId: string;
  modelPath: string;
};
export type SceneModelUpdateItem = Omit<DataPlatformModelIdentity, 'sourceKey'> & {
  sourceUrls: string[];
  /** 历史来源或缺失身份只作为查询线索，需当前中台确认成功后再回填。 */
  sourceMigration?: boolean;
  variants?: Array<{ modelPath: string; sourceUrls: string[] }>;
};
export type SceneModelUpdateIssue = { resourceKind: 'model' | 'combo' | 'environment'; resourceId?: string; message: string };
export type SceneModelCatalogEntry = { kind: 'model' | 'combo'; resourceId: string; name: string; fileName: string };

/** 同步落盘和历史名称匹配共用，避免非法字符、长名称或 Windows 保留名造成关联失败。 */
export function sanitizeSceneModelPackageName(value: string): string {
  const normalized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 80) || '未命名';
  const stem = normalized.split('.', 1)[0]?.toUpperCase() ?? '';
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem) ? `_${normalized}` : normalized;
}

function normalizeResourceName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\.(?:glb|gltf)$/i, '')
    .replace(/[-_\s]+场景保留版$/, '').trim().toLowerCase();
}

/** 仅原 ID 被中台明确判定不存在时使用；名称和主文件必须共同唯一匹配，不能猜测子模型。 */
export function findCurrentSceneModelReplacement(item: SceneModelUpdateItem, catalog: readonly SceneModelCatalogEntry[]): SceneModelUpdateItem {
  const restored = catalog.filter(record => record.kind === item.kind && record.resourceId === item.resourceId);
  if (restored.length === 1) return item;
  if (restored.length > 1) throw new Error(`模型 ${item.kind}:${item.resourceId} 在当前中台存在重复 ID。`);
  const paths = new Set(item.variants?.map(variant => variant.modelPath) ?? [item.modelPath]);
  if (paths.size !== 1 || item.modelPath.includes('/')) throw new Error(`历史模型 ${item.kind}:${item.resourceId} 已不存在，包内子模型不能自动改绑其他资源。`);
  const names = new Set<string>();
  for (const url of item.sourceUrls) {
    if (!url.startsWith('editor-asset://local/')) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(url.slice('editor-asset://local/'.length).split(/[?#]/, 1)[0]).replace(/\\/g, '/'); }
    catch { continue; }
    const match = /(?:^|\/)(model|combo)-([1-9]\d{0,63})-([^/]+)\//i.exec(decoded);
    if (!match || match[1].toLowerCase() !== item.kind || match[2] !== item.resourceId) continue;
    // 固定版本目录最后的 12 位是编辑器布局哈希，不属于资源名。
    const name = /\/scene-model-versions\/[a-f0-9]{64}\/[a-f0-9]{64}\//i.test(decoded)
      ? match[3].replace(/-[a-f0-9]{12}$/i, '') : match[3];
    const normalized = normalizeResourceName(name);
    if (normalized) names.add(normalized);
  }
  const candidates = catalog.filter(record => record.kind === item.kind
    && record.name.trim() && names.has(normalizeResourceName(sanitizeSceneModelPackageName(record.name)))
    && record.fileName.normalize('NFKC').trim().toLowerCase() === item.modelPath.normalize('NFKC').toLowerCase());
  if (candidates.length !== 1) throw new Error(`历史模型 ${item.kind}:${item.resourceId} 已不存在，当前中台按资源名和主文件匹配到 ${candidates.length} 个候选，不能自动替换。`);
  return { ...item, resourceId: candidates[0].resourceId, sourceMigration: true };
}

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
  /** 按当前中台查询历史资源 ID；返回候选不等于已完成来源确认。 */
  resolveAgainstCurrentSource?: boolean;
  /** 未绑定场景无法从项目绑定确认历史资源来源。 */
  requireSourceIdentity?: boolean;
  onIssue?: (issue: SceneModelUpdateIssue) => void;
} = {}): SceneModelUpdateItem[] {
  const { models, devices } = collectPublishModelReferences(scene);
  const references = [...models.map(reference => reference.asset), ...devices];
  const requireSourceIdentity = options.requireSourceIdentity === true && !options.resolveAgainstCurrentSource;
  // 点击设备模板没有独立身份字段时，只能借用同一个完整 URL 的明确身份证据。
  const identitiesByUrl = new Map<string, { identity?: DataPlatformModelIdentity; error?: Error }>();
  if (requireSourceIdentity) for (const asset of references) {
    if (asset.dataPlatformModel === undefined) continue;
    const key = String(asset.sourceUrl);
    const proof = identitiesByUrl.get(key) ?? {};
    if (proof.error) continue;
    try {
      const candidate = normalizeDataPlatformModelIdentity(asset.dataPlatformModel)!;
      const identity = proof.identity;
      if (identity && (candidate.sourceKey !== identity.sourceKey || candidate.kind !== identity.kind
        || candidate.resourceId !== identity.resourceId || candidate.modelPath !== identity.modelPath)) {
        throw new Error('同一模型 URL 的来源身份冲突，已保留整个资源组。');
      }
      proof.identity = candidate;
    } catch (error) {
      proof.error = error instanceof Error ? error : new Error(String(error));
    }
    identitiesByUrl.set(key, proof);
  }
  const plan = new Map<string, SceneModelUpdateItem>();
  const blocked = new Set<string>();
  for (const asset of references) {
    const pathKey = getClickEventModelResourceKey(asset.sourceUrl);
    const [pathKind, pathId] = pathKey?.split(':') ?? [];
    const resourceKey = pathKey ? `${pathKind}:${pathId}` : undefined;
    if (resourceKey && blocked.has(resourceKey)) continue;
    try {
      const proof = requireSourceIdentity ? identitiesByUrl.get(String(asset.sourceUrl)) : undefined;
      if (proof?.error) throw proof.error;
      const identity = requireSourceIdentity ? proof?.identity : normalizeDataPlatformModelIdentity(asset.dataPlatformModel);
      if (pathKey && !identity && requireSourceIdentity) throw new Error('场景模型缺少数据中台来源身份，无法确认与当前配置同源，已保留原模型。');
      if (identity && identity.sourceKey !== sourceKey && !options.allowSourceRebind && !options.resolveAgainstCurrentSource) throw new Error('场景模型的数据中台来源与当前项目不一致，请核对模型来源后同步。');
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
      if (previous && previous.modelPath !== modelPath && !previous.variants) {
        previous.variants = [{ modelPath: previous.modelPath, sourceUrls: [...previous.sourceUrls] }];
      }
      const item: SceneModelUpdateItem = previous ?? { kind, resourceId, modelPath, sourceUrls: [] };
      if (options.resolveAgainstCurrentSource && (!identity || identity.sourceKey !== sourceKey)) item.sourceMigration = true;
      const sourceUrl = String(asset.sourceUrl);
      if (item.variants) {
        let variant = item.variants.find(candidate => candidate.modelPath === modelPath);
        if (!variant) { variant = { modelPath, sourceUrls: [] }; item.variants.push(variant); }
        if (!variant.sourceUrls.includes(sourceUrl)) variant.sourceUrls.push(sourceUrl);
      }
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
  return plan.flatMap(group => (group.variants ?? [{ modelPath: group.modelPath, sourceUrls: group.sourceUrls }]).map(variant => {
    const item = { ...group, ...variant };
    const candidates = byResource.get(`${item.kind}:${item.resourceId}`) ?? [];
    const exact = candidates.filter(candidate => candidate.modelPath === item.modelPath);
    const chosen = exact.length === 1 ? exact[0] : candidates.length === 1
      && !item.modelPath.includes('/') && !candidates[0].modelPath.includes('/') ? candidates[0] : null;
    if (!chosen) throw new Error(`模型 ${item.kind}:${item.resourceId} 的包内模型 ${item.modelPath} 缺失或存在变体歧义，原场景保持不变。`);
    return { sourceUrls: item.sourceUrls, asset: chosen.asset };
  }));
}
