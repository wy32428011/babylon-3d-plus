import path from 'node:path';

export const MAX_THUMBNAIL_FILE_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MIME_EXTENSIONS = new Map([
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'], ['image/gif', '.gif'],
]);

/** 文件接口的 URL 可能没有扩展名，此时按下载响应的图片类型命名。 */
export function getDataPlatformThumbnailExtension(remoteUrl: string, contentType = ''): string | null {
  const mimeType = contentType.split(';', 1)[0].trim().toLowerCase();
  const mimeExtension = MIME_EXTENSIONS.get(mimeType) ?? null;
  if (mimeType && mimeType !== 'application/octet-stream' && !mimeExtension) return null;
  try {
    const extension = path.extname(new URL(remoteUrl, 'http://placeholder.invalid/').pathname).toLowerCase();
    return EXTENSIONS.has(extension) ? extension : mimeExtension;
  } catch {
    return mimeExtension;
  }
}
