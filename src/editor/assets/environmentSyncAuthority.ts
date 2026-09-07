import type { ProjectModelAssetEntry } from './AssetDatabase';
import type { SceneEnvironmentSettings } from '../model/SceneDocument';

/** 绑定中台是资源权威；只按同来源稳定ID选择唯一资源，不以名称或旧路径兜底。 */
export function findAuthoritativeEnvironmentAsset(
  assets: ProjectModelAssetEntry[], sourceKey: string, resourceId: string | undefined,
): ProjectModelAssetEntry | null {
  if (!resourceId) return null;
  const matches = assets.filter((asset) => asset.libraryKind === 'environment'
    && asset.dataPlatformSourceKey === sourceKey && asset.dataPlatformResourceId === resourceId);
  return matches.length === 1 ? matches[0] : null;
}

/** 缓存失效标记只进入运行时URL，不改变场景资源身份或持久化配置。 */
export function environmentForSyncRun(environment: SceneEnvironmentSettings, runId?: string): SceneEnvironmentSettings {
  if (!runId) return environment;
  const versionUrl = (value: string) => {
    const url = new URL(value);
    url.searchParams.set('assetRevision', `${url.searchParams.get('assetRevision') ?? ''}:${runId}`);
    return url.toString();
  };
  return { ...environment, activeVariantUrl: versionUrl(environment.activeVariantUrl),
    variants: environment.variants.map((variant) => ({ ...variant, sourceUrl: versionUrl(variant.sourceUrl) })) };
}
