import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertTrustedPathWithinRoot } from './digitalTwinSourceEnvironmentRelink.js';

/** 创建每一级之前先验证已存在的父目录，避免 recursive mkdir 穿过 Junction 后才报错。 */
export async function ensureOpeningDirectory(projectRoot: string, target: string): Promise<void> {
  const root = path.resolve(projectRoot), relative = path.relative(root, path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('开场资源目录不在工程内部。');
  let current = root;
  await assertTrustedPathWithinRoot(root, current, '开场资源目录');
  for (const segment of relative.split(path.sep)) {
    const next = path.join(current, segment);
    await assertTrustedPathWithinRoot(root, current, '开场资源父目录');
    try { await fs.mkdir(next); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await assertTrustedPathWithinRoot(root, next, '开场资源目录');
    if (!(await fs.lstat(next)).isDirectory()) throw new Error('开场资源路径不是目录。');
    current = next;
  }
}
