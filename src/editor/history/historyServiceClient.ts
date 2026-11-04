import {
  validateHistoryServiceRequest,
  type HistoryEffectiveConfiguration,
  type HistoryCaptureStatus,
  type HistoryPublicationQuery,
  type HistoryProjectorQuery,
  type HistoryJsonObject,
  type HistoryOperationResult,
  type HistoryServiceAction,
  type HistoryServiceCapabilities,
  type HistorySourceDetail,
  type HistorySourceQueryResult,
  type HistoryValidationResult,
} from '../../../electron/shared/historyServiceContract';

export type HistoryImportCandidate = { dataSourceId: string; name: string; revision: string; credentialConfigured: boolean; importAllowed: boolean };
export type HistorySourceUsage = { sourceId: string; activeBindingCount: number; retainedContractCount: number; grantedProjectCount: number };
type Responses = {
  capabilities: HistoryServiceCapabilities;
  querySources: HistorySourceQueryResult;
  queryImportCandidates: { items: HistoryImportCandidate[]; total: number; legacyBoundaryProtected: boolean };
  queryPublishedVersions: HistoryPublicationQuery;
  queryProjectorBuilds: HistoryProjectorQuery;
  importSource: HistorySourceDetail;
  getSource: HistorySourceDetail;
  saveSourceDraft: HistorySourceDetail;
  updateSourceCredential: HistorySourceDetail;
  probeSource: HistoryOperationResult;
  sourceUsage: HistorySourceUsage;
  retireSource: HistoryOperationResult;
  validateConfig: HistoryValidationResult;
  getCaptureConfig: HistoryEffectiveConfiguration;
  activateProvider: HistoryOperationResult;
  applyCapturePolicy: HistoryOperationResult;
  pauseCapture: HistoryOperationResult;
  resumeCapture: HistoryOperationResult;
  captureStatus: HistoryCaptureStatus;
  getOperation: HistoryOperationResult;
  cancelOperation: HistoryOperationResult;
};

export type HistoryServiceResponse<A extends HistoryServiceAction> = Responses[A];

export class HistoryServiceError extends Error {
  readonly code: string;
  readonly requestId: string;
  constructor(code: string, message: string, requestId: string) {
    super(message);
    this.name = 'HistoryServiceError';
    this.code = code;
    this.requestId = requestId;
  }
}

export function createHistoryRequestId(): string { return crypto.randomUUID(); }
export function isHistoryRequestCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof HistoryServiceError && error.code === 'HISTORY_CANCELED';
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string'; }
function nullableTime(value: unknown): boolean { return value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function source(value: unknown): boolean {
  return object(value) && text(value.sourceId) && text(value.projectId) && text(value.revision) && text(value.accessRevision)
    && text(value.name) && ['mqtt', 'http', 'platform', 'external-http'].includes(String(value.kind))
    && ['draft', 'ready', 'retired', 'disabled'].includes(String(value.status))
    && Array.isArray(value.roles) && value.roles.every(text) && typeof value.credentialConfigured === 'boolean';
}

/** 先校验平台返回形状再交给表单，损坏的响应不能被当成空目录或有效配置。 */
function validResponse(action: HistoryServiceAction, value: unknown): boolean {
  if (!object(value)) return false;
  switch (action) {
    case 'capabilities': return value.version === 1 && Array.isArray(value.providers) && typeof value.maxRetentionDays === 'number';
    case 'querySources': return Array.isArray(value.items) && value.items.every(source) && Number.isSafeInteger(value.total) && Number(value.total) >= 0;
    case 'queryImportCandidates': return Array.isArray(value.items) && Number.isSafeInteger(value.total) && value.items.every(item => object(item) && text(item.dataSourceId) && text(item.name) && text(item.revision) && typeof item.credentialConfigured === 'boolean' && typeof item.importAllowed === 'boolean');
    case 'queryProjectorBuilds': return Array.isArray(value.items) && value.items.every(item => object(item)
      && typeof item.digest === 'string' && /^[a-f0-9]{64}$/u.test(item.digest)
      && item.stateSchemaVersion === '1' && item.kernelVersion === 'state-kernel/1' && item.scheduleVersion === 'input-boundary/1');
    case 'queryPublishedVersions': return Array.isArray(value.items) && Number.isSafeInteger(value.total) && value.items.every(item => object(item) && text(item.publishedVersionId) && Number.isSafeInteger(item.versionNumber) && typeof item.historyPackageAvailable === 'boolean');
    case 'getSource': case 'saveSourceDraft': case 'importSource': case 'updateSourceCredential': return source(value) && object(value.config);
    case 'validateConfig': return text(value.validationId) && (value.contractId === null || text(value.contractId))
      && (value.digest === null || text(value.digest)) && Number.isSafeInteger(value.expiresAt) && typeof value.canActivate === 'boolean'
      && Array.isArray(value.issues) && value.issues.every(issue => object(issue) && text(issue.code) && text(issue.message) && ['error', 'warning'].includes(String(issue.severity)));
    case 'getCaptureConfig': case 'captureStatus': return text(value.projectId) && text(value.policyRevision) && text(value.bindingRevision)
      && (value.publishedVersionId === null || text(value.publishedVersionId)) && (value.contractId === null || text(value.contractId))
      && ['not-configured', 'initializing', 'collecting', 'ready', 'paused', 'failed'].includes(String(value.phase))
      && ['uninitialized', 'incomplete', 'complete'].includes(String(value.completeness))
      && (value.retentionDays === null || Number.isSafeInteger(value.retentionDays) && Number(value.retentionDays) > 0)
      && nullableTime(value.capturedThrough) && nullableTime(value.queryableThrough)
      && (action !== 'captureStatus' || Array.isArray(value.operations) && value.operations.every(item => validResponse('getOperation', item)));
    case 'sourceUsage': return text(value.sourceId) && ['activeBindingCount', 'retainedContractCount', 'grantedProjectCount'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
    default: return text(value.operationId) && text(value.requestId)
      && ['pending', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(value.status))
      && (value.message === null || text(value.message));
  }
}

/** 只能走可信 Electron 管理桥；浏览器离线模式不会退回匿名 HTTP。 */
export async function invokeHistoryService<A extends HistoryServiceAction>(
  projectId: string,
  action: A,
  body: HistoryJsonObject = {},
  options: { signal?: AbortSignal; requestId?: string } = {},
): Promise<Responses[A]> {
  const requestId = options.requestId ?? createHistoryRequestId();
  const api = window.editorApi;
  if (!api?.invokeHistoryService) throw new HistoryServiceError('HISTORY_DESKTOP_REQUIRED', '服务端来源管理需要桌面编辑器；仍可编辑无密钥场景草稿。', requestId);
  const request = validateHistoryServiceRequest({ projectId, requestId, action, body });
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  const cancel = () => { void api.cancelHistoryService?.(requestId).catch(() => undefined); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await api.invokeHistoryService(request);
    if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (!result.success) throw new HistoryServiceError(result.code, result.message, requestId);
    if (!validResponse(action, result.data)) throw new HistoryServiceError('HISTORY_RESPONSE_INVALID', '历史服务返回的结构不兼容；未替换已有目录或有效配置。', requestId);
    return result.data as Responses[A];
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (error instanceof HistoryServiceError) throw error;
    // IPC 的底层异常可能含本机路径；不将其原文写入表单或日志。
    throw new HistoryServiceError('HISTORY_BRIDGE_FAILED', '历史管理桥未能完成请求，请检查当前项目绑定和本机凭据配置。', requestId);
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}
