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

type DataPlatformConfig = {
  baseUrl: string;
  workspaceRoot: string;
  usesDefaultWorkspace: boolean;
};

type DataPlatformWorkspaceSelectionResult = {
  canceled: boolean;
  config: DataPlatformConfig;
};

type SaveDataPlatformConfigRequest = {
  baseUrl: string;
};

type DataPlatformProjectEntry = {
  id: string;
  projectName: string;
  sceneCount: number;
  screenCount: number;
  modelCount: number;
  envModelCount: number;
  comboModelCount: number;
  poiCount: number;
  chartCount: number;
  themeCount: number;
  latestEditorProjectId: string | null;
  latestEditorProjectVersionId: string | null;
  latestEditorProjectVersionNumber: number | null;
  latestEditorProjectName: string | null;
  latestEditorProjectPackageUrl: string | null;
  latestEditorProjectPackageFileName: string | null;
  updatedAt: string | null;
};

type OpenDataPlatformProjectRequest = {
  projectId: string;
};

type DataPlatformProjectOpenResult = {
  projectRoot: string;
  sceneFilePath: string | null;
  source: 'package' | 'generated';
  warning: string | null;
  modelSyncStarted: boolean;
};

type DataPlatformModelSyncPhase =
  | 'querying'
  | 'downloading'
  | 'validating'
  | 'promoting'
  | 'completed'
  | 'failed';

type DataPlatformModelSyncProgress = {
  runId: string;
  phase: DataPlatformModelSyncPhase;
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

type DataPlatformProjectListRequest = {
  projectName: string;
};

type DataPlatformProjectListResult = {
  records: DataPlatformProjectEntry[];
  total: number;
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
  libraryKind: 'model';
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

type ImportEnvironmentModelFileResult = {
  canceled: boolean;
  filePath: string | null;
  projectRoot: string | null;
  importedAsset: ProjectModelAssetEntry | null;
  projectAssets: ProjectModelAssetEntry[];
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

/** Web 部署工程的输出形式。 */
type DeploymentExportFormat = 'directory' | 'zip';

/** Web 部署工程导出的执行阶段。 */
type DeploymentExportPhase =
  | 'preflight'
  | 'copy-template'
  | 'copy-assets'
  | 'write-metadata'
  | 'archive'
  | 'publish';

/** renderer 发起 Web 部署工程导出的请求。 */
type DeploymentExportRequest = {
  requestId: string;
  suggestedName: string;
  format: DeploymentExportFormat;
  sceneContent: string;
};

/** 主进程向当前 renderer 广播的 Web 部署工程导出进度。 */
type DeploymentExportProgress = {
  requestId: string;
  phase: DeploymentExportPhase;
  detail: string;
  percent: number;
  completedFiles: number;
  totalFiles: number;
  copiedBytes: number;
  totalBytes: number;
};

/** Web 部署工程导出结果；取消时 outputPath 为 null。 */
type DeploymentExportResult = {
  requestId: string;
  canceled: boolean;
  format: DeploymentExportFormat;
  outputPath: string | null;
  fileCount: number;
  totalBytes: number;
  externalAssetCount: number;
  warnings: string[];
};

/** 取消当前 Web 部署工程导出的请求。 */
type DeploymentExportCancelRequest = {
  requestId: string;
};

/** 在文件管理器中定位已完成导出结果的请求。 */
type DeploymentExportRevealRequest = {
  requestId: string;
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
    getDataPlatformConfig: () => Promise<DataPlatformConfig>;
    saveDataPlatformConfig: (request: SaveDataPlatformConfigRequest) => Promise<DataPlatformConfig>;
    selectDataPlatformWorkspace: () => Promise<DataPlatformWorkspaceSelectionResult>;
    resetDataPlatformWorkspace: () => Promise<DataPlatformConfig>;
    listDataPlatformProjects: (request?: DataPlatformProjectListRequest) => Promise<DataPlatformProjectListResult>;
    openDataPlatformProject: (request: OpenDataPlatformProjectRequest) => Promise<DataPlatformProjectOpenResult>;
    retryDataPlatformModelSync: () => Promise<boolean>;
    onDataPlatformModelSyncProgress: (handler: (progress: DataPlatformModelSyncProgress) => void) => () => void;
    listProjectAssets: () => Promise<ProjectListAssetsResult>;
    openRecentProject: (request: OpenRecentProjectRequest) => Promise<ProjectListAssetsResult>;
    removeRecentWorkspaceItem: (request: RemoveRecentWorkspaceItemRequest) => Promise<void>;
    selectProjectDirectory: () => Promise<SelectProjectDirectoryResult>;
    importCadFile: () => Promise<ImportCadFileResult>;
    importModelFolder: (request: ImportModelFolderRequest) => Promise<ImportModelFolderResult>;
    importEnvironmentModelFile: () => Promise<ImportEnvironmentModelFileResult>;
    listModelPackageVariants: (request: ListModelPackageVariantsRequest) => Promise<ModelPackageVariant[]>;
    exportWebProject: (request: DeploymentExportRequest) => Promise<DeploymentExportResult>;
    cancelWebProjectExport: (request: DeploymentExportCancelRequest) => Promise<boolean>;
    onWebProjectExportProgress: (handler: (progress: DeploymentExportProgress) => void) => () => void;
    revealWebProjectExport: (request: DeploymentExportRevealRequest) => Promise<void>;
    mqttConfigure?: (request: MqttIpcConfigureRequest) => Promise<MqttIpcStatus>;
    mqttDisconnect?: () => Promise<MqttIpcStatus>;
    mqttGetStatus?: () => Promise<MqttIpcStatus>;
    onMqttEvent?: (handler: (event: MqttIpcEvent) => void) => () => void;
  };
}
