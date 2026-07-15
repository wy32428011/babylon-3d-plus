import type { AssetEntry, ImportModelFolderSkippedEntry, ModelPackageVariant } from '../types.js';
type ModelPackageScanResult = {
    asset?: AssetEntry;
    skipped?: ImportModelFolderSkippedEntry;
};
/** 校验 GLB 头、版本、声明长度、JSON 首块和分块边界，拒绝仅伪装扩展名的损坏文件。 */
export declare function validateGlbModelFile(modelFilePath: string): Promise<boolean>;
export declare function scanModelPackage(packagePath: string): Promise<ModelPackageScanResult>;
/** 列出模型包内所有可作为环境效果切换的 glTF/GLB 变体，并把主模型排在首位。 */
export declare function listModelPackageVariants(packagePath: string): Promise<ModelPackageVariant[]>;
/**
 * 扫描用户选择的模型目录。
 * 所选目录根部存在模型文件时，优先把该目录视为完整模型包，避免 GLTF 的纹理等资源子目录被误判为独立模型包。
 */
export declare function scanModelFolder(rootPath: string): Promise<{
    assets: AssetEntry[];
    skipped: ImportModelFolderSkippedEntry[];
}>;
export {};
