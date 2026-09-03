import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectModelAssetEntry } from '../types.js';
import { authorizeAssetFile } from './assetRegistry.js';
import { inspectGlbModelFile, scanModelPackage } from './modelPackageScanner.js';
import {
  getProjectModelsRoot,
  readProjectAssetIndex,
  writeProjectAssetIndex,
} from './projectAssetStore.js';

/** 独立目录保留每次上传，避免同名人物覆盖其他场景正在引用的文件。 */
export async function importManualRoamAvatarIntoProject(
  projectRoot: string,
  sourceFilePath: string,
): Promise<ProjectModelAssetEntry> {
  try {
    await inspectGlbModelFile(sourceFilePath);
  } catch (error) {
    throw new Error(`人物模型校验失败：${error instanceof Error ? error.message.replaceAll('环境', '人物') : String(error)}`);
  }
  const modelsRoot = path.resolve(getProjectModelsRoot(projectRoot));
  await fs.mkdir(modelsRoot, { recursive: true });
  const packagePath = await fs.mkdtemp(path.join(modelsRoot, 'RoamAvatar-'));
  const targetPath = path.join(packagePath, path.basename(sourceFilePath));
  try {
    await fs.copyFile(sourceFilePath, targetPath);
    await inspectGlbModelFile(targetPath);
    const scanned = await scanModelPackage(packagePath);
    if (!scanned.asset) throw new Error(scanned.skipped?.reason ?? '人物模型扫描失败。');
    const asset: ProjectModelAssetEntry = {
      ...scanned.asset,
      name: path.parse(sourceFilePath).name,
      displayName: path.parse(sourceFilePath).name,
      kind: 'model', libraryKind: 'model',
    };
    const index = await readProjectAssetIndex(projectRoot);
    await writeProjectAssetIndex(projectRoot, { version: 2, assets: [...index.assets, asset] });
    authorizeAssetFile(asset.path);
    return asset;
  } catch (error) {
    // 仅回收本次 mkdtemp 创建的直属目录。
    if (path.dirname(packagePath) !== modelsRoot) throw error;
    try {
      await fs.rm(packagePath, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '人物导入失败，临时模型目录清理失败。');
    }
    throw error;
  }
}
