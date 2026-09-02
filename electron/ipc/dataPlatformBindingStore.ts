import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const BINDING_FILE_NAME = 'data-platform-binding.json';
const PROJECT_ID_PATTERN = /^[1-9]\d{0,63}$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^\d{1,64}$/;
const POSITIVE_ID_PATTERN = /^[1-9]\d{0,63}$/;
const DATA_PLATFORM_FRONTEND_PORT_MIN = 1;
const DATA_PLATFORM_FRONTEND_PORT_MAX = 65_535;

export type DataPlatformBindingMetadata = {
  version: 1;
  baseUrl: string;
  /** 大屏页面所在的 Web 地址；旧绑定缺失时按 API 地址推导。 */
  webBaseUrl: string;
  workspaceRoot: string | null;
  projectId: string;
  projectName: string;
  editorProjectId: string | null;
  latestVersionId: string | null;
  latestVersionNumber: number | null;
  resourceRevision: string;
  entryScenePath: string | null;
  syncedAt: string;
};

export type CreateDataPlatformBindingInput = Omit<DataPlatformBindingMetadata, 'version' | 'workspaceRoot' | 'webBaseUrl'> & {
  webBaseUrl?: string;
  workspaceRoot?: string | null;
};

type CurrentDataPlatformBinding = {
  projectRoot: string;
  metadata: DataPlatformBindingMetadata;
};

let currentBinding: CurrentDataPlatformBinding | null = null;

/** 业务项目工作区固定落在 workspaceRoot/Projects/{projectId}，项目 ID 不参与自由路径拼接。 */
export function resolveDataPlatformProjectRoot(workspaceRoot: string, projectId: string): string {
  const normalizedProjectId = normalizeProjectId(projectId);
  return path.resolve(workspaceRoot, 'Projects', normalizedProjectId);
}

/** 全量共享模型缓存与业务工程分离，项目通过资产索引只读引用该目录。 */
export function resolveDataPlatformSharedResourcesRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, 'SharedResources');
}

/** 从绑定恢复数据中台工作区；旧版绑定仅允许按规范 Projects/{projectId} 目录反推。 */
export function resolveDataPlatformBindingWorkspaceRoot(
  projectRoot: string,
  metadata: Pick<DataPlatformBindingMetadata, 'workspaceRoot' | 'projectId'>,
): string {
  if (metadata.workspaceRoot) return path.resolve(metadata.workspaceRoot);
  const normalizedProjectRoot = path.resolve(projectRoot);
  const projectsRoot = path.dirname(normalizedProjectRoot);
  if (path.basename(projectsRoot).toLowerCase() !== 'projects' || path.basename(normalizedProjectRoot) !== metadata.projectId) {
    throw new Error('本地数据中台项目绑定缺少工作区信息，且项目目录结构无法安全反推。');
  }
  return path.dirname(projectsRoot);
}

export function resolveDataPlatformBindingSharedResourcesRoot(
  projectRoot: string,
  metadata: Pick<DataPlatformBindingMetadata, 'workspaceRoot' | 'projectId'>,
): string {
  return resolveDataPlatformSharedResourcesRoot(resolveDataPlatformBindingWorkspaceRoot(projectRoot, metadata));
}

export function getDataPlatformBindingPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.babylon-editor', BINDING_FILE_NAME);
}

