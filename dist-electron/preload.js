import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('editorApi', {
    version: '0.1.0',
    saveScene: (request) => ipcRenderer.invoke('scene:save', request),
    loadScene: () => ipcRenderer.invoke('scene:load'),
    readTextFile: (request) => ipcRenderer.invoke('file:readText', request),
    scanAssets: () => ipcRenderer.invoke('assets:scan'),
    listProjectAssets: () => ipcRenderer.invoke('project:listAssets'),
    selectProjectDirectory: () => ipcRenderer.invoke('project:selectDirectory'),
    importModelFolder: () => ipcRenderer.invoke('assets:importModelFolder'),
});
