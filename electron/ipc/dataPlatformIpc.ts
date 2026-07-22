import { app, ipcMain, net } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  DataPlatformConfig,
  DataPlatformModelSyncProgress,
  DataPlatformProjectEntry,
  DataPlatformProjectListRequest,
  DataPlatformProjectListResult,
  DataPlatformProjectOpenResult,
  OpenDataPlatformProjectRequest,
  SaveDataPlatformConfigRequest,
} from '../types.js';
import {
  clearDataPlatformProjectServiceRetryContext,
  getCurrentDataPlatformModelSyncProgress,
  openDataPlatformProject,
  retryLatestDataPlatformModelSync,
} from './dataPlatformProjectService.js';

const DATA_PLATFORM_CONFIG_FILE = 'data-platform-config.json';
const PROJECT_QUERY_PATH = 'api/v1/projects/query';
const PROJECT_PAGE_SIZE = 12;
const PROJECT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_TEXT_LENGTH = 2_000_000;

let registered = false;
const trustedProjectsById = new Map<string, DataPlatformProjectEntry>();
let trustedProjectsBaseUrl = '';

type PersistedDataPlatformConfig = {
  version: 1;
  baseUrl: string;
};

/** 注册数据中台配置与项目列表 IPC，重复调用时保持幂等。 */
export function registerDataPlatformIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('data-platform:getConfig', async (): Promise<DataPlatformConfig> => {
    return readDataPlatformConfig();
  });

  ipcMain.handle(
    'data-platform:saveConfig',
    async (_event, request: SaveDataPlatformConfigRequest): Promise<DataPlatformConfig> => {
      const config = await saveDataPlatformConfig(validateSaveRequest(request));
      trustedProjectsById.clear();
      trustedProjectsBaseUrl = '';
      clearDataPlatformProjectServiceRetryContext();
      return config;
    },
  );

  ipcMain.handle(
    'data-platform:listProjects',
    async (_event, request?: DataPlatformProjectListRequest): Promise<DataPlatformProjectListResult> => {
      const query = validateProjectListRequest(request);
      const config = await readDataPlatformConfig();
      if (!config.baseUrl) {
        throw new Error('尚未配置数据中台地址。');
      }

      const result = await requestDataPlatformProjects(config.baseUrl, query.projectName);
      trustedProjectsById.clear();
      trustedProjectsBaseUrl = config.baseUrl;
      for (const project of result.records) trustedProjectsById.set(project.id, project);
      return result;
    },
  );

  ipcMain.handle(
    'data-platform:openProject',
    async (_event, request: OpenDataPlatformProjectRequest): Promise<DataPlatformProjectOpenResult> => {
      const openRequest = validateOpenProjectRequest(request);
      const project = trustedProjectsById.get(openRequest.projectId);
      if (!project) {
        throw new Error('只能打开最近一次数据中台列表中展示的项目，请先刷新项目列表。');
      }

      const config = await readDataPlatformConfig();
      if (!config.baseUrl) throw new Error('尚未配置数据中台地址。');
      if (config.baseUrl !== trustedProjectsBaseUrl) {
        throw new Error('数据中台地址已变化，请刷新项目列表后再打开。');
      }
      return openDataPlatformProject(project, config.baseUrl);
    },
  );

  ipcMain.handle('data-platform:retryModelSync', async (): Promise<boolean> => {
    return retryLatestDataPlatformModelSync();
  });

  ipcMain.handle(
    'data-platform:getModelSyncProgress',
    async (): Promise<DataPlatformModelSyncProgress | null> => getCurrentDataPlatformModelSyncProgress(),
  );
}

