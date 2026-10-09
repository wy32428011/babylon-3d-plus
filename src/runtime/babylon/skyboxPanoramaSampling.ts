import type { CubeMapInfo } from '@babylonjs/core/Misc/HighDynamicRange/panoramaToCubemap';
import { validateSkyboxDecodeInput, validateSkyboxSourceDimensions } from './skyboxDecodedValidation.ts';

// 保留 Babylon 六面的角点、步进和方向，避免旧场景旋转或上下翻转。
const FACE_AXES = {
  front: [[1, -1, -1], [0, 0, 2], [0, 2, 0]],
  back: [[-1, -1, 1], [0, 0, -2], [0, 2, 0]],
  left: [[-1, -1, -1], [2, 0, 0], [0, 2, 0]],
  right: [[1, -1, 1], [-2, 0, 0], [0, 2, 0]],
  up: [[-1, -1, -1], [0, 0, 2], [2, 0, 0]],
  down: [[1, 1, -1], [0, 0, 2], [-2, 0, 0]],
} as const;

/** 在线性 RGB 中插值；经度循环、纬度钳制，消除小全景升采样的最近邻方块。 */
export function convertSkyboxPanoramaToCubemap(
  data: Float32Array, width: number, height: number, size: number, invertY: boolean,
): CubeMapInfo {
  validateSkyboxSourceDimensions(width, height);
  validateSkyboxDecodeInput(data.byteLength, size);
  const stride = data.length / (width * height);
  if (stride !== 3 && stride !== 4) throw new RangeError('天空盒全景必须是完整的 RGB 或 RGBA 浮点像素。');
  const faces = {} as Record<keyof typeof FACE_AXES, Float32Array>;
  for (const face of Object.keys(FACE_AXES) as (keyof typeof FACE_AXES)[]) {
    const [origin, axisX, axisY] = FACE_AXES[face];
    const output = new Float32Array(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const vx = origin[0] + axisX[0] * x / size + axisY[0] * y / size;
        const vy = origin[1] + axisX[1] * x / size + axisY[1] * y / size;
        const vz = origin[2] + axisX[2] * x / size + axisY[2] * y / size;
        const longitude = (Math.atan2(vz, vx) / (2 * Math.PI) + 0.5) * width;
        const latitude = Math.acos(Math.max(-1, Math.min(1, vy / Math.hypot(vx, vy, vz)))) / Math.PI * height;
        const sourceY = Math.max(0, Math.min(height - 1, invertY ? height - 1 - latitude : latitude));
        const floorX = Math.floor(longitude);
        const x0 = ((floorX % width) + width) % width;
        const x1 = (x0 + 1) % width;
        const y0 = Math.floor(sourceY);
        const y1 = Math.min(y0 + 1, height - 1);
        const fx = longitude - floorX;
        const fy = sourceY - y0;
        const top0 = (y0 * width + x0) * stride;
        const top1 = (y0 * width + x1) * stride;
        const bottom0 = (y1 * width + x0) * stride;
        const bottom1 = (y1 * width + x1) * stride;
        const destination = (y * size + x) * 3;
        for (let channel = 0; channel < 3; channel++) {
          const top = data[top0 + channel] * (1 - fx) + data[top1 + channel] * fx;
          const bottom = data[bottom0 + channel] * (1 - fx) + data[bottom1 + channel] * fx;
          output[destination + channel] = top * (1 - fy) + bottom * fy;
        }
      }
    }
    faces[face] = output;
  }
  return { ...faces, size, type: 1, format: 4, gammaSpace: false };
}
