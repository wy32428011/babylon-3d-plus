import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const INDEX_FILE_NAME = 'data-platform-charts.json';
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const MAX_QUERY_PAGES = 100;
const MAX_SCREEN_RECORDS = 10_000;
const POSITIVE_IDENTIFIER_PATTERN = /^[1-9]\d{0,63}$/;
const SCREEN_ID_PREFIX = 'data-platform-screen:';

export type DataPlatformChartType = 'SCREEN';

export type SyncedDataPlatformChart = {
  id: string;
  projectId: string;
  screenId: string;
  screenName: string;
  screenCode?: string;
  name: string;
  chartType: DataPlatformChartType;
};

export type DataPlatformChartIndex = {
  version: 1;
  baseUrl?: string;
  projectId: string;
  syncedAt: string;
  charts: SyncedDataPlatformChart[];
};

export type ExecuteDataPlatformChartSyncOptions = {
  baseUrl?: string;
  projectId: string;
  projectRoot: string;
  syncedAt?: string;
  pageSize?: number;
  requestPage: (pageNum: number, pageSize: number) => Promise<unknown>;
};

type NormalizedScreenPage = {
  records: Record<string, unknown>[];
  total: number;
};

/** 图表索引固定存放在当前业务项目目录内，避免不同项目共享同一份列表。 */
export function getDataPlatformChartIndexPath(projectRoot: string): string {
  return path.join(normalizeProjectRoot(projectRoot), '.babylon-editor', INDEX_FILE_NAME);
}

/**
 * 拉取当前项目已绑定的大屏元数据。所有分页均成功后才替换本地索引。
 */
export async function executeDataPlatformChartSync(
  options: ExecuteDataPlatformChartSyncOptions,
): Promise<DataPlatformChartIndex> {
  if (!isPlainObject(options)) throw new Error('数据中台图表同步参数无效。');
  if (typeof options.requestPage !== 'function') throw new Error('数据中台图表分页请求函数无效。');

  const projectId = normalizePositiveIdentifier(options.projectId, '数据中台项目 ID');
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const baseUrl = options.baseUrl === undefined ? undefined : normalizeBaseUrl(options.baseUrl);
  const syncedAt = normalizeTimestamp(options.syncedAt ?? new Date().toISOString());
  const pageSize = normalizePageSize(options.pageSize ?? DEFAULT_PAGE_SIZE);
  const charts: SyncedDataPlatformChart[] = [];
  const chartIds = new Set<string>();
  let receivedScreenCount = 0;
  let expectedTotal: number | null = null;
  let completed = false;

  for (let pageNum = 1; pageNum <= MAX_QUERY_PAGES; pageNum += 1) {
    const payload = await options.requestPage(pageNum, pageSize);
    const page = normalizeScreenPage(payload, pageNum, pageSize);
    if (expectedTotal === null) expectedTotal = page.total;
    else if (page.total !== expectedTotal) {
      throw new Error(`项目大屏分页 total 不一致：期望 ${expectedTotal}，实际 ${page.total}。`);
    }
    receivedScreenCount += page.records.length;
    if (receivedScreenCount > MAX_SCREEN_RECORDS || page.total > MAX_SCREEN_RECORDS) {
      throw new Error(`项目已绑定大屏数量超过 ${MAX_SCREEN_RECORDS} 项限制。`);
    }
    if (receivedScreenCount > page.total) {
      throw new Error(`项目大屏分页记录数 ${receivedScreenCount} 超过响应 total ${page.total}。`);
    }

    page.records.forEach((screen, index) => {
      const chart = createScreenEntry(screen, projectId, receivedScreenCount - page.records.length + index);
      if (chartIds.has(chart.id)) {
        throw new Error(`项目大屏稳定 ID 重复或冲突：${chart.id}`);
      }
      chartIds.add(chart.id);
      charts.push(chart);
    });

    if (receivedScreenCount === page.total) {
      completed = true;
      break;
    }
    if (page.records.length === 0 || page.records.length < pageSize) {
      throw new Error(`项目大屏分页未取完 total：已获取 ${receivedScreenCount}，应获取 ${page.total}。`);
    }
  }

  if (!completed) throw new Error(`项目大屏分页超过 ${MAX_QUERY_PAGES} 页限制。`);

  const index = normalizeDataPlatformChartIndex({
    version: 1,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    projectId,
    syncedAt,
    charts,
  });
  await writeDataPlatformChartIndex(projectRoot, index);
  return index;
}

