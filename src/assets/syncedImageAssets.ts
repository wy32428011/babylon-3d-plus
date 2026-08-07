import { createPlatformImageReference } from './imageAssets';

/**
 * 渲染进程侧的数据中台同步图片登记表，保存最近一次 listSyncedImages 的结果。
 * 拖拽载荷解码、纹理预览与运行时引用解析都通过该登记表校验和定位图片。
 */
let syncedImageAssets: SyncedImageAssetEntry[] = [];

/** 替换整份同步图片登记表，来源为 Electron 主进程的本地图片索引。 */
export function setSyncedImageAssets(assets: SyncedImageAssetEntry[]): void {
  syncedImageAssets = Array.isArray(assets) ? assets : [];
}

/** 返回当前同步图片登记表副本，供图片库面板组合展示。 */
export function getSyncedImageAssets(): SyncedImageAssetEntry[] {
  return syncedImageAssets;
}

/** 按稳定引用查找已登记同步图片，未登记时返回 null。 */
export function findSyncedImageAssetByReference(reference: string): SyncedImageAssetEntry | null {
  const normalizedReference = reference.trim();
  return syncedImageAssets.find((asset) => asset.reference === normalizedReference) ?? null;
}

/** 判断字符串是否已登记为可用同步图片引用。 */
export function isRegisteredSyncedImageReference(reference: string): boolean {
  return findSyncedImageAssetByReference(reference) !== null;
}

/** 解析同步图片引用的缩略图 / 纹理地址，未登记返回 null。 */
export function resolveSyncedImageSourceUrl(reference: string): string | null {
  return findSyncedImageAssetByReference(reference)?.sourceUrl ?? null;
}

/** 按图标 Key 生成同步图片稳定引用，格式错误会立即抛出。 */
export function createSyncedImageReference(iconKey: string): string {
  return createPlatformImageReference(iconKey);
}
