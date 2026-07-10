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
    /** 透传模型文件夹导入请求，renderer 指定普通模型或环境模型库。 */
    importModelFolder: (request) => ipcRenderer.invoke('assets:importModelFolder', request),
    listModelPackageVariants: (request) => ipcRenderer.invoke('assets:listModelPackageVariants', request),
    mqttConfigure: (request) => ipcRenderer.invoke('mqtt:configure', request),
    mqttDisconnect: () => ipcRenderer.invoke('mqtt:disconnect'),
    mqttGetStatus: () => ipcRenderer.invoke('mqtt:getStatus'),
    onMqttEvent: (handler) => {
        const listener = (_event, payload) => handler(payload);
        ipcRenderer.on('mqtt:event', listener);
        return () => ipcRenderer.removeListener('mqtt:event', listener);
    },
});