/** 原子写入图表索引，失败时不会留下半份 JSON 或覆盖可用旧索引。 */
export async function writeDataPlatformChartIndex(
  projectRoot: string,
  index: DataPlatformChartIndex,
): Promise<DataPlatformChartIndex> {
  const normalized = normalizeDataPlatformChartIndex(index);
  const indexPath = getDataPlatformChartIndexPath(projectRoot);
  const parentRoot = path.dirname(indexPath);
  const temporaryPath = path.join(parentRoot, `.${INDEX_FILE_NAME}.tmp-${randomUUID()}`);

  await fs.mkdir(parentRoot, { recursive: true });
  await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await replaceFile(temporaryPath, indexPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return normalized;
}

/** 读取当前项目图表索引，并可同时校验绑定项目和数据中台地址。 */
export async function readDataPlatformChartIndex(
  projectRoot: string,
  expectedProjectId: string,
  expectedBaseUrl?: string,
): Promise<DataPlatformChartIndex> {
  const projectId = normalizePositiveIdentifier(expectedProjectId, '数据中台项目 ID');
  const baseUrl = expectedBaseUrl === undefined ? undefined : normalizeBaseUrl(expectedBaseUrl);
  try {
    const parsed = JSON.parse(await fs.readFile(getDataPlatformChartIndexPath(projectRoot), 'utf8')) as unknown;
    const normalized = normalizeDataPlatformChartIndex(parsed);
    if (normalized.projectId !== projectId) {
      throw new Error(`图表索引项目不匹配：期望 ${projectId}，实际 ${normalized.projectId}。`);
    }
    if (baseUrl !== undefined && normalized.baseUrl !== baseUrl) {
      throw new Error('图表索引数据中台地址与当前项目绑定不匹配。');
    }
    return normalized;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        version: 1,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        projectId,
        syncedAt: new Date(0).toISOString(),
        charts: [],
      };
    }
    throw error;
  }
}

/** 校验磁盘格式并保持可选字段不被无意义补齐。 */
export function normalizeDataPlatformChartIndex(value: unknown): DataPlatformChartIndex {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.charts)) {
    throw new Error('数据中台图表索引版本或结构无效。');
  }

  const projectId = normalizePositiveIdentifier(value.projectId, '图表索引 projectId');
  const baseUrl = value.baseUrl === undefined ? undefined : normalizeBaseUrl(value.baseUrl);
  const chartIds = new Set<string>();
  const charts: SyncedDataPlatformChart[] = [];
  value.charts.forEach((chart, index) => {
    if (isPlainObject(chart) && isLegacyWidgetChartType(chart.chartType)) return;
    const normalized = normalizeChartEntry(chart, projectId, index);
    if (chartIds.has(normalized.id)) throw new Error(`图表索引存在重复稳定 ID：${normalized.id}`);
    chartIds.add(normalized.id);
    charts.push(normalized);
  });
  if (charts.length > MAX_SCREEN_RECORDS) throw new Error(`项目大屏数量超过 ${MAX_SCREEN_RECORDS} 项限制。`);

  return {
    version: 1,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    projectId,
    syncedAt: normalizeTimestamp(value.syncedAt),
    charts,
  };
}

function normalizeScreenPage(value: unknown, expectedPageNum: number, expectedPageSize: number): NormalizedScreenPage {
  if (!isPlainObject(value)) throw new Error('数据中台项目大屏响应结构不正确。');
  if (value.success !== true) {
    throw new Error(normalizeOptionalText(value.message) ?? '数据中台项目大屏查询失败。');
  }
  if (!isPlainObject(value.data) || !Array.isArray(value.data.records)) {
    throw new Error('数据中台项目大屏响应缺少 data.records。');
  }

  const pageNum = normalizeNonNegativeInteger(value.data.pageNum, '项目大屏响应 pageNum');
  const pageSize = normalizeNonNegativeInteger(value.data.pageSize, '项目大屏响应 pageSize');
  if (pageNum !== expectedPageNum) {
    throw new Error(`项目大屏响应页码 pageNum 不一致：期望 ${expectedPageNum}，实际 ${pageNum}。`);
  }
  if (pageSize !== expectedPageSize) {
    throw new Error(`项目大屏响应 pageSize 不一致：期望 ${expectedPageSize}，实际 ${pageSize}。`);
  }

  return {
    records: value.data.records.map((record, index) => {
      if (!isPlainObject(record)) throw new Error(`项目大屏响应第 ${index + 1} 项不是对象。`);
      return record;
    }),
    total: normalizeNonNegativeInteger(value.data.total, '项目大屏响应 total'),
  };
}

