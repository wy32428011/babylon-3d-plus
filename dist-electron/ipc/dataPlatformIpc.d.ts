import type { DataPlatformProjectListResult } from '../types.js';
/** 注册数据中台配置与项目列表 IPC，重复调用时保持幂等。 */
export declare function registerDataPlatformIpc(): void;
/** 规范化数据中台地址，空字符串表示主动清除配置。 */
export declare function normalizeDataPlatformBaseUrl(value: unknown): string;
/** 校验并归一化项目列表响应，避免远端异常字段污染 renderer。 */
export declare function normalizeProjectListResponse(value: unknown): DataPlatformProjectListResult;
