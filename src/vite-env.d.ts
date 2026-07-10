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
type ModelAssetLibraryKind = 'model' | 'environment';
type ModelParameterConfig = import('./editor/model/modelParameters').ModelParameterConfig;
type ModelScriptAsset = import('./editor/model/components').ModelScriptAsset;
type ModelDataDrivenConfig = import('./editor/model/telemetryBinding').ModelDataDrivenConfig;

type AssetEntry = {
  id: string;
  name: string;
  path: string;
  sourceUrl: string;
  assetRevision?: string;
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
  dataDrivenConfig?: ModelDataDrivenConfig;
  libraryKind?: ModelAssetLibraryKind;
};

type ProjectModelAssetEntry = AssetEntry & {
  kind: 'model';
  libraryKind: ModelAssetLibraryKind;
};

type ImportModelFolderRequest = {
  libraryKind: ModelAssetLibraryKind;
};

type ImportModelFolderSkippedEntry = {
  packagePath: string;
  reason: string;
};

type ImportModelFolderResult = {
  canceled: boolean;
  rootPath: string | null;
  projectRoot: string | null;
  importedAssets: ProjectModelAssetEntry[];
  projectAssets: ProjectModelAssetEntry[];
  skipped: ImportModelFolderSkippedEntry[];
};

type ModelPackageVariant = {
  name: string;
  path: string;
  sourceUrl: string;
};

type ListModelPackageVariantsRequest = {
  packagePath: string;
};

type ImportCadFileResult = {
  canceled: boolean;
  filePath: string | null;
  sourceUrl: string | null;
  fileSizeBytes: number;
};

type ProjectListAssetsResult = {
  projectRoot: string | null;
  assets: ProjectModelAssetEntry[];
};

type SelectProjectDirectoryResult = {
  canceled: boolean;
  projectRoot: string | null;
};

type MqttIpcAdapterConfig =
  | { kind: 'epv'; sourceId?: string; deviceType?: string }
  | {
      kind: 'json-path';
      sourceId?: string;
      deviceTypePath?: string;
      assetCodePath?: string;
      timestampPath?: string;
      sequencePath?: string;
      fields: Record<string, string>;
    };

type MqttIpcSubscriptionConfig = {
  topic: string;
  qos: 0 | 1 | 2;
  adapter?: MqttIpcAdapterConfig;
};

type MqttIpcConfigureRequest = {
  enabled: boolean;
  address: string;
  subscriptions: MqttIpcSubscriptionConfig[];
};

type MqttIpcStatus = {
  state: 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error';
  address?: string;
  subscriptions: MqttIpcSubscriptionConfig[];
  lastError?: string;
};

type MqttIpcEvent =
  | { type: 'status'; status: MqttIpcStatus }
  | { type: 'log'; message: string; receivedAt: number }
  | {
      type: 'message';
      sourceId: string;
      subscription: MqttIpcSubscriptionConfig;
      topic: string;
      payloadText: string;
      receivedAt: number;
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
    importModelFolder: (request: ImportModelFolderRequest) => Promise<ImportModelFolderResult>;
    listModelPackageVariants: (request: ListModelPackageVariantsRequest) => Promise<ModelPackageVariant[]>;
    mqttConfigure?: (request: MqttIpcConfigureRequest) => Promise<MqttIpcStatus>;
    mqttDisconnect?: () => Promise<MqttIpcStatus>;
    mqttGetStatus?: () => Promise<MqttIpcStatus>;
    onMqttEvent?: (handler: (event: MqttIpcEvent) => void) => () => void;
  };
}
