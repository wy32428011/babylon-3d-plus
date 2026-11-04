import { randomUUID } from 'node:crypto';
import { compareDecimal, nextDecimal } from '../../../runtime/history/state/safeJson.ts';
import type { ArchiveLimits, ArchiveRecoveryNotice, HistoryWriter } from './types.ts';
import { ArchiveFiles } from './files.ts';
import type { ExactFile } from './files.ts';
import { clone, frame, need, pack, parse, same, sha256, unframe } from './primitives.ts';

export type JournalPosition = { sequence: string; hash: string; writer: HistoryWriter };
type Entry<E> = { format: 'history-journal/1'; archiveId: string; sequence: string; previousHash: string; writer: HistoryWriter; event: E };
type CatalogMarker = {
  format: 'history-catalog/1'; archiveId: string; position: JournalPosition; nextFileIndex: string;
  catalog: ExactFile; cleanup: ExactFile[];
};
const ZERO_HASH = '0'.repeat(64);
function numbered(index: string): string { need(index.length <= 20, 'BUDGET', '物理日志段编号超过上限。'); return index.padStart(20, '0'); }
function journalName(index: string): string { return `journal/${numbered(index)}.wal`; }
function fileIndex(name: string): string { return BigInt(name.slice(name.indexOf('/') + 1, name.indexOf('/') + 21)).toString(); }
/** 先追加完整帧并 fsync，再更新内存索引。所有修改由宿主的写队列和持久 fence 包围。 */
export class ArchiveJournal<E> {
  #position: JournalPosition;
  #fileIndex = '1';
  #fileBytes = 0;
  #replayBytes = 0;
  #files: string[] = [];
  #catalog: { markerPath: string; marker: CatalogMarker } | null = null;
  private constructor(readonly files: ArchiveFiles, readonly archiveId: string, readonly limits: Readonly<ArchiveLimits>, writer: HistoryWriter,
    readonly apply: (event: E, position: JournalPosition) => void) {
    this.#position = { sequence: '0', hash: ZERO_HASH, writer: { ownerId: '', fencingToken: '0' } };
  }
  get position(): JournalPosition { return clone(this.#position); }
  get bytesSinceCatalog(): number { return this.#replayBytes; }
  get knownMetadataPaths(): ReadonlySet<string> {
    const paths = new Set(this.#files);
    if (this.#catalog) {
      paths.add(this.#catalog.markerPath); paths.add(this.#catalog.marker.catalog.relativePath);
      for (const file of this.#catalog.marker.cleanup) paths.add(file.relativePath);
    }
    return paths;
  }
  static async open<E, S>(files: ArchiveFiles, archiveId: string, limits: Readonly<ArchiveLimits>, writer: HistoryWriter,
    loadCatalog: (state: S) => void, apply: (event: E, position: JournalPosition) => void,
    notices: ArchiveRecoveryNotice[]): Promise<ArchiveJournal<E>> {
    const journal = new ArchiveJournal(files, archiveId, limits, writer, apply);
    const catalogs = (await files.list('catalog', limits.maxIndexEntries)).filter(name => name.endsWith('.commit')).sort();
    let expectedFile = '1';
    if (catalogs.length) {
      const markerPath = catalogs[catalogs.length - 1];
      const marker = parse<CatalogMarker>(unframe(await files.read(markerPath, limits.maxCatalogBytes), limits.maxCatalogBytes), limits.maxCatalogBytes);
      need(marker.format === 'history-catalog/1' && marker.archiveId === archiveId
        && /^catalog\/[0-9]{20}-[a-f0-9-]{36}\.json$/u.test(marker.catalog.relativePath), 'CORRUPT_CATALOG', '归档快照标记身份或文件类型不一致。');
      const bytes = await files.read(marker.catalog.relativePath, limits.maxCatalogBytes);
      need(bytes.byteLength === marker.catalog.bytes && sha256(bytes) === marker.catalog.sha256, 'CORRUPT_CATALOG', '元数据快照校验失败。');
      loadCatalog(parse<S>(bytes, limits.maxCatalogBytes, limits.maxIndexEntries));
      journal.#position = clone(marker.position); expectedFile = marker.nextFileIndex;
      journal.#catalog = { markerPath, marker };
    }
    need(compareDecimal(writer.fencingToken, journal.#position.writer.fencingToken) >= 0
      && (writer.fencingToken !== journal.#position.writer.fencingToken || writer.ownerId === journal.#position.writer.ownerId),
    'FENCED', '持久 writer 代际高于当前授权。');
    const allFiles = (await files.list('journal', limits.maxIndexEntries)).sort();
    journal.#files = allFiles.filter(name => compareDecimal(fileIndex(name), expectedFile) >= 0);
    for (let index = 0; index < journal.#files.length; index += 1) {
      const relative = journal.#files[index];
      need(fileIndex(relative) === expectedFile, 'JOURNAL_GAP', '提交日志缺少中间段，不能标记连续。', { expectedFile, relative });
      const bytes = await files.read(relative, limits.maxJournalSegmentBytes);
      journal.#replayBytes += bytes.byteLength;
      need(journal.#replayBytes <= limits.maxJournalReplayBytes, 'RECOVERY_BUDGET', '提交日志恢复超过预算；须使用已提交元数据快照，不能跳过旧段。');
      let cursor = 0;
      while (cursor < bytes.byteLength) {
        const remaining = bytes.byteLength - cursor;
        let size: number | null = null;
        if (remaining >= 4) {
          const payloadBytes = bytes.readUInt32BE(cursor);
          need(payloadBytes <= limits.maxJournalRecordBytes, 'CORRUPT_JOURNAL', '提交帧长度损坏或超过预算。');
          size = payloadBytes + 36;
        }
        if (size === null || remaining < size) {
          need(index === journal.#files.length - 1, 'JOURNAL_GAP', '非末尾日志段含半写帧，不能越过缺口恢复。');
          await files.truncateUncommitted(relative, cursor, bytes.byteLength);
          notices.push({ kind: 'uncommitted-journal-tail', relativePath: relative, discardedBytes: remaining });
          journal.#replayBytes -= remaining; break;
        }
        const payload = unframe(bytes.subarray(cursor, cursor + size), limits.maxJournalRecordBytes);
        const entry = parse<Entry<E>>(payload, limits.maxJournalRecordBytes, limits.maxIndexEntries);
        need(entry.format === 'history-journal/1' && entry.archiveId === archiveId && entry.sequence === nextDecimal(journal.#position.sequence)
          && entry.previousHash === journal.#position.hash, 'JOURNAL_GAP', '提交链顺序、归档身份或前驱校验和不匹配。');
        need(compareDecimal(entry.writer.fencingToken, journal.#position.writer.fencingToken) >= 0
          && (entry.writer.fencingToken !== journal.#position.writer.fencingToken || entry.writer.ownerId === journal.#position.writer.ownerId),
        'FENCED', '提交日志包含旧 writer 或同代异主记录。');
        journal.#position = { sequence: entry.sequence, hash: sha256(payload), writer: clone(entry.writer) };
        apply(entry.event, journal.position); cursor += size;
      }
      journal.#fileIndex = expectedFile; journal.#fileBytes = cursor; expectedFile = nextDecimal(expectedFile);
    }
    if (journal.#files.length === 0) {
      journal.#fileIndex = expectedFile; await files.create(journalName(expectedFile)); journal.#files.push(journalName(expectedFile));
    }
    need(compareDecimal(writer.fencingToken, journal.#position.writer.fencingToken) >= 0
      && (writer.fencingToken !== journal.#position.writer.fencingToken || writer.ownerId === journal.#position.writer.ownerId), 'FENCED', '当前 writer 不是最后提交代际。');
    return journal;
  }
  async append(event: E, writer: HistoryWriter): Promise<JournalPosition> {
    need(compareDecimal(writer.fencingToken, this.#position.writer.fencingToken) >= 0
      && (writer.fencingToken !== this.#position.writer.fencingToken || writer.ownerId === this.#position.writer.ownerId), 'FENCED', '拒绝旧 writer 提交。');
    const entry: Entry<E> = { format: 'history-journal/1', archiveId: this.archiveId, sequence: nextDecimal(this.#position.sequence),
      previousHash: this.#position.hash, writer: clone(writer), event };
    const payload = pack(entry, this.limits.maxJournalRecordBytes), bytes = frame(payload);
    need(this.#replayBytes + bytes.byteLength <= this.limits.maxJournalReplayBytes, 'CATALOG_REQUIRED', '提交日志达到恢复预算，先建立元数据快照再继续。');
    if (this.#fileBytes + bytes.byteLength > this.limits.maxJournalSegmentBytes) {
      this.#fileIndex = nextDecimal(this.#fileIndex); this.#fileBytes = 0;
      await this.files.create(journalName(this.#fileIndex)); this.#files.push(journalName(this.#fileIndex));
    }
    await this.files.append(journalName(this.#fileIndex), this.#fileBytes, bytes);
    this.#fileBytes += bytes.byteLength; this.#replayBytes += bytes.byteLength;
    this.#position = { sequence: entry.sequence, hash: sha256(payload), writer: clone(writer) };
    this.apply(event, this.position);
    return this.position;
  }
  /** 不在逐事件路径重写目录；只在显式维护或有界日志阈值处压缩元数据。 */
  async checkpoint<S>(state: S): Promise<{ sequence: string; removedFiles: string[] }> {
    const nextIndex = nextDecimal(this.#fileIndex), prefix = `catalog/${numbered(nextIndex)}-${randomUUID()}`;
    const catalogPath = `${prefix}.json`, markerPath = `${prefix}.commit`, bytes = pack(state, this.limits.maxCatalogBytes);
    await this.files.publish(catalogPath, bytes);
    const cleanupMap = new Map<string, ExactFile>();
    if (this.#catalog) {
      for (const file of this.#catalog.marker.cleanup) if (await this.files.exists(file.relativePath)) cleanupMap.set(file.relativePath, file);
      for (const relative of [this.#catalog.markerPath, this.#catalog.marker.catalog.relativePath]) {
        if (await this.files.exists(relative)) {
          const prior = await this.files.read(relative, this.limits.maxCatalogBytes);
          cleanupMap.set(relative, { relativePath: relative, bytes: prior.byteLength, sha256: sha256(prior) });
        }
      }
    }
    for (const relative of this.#files) {
      const prior = await this.files.read(relative, this.limits.maxJournalSegmentBytes);
      cleanupMap.set(relative, { relativePath: relative, bytes: prior.byteLength, sha256: sha256(prior) });
    }
    need(cleanupMap.size <= this.limits.maxIndexEntries, 'BUDGET', '元数据回收计划过大。');
    // 新空段先持久创建；快照提交以后它就是唯一追加入口，旧段只由 marker 的确切计划回收。
    await this.files.create(journalName(nextIndex));
    const marker: CatalogMarker = { format: 'history-catalog/1', archiveId: this.archiveId, position: this.position,
      nextFileIndex: nextIndex, catalog: { relativePath: catalogPath, bytes: bytes.byteLength, sha256: sha256(bytes) }, cleanup: [...cleanupMap.values()] };
    await this.files.publish(markerPath, frame(pack(marker, this.limits.maxCatalogBytes - 36)));
    this.#catalog = { markerPath, marker }; this.#fileIndex = nextIndex; this.#fileBytes = 0;
    this.#files = [journalName(nextIndex)]; this.#replayBytes = 0;
    return { sequence: marker.position.sequence, removedFiles: await this.cleanupCatalog() };
  }
  async cleanupCatalog(): Promise<string[]> {
    const removed: string[] = [];
    if (!this.#catalog) return removed;
    for (const file of this.#catalog.marker.cleanup) {
      need(/^(journal\/|catalog\/)/u.test(file.relativePath) && !same(file.relativePath, this.#catalog.markerPath)
        && file.relativePath !== this.#catalog.marker.catalog.relativePath && !this.#files.includes(file.relativePath),
      'CORRUPT_CATALOG', '快照清理计划试图删除非元数据文件或当前依赖。');
      if (await this.files.removeExact(file, Math.max(this.limits.maxCatalogBytes, this.limits.maxJournalSegmentBytes))) removed.push(file.relativePath);
    }
    return removed;
  }
}