/** 创建经过严格归一化的绑定元数据，所有 Long 标识均保留为十进制字符串。 */
export function createDataPlatformBinding(input: CreateDataPlatformBindingInput): DataPlatformBindingMetadata {
  const latestVersionNumber = input.latestVersionNumber;
  if (latestVersionNumber !== null && (!Number.isInteger(latestVersionNumber) || latestVersionNumber <= 0)) {
    throw new Error('最新工程版本号无效。');
  }
  return {
    version: 1,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    webBaseUrl: normalizeBaseUrl(input.webBaseUrl ?? inferDataPlatformWebBaseUrl(input.baseUrl)),
    workspaceRoot: normalizeWorkspaceRoot(input.workspaceRoot),
    projectId: normalizeProjectId(input.projectId),
    projectName: normalizeProjectName(input.projectName),
    editorProjectId: normalizeOptionalId(input.editorProjectId, 'Editor 工程 ID'),
    latestVersionId: normalizeOptionalId(input.latestVersionId, '最新工程版本 ID'),
    latestVersionNumber,
    resourceRevision: normalizeResourceRevision(input.resourceRevision),
    entryScenePath: normalizeEntryScenePath(input.entryScenePath),
    syncedAt: normalizeTimestamp(input.syncedAt),
  };
}

/** 原子写入项目绑定；临时文件始终与目标同目录且带随机标记。 */
export async function writeDataPlatformBinding(
  projectRoot: string,
  metadata: DataPlatformBindingMetadata,
): Promise<DataPlatformBindingMetadata> {
  const normalized = createDataPlatformBinding(metadata);
  const bindingPath = getDataPlatformBindingPath(projectRoot);
  const parentRoot = path.dirname(bindingPath);
  const temporaryPath = path.join(parentRoot, `.${BINDING_FILE_NAME}.tmp-${randomUUID()}`);
  await fs.mkdir(parentRoot, { recursive: true });
  await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await replaceFile(temporaryPath, bindingPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return normalized;
}

/** 读取并校验项目绑定；不存在时返回 null，损坏内容不静默吞掉。 */
export async function readDataPlatformBinding(projectRoot: string): Promise<DataPlatformBindingMetadata | null> {
  const bindingPath = getDataPlatformBindingPath(projectRoot);
  try {
    const parsed = JSON.parse(await fs.readFile(bindingPath, 'utf8')) as unknown;
    if (!isPlainObject(parsed) || parsed.version !== 1) throw new Error('本地数据中台绑定文件版本或结构无效。');
    return createDataPlatformBinding({
      baseUrl: parsed.baseUrl as string,
      webBaseUrl: (parsed.webBaseUrl ?? inferDataPlatformWebBaseUrl(parsed.baseUrl as string)) as string,
      workspaceRoot: (parsed.workspaceRoot ?? null) as string | null,
      projectId: parsed.projectId as string,
      projectName: parsed.projectName as string,
      editorProjectId: (parsed.editorProjectId ?? null) as string | null,
      latestVersionId: (parsed.latestVersionId ?? null) as string | null,
      latestVersionNumber: (parsed.latestVersionNumber ?? null) as number | null,
      resourceRevision: parsed.resourceRevision as string,
      entryScenePath: (parsed.entryScenePath ?? null) as string | null,
      syncedAt: parsed.syncedAt as string,
    });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`读取本地数据中台项目绑定失败：${message}`);
  }
}

export function setCurrentDataPlatformBinding(projectRoot: string, metadata: DataPlatformBindingMetadata): void {
  currentBinding = { projectRoot: path.resolve(projectRoot), metadata: createDataPlatformBinding(metadata) };
}

export function getCurrentDataPlatformBinding(): CurrentDataPlatformBinding | null {
  return currentBinding ? { projectRoot: currentBinding.projectRoot, metadata: { ...currentBinding.metadata } } : null;
}

export function clearCurrentDataPlatformBinding(): void {
  currentBinding = null;
}

/**
 * 按明确项目更新绑定；发布期间即使用户切换了当前项目，也只写回原发布项目。
 */
