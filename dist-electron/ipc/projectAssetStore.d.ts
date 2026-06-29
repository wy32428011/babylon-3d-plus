import type { AssetEntry, ImportModelFolderSkippedEntry, ProjectAssetIndex, ProjectListAssetsResult } from '../types.js';
type ImportModelPackagesIntoProjectResult = {
    assets: AssetEntry[];
    skipped: ImportModelFolderSkippedEntry[];
};
export declare function getCurrentProjectRoot(): string | null;
export declare function setCurrentProjectRoot(projectRoot: string): void;
export declare function getProjectModelsRoot(projectRoot: string): string;
export declare function getProjectAssetIndexPath(projectRoot: string): string;
export declare function ensureProjectDirectories(projectRoot: string): Promise<void>;
export declare function readProjectAssetIndex(projectRoot: string): Promise<ProjectAssetIndex>;
export declare function writeProjectAssetIndex(projectRoot: string, index: ProjectAssetIndex): Promise<void>;
export declare function toSafePackageDirectoryName(name: string): string;
export declare function copyDirectory(source: string, target: string): Promise<void>;
export declare function ensureCurrentProjectRootWithDialog(): Promise<string | null>;
export declare function listProjectAssets(): Promise<ProjectListAssetsResult>;
export declare function importModelPackagesIntoProject(scannedAssets: AssetEntry[]): Promise<ImportModelPackagesIntoProjectResult>;
export {};
