import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PROJECT_PANEL_PATH = 'src/editor/panels/ProjectPanel.tsx';

test('图表库只展示当前绑定项目大屏并支持名称和编码筛选', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');

  assert.ok(source.includes("from '../assets/dataPlatformChartLibrary'"));
  assert.ok(source.includes("if (activeLibrary.key === 'chart')"));
  assert.ok(source.includes('createDataPlatformChartLibraryItems(syncedCharts)'));
  assert.ok(source.includes('matchesDataPlatformChartLibrarySearch(item, normalizedLibraryFilter)'));
  assert.ok(source.includes('当前工程未绑定数据中台项目'));
  assert.ok(source.includes('当前绑定项目暂无可同步的大屏'));
});

test('图表同步 API、手动同步和失败重试均受当前绑定上下文约束', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');

  assert.ok(source.includes('listDataPlatformCharts?: () => Promise<DataPlatformChartLibrarySnapshot>'));
  assert.ok(source.includes('syncDataPlatformCharts?: () => Promise<boolean>'));
  assert.ok(source.includes('retryDataPlatformChartSync?: () => Promise<boolean>'));
  assert.ok(source.includes('onDataPlatformChartSyncProgress?:'));
  assert.ok(source.includes('disabled={props.readOnly || !chartSyncContextKey'));
  assert.ok(source.includes('同步数据中台大屏'));
  assert.ok(source.includes('重试大屏同步'));
});

test('绑定项目加载后自动同步图表，未绑定时不触发同步请求', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');

  assert.ok(source.includes('if (!expectedContextKey) return'));
  assert.ok(source.includes('autoChartSyncContextKeyRef.current === expectedContextKey'));
  assert.ok(source.includes('void api.syncDataPlatformCharts()'));
});

test('场景切换清空旧图表且迟到结果和进度不能覆盖新项目', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');

  assert.ok(source.includes('chartLibraryLoadRequestRef.current += 1'));
  assert.ok(source.includes('setSyncedCharts([])'));
  assert.ok(source.includes('sceneSessionIdRef.current !== expectedSceneSessionId'));
  assert.ok(source.includes('chartSyncContextKeyRef.current !== expectedContextKey'));
  assert.ok(source.includes('progress.contextKey !== chartSyncContextKeyRef.current'));
});

test('同步图表卡片保持只读，不进入点击或拖拽创建链路', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');

  assert.ok(source.includes('const isSyncedChart = isDataPlatformChartLibraryItem(item)'));
  assert.ok(source.includes('if (isDataPlatformChartLibraryItem(item)) return;'));
  assert.ok(source.includes('if (isDataPlatformChartLibraryItem(item)) {'));
  assert.ok(source.includes('const isActionableItem = !isSyncedChart'));
  assert.ok(source.includes('同步自数据中台的大屏'));
  assert.equal(source.includes("item.syncedChart.chartType === 'SCREEN'"), false);
});
