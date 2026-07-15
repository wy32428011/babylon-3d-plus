import type { Vector3Data } from '../../editor/model/math';

/** 环境模型右边界与世界原点之间保留的固定安全间距。 */
export const ENVIRONMENT_ORIGIN_LEFT_GAP_METERS = 2;

/** 环境模型没有有效几何包围盒时使用的负 X 回退位置。 */
export const ENVIRONMENT_FALLBACK_LEFT_OFFSET_METERS = 10;

/** 判断三维坐标是否全部为有限数值。 */
function isFiniteVector3Data(vector: Vector3Data): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

/**
 * 根据环境模型世界包围盒计算根节点偏移。
 * 结果会把模型右边界放到 X=-2m、底部放到 Y=0，并让 Z 方向中心对齐世界原点。
 */
export function calculateEnvironmentOriginLeftOffset(
  minimum: Vector3Data,
  maximum: Vector3Data,
): Vector3Data | null {
  if (!isFiniteVector3Data(minimum) || !isFiniteVector3Data(maximum)) return null;
  if (maximum.x < minimum.x || maximum.y < minimum.y || maximum.z < minimum.z) return null;

  return {
    x: -ENVIRONMENT_ORIGIN_LEFT_GAP_METERS - maximum.x,
    y: -minimum.y,
    z: -(minimum.z + maximum.z) / 2,
  };
}
