import type { AssetEntry } from './AssetDatabase';
import type { ModelAssetTemplate } from '../model/components';

export type ImportedAssetIndexes = {
  byPath: Map<string, AssetEntry>;
  bySourceUrl: Map<string, AssetEntry>;
  uniqueByPackagePath: Map<string, AssetEntry>;
  uniqueByDataPlatformPackage: Map<string, AssetEntry>;
  uniqueByDataPlatformIdentity: Map<string, AssetEntry>;
  uniqueByDataPlatformLogicalPackage: Map<string, AssetEntry>;
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

/** 提取数据中台生成目录中的稳定“资源类型 + 业务 ID”，模型改名或主文件改名后仍可重新关联。 */
function getDataPlatformPackageMatchKey(modelPath: string | undefined, packagePath?: string): string {
  const packageDirectoryName = getPathBaseName(packagePath ?? getDirectoryPath(modelPath));
  const match = /^(model|env|combo)-(\d+)(?:-|$)/i.exec(packageDirectoryName);
  return match ? `${match[1].toLowerCase()}:${match[2]}` : '';
}


function getDataPlatformIdentityKey(sourceKey: unknown, resourceId: unknown): string {
  return typeof sourceKey === 'string' && /^[0-9a-f]{64}$/.test(sourceKey)
    && typeof resourceId === 'string' && /^[1-9]\d{0,63}$/.test(resourceId)
      ? `${sourceKey}:${resourceId}`
      : '';
}

/**
 * 去除数据中台实例内数据库 ID，只保留资源类型和模型名称。
 * 同一模型迁移到不同数据中台后 ID 可能变化，但同步目录中的名称部分仍可作为唯一兜底键。
 */
function getDataPlatformLogicalPackageMatchKey(modelPath: string | undefined, packagePath?: string): string {
  const packageDirectoryName = getPathBaseName(packagePath ?? getDirectoryPath(modelPath));
  const match = /^(model|env|combo)-\d+-(.+)$/i.exec(packageDirectoryName);
  const logicalName = match?.[2]?.trim();
  return match && logicalName ? `${match[1].toLowerCase()}:${logicalName}` : '';
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
  const dataPlatformPackageAssetLists = new Map<string, AssetEntry[]>();
  const dataPlatformIdentityAssetLists = new Map<string, AssetEntry[]>();
  const dataPlatformLogicalPackageAssetLists = new Map<string, AssetEntry[]>();
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

    const dataPlatformIdentityKey = getDataPlatformIdentityKey(asset.dataPlatformSourceKey, asset.dataPlatformResourceId);
    if (dataPlatformIdentityKey) {
      const identityAssets = dataPlatformIdentityAssetLists.get(dataPlatformIdentityKey) ?? [];
      identityAssets.push(asset);
      dataPlatformIdentityAssetLists.set(dataPlatformIdentityKey, identityAssets);
    }

    const dataPlatformPackageKey = getDataPlatformPackageMatchKey(asset.path, asset.packagePath);
    if (dataPlatformPackageKey) {
      const packageAssets = dataPlatformPackageAssetLists.get(dataPlatformPackageKey) ?? [];
      packageAssets.push(asset);
      dataPlatformPackageAssetLists.set(dataPlatformPackageKey, packageAssets);
    }

    const dataPlatformLogicalPackageKey = getDataPlatformLogicalPackageMatchKey(asset.path, asset.packagePath);
    if (dataPlatformLogicalPackageKey) {
      const packageAssets = dataPlatformLogicalPackageAssetLists.get(dataPlatformLogicalPackageKey) ?? [];
      packageAssets.push(asset);
      dataPlatformLogicalPackageAssetLists.set(dataPlatformLogicalPackageKey, packageAssets);
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
    uniqueByDataPlatformPackage: createUniqueAssetIndex(dataPlatformPackageAssetLists),
    uniqueByDataPlatformIdentity: createUniqueAssetIndex(dataPlatformIdentityAssetLists),
    uniqueByDataPlatformLogicalPackage: createUniqueAssetIndex(dataPlatformLogicalPackageAssetLists),
    uniqueByPortablePackage: createUniqueAssetIndex(portablePackageAssetLists),
  };
}

/** 按完整目录、同中台业务 ID 或跨中台逻辑包名查找唯一模型包，供普通模型和场景环境共同复用。 */
export function findImportedAssetForPackagePath(
  packagePath: string | undefined,
  indexes: ImportedAssetIndexes,
  remoteIdentity?: { sourceKey?: string; resourceId?: string },
): AssetEntry | null {
  const remoteIdentityKey = getDataPlatformIdentityKey(remoteIdentity?.sourceKey, remoteIdentity?.resourceId);
  if (remoteIdentityKey) return indexes.uniqueByDataPlatformIdentity.get(remoteIdentityKey) ?? null;

  const packageMatch = indexes.uniqueByPackagePath.get(normalizeAssetMatchPath(packagePath));
  if (packageMatch) return packageMatch;

  const dataPlatformPackageKey = getDataPlatformPackageMatchKey(undefined, packagePath);
  if (dataPlatformPackageKey) {
    const dataPlatformPackageMatch = indexes.uniqueByDataPlatformPackage.get(dataPlatformPackageKey);
    if (dataPlatformPackageMatch) return dataPlatformPackageMatch;
  }

  const logicalPackageKey = getDataPlatformLogicalPackageMatchKey(undefined, packagePath);
  return logicalPackageKey
    ? indexes.uniqueByDataPlatformLogicalPackage.get(logicalPackageKey) ?? null
    : null;
}

/**
 * 优先按本机精确路径/URL 匹配；数据中台先按业务 ID、再按跨中台唯一逻辑包名关联，其他场景再按便携包标识关联。
 */
export function findImportedAssetForModelAsset(
  modelAsset: ModelAssetTemplate,
  indexes: ImportedAssetIndexes,
): AssetEntry | null {
  const pathMatch = indexes.byPath.get(normalizeAssetMatchPath(modelAsset.sourcePath));
  if (pathMatch) return pathMatch;

  const sourceUrlMatch = indexes.bySourceUrl.get(modelAsset.sourceUrl.trim());
  if (sourceUrlMatch) return sourceUrlMatch;

  const packageMatch = findImportedAssetForPackagePath(getDirectoryPath(modelAsset.sourcePath), indexes);
  if (packageMatch) return packageMatch;

  const portablePackageMatch = indexes.uniqueByPortablePackage.get(getPortablePackageMatchKey(modelAsset.sourcePath));
  return portablePackageMatch ?? null;
}
