import { contextBridge, ipcRenderer } from 'electron';
import type {
  AssetEntry,
  ImportModelFolderResult,
  LoadSceneResult,
  ProjectListAssetsResult,
  ReadTextFileRequest,
  ReadTextFileResult,
  SaveSceneRequest,
  SaveSceneResult,
  SelectProjectDirectoryResult,
} from './types.js';

contextBridge.exposeInMainWorld('editorApi', {
  version: '0.1.0',
  saveScene: (request: SaveSceneRequest): Promise<SaveSceneResult> => ipcRenderer.invoke('scene:save', request),
  loadScene: (): Promise<LoadSceneResult> => ipcRenderer.invoke('scene:load'),
  readTextFile: (request: ReadTextFileRequest): Promise<ReadTextFileResult> => ipcRenderer.invoke('file:readText', request),
  scanAssets: (): Promise<AssetEntry[]> => ipcRenderer.invoke('assets:scan'),
  listProjectAssets: (): Promise<ProjectListAssetsResult> => ipcRenderer.invoke('project:listAssets'),
  selectProjectDirectory: (): Promise<SelectProjectDirectoryResult> => ipcRenderer.invoke('project:selectDirectory'),
  importModelFolder: (): Promise<ImportModelFolderResult> => ipcRenderer.invoke('assets:importModelFolder'),
});
