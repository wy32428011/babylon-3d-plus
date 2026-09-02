import { net } from 'electron';
import { promises as fs } from 'node:fs';
import { createPendingChunkIndexes } from './digitalTwinPublishProtocol.js';
import { resolveDataPlatformRemoteUrl } from './dataPlatformTransfer.js';
import type { DigitalTwinRuntimeConfigSavePayload } from '../shared/digitalTwinRuntimeConfig.js';

const REQUEST_TIMEOUT_MS = 30_000;
const COMMIT_TIMEOUT_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024;
const RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;

export type DigitalTwinUploadSession = {
  uploadId: string;
  packageType: 'SOURCE' | 'DIST';
  fileName: string;
  fileSize: number;
  sha256: string;
  chunkSize: number;
  totalChunks: number;
  uploadedChunks: number[];
  receivedBytes: number;
  status: string;
  completedFileId: string | null;
  expiresAt: string | null;
};

export type DigitalTwinPublishTask = {
  taskId: string;
  requestId: string;
  projectId: string;
  editorProjectId: string | null;
  baseVersionId: string | null;
  projectResourceRevision: string;
  publishName: string;
  remark: string | null;
  entryScenePath: string;
  entrySceneName: string;
  status: string;
  stage: string;
  errorCode: string | null;
  errorMessage: string | null;
  sourceUpload: DigitalTwinUploadSession | null;
  distUpload: DigitalTwinUploadSession | null;
  editorProjectVersionId: string | null;
  editorProjectPublishId: string | null;
  projectPublishId: string | null;
  stableUrl: string | null;
  releaseUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type DigitalTwinRuntimeConfig = {
  projectId: string;
  mqttBrokerUrl: string | null;
  apiBaseUrl: string | null;
  runtimeEnabled: boolean;
  configJson: string | null;
  updatedAt: string | null;
};

export type DigitalTwinProjectStatus = {
  projectId: string;
  editorProjectId: string | null;
  latestVersionId: string | null;
  latestVersionNumber: number | null;
  onlineVersionId: string | null;
  onlineVersionNumber: number | null;
  status: string;
  stableUrl: string | null;
  releaseUrl: string | null;
  lastPublishedAt: string | null;
  runtimeConfig: DigitalTwinRuntimeConfig;
};

export type DigitalTwinPreparePayload = {
  requestId: string;
  projectId: string;
  baseVersionId: string | null;
  overwriteExisting: boolean;
  forceOverwrite: boolean;
  publishName: string;
  remark: string | null;
  entryScenePath: string;
  entrySceneName: string;
  manifestJson: string;
  resourceRevision: string;
  confirmResourceBindings: boolean;
  modelIds: string[];
  envModelIds: string[];
  comboModelIds: string[];
  sourcePackage: { fileName: string; fileSize: number; sha256: string };
  distPackage: { fileName: string; fileSize: number; sha256: string };
};

export class DigitalTwinApiError extends Error {
  readonly code: string;
  readonly data: unknown;
  readonly httpStatus: number;

  constructor(code: string, message: string, data: unknown, httpStatus: number) {
    super(message);
    this.name = 'DigitalTwinApiError';
    this.code = code;
    this.data = data;
    this.httpStatus = httpStatus;
  }
}

/** 数据中台数字孪生发布 API 客户端，Long 主键始终以字符串传输和解析。 */
export class DigitalTwinUploadClient {
  constructor(private readonly baseUrl: string) {}

  async prepare(payload: DigitalTwinPreparePayload, signal: AbortSignal): Promise<DigitalTwinPublishTask> {
    const task = normalizePublishTask(await this.requestJson(
      'api/v1/digital-twin/publish-tasks/prepare',
      'POST',
      payload,
      signal,
    ));
    assertPreparedPublishTask(payload, task);
    return task;
  }

  async uploadPackage(
    session: DigitalTwinUploadSession,
    filePath: string,
    signal: AbortSignal,
    onProgress: (uploadedBytes: number, totalBytes: number) => void,
  ): Promise<DigitalTwinUploadSession> {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size !== session.fileSize) throw new Error(`待上传 ${session.packageType} 工程包大小已变化。`);
    let current = await this.uploadDetail(session.uploadId, signal);
    assertMatchingUploadSession(session, current);
    const pending = createPendingChunkIndexes(stat.size, current.chunkSize, current.uploadedChunks);
    let uploadedBytes = Math.min(current.receivedBytes, stat.size);
    onProgress(uploadedBytes, stat.size);
    const handle = await fs.open(filePath, 'r');
    try {
      for (const chunkIndex of pending) {
        throwIfAborted(signal);
        const offset = chunkIndex * current.chunkSize;
        const expectedBytes = Math.min(current.chunkSize, stat.size - offset);
        const buffer = Buffer.allocUnsafe(expectedBytes);
        const read = await handle.read(buffer, 0, expectedBytes, offset);
        if (read.bytesRead !== expectedBytes) throw new Error(`读取上传分片 ${chunkIndex} 不完整。`);
        const updated = await retryTransient(
          () => this.uploadChunk(current.uploadId, chunkIndex, buffer, signal),
          signal,
        );
        assertMatchingUploadSession(session, updated);
        current = updated;
        uploadedBytes = Math.min(current.receivedBytes, stat.size);
        onProgress(uploadedBytes, stat.size);
      }
    } finally {
      await handle.close();
    }
    const completed = await this.completeUpload(current.uploadId, signal);
    assertMatchingUploadSession(session, completed);
    return completed;
  }

  async uploadDetail(uploadId: string, signal: AbortSignal): Promise<DigitalTwinUploadSession> {
    return normalizeUploadSession(await this.requestJson(`api/v1/digital-twin/uploads/${uploadId}`, 'GET', undefined, signal));
  }

  async completeUpload(uploadId: string, signal: AbortSignal): Promise<DigitalTwinUploadSession> {
    return normalizeUploadSession(await this.requestJson(`api/v1/digital-twin/uploads/${uploadId}/complete`, 'POST', {}, signal));
  }

  async commit(expectedTask: DigitalTwinPublishTask, signal: AbortSignal): Promise<DigitalTwinPublishTask> {
    const task = normalizePublishTask(await this.requestJson(
      'api/v1/digital-twin/publish-tasks/commit',
      'POST',
      { taskId: expectedTask.taskId },
      signal,
      COMMIT_TIMEOUT_MS,
    ));
    assertMatchingPublishTaskIdentity(expectedTask, task);
    if (task.status !== 'COMPLETED') throw new Error('数字孪生提交响应未处于 COMPLETED 状态。');
    return task;
  }

  async cancel(taskId: string, signal: AbortSignal): Promise<void> {
    await this.requestJson('api/v1/digital-twin/publish-tasks/cancel', 'POST', { id: taskId }, signal);
  }

  async projectStatus(projectId: string, signal: AbortSignal): Promise<DigitalTwinProjectStatus> {
    const status = normalizeProjectStatus(await this.requestJson(
      'api/v1/digital-twin/projects/status',
      'POST',
      { projectId },
      signal,
    ));
    if (status.projectId !== projectId) throw new Error('数字孪生项目状态响应与请求项目不匹配。');
    return status;
  }

  async saveRuntimeConfig(
    payload: DigitalTwinRuntimeConfigSavePayload,
    signal: AbortSignal,
  ): Promise<DigitalTwinRuntimeConfig> {
    const config = normalizeRuntimeConfig(await this.requestJson(
      'api/v1/digital-twin/runtime-config/save',
      'POST',
      payload,
      signal,
    ));
    if (config.projectId !== payload.projectId) throw new Error('数字孪生运行配置响应与请求项目不匹配。');
    return config;
  }

  private async uploadChunk(
    uploadId: string,
    chunkIndex: number,
    body: Buffer,
    signal: AbortSignal,
  ): Promise<DigitalTwinUploadSession> {
    return normalizeUploadSession(await this.requestJson(
      `api/v1/digital-twin/uploads/${uploadId}/chunks/${chunkIndex}`,
      'PUT',
      new Uint8Array(body),
      signal,
    ));
  }

  private async requestJson(
    endpointPath: string,
    method: 'GET' | 'POST' | 'PUT',
    body: unknown,
    signal: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const endpoint = resolveDataPlatformRemoteUrl(this.baseUrl, endpointPath);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const binaryBody = body instanceof Uint8Array;
      const requestBody: BodyInit | undefined = method === 'GET'
        ? undefined
        : binaryBody
          ? Uint8Array.from(body).buffer
          : JSON.stringify(body ?? {});
      const response = await net.fetch(endpoint.toString(), {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          ...(binaryBody ? { 'Content-Type': 'application/octet-stream' } : method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(requestBody === undefined ? {} : { body: requestBody }),
        signal: controller.signal,
      });
      const responseText = await readResponseText(response, MAX_RESPONSE_BYTES);
      let envelope: unknown;
      try {
        envelope = responseText ? JSON.parse(responseText) as unknown : null;
      } catch {
        throw new Error(`数字孪生接口响应不是有效 JSON：${endpoint.pathname}`);
      }
      if (!isPlainObject(envelope)) throw new Error(`数字孪生接口响应结构无效：${endpoint.pathname}`);
      if (!response.ok || envelope.success !== true) {
        const code = typeof envelope.code === 'string' && envelope.code ? envelope.code : `HTTP_${response.status}`;
        const message = typeof envelope.message === 'string' && envelope.message ? envelope.message : `数字孪生接口返回 HTTP ${response.status}`;
        throw new DigitalTwinApiError(code, message, envelope.data, response.status);
      }
      return envelope.data;
    } catch (error) {
      if (timedOut) throw new Error(`数字孪生接口请求超时：${endpoint.pathname}`);
      if (signal.aborted) throw createAbortError();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }
}

async function retryTransient<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt >= RETRY_DELAYS_MS.length) throw error;
      await wait(RETRY_DELAYS_MS[attempt], signal);
    }
  }
  throw lastError;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof DigitalTwinApiError) return error.httpStatus === 408 || error.httpStatus === 429 || error.httpStatus >= 500;
  return error instanceof Error && error.name !== 'AbortError';
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(createAbortError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error('数字孪生接口响应过大，已停止读取。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function normalizePublishTask(value: unknown): DigitalTwinPublishTask {
  const task = requireObject(value, '数字孪生发布任务');
  return {
    taskId: requiredId(task.taskId, 'taskId'),
    requestId: requiredString(task.requestId, 'requestId'),
    projectId: requiredId(task.projectId, 'projectId'),
    editorProjectId: optionalId(task.editorProjectId),
    baseVersionId: optionalId(task.baseVersionId),
    projectResourceRevision: nonNegativeIntegerString(task.projectResourceRevision, 'projectResourceRevision'),
    publishName: requiredString(task.publishName, 'publishName'),
    remark: optionalString(task.remark),
    entryScenePath: requiredString(task.entryScenePath, 'entryScenePath'),
    entrySceneName: requiredString(task.entrySceneName, 'entrySceneName'),
    status: requiredString(task.status, 'status'),
    stage: requiredString(task.stage, 'stage'),
    errorCode: optionalString(task.errorCode),
    errorMessage: optionalString(task.errorMessage),
    sourceUpload: task.sourceUpload ? normalizeUploadSession(task.sourceUpload) : null,
    distUpload: task.distUpload ? normalizeUploadSession(task.distUpload) : null,
    editorProjectVersionId: optionalId(task.editorProjectVersionId),
    editorProjectPublishId: optionalId(task.editorProjectPublishId),
    projectPublishId: optionalId(task.projectPublishId),
    stableUrl: optionalString(task.stableUrl),
    releaseUrl: optionalString(task.releaseUrl),
    createdAt: optionalString(task.createdAt),
    updatedAt: optionalString(task.updatedAt),
  };
}

function assertPreparedPublishTask(payload: DigitalTwinPreparePayload, task: DigitalTwinPublishTask): void {
  if (task.requestId !== payload.requestId || task.projectId !== payload.projectId) {
    throw new Error('数字孪生 prepare 响应与原发布请求不匹配。');
  }
  if (!payload.forceOverwrite && payload.baseVersionId !== null && task.baseVersionId !== payload.baseVersionId) {
    throw new Error('数字孪生 prepare 响应基础版本不匹配。');
  }
  if (!payload.forceOverwrite && payload.baseVersionId === null && !payload.overwriteExisting && task.baseVersionId !== null) {
    throw new Error('数字孪生 prepare 响应包含意外的基础版本。');
  }
  if (payload.forceOverwrite && task.baseVersionId === null) {
    throw new Error('数字孪生强制覆盖 prepare 响应缺少实际基础版本。');
  }
  if (
    task.publishName !== payload.publishName.trim()
    || task.entryScenePath !== payload.entryScenePath.trim()
    || task.entrySceneName !== payload.entrySceneName.trim()
  ) {
    throw new Error('数字孪生 prepare 响应工程描述不匹配。');
  }

  const expectedRevision = normalizeDecimalString(payload.resourceRevision, 'resourceRevision');
  const revisionComparison = compareDecimalStrings(task.projectResourceRevision, expectedRevision);
  if ((!payload.confirmResourceBindings && revisionComparison !== 0) || (payload.confirmResourceBindings && revisionComparison < 0)) {
    throw new Error('数字孪生 prepare 响应资源修订不匹配。');
  }
  if (!task.sourceUpload || !task.distUpload) throw new Error('数字孪生 prepare 响应缺少 SOURCE 或 DIST 上传会话。');
  assertPreparedUpload(payload.sourcePackage, 'SOURCE', task.sourceUpload);
  assertPreparedUpload(payload.distPackage, 'DIST', task.distUpload);
}

function assertPreparedUpload(
  descriptor: DigitalTwinPreparePayload['sourcePackage'],
  packageType: DigitalTwinUploadSession['packageType'],
  session: DigitalTwinUploadSession,
): void {
  if (
    session.packageType !== packageType
    || session.fileName !== descriptor.fileName.trim()
    || session.fileSize !== descriptor.fileSize
    || session.sha256 !== descriptor.sha256.toLowerCase()
  ) {
    throw new Error(`数字孪生 prepare 响应 ${packageType} 上传会话与本地工程包不匹配。`);
  }
}

function assertMatchingPublishTaskIdentity(expected: DigitalTwinPublishTask, actual: DigitalTwinPublishTask): void {
  if (
    expected.taskId !== actual.taskId
    || expected.requestId !== actual.requestId
    || expected.projectId !== actual.projectId
    || expected.baseVersionId !== actual.baseVersionId
    || expected.projectResourceRevision !== actual.projectResourceRevision
    || expected.publishName !== actual.publishName
    || expected.entryScenePath !== actual.entryScenePath
    || expected.entrySceneName !== actual.entrySceneName
    || (expected.editorProjectId !== null && expected.editorProjectId !== actual.editorProjectId)
  ) {
    throw new Error('数字孪生提交响应与原发布任务不匹配。');
  }
}

function normalizeDecimalString(value: string, label: string): string {
  if (!/^\d{1,64}$/.test(value.trim())) throw new Error(`数字孪生请求 ${label} 无效。`);
  return value.trim().replace(/^0+(?=\d)/, '');
}

function compareDecimalStrings(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '');
  const normalizedRight = right.replace(/^0+(?=\d)/, '');
  return normalizedLeft.length - normalizedRight.length || normalizedLeft.localeCompare(normalizedRight, 'en');
}

