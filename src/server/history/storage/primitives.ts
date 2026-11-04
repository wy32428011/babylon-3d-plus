import { createHash } from 'node:crypto';
import { canonicalStringify, copySafeJson, resolveStateBudgets } from '../../../runtime/history/state/safeJson.ts';
import type { StateBudgets } from '../../../runtime/history/state/safeJson.ts';
import type { ArchiveLimits, ArchiveScope, HistoryRecordRef, HistoryWriter } from './types.ts';
import { HistoryStorageError } from './types.ts';

export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxRawPayloadBytes: 1024 * 1024, maxRawGroupBytes: 8 * 1024 * 1024, maxRawGroupRecords: 256,
  maxQueuedArrivalBytes: 32 * 1024 * 1024, maxQueuedArrivals: 4096, groupCommitDelayMs: 5,
  maxBatchBytes: 16 * 1024 * 1024, maxCheckpointBytes: 64 * 1024 * 1024, maxSegmentBytes: 96 * 1024 * 1024,
  maxRecordsPerSegment: 4096, maxJournalSegmentBytes: 8 * 1024 * 1024, maxJournalRecordBytes: 2 * 1024 * 1024,
  maxJournalReplayBytes: 256 * 1024 * 1024, maxCatalogBytes: 128 * 1024 * 1024, maxIndexEntries: 500_000,
  maxHotBytes: 8 * 1024 ** 3, maxStoredBytes: 32 * 1024 ** 3, maxInflationRatio: 1024,
  maxSessions: 64, maxSessionTtlMs: 5 * 60_000, maxPageBytes: 32 * 1024 * 1024, maxPageBatches: 256,
  maxPagesPerSession: 256, maxReadBytesPerSession: 512 * 1024 * 1024, maxConcurrentReads: 4,
  maxRecoveryBytes: 512 * 1024 * 1024, maxRecoveryPages: 512, maxCompactionSegments: 16,
  maxDependencies: 4096, maxRetentionFiles: 2048,
});
export function need(condition: unknown, code: string, message: string, detail: Record<string, unknown> = {}): asserts condition {
  if (!condition) throw new HistoryStorageError(code, message, detail);
}
export function resolveArchiveLimits(overrides: Partial<ArchiveLimits> = {}): Readonly<ArchiveLimits> {
  const result = { ...DEFAULT_ARCHIVE_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    need(Object.prototype.hasOwnProperty.call(result, key) && Number.isSafeInteger(value) && (value as number) > 0,
      'BUDGET', '存储预算必须是已知的正安全整数。');
    result[key as keyof ArchiveLimits] = value as number;
  }
  need(result.maxRawPayloadBytes * 2 + 16_384 <= result.maxRawGroupBytes
    && result.maxRawGroupBytes + 36 <= result.maxSegmentBytes
    && result.maxBatchBytes + 36 <= result.maxSegmentBytes
    && result.maxCheckpointBytes + 36 <= result.maxSegmentBytes
    && result.maxJournalRecordBytes + 36 <= result.maxJournalSegmentBytes
    && result.maxHotBytes <= result.maxStoredBytes, 'BUDGET', '单条、分组、段及磁盘预算互相不兼容。');
  need(Number.isSafeInteger(metadataReserve(result)) && metadataReserve(result) < result.maxStoredBytes
    && result.maxSegmentBytes <= 0x7fffffff, 'BUDGET', '总存储预算必须覆盖元数据换代临时空间，单段不得超过 2 GiB。');
  return Object.freeze(result);
}
/** 当前/下一份 catalog 与提交标记、尚未裁剪的 journal 的保守空间预留。 */
export function metadataReserve(limits: Readonly<ArchiveLimits>): number {
  return limits.maxJournalReplayBytes + limits.maxCatalogBytes * 4 + 1024 * 1024;
}
export function text(value: unknown, name: string, max = 512): asserts value is string {
  need(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value), 'INVALID_ARGUMENT', `${name} 必须是有界非空文本。`);
}
export function decimal(value: unknown, name = 'cursor'): asserts value is string {
  need(typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value) && value.length <= 256, 'CURSOR', `${name} 必须是有界十进制字符串。`);
}
export function timestamp(value: unknown): asserts value is number {
  need(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'TIME', '时间必须是非负 UTC 毫秒安全整数。');
}
export function checksum(value: unknown): asserts value is string {
  need(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'CHECKSUM', '必须提供 SHA-256 小写十六进制校验和。');
}
export function sha256(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
export function jsonHash(value: unknown): string { return sha256(canonicalStringify(value)); }
export function same(a: unknown, b: unknown): boolean { return canonicalStringify(a) === canonicalStringify(b); }
export function scopeKey(scope: ArchiveScope): string { return sha256(canonicalStringify(scope)); }
export function validateScope(scope: ArchiveScope, writer: HistoryWriter): void {
  text(scope.projectId, 'projectId'); text(scope.captureDomainId, 'captureDomainId'); text(scope.captureEpoch, 'captureEpoch');
  text(writer.ownerId, 'ownerId'); decimal(writer.fencingToken, 'fencingToken');
  need(writer.fencingToken !== '0', 'FENCED', 'writer fencingToken 必须从正整数代际开始。');
}
export function clone<T>(value: T): T { return JSON.parse(canonicalStringify(value)) as T; }
export function pack(value: unknown, maxBytes: number): Buffer {
  const output = Buffer.from(canonicalStringify(value), 'utf8');
  need(output.byteLength <= maxBytes, 'BUDGET', '持久记录超过字节预算。', { maxBytes, bytes: output.byteLength });
  return output;
}
export function parse<T>(bytes: Buffer, maxBytes: number, maxArrayLength = 1_000_000): T {
  need(bytes.byteLength <= maxBytes, 'BUDGET', '读取记录超过字节预算。');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HistoryStorageError('CORRUPT_JSON', '持久记录不是合法 UTF-8 JSON。'); }
  return copySafeJson(parsed, resolveStateBudgets({ maxBytes: maxBytes * 2, maxStringLength: maxBytes,
    maxNodes: Math.max(maxArrayLength * 16, 2_000_000), maxArrayLength, maxObjectKeys: 4096, maxDepth: 64 })) as unknown as T;
}
export function storageStateBudgets(overrides: Partial<StateBudgets> | undefined, maxBytes: number): Readonly<StateBudgets> {
  return resolveStateBudgets({ ...overrides, maxBytes: Math.min(overrides?.maxBytes ?? maxBytes, maxBytes) });
}
export function frame(payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(4); header.writeUInt32BE(payload.byteLength);
  return Buffer.concat([header, payload, Buffer.from(sha256(payload), 'hex')]);
}
export function unframe(bytes: Buffer, maximum: number): Buffer {
  need(bytes.byteLength >= 36, 'CORRUPT_FRAME', '记录帧不完整。');
  const length = bytes.readUInt32BE(0);
  need(length <= maximum && bytes.byteLength === length + 36, 'CORRUPT_FRAME', '记录长度不匹配或超过预算。');
  const body = bytes.subarray(4, 4 + length);
  need(sha256(body) === bytes.subarray(4 + length).toString('hex'), 'CHECKSUM', '记录帧 SHA-256 不匹配。');
  return body;
}
export function physicalOffset(value: string, maximum: number): number {
  decimal(value); const number = Number(value);
  need(Number.isSafeInteger(number) && number <= maximum, 'BUDGET', '物理段偏移超过段预算。');
  return number;
}
export function validateRecordRef(ref: HistoryRecordRef, maximum: number): void {
  text(ref.segmentId, 'segmentId'); physicalOffset(ref.offset, maximum); checksum(ref.sha256);
  need(Number.isSafeInteger(ref.bytes) && ref.bytes >= 36 && ref.bytes <= maximum
    && physicalOffset(ref.offset, maximum) + ref.bytes <= maximum, 'CORRUPT_INDEX', '段记录索引越界。');
}
export function upperBound<T>(values: readonly T[], atOrBefore: (value: T) => boolean): number {
  let low = 0, high = values.length;
  while (low < high) { const middle = low + Math.floor((high - low) / 2); if (atOrBefore(values[middle])) low = middle + 1; else high = middle; }
  return low;
}
export function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code; }
