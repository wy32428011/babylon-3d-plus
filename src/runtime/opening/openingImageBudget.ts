const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_SESSION_PIXELS = 64_000_000;

/** 压缩文件很小也可能解码成大图；限制每次播放保留的图片总像素。 */
export class OpeningImageBudget {
  private pixels = 0;

  accept(width: number, height: number, label: string): void {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`开场图片 ${label} 的尺寸无效。`);
    }
    const pixels = width * height;
    if (pixels > MAX_IMAGE_PIXELS) throw new Error(`开场图片 ${label} 超过单图 3200 万像素限制。`);
    if (this.pixels + pixels > MAX_SESSION_PIXELS) throw new Error(`开场图片 ${label} 导致本次播放超过累计 6400 万像素预算。`);
    this.pixels += pixels;
  }
}
