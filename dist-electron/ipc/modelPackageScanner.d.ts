import type { AssetEntry, ImportModelFolderSkippedEntry } from '../types.js';
type ModelPackageScanResult = {
    asset?: AssetEntry;
    skipped?: ImportModelFolderSkippedEntry;
};
export declare function scanModelPackage(packagePath: string): Promise<ModelPackageScanResult>;
export declare function scanModelFolder(rootPath: string): Promise<{
    assets: AssetEntry[];
    skipped: ImportModelFolderSkippedEntry[];
}>;
export {};
