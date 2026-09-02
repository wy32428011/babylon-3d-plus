import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDataPlatformChartLibraryItems,
  isDataPlatformChartLibraryItem,
  matchesDataPlatformChartLibrarySearch,
  type DataPlatformChartAssetEntry,
} from '../../src/editor/assets/dataPlatformChartLibrary.ts';

const charts = [
  {
    id: 'data-platform-screen:100:200',
    projectId: '100',
    screenId: '200',
    screenName: '设备总览',
    screenCode: 'SCREEN-OVERVIEW',
    screenUrl: 'http://127.0.0.1:8086/#/bigscreen-designer/published/200',
    thumbnailUrl: 'http://127.0.0.1:8086/api/v1/files/300/content',
    name: '设备总览',
    chartType: 'SCREEN',
  },
  {
    id: 'data-platform-chart:100:200:line-main',
    projectId: '100',
    screenId: '200',
    screenName: '设备总览',
    widgetId: 'line-main',
    name: '产量趋势',
    chartType: 'LINE_CHART',
    pageKey: 'overview',
  },
  {
    id: 'data-platform-chart:100:200:bar-main',
    projectId: '100',
    screenId: '200',
    screenName: '设备总览',
    widgetId: 'bar-main',
    name: '设备排行',
    chartType: 'BAR_CHART',
  },
  {
    id: 'data-platform-chart:100:201:pie-main',
    projectId: '100',
    screenId: '201',
    screenName: '能源总览',
    widgetId: 'pie-main',
    name: '能源占比',
    chartType: 'PIE_CHART',
  },
] as unknown as DataPlatformChartAssetEntry[];

test('图表库只把完整大屏转换为资源卡片，并忽略旧内部图表', () => {
  const items = createDataPlatformChartLibraryItems(charts);

  assert.deepEqual(items.map((item) => ({
    id: item.id,
    name: item.name,
    icon: item.icon,
    subtitle: item.subtitle,
    thumbnailUrl: item.thumbnailUrl,
  })), [{
    id: charts[0]?.id,
    name: '设备总览',
    icon: 'panel',
    subtitle: '大屏 · SCREEN-OVERVIEW',
    thumbnailUrl: 'http://127.0.0.1:8086/api/v1/files/300/content',
  }]);
  assert.ok(items.every(isDataPlatformChartLibraryItem));
});

test('图表库搜索只匹配大屏名称、编码和资源类型', () => {
  const [screenItem] = createDataPlatformChartLibraryItems(charts);
  assert.ok(screenItem);

  assert.equal(matchesDataPlatformChartLibrarySearch(screenItem, '大屏'), true);
  assert.equal(matchesDataPlatformChartLibrarySearch(screenItem, 'screen-overview'), true);
  assert.equal(matchesDataPlatformChartLibrarySearch(screenItem, '设备总览'), true);
  assert.equal(matchesDataPlatformChartLibrarySearch(screenItem, '折线图'), false);
});