function assertMatchingUploadSession(expected: DigitalTwinUploadSession, actual: DigitalTwinUploadSession): void {
  if (
    expected.uploadId !== actual.uploadId
    || expected.packageType !== actual.packageType
    || expected.fileName !== actual.fileName
    || expected.fileSize !== actual.fileSize
    || expected.sha256 !== actual.sha256
    || expected.chunkSize !== actual.chunkSize
    || expected.totalChunks !== actual.totalChunks
  ) {
    throw new Error('数字孪生上传会话在上传过程中发生变化。');
  }
}

function normalizeUploadSession(value: unknown): DigitalTwinUploadSession {
  const session = requireObject(value, '数字孪生上传会话');
  const packageType = session.packageType;
  if (packageType !== 'SOURCE' && packageType !== 'DIST') throw new Error('数字孪生上传会话 packageType 无效。');
  const fileSize = safeNonNegativeInteger(session.fileSize, 'fileSize');
  const chunkSize = positiveSafeInteger(session.chunkSize, 'chunkSize');
  if (chunkSize > MAX_UPLOAD_CHUNK_BYTES) throw new Error('数字孪生上传会话 chunkSize 超过 64 MiB 限制。');
  const totalChunks = safeNonNegativeInteger(session.totalChunks, 'totalChunks');
  const expectedTotalChunks = fileSize === 0 ? 0 : Math.ceil(fileSize / chunkSize);
  if (totalChunks !== expectedTotalChunks) throw new Error('数字孪生上传会话 totalChunks 与文件大小不一致。');
  if (!Array.isArray(session.uploadedChunks)) throw new Error('数字孪生上传会话 uploadedChunks 无效。');
  const uploadedChunks = session.uploadedChunks.map((item) => {
    if (!Number.isInteger(item) || Number(item) < 0 || Number(item) >= totalChunks) {
      throw new Error('数字孪生上传会话 uploadedChunks 包含越界分片。');
    }
    return Number(item);
  });
  const uniqueUploadedChunks = [...new Set(uploadedChunks)].sort((left, right) => left - right);
  if (uniqueUploadedChunks.length !== uploadedChunks.length) {
    throw new Error('数字孪生上传会话 uploadedChunks 包含重复分片。');
  }
  const receivedBytes = safeNonNegativeInteger(session.receivedBytes, 'receivedBytes');
  if (receivedBytes > fileSize) throw new Error('数字孪生上传会话 receivedBytes 超过文件大小。');
  return {
    uploadId: requiredId(session.uploadId, 'uploadId'),
    packageType,
    fileName: requiredString(session.fileName, 'fileName'),
    fileSize,
    sha256: requiredHash(session.sha256),
    chunkSize,
    totalChunks,
    uploadedChunks: uniqueUploadedChunks,
    receivedBytes,
    status: requiredString(session.status, 'status'),
    completedFileId: optionalId(session.completedFileId),
    expiresAt: optionalString(session.expiresAt),
  };
}

