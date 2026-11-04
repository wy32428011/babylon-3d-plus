import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveScope, HistoryDurability } from './types.ts';
import { HistoryStorageError } from './types.ts';
import { errorCode, need, sha256 } from './primitives.ts';

const UUID = '[a-f0-9-]{36}';
const RELATIVE_FILE = new RegExp(`^(?:identity\\.json|segments/(?:raw|changes|checkpoints)-${UUID}\\.(?:wal|gz)|journal/[0-9]{20}\\.wal|catalog/[0-9]{20}-${UUID}\\.(?:json|commit)(?:\\.tmp)?)$`, 'u');
export type ExactFile = { relativePath: string; bytes: number; sha256: string };
/** 私有目录仍须由操作系统 ACL 保护；lstat/O_NOFOLLOW 不能抵御有同目录写权限的恶意本机进程。 */
export class ArchiveFiles {
  readonly root: string;
  readonly durability: HistoryDurability;
  constructor(root: string, durability: HistoryDurability) { this.root = root; this.durability = durability; }
  static async prepareRoot(root: string, scope: ArchiveScope, durability: HistoryDurability): Promise<{ files: ArchiveFiles; domain: string }> {
    need(typeof root === 'string' && root.length <= 4096 && path.isAbsolute(root), 'PATH', '历史目录必须是服务器提供的有界绝对路径（最多 4096 字符）。');
    const normalized = path.resolve(root), parsed = path.parse(normalized);
    let current = parsed.root;
    for (const part of normalized.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await lstat(current);
      need(stat.isDirectory() && !stat.isSymbolicLink(), 'PATH', '历史目录及祖先不得为符号链接或 junction。');
    }
    const resolved = path.resolve(await realpath(normalized));
    need(process.platform === 'win32' ? resolved.toLowerCase() === normalized.toLowerCase() : resolved === normalized,
      'PATH', '历史目录解析结果不一致。');
    const project = await ArchiveFiles.child(normalized, `p-${sha256(scope.projectId)}`, durability);
    const domain = await ArchiveFiles.child(project, `d-${sha256(scope.captureDomainId)}`, durability);
    const epoch = await ArchiveFiles.child(domain, `e-${sha256(scope.captureEpoch)}`, durability);
    for (const part of ['segments', 'journal', 'catalog']) await ArchiveFiles.child(epoch, part, durability);
    return { files: new ArchiveFiles(epoch, durability), domain };
  }
  private static async child(parent: string, basename: string, durability: HistoryDurability): Promise<string> {
    const target = path.join(parent, basename);
    try { await mkdir(target, { mode: 0o700 }); await ArchiveFiles.syncDirectory(parent, durability); }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
    const stat = await lstat(target);
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'PATH', '存储子目录不是受控的普通目录。');
    return target;
  }
  static async syncDirectory(directory: string, durability: HistoryDurability): Promise<void> {
    if (durability === 'file-fsync') return;
    let handle: FileHandle | undefined;
    try { handle = await open(directory, constants.O_RDONLY); await handle.sync(); }
    catch (error) { throw new HistoryStorageError('DIRECTORY_FSYNC', '目录 fsync 失败；不能承诺文件名/提交标记的断电持久性。Windows 可显式选择 file-fsync，不能静默降级。', { cause: String(error) }); }
    finally { await handle?.close(); }
  }
  absolute(relative: string): string {
    need(RELATIVE_FILE.test(relative), 'PATH', '拒绝非本归档生成的相对文件名。', { relative });
    return path.join(this.root, ...relative.split('/'));
  }
  async list(directory: 'journal' | 'catalog' | 'segments', maxFiles: number): Promise<string[]> {
    const parent = path.join(this.root, directory), stat = await lstat(parent);
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'PATH', '存储目录被替换。');
    const entries = await readdir(parent, { withFileTypes: true });
    need(entries.length <= maxFiles, 'BUDGET', '存储目录文件数超过预算。');
    const result: string[] = [];
    for (const entry of entries) {
      const relative = `${directory}/${entry.name}`;
      need(!entry.isSymbolicLink(), 'PATH', '存储目录含符号链接。');
      // 非本任务文件从不读取或清理，也不能借其文件名成为删除候选。
      if (RELATIVE_FILE.test(relative) && entry.isFile()) result.push(relative);
    }
    return result;
  }
  async handle(relative: string, write = false): Promise<FileHandle> {
    const absolute = this.absolute(relative), parent = await lstat(path.dirname(absolute));
    need(parent.isDirectory() && !parent.isSymbolicLink(), 'PATH', '文件父目录被替换。');
    const before = await lstat(absolute);
    need(before.isFile() && !before.isSymbolicLink(), 'PATH', '归档对象必须是普通文件。');
    const handle = await open(absolute, (write ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
    try {
      const after = await handle.stat();
      need(after.isFile() && before.dev === after.dev && before.ino === after.ino, 'PATH', '归档文件在打开期间被替换。');
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async size(relative: string): Promise<number> {
    const handle = await this.handle(relative);
    try { const size = (await handle.stat()).size; need(Number.isSafeInteger(size), 'BUDGET', '物理文件超过安全尺寸。'); return size; }
    finally { await handle.close(); }
  }
  async exists(relative: string): Promise<boolean> {
    try { await this.size(relative); return true; }
    catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
  }
  async read(relative: string, maximum: number, offset = 0, length?: number): Promise<Buffer> {
    const handle = await this.handle(relative);
    try {
      const size = (await handle.stat()).size, count = length ?? size;
      need(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(count) && count >= 0 && count <= maximum
        && offset + count <= size, 'CORRUPT_FILE', '归档文件缺失、截短或读取超过预算。', { relative, offset, count, size });
      const bytes = Buffer.allocUnsafe(count); let completed = 0;
      while (completed < count) {
        const read = await handle.read(bytes, completed, count - completed, offset + completed);
        need(read.bytesRead > 0, 'CORRUPT_FILE', '归档文件在读取期间截短。'); completed += read.bytesRead;
      }
      return bytes;
    } finally { await handle.close(); }
  }
  async create(relative: string, bytes: Buffer = Buffer.alloc(0)): Promise<void> {
    const absolute = this.absolute(relative), parent = await lstat(path.dirname(absolute));
    need(parent.isDirectory() && !parent.isSymbolicLink(), 'PATH', '文件父目录被替换。');
    const handle = await open(absolute, 'wx', 0o600);
    try { await ArchiveFiles.writeAll(handle, bytes, 0); await handle.sync(); }
    finally { await handle.close(); }
    await ArchiveFiles.syncDirectory(path.dirname(absolute), this.durability);
  }
  async publish(relative: string, bytes: Buffer): Promise<void> {
    const temp = `${relative}.tmp`;
    await this.create(temp, bytes);
    need(!await this.exists(relative), 'FILE_EXISTS', '不可覆盖已有不可变文件。');
    await rename(this.absolute(temp), this.absolute(relative));
    await ArchiveFiles.syncDirectory(path.dirname(this.absolute(relative)), this.durability);
  }
  async append(relative: string, expectedOffset: number, bytes: Buffer): Promise<void> {
    const handle = await this.handle(relative, true);
    try {
      need((await handle.stat()).size === expectedOffset, 'UNCOMMITTED_TAIL', '文件尾与已知持久边界不同，须停止写入并恢复。');
      await ArchiveFiles.writeAll(handle, bytes, expectedOffset); await handle.sync();
    } finally { await handle.close(); }
  }
  async truncateUncommitted(relative: string, size: number, expectedSize: number): Promise<void> {
    const handle = await this.handle(relative, true);
    try {
      need((await handle.stat()).size === expectedSize && size <= expectedSize, 'CORRUPT_FILE', '恢复尾部时文件长度改变。');
      await handle.truncate(size); await handle.sync();
    } finally { await handle.close(); }
  }
  /** 仅接收已经写入持久删除计划的 exactFile；不会递归删除目录或按 glob 清理。 */
  async removeExact(file: ExactFile, maxBytes: number): Promise<boolean> {
    if (!await this.exists(file.relativePath)) return false;
    need(file.bytes <= maxBytes, 'BUDGET', '待删除文件超过校验预算。');
    const bytes = await this.read(file.relativePath, maxBytes);
    need(bytes.byteLength === file.bytes && sha256(bytes) === file.sha256, 'DELETE_MISMATCH', '待删除文件与持久计划不符，保留原文件。', { relativePath: file.relativePath });
    await unlink(this.absolute(file.relativePath));
    await ArchiveFiles.syncDirectory(path.dirname(this.absolute(file.relativePath)), this.durability);
    return true;
  }
  private static async writeAll(handle: FileHandle, bytes: Buffer, offset: number): Promise<void> {
    let completed = 0;
    while (completed < bytes.byteLength) {
      const result = await handle.write(bytes, completed, bytes.byteLength - completed, offset + completed);
      need(result.bytesWritten > 0, 'WRITE_FAILED', '持久文件写入没有前进。'); completed += result.bytesWritten;
    }
  }
}