export async function updateDataPlatformBinding(
  projectRoot: string,
  expectedProjectId: string,
  patch: Partial<Omit<DataPlatformBindingMetadata, 'version' | 'projectId' | 'baseUrl' | 'workspaceRoot'>>,
): Promise<DataPlatformBindingMetadata> {
  const normalizedRoot = path.resolve(projectRoot);
  const normalizedProjectId = normalizeProjectId(expectedProjectId);
  const existing = await readDataPlatformBinding(normalizedRoot);
  if (!existing) throw new Error('目标数据中台项目绑定不存在。');
  if (existing.projectId !== normalizedProjectId) throw new Error('目标数据中台项目绑定与发布项目不匹配。');

  const updated = createDataPlatformBinding({ ...existing, ...patch });
  await writeDataPlatformBinding(normalizedRoot, updated);
  if (currentBinding?.projectRoot === normalizedRoot && currentBinding.metadata.projectId === normalizedProjectId) {
    currentBinding = { projectRoot: normalizedRoot, metadata: updated };
  }
  return updated;
}

function normalizeBaseUrl(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('数据中台地址不能为空。');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('数据中台地址格式无效。');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('数据中台地址仅支持不含凭据的 HTTP/HTTPS URL。');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

/** 校验数据中台前端端口；空值表示按 API 地址自动推导。 */
export function normalizeDataPlatformFrontendPort(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) return null;
    if (!/^\d+$/.test(normalized)) throw new Error('数据中台前端端口必须是 1-65535 的整数。');
    value = Number(normalized);
  }
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < DATA_PLATFORM_FRONTEND_PORT_MIN
    || value > DATA_PLATFORM_FRONTEND_PORT_MAX
  ) {
    throw new Error('数据中台前端端口必须是 1-65535 的整数。');
  }
  return value;
}

/** 从已归一化的大屏页面地址回填端口，默认协议端口返回 null。 */
export function inferDataPlatformFrontendPort(webBaseUrl: string): number | null {
  try {
    const url = new URL(webBaseUrl.trim());
    return url.port ? normalizeDataPlatformFrontendPort(url.port) : null;
  } catch {
    return null;
  }
}

/** 按 API 主机生成大屏页面根地址；显式前端端口优先于历史自动推导规则。 */
export function resolveDataPlatformWebBaseUrl(baseUrl: string, frontendPort?: number | null): string {
  const normalizedPort = normalizeDataPlatformFrontendPort(frontendPort);
  try {
    const url = new URL(baseUrl.trim());
    if (normalizedPort !== null) {
      url.port = String(normalizedPort);
    } else if (isPrivateOrLocalHostname(url.hostname) && (url.port === '8086' || url.port === '18087')) {
      url.port = '8001';
    }
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return baseUrl.trim().replace(/\/+$/, '');
  }
}

/** 旧配置只保存 API 地址时，为本地开发端口补齐大屏页面地址。 */
export function inferDataPlatformWebBaseUrl(baseUrl: string): string {
  return resolveDataPlatformWebBaseUrl(baseUrl);
}

/**
 * 保存弹窗里的大屏地址和前端端口。
 * 用户明确填写的页面地址必须原样保留；端口只在页面地址为空时用来按 API 主机推导。
 */
export function resolveSavedDataPlatformPageConfig(draft: {
  baseUrl: string;
  storedBaseUrl: string;
  storedWebBaseUrl: string;
  storedFrontendPort: number | null;
  requestedWebBaseUrl?: string;
  requestedFrontendPort?: number | null;
  hasRequestedWebBaseUrl: boolean;
  hasRequestedFrontendPort: boolean;
}): { webBaseUrl: string; frontendPort: number | null } {
  if (!draft.baseUrl) return { webBaseUrl: '', frontendPort: null };

  const frontendPort = draft.hasRequestedFrontendPort
    ? normalizeDataPlatformFrontendPort(draft.requestedFrontendPort)
    : draft.storedFrontendPort;
  const requestedWebBaseUrl = draft.hasRequestedWebBaseUrl
    ? normalizeOptionalPageUrl(draft.requestedWebBaseUrl)
    : undefined;

  if (requestedWebBaseUrl) {
    return { webBaseUrl: requestedWebBaseUrl, frontendPort };
  }

  if (frontendPort !== null) {
    return {
      webBaseUrl: resolveDataPlatformWebBaseUrl(draft.baseUrl, frontendPort),
      frontendPort,
    };
  }

  if (!draft.hasRequestedWebBaseUrl && draft.baseUrl === draft.storedBaseUrl && draft.storedWebBaseUrl) {
    return {
      webBaseUrl: draft.storedWebBaseUrl,
      frontendPort: draft.storedFrontendPort,
    };
  }

  const inferredWebBaseUrl = inferDataPlatformWebBaseUrl(draft.baseUrl);
  return {
    webBaseUrl: inferredWebBaseUrl,
    frontendPort: inferDataPlatformFrontendPort(inferredWebBaseUrl),
  };
}

