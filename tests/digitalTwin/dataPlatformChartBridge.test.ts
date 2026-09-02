import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CHART_SYNC_PATH = 'electron/ipc/dataPlatformChartSync.ts';
const DATA_PLATFORM_IPC_PATH = 'electron/ipc/dataPlatformIpc.ts';
const PRELOAD_PATHS = ['electron/preload.ts', 'electron/preload.cts'];
const MAIN_PATH = 'electron/main.ts';

test('图表同步只使用当前绑定项目并查询该项目已绑定大屏', () => {
  const source = readFileSync(CHART_SYNC_PATH, 'utf8');

  assert.ok(source.includes('getCurrentDataPlatformBinding()'));
  assert.ok(source.includes('if (!binding) return false'));
  assert.ok(source.includes('api/v1/projects/${context.projectId}/config/screens/query'));
  assert.ok(source.includes('executeDataPlatformChartSync({'));
  assert.ok(source.includes('projectId: context.projectId'));
  assert.ok(source.includes('projectRoot: context.projectRoot'));
});

test('图表同步上下文由已读取绑定纯计算，并在启动前复核当前绑定', () => {
  const source = readFileSync(CHART_SYNC_PATH, 'utf8');

  assert.ok(source.includes("import { createHash, randomUUID } from 'node:crypto';"));
  assert.ok(source.includes("import path from 'node:path';"));
  assert.ok(source.includes("const contextKey = createHash('sha256')"));
  assert.equal(source.includes('const contextKey = getCurrentDataPlatformSkyboxSyncContextKey();'), false);
  assert.ok(source.includes('if (!isCurrentChartSyncContext(context.contextKey)) return false;'));
});

test('已结束任务不会继续暴露查询中或解析中的陈旧进度', () => {
  const source = readFileSync(CHART_SYNC_PATH, 'utf8');

  assert.ok(source.includes('isDataPlatformChartSyncTerminalPhase(latestChartSyncProgress.phase)'));
  assert.ok(source.includes('activeChartSync?.runId !== latestChartSyncProgress.runId'));
});

test('图表库快照按当前绑定上下文读取并在未绑定时返回空库', () => {
  const source = readFileSync(CHART_SYNC_PATH, 'utf8');

  assert.ok(source.includes('listCurrentDataPlatformCharts'));
  assert.ok(source.includes('contextKey: null'));
  assert.ok(source.includes('projectId: null'));
  assert.ok(source.includes('charts: []'));
  assert.ok(source.includes('readDataPlatformChartIndex('));
  assert.ok(source.includes('binding.projectRoot'));
  assert.ok(source.includes('binding.metadata.projectId'));
  assert.ok(source.includes('context.baseUrl'));
  assert.ok(source.includes('context.webBaseUrl'));
});

test('图表同步 IPC 入口始终使用当前持久化配置地址', () => {
  const source = readFileSync(DATA_PLATFORM_IPC_PATH, 'utf8');

  assert.ok(source.includes("const config = await readDataPlatformConfig();"));
  assert.ok(source.includes("return startDataPlatformChartSync({"));
  assert.ok(source.includes("return retryDataPlatformChartSync({"));
  assert.ok(source.includes('baseUrl: config.baseUrl'));
  assert.ok(source.includes('webBaseUrl: config.webBaseUrl || config.baseUrl'));
});

test('IPC 与两个 preload 入口暴露图表同步、重试、快照和进度订阅', () => {
  const ipcSource = readFileSync(DATA_PLATFORM_IPC_PATH, 'utf8');
  assert.ok(ipcSource.includes("'data-platform:syncCharts'"));
  assert.ok(ipcSource.includes("'data-platform:retryChartSync'"));
  assert.ok(ipcSource.includes("'data-platform:getChartLibrary'"));
  assert.ok(ipcSource.includes("'data-platform:getChartSyncProgress'"));

  for (const preloadPath of PRELOAD_PATHS) {
    const preloadSource = readFileSync(preloadPath, 'utf8');
    assert.ok(preloadSource.includes("syncDataPlatformCharts: (): Promise<boolean> => ipcRenderer.invoke('data-platform:syncCharts')"));
    assert.ok(preloadSource.includes("retryDataPlatformChartSync: (): Promise<boolean> => ipcRenderer.invoke('data-platform:retryChartSync')"));
    assert.ok(preloadSource.includes("listDataPlatformCharts: (): Promise<DataPlatformChartLibrarySnapshot> => ipcRenderer.invoke('data-platform:getChartLibrary')"));
    assert.ok(preloadSource.includes("ipcRenderer.on('data-platform:chartSyncProgress', listener)"));
    assert.ok(preloadSource.includes("ipcRenderer.invoke('data-platform:getChartSyncProgress')"));
  }
});

test('应用退出时取消并等待在途图表同步任务', () => {
  const source = readFileSync(MAIN_PATH, 'utf8');

  assert.ok(source.includes("import { disposeDataPlatformChartSync } from './ipc/dataPlatformChartSync.js';"));
  assert.ok(source.includes('disposeDataPlatformChartSync()'));
});
