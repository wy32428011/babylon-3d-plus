import { normalizeDataPlatformScreenComponent } from '../model/dataPlatformScreen';
import type { DataPlatformChartAssetEntry } from './dataPlatformChartLibrary';

export const DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE = 'application/x-babylon-editor-data-platform-screen';

/** 仅接收具有实时页面地址的完整大屏，不把缩略图当作实时内容。 */
export function normalizeChartMarkerScreenSource(value: unknown): DataPlatformChartAssetEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.chartType !== 'SCREEN') return null;
  const screen = normalizeDataPlatformScreenComponent({ ...source, renderMode: 'iframe' });
  if (!screen) return null;
  const name = typeof source.name === 'string' ? source.name.trim().slice(0, 128) : '';
  return {
    id: typeof source.id === 'string' ? source.id.slice(0, 256) : `data-platform-screen:${screen.projectId}:${screen.screenId}`,
    chartType: 'SCREEN',
    projectId: screen.projectId,
    screenId: screen.screenId,
    name: name || '数据中台大屏',
    screenName: name || '数据中台大屏',
    screenUrl: screen.screenUrl,
    ...(screen.thumbnailUrl ? { thumbnailUrl: screen.thumbnailUrl } : {}),
  };
}

export function decodeDataPlatformScreenDragPayload(raw: string): DataPlatformChartAssetEntry | null {
  if (raw.length > 16_384) return null;
  try {
    return normalizeChartMarkerScreenSource(JSON.parse(raw));
  } catch {
    return null;
  }
}
