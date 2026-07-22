import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AssetEntry,
  DeploymentExportCancelRequest,
  DeploymentExportProgress,
  DeploymentExportRequest,
  DeploymentExportResult,
  DataPlatformConfig,
  DataPlatformModelSyncProgress,
  DataPlatformProjectListRequest,
  DataPlatformProjectListResult,
  DataPlatformProjectOpenResult,
  DeploymentExportRevealRequest,
  ImportCadFileResult,
  ImportEnvironmentModelFileResult,
  ImportModelFolderRequest,
  ImportModelFolderResult,
  ListModelPackageVariantsRequest,
  LoadSceneFileRequest,
  LoadSceneResult,
  ModelPackageVariant,
  MqttIpcConfigureRequest,
  MqttIpcEvent,
  MqttIpcStatus,
  OpenDataPlatformProjectRequest,
  OpenRecentProjectRequest,
  ProjectListAssetsResult,
  ReadTextFileRequest,
  ReadTextFileResult,
  RecentWorkspacesResult,
  RemoveRecentWorkspaceItemRequest,
  SaveDataPlatformConfigRequest,
  SaveSceneRequest,
  SaveSceneResult,
  SelectProjectDirectoryResult,
} from './types.js';

contextBridge.exposeInMainWorld('editorApi', {
  version: '0.1.0',
  saveScene: (request: SaveSceneRequest): Promise<SaveSceneResult> => ipcRenderer.invoke('scene:save', request),
  loadScene: (): Promise<LoadSceneResult> => ipcRenderer.invoke('scene:load'),
  loadSceneFile: (request: LoadSceneFileRequest): Promise<LoadSceneResult> => ipcRenderer.invoke('scene:loadFile', request),
  readTextFile: (request: ReadTextFileRequest): Promise<ReadTextFileResult> => ipcRenderer.invoke('file:readText', request),
  scanAssets: (): Promise<AssetEntry[]> => ipcRenderer.invoke('assets:scan'),
  getRecentWorkspaces: (): Promise<RecentWorkspacesResult> => ipcRenderer.invoke('project:getRecentWorkspaces'),
  getDataPlatformConfig: (): Promise<DataPlatformConfig> => ipcRenderer.invoke('data-platform:getConfig'),
  saveDataPlatformConfig: (request: SaveDataPlatformConfigRequest): Promise<DataPlatformConfig> =>
    ipcRenderer.invoke('data-platform:saveConfig', request),
  listDataPlatformProjects: (request?: DataPlatformProjectListRequest): Promise<DataPlatformProjectListResult> =>
    ipcRenderer.invoke('data-platform:listProjects', request),
  openDataPlatformProject: (request: OpenDataPlatformProjectRequest): Promise<DataPlatformProjectOpenResult> =>
    ipcRenderer.invoke('data-platform:openProject', request),
  retryDataPlatformModelSync: (): Promise<boolean> => ipcRenderer.invoke('data-platform:retryModelSync'),
  onDataPlatformModelSyncProgress: (handler: (progress: DataPlatformModelSyncProgress) => void): (() => void) => {
    let active = true;
    const listener = (_event: IpcRendererEvent, payload: DataPlatformModelSyncProgress) => handler(payload);
    ipcRenderer.on('data-platform:modelSyncProgress', listener);
    void ipcRenderer.invoke('data-platform:getModelSyncProgress').then((payload: DataPlatformModelSyncProgress | null) => {
      if (active && payload) handler(payload);
    }).catch(() => undefined);
    return () => {
      active = false;
      ipcRenderer.removeListener('data-platform:modelSyncProgress', listener);
    };
  },
  listProjectAssets: (): Promise<ProjectListAssetsResult> => ipcRenderer.invoke('project:listAssets'),
  openRecentProject: (request: OpenRecentProjectRequest): Promise<ProjectListAssetsResult> => ipcRenderer.invoke('project:openRecent', request),
  removeRecentWorkspaceItem: (request: RemoveRecentWorkspaceItemRequest): Promise<void> => ipcRenderer.invoke('project:removeRecentWorkspaceItem', request),
  selectProjectDirectory: (): Promise<SelectProjectDirectoryResult> => ipcRenderer.invoke('project:selectDirectory'),
  importCadFile: (): Promise<ImportCadFileResult> => ipcRenderer.invoke('assets:importCadFile'),
  /** 透传普通模型文件夹导入请求。 */
  importModelFolder: (request: ImportModelFolderRequest): Promise<ImportModelFolderResult> => ipcRenderer.invoke('assets:importModelFolder', request),
  /** 透传环境模型单 GLB 文件导入请求。 */
  importEnvironmentModelFile: (): Promise<ImportEnvironmentModelFileResult> => ipcRenderer.invoke('assets:importEnvironmentModelFile'),
  listModelPackageVariants: (request: ListModelPackageVariantsRequest): Promise<ModelPackageVariant[]> =>
    ipcRenderer.invoke('assets:listModelPackageVariants', request),
  /** 发起当前场景的 Web 部署工程导出。 */
  exportWebProject: (request: DeploymentExportRequest): Promise<DeploymentExportResult> =>
    ipcRenderer.invoke('deployment-export:start', request),
  /** 取消当前窗口中 requestId 对应的导出任务。 */
  cancelWebProjectExport: (request: DeploymentExportCancelRequest): Promise<boolean> =>
    ipcRenderer.invoke('deployment-export:cancel', request),
  /** 订阅当前窗口的 Web 部署工程导出进度。 */
  onWebProjectExportProgress: (handler: (progress: DeploymentExportProgress) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: DeploymentExportProgress) => handler(payload);
    ipcRenderer.on('deployment-export:progress', listener);
    return () => ipcRenderer.removeListener('deployment-export:progress', listener);
  },
  /** 在文件管理器中定位已经成功发布的导出结果。 */
  revealWebProjectExport: (request: DeploymentExportRevealRequest): Promise<void> =>
    ipcRenderer.invoke('deployment-export:reveal', request),
  mqttConfigure: (request: MqttIpcConfigureRequest): Promise<MqttIpcStatus> => ipcRenderer.invoke('mqtt:configure', request),
  mqttDisconnect: (): Promise<MqttIpcStatus> => ipcRenderer.invoke('mqtt:disconnect'),
  mqttGetStatus: (): Promise<MqttIpcStatus> => ipcRenderer.invoke('mqtt:getStatus'),
  onMqttEvent: (handler: (event: MqttIpcEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: MqttIpcEvent) => handler(payload);
    ipcRenderer.on('mqtt:event', listener);
    return () => ipcRenderer.removeListener('mqtt:event', listener);
  },
});
