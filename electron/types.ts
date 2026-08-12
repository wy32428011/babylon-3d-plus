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
  currentResourceRevision: string;
  publishedResourceRevision: string;
  digitalTwinStatus: string | null;
  onlineDigitalTwinVersionId: string | null;
  onlineDigitalTwinVersionNumber: number | null;
  onlineDigitalTwinPublishId: string | null;
  onlineProjectPublishId: string | null;
  digitalTwinStableUrl: string | null;
  digitalTwinReleaseUrl: string | null;
  digitalTwinLastPublishedAt: string | null;
  updatedAt: string | null;
};

export type OpenDataPlatformProjectRequest = {
  projectId: string;
};

export type DataPlatformBindingSummary = {
  baseUrl: string;
  projectId: string;
  projectName: string;
  editorProjectId: string | null;
  latestVersionId: string | null;
  latestVersionNumber: number | null;
  resourceRevision: string;
  entryScenePath: string | null;
  syncedAt: string;
};

export type DataPlatformProjectOpenResult = {
  projectRoot: string;
  sceneFilePath: string | null;
  source: 'package' | 'generated' | 'local';
  warning: string | null;
  conflictCopyPath: string | null;
  modelSyncStarted: boolean;
  skyboxSyncStarted: boolean;
  binding: DataPlatformBindingSummary;
};

export type DataPlatformDeepLink = {
  baseUrl: string;
  projectId: string;
};

export type DigitalTwinPublishContext = {
  available: boolean;
  projectRoot: string | null;
  baseUrl: string | null;
  projectId: string | null;
  projectName: string | null;
  editorProjectId: string | null;
  baseVersionId: string | null;
  baseVersionNumber: number | null;
  resourceRevision: string | null;
  entryScenePath: string | null;
  remoteLatestVersionId: string | null;
  remoteLatestVersionNumber: number | null;
  stableUrl: string | null;
  releaseUrl: string | null;
  dataPlatformOrigin: string | null;
  allowedParentOrigins: string[];
  overwriteConfirmationRequired: boolean;
  versionConflict: boolean;
  publishActive: boolean;
};

export type DigitalTwinPublishRequest = {
  requestId: string;
  publishName: string;
  remark: string;
  sceneContent: string;
  overwriteExisting: boolean;
  confirmResourceBindings: boolean;
  allowedParentOrigins: string[];
};

export type DigitalTwinPublishProgressPhase =
  | 'saving'
  | 'source-package'
  | 'dist-package'
  | 'prepare'
  | 'upload-source'
  | 'upload-dist'
  | 'commit'
  | 'completed'
  | 'failed'
  | 'canceled';

export type DigitalTwinPublishProgress = {
  requestId: string;
  phase: DigitalTwinPublishProgressPhase;
  detail: string;
  percent: number;
  uploadedBytes: number;
  totalBytes: number;
};

export type DigitalTwinPublishResult = {
  requestId: string;
  status: 'completed' | 'confirmation-required' | 'conflict' | 'canceled';
  errorCode: string | null;
  message: string;
  errorData: unknown;
  conflictCopyPath: string | null;
  editorProjectId: string | null;
  editorProjectVersionId: string | null;
  editorProjectVersionNumber: number | null;
  editorProjectPublishId: string | null;
  projectPublishId: string | null;
  stableUrl: string | null;
  releaseUrl: string | null;
  warnings: string[];
};

export type DigitalTwinPublishCancelRequest = {
  requestId: string;
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

export type DataPlatformSkyboxSyncPhase =
  | 'querying'
  | 'downloading'
  | 'validating'
  | 'promoting'
  | 'completed'
  | 'failed';

export type DataPlatformSkyboxSyncProgress = {
  runId: string;
  contextKey: string | null;
  phase: DataPlatformSkyboxSyncPhase;
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

/** 同步自数据中台大屏图标库的图片资产，仅登记 CUSTOM + ACTIVE 且带 iconUrl 的图标。 */
export type SyncedImageAssetEntry = {
  /** 中台图标资产主键。 */
  id: string;
  /** 组件引用时使用的稳定图标 Key，创建后不可变。 */
  iconKey: string;
  /** 图标展示名称。 */
  name: string;
  /** 图标分类。 */
  category?: string;
  /** 排序号。 */
  sortOrder?: number;
  /** 中台更新时间，用于增量同步判定。 */
  updatedAt: string;
  /** 本地文件名，格式为 <iconKey>.<ext>。 */
  fileName: string;
  /** 本地文件绝对路径。 */
  filePath: string;
  /** 编辑器授权资产 URL。 */
  sourceUrl: string;
  /** 稳定逻辑引用，场景只保存该引用。 */
  reference: string;
  fileSizeBytes?: number;
};

/** 本地同步图片索引文件结构。 */
export type SyncedImageIndex = {
  version: 1;
  images: SyncedImageAssetEntry[];
};

/** 数据中台图片同步执行阶段。 */
export type DataPlatformImageSyncPhase =
  | 'querying'
  | 'downloading'
  | 'validating'
  | 'promoting'
  | 'completed'
  | 'failed';

/** 数据中台图片同步进度，与模型同步进度同构。 */
export type DataPlatformImageSyncProgress = {
  runId: string;
  phase: DataPlatformImageSyncPhase;
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
export type SkyboxAssetFormat = 'hdr' | 'exr';

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
  fileSizeBytes?: number;
  parameterConfig?: unknown;
  dataDrivenConfig?: unknown;
  builtInSlotBindingConfig?: unknown;
};

/** 项目索引中的模型资产，必须是模型且带有明确资产库分类。 */
export type ProjectModelAssetEntry = AssetEntry & {
  kind: 'model';
  libraryKind: ModelAssetLibraryKind;
};

/** 项目天空盒资源独立于模型资产索引，直接扫描 Assets/Skyboxes 得到。 */
export type ProjectSkyboxAssetEntry = {
  id: string;
  name: string;
  displayName: string;
  path: string;
  sourceUrl: string;
  assetRevision: string;
  packagePath: string;
  kind: 'skybox';
  libraryKind: 'skybox';
  format: SkyboxAssetFormat;
  fileSizeBytes: number;
  source: 'project' | 'data-platform';
  availability: 'active' | 'orphaned';
  dataPlatformResourceId?: string;
  dataPlatformRevision?: string;
  fileSha256?: string;
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

export type ImportSkyboxFileResult = {
  canceled: boolean;
  filePath: string | null;
  projectRoot: string | null;
  importedAsset: ProjectSkyboxAssetEntry | null;
  skyboxes: ProjectSkyboxAssetEntry[];
  orphanedSkyboxes: ProjectSkyboxAssetEntry[];
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
  skyboxSyncContextKey: string | null;
  assets: ProjectModelAssetEntry[];
  skyboxes: ProjectSkyboxAssetEntry[];
  orphanedSkyboxes: ProjectSkyboxAssetEntry[];
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
