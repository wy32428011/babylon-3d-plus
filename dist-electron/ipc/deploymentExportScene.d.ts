import { type DeploymentAssetKind, type DeploymentCopiedFile, type DeploymentCopyFile } from './deploymentExportFileSystem.js';
/** Web 部署导出预检与场景改写的完整结果。 */
export type PreparedDeploymentExport = {
    sceneContent: string;
    runtimeConfigContent: string;
    readmeContent: string;
    assetFiles: DeploymentCopyFile[];
    externalAssetCount: number;
    warnings: string[];
};
/** 资产清单的单条稳定记录。 */
export type DeploymentAssetManifestEntry = {
    logicalUrl: string;
    path: string;
    kind: DeploymentAssetKind;
    size: number;
    sha256: string;
};
/** 校验场景 v1、解析所有资源引用、预检文件并生成无本机路径的部署快照。 */
export declare function prepareDeploymentExport(content: string, exportName: string, forbiddenOutputPaths: string[], signal: AbortSignal, onStatus: (message: string) => void): Promise<PreparedDeploymentExport>;
/** 根据已复制文件的真实哈希生成部署资产清单。 */
export declare function createAssetManifestContent(copiedFiles: DeploymentCopiedFile[]): string;
