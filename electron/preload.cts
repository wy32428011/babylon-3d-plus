import type {
  ImportCadFileResult,
  ImportModelFolderResult,
  LoadSceneFileRequest,
  LoadSceneResult,
  OpenRecentProjectRequest,
  ProjectListAssetsResult,
  ReadTextFileRequest,
  RecentWorkspacesResult,
  RemoveRecentWorkspaceItemRequest,
  SaveSceneRequest,
  SelectProjectDirectoryResult,
} from './types.js';

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
  importModelFolder: (): Promise<ImportModelFolderResult> => ipcRenderer.invoke('assets:importModelFolder'),
});
