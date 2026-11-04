import { randomUUID } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { ArchiveLimits, ArchiveRecoveryNotice, HistoryRecordRef } from './types.ts';
import type { ArchiveEvent, SegmentIndex, SegmentKind } from './metadata.ts';
import { ArchiveIndex } from './metadata.ts';
import { ArchiveFiles } from './files.ts';
import { clone, frame, need, physicalOffset, sha256, unframe, validateRecordRef } from './primitives.ts';

const compress = promisify(gzip), inflate = promisify(gunzip);
export class ReadBudget {
  used = 0;
  constructor(readonly maximum: number, readonly onCharge: (bytes: number) => void = () => undefined) {}
  charge(bytes: number): void {
    need(Number.isSafeInteger(bytes) && bytes >= 0 && this.used + bytes <= this.maximum, 'READ_BUDGET', '本次读取/解压超过实际 I/O 预算。');
    this.onCharge(bytes); this.used += bytes;
  }
  fits(bytes: number): boolean { return this.used + bytes <= this.maximum; }
}
/** 一个页/恢复窗口内复用同一压缩段；预算按压缩输入和解压输出收费，不按返回 JSON 大小冒充 I/O。 */
export class SegmentReadContext {
  readonly #inflated = new Map<string, Buffer>();
  constructor(readonly files: ArchiveFiles, readonly limits: Readonly<ArchiveLimits>, readonly budget: ReadBudget) {}
  cost(ref: HistoryRecordRef, segment: SegmentIndex): number {
    return segment.cold ? (this.#inflated.has(segment.id) ? 0 : segment.cold.bytes + segment.bytes) : ref.bytes;
  }
  async read(ref: HistoryRecordRef, segment: SegmentIndex): Promise<Buffer> {
    validateRecordRef(ref, this.limits.maxSegmentBytes);
    const offset = physicalOffset(ref.offset, this.limits.maxSegmentBytes);
    need(ref.segmentId === segment.id && offset + ref.bytes <= segment.bytes, 'CORRUPT_INDEX', '记录指针不属于所固定的段。');
    let encoded: Buffer;
    if (segment.cold) {
      let bytes = this.#inflated.get(segment.id);
      if (!bytes) {
        need(segment.sealed && segment.sha256 && segment.bytes <= this.limits.maxSegmentBytes
          && segment.cold.bytes <= this.limits.maxSegmentBytes + 65_536
          && segment.bytes <= Math.max(1, segment.cold.bytes) * this.limits.maxInflationRatio,
        'DECOMPRESSION_BUDGET', '压缩段尺寸、膨胀比或封存状态无效。');
        this.budget.charge(segment.cold.bytes + segment.bytes);
        const compressed = await this.files.read(segment.cold.relativePath, this.limits.maxSegmentBytes + 65_536);
        need(compressed.byteLength === segment.cold.bytes && sha256(compressed) === segment.cold.sha256, 'CHECKSUM', '压缩段 SHA-256 不匹配。');
        bytes = await inflate(compressed, { maxOutputLength: Math.max(1, segment.bytes) });
        need(bytes.byteLength === segment.bytes && sha256(bytes) === segment.sha256, 'CHECKSUM', '解压后段长度或 SHA-256 不匹配。');
        this.#inflated.set(segment.id, bytes);
      }
      encoded = bytes.subarray(offset, offset + ref.bytes);
    } else {
      this.budget.charge(ref.bytes); encoded = await this.files.read(segment.hotPath, this.limits.maxSegmentBytes, offset, ref.bytes);
    }
    const payload = unframe(encoded, this.limits.maxSegmentBytes - 36);
    need(sha256(payload) === ref.sha256, 'CHECKSUM', '记录与已提交索引的 SHA-256 不一致。');
    return payload;
  }
}
export class ArchiveSegments {
  readonly #active = new Map<SegmentKind, string>();
  constructor(readonly files: ArchiveFiles, readonly index: ArchiveIndex, readonly limits: Readonly<ArchiveLimits>,
    readonly appendEvent: (event: ArchiveEvent) => Promise<unknown>, readonly beforeWrite: () => void = () => undefined,
    readonly reservedMetadataBytes = 0) {}
  async recover(notices: ArchiveRecoveryNotice[]): Promise<void> {
    for (const segment of this.index.segments.values()) {
      need(segment.bytes <= this.limits.maxSegmentBytes && segment.records <= this.limits.maxRecordsPerSegment, 'CORRUPT_INDEX', '段索引超过配置容量。');
      if (segment.cold) {
        need(await this.files.size(segment.cold.relativePath) === segment.cold.bytes, 'DEPENDENCY_MISSING', '压缩段缺失或截短。');
      } else {
        if (!await this.files.exists(segment.hotPath)) {
          need(!segment.sealed && segment.bytes === 0, 'DEPENDENCY_MISSING', '已提交的热日志段缺失。');
          await this.files.create(segment.hotPath);
        }
        const size = await this.files.size(segment.hotPath);
        need(size >= segment.bytes && (!segment.sealed || size === segment.bytes), 'CORRUPT_FILE', '热段缺少已提交字节或封存尺寸改变。');
        if (size > segment.bytes) {
          need(size <= this.limits.maxSegmentBytes, 'CORRUPT_FILE', '未提交尾部超过段预算。');
          await this.files.truncateUncommitted(segment.hotPath, segment.bytes, size);
          notices.push({ kind: 'uncommitted-segment-tail', relativePath: segment.hotPath, discardedBytes: size - segment.bytes });
        }
      }
      if (!segment.sealed) {
        need(!this.#active.has(segment.kind), 'CORRUPT_INDEX', '同一种日志存在多个未封存写入段。'); this.#active.set(segment.kind, segment.id);
      }
    }
  }
  async append(kind: SegmentKind, payload: Buffer): Promise<HistoryRecordRef> {
    const bytes = frame(payload);
    need(bytes.byteLength <= this.limits.maxSegmentBytes, 'BUDGET', '记录超过物理段预算。');
    need(this.index.storedBytes + bytes.byteLength + this.reservedMetadataBytes <= this.limits.maxStoredBytes
      && this.index.hotBytes + bytes.byteLength <= this.limits.maxHotBytes, 'STORAGE_BACKPRESSURE', '磁盘/热日志配额不足，停止确认而非丢弃输入。');
    need(this.index.entries < this.limits.maxIndexEntries, 'INDEX_CAPACITY', '索引达到容量上限，请先执行已授权留存维护。');
    let segment = this.#active.has(kind) ? this.index.segment(this.#active.get(kind)!) : undefined;
    if (segment && (segment.bytes + bytes.byteLength > this.limits.maxSegmentBytes || segment.records >= this.limits.maxRecordsPerSegment)) {
      await this.seal(segment.id); segment = undefined;
    }
    if (!segment) {
      const id = randomUUID();
      segment = { id, kind, hotPath: `segments/${kind}-${id}.wal`, bytes: 0, records: 0, sealed: false, sha256: null, cold: null };
      need(this.index.files.size < this.limits.maxIndexEntries, 'INDEX_CAPACITY', '归档文件索引达到上限。');
      await this.appendEvent({ kind: 'segment-open', segment }); await this.files.create(segment.hotPath); this.#active.set(kind, id);
      segment = this.index.segment(id);
    }
    const ref: HistoryRecordRef = { segmentId: segment.id, offset: String(segment.bytes), bytes: bytes.byteLength, sha256: sha256(payload) };
    this.beforeWrite(); await this.files.append(segment.hotPath, segment.bytes, bytes);
    return ref;
  }
  async seal(id: string): Promise<void> {
    const segment = this.index.segment(id);
    if (segment.sealed) return;
    const bytes = await this.files.read(segment.hotPath, this.limits.maxSegmentBytes);
    need(bytes.byteLength === segment.bytes, 'UNCOMMITTED_TAIL', '封存前发现未提交尾部，必须先恢复。');
    await this.appendEvent({ kind: 'seal', segmentId: id, bytes: segment.bytes, sha256: sha256(bytes) }); this.#active.delete(segment.kind);
  }
  async sealActive(): Promise<void> { for (const id of [...this.#active.values()]) await this.seal(id); }
  async compressCandidate(segment: SegmentIndex): Promise<{ segment: SegmentIndex; compressed: Buffer }> {
    need(segment.sealed && !segment.cold && segment.sha256, 'SEGMENT_STATE', '只能压缩已封存、尚未冷归档的段。');
    const bytes = await this.files.read(segment.hotPath, this.limits.maxSegmentBytes);
    need(bytes.byteLength === segment.bytes && sha256(bytes) === segment.sha256, 'CHECKSUM', '待压缩热段损坏。');
    const compressed = await compress(bytes, { level: 6, maxOutputLength: this.limits.maxSegmentBytes + 65_536 });
    need(bytes.byteLength <= Math.max(1, compressed.byteLength) * this.limits.maxInflationRatio, 'DECOMPRESSION_BUDGET', '压缩结果超出配置的安全膨胀比，未公布冷归档。');
    return { segment: clone(segment), compressed };
  }
  async commitCompressed(candidate: { segment: SegmentIndex; compressed: Buffer }): Promise<void> {
    const current = this.index.segment(candidate.segment.id);
    need(current.sealed && !current.cold && current.sha256 === candidate.segment.sha256, 'STALE_COMPACTION', '封存段在准备压缩期间已改变。');
    const file = { relativePath: `segments/${current.kind}-${current.id}.gz`, bytes: candidate.compressed.byteLength, sha256: sha256(candidate.compressed) };
    const reserved = this.index.files.get(file.relativePath);
    need(this.index.storedBytes + (reserved ? 0 : candidate.compressed.byteLength) + this.reservedMetadataBytes <= this.limits.maxStoredBytes,
      'STORAGE_BACKPRESSURE', '压缩临时副本及元数据换代预留超过磁盘预算。');
    if (!reserved) await this.appendEvent({ kind: 'reserve-compressed', file: { ...file, state: 'reserved', segmentId: current.id } });
    else need(reserved.state === 'reserved' && reserved.sha256 === file.sha256 && reserved.bytes === file.bytes, 'STALE_COMPACTION', '已有压缩准备记录不匹配。');
    if (!await this.files.exists(file.relativePath)) { this.beforeWrite(); await this.files.create(file.relativePath, candidate.compressed); }
    else {
      const bytes = await this.files.read(file.relativePath, this.limits.maxSegmentBytes + 65_536);
      need(bytes.byteLength === file.bytes && sha256(bytes) === file.sha256, 'CORRUPT_FILE', '未完成的压缩对象损坏；不能覆盖，应按持久清理计划移除。');
    }
    await this.appendEvent({ kind: 'compressed', segmentId: current.id, file });
  }
}
