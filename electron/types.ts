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

export type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';

export type AssetEntry = {
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
