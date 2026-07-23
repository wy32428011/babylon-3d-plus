import type { AssetEntry } from './AssetDatabase';
import type { ModelAssetTemplate } from '../model/components';

export type ImportedAssetIndexes = {
  byPath: Map<string, AssetEntry>;
  bySourceUrl: Map<string, AssetEntry>;
  uniqueByPackagePath: Map<string, AssetEntry>;
  uniqueByPortablePackage: Map<string, AssetEntry>;
};

/** 归一化导入资产匹配路径，避免 Windows 分隔符和大小写差异影响同包识别。 */
function normalizeAssetMatchPath(value: string | undefined): string {
  return (value ?? '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

/** 从文件路径中取出所在目录。 */
function getDirectoryPath(filePath: string | undefined): string {
  const normalizedPath = (filePath ?? '').trim().replace(/\\/g, '/');
  const separatorIndex = normalizedPath.lastIndexOf('/');
  return separatorIndex > 0 ? normalizedPath.slice(0, separatorIndex) : '';
}

/** 获取已归一化路径的最后一段名称。 */
function getPathBaseName(filePath: string | undefined): string {
  const normalizedPath = normalizeAssetMatchPath(filePath);
  const separatorIndex = normalizedPath.lastIndexOf('/');
  return separatorIndex >= 0 ? normalizedPath.slice(separatorIndex + 1) : normalizedPath;
}

/** 获取模型包完整路径匹配键，优先使用扫描得到的 packagePath。 */
function getAssetPackageMatchPath(asset: AssetEntry): string {
  return normalizeAssetMatchPath(asset.packagePath ?? getDirectoryPath(asset.path));
}

/**
 * 生成可跨电脑迁移的模型包键。
 * 模型导入会保留一级包目录名和主模型文件名，因此不依赖盘符及项目根路径。
 */
function getPortablePackageMatchKey(modelPath: string | undefined, packagePath?: string): string {
  const modelFileName = getPathBaseName(modelPath);
  const packageDirectoryName = getPathBaseName(packagePath ?? getDirectoryPath(modelPath));
  return modelFileName && packageDirectoryName ? `${packageDirectoryName}/${modelFileName}` : '';
}

/** 只保留候选资产唯一的匹配键，歧义键不参与自动重新关联。 */
function createUniqueAssetIndex(candidateLists: Map<string, AssetEntry[]>): Map<string, AssetEntry> {
  const uniqueAssets = new Map<string, AssetEntry>();
  for (const [key, candidates] of candidateLists.entries()) {
    if (candidates.length === 1) uniqueAssets.set(key, candidates[0]);
  }
  return uniqueAssets;
}

/** 为本轮导入的模型资产建立精确路径、完整包目录和跨电脑包标识索引。 */
export function createImportedAssetIndexes(assets: AssetEntry[]): ImportedAssetIndexes {
  const modelAssets = assets.filter((asset) => asset.kind === 'model');
  const byPath = new Map<string, AssetEntry>();
  const bySourceUrl = new Map<string, AssetEntry>();
  const packageAssetLists = new Map<string, AssetEntry[]>();
  const portablePackageAssetLists = new Map<string, AssetEntry[]>();

  for (const asset of modelAssets) {
    const pathKey = normalizeAssetMatchPath(asset.path);
    if (pathKey) byPath.set(pathKey, asset);

    const sourceUrlKey = asset.sourceUrl.trim();
    if (sourceUrlKey) bySourceUrl.set(sourceUrlKey, asset);

    const packageKey = getAssetPackageMatchPath(asset);
    if (packageKey) {
      const packageAssets = packageAssetLists.get(packageKey) ?? [];
      packageAssets.push(asset);
      packageAssetLists.set(packageKey, packageAssets);
    }

    const portablePackageKey = getPortablePackageMatchKey(asset.path, asset.packagePath);
    if (portablePackageKey) {
      const packageAssets = portablePackageAssetLists.get(portablePackageKey) ?? [];
      packageAssets.push(asset);
      portablePackageAssetLists.set(portablePackageKey, packageAssets);
    }
  }

  return {
    byPath,
    bySourceUrl,
    uniqueByPackagePath: createUniqueAssetIndex(packageAssetLists),
    uniqueByPortablePackage: createUniqueAssetIndex(portablePackageAssetLists),
  };
}

/**
 * 优先按本机精确路径/URL 匹配；跨电脑打开场景时，再按唯一的“包目录名 + 主模型文件名”重新关联。
 */
export function findImportedAssetForModelAsset(
  modelAsset: ModelAssetTemplate,
  indexes: ImportedAssetIndexes,
): AssetEntry | null {
  const pathMatch = indexes.byPath.get(normalizeAssetMatchPath(modelAsset.sourcePath));
  if (pathMatch) return pathMatch;

  const sourceUrlMatch = indexes.bySourceUrl.get(modelAsset.sourceUrl.trim());
  if (sourceUrlMatch) return sourceUrlMatch;

  const packageMatch = indexes.uniqueByPackagePath.get(normalizeAssetMatchPath(getDirectoryPath(modelAsset.sourcePath)));
  if (packageMatch) return packageMatch;

  const portablePackageMatch = indexes.uniqueByPortablePackage.get(getPortablePackageMatchKey(modelAsset.sourcePath));
  return portablePackageMatch ?? null;
}
