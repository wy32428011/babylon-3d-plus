import { app, dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  DataPlatformConfig,
  DataPlatformEnvironmentSyncProgress,
  DataPlatformEnvironmentSyncRequest,
  DataPlatformImageSyncProgress,
  DataPlatformModelSyncProgress,
  DataPlatformSkyboxSyncProgress,
  SyncedImageAssetEntry,
  DataPlatformProjectEntry,
  DataPlatformProjectListRequest,
  DataPlatformProjectListResult,
  DataPlatformProjectOpenResult,
  DataPlatformWorkspaceSelectionResult,
  OpenDataPlatformProjectRequest,
  SaveDataPlatformConfigRequest,
} from '../types.js';
import {
  clearDataPlatformProjectServiceRetryContext,
  ensureWritableEditorRoot,
  getCurrentDataPlatformModelSyncProgress,
  getCurrentDataPlatformEnvironmentSyncProgress,
  getCurrentDataPlatformSkyboxSyncProgress,
  getDataPlatformEditorRoot,
  openDataPlatformProject,
  listSyncedImagesForWorkspace,
  retryLatestDataPlatformModelSync,
  retryLatestDataPlatformEnvironmentSync,
  retryLatestDataPlatformSkyboxSync,
  retryLatestDataPlatformImageSync,
  syncDataPlatformImagesForWorkspace,
  syncDataPlatformModelsForWorkspace,
  syncDataPlatformEnvironmentsForWorkspace,
  syncDataPlatformSkyboxesForWorkspace,
  getCurrentDataPlatformImageSyncProgress,
} from './dataPlatformProjectService.js';
import { requestDataPlatformJson } from './dataPlatformTransfer.js';

const DATA_PLATFORM_CONFIG_FILE = 'data-platform-config.json';
const PROJECT_QUERY_PATH = 'api/v1/projects/query';
const PROJECT_DETAIL_PATH = 'api/v1/projects/detail';
const PROJECT_PAGE_SIZE = 12;
const PROJECT_REQUEST_TIMEOUT_MS = 10_000;

let registered = false;
const trustedProjectsById = new Map<string, DataPlatformProjectEntry>();
let trustedProjectsBaseUrl = '';

type PersistedDataPlatformConfigV1 = {
  version: 1;
  baseUrl: string;
};

type PersistedDataPlatformConfigV2 = {
  version: 2;
  baseUrl: string;
  workspaceRoot: string | null;
};

