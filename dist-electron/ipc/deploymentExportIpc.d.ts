/** 注册 Web 部署工程导出、取消、进度和定位 IPC。 */
export declare function registerDeploymentExportIpc(): void;
/** 中止所有未完成任务并移除 IPC handler，供应用退出时统一回收。 */
export declare function disposeAllDeploymentExportTasks(): void;
