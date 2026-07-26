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

export type DataPlatformConfig = {
  baseUrl: string;
  workspaceRoot: string;
  usesDefaultWorkspace: boolean;
};

export type DataPlatformWorkspaceSelectionResult = {
  canceled: boolean;
  config: DataPlatformConfig;
};

export type SaveDataPlatformConfigRequest = {
  baseUrl: string;
};

export type DataPlatformProjectEntry = {
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

export type OpenDataPlatformProjectRequest = {
  projectId: string;
};

export type DataPlatformProjectOpenResult = {
  projectRoot: string;
  sceneFilePath: string | null;
  source: 'package' | 'generated';
  warning: string | null;
  modelSyncStarted: boolean;
};

export type DataPlatformModelSyncPhase =
  | 'querying'
  | 'downloading'
  | 'validating'
  | 'promoting'
  | 'completed'
  | 'failed';

export type DataPlatformModelSyncProgress = {
  runId: string;
  phase: DataPlatformModelSyncPhase;
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

export type DataPlatformProjectListRequest = {
  projectName: string;
};

export type DataPlatformProjectListResult = {
  records: DataPlatformProjectEntry[];
  total: number;
};

export type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';

export type ModelScriptAsset = {
  path: string;
  sourceUrl: string;
  name: string;
};

/** 模型资产库分类：普通模型与环境模型分别落到不同项目目录。 */
export type ModelAssetLibraryKind = 'model' | 'environment';

export type AssetEntry = {
  id: string;
  name: string;
  path: string;
  sourceUrl: string;
  assetRevision?: string;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  kind: 'folder' | 'model' | 'texture' | 'scene' | 'unknown';
  /** 扫描阶段可为空，写入项目索引后必须具备资产库分类。 */
  libraryKind?: ModelAssetLibraryKind;
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
  dataDrivenConfig?: unknown;
};

/** 项目索引中的模型资产，必须是模型且带有明确资产库分类。 */
export type ProjectModelAssetEntry = AssetEntry & {
  kind: 'model';
  libraryKind: ModelAssetLibraryKind;
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

/** 普通模型文件夹入口固定写入模型库；环境模型使用独立的单 GLB 导入 API。 */
export type ImportModelFolderRequest = {
  libraryKind: 'model';
};

/** 导入模型文件夹返回本次导入、项目完整资产与跳过项。 */
export type ImportModelFolderResult = {
  canceled: boolean;
  rootPath: string | null;
  projectRoot: string | null;
  importedAssets: ProjectModelAssetEntry[];
  projectAssets: ProjectModelAssetEntry[];
  skipped: ImportModelFolderSkippedEntry[];
};

/** 直接导入单个环境 GLB 后返回项目内资产和完整项目资源快照。 */
export type ImportEnvironmentModelFileResult = {
  canceled: boolean;
  filePath: string | null;
  projectRoot: string | null;
  importedAsset: ProjectModelAssetEntry | null;
  projectAssets: ProjectModelAssetEntry[];
};

export type ImportCadFileResult = {
  canceled: boolean;
  filePath: string | null;
  sourceUrl: string | null;
  fileSizeBytes: number;
};

export type ProjectAssetIndex = {
  version: 2;
  assets: ProjectModelAssetEntry[];
};

export type ProjectListAssetsResult = {
  projectRoot: string | null;
  assets: ProjectModelAssetEntry[];
};

export type SelectProjectDirectoryResult = {
  canceled: boolean;
  projectRoot: string | null;
};

export type MqttIpcAdapterConfig =
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

export type MqttIpcSubscriptionConfig = {
  topic: string;
  qos: 0 | 1 | 2;
  adapter?: MqttIpcAdapterConfig;
};

export type MqttIpcConfigureRequest = {
  enabled: boolean;
  address: string;
  subscriptions: MqttIpcSubscriptionConfig[];
};

export type MqttIpcStatus = {
  state: 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error';
  address?: string;
  subscriptions: MqttIpcSubscriptionConfig[];
  lastError?: string;
};

export type MqttIpcEvent =
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
export type DeploymentExportFormat = 'directory' | 'zip';

/** Web 部署工程导出的执行阶段。 */
export type DeploymentExportPhase =
  | 'preflight'
  | 'copy-template'
  | 'copy-assets'
  | 'write-metadata'
  | 'archive'
  | 'publish';

/** renderer 发起 Web 部署工程导出的请求。 */
export type DeploymentExportRequest = {
  requestId: string;
  suggestedName: string;
  format: DeploymentExportFormat;
  sceneContent: string;
};

/** 主进程向当前 renderer 广播的 Web 部署工程导出进度。 */
export type DeploymentExportProgress = {
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
export type DeploymentExportResult = {
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
export type DeploymentExportCancelRequest = {
  requestId: string;
};

/** 在文件管理器中定位已完成导出结果的请求。 */
export type DeploymentExportRevealRequest = {
  requestId: string;
};

/** 兼容按动作在前命名的取消请求类型。 */
export type CancelDeploymentExportRequest = DeploymentExportCancelRequest;

/** 兼容按动作在前命名的定位请求类型。 */
export type RevealDeploymentExportRequest = DeploymentExportRevealRequest;
