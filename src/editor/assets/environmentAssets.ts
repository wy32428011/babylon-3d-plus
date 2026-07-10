import type { AssetEntry } from './AssetDatabase';
import {
  sanitizeSceneEnvironment,
  type SceneEnvironmentSettings,
  type SceneEnvironmentVariant,
} from '../model/SceneDocument';

type ModelPackageVariant = {
  name: string;
  path: string;
  sourceUrl: string;
};

/** 根据模型资产生成最小可用的环境效果变体，保证非模型包资产也能作为环境底座使用。 */
export function createFallbackEnvironmentVariant(asset: AssetEntry): SceneEnvironmentVariant {
  return {
    name: asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, '') || '默认预设',
    sourcePath: asset.path,
    sourceUrl: asset.sourceUrl,
  };
}

/** 将项目模型资产和包内变体转换为场景级环境配置，并复用 SceneDocument 的安全归一化规则。 */
export function createEnvironmentFromAsset(
  asset: AssetEntry,
  variants: SceneEnvironmentVariant[],
): SceneEnvironmentSettings | null {
  const safeVariants = variants.length > 0 ? variants : [createFallbackEnvironmentVariant(asset)];

  return sanitizeSceneEnvironment({
    packagePath: asset.packagePath ?? asset.path,
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
