import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArchiveScope, HistoryDurability, HistoryWriter } from '../storage/types.ts';
import { ArchiveFiles } from '../storage/files.ts';
import { clone, errorCode, frame, need, pack, parse, same, sha256, unframe } from '../storage/primitives.ts';
import { compareDecimal } from '../../../runtime/history/state/safeJson.ts';

const SEGMENT = /^([0-9]{12})\.events$/u;
type Lock = { format: 'history-event-owner/1'; id: string; scope: ArchiveScope; writer: HistoryWriter };
export type EventFileLimits = { maxSegmentBytes: number; maxFrameBytes: number; maxStoredBytes: number; maxRecoveryBytes: number; maxSegments: number };
export type FrameLocation = { segment: number; offset: number; bytes: number; digest: string };

/** 索引目录必须是受 ACL 保护的私有本地目录；不遍历、删除任何非本索引文件。 */
export class EventFiles {
  #segment = 0; #offset = 0; #total = 0; #lockDigest = ''; #reclaimed = false;
  private constructor(readonly dir: string, readonly durability: HistoryDurability, readonly limits: EventFileLimits) {}
  static async open(root: string, key: string, scope: ArchiveScope, writer: HistoryWriter, durability: HistoryDurability,
    limits: EventFileLimits, reclaim?: HistoryWriter): Promise<EventFiles> {
    need(path.isAbsolute(root) && root.length <= 4096, 'PATH', '事件索引根目录必须是已部署的绝对路径。');
    const normalized = path.resolve(root), parsed = path.parse(normalized); let current = parsed.root;
    for (const part of normalized.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); const stat = await lstat(current);
      need(stat.isDirectory() && !stat.isSymbolicLink(), 'PATH', '事件目录及其祖先不得为 symlink/junction。');
    }
    const resolved = path.resolve(await realpath(normalized));
    need(process.platform === 'win32' ? resolved.toLowerCase() === normalized.toLowerCase() : resolved === normalized, 'PATH', '事件目录解析结果不一致。');
    const dir = path.join(normalized, `events-${sha256(key)}`);
    try { await mkdir(dir, { mode: 0o700 }); await ArchiveFiles.syncDirectory(normalized, durability); }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
    const stat = await lstat(dir); need(stat.isDirectory() && !stat.isSymbolicLink(), 'PATH', '事件目录不是普通目录。');
    const files = new EventFiles(dir, durability, limits); await files.acquire(scope, writer, reclaim); return files;
  }
  private filename(name: string): string {
    need(name === 'identity' || name === 'identity.tmp' || name === 'owner' || SEGMENT.test(name), 'PATH', '事件索引拒绝非自有文件名。');
    return path.join(this.dir, name);
  }
  private async checkedHandle(name: string, write = false): Promise<FileHandle> {
    const parent = await lstat(this.dir); need(parent.isDirectory() && !parent.isSymbolicLink(), 'PATH', '事件目录被替换。');
    const file = this.filename(name), before = await lstat(file);
    need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'PATH', '事件文件必须是单链接普通文件。');
    const handle = await open(file, (write ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
    try { const after = await handle.stat(); need(after.isFile() && after.nlink === 1 && before.dev === after.dev && before.ino === after.ino, 'PATH', '事件文件在打开时被替换或存在外部硬链接。'); return handle; }
    catch (error) { await handle.close(); throw error; }
  }
  private async create(name: string, data: Buffer): Promise<void> {
    const parent = await lstat(this.dir); need(parent.isDirectory() && !parent.isSymbolicLink(), 'PATH', '事件目录被替换。');
    const handle = await open(this.filename(name), 'wx', 0o600);
    try { await this.writeAll(handle, data, 0); await handle.sync(); } finally { await handle.close(); }
    await ArchiveFiles.syncDirectory(this.dir, this.durability);
  }
  private async writeAll(handle: FileHandle, data: Buffer, offset: number): Promise<void> {
    let position = 0; while (position < data.length) { const result = await handle.write(data, position, data.length - position, offset + position);
      need(result.bytesWritten > 0, 'WRITE_FAILED', '事件索引写入未前进。'); position += result.bytesWritten; }
  }
  private async acquire(scope: ArchiveScope, writer: HistoryWriter, reclaim?: HistoryWriter): Promise<void> {
    try {
      const data = await this.readFile('owner', 16_384), previous = parse<Lock>(unframe(data, 16_348), 16_348);
      need(previous.format === 'history-event-owner/1' && same(previous.scope, scope) && reclaim && same(previous.writer, reclaim)
        && compareDecimal(writer.fencingToken, reclaim.fencingToken) > 0, 'WRITER_LOCKED', '事件索引已有所有者；必须持久换代并显式指定原 owner。');
      need(sha256(await this.readFile('owner', 16_384)) === sha256(data), 'WRITER_LOCKED', '事件所有者在恢复时改变。');
      await unlink(this.filename('owner')); await ArchiveFiles.syncDirectory(this.dir, this.durability); this.#reclaimed = true;
    } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    const record: Lock = { format: 'history-event-owner/1', id: randomUUID(), scope: clone(scope), writer: clone(writer) };
    const bytes = frame(pack(record, 16_348)); await this.create('owner', bytes); this.#lockDigest = sha256(bytes);
  }
  async assertOwned(): Promise<void> { need(sha256(await this.readFile('owner', 16_384)) === this.#lockDigest, 'FENCED', '事件索引已失去 writer 所有权。'); }
  async release(): Promise<void> { await this.assertOwned(); await unlink(this.filename('owner')); await ArchiveFiles.syncDirectory(this.dir, this.durability); }
  async readFile(name: string, maximum: number, offset = 0, count?: number,
    charge?: { onRead(): void; onBytes(bytes: number): void }): Promise<Buffer> {
    const handle = await this.checkedHandle(name);
    try {
      const size = (await handle.stat()).size, length = count ?? size;
      need(Number.isSafeInteger(size) && Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length)
        && length >= 0 && length <= maximum && offset + length <= size, 'CORRUPT_FILE', '事件文件截短或读取超出预算。');
      const data = Buffer.allocUnsafe(length); let done = 0;
      while (done < length) {
        charge?.onRead(); const item = await handle.read(data, done, length - done, offset + done);
        charge?.onBytes(item.bytesRead); need(item.bytesRead > 0, 'CORRUPT_FILE', '事件文件读取时截短。'); done += item.bytesRead;
      }
      return data;
    } finally { await handle.close(); }
  }
  async identity<T>(initial: T): Promise<T> {
    try {
      const existing = parse<T>(unframe(await this.readFile('identity', 65_536), 65_500), 65_500);
      await this.removeIdentityTemp(true); return existing;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      await this.removeIdentityTemp(this.#reclaimed);
      const entries = await readdir(this.dir);
      need(entries.every(entry => entry === 'owner'), 'CORRUPT_INDEX', '存在事件数据却缺少身份记录，不能初始化空索引。');
      await this.create('identity.tmp', frame(pack(initial, 65_500)));
      await rename(this.filename('identity.tmp'), this.filename('identity'));
      await ArchiveFiles.syncDirectory(this.dir, this.durability);
      return initial;
    }
  }
  private async removeIdentityTemp(owned: boolean): Promise<void> {
    try {
      const handle = await this.checkedHandle('identity.tmp'); await handle.close();
      need(owned, 'PATH', '缺少可证明的事件目录所有权，不能删除未知临时文件。');
      await unlink(this.filename('identity.tmp')); await ArchiveFiles.syncDirectory(this.dir, this.durability);
    } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
  /** 完整校验帧，只有最后文件的不完整尾部可回退；所有恢复均由外层持久 fencing 包围。 */
  async recover(onFrame: (location: FrameLocation, payload: Buffer) => void): Promise<void> {
    const entries = await readdir(this.dir, { withFileTypes: true });
    need(entries.length <= this.limits.maxSegments + 2, 'INDEX_CAPACITY', '事件目录文件数超过预算。');
    for (const entry of entries) need(!entry.isSymbolicLink() && entry.isFile()
      && (entry.name === 'owner' || entry.name === 'identity' || SEGMENT.test(entry.name)), 'PATH', '事件目录含未知文件或符号链接，拒绝读取和清理。');
    const names = entries.map(entry => entry.name).filter(name => SEGMENT.test(name)).sort();
    let recovered = (await this.readFile('identity', 65_536)).byteLength + (await this.readFile('owner', 16_384)).byteLength;
    this.#total = recovered;
    need(recovered <= this.limits.maxRecoveryBytes && this.#total <= this.limits.maxStoredBytes, 'RECOVERY_BUDGET', '事件元数据超出恢复或存储预算。');
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]; need(name === this.segmentName(index), 'CORRUPT_INDEX', '事件段缺失或序号不连续。');
      const handle = await this.checkedHandle(name, true);
      try {
        const size = (await handle.stat()).size;
        need(size <= this.limits.maxSegmentBytes && recovered + size <= this.limits.maxRecoveryBytes
          && this.#total + size <= this.limits.maxStoredBytes, 'RECOVERY_BUDGET', '恢复事件段的实际读取或存储超过预算。');
        recovered += size; this.#total += size;
        const data = Buffer.allocUnsafe(size); let read = 0;
        while (read < size) { const result = await handle.read(data, read, size - read, read); need(result.bytesRead > 0, 'CORRUPT_FILE', '恢复期间事件段截短。'); read += result.bytesRead; }
        let offset = 0;
        while (offset < size) {
          if (size - offset < 4) break;
          const payloadLength = data.readUInt32BE(offset); need(payloadLength <= this.limits.maxFrameBytes, 'CORRUPT_FRAME', '事件帧长度超过预算。');
          const length = payloadLength + 36; if (offset + length > size) break;
          const bytes = data.subarray(offset, offset + length), payload = unframe(bytes, this.limits.maxFrameBytes);
          onFrame({ segment: index, offset, bytes: length, digest: sha256(payload) }, payload); offset += length;
        }
        if (offset !== size) {
          need(index === names.length - 1, 'CORRUPT_FILE', '非末尾事件段出现不完整帧。');
          await handle.truncate(offset); await handle.sync(); this.#total -= size - offset;
        }
        this.#segment = index; this.#offset = offset;
      } finally { await handle.close(); }
    }
    if (!names.length) { await this.create(this.segmentName(0), Buffer.alloc(0)); this.#segment = 0; this.#offset = 0; }
  }
  private segmentName(index: number): string { need(Number.isSafeInteger(index) && index >= 0 && index < this.limits.maxSegments, 'INDEX_CAPACITY', '事件分段数达到上限。'); return `${String(index).padStart(12, '0')}.events`; }
  async append(payload: Buffer): Promise<FrameLocation> {
    need(payload.length <= this.limits.maxFrameBytes, 'EVENT_BUDGET', '事件提交组超过帧预算。');
    const bytes = frame(payload); need(this.#total + bytes.length <= this.limits.maxStoredBytes, 'STORAGE_BACKPRESSURE', '事件索引存储容量已满，不能静默丢失事件。');
    if (this.#offset + bytes.length > this.limits.maxSegmentBytes) {
      this.#segment += 1; await this.create(this.segmentName(this.#segment), Buffer.alloc(0)); this.#offset = 0;
    }
    const handle = await this.checkedHandle(this.segmentName(this.#segment), true), offset = this.#offset;
    try { need((await handle.stat()).size === offset, 'UNCOMMITTED_TAIL', '事件段尾与内存水位不一致，须重新恢复。');
      await this.writeAll(handle, bytes, offset); await handle.sync(); }
    finally { await handle.close(); }
    this.#offset += bytes.length; this.#total += bytes.length;
    return { segment: this.#segment, offset, bytes: bytes.length, digest: sha256(payload) };
  }
  async readFrame(location: FrameLocation, charge?: { onRead(): void; onBytes(bytes: number): void }): Promise<Buffer> {
    const bytes = await this.readFile(this.segmentName(location.segment), this.limits.maxFrameBytes + 36, location.offset, location.bytes, charge);
    const payload = unframe(bytes, this.limits.maxFrameBytes); need(sha256(payload) === location.digest, 'CHECKSUM', '事件帧与固定索引不匹配。'); return payload;
  }
}
