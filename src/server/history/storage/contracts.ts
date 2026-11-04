import { readStateChangeBatch, sealStateChangeBatch } from '../../../runtime/history/state/codec.ts';
import { canonicalStringify, compareDecimal, copySafeJson, nextDecimal } from '../../../runtime/history/state/safeJson.ts';
import type { StateBudgets } from '../../../runtime/history/state/safeJson.ts';
import { TWIN_INPUT_JSON_SCHEMA, validateJsonSchema } from '../../../runtime/history/state/schema.ts';
import type { DeepReadonly, InputCursor, KernelInput, StateChangeBatch, VersionManifest } from '../../../runtime/history/state/types.ts';
import type {
  ArchiveLimits, ArchiveScope, CapturedReceipt, HistoryDependencyKind, HistoryDependencyRef,
  PrepareCommitRequest, ProjectionDependencies, RawHistoryArrival,
} from './types.ts';
import type { HeadIndex, StatePreparation } from './metadata.ts';
import { checksum, clone, decimal, jsonHash, need, parse, same, text, timestamp } from './primitives.ts';

export type RawRecord = {
  id: string; sourceId: string; sourceContractId: string; receivedAt: number;
  transport: RawHistoryArrival['transport']; payloadBase64: string; payloadBytes: number; inputCursor: InputCursor;
};
export type RawGroupDocument = { format: 'history-raw/1'; archiveId: string; scope: ArchiveScope; records: RawRecord[] };
export type StateRecordDocument = { format: 'history-state/1'; input: DeepReadonly<KernelInput>; batch: DeepReadonly<StateChangeBatch> };
export function assertInputScope(cursor: DeepReadonly<InputCursor>, scope: ArchiveScope): void {
  decimal(cursor.offset);
  need(cursor.captureDomainId === scope.captureDomainId && cursor.captureEpoch === scope.captureEpoch, 'CAPTURE_EPOCH_MISMATCH', '输入游标不属于当前项目采集关联域/纪元。');
}
export function normalizeArrival(value: RawHistoryArrival, limits: Readonly<ArchiveLimits>): Omit<RawRecord, 'id' | 'inputCursor'> {
  text(value.sourceId, 'sourceId'); text(value.sourceContractId, 'sourceContractId'); timestamp(value.receivedAt);
  need(value.rawPayload instanceof Uint8Array && value.rawPayload.byteLength <= limits.maxRawPayloadBytes, 'ARRIVAL_BUDGET', '原始业务载荷必须是预算内的字节数组。');
  // 不展开任意请求对象；仅复制白名单字段，拒绝 header/url/token/password 等附加字段。
  const envelopeKeys = Object.keys(value);
  need(envelopeKeys.every(key => ['sourceId', 'sourceContractId', 'receivedAt', 'transport', 'rawPayload'].includes(key)), 'SENSITIVE_METADATA', '原始到达 envelope 含非白名单字段，不能存储认证请求头或密钥。');
  const metadata = copySafeJson(value.transport) as unknown as RawHistoryArrival['transport'];
  let transport: RawHistoryArrival['transport'];
  if (metadata.kind === 'mqtt') {
    need(Object.keys(metadata).every(key => ['kind', 'topic', 'qos', 'retain', 'duplicate', 'packetId', 'captureTransactionId'].includes(key)), 'SENSITIVE_METADATA', 'MQTT 元信息含非白名单字段。');
    text(metadata.topic, 'topic', 4096);
    need([0, 1, 2].includes(metadata.qos) && typeof metadata.retain === 'boolean' && typeof metadata.duplicate === 'boolean', 'TRANSPORT', 'MQTT 元信息无效。');
    if (metadata.packetId !== null) text(metadata.packetId, 'packetId', 128);
    if (metadata.captureTransactionId !== undefined) need(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(metadata.captureTransactionId), 'TRANSPORT', 'MQTT 捕获事务标识无效。');
    transport = { kind: 'mqtt', topic: metadata.topic, qos: metadata.qos, retain: metadata.retain, duplicate: metadata.duplicate, packetId: metadata.packetId,
      ...(metadata.captureTransactionId === undefined ? {} : { captureTransactionId: metadata.captureTransactionId }) };
  } else if (metadata.kind === 'http') {
    need(Object.keys(metadata).every(key => ['kind', 'requestId', 'attemptId', 'method', 'scope', 'rows', 'statusCode', 'outcome'].includes(key)), 'SENSITIVE_METADATA', 'HTTP 元信息含非白名单字段。');
    text(metadata.requestId, 'requestId'); text(metadata.attemptId, 'attemptId');
    need(['GET', 'POST'].includes(metadata.method) && ['full', 'rows'].includes(metadata.scope)
      && Array.isArray(metadata.rows) && metadata.rows.length <= 4096 && ['response', 'transport-error'].includes(metadata.outcome)
      && (metadata.statusCode === null || (Number.isInteger(metadata.statusCode) && metadata.statusCode >= 100 && metadata.statusCode <= 599)), 'TRANSPORT', 'HTTP 到达元信息无效。');
    for (const row of metadata.rows) text(row, 'row', 256);
    transport = { kind: 'http', requestId: metadata.requestId, attemptId: metadata.attemptId, method: metadata.method,
      scope: metadata.scope, rows: [...metadata.rows], statusCode: metadata.statusCode, outcome: metadata.outcome };
  } else {
    need(metadata.kind === 'control' && Object.keys(metadata).every(key => ['kind', 'controlKind'].includes(key))
      && ['advance', 'gap', 'baseline', 'configuration'].includes(metadata.controlKind), 'TRANSPORT', '控制观测元信息无效。');
    transport = { kind: 'control', controlKind: metadata.controlKind };
  }
  return { sourceId: value.sourceId, sourceContractId: value.sourceContractId, receivedAt: value.receivedAt, transport,
    payloadBase64: Buffer.from(value.rawPayload).toString('base64'), payloadBytes: value.rawPayload.byteLength };
}
export function dependencyClosure(value: ProjectionDependencies, versions: DeepReadonly<VersionManifest>, maximum: number): ProjectionDependencies {
  const dependencies = copySafeJson(value) as unknown as ProjectionDependencies;
  need(Array.isArray(dependencies.roots) && Array.isArray(dependencies.references) && dependencies.references.length <= maximum
    && dependencies.roots.length <= maximum && dependencies.roots.length > 0, 'DEPENDENCIES', '版本引用闭包必须有界且非空。');
  const definitions = new Map<string, HistoryDependencyRef>();
  const kinds: HistoryDependencyKind[] = ['publication', 'viewer', 'projector', 'kernel', 'scene', 'models', 'scripts', 'logic', 'source-contract', 'resource'];
  for (const reference of dependencies.references) {
    text(reference.id, 'dependency.id'); text(reference.version, 'dependency.version'); checksum(reference.sha256);
    need(kinds.includes(reference.kind) && !definitions.has(reference.id) && Array.isArray(reference.dependsOn) && reference.dependsOn.length <= maximum,
      'DEPENDENCIES', '版本引用重复、类型未知或依赖数超限。'); definitions.set(reference.id, reference);
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string, depth: number): void => {
    text(id, 'dependency.id'); need(depth <= 64 && !visiting.has(id), 'DEPENDENCIES', '版本引用依赖过深或成环。');
    if (visited.has(id)) return;
    const reference = definitions.get(id); need(reference, 'DEPENDENCY_MISSING', '版本依赖闭包不完整。', { id });
    visiting.add(id); for (const child of reference.dependsOn) visit(child, depth + 1); visiting.delete(id); visited.add(id);
  };
  for (const root of dependencies.roots) visit(root, 0);
  const locked: [HistoryDependencyKind, string][] = [
    ['publication', versions.publishedVersionId], ['projector', versions.projectorVersion], ['kernel', versions.kernelVersion],
    ['scene', versions.sceneHash], ['models', versions.modelManifestHash], ['scripts', versions.scriptManifestHash],
    ['logic', versions.logicManifestHash], ['source-contract', versions.sourceContractId],
  ];
  for (const [kind, version] of locked) need([...visited].some(id => {
    const reference = definitions.get(id)!; return reference.kind === kind && reference.version === version;
  }), 'DEPENDENCY_MISSING', '版本清单缺少对应的不可变资源引用。', { kind, version });
  need([...visited].some(id => definitions.get(id)!.kind === 'viewer'), 'DEPENDENCY_MISSING', '必须保留兼容 Viewer 执行产物引用。');
  return clone({ roots: [...dependencies.roots], references: [...visited].sort().map(id => definitions.get(id)!) });
}
export function validatePreparedInput(request: PrepareCommitRequest, head: HeadIndex, scope: ArchiveScope,
  versions: DeepReadonly<VersionManifest>, budgets: Readonly<StateBudgets>): { input: DeepReadonly<KernelInput>; batch: DeepReadonly<StateChangeBatch>; head: HeadIndex } {
  const input = copySafeJson(request.input, budgets) as unknown as KernelInput;
  validateJsonSchema(input, TWIN_INPUT_JSON_SCHEMA, budgets, 'input');
  const batch = readStateChangeBatch(request.batch, budgets);
  need(same(input.versions, versions) && same(batch.versions, versions) && input.projectionId === head.cursor.projectionId
    && batch.projectionId === input.projectionId, 'VERSION_MISMATCH', '输入/变化批次的投影或固定版本不一致。');
  assertInputScope(input.cursor, scope);
  need(input.cursor.offset === nextDecimal(head.inputCursor.offset) && input.logicalTime >= head.logicalTime
    && batch.fromRevision === head.cursor.stateRevision && same(batch.inputCursor, input.cursor), 'INPUT_GAP', '输入或状态修订未接续已提交边界。');
  let cursor = clone(head.inputCursor), revision = head.cursor.stateRevision, time = head.logicalTime, continuity = head.continuity;
  let completeCursor = clone(head.completeCursor), completeTime = head.completeTime, inputs = 0;
  for (const item of batch.revisions) {
    need(item.revision === nextDecimal(revision) && item.logicalTime >= time && item.logicalTime <= input.logicalTime, 'REVISION_GAP', '原子修订缺号或逻辑时间倒退。');
    assertInputScope(item.inputCursor, scope);
    if (item.cause.kind === 'timer') need(same(item.inputCursor, cursor), 'INPUT_GAP', '定时任务不得私自前移输入边界。');
    else {
      inputs += 1; need(inputs === 1 && same(item.inputCursor, input.cursor) && item.cause.id === input.id
        && item.logicalTime === input.logicalTime, 'INPUT_GAP', '一个内核输入必须对应唯一的已记录输入边界。'); cursor = clone(input.cursor);
      need(item.cause.kind === (input.kind === 'gap' ? 'gap' : input.kind === 'advance' ? 'advance' : 'input'), 'INPUT_GAP', '输入原因和原子修订不匹配。');
    }
    need(continuity.status === 'gap' ? item.cause.kind === 'gap' && item.changes.length === 0 && same(continuity, item.continuity)
      : item.cause.kind === 'gap' ? item.continuity.status === 'gap' && item.continuity.since === time
        : same(continuity, item.continuity), 'CONTINUITY_GAP', '增量不得跨缺口恢复完整性或改写已声明的连续区间。');
    time = item.logicalTime; revision = item.revision; continuity = item.continuity;
    if (continuity.status === 'complete') { completeCursor = { projectionId: input.projectionId, stateRevision: revision }; completeTime = time; }
  }
  need(inputs === 1 && revision === batch.toRevision && time === batch.throughTime && time === input.logicalTime
    && same(cursor, batch.inputCursor), 'BATCH_BOUNDARY', '批次头尾与实际原子修订不一致。');
  return { input, batch, head: { cursor: { projectionId: input.projectionId, stateRevision: revision }, inputCursor: cursor,
    logicalTime: time, continuity, completeCursor, completeTime } };
}
export function decodeStoredBatch(bytes: Buffer, preparation: StatePreparation | { proof: StatePreparation['proof'] }, budgets: Readonly<StateBudgets>): DeepReadonly<StateChangeBatch> {
  const document = parse<StateRecordDocument>(bytes, budgets.maxBytes);
  need(document.format === 'history-state/1', 'CORRUPT_BATCH', '状态段记录类型错误。');
  const batch = readStateChangeBatch(document.batch, budgets), proof = preparation.proof;
  need(batch.projectionId === proof.projectionId && jsonHash(batch.versions) === proof.versionDigest && batch.fromRevision === proof.fromRevision
    && batch.toRevision === proof.toRevision && batch.throughTime === proof.throughTime && batch.checksum.value === proof.batchChecksum
    && same(batch.inputCursor, proof.inputCursor) && same(document.input.cursor, batch.inputCursor), 'CORRUPT_BATCH', '已提交批次与提交索引不匹配。');
  return batch;
}
export function sliceBatch(batch: DeepReadonly<StateChangeBatch>, after: string, through: string, budgets: Readonly<StateBudgets>): DeepReadonly<StateChangeBatch> {
  const revisions = batch.revisions.filter(item => compareDecimal(item.revision, after) > 0 && compareDecimal(item.revision, through) <= 0);
  need(revisions.length > 0 && revisions[0].revision === nextDecimal(after), 'REVISION_GAP', '查询切片不能跳过原子修订。');
  const last = revisions[revisions.length - 1];
  if (batch.fromRevision === after && batch.toRevision === last.revision) return batch;
  return sealStateChangeBatch({ format: 'twin-changes/1', committed: true, versions: batch.versions, projectionId: batch.projectionId,
    fromRevision: after, toRevision: last.revision, throughTime: last.logicalTime, inputCursor: last.inputCursor, revisions }, budgets);
}
export function receiptMatchesCursor(receipt: CapturedReceipt, cursor: InputCursor): boolean { return canonicalStringify(receipt.inputCursor) === canonicalStringify(cursor); }