function createScreenEntry(
  screen: Record<string, unknown>,
  projectId: string,
  screenIndex: number,
): SyncedDataPlatformChart {
  const screenId = normalizePositiveIdentifier(screen.screenId, `第 ${screenIndex + 1} 项 screenId（大屏 ID）`);
  const screenName = normalizeRequiredText(screen.screenName, `第 ${screenIndex + 1} 项大屏名称`, 256);
  const screenCode = normalizeOptionalText(screen.screenCode, 256);
  return {
    id: `${SCREEN_ID_PREFIX}${projectId}:${screenId}`,
    projectId,
    screenId,
    screenName,
    ...(screenCode === undefined ? {} : { screenCode }),
    name: screenName,
    chartType: 'SCREEN',
  };
}

function normalizeChartEntry(value: unknown, projectId: string, index: number): SyncedDataPlatformChart {
  if (!isPlainObject(value)) throw new Error(`图表索引第 ${index + 1} 项不是对象。`);
  const entryProjectId = normalizePositiveIdentifier(value.projectId, `图表索引第 ${index + 1} 项 projectId`);
  if (entryProjectId !== projectId) throw new Error(`图表索引第 ${index + 1} 项所属项目不匹配。`);
  const screenId = normalizePositiveIdentifier(value.screenId, `图表索引第 ${index + 1} 项 screenId`);
  if (value.chartType !== 'SCREEN') throw new Error(`图表索引第 ${index + 1} 项 chartType 无效。`);
  if (value.widgetId !== undefined || value.pageKey !== undefined) {
    throw new Error(`图表索引第 ${index + 1} 项大屏不能包含 widgetId 或 pageKey。`);
  }
  const expectedId = `${SCREEN_ID_PREFIX}${projectId}:${screenId}`;
  if (value.id !== expectedId) throw new Error(`图表索引第 ${index + 1} 项稳定 ID 无效。`);
  const screenCode = normalizeOptionalText(value.screenCode, 256);

  return {
    id: expectedId,
    projectId,
    screenId,
    screenName: normalizeRequiredText(value.screenName, `图表索引第 ${index + 1} 项 screenName`, 256),
    ...(screenCode === undefined ? {} : { screenCode }),
    name: normalizeRequiredText(value.name, `图表索引第 ${index + 1} 项 name`, 256),
    chartType: 'SCREEN',
  };
}

function isLegacyWidgetChartType(value: unknown): boolean {
  return value === 'LINE_CHART' || value === 'BAR_CHART' || value === 'PIE_CHART';
}

function normalizePositiveIdentifier(value: unknown, label: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} 必须是字符串，数字值超出 JavaScript 安全整数范围。`);
    value = String(value);
  }
  if (typeof value !== 'string' || !POSITIVE_IDENTIFIER_PATTERN.test(value.trim())) {
    throw new Error(`${label} 必须是规范正十进制字符串。`);
  }
  return value.trim();
}

function normalizeProjectRoot(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) {
    throw new Error('图表索引项目根目录必须是绝对路径。');
  }
  return path.resolve(value.trim());
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('数据中台地址不能为空。');
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('数据中台地址格式无效。');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new Error('数据中台地址仅支持不含凭据的 HTTP/HTTPS URL。');
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('图表同步时间无效。');
  return new Date(value).toISOString();
}

function normalizePageSize(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_PAGE_SIZE) {
    throw new Error(`图表同步 pageSize 必须是 1-${MAX_PAGE_SIZE} 的整数。`);
  }
  return value as number;
}

function normalizeNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) throw new Error(`${label} 必须是非负安全整数。`);
    value = Number(normalized);
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} 必须是非负安全整数。`);
  return value as number;
}

function normalizeRequiredText(value: unknown, label: string, maxLength: number): string {
  const normalized = normalizeOptionalText(value, maxLength);
  if (!normalized) throw new Error(`${label} 不能为空或格式无效。`);
  return normalized;
}

function normalizeOptionalText(value: unknown, maxLength = 1024): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\x00-\x1f]/.test(normalized)) return undefined;
  return normalized;
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
    throw new Error(`图表索引目标路径不是安全普通文件，拒绝替换：${targetPath}`);
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
        throw new Error(`替换图表索引失败且旧文件回滚失败：${originalMessage}；旧文件保留在 ${backupPath}；回滚错误：${rollbackMessage}`);
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
