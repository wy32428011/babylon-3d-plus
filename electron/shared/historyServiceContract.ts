export type HistorySourceRole = 'telemetry' | 'inventory' | 'cargo' | 'alarm' | 'baseline' | 'historical-events';

export type HistoryJson = null | boolean | number | string | HistoryJson[] | { [key: string]: HistoryJson };
export type HistoryJsonObject = { [key: string]: HistoryJson };
export type HistoryProjectContext = { projectId: string; projectName: string; platformOrigin: string | null; latestVersionId: string | null };
export type HistoryAccessStatus = { configured: boolean; encryptionAvailable: boolean; platformOrigin: string | null; projectId: string };
export type HistoryAccessUpdate = { projectId: string; operation: 'replace' | 'clear'; secret?: string };
export type HistoryServiceResult = { success: true; data: unknown } | { success: false; code: string; message: string };
export type HistorySourceKind = 'mqtt' | 'http' | 'platform' | 'external-http';
export type HistorySourceSummary = {
  sourceId: string;
  projectId: string;
  name: string;
  kind: HistorySourceKind;
  revision: string;
  accessRevision: string;
  status: 'draft' | 'ready' | 'retired' | 'disabled';
  roles: HistorySourceRole[];
  credentialConfigured: boolean;
  updatedAt: string;
};
export type HistorySourceDetail = HistorySourceSummary & { config: HistoryJsonObject };
export type HistorySourceQueryResult = { items: HistorySourceSummary[]; total: number };
export type HistoryValidationIssue = { code: string; severity: 'error' | 'warning'; message: string; sourceId?: string };
export type HistoryValidationResult = {
  validationId: string;
  contractId: string | null;
  digest: string | null;
  expiresAt: number;
  canActivate: boolean;
  issues: HistoryValidationIssue[];
};
export type HistoryServiceCapabilities = {
  version: 1;
  authorizationRequired: boolean;
  credentialsConfigured: boolean;
  providers: ('platform' | 'external-http')[];
  maxSourceBindings: number;
  maxResponseBytes: number;
  maxPageCount: number;
  maxRetentionDays: number;
};
export type HistoryEffectiveConfiguration = {
  projectId: string;
  policyRevision: string;
  bindingRevision: string;
  publishedVersionId: string | null;
  contractId: string | null;
  phase: 'not-configured' | 'initializing' | 'collecting' | 'ready' | 'paused' | 'failed';
  completeness: 'uninitialized' | 'incomplete' | 'complete';
  message: string | null;
  capturedThrough: number | null;
  queryableThrough: number | null;
  retentionDays: number | null;
};
export type HistoryOperationResult = {
  operationId: string;
  requestId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  message: string | null;
  result: HistoryJson;
};

export type HistoryProjectorBuild = { digest: string; stateSchemaVersion: '1'; kernelVersion: 'state-kernel/1'; scheduleVersion: 'input-boundary/1' };
export type HistoryProjectorQuery = { items: HistoryProjectorBuild[] };
export type HistoryPublishedVersion = { publishedVersionId: string; versionNumber: number; historyPackageAvailable: boolean };
export type HistoryPublicationQuery = { items: HistoryPublishedVersion[]; total: number };
export type HistoryCaptureStatus = HistoryEffectiveConfiguration & { operations: HistoryOperationResult[] };

export const HISTORY_SERVICE_ACTIONS = {
  capabilities: '/api/v1/twin-history/capabilities',
  queryPublishedVersions: '/api/v1/twin-history/publications/query',
  queryProjectorBuilds: '/api/v1/twin-history/projectors/query',
  querySources: '/api/v1/twin-history/sources/query',
  queryImportCandidates: '/api/v1/twin-history/sources/import-candidates',
  importSource: '/api/v1/twin-history/sources/import',
  getSource: '/api/v1/twin-history/sources/detail',
  saveSourceDraft: '/api/v1/twin-history/sources/draft/save',
  updateSourceCredential: '/api/v1/twin-history/sources/credential/update',
  probeSource: '/api/v1/twin-history/sources/probe',
  sourceUsage: '/api/v1/twin-history/sources/usage',
  retireSource: '/api/v1/twin-history/sources/retire',
  validateConfig: '/api/v1/twin-history/capture/config/validate',
  getCaptureConfig: '/api/v1/twin-history/capture/config/query',
  activateProvider: '/api/v1/twin-history/providers/activate',
  applyCapturePolicy: '/api/v1/twin-history/capture/policy/apply',
  pauseCapture: '/api/v1/twin-history/capture/pause',
  resumeCapture: '/api/v1/twin-history/capture/resume',
  captureStatus: '/api/v1/twin-history/capture/status',
  getOperation: '/api/v1/twin-history/capture/tasks/detail',
  cancelOperation: '/api/v1/twin-history/capture/tasks/cancel',
} as const;
export type HistoryServiceAction = keyof typeof HISTORY_SERVICE_ACTIONS;
export type HistoryServiceRequest = {
  requestId: string;
  projectId: string;
  action: HistoryServiceAction;
  body: HistoryJsonObject;
};

