import type { AssetEntry, ImportModelFolderSkippedEntry, ModelAssetLibraryKind, ProjectAssetIndex, ProjectModelAssetEntry, ProjectListAssetsResult, RecentWorkspacesResult } from '../types.js';
type ImportModelPackagesIntoProjectResult = {
    importedAssets: ProjectModelAssetEntry[];
    projectAssets: ProjectModelAssetEntry[];
    skipped: ImportModelFolderSkippedEntry[];
};
export declare function getCurrentProjectRoot(): string | null;
export declare function setCurrentProjectRoot(projectRoot: string): void;
export declare function getRecentWorkspaces(): Promise<RecentWorkspacesResult>;
export declare function rememberRecentProjectRoot(projectRoot: string, lastScenePath?: string): Promise<void>;
export declare function rememberRecentSceneFile(filePath: string, projectRoot?: string | null): Promise<void>;
export declare function assertRecentSceneFile(filePath: string): Promise<string>;
export declare function removeRecentWorkspaceItem(kind: 'project' | 'scene', itemPath: string): Promise<void>;
export declare function activateProjectRoot(projectRoot: string, lastScenePath?: string): Promise<ProjectListAssetsResult>;
export declare function openRecentProject(projectRoot: string): Promise<ProjectListAssetsResult>;
export declare function getProjectModelsRoot(projectRoot: string): string;
/** 返回项目环境模型目录 Assets/Environments。 */
export declare function getProjectEnvironmentsRoot(projectRoot: string): string;
export declare function getProjectAssetIndexPath(projectRoot: string): string;
/** 确保项目元数据、普通模型与环境模型目录都已创建。 */
export declare function ensureProjectDirectories(projectRoot: string): Promise<void>;
/** 读取项目资产索引，兼容 v1 并返回 v2 内存结构，不在读取时写回。 */
export declare function readProjectAssetIndex(projectRoot: string): Promise<ProjectAssetIndex>;
/** 写入 v2 项目资产索引，调用方需传入已分类的项目模型资产。 */
export declare function writeProjectAssetIndex(projectRoot: string, index: ProjectAssetIndex): Promise<void>;
export declare function toSafePackageDirectoryName(name: string): string;
export declare function copyDirectory(source: string, target: string): Promise<void>;
export declare function ensureCurrentProjectRootWithDialog(): Promise<string | null>;
export declare function selectCurrentProjectRootWithDialog(): Promise<string | null>;
export declare function listProjectAssets(): Promise<ProjectListAssetsResult>;
/**
 * 将用户选择的单个环境 GLB 保存为项目内独立单文件包，并写入环境分库索引。
 * 旧环境模型包仍保留原有索引结构；只有同目标包或同资产路径的环境记录会被替换。
 */
export declare function importEnvironmentModelFileIntoProject(sourceFilePath: string): Promise<{
    importedAsset: ProjectModelAssetEntry;
    projectAssets: ProjectModelAssetEntry[];
}>;
/** 将扫描到的模型包复制进指定项目资产库，并只替换目标库中的同名记录。 */
export declare function importModelPackagesIntoProject(scannedAssets: AssetEntry[], libraryKind: ModelAssetLibraryKind): Promise<ImportModelPackagesIntoProjectResult>;
export {};
