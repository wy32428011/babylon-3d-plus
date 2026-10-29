import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const pendingSaves = new Map<string, Promise<unknown>>();

/** 资源准备、迁移备份和文件替换必须共用目标路径的锁。 */
export async function withSceneSaveLock<T>(filePath: string, save: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(filePath);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const previous = pendingSaves.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(save);
  pendingSaves.set(key, task);
  try { return await task; }
  finally { if (pendingSaves.get(key) === task) pendingSaves.delete(key); }
}

/** 只替换完整写入的同目录临时文件，任何失败都不先删除原场景。 */
export async function writeSceneFileAtomically(filePath: string, content: string): Promise<void> {
  let mode: number | undefined;
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('场景保存目标必须是普通文件。');
    mode = stat.mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, 'wx', mode);
  try {
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(error => {
      console.warn('[scene:save] 清理保存临时文件失败。', error);
    });
  }
}
