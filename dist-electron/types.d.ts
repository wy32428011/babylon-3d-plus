export type SceneFilePayload = {
    name: string;
    content: string;
};
export type SaveSceneRequest = {
    suggestedName: string;
    content: string;
};
export type SaveSceneResult = {
    canceled: boolean;
    filePath: string | null;
};
export type LoadSceneResult = {
    canceled: boolean;
    filePath: string | null;
    content: string | null;
};
export type ReadTextFileRequest = {
    filePath: string;
};
export type ReadTextFileResult = {
    filePath: string;
    content: string;
};
export type LoadSceneFileRequest = {
    filePath: string;
};
export type OpenRecentProjectRequest = {
    projectRoot: string;
};
export type RemoveRecentWorkspaceItemRequest = {
    kind: 'project' | 'scene';
    path: string;
};
export type RecentProjectEntry = {
    projectRoot: string;
    displayName: string;
    lastOpenedAt: string;
    exists: boolean;
    assetCount: number;
    lastScenePath?: string;
};
export type RecentSceneEntry = {
    filePath: string;
    displayName: string;
    lastOpenedAt: string;
    exists: boolean;
    projectRoot?: string;
};
export type RecentWorkspacesResult = {
    projects: RecentProjectEntry[];
    scenes: RecentSceneEntry[];
};
export type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';
export type ModelScriptAsset = {
    path: string;
    sourceUrl: string;
    name: string;
};
export type AssetEntry = {
    id: string;
    name: string;
    path: string;
    sourceUrl: string;
    thumbnailPath?: string;
    thumbnailUrl?: string;
    kind: 'folder' | 'model' | 'texture' | 'scene' | 'unknown';
    packagePath?: string;
    metadataPath?: string;
    scriptPaths?: string[];
    scriptAssets?: ModelScriptAsset[];
    parameterScriptMetadata?: unknown[];
    animationScriptMetadata?: unknown[];
    defaultAssetCode?: string;
    displayName?: string;
    lengthUnit?: ModelSourceLengthUnit;
    unitScaleToMeters?: number;
    parameterConfig?: unknown;
};
export type ModelPackageVariant = {
    name: string;
    path: string;
    sourceUrl: string;
};
export type ListModelPackageVariantsRequest = {
    packagePath: string;
};
export type ImportModelFolderSkippedEntry = {
    packagePath: string;
    reason: string;
};
export type ImportModelFolderResult = {
    canceled: boolean;
    rootPath: string | null;
    projectRoot: string | null;
    assets: AssetEntry[];
    skipped: ImportModelFolderSkippedEntry[];
};
export type ImportCadFileResult = {
    canceled: boolean;
    filePath: string | null;
    sourceUrl: string | null;
    fileSizeBytes: number;
};
export type ProjectAssetIndex = {
    version: 1;
    assets: AssetEntry[];
};
export type ProjectListAssetsResult = {
    projectRoot: string | null;
    assets: AssetEntry[];
};
export type SelectProjectDirectoryResult = {
    canceled: boolean;
    projectRoot: string | null;
};