function normalizeProjectStatus(value: unknown): DigitalTwinProjectStatus {
  const status = requireObject(value, '数字孪生项目状态');
  const projectId = requiredId(status.projectId, 'projectId');
  const runtimeConfig = normalizeRuntimeConfig(status.runtimeConfig);
  if (runtimeConfig.projectId !== projectId) throw new Error('数字孪生项目状态中的运行配置项目不匹配。');
  return {
    projectId,
    editorProjectId: optionalId(status.editorProjectId),
    latestVersionId: optionalId(status.latestVersionId),
    latestVersionNumber: optionalPositiveInteger(status.latestVersionNumber),
    onlineVersionId: optionalId(status.onlineVersionId),
    onlineVersionNumber: optionalPositiveInteger(status.onlineVersionNumber),
    status: requiredString(status.status, 'status'),
    stableUrl: optionalString(status.stableUrl),
    releaseUrl: optionalString(status.releaseUrl),
    lastPublishedAt: optionalString(status.lastPublishedAt),
    runtimeConfig,
  };
}

function normalizeRuntimeConfig(value: unknown): DigitalTwinRuntimeConfig {
  const config = requireObject(value, '数字孪生运行配置');
  if (typeof config.runtimeEnabled !== 'boolean') throw new Error('数字孪生响应 runtimeEnabled 无效。');
  return {
    projectId: requiredId(config.projectId, 'projectId'),
    mqttBrokerUrl: optionalString(config.mqttBrokerUrl),
    apiBaseUrl: optionalString(config.apiBaseUrl),
    runtimeEnabled: config.runtimeEnabled,
    configJson: optionalString(config.configJson),
    updatedAt: optionalString(config.updatedAt),
  };
}

