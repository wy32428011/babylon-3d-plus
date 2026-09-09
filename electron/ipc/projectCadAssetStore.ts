import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { authorizeAssetFile, encodeAssetUrl } from './assetRegistry.js';
import { assertTrustedPathWithinRoot } from './digitalTwinSourceEnvironmentRelink.js';

type ImportedCadFile = {
  filePath: string;
  sourceUrl: string;
  fileSizeBytes: number;
};

/** 保存用户选择的原始 DXF，每次导入使用独立目录，避免覆盖其它场景引用的同名图纸。 */
export async function importCadFileIntoProject(projectRoot: string, sourceFilePath: string): Promise<ImportedCadFile> {
  if (!path.isAbsolute(projectRoot) || !path.isAbsolute(sourceFilePath)) {
    throw new Error('导入 CAD 需要已选择的项目目录和完整源文件路径。');
  }
  const sourcePath = path.resolve(sourceFilePath);
  if (path.extname(sourcePath).toLowerCase() !== '.dxf') throw new Error('仅支持导入 .dxf CAD 图纸。');
  await assertTrustedPathWithinRoot(path.parse(sourcePath).root, sourcePath, 'CAD 源文件');
  const sourceStat = await fs.lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('CAD 源文件必须是普通文件。');

  const root = path.resolve(projectRoot);
  await assertTrustedPathWithinRoot(root, root, 'CAD 项目目录');
  const assetsRoot = path.join(root, 'Assets');
  const cadRoot = path.join(assetsRoot, 'Cad');
  // 逐层检查后再创建下一层，不能先 recursive mkdir 再发现祖先 Junction 已写到项目外。
  for (const directory of [assetsRoot, cadRoot]) {
    await fs.mkdir(directory).catch((error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    });
    await assertTrustedPathWithinRoot(root, directory, 'CAD 保存目录');
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error('CAD 保存路径必须是目录。');
  }

  const packagePath = await fs.mkdtemp(path.join(cadRoot, 'Import-'));
  const targetPath = path.join(packagePath, path.basename(sourcePath));
  try {
    await assertTrustedPathWithinRoot(root, packagePath, 'CAD 保存目录');
    await fs.copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
    await assertTrustedPathWithinRoot(path.parse(sourcePath).root, sourcePath, 'CAD 源文件');
    await assertTrustedPathWithinRoot(root, targetPath, 'CAD 项目副本');
    const [copiedStat, currentSourceStat] = await Promise.all([fs.lstat(targetPath), fs.lstat(sourcePath)]);
    if (!copiedStat.isFile() || copiedStat.isSymbolicLink() || copiedStat.size !== sourceStat.size
      || !currentSourceStat.isFile() || currentSourceStat.isSymbolicLink()
      || currentSourceStat.size !== sourceStat.size || currentSourceStat.mtimeMs !== sourceStat.mtimeMs
      || currentSourceStat.ino !== sourceStat.ino) {
      throw new Error('CAD 源文件在复制过程中发生变化，请重新导入。');
    }
    authorizeAssetFile(targetPath);
    return { filePath: targetPath, sourceUrl: encodeAssetUrl(targetPath), fileSizeBytes: copiedStat.size };
  } catch (error) {
    try {
      // 只清理本次创建且仍位于可信项目内的独立目录。
      if (path.dirname(packagePath) !== cadRoot) throw new Error('CAD 临时目录越界，已停止清理。');
      await assertTrustedPathWithinRoot(root, packagePath, 'CAD 临时目录');
      await fs.rm(packagePath, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'CAD 导入失败，项目副本目录清理失败。');
    }
    throw error;
  }
}
