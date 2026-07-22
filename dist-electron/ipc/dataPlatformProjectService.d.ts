import type { DataPlatformModelSyncProgress, DataPlatformProjectEntry, DataPlatformProjectOpenResult } from '../types.js';
/** 返回数据中台项目固定使用的编辑器数据根目录。 */
export declare function getDataPlatformEditorRoot(): string;
/** 从可信项目缓存打开工程，renderer 只允许提交项目 ID。 */
export declare function openDataPlatformProject(project: DataPlatformProjectEntry, baseUrl: string): Promise<DataPlatformProjectOpenResult>;
/** 暴露模型同步重试给 IPC。 */
export declare function retryLatestDataPlatformModelSync(): boolean;
/** 暴露最近模型同步进度给晚挂载的 renderer。 */
export declare function getCurrentDataPlatformModelSyncProgress(): DataPlatformModelSyncProgress | null;
/** 数据中台配置变更后清除旧地址对应的重试上下文。 */
export declare function clearDataPlatformProjectServiceRetryContext(): void;
/** 应用退出时取消并等待工程打开与模型同步任务。 */
export declare function disposeDataPlatformProjectTasks(): Promise<void>;
