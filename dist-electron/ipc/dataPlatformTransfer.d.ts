export declare const MAX_ARCHIVE_COMPRESSED_BYTES: number;
export type DownloadRemoteFileOptions = {
    baseUrl: string;
    remoteUrl: string;
    destinationPath: string;
    maxBytes: number;
    signal: AbortSignal;
    timeoutMs: number;
    context: string;
    onBytes?: (bytes: number) => void;
};
export type DownloadRemoteFileResult = {
    bytes: number;
    contentType: string;
    finalUrl: string;
};
/** 回滚不完整时要求调用方保留 staging/backup，避免清理掉唯一可恢复副本。 */
export declare class DataPlatformRollbackError extends Error {
    constructor(message: string);
}
/** 按数据中台 Base URL 解析相对下载地址，并拒绝危险协议与内嵌凭据。 */
export declare function resolveDataPlatformRemoteUrl(baseUrl: string, value: string): URL;
/** 判断 candidate 是否严格位于 root 内部。 */
export declare function isPathInside(root: string, candidate: string): boolean;
/** 校验待操作路径位于预期根目录，防止计算路径越界。 */
export declare function assertPathInside(root: string, candidate: string, label: string): void;
/** 发起有大小上限和超时控制的 JSON POST 请求。 */
export declare function requestDataPlatformJson(options: {
    baseUrl: string;
    endpointPath: string;
    body: unknown;
    signal: AbortSignal;
    timeoutMs: number;
    context: string;
}): Promise<unknown>;
/** 以临时文件承接远程响应，完整写入并校验大小后再重命名到目标路径。 */
export declare function downloadRemoteFile(options: DownloadRemoteFileOptions): Promise<DownloadRemoteFileResult>;
/** 安全展开 ZIP：预检目录项、路径、符号链接及大小，再逐项流式写入。 */
export declare function extractZipSecurely(archivePath: string, destinationRoot: string, signal: AbortSignal): Promise<void>;
