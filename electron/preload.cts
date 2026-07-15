import type {
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
  OpenRecentProjectRequest,
  ProjectListAssetsResult,
  ReadTextFileRequest,
  RecentWorkspacesResult,
  RemoveRecentWorkspaceItemRequest,
  SaveSceneRequest,
  SelectProjectDirectoryResult,
} from './types.js';

import type { IpcRendererEvent } from 'electron';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('editorApi', {
  version: '0.1.0',
  saveScene: (request: SaveSceneRequest) => ipcRenderer.invoke('scene:save', request),
  loadScene: () => ipcRenderer.invoke('scene:load'),
  loadSceneFile: (request: LoadSceneFileRequest): Promise<LoadSceneResult> => ipcRenderer.invoke('scene:loadFile', request),
  readTextFile: (request: ReadTextFileRequest) => ipcRenderer.invoke('file:readText', request),
  scanAssets: () => ipcRenderer.invoke('assets:scan'),
  getRecentWorkspaces: (): Promise<RecentWorkspacesResult> => ipcRenderer.invoke('project:getRecentWorkspaces'),
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
  mqttConfigure: (request: MqttIpcConfigureRequest): Promise<MqttIpcStatus> => ipcRenderer.invoke('mqtt:configure', request),
  mqttDisconnect: (): Promise<MqttIpcStatus> => ipcRenderer.invoke('mqtt:disconnect'),
  mqttGetStatus: (): Promise<MqttIpcStatus> => ipcRenderer.invoke('mqtt:getStatus'),
  onMqttEvent: (handler: (event: MqttIpcEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: MqttIpcEvent) => handler(payload);
    ipcRenderer.on('mqtt:event', listener);
    return () => ipcRenderer.removeListener('mqtt:event', listener);
  },
});
