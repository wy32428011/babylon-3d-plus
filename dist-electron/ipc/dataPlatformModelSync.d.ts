import type { DataPlatformModelSyncProgress } from '../types.js';
/** 启动全局模型同步；已有任务运行时直接复用，不创建并发覆盖任务。 */
export declare function startDataPlatformModelSync(baseUrl: string, editorRoot: string): boolean;
/** 失败后按最近一次 Base URL 与编辑器目录重新发起同步。 */
export declare function retryDataPlatformModelSync(): boolean;
/** 返回最近进度快照，供晚于任务启动挂载的 renderer 补读。 */
export declare function getLatestDataPlatformModelSyncProgress(): DataPlatformModelSyncProgress | null;
/** 配置地址变化后清除失败任务的重试上下文，运行中的任务不受影响。 */
export declare function clearDataPlatformModelSyncRetryContext(): void;
/** 应用退出时取消并等待当前同步任务，避免 staging 残留或推广事务中断。 */
export declare function disposeDataPlatformModelSync(): Promise<void>;
