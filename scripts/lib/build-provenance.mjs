import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Git diff 不含新增文件；同时记录实际构建输入的路径与内容身份。 */
export function captureBuildInputs(workspace) {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: workspace, maxBuffer: 32 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(name => /^(?:src\/|electron\/|scripts\/|public\/|(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vite[^/]*\.ts|index\.html|viewer\.html)$)/.test(name));
  const files = [];
  for (const name of [...new Set(names)].sort()) {
    try {
      files.push({ path: name, sha256: createHash('sha256').update(readFileSync(path.join(workspace, name))).digest('hex') });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { scope: 'Git tracked and non-ignored untracked build inputs; generated/ignored external assets require separate scene manifest',
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}
