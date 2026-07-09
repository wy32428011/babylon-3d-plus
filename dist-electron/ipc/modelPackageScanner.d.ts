import type { AssetEntry, ImportModelFolderSkippedEntry, ModelPackageVariant } from '../types.js';
type ModelPackageScanResult = {
    asset?: AssetEntry;
    skipped?: ImportModelFolderSkippedEntry;
};
export declare function scanModelPackage(packagePath: string): Promise<ModelPackageScanResult>;
/** 列出模型包内所有可作为环境效果切换的 glTF/GLB 变体，并把主模型排在首位。 */
export declare function listModelPackageVariants(packagePath: string): Promise<ModelPackageVariant[]>;
export declare function scanModelFolder(rootPath: string): Promise<{
    assets: AssetEntry[];
    skipped: ImportModelFolderSkippedEntry[];
}>;
export {};
