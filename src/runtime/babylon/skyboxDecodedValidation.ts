export const MAX_SKYBOX_DECODE_SOURCE_BYTES = 512 * 1024 * 1024;
export const MAX_SKYBOX_DECODE_FACE_SIZE = 1024;
export const MAX_SKYBOX_DECODE_SOURCE_PIXELS = 32 * 1024 * 1024;

/** 与导入天空盒文件限制和编辑器分辨率上限一致，主线程和 Worker 双重校验。 */
export function validateSkyboxDecodeInput(sourceBytes: number, faceSize: number): void {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 1 || sourceBytes > MAX_SKYBOX_DECODE_SOURCE_BYTES) {
    throw new RangeError('天空盒源文件大小无效或超过 512 MiB。');
  }
  if (!Number.isInteger(faceSize) || faceSize < 1 || faceSize > MAX_SKYBOX_DECODE_FACE_SIZE) {
    throw new RangeError('天空盒立方体面尺寸必须是 1 到 1024 的整数。');
  }
}

/** 读取文件头后、分配解码像素前限制尺寸，不能信任文件里声明的宽高。 */
export function validateSkyboxSourceDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MAX_SKYBOX_DECODE_SOURCE_PIXELS / height) {
    throw new RangeError('天空盒原始宽高必须是正整数，且总像素不能超过 32 Mi 像素。');
  }
}