/** 页面地址允许留空表示改回自动推导，非空时走与绑定相同的 HTTP(S) 校验。 */
function normalizeOptionalPageUrl(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('大屏页面地址必须是字符串。');
  return value.trim() ? normalizeBaseUrl(value) : '';
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  if (/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(normalized)) return true;
  if (/^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(normalized)) return true;
  if (/^192\.168\.(?:\d{1,3}\.)\d{1,3}$/.test(normalized)) return true;
  const private172 = normalized.match(/^172\.(\d{1,3})\.(?:\d{1,3}\.)\d{1,3}$/);
  if (!private172) return false;
  const secondOctet = Number(private172[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}

function normalizeWorkspaceRoot(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) {
    throw new Error('数据中台工作区路径无效。');
  }
  return path.resolve(value.trim());
}

function normalizeProjectId(value: string): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value.trim())) throw new Error('数据中台项目 ID 无效。');
  return value.trim();
}

function normalizeProjectName(value: string): string {
  if (typeof value !== 'string') throw new Error('数据中台项目名称无效。');
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\x00-\x1f]/.test(normalized)) throw new Error('数据中台项目名称无效。');
  return normalized;
}

function normalizeOptionalId(value: string | null, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !POSITIVE_ID_PATTERN.test(value.trim())) throw new Error(`${label} 无效。`);
  return value.trim();
}

function normalizeResourceRevision(value: string): string {
  if (typeof value !== 'string' || !NON_NEGATIVE_INTEGER_PATTERN.test(value.trim())) throw new Error('项目资源修订无效。');
  return value.trim().replace(/^0+(?=\d)/, '');
}

function normalizeEntryScenePath(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('入口场景路径无效。');
  const normalized = path.posix.normalize(value.trim().replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error('入口场景路径必须位于项目目录内。');
  }
  if (!normalized.toLowerCase().endsWith('.scene.json')) throw new Error('入口场景路径必须是 .scene.json 文件。');
  return normalized;
}

function normalizeTimestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('绑定同步时间无效。');
  return new Date(value).toISOString();
}

async function replaceFile(sourcePath: string, targetPath: string): Promise<void> {
  let initialError: unknown;
  try {
    await fs.rename(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!isNodeError(error) || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code ?? '')) throw error;
    initialError = error;
  }

  let targetStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    targetStat = await fs.lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') throw initialError;
    throw error;
  }
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error(`目标路径不是安全普通文件，拒绝替换：${targetPath}`);
  }

  const backupPath = `${targetPath}.backup-${randomUUID()}`;
  let backupMoved = false;
  try {
    await fs.rename(targetPath, backupPath);
    backupMoved = true;
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (backupMoved) {
      try {
        await fs.rename(backupPath, targetPath);
        backupMoved = false;
      } catch (rollbackError) {
        const originalMessage = error instanceof Error ? error.message : String(error);
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`替换文件失败且旧文件回滚失败：${originalMessage}；旧文件保留在 ${backupPath}；回滚错误：${rollbackMessage}`);
      }
    }
    throw error;
  }
  if (backupMoved) await fs.rm(backupPath, { force: true }).catch(() => undefined);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}
