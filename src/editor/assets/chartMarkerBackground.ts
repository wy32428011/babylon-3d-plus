import { decodeImageAssetDragPayload } from './AssetDatabase';

export const CHART_MARKER_BACKGROUND_MAX_BYTES = 2 * 1024 * 1024;
export const CHART_MARKER_BACKGROUND_RASTER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const LIBRARY_IMAGE_TYPES = [...CHART_MARKER_BACKGROUND_RASTER_TYPES, 'image/gif', 'image/svg+xml'];

/** 从已登记的图片库资源读取背景，不接受拖拽载荷中的任意外部地址。 */
export async function loadChartMarkerLibraryBackground(payload: string, signal: AbortSignal): Promise<Blob> {
  const asset = decodeImageAssetDragPayload(payload);
  if (!asset) throw new Error('请从编辑器图片库拖入有效图片。');
  const response = await fetch(asset.sourceUrl, { signal });
  if (!response.ok) throw new Error(`背景图片读取失败（${response.status}），请检查图片库资源是否可用。`);
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (!LIBRARY_IMAGE_TYPES.includes(type)) throw new Error('背景图片格式不受支持，请使用 PNG、JPEG、WebP、GIF 或 SVG。');
  const maxBytes = CHART_MARKER_BACKGROUND_MAX_BYTES;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('背景图片不能超过 2 MB。');
  }
  if (!response.body) throw new Error('背景图片内容为空。');
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error('背景图片不能超过 2 MB。');
      }
      chunks.push(new Uint8Array(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!bytes) throw new Error('背景图片内容为空。');
  return new Blob(chunks, { type });
}
