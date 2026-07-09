import { contextBridge, ipcRenderer } from 'electron';
import type {
  AssetEntry,
  ImportCadFileResult,
  ImportModelFolderResult,
  ListModelPackageVariantsRequest,
  LoadSceneFileRequest,
  LoadSceneResult,
  ModelPackageVariant,
  OpenRecentProjectRequest,
  ProjectListAssetsResult,
  ReadTextFileRequest,
  ReadTextFileResult,
  RecentWorkspacesResult,
  RemoveRecentWorkspaceItemRequest,
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
  listProjectAssets: (): Promise<ProjectListAssetsResult> => ipcRenderer.invoke('project:listAssets'),
  openRecentProject: (request: OpenRecentProjectRequest): Promise<ProjectListAssetsResult> => ipcRenderer.invoke('project:openRecent', request),
  removeRecentWorkspaceItem: (request: RemoveRecentWorkspaceItemRequest): Promise<void> => ipcRenderer.invoke('project:removeRecentWorkspaceItem', request),
  selectProjectDirectory: (): Promise<SelectProjectDirectoryResult> => ipcRenderer.invoke('project:selectDirectory'),
  importCadFile: (): Promise<ImportCadFileResult> => ipcRenderer.invoke('assets:importCadFile'),
  importModelFolder: (): Promise<ImportModelFolderResult> => ipcRenderer.invoke('assets:importModelFolder'),
  listModelPackageVariants: (request: ListModelPackageVariantsRequest): Promise<ModelPackageVariant[]> =>
    ipcRenderer.invoke('assets:listModelPackageVariants', request),
});
