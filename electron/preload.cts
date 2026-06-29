import type {
  ProjectListAssetsResult,
  ReadTextFileRequest,
  SaveSceneRequest,
  SelectProjectDirectoryResult,
} from './types.js';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('editorApi', {
  version: '0.1.0',
  saveScene: (request: SaveSceneRequest) => ipcRenderer.invoke('scene:save', request),
  loadScene: () => ipcRenderer.invoke('scene:load'),
  readTextFile: (request: ReadTextFileRequest) => ipcRenderer.invoke('file:readText', request),
  scanAssets: () => ipcRenderer.invoke('assets:scan'),
  listProjectAssets: (): Promise<ProjectListAssetsResult> => ipcRenderer.invoke('project:listAssets'),
  selectProjectDirectory: (): Promise<SelectProjectDirectoryResult> => ipcRenderer.invoke('project:selectDirectory'),
  importModelFolder: () => ipcRenderer.invoke('assets:importModelFolder'),
});
