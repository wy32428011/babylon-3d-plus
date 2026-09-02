import { BrowserWindow } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DataPlatformBindingMetadata } from './dataPlatformBindingStore.js';
import {
  getCurrentDataPlatformBinding,
  inferDataPlatformWebBaseUrl,
} from './dataPlatformBindingStore.js';
import {
  executeDataPlatformChartSync,
  readDataPlatformChartIndex,
  type SyncedDataPlatformChart,
} from './dataPlatformChartStore.js';
import { requestDataPlatformJson } from './dataPlatformTransfer.js';

const CHART_QUERY_PAGE_SIZE = 100;
const CHART_QUERY_TIMEOUT_MS = 20_000;
const MISSING_INDEX_SYNCED_AT = new Date(0).toISOString();

export type DataPlatformChartSyncPhase =
  | 'querying'
  | 'parsing'
  | 'promoting'
  | 'completed'
  | 'failed';

export type DataPlatformChartSyncProgress = {
  runId: string;
  contextKey: string;
  phase: DataPlatformChartSyncPhase;
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

export type DataPlatformChartLibrarySnapshot = {
  contextKey: string | null;
  projectId: string | null;
  projectName: string | null;
  syncedAt: string | null;
  charts: SyncedDataPlatformChart[];
};

type DataPlatformChartSyncContext = {
  baseUrl: string;
  webBaseUrl: string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  contextKey: string;
};

export type DataPlatformChartSyncSource = {
  /** 当前配置的数据中台 API 地址；所有大屏查询必须使用此地址。 */
  baseUrl: string;
  /** 当前配置的大屏页面地址，仅用于解析/展示大屏页面。 */
  webBaseUrl?: string;
};

type ActiveDataPlatformChartSync = {
  runId: string;
  context: DataPlatformChartSyncContext;
  controller: AbortController;
  promise: Promise<void>;
};

let activeChartSync: ActiveDataPlatformChartSync | null = null;
let latestChartSyncProgress: DataPlatformChartSyncProgress | null = null;
let lastChartSyncContext: DataPlatformChartSyncContext | null = null;
let chartSyncShuttingDown = false;

/** 仅为当前已绑定的数据中台项目启动大屏资源同步。 */
export async function startDataPlatformChartSync(source?: DataPlatformChartSyncSource): Promise<boolean> {
  if (chartSyncShuttingDown) return false;
  const binding = getCurrentDataPlatformBinding();
  if (!binding) return false;

  const context = createChartSyncContext(binding.projectRoot, binding.metadata, source);
  if (!context) return false;
  if (!isCurrentChartSyncContext(context.contextKey)) return false;
  if (activeChartSync?.context.contextKey === context.contextKey) return false;

  if (activeChartSync) {
    const previous = activeChartSync;
    previous.controller.abort();
    await previous.promise.catch(() => undefined);
    if (chartSyncShuttingDown) return false;
    const currentBinding = getCurrentDataPlatformBinding();
    const currentContext = currentBinding
      ? createChartSyncContext(currentBinding.projectRoot, currentBinding.metadata, source)
      : null;
    if (!currentContext || currentContext.contextKey !== context.contextKey) return false;
    if (activeChartSync) return false;
  }

  lastChartSyncContext = context;
  const runId = randomUUID();
  const controller = new AbortController();
  const promise = runDataPlatformChartSync(runId, context, controller.signal)
    .catch((error: unknown) => {
      if (controller.signal.aborted || !isCurrentChartSyncContext(context.contextKey)) return;
      const message = toErrorMessage(error);
      updateChartSyncProgress({
        runId,
        contextKey: context.contextKey,
        phase: 'failed',
        completed: latestChartSyncProgress?.runId === runId ? latestChartSyncProgress.completed : 0,
        total: latestChartSyncProgress?.runId === runId ? latestChartSyncProgress.total : 0,
        message: '数据中台大屏同步失败，已保留原大屏资源。',
        error: message,
      });
    })
    .finally(() => {
      if (activeChartSync?.runId === runId) activeChartSync = null;
    });

  activeChartSync = { runId, context, controller, promise };
  return true;
}

/** 仅允许在仍处于同一绑定项目时重试最近一次同步。 */
export async function retryDataPlatformChartSync(source?: DataPlatformChartSyncSource): Promise<boolean> {
  if (activeChartSync || chartSyncShuttingDown || !lastChartSyncContext) return false;
  if (!isCurrentChartSyncContext(lastChartSyncContext.contextKey)) return false;
  return startDataPlatformChartSync(source);
}

/** 返回当前绑定项目的最近进度；项目切换后不暴露旧项目快照。 */
export function getCurrentDataPlatformChartSyncProgress(): DataPlatformChartSyncProgress | null {
  if (!latestChartSyncProgress || !isCurrentChartSyncContext(latestChartSyncProgress.contextKey)) return null;
  if (
    !isDataPlatformChartSyncTerminalPhase(latestChartSyncProgress.phase)
    && activeChartSync?.runId !== latestChartSyncProgress.runId
  ) return null;
  return { ...latestChartSyncProgress };
}

/** 读取当前绑定项目的本地大屏索引；未绑定时明确返回空图表库。 */
export async function listCurrentDataPlatformCharts(source?: DataPlatformChartSyncSource): Promise<DataPlatformChartLibrarySnapshot> {
  const binding = getCurrentDataPlatformBinding();
  if (!binding) {
    return {
      contextKey: null,
      projectId: null,
      projectName: null,
      syncedAt: null,
      charts: [],
    };
  }

  const context = createChartSyncContext(binding.projectRoot, binding.metadata, source);
  if (!context) {
    return {
      contextKey: null,
      projectId: null,
      projectName: null,
      syncedAt: null,
      charts: [],
    };
  }
  const index = await readDataPlatformChartIndex(
    binding.projectRoot,
    binding.metadata.projectId,
    context.baseUrl,
    context.webBaseUrl,
  );
  return {
    contextKey: context.contextKey,
    projectId: binding.metadata.projectId,
    projectName: binding.metadata.projectName,
    syncedAt: index.syncedAt === MISSING_INDEX_SYNCED_AT ? null : index.syncedAt,
    charts: index.charts.map((chart) => ({ ...chart })),
  };
}

/** 配置变化后禁止使用旧绑定上下文发起重试。 */
export function clearDataPlatformChartSyncRetryContext(): void {
  lastChartSyncContext = null;
  latestChartSyncProgress = null;
  activeChartSync?.controller.abort();
}

/** 应用退出时取消并等待在途请求，避免退出过程中继续写索引。 */
export async function disposeDataPlatformChartSync(): Promise<void> {
  chartSyncShuttingDown = true;
  lastChartSyncContext = null;
  const active = activeChartSync;
  if (!active) return;
  active.controller.abort();
  await active.promise.catch(() => undefined);
}

async function runDataPlatformChartSync(
  runId: string,
  context: DataPlatformChartSyncContext,
  signal: AbortSignal,
): Promise<void> {
  let queriedScreens = 0;
  let totalScreens = 0;
  updateChartSyncProgress({
    runId,
    contextKey: context.contextKey,
    phase: 'querying',
    completed: 0,
    total: 0,
    message: `正在查询项目“${context.projectName}”已绑定的大屏...`,
    error: null,
  });

  const index = await executeDataPlatformChartSync({
    baseUrl: context.baseUrl,
    webBaseUrl: context.webBaseUrl,
    projectId: context.projectId,
    projectRoot: context.projectRoot,
    requestPage: async (pageNum, pageSize) => {
      if (signal.aborted) throw new Error('数据中台大屏同步已取消。');
      updateChartSyncProgress({
        runId,
        contextKey: context.contextKey,
        phase: 'querying',
        completed: queriedScreens,
        total: totalScreens,
        message: `正在查询项目大屏第 ${pageNum} 页...`,
        error: null,
      });
      const payload = await requestDataPlatformJson({
        baseUrl: context.baseUrl,
        endpointPath: `api/v1/projects/${context.projectId}/config/screens/query`,
        body: { pageNum, pageSize, keyword: '' },
        signal,
        timeoutMs: CHART_QUERY_TIMEOUT_MS,
        context: `查询项目“${context.projectName}”已绑定大屏`,
      });

      const pageMetrics = readPageMetrics(payload);
      if (pageMetrics) {
        queriedScreens += pageMetrics.recordCount;
        totalScreens = pageMetrics.total;
        updateChartSyncProgress({
          runId,
          contextKey: context.contextKey,
          phase: 'parsing',
          completed: Math.min(queriedScreens, totalScreens),
          total: totalScreens,
          message: `正在整理第 ${pageNum} 页大屏资源...`,
          error: null,
        });
        if (queriedScreens >= totalScreens) {
          updateChartSyncProgress({
            runId,
            contextKey: context.contextKey,
            phase: 'promoting',
            completed: totalScreens,
            total: totalScreens,
            message: '正在原子替换当前项目大屏索引...',
            error: null,
          });
        }
      }
      return payload;
    },
    pageSize: CHART_QUERY_PAGE_SIZE,
  });

  if (signal.aborted || !isCurrentChartSyncContext(context.contextKey)) return;
  updateChartSyncProgress({
    runId,
    contextKey: context.contextKey,
    phase: 'completed',
    completed: index.charts.length,
    total: index.charts.length,
    message: `大屏同步完成，共同步 ${index.charts.length} 个大屏资源。`,
    error: null,
  });
}

function createChartSyncContext(
  projectRoot: string,
  metadata: DataPlatformBindingMetadata,
  source?: DataPlatformChartSyncSource,
): DataPlatformChartSyncContext | null {
  let normalizedBindingBaseUrl: string;
  let normalizedBaseUrl: string;
  let normalizedWebBaseUrl: string;
  try {
    normalizedBindingBaseUrl = new URL(metadata.baseUrl).toString().replace(/\/$/, '');
    normalizedBaseUrl = new URL(source?.baseUrl ?? normalizedBindingBaseUrl).toString().replace(/\/$/, '');
    normalizedWebBaseUrl = new URL(
      source?.webBaseUrl || metadata.webBaseUrl || inferDataPlatformWebBaseUrl(normalizedBaseUrl),
    ).toString().replace(/\/$/, '');
  } catch {
    return null;
  }
  const normalizedProjectId = metadata.projectId.trim();
  if (!/^[1-9]\d{0,63}$/.test(normalizedProjectId)) return null;
  const absoluteProjectRoot = path.resolve(projectRoot);
  const normalizedProjectRoot = process.platform === 'win32'
    ? absoluteProjectRoot.toLowerCase()
    : absoluteProjectRoot;
  const contextKey = createHash('sha256')
    // contextKey 标识绑定项目，不把展示页面地址或当前请求源混入身份 key。
    .update(`${normalizedBindingBaseUrl}\n${normalizedProjectId}\n${normalizedProjectRoot}`, 'utf8')
    .digest('hex');
  return {
    baseUrl: normalizedBaseUrl,
    webBaseUrl: normalizedWebBaseUrl,
    projectId: normalizedProjectId,
    projectName: metadata.projectName,
    projectRoot: absoluteProjectRoot,
    contextKey,
  };
}

function isCurrentChartSyncContext(expectedContextKey: string): boolean {
  const binding = getCurrentDataPlatformBinding();
  if (!binding) return false;
  return createChartSyncContext(binding.projectRoot, binding.metadata)?.contextKey === expectedContextKey;
}

function isDataPlatformChartSyncTerminalPhase(phase: DataPlatformChartSyncPhase): boolean {
  return phase === 'completed' || phase === 'failed';
}

function updateChartSyncProgress(progress: DataPlatformChartSyncProgress): void {
  if (chartSyncShuttingDown) return;
  latestChartSyncProgress = { ...progress };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('data-platform:chartSyncProgress', progress);
  }
}

function readPageMetrics(value: unknown): { recordCount: number; total: number } | null {
  if (!isPlainObject(value) || !isPlainObject(value.data) || !Array.isArray(value.data.records)) return null;
  const total = readNonNegativeSafeInteger(value.data.total);
  if (total === null) return null;
  return { recordCount: value.data.records.length, total };
}

function readNonNegativeSafeInteger(value: unknown): number | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return null;
    value = Number(normalized);
  }
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return '未知错误。';
  }
}