const MAX_REQUEST_BYTES = 262_144;
const MAX_NODES = 20_000;
const utf8 = new TextEncoder();

function copyJson(value: unknown, depth: number, budget: { nodes: number }): HistoryJson {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > 16) throw new Error('历史服务请求超过结构预算。');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('历史服务请求包含非法数值。');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_REQUEST_BYTES) throw new Error('历史服务请求字段过长。');
    return value;
  }
  if (typeof value !== 'object' || !value) throw new Error('历史服务请求必须是普通 JSON 数据。');
  if (Object.getOwnPropertySymbols(value).length) throw new Error('历史服务请求含不支持的属性。');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((item) => !Object.prototype.hasOwnProperty.call(item, 'value'))) {
    throw new Error('历史服务请求不允许访问器。');
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_NODES) throw new Error('历史服务请求数组不合法。');
    if (Object.keys(descriptors).some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(key))) throw new Error('历史服务请求数组包含额外属性。');
    return Array.from({ length: value.length }, (_, index) => {
      const item = descriptors[String(index)];
      if (!item) throw new Error('历史服务请求数组不能包含空缺项。');
      return copyJson(item.value, depth + 1, budget);
    });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('历史服务请求对象不合法。');
  const result: HistoryJsonObject = Object.create(null) as HistoryJsonObject;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('历史服务请求包含不安全字段。');
    result[key] = copyJson(descriptor.value, depth + 1, budget);
  }
  return result;
}

export function validateHistoryProjectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new Error('历史项目 ID 必须是有效的长整型字符串。');
  }
  return value;
}

export function validateHistoryAccessUpdate(value: unknown): HistoryAccessUpdate {
  const input = copyJson(value, 0, { nodes: 0 });
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['projectId', 'operation', 'secret'].includes(key))) throw new Error('历史访问凭据操作格式不正确。');
  const projectId = validateHistoryProjectId(input.projectId);
  if (input.operation === 'clear') {
    if (input.secret !== undefined) throw new Error('清除访问凭据时不能同时提交密钥。');
    return { projectId, operation: 'clear' };
  }
  if (input.operation !== 'replace' || typeof input.secret !== 'string'
    || input.secret.length < 16 || input.secret.length > 4096 || /[^\x21-\x7e]/u.test(input.secret) || /^\*+$/u.test(input.secret)) {
    throw new Error('管理访问键须为 16–4096 位无空格 ASCII 字符，不能使用遮罩值。');
  }
  return { projectId, operation: 'replace', secret: input.secret };
}

/** 固定动作桥接；即使请求体包含来源地址，也只能发给平台管理 API，不能作为转发目标。 */
export function validateHistoryServiceRequest(value: unknown): HistoryServiceRequest {
  const input = copyJson(value, 0, { nodes: 0 });
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('历史服务请求格式不正确。');
  if (Object.keys(input).some((key) => !['requestId', 'projectId', 'action', 'body'].includes(key))) throw new Error('历史服务请求包含未知字段。');
  const { requestId, projectId, action, body = {} } = input;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(requestId)) throw new Error('历史请求标识不合法。');
  const normalizedProjectId = validateHistoryProjectId(projectId);
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(HISTORY_SERVICE_ACTIONS, action)) throw new Error('不支持的历史服务动作。');
  if (!body || typeof body !== 'object' || Array.isArray(body) || 'projectId' in body || 'requestId' in body) throw new Error('历史服务参数不能覆盖项目或请求标识。');
  for (const key of ['sourceId', 'dataSourceId', 'sourceRevision', 'expectedRevision', 'expectedAccessRevision', 'publishedVersionId', 'policyRevision', 'bindingRevision', 'operationId', 'operationRequestId', 'contractId', 'validationId']) {
    if (key in body && (typeof body[key] !== 'string' || body[key].length === 0 || body[key].length > 256)) {
      throw new Error('历史服务的标识和修订必须使用非空字符串。');
    }
  }
  if (utf8.encode(JSON.stringify(input)).byteLength > MAX_REQUEST_BYTES) throw new Error('历史服务请求超过字节预算。');
  return { requestId, projectId: normalizedProjectId, action: action as HistoryServiceAction, body };
}

export function historyServiceEndpoint(request: HistoryServiceRequest): { path: string; body: HistoryJsonObject } {
  return {
    path: HISTORY_SERVICE_ACTIONS[request.action],
    body: { ...request.body, projectId: request.projectId, requestId: request.requestId },
  };
}
