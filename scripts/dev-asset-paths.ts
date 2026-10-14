import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { loadEnv } from 'vite';

/** 只读取模型库变量；显式进程配置优先，历史盘符可用时保留兼容。 */
export function resolveDevAssetRoots(workspace: string, mode: string, environment: Record<string, string | undefined> = process.env,
  isDirectory: (directory: string) => boolean = directory => existsSync(directory) && statSync(directory).isDirectory()): string[] {
  const root = path.resolve(workspace);
  const fromFile = loadEnv(mode, root, 'STACKER_MODEL_LIBRARY_ROOT').STACKER_MODEL_LIBRARY_ROOT;
  const configured = environment.STACKER_MODEL_LIBRARY_ROOT?.trim() || fromFile?.trim();
  const legacy = path.resolve('F:/3d-models');
  return [root, configured ? path.resolve(root, configured) : isDirectory(legacy) ? legacy : root];
}

/** 延续现有根目录边界，不允许父目录、兄弟前缀目录或跨盘符访问。 */
export function isAllowedDevAssetPath(filePath: string, roots: string[]): boolean {
  const resolved = path.resolve(filePath);
  return roots.some(root => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}
