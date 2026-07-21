import { type Stats } from 'node:fs';
/** 导出资产清单中的资源分类。 */
export type DeploymentAssetKind = 'model' | 'environment' | 'cad' | 'script' | 'texture' | 'buffer' | 'metadata' | 'asset';
/** 安全预检后得到的源文件快照。 */
export type SafeSourceFile = {
    sourcePath: string;
    relativePath: string;
    size: number;
    mtimeMs: number;
};
/** 需要复制到 staging 的单个文件。 */
export type DeploymentCopyFile = SafeSourceFile & {
    destinationRelativePath: string;
    kind: DeploymentAssetKind;
    logicalUrl?: string;
};
/** 单个已复制文件的哈希结果。 */
export type DeploymentCopiedFile = DeploymentCopyFile & {
    sha256: string;
};
/** 并发复制阶段的累计进度。 */
export type DeploymentCopyProgress = {
    completedFiles: number;
    totalFiles: number;
    completedBytes: number;
    totalBytes: number;
};
/** 创建统一的导出取消异常，便于 IPC 层收口取消结果。 */
export declare function createDeploymentExportAbortError(): Error;
/** 判断未知异常是否代表主动取消。 */
export declare function isDeploymentExportAbortError(error: unknown): boolean;
/** 在长耗时步骤之间检查取消信号。 */
export declare function throwIfDeploymentExportAborted(signal: AbortSignal): void;
/** Windows 下按不区分大小写的方式生成本地路径比较键。 */
export declare function toLocalPathKey(filePath: string): string;
/** 判断 candidate 是否等于 root 或位于 root 内。 */
export declare function isPathInsideOrEqual(root: string, candidate: string): boolean;
/** 判断两个路径是否存在包含关系，用于阻止导出输出递归进入源目录。 */
export declare function pathsOverlap(left: string, right: string): boolean;
/** 将部署相对路径统一转换为正斜杠格式。 */
export declare function toDeploymentPath(relativePath: string): string;
/** 将受控相对路径解析到 staging 内，并拒绝路径逃逸。 */
export declare function resolveDeploymentDestination(stagingRoot: string, relativePath: string): string;
/** 读取路径状态；路径不存在时返回 null。 */
export declare function lstatIfExists(filePath: string): Promise<Stats | null>;
/** 校验目录存在、不是符号链接或 Junction，并返回 realpath。 */
export declare function assertSafeDirectory(directoryPath: string, label: string): Promise<string>;
/** 校验源根目录与输出路径不重叠，避免递归复制 staging 或正式结果。 */
export declare function assertNoSourceOutputOverlap(sourceRoot: string, forbiddenOutputPaths: string[]): void;
/**
 * 安全枚举一个资源根目录。
 * includeRelativePaths 为 null 时复制完整目录；否则只枚举明确文件，并逐级拒绝链接与路径逃逸。
 */
export declare function scanSafeSourceRoot(sourceRoot: string, includeRelativePaths: ReadonlySet<string> | null, forbiddenOutputPaths: string[], signal: AbortSignal, maxFiles?: number): Promise<SafeSourceFile[]>;
/** 以固定并发数流式复制文件，同时计算 SHA-256 并汇报累计进度。 */
export declare function copyDeploymentFiles(files: DeploymentCopyFile[], stagingRoot: string, concurrency: number, signal: AbortSignal, onProgress: (progress: DeploymentCopyProgress) => void): Promise<DeploymentCopiedFile[]>;
