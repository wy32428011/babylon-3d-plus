"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('editorApi', {
    version: '0.1.0',
    saveScene: (request) => ipcRenderer.invoke('scene:save', request),
    loadScene: () => ipcRenderer.invoke('scene:load'),
    loadSceneFile: (request) => ipcRenderer.invoke('scene:loadFile', request),
    readTextFile: (request) => ipcRenderer.invoke('file:readText', request),
    scanAssets: () => ipcRenderer.invoke('assets:scan'),
    getRecentWorkspaces: () => ipcRenderer.invoke('project:getRecentWorkspaces'),
    listProjectAssets: () => ipcRenderer.invoke('project:listAssets'),
    openRecentProject: (request) => ipcRenderer.invoke('project:openRecent', request),
    removeRecentWorkspaceItem: (request) => ipcRenderer.invoke('project:removeRecentWorkspaceItem', request),
    selectProjectDirectory: () => ipcRenderer.invoke('project:selectDirectory'),
    importCadFile: () => ipcRenderer.invoke('assets:importCadFile'),
    importModelFolder: () => ipcRenderer.invoke('assets:importModelFolder'),
    listModelPackageVariants: (request) => ipcRenderer.invoke('assets:listModelPackageVariants', request),
});
