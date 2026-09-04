/** 虚拟输送线内置模型包的共享解析与惰性导入辅助。 */

export const VIRTUAL_CONVEYOR_PACKAGE_NAME = 'virtual-conveyor';

export type VirtualConveyorAssetResult = {
  asset: ProjectModelAssetEntry | null;
  projectAssets: ProjectModelAssetEntry[];
  imported: boolean;
  error: string | null;
};

/** 按模型库 packagePath 目录名判定是否为虚拟输送线资产。 */
export function isVirtualConveyorPackageAsset(asset: ProjectModelAssetEntry): boolean {
  if (asset.kind !== 'model' || asset.libraryKind !== 'model') return false;
  const packageDirectory = asset.packagePath?.split(/[\\/]/).filter(Boolean).pop();
  return packageDirectory === VIRTUAL_CONVEYOR_PACKAGE_NAME;
}

/**
 * 确保虚拟输送线模型包已导入当前项目：先查项目模型库，缺失时经主进程从内置模板复制导入。
 * 返回最新项目资产快照，供调用方刷新本地资源库状态。
 */
export async function ensureVirtualConveyorAsset(): Promise<VirtualConveyorAssetResult> {
  const failure = (error: string): VirtualConveyorAssetResult => ({
    asset: null,
    projectAssets: [],
    imported: false,
    error,
  });

  const api = window.editorApi;
  if (!api?.listProjectAssets || !api.importBuiltinModelPackage) {
    return failure('放置虚拟输送线需要 Electron 桌面环境。');
  }

  try {
    const listed = await api.listProjectAssets();
    const existing = listed.assets.find(isVirtualConveyorPackageAsset);
    if (existing) {
      return { asset: existing, projectAssets: listed.assets, imported: false, error: null };
    }

    const imported = await api.importBuiltinModelPackage({ packageName: VIRTUAL_CONVEYOR_PACKAGE_NAME });
    if (imported.canceled) {
      return failure('导入虚拟输送线模型包需要先选择项目目录。');
    }
    const skippedReason = imported.skipped[0]?.reason;
    if (skippedReason) {
      return failure(`虚拟输送线模型包导入被跳过：${skippedReason}`);
    }
    const asset = imported.projectAssets.find(isVirtualConveyorPackageAsset) ?? null;
    if (!asset) {
      return failure('虚拟输送线模型包导入后未在模型库中找到。');
    }
    return { asset, projectAssets: imported.projectAssets, imported: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`虚拟输送线模型包导入失败：${message}`);
  }
}
