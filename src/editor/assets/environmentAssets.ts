import type { AssetEntry } from './AssetDatabase';
import {
  sanitizeSceneEnvironment,
  type SceneEnvironmentSettings,
  type SceneEnvironmentVariant,
} from '../model/SceneDocument';
import { createModelLengthUnitInfo } from '../model/sceneUnits';

type ModelPackageVariant = {
  name: string;
  path: string;
  sourceUrl: string;
};

/** 把资产导入版本写入环境 URL 查询参数，同路径覆盖后也能触发配置判等和 Babylon 重载。 */
function createVersionedEnvironmentSourceUrl(sourceUrl: string, assetRevision: string | undefined): string {
  const normalizedRevision = assetRevision?.trim();
  if (!normalizedRevision) return sourceUrl;

  try {
    const parsed = new URL(sourceUrl);
    parsed.searchParams.set('assetRevision', normalizedRevision);
    return parsed.toString();
  } catch {
    return sourceUrl;
  }
}

/** 根据模型资产生成最小可用的环境效果变体，保证非模型包资产也能作为环境底座使用。 */
export function createFallbackEnvironmentVariant(asset: AssetEntry): SceneEnvironmentVariant {
  return {
    name: asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, '') || '默认预设',
    sourcePath: asset.path,
    sourceUrl: createVersionedEnvironmentSourceUrl(asset.sourceUrl, asset.assetRevision),
  };
}

/** 将项目模型资产和包内变体转换为场景级环境配置，并复用 SceneDocument 的安全归一化规则。 */
export function createEnvironmentFromAsset(
  asset: AssetEntry,
  variants: SceneEnvironmentVariant[],
): SceneEnvironmentSettings | null {
  const sourceVariants = variants.length > 0 ? variants : [createFallbackEnvironmentVariant(asset)];
  const unitInfo = createModelLengthUnitInfo(asset.lengthUnit);
  const safeVariants = sourceVariants.map((variant) => ({
    ...variant,
    sourceUrl: createVersionedEnvironmentSourceUrl(variant.sourceUrl, asset.assetRevision),
  }));

  return sanitizeSceneEnvironment({
    packagePath: asset.packagePath ?? asset.path,
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    thumbnailUrl: asset.thumbnailUrl,
    activeVariantUrl: safeVariants[0].sourceUrl,
    variants: safeVariants,
  });
}

/** 读取模型包内的环境效果变体；读取失败交给调用方展示具体错误。 */
export async function loadEnvironmentVariantsFromAsset(asset: AssetEntry): Promise<SceneEnvironmentVariant[]> {
  if (!asset.packagePath || !window.editorApi?.listModelPackageVariants) {
    return [createFallbackEnvironmentVariant(asset)];
  }

  const result: ModelPackageVariant[] = await window.editorApi.listModelPackageVariants({
    packagePath: asset.packagePath,
  });

  if (result.length === 0) {
    return [createFallbackEnvironmentVariant(asset)];
  }

  return result.map((variant) => ({
    name: variant.name,
    sourcePath: variant.path,
    sourceUrl: variant.sourceUrl,
  }));
}

/** 从项目环境资产创建完整环境配置，非 environment 分库资产直接拒绝，形成跨库防御边界。 */
export async function loadEnvironmentFromAsset(asset: AssetEntry): Promise<SceneEnvironmentSettings | null> {
  if (asset.libraryKind !== 'environment') return null;

  const variants = await loadEnvironmentVariantsFromAsset(asset);
  return createEnvironmentFromAsset(asset, variants);
}
