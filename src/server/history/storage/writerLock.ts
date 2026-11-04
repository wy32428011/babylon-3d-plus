import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { compareDecimal } from '../../../runtime/history/state/safeJson.ts';
import type { ArchiveScope, HistoryDurability, HistoryWriter } from './types.ts';
import { ArchiveFiles } from './files.ts';
import { clone, errorCode, need, pack, parse, same, sha256 } from './primitives.ts';

type LockRecord = { format: 'history-owner/1'; lockId: string; projectId: string; captureDomainId: string; writer: HistoryWriter };
/** 所有方法只能在 HistoryFencingPort.runExclusive 内调用。没有 PID 探测、进程终止或超时抢锁。 */
export class ArchiveWriterLock {
  private constructor(readonly file: string, readonly record: LockRecord, readonly digest: string, readonly durability: HistoryDurability) {}
  static async acquire(domain: string, scope: ArchiveScope, writer: HistoryWriter, durability: HistoryDurability, reclaim?: HistoryWriter): Promise<{ lock: ArchiveWriterLock; reclaimed: boolean }> {
    const file = path.join(domain, '.history-writer.json'); let reclaimed = false;
    try {
      const previous = await ArchiveWriterLock.read(file);
      need(reclaim && same(previous.record.writer, reclaim) && previous.record.projectId === scope.projectId
        && previous.record.captureDomainId === scope.captureDomainId && compareDecimal(writer.fencingToken, reclaim.fencingToken) > 0,
      'WRITER_LOCKED', '已有 writer 所有权记录；须由持久授权层换代并显式指定原 owner 后恢复，不能按超时偷锁。', { previousWriter: previous.record.writer });
      // 外层持久 fence 在整个回调期间排他；旧 writer 的任何磁盘修改也必须经过相同 gate。
      const current = await ArchiveWriterLock.read(file);
      need(current.digest === previous.digest, 'WRITER_LOCKED', 'writer 所有权已改变。');
      await unlink(file); await ArchiveFiles.syncDirectory(domain, durability); reclaimed = true;
    } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    const record: LockRecord = { format: 'history-owner/1', lockId: randomUUID(), projectId: scope.projectId,
      captureDomainId: scope.captureDomainId, writer: clone(writer) };
    const bytes = pack(record, 8192), temporary = path.join(domain, `.history-writer-${record.lockId}.tmp`);
    let created = false, failed = false, failure: unknown;
    try {
      const handle = await open(temporary, 'wx', 0o600); created = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await link(temporary, file);
      await ArchiveFiles.syncDirectory(domain, durability);
    } catch (error) { failed = true; failure = error; }
    if (created) {
      try { await unlink(temporary); await ArchiveFiles.syncDirectory(domain, durability); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
    if (failed) throw failure;
    return { lock: new ArchiveWriterLock(file, record, sha256(bytes), durability), reclaimed };
  }
  private static async read(file: string): Promise<{ record: LockRecord; digest: string }> {
    const before = await lstat(file, { bigint: true });
    need(before.isFile() && !before.isSymbolicLink() && before.size <= 8192n, 'WRITER_LOCK', 'writer 所有权文件无效。');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const after = await handle.stat({ bigint: true });
      need(before.dev === after.dev && before.ino === after.ino && after.size <= 8192n, 'WRITER_LOCK', 'writer 文件在打开期间改变。');
      const bytes = await handle.readFile(), record = parse<LockRecord>(bytes, 8192);
      need(record.format === 'history-owner/1' && typeof record.lockId === 'string', 'WRITER_LOCK', 'writer 所有权记录损坏。');
      return { record, digest: sha256(bytes) };
    } finally { await handle.close(); }
  }
  async assertOwned(): Promise<void> {
    need((await ArchiveWriterLock.read(this.file)).digest === this.digest, 'FENCED', '当前实例已不拥有该关联域的 writer 锁。');
  }
  async release(): Promise<void> {
    await this.assertOwned(); await unlink(this.file); await ArchiveFiles.syncDirectory(path.dirname(this.file), this.durability);
  }
}
