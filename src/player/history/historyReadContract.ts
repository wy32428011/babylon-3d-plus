import type { HistoryCoverageGap, HistoryTimeRange, HistoryTimelineEvent, HistoryVersionBoundary } from '../../runtime/history/historyReplayContract';
import type { StateChangeBatch, StateCursor, VersionManifest } from '../../runtime/history/state';

/** Viewer 查询协议草案；服务端尚未实现，不能将此类型视为服务能力证明。所有时间为 UTC 毫秒。 */
export type HistoryReadIdentity = {
  projectId: string;
  cacheRevision: string;
  publishedVersionId: string;
  bindingRevision: string;
  projectionId: string;
};
export type HistoryReadCapabilityRequest = { projectId: string; cacheRevision: string };
export type HistoryReadCapabilityResponse = {
  projectId: string; cacheRevision: string; readOnly: true; scope: 'history:read';
  /** 短期限定项目的只读能力，仅存内存，通过 Authorization: Bearer 传递，不写入 URL。 */
  capability: string; expiresAt: number;
};
export type HistoryCoverageRequest = { identity: HistoryReadIdentity; range: HistoryTimeRange };
export type HistoryCoverageResponse = {
  identity: HistoryReadIdentity; range: HistoryTimeRange; sourceName: string; sourceQuality: string;
  queryableThrough: number; gaps: HistoryCoverageGap[]; versionBoundaries: HistoryVersionBoundary[];
};
export type HistoryOpenRequest = {
  identity: HistoryReadIdentity; mode: 'history' | 'live'; range: HistoryTimeRange | null;
};
export type HistoryOpenResponse = {
  sessionId: string; identity: HistoryReadIdentity; versions: VersionManifest; mode: 'history' | 'live';
  readOnly: true; expiresAt: number; replayAbi: string;
  limits: { maxSnapshotBytes: number; maxChunks: number; maxPageBytes: number; maxPages: number };
};
export type HistoryStateAtRequest = { sessionId: string; generation: number; requestId: string; asOf: number | null };
export type HistorySnapshotChunk = { index: number; byteLength: number; sha256: string };
export type HistorySnapshotManifest = {
  snapshotId: string; identity: HistoryReadIdentity; cursor: StateCursor; requestedTime: number | null;
  /** checkpointTime 是检查点时间，resolvedTime 是最后已提交业务修订时间；coveredThrough 是可证明连续/可采样的展示时刻。 */
  checkpointTime: number; resolvedTime: number; coveredThrough: number; throughCursor: StateCursor;
  expiresAt: number; byteLength: number; chunks: HistorySnapshotChunk[];
  /** 实时全态所需的续传租约及固定尾游标；须先应用完整窗口再揭示实时。 */
  resume: { toCursor: StateCursor; throughTime: number; leaseExpiresAt: number } | null;
};
export type HistoryStateAtResponse = { status: 'ready'; snapshot: HistorySnapshotManifest }
  | { status: 'pending'; retryAfterMs: number }
  | { status: 'gap' | 'unavailable'; message: string };
export type HistoryStateChunkRequest = { sessionId: string; generation: number; snapshotId: string; index: number };
export type HistoryStateChunkResponse = {
  snapshotId: string; index: number; cursor: StateCursor; encoding: 'base64'; data: string;
};
export type HistoryStateCancelRequest = { sessionId: string; requestId: string };
export type HistoryStateCancelResponse = { cancelled: boolean };
export type HistoryChangesRequest = {
  sessionId: string; generation: number; afterCursor: StateCursor;
  /** 首次可为 null，由服务端固定窗口；续页必须原样发送。实时模式首请求 throughTime 也可为 null，服务端返回已证明的查询水位。 */
  windowId: string | null; toCursor: StateCursor | null; throughTime: number | null;
};
export type HistoryChangesResponse = {
  identity: HistoryReadIdentity; windowId: string; afterCursor: StateCursor; toCursor: StateCursor;
  nextCursor: StateCursor; throughTime: number; hasMore: boolean; batches: StateChangeBatch[];
  /** 固定窗口在租约内有效；过期时不得继续接旧页。 */
  windowExpiresAt: number;
  continuity: 'complete' | 'gap' | 'version-boundary' | 'cursor-expired';
};
/** queryId 与 cursor 均为不透明的稳定分页身份，过期必须重新发起查询。 */
export type HistoryEventsRequest = { sessionId: string; range: HistoryTimeRange; queryId: string | null; cursor: string | null; limit: number };
export type HistoryEventsResponse = {
  identity: HistoryReadIdentity; range: HistoryTimeRange; queryId: string; cursor: string | null;
  nextCursor: string | null; hasMore: boolean; expiresAt: number; items: HistoryTimelineEvent[];
};
export type HistoryCloseRequest = { sessionId: string };
export type HistoryCloseResponse = { closed: boolean };

/** 明确列出只读动作；没有采集控制、任意转发或管理凭据接口。 */
export interface HistoryReadApi {
  capabilities(request: HistoryReadCapabilityRequest, signal: AbortSignal): Promise<HistoryReadCapabilityResponse>;
  coverage(request: HistoryCoverageRequest, signal: AbortSignal): Promise<HistoryCoverageResponse>;
  open(request: HistoryOpenRequest, signal: AbortSignal): Promise<HistoryOpenResponse>;
  stateAt(request: HistoryStateAtRequest, signal: AbortSignal): Promise<HistoryStateAtResponse>;
  stateChunk(request: HistoryStateChunkRequest, signal: AbortSignal): Promise<HistoryStateChunkResponse>;
  cancel(request: HistoryStateCancelRequest, signal: AbortSignal): Promise<HistoryStateCancelResponse>;
  changes(request: HistoryChangesRequest, signal: AbortSignal): Promise<HistoryChangesResponse>;
  events(request: HistoryEventsRequest, signal: AbortSignal): Promise<HistoryEventsResponse>;
  close(request: HistoryCloseRequest, signal: AbortSignal): Promise<HistoryCloseResponse>;
}
