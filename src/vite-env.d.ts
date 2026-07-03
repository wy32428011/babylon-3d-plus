/// <reference types="vite/client" />

declare module '*?raw' {
  const content: string;
  export default content;
}

type SaveSceneRequest = {
  suggestedName: string;
  content: string;
};

type SaveSceneResult = {
  canceled: boolean;
  filePath: string | null;
};

type LoadSceneResult = {
  canceled: boolean;
  filePath: string | null;
  content: string | null;
};

type ReadTextFileRequest = {
  filePath: string;
};

type ReadTextFileResult = {
  filePath: string;
  content: string;
};

type LoadSceneFileRequest = {
  filePath: string;
};

type OpenRecentProjectRequest = {
  projectRoot: string;
};

type RemoveRecentWorkspaceItemRequest = {
  kind: 'project' | 'scene';
  path: string;
};

type RecentProjectEntry = {
  projectRoot: string;
  displayName: string;
  lastOpenedAt: string;
  exists: boolean;
  assetCount: number;
  lastScenePath?: string;
};

type RecentSceneEntry = {
  filePath: string;
  displayName: string;
  lastOpenedAt: string;
  exists: boolean;
  projectRoot?: string;
};

type RecentWorkspacesResult = {
  projects: RecentProjectEntry[];
  scenes: RecentSceneEntry[];
};

type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';
type ModelParameterConfig = import('./editor/model/modelParameters').ModelParameterConfig;
type ModelScriptAsset = import('./editor/model/components').ModelScriptAsset;

type AssetEntry = {
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
  parameterConfig?: ModelParameterConfig;
};

type ImportModelFolderSkippedEntry = {
  packagePath: string;
  reason: string;
};

type ImportModelFolderResult = {
  canceled: boolean;
  rootPath: string | null;
  projectRoot: string | null;
  assets: AssetEntry[];
  skipped: ImportModelFolderSkippedEntry[];
};

type ImportCadFileResult = {
  canceled: boolean;
  filePath: string | null;
  sourceUrl: string | null;
  fileSizeBytes: number;
};

type ProjectListAssetsResult = {
  projectRoot: string | null;
  assets: AssetEntry[];
};

type SelectProjectDirectoryResult = {
  canceled: boolean;
  projectRoot: string | null;
};

interface Window {
  editorApi: {
    version: string;
    saveScene: (request: SaveSceneRequest) => Promise<SaveSceneResult>;
    loadScene: () => Promise<LoadSceneResult>;
    loadSceneFile: (request: LoadSceneFileRequest) => Promise<LoadSceneResult>;
    readTextFile: (request: ReadTextFileRequest) => Promise<ReadTextFileResult>;
    scanAssets: () => Promise<AssetEntry[]>;
    getRecentWorkspaces: () => Promise<RecentWorkspacesResult>;
    listProjectAssets: () => Promise<ProjectListAssetsResult>;
    openRecentProject: (request: OpenRecentProjectRequest) => Promise<ProjectListAssetsResult>;
    removeRecentWorkspaceItem: (request: RemoveRecentWorkspaceItemRequest) => Promise<void>;
    selectProjectDirectory: () => Promise<SelectProjectDirectoryResult>;
    importCadFile: () => Promise<ImportCadFileResult>;
    importModelFolder: () => Promise<ImportModelFolderResult>;
  };
}
