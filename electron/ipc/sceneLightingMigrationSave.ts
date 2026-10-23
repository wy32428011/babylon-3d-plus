import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
function lightingVersion(content: string): { scene: boolean; version: unknown } {
  const envelope = object(JSON.parse(content.replace(/^\uFEFF/, '')));
  const scene = object(envelope?.scene);
  const settings = object(scene?.sceneSettings);
  return { scene: Boolean(scene && settings), version: object(settings?.lighting)?.version };
}

/** 首次覆盖旧格式前保留原始字节；备份失败必须阻止后续写盘。 */
export async function preserveLegacyLightingSceneBeforeWrite(filePath: string, nextContent: string): Promise<string | null> {
  const next = lightingVersion(nextContent);
  if (!next.scene || next.version !== 2) return null;
  let original: Buffer;
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('场景迁移目标必须是普通文件，未写入。');
    original = await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let previous: ReturnType<typeof lightingVersion>;
  try { previous = lightingVersion(original.toString('utf8')); }
  catch { return null; }
  if (!previous.scene || previous.version === 2) return null;
  const hash = createHash('sha256').update(original).digest('hex').slice(0, 12);
  const backup = filePath + '.before-lighting-v2.' + hash + '.bak';
  try { await fs.writeFile(backup, original, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const backupStat = await fs.lstat(backup);
    if (backupStat.isSymbolicLink() || !backupStat.isFile() || !(await fs.readFile(backup)).equals(original)) {
      throw new Error('场景迁移备份路径被不同内容占用，未覆盖原文件：' + backup, { cause: error });
    }
  }
  // 校验目标没有在读取和备份期间被其他任务改写。
  if (!(await fs.readFile(filePath)).equals(original)) throw new Error('场景文件在备份期间已变化，未覆盖，请重新保存。');
  return backup;
}