/** 规范化数据中台地址，空字符串表示主动清除配置。 */
export function normalizeDataPlatformBaseUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('数据中台地址必须是字符串。');
  }

  const trimmed = value.trim();
  if (!trimmed) return '';

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('数据中台地址格式不正确。');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('数据中台地址仅支持 http:// 或 https://。');
  }

  if (parsed.username || parsed.password) {
    throw new Error('数据中台地址不能包含账号或密码。');
  }

  if (parsed.search || parsed.hash) {
    throw new Error('数据中台地址不能包含 query 或 hash。');
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${normalizedPath === '/' ? '' : normalizedPath}`;
}

/** 读取 userData 中持久化的数据中台配置。 */
async function readDataPlatformConfig(): Promise<DataPlatformConfig> {
  try {
    const content = await fs.readFile(getDataPlatformConfigPath(), 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    if (!isPlainObject(parsed) || parsed.version !== 1) {
      throw new Error('数据中台配置文件版本或结构不正确。');
    }

    return {
      baseUrl: normalizeDataPlatformBaseUrl(parsed.baseUrl),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { baseUrl: '' };
    }

    if (error instanceof SyntaxError) {
      throw new Error('数据中台配置文件不是有效 JSON。');
    }

    throw error;
  }
}

/** 写入经过校验的数据中台配置。 */
async function saveDataPlatformConfig(request: SaveDataPlatformConfigRequest): Promise<DataPlatformConfig> {
  const config: DataPlatformConfig = {
    baseUrl: normalizeDataPlatformBaseUrl(request.baseUrl),
  };
  const persisted: PersistedDataPlatformConfig = {
    version: 1,
    baseUrl: config.baseUrl,
  };
  const configPath = getDataPlatformConfigPath();

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf-8');
  return config;
}

/** 通过 Electron 网络栈查询数据中台业务项目列表。 */
async function requestDataPlatformProjects(baseUrl: string, projectName: string): Promise<DataPlatformProjectListResult> {
  const endpoint = new URL(PROJECT_QUERY_PATH, `${baseUrl}/`).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROJECT_REQUEST_TIMEOUT_MS);

  let response: Awaited<ReturnType<typeof net.fetch>>;
  try {
    response = await net.fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pageNum: 1,
        pageSize: PROJECT_PAGE_SIZE,
        projectName,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new Error('请求数据中台项目列表超时，请检查服务地址和网络。');
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`连接数据中台失败：${message}`);
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('请求数据中台项目列表超时，请检查服务地址和网络。');
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`读取数据中台响应失败：${message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (responseText.length > MAX_RESPONSE_TEXT_LENGTH) {
    throw new Error('数据中台项目列表响应过大，已停止解析。');
  }

  if (!response.ok) {
    const detail = readResponseMessage(responseText);
    throw new Error(`数据中台返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error('数据中台项目列表响应不是有效 JSON。');
  }

  return normalizeProjectListResponse(payload);
}

/** 校验并归一化项目列表响应，避免远端异常字段污染 renderer。 */
export function normalizeProjectListResponse(value: unknown): DataPlatformProjectListResult {
  if (!isPlainObject(value)) {
    throw new Error('数据中台项目列表响应结构不正确。');
  }

  if (value.success !== true) {
    const message = typeof value.message === 'string' && value.message.trim()
      ? value.message.trim()
      : '数据中台返回业务失败。';
    throw new Error(message);
  }

  if (!isPlainObject(value.data) || !Array.isArray(value.data.records)) {
    throw new Error('数据中台项目列表缺少 data.records。');
  }

  const records = value.data.records
    .map((record, index) => normalizeProjectEntry(record, index))
    .sort((left, right) => toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt))
    .slice(0, PROJECT_PAGE_SIZE);

  return {
    records,
    total: normalizeNonNegativeInteger(value.data.total, records.length),
  };
}

function normalizeProjectEntry(value: unknown, index: number): DataPlatformProjectEntry {
  if (!isPlainObject(value)) {
    throw new Error(`数据中台项目列表第 ${index + 1} 项不是对象。`);
  }

  return {
    id: normalizeRequiredIdentifier(value.id, `数据中台项目列表第 ${index + 1} 项 id`),
    projectName: normalizeRequiredString(value.projectName, `第 ${index + 1} 项 projectName`),
    sceneCount: normalizeNonNegativeInteger(value.sceneCount),
    screenCount: normalizeNonNegativeInteger(value.screenCount),
    modelCount: normalizeNonNegativeInteger(value.modelCount),
    envModelCount: normalizeNonNegativeInteger(value.envModelCount),
    comboModelCount: normalizeNonNegativeInteger(value.comboModelCount),
    poiCount: normalizeNonNegativeInteger(value.poiCount),
    chartCount: normalizeNonNegativeInteger(value.chartCount),
    themeCount: normalizeNonNegativeInteger(value.themeCount),
    latestEditorProjectId: normalizeOptionalIdentifier(value.latestEditorProjectId),
    latestEditorProjectVersionId: normalizeOptionalIdentifier(value.latestEditorProjectVersionId),
    latestEditorProjectVersionNumber: normalizeOptionalInteger(value.latestEditorProjectVersionNumber),
    latestEditorProjectName: normalizeOptionalString(value.latestEditorProjectName),
    latestEditorProjectPackageUrl: normalizeOptionalString(value.latestEditorProjectPackageUrl),
    latestEditorProjectPackageFileName: normalizeOptionalString(value.latestEditorProjectPackageFileName),
    updatedAt: normalizeOptionalString(value.updatedAt),
  };
}


function validateOpenProjectRequest(value: unknown): OpenDataPlatformProjectRequest {
  if (!isPlainObject(value)) {
    throw new Error('打开数据中台项目请求格式不正确。');
  }

  return {
    projectId: normalizeRequiredIdentifier(value.projectId, '打开数据中台项目请求中的 projectId'),
  };
}

function validateSaveRequest(value: unknown): SaveDataPlatformConfigRequest {
  if (!isPlainObject(value)) {
    throw new Error('数据中台配置请求格式不正确。');
  }

  return {
    baseUrl: normalizeDataPlatformBaseUrl(value.baseUrl),
  };
}

/** 校验项目查询条件，未传入时保持原有的全量第一页行为。 */
function validateProjectListRequest(value: unknown): DataPlatformProjectListRequest {
  if (value === undefined) return { projectName: '' };
  if (!isPlainObject(value)) {
    throw new Error('数据中台项目查询请求格式不正确。');
  }

  if (value.projectName !== undefined && typeof value.projectName !== 'string') {
    throw new Error('项目名称搜索条件必须是字符串。');
  }

  const projectName = typeof value.projectName === 'string' ? value.projectName.trim() : '';
  if (projectName.length > 100) {
    throw new Error('项目名称搜索条件不能超过 100 个字符。');
  }

  return { projectName };
}

function getDataPlatformConfigPath(): string {
  return path.join(app.getPath('userData'), DATA_PLATFORM_CONFIG_FILE);
}

function readResponseMessage(responseText: string): string {
  if (!responseText.trim()) return '';

  try {
    const parsed = JSON.parse(responseText) as unknown;
    return isPlainObject(parsed) && typeof parsed.message === 'string'
      ? parsed.message.trim().slice(0, 300)
      : '';
  } catch {
    return '';
  }
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`数据中台项目列表 ${fieldName} 无效。`);
  }

  return value.trim();
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeRequiredIdentifier(value: unknown, fieldName: string): string {
  const normalized = normalizeIdentifier(value);
  if (!normalized) {
    throw new Error(`${fieldName} 无效。`);
  }

  return normalized;
}

function normalizeOptionalIdentifier(value: unknown): string | null {
  return normalizeIdentifier(value);
}

/** 业务主键按十进制字符串保留，拒绝把超出安全整数范围的 number 静默取整。 */
function normalizeIdentifier(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return /^\d{1,64}$/.test(normalized) ? normalized : null;
  }

  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }

  return null;
}

function normalizeOptionalInteger(value: unknown): number | null {
  const normalized = toFiniteNumber(value);
  return normalized === null || normalized < 0 ? null : Math.trunc(normalized);
}

function normalizeNonNegativeInteger(value: unknown, fallback = 0): number {
  const normalized = toFiniteNumber(value);
  return normalized === null || normalized < 0 ? fallback : Math.trunc(normalized);
}

function toFiniteNumber(value: unknown): number | null {
  const normalized = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(normalized) ? normalized : null;
}

function toTimestamp(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}