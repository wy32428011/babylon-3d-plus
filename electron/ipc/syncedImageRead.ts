import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SyncedImageAssetEntry, SyncedImageReadResult } from '../types.js';
import { resolveEditorAssetImageContentType } from './editorAssetCacheHeaders.js';

export const MAX_SYNCED_IMAGE_READ_BYTES = 20 * 1024 * 1024;

/** 只读取当前图片登记表中的文件，renderer 不能借此传入本地路径或远程 URL。 */
export async function readRegisteredSyncedImage(
  reference: unknown,
  registeredImages: readonly SyncedImageAssetEntry[],
): Promise<SyncedImageReadResult> {
  if (typeof reference !== 'string' || !/^editor-image:\/\/platform\/[a-z][a-z0-9_-]{1,63}$/.test(reference)) {
    throw new Error('同步图片引用格式不正确。');
  }
  const image = registeredImages.find((entry) => entry.reference === reference);
  if (!image) throw new Error('图片未登记在当前图片库中，请同步图片库后重试。');

  const contentType = resolveEditorAssetImageContentType(image.filePath);
  if (!contentType || !path.isAbsolute(image.filePath)) {
    throw new Error(`同步图片“${image.name}”的文件格式或登记路径不受支持。`);
  }

  const file = await fs.open(image.filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SYNCED_IMAGE_READ_BYTES) {
      throw new Error(`同步图片“${image.name}”必须为非空文件，且不能超过 20 MiB。`);
    }
    // 按登记文件实际体积分配上限，多读一个字节以发现同步替换或增长，避免无界 readFile。
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total !== stat.size) {
      throw new Error(`同步图片“${image.name}”在读取时发生变化，请重试。`);
    }
    return { bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, total), contentType };
  } finally {
    await file.close();
  }
}