function requiredId(value: unknown, label: string): string {
  const normalized = optionalId(value);
  if (!normalized) throw new Error(`数字孪生响应 ${label} 无效。`);
  return normalized;
}

function optionalId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value.trim())) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new Error('数字孪生响应包含无效 Long ID。');
}

function nonNegativeIntegerString(value: unknown, label: string): string {
  if (typeof value === 'string' && /^\d{1,64}$/.test(value.trim())) return value.trim().replace(/^0+(?=\d)/, '');
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error(`数字孪生响应 ${label} 无效。`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`数字孪生响应 ${label} 无效。`);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeNonNegativeInteger(value: unknown, label: string): number {
  const normalized = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`数字孪生响应 ${label} 无效。`);
  }
  return normalized;
}

function positiveSafeInteger(value: unknown, label: string): number {
  const normalized = safeNonNegativeInteger(value, label);
  if (normalized <= 0) throw new Error(`数字孪生响应 ${label} 必须大于 0。`);
  return normalized;
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const normalized = safeNonNegativeInteger(value, '版本号');
  return normalized > 0 ? normalized : null;
}

function requiredHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('数字孪生响应 SHA-256 无效。');
  return value.toLowerCase();
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${label}响应结构无效。`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error('数字孪生发布已取消。');
  error.name = 'AbortError';
  return error;
}
