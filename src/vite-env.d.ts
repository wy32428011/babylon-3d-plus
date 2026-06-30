/// <reference types="vite/client" />

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

type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';
type ModelParameterConfig = import('./editor/model/modelParameters').ModelParameterConfig;

type AssetEntry = {
  id: string;
  name: string;
  path: string;
  sourceUrl: string;
  kind: 'folder' | 'model' | 'texture' | 'scene' | 'unknown';
  packagePath?: string;
  metadataPath?: string;
  scriptPaths?: string[];
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
    readTextFile: (request: ReadTextFileRequest) => Promise<ReadTextFileResult>;
    scanAssets: () => Promise<AssetEntry[]>;
    listProjectAssets: () => Promise<ProjectListAssetsResult>;
    selectProjectDirectory: () => Promise<SelectProjectDirectoryResult>;
    importModelFolder: () => Promise<ImportModelFolderResult>;
  };
}
