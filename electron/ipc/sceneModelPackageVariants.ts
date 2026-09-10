import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectModelAssetEntry } from '../types.js';
import type { SceneModelUpdateItem } from '../shared/sceneModelUpdatePlan.js';
import { getClickEventModelResourceKey } from '../shared/clickEventModelIdentity.js';
import { encodeAssetUrl } from './assetRegistry.js';

/** 子模型只按经过身份校验的包内路径关联，绝不以主模型替换缺失子模型。 */
export async function includeSceneModelPackageVariants(item: SceneModelUpdateItem, assets: ProjectModelAssetEntry[],
  signal: AbortSignal): Promise<ProjectModelAssetEntry[]> {
  const result = [...assets];
  const paths = item.variants?.map(variant => variant.modelPath) ?? [item.modelPath];
  for (const relativePath of paths) {
    signal.throwIfAborted();
    if (assets.some(asset => getClickEventModelResourceKey(asset.sourceUrl)?.split(':')[2] === relativePath)) continue;
    const roots = new Map(assets.filter(asset => asset.packagePath).map(asset => [asset.packagePath!, asset]));
    if (roots.size !== 1) continue;
    const [packageRoot, base] = [...roots][0];
    if (!relativePath || path.isAbsolute(relativePath) || /[\\:?#]/.test(relativePath)
      || relativePath.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('包内子模型路径无效。');
    const file = path.resolve(packageRoot, relativePath);
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const root = await fs.realpath(packageRoot), realFile = await fs.realpath(file);
    const relative = path.relative(root, realFile);
    if (stat.isSymbolicLink() || !stat.isFile() || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('包内子模型不在已校验资源包内。');
    result.push({ ...base, id: file, path: file, sourceUrl: encodeAssetUrl(file), name: path.basename(file), fileSizeBytes: stat.size });
  }
  signal.throwIfAborted();
  return result;
}
