import { randomUUID } from 'node:crypto';
import { compareDecimal } from '../../../runtime/history/state/safeJson.ts';
import type { ArchiveLimits, HistoryDependencyRef, RetentionRequest } from './types.ts';
import type { StoredRetentionPlan, TrimIndex } from './metadata.ts';
import { ArchiveIndex } from './metadata.ts';
import { ArchiveFiles } from './files.ts';
import { clone, need, same, sha256, timestamp, upperBound } from './primitives.ts';

function mergeReferences(output: Map<string, HistoryDependencyRef>, references: readonly HistoryDependencyRef[]): void {
  for (const reference of references) {
    const previous = output.get(reference.id);
    need(!previous || same(previous, reference), 'DEPENDENCY_CONFLICT', '同一资源引用身份对应不同内容，拒绝进行留存清理。', { id: reference.id });
    output.set(reference.id, reference);
  }
}
/**
 * 生成的事件一旦 fsync 即裁剪可查询窗口，并禁止新会话进入待删除范围；随后才物理删除。
 * 旧会话使用固定快照和持久 lease，其段/版本闭包不参与回收。此函数不删除任何文件。
 */
export async function prepareRetention(index: ArchiveIndex, files: ArchiveFiles, limits: Readonly<ArchiveLimits>,
  request: RetentionRequest, pinned: Set<string>): Promise<StoredRetentionPlan> {
  timestamp(request.retainFrom); const now = Date.now(), usedSegments = new Set<string>(), before = new Map<string, HistoryDependencyRef>();
  const kept = new Map<string, HistoryDependencyRef>(), trims: TrimIndex[] = [], pinnedProjects = new Set<string>();
  const expiredLeases: string[] = [];
  for (const lease of index.leases.values()) {
    mergeReferences(before, lease.dependencies);
    if (lease.expiresAt > now || lease.segmentIds.some(id => pinned.has(id))) {
      if (lease.projectionId) pinnedProjects.add(lease.projectionId);
      for (const id of lease.segmentIds) usedSegments.add(id);
      mergeReferences(kept, lease.dependencies);
    } else expiredLeases.push(lease.id);
  }
  let neededRawOffset: string | null = null;
  const requireInput = (offset: string) => { if (neededRawOffset === null || compareDecimal(offset, neededRawOffset) < 0) neededRawOffset = offset; };
  for (const candidate of index.preparations.values()) {
    usedSegments.add(candidate.proof.record.segmentId); requireInput(candidate.proof.inputCursor.offset);
    if (candidate.kind === 'projection') { mergeReferences(before, candidate.dependencies.references); mergeReferences(kept, candidate.dependencies.references); }
    else pinnedProjects.add(candidate.proof.projectionId);
  }
  for (const projection of index.projections.values()) {
    mergeReferences(before, projection.dependencies.references);
    const retire = projection.closed && projection.head.logicalTime < request.retainFrom && !pinnedProjects.has(projection.id)
      && !projection.checkpoints.some(item => pinned.has(item.record.segmentId))
      && !projection.batches.some(item => pinned.has(item.proof.record.segmentId));
    if (retire) { trims.push({ projectionId: projection.id, retire: true, checkpointRevision: '', retainedFrom: request.retainFrom }); continue; }
    mergeReferences(kept, projection.dependencies.references);
    const boundary = upperBound(projection.checkpoints, item => item.logicalTime <= request.retainFrom);
    const anchor = projection.checkpoints[Math.max(0, boundary - 1)];
    // 基线/检查点不晚于窗口起点，之后的全部原子修订形成恢复依赖闭包。
    trims.push({ projectionId: projection.id, retire: false, checkpointRevision: anchor.cursor.stateRevision, retainedFrom: Math.max(request.retainFrom, projection.retainedFrom) });
    for (const checkpoint of projection.checkpoints) if (compareDecimal(checkpoint.cursor.stateRevision, anchor.cursor.stateRevision) >= 0) {
      usedSegments.add(checkpoint.record.segmentId); requireInput(checkpoint.inputCursor.offset);
    }
    for (const batch of projection.batches) if (compareDecimal(batch.proof.toRevision, anchor.cursor.stateRevision) > 0) {
      usedSegments.add(batch.proof.record.segmentId); requireInput(batch.proof.inputCursor.offset);
    }
  }
  let keepRawIndex = index.groups.length;
  for (let position = 0; position < index.groups.length; position += 1) {
    const group = index.groups[position];
    if (group.maxReceivedAt >= request.retainFrom || (neededRawOffset !== null && compareDecimal(group.lastOffset, neededRawOffset) >= 0)
      || pinned.has(group.record.segmentId)) { keepRawIndex = position; break; }
  }
  const dropRawThrough = keepRawIndex > 0 ? index.groups[keepRawIndex - 1].lastOffset : index.rawFloor;
  for (let position = keepRawIndex; position < index.groups.length; position += 1) usedSegments.add(index.groups[position].record.segmentId);
  for (const id of pinned) usedSegments.add(id);
  const removeSegments = [...index.segments.values()].filter(segment => segment.sealed && !usedSegments.has(segment.id)).map(segment => segment.id);
  const removable = new Set(removeSegments), alreadyPlanned = new Set<string>();
  for (const prior of index.plans.values()) for (const file of prior.plan.files) if (!prior.removedFiles.includes(file.relativePath)) alreadyPlanned.add(file.relativePath);
  const plannedFiles: StoredRetentionPlan['plan']['files'] = []; let readBytes = 0;
  for (const file of index.files.values()) {
    if (alreadyPlanned.has(file.relativePath) || pinned.has(file.segmentId)) continue;
    if (!removable.has(file.segmentId) && index.segments.has(file.segmentId) && file.state !== 'obsolete' && file.state !== 'reserved') continue;
    if (plannedFiles.length >= limits.maxRetentionFiles) break;
    // 段已封存/从未公布的 reserved 对象才允许计划删除，活动段永不就地截断。
    const exists = await files.exists(file.relativePath);
    const size = exists ? await files.size(file.relativePath) : file.bytes;
    need(size <= limits.maxSegmentBytes + 65_536, 'BUDGET', '待回收对象超过段预算。');
    if (readBytes + size > limits.maxRecoveryBytes) continue;
    let digest = file.sha256;
    if (exists) {
      const bytes = await files.read(file.relativePath, limits.maxSegmentBytes + 65_536); readBytes += bytes.byteLength;
      const actual = sha256(bytes);
      // 未提交压缩对象允许精确计划回收其半写内容；已提交对象损坏必须报错，不能借留存掩盖。
      need(file.state === 'reserved' || (bytes.byteLength === file.bytes && actual === file.sha256), 'CHECKSUM', '待回收的已提交对象损坏，拒绝清理。'); digest = actual;
    } else {
      const plannedPreviously = [...index.plans.values()].some(plan => plan.plan.files.some(item => item.relativePath === file.relativePath));
      need(file.state === 'reserved' || plannedPreviously, 'DEPENDENCY_MISSING', '已登记对象无故缺失，不能当作清理成功。');
      if (!digest) digest = sha256(Buffer.alloc(0));
    }
    plannedFiles.push({ relativePath: file.relativePath, bytes: size, sha256: digest });
  }
  const retainedDependencies = [...kept.values()].sort((a, b) => a.id.localeCompare(b.id));
  const releasedDependencies = [...before.values()].filter(reference => !kept.has(reference.id)).sort((a, b) => a.id.localeCompare(b.id));
  return { plan: { planId: randomUUID(), retainFrom: request.retainFrom, journalSequence: '0', files: plannedFiles,
    retiredProjectionIds: trims.filter(trim => trim.retire).map(trim => trim.projectionId), retainedDependencies: clone(retainedDependencies),
    releasedDependencies: clone(releasedDependencies), pinnedSegmentIds: [...pinned].sort() }, trims, dropRawThrough,
    removeSegments, removedFiles: [], expiredLeases };
}
