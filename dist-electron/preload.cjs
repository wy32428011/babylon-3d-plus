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
    getDataPlatformConfig: () => ipcRenderer.invoke('data-platform:getConfig'),
    saveDataPlatformConfig: (request) => ipcRenderer.invoke('data-platform:saveConfig', request),
    selectDataPlatformWorkspace: () => ipcRenderer.invoke('data-platform:selectWorkspace'),
    resetDataPlatformWorkspace: () => ipcRenderer.invoke('data-platform:resetWorkspace'),
    listDataPlatformProjects: (request) => ipcRenderer.invoke('data-platform:listProjects', request),
    openDataPlatformProject: (request) => ipcRenderer.invoke('data-platform:openProject', request),
    retryDataPlatformModelSync: () => ipcRenderer.invoke('data-platform:retryModelSync'),
    onDataPlatformModelSyncProgress: (handler) => {
        let active = true;
        const listener = (_event, payload) => handler(payload);
        ipcRenderer.on('data-platform:modelSyncProgress', listener);
        void ipcRenderer.invoke('data-platform:getModelSyncProgress').then((payload) => {
            if (active && payload)
                handler(payload);
        }).catch(() => undefined);
        return () => {
            active = false;
            ipcRenderer.removeListener('data-platform:modelSyncProgress', listener);
        };
    },
    listProjectAssets: () => ipcRenderer.invoke('project:listAssets'),
    openRecentProject: (request) => ipcRenderer.invoke('project:openRecent', request),
    removeRecentWorkspaceItem: (request) => ipcRenderer.invoke('project:removeRecentWorkspaceItem', request),
    selectProjectDirectory: () => ipcRenderer.invoke('project:selectDirectory'),
    importCadFile: () => ipcRenderer.invoke('assets:importCadFile'),
    /** 透传普通模型文件夹导入请求。 */
    importModelFolder: (request) => ipcRenderer.invoke('assets:importModelFolder', request),
    /** 透传环境模型单 GLB 文件导入请求。 */
    importEnvironmentModelFile: () => ipcRenderer.invoke('assets:importEnvironmentModelFile'),
    listModelPackageVariants: (request) => ipcRenderer.invoke('assets:listModelPackageVariants', request),
    /** 发起当前场景的 Web 部署工程导出。 */
    exportWebProject: (request) => ipcRenderer.invoke('deployment-export:start', request),
    /** 取消当前窗口中 requestId 对应的导出任务。 */
    cancelWebProjectExport: (request) => ipcRenderer.invoke('deployment-export:cancel', request),
    /** 订阅当前窗口的 Web 部署工程导出进度。 */
    onWebProjectExportProgress: (handler) => {
        const listener = (_event, payload) => handler(payload);
        ipcRenderer.on('deployment-export:progress', listener);
        return () => ipcRenderer.removeListener('deployment-export:progress', listener);
    },
    /** 在文件管理器中定位已经成功发布的导出结果。 */
    revealWebProjectExport: (request) => ipcRenderer.invoke('deployment-export:reveal', request),
    mqttConfigure: (request) => ipcRenderer.invoke('mqtt:configure', request),
    mqttDisconnect: () => ipcRenderer.invoke('mqtt:disconnect'),
    mqttGetStatus: () => ipcRenderer.invoke('mqtt:getStatus'),
    onMqttEvent: (handler) => {
        const listener = (_event, payload) => handler(payload);
        ipcRenderer.on('mqtt:event', listener);
        return () => ipcRenderer.removeListener('mqtt:event', listener);
    },
});
