export const CHART_MARKER_SURFACE_CHANNEL = 'babylon-chart-marker-surface';
export const CHART_MARKER_SURFACE_VERSION = 1;
const MAX_DATA_URL_LENGTH = 4 * 1024 * 1024;

export type ChartMarkerSurfaceResponse = {
  channel: typeof CHART_MARKER_SURFACE_CHANNEL;
  version: 1;
  requestId: string;
} & ({ type: 'frame'; width: number; height: number; dataUrl: string } | { type: 'frame-error'; message: string });

/** 展开画面最多 2 MP；曲面分段共用此帧，不会重复加载或截取大屏。 */
export function getChartMarkerSurfaceSize(width: number, height: number): { width: number; height: number } {
  const w = Math.max(1, width * 4), h = Math.max(1, height * 4);
  const factor = Math.min(1, 2048 / w, 2048 / h, Math.sqrt(2097152 / (w * h)));
  return { width: Math.max(1, Math.floor(w * factor)), height: Math.max(1, Math.floor(h * factor)) };
}

export function createChartMarkerSurfaceUrl(screenUrl: string): string {
  const url = new URL(screenUrl);
  url.searchParams.set('zending3dSurface', '1');
  return url.href;
}

/** 来源由调用方核对；这里再拒绝过期响应、外部图片地址及无界分辨率。 */
export function parseChartMarkerSurfaceResponse(value: unknown, requestId: string): ChartMarkerSurfaceResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.channel !== CHART_MARKER_SURFACE_CHANNEL || data.version !== 1 || data.requestId !== requestId
    || !requestId || requestId.length > 128) return null;
  const keys = data.type === 'frame' ? ['channel', 'version', 'type', 'requestId', 'width', 'height', 'dataUrl']
    : ['channel', 'version', 'type', 'requestId', 'message'];
  if (Object.keys(data).length !== keys.length || Object.keys(data).some(key => !keys.includes(key))) return null;
  if (data.type === 'frame-error') return typeof data.message === 'string' && data.message.length <= 512 ? data as ChartMarkerSurfaceResponse : null;
  if (data.type !== 'frame' || !Number.isInteger(data.width) || !Number.isInteger(data.height)) return null;
  const width = data.width as number, height = data.height as number;
  if (width < 1 || height < 1 || width > 2048 || height > 2048 || width * height > 2097152) return null;
  if (typeof data.dataUrl !== 'string' || data.dataUrl.length > MAX_DATA_URL_LENGTH
    || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(data.dataUrl)) return null;
  return data as ChartMarkerSurfaceResponse;
}
