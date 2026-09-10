import { promises as fs } from 'node:fs';
import path from 'node:path';

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** 目标可尚未创建，但任何已有祖先的真实位置必须位于调用方给定的根目录内。 */
export async function assertRecoveryPathInsideRoot(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root), resolvedTarget = path.resolve(target);
  if (!inside(resolvedRoot, resolvedTarget)) throw new Error('资源恢复路径超出指定根目录。');
  const realRoot = await fs.realpath(resolvedRoot);
  let ancestor = resolvedTarget;
  for (;;) {
    try {
      await fs.lstat(ancestor);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor || !inside(resolvedRoot, parent)) throw new Error('资源恢复路径没有可验证的根目录。');
      ancestor = parent;
      continue;
    }
    const realAncestor = await fs.realpath(ancestor);
    if (!inside(realRoot, realAncestor)) throw new Error('资源恢复路径通过符号链接或 junction 越界。');
    return;
  }
}