type StoredDataPlatformConfig = {
  baseUrl: string;
  customWorkspaceRoot: string | null;
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
    'data-platform:selectWorkspace',
    async (): Promise<DataPlatformWorkspaceSelectionResult> => selectDataPlatformWorkspace(),
  );

  ipcMain.handle('data-platform:resetWorkspace', async (): Promise<DataPlatformConfig> => {
    const config = await resetDataPlatformWorkspace();
    clearDataPlatformProjectServiceRetryContext();
    return config;
  });

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
    'data-platform:getProject',
    async (_event, request: OpenDataPlatformProjectRequest): Promise<DataPlatformProjectEntry> => {
      const detailRequest = validateOpenProjectRequest(request);
      const config = await readDataPlatformConfig();
      if (!config.baseUrl) throw new Error('尚未配置数据中台地址。');
      const project = await requestDataPlatformProject(config.baseUrl, detailRequest.projectId);
      trustedProjectsById.set(project.id, project);
      trustedProjectsBaseUrl = config.baseUrl;
      return project;
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
      return openDataPlatformProject(project, config.baseUrl, config.workspaceRoot);
    },
  );

  ipcMain.handle('data-platform:syncModels', async (): Promise<boolean> => {
    const config = await readDataPlatformConfig();
    if (!config.baseUrl) return false;
    return syncDataPlatformModelsForWorkspace(config.baseUrl, config.workspaceRoot);
  });

  ipcMain.handle('data-platform:retryModelSync', async (): Promise<boolean> => {
    return retryLatestDataPlatformModelSync();
  });

  ipcMain.handle(
    'data-platform:getModelSyncProgress',
    async (): Promise<DataPlatformModelSyncProgress | null> => getCurrentDataPlatformModelSyncProgress(),
  );

  ipcMain.handle('data-platform:syncEnvironments', async (_event, request?: DataPlatformEnvironmentSyncRequest): Promise<boolean> => {
    const config = await readDataPlatformConfig();
    if (!config.baseUrl) return false;
    return syncDataPlatformEnvironmentsForWorkspace(config.baseUrl, config.workspaceRoot, request?.expectedSourceKey);
  });

  ipcMain.handle('data-platform:retryEnvironmentSync', async (): Promise<boolean> => {
    return retryLatestDataPlatformEnvironmentSync();
  });

  ipcMain.handle(
    'data-platform:getEnvironmentSyncProgress',
    async (): Promise<DataPlatformEnvironmentSyncProgress | null> => getCurrentDataPlatformEnvironmentSyncProgress(),
  );

  ipcMain.handle('data-platform:syncSkyboxes', async (): Promise<boolean> => {
    const config = await readDataPlatformConfig();
    if (!config.baseUrl) throw new Error('尚未配置数据中台地址。');
    return syncDataPlatformSkyboxesForWorkspace(config.baseUrl, config.workspaceRoot);
  });

  ipcMain.handle('data-platform:retrySkyboxSync', async (): Promise<boolean> => {
    return retryLatestDataPlatformSkyboxSync();
  });

  ipcMain.handle(
    'data-platform:getSkyboxSyncProgress',
    async (): Promise<DataPlatformSkyboxSyncProgress | null> => getCurrentDataPlatformSkyboxSyncProgress(),
  );

  ipcMain.handle('data-platform:syncImages', async (): Promise<boolean> => {
    const config = await readDataPlatformConfig();
    if (!config.baseUrl) return false;
    return syncDataPlatformImagesForWorkspace(config.baseUrl, config.workspaceRoot);
  });

  ipcMain.handle('data-platform:retryImageSync', async (): Promise<boolean> => {
    return retryLatestDataPlatformImageSync();
  });

  ipcMain.handle(
    'data-platform:getImageSyncProgress',
    async (): Promise<DataPlatformImageSyncProgress | null> => getCurrentDataPlatformImageSyncProgress(),
  );

  ipcMain.handle(
    'data-platform:listSyncedImages',
    async (): Promise<SyncedImageAssetEntry[]> => {
      const config = await readDataPlatformConfig();
      if (!config.baseUrl) return [];
      return listSyncedImagesForWorkspace(config.workspaceRoot);
    },
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

/** 读取配置文件并兼容仅包含服务地址的 v1 格式。 */
async function readStoredDataPlatformConfig(): Promise<StoredDataPlatformConfig> {
  try {
    const content = await fs.readFile(getDataPlatformConfigPath(), 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    if (!isPlainObject(parsed)) {
      throw new Error('数据中台配置文件版本或结构不正确。');
    }

    if (parsed.version === 1) {
      const legacy = parsed as PersistedDataPlatformConfigV1;
      return {
        baseUrl: normalizeDataPlatformBaseUrl(legacy.baseUrl),
        customWorkspaceRoot: null,
      };
    }

    if (parsed.version !== 2) {
      throw new Error('数据中台配置文件版本或结构不正确。');
    }

    const current = parsed as PersistedDataPlatformConfigV2;
    return {
      baseUrl: normalizeDataPlatformBaseUrl(current.baseUrl),
      customWorkspaceRoot: normalizePersistedWorkspaceRoot(current.workspaceRoot),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { baseUrl: '', customWorkspaceRoot: null };
    }

    if (error instanceof SyntaxError) {
      throw new Error('数据中台配置文件不是有效 JSON。');
    }

    throw error;
  }
}

/** 将内部配置转换为 renderer 可直接展示的有效工作区。 */
function toDataPlatformConfig(stored: StoredDataPlatformConfig): DataPlatformConfig {
  return {
    baseUrl: stored.baseUrl,
    workspaceRoot: getDataPlatformEditorRoot(stored.customWorkspaceRoot),
    usesDefaultWorkspace: stored.customWorkspaceRoot === null,
  };
}

/** 读取 userData 中持久化的数据中台配置。 */
async function readDataPlatformConfig(): Promise<DataPlatformConfig> {
  return toDataPlatformConfig(await readStoredDataPlatformConfig());
}

/** 统一写入 v2 配置，避免修改服务地址时覆盖已经选择的工作区。 */
async function writeStoredDataPlatformConfig(stored: StoredDataPlatformConfig): Promise<DataPlatformConfig> {
  const persisted: PersistedDataPlatformConfigV2 = {
    version: 2,
    baseUrl: stored.baseUrl,
    workspaceRoot: stored.customWorkspaceRoot,
  };
  const configPath = getDataPlatformConfigPath();

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf-8');
  return toDataPlatformConfig(stored);
}

/** 写入经过校验的数据中台服务地址，并保留工作区配置。 */
async function saveDataPlatformConfig(request: SaveDataPlatformConfigRequest): Promise<DataPlatformConfig> {
  const stored = await readStoredDataPlatformConfig();
  return writeStoredDataPlatformConfig({
    ...stored,
    baseUrl: normalizeDataPlatformBaseUrl(request.baseUrl),
  });
}

/** 由主进程选择并验证工作区，renderer 无法直接提交任意文件系统路径。 */
async function selectDataPlatformWorkspace(): Promise<DataPlatformWorkspaceSelectionResult> {
  const stored = await readStoredDataPlatformConfig();
  const currentConfig = toDataPlatformConfig(stored);
  const result = await dialog.showOpenDialog({
    title: '选择数据中台工作区',
    defaultPath: currentConfig.workspaceRoot,
    properties: ['openDirectory', 'createDirectory'],
  });
  const [selectedPath] = result.filePaths;

  if (result.canceled || !selectedPath) {
    return { canceled: true, config: currentConfig };
  }

  const workspaceRoot = path.resolve(selectedPath);
  await ensureWritableEditorRoot(workspaceRoot);

  const config = await writeStoredDataPlatformConfig({
    ...stored,
    customWorkspaceRoot: workspaceRoot,
  });
  clearDataPlatformProjectServiceRetryContext();
  return { canceled: false, config };
}

/** 清除自定义路径并恢复当前运行环境的默认工作区。 */
async function resetDataPlatformWorkspace(): Promise<DataPlatformConfig> {
  const stored = await readStoredDataPlatformConfig();
  const defaultWorkspaceRoot = getDataPlatformEditorRoot(null);
  await ensureWritableEditorRoot(defaultWorkspaceRoot);
  return writeStoredDataPlatformConfig({
    ...stored,
    customWorkspaceRoot: null,
  });
}

/** 按项目 ID 查询详情，供外部深链绕过分页列表精确打开目标工程。 */
async function requestDataPlatformProject(baseUrl: string, projectId: string): Promise<DataPlatformProjectEntry> {
  const payload = await requestDataPlatformJson({
    baseUrl,
    endpointPath: PROJECT_DETAIL_PATH,
    body: { id: projectId },
    signal: new AbortController().signal,
    timeoutMs: PROJECT_REQUEST_TIMEOUT_MS,
    context: '查询数据中台项目详情',
  });
  if (!isPlainObject(payload) || payload.success !== true || !isPlainObject(payload.data)) {
    const message = isPlainObject(payload) && typeof payload.message === 'string' ? payload.message.trim() : '';
    throw new Error(message || '数据中台项目详情响应结构不正确。');
  }
  return normalizeProjectEntry(payload.data, 0);
}
/** 通过统一受限请求读取数据中台业务项目列表。 */
async function requestDataPlatformProjects(baseUrl: string, projectName: string): Promise<DataPlatformProjectListResult> {
  const payload = await requestDataPlatformJson({
    baseUrl,
    endpointPath: PROJECT_QUERY_PATH,
    body: {
      pageNum: 1,
      pageSize: PROJECT_PAGE_SIZE,
      projectName,
    },
    signal: new AbortController().signal,
    timeoutMs: PROJECT_REQUEST_TIMEOUT_MS,
    context: '查询数据中台项目列表',
  });
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
    currentResourceRevision: normalizeNonNegativeIntegerString(value.currentResourceRevision),
    publishedResourceRevision: normalizeNonNegativeIntegerString(value.publishedResourceRevision),
    digitalTwinStatus: normalizeOptionalString(value.digitalTwinStatus),
    onlineDigitalTwinVersionId: normalizeOptionalIdentifier(value.onlineDigitalTwinVersionId),
    onlineDigitalTwinVersionNumber: normalizeOptionalInteger(value.onlineDigitalTwinVersionNumber),
    onlineDigitalTwinPublishId: normalizeOptionalIdentifier(value.onlineDigitalTwinPublishId),
    onlineProjectPublishId: normalizeOptionalIdentifier(value.onlineProjectPublishId),
    digitalTwinStableUrl: normalizeOptionalString(value.digitalTwinStableUrl),
    digitalTwinReleaseUrl: normalizeOptionalString(value.digitalTwinReleaseUrl),
    digitalTwinLastPublishedAt: normalizeOptionalString(value.digitalTwinLastPublishedAt),
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

function normalizePersistedWorkspaceRoot(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) {
    throw new Error('数据中台配置中的工作区路径无效。');
  }
  return path.normalize(value.trim());
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
    return /^[1-9]\d{0,63}$/.test(normalized) ? normalized : null;
  }

  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }

  return null;
}

/** 非负 Long 修订号按字符串保留，避免 JavaScript number 丢失精度。 */
function normalizeNonNegativeIntegerString(value: unknown): string {
  if (typeof value === 'string' && /^\d{1,64}$/.test(value.trim())) {
    return value.trim().replace(/^0+(?=\d)/, '');
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return '0';
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