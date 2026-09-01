export type DataPlatformChartType = 'SCREEN';

export type DataPlatformChartAssetEntry = {
  id: string;
  projectId: string;
  screenId: string;
  screenName: string;
  screenCode?: string;
  name: string;
  chartType: DataPlatformChartType;
};

export type DataPlatformChartLibraryItem = {
  id: string;
  name: string;
  icon: string;
  subtitle: string;
  syncedChart: DataPlatformChartAssetEntry;
};

/** 将绑定项目的完整大屏转成数字孪生图表库卡片。 */
export function createDataPlatformChartLibraryItems(
  charts: readonly DataPlatformChartAssetEntry[],
): DataPlatformChartLibraryItem[] {
  return charts
    .filter((chart) => chart.chartType === 'SCREEN')
    .map((chart) => ({
      id: chart.id,
      name: chart.name,
      icon: 'panel',
      subtitle: `大屏 · ${chart.screenCode ?? '已绑定项目'}`,
      syncedChart: chart,
    }));
}

/** 判断资源卡片是否来自绑定项目的大屏图表。 */
export function isDataPlatformChartLibraryItem(value: unknown): value is DataPlatformChartLibraryItem {
  return Boolean(value && typeof value === 'object' && 'syncedChart' in value);
}

/** 图表库搜索覆盖大屏名称、编码和资源类型。 */
export function matchesDataPlatformChartLibrarySearch(
  item: DataPlatformChartLibraryItem,
  normalizedQuery: string,
): boolean {
  const query = normalizedQuery.trim().toLowerCase();
  if (!query) return true;
  return [
    item.name,
    item.syncedChart.screenName,
    item.syncedChart.screenCode,
    '大屏',
    item.syncedChart.chartType,
  ].some((value) => value?.toLowerCase().includes(query));
}
