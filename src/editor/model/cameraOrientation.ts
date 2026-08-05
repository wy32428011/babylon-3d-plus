import type { StandardSceneCameraOrientation } from './SceneDocument';

/** ArcRotateCamera 在上下极点附近保留的微小偏角，避免 up 向量退化。 */
export const STANDARD_CAMERA_VIEW_POLE_EPSILON = 0.01;

export type CameraOrbitAngles = {
  alpha: number;
  beta: number;
};

export type StandardCameraViewLabel = {
  face: string;
  english: string;
  chinese: string;
};

const STANDARD_CAMERA_VIEW_ANGLES: Record<StandardSceneCameraOrientation, CameraOrbitAngles> = {
  top: { alpha: -Math.PI / 2, beta: STANDARD_CAMERA_VIEW_POLE_EPSILON },
  bottom: { alpha: Math.PI / 2, beta: Math.PI - STANDARD_CAMERA_VIEW_POLE_EPSILON },
  front: { alpha: -Math.PI / 2, beta: Math.PI / 2 },
  back: { alpha: Math.PI / 2, beta: Math.PI / 2 },
  right: { alpha: 0, beta: Math.PI / 2 },
  left: { alpha: Math.PI, beta: Math.PI / 2 },
};

export const STANDARD_CAMERA_VIEW_LABELS: Record<StandardSceneCameraOrientation, StandardCameraViewLabel> = {
  top: { face: '顶', english: 'Top', chinese: '顶面视角' },
  bottom: { face: '底', english: 'Bottom', chinese: '底面视角' },
  front: { face: '前', english: 'Front', chinese: '前面视角' },
  back: { face: '后', english: 'Back', chinese: '后面视角' },
  right: { face: '右', english: 'Right', chinese: '右面视角' },
  left: { face: '左', english: 'Left', chinese: '左面视角' },
};

/** 返回六个标准面的稳定 ArcRotateCamera 角度。 */
export function getStandardCameraViewAngles(orientation: StandardSceneCameraOrientation): CameraOrbitAngles {
  return STANDARD_CAMERA_VIEW_ANGLES[orientation];
}

/** 把 alpha 差值归一化到 [-PI, PI]，确保视角动画不绕远路。 */
export function getShortestCameraAlphaDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export type CompassAxisOffset = { x: number; y: number };

/** 深度轴投影接近中心时沿固定方向分离正负端点，避免两个点击目标完全重叠。 */
export function resolveCompassAxisOffset(
  projectedX: number,
  projectedY: number,
  depth: number,
  fallback: readonly [number, number],
  axisRadius: number,
  fallbackRadius: number,
): CompassAxisOffset {
  let x = projectedX * axisRadius;
  let y = projectedY * axisRadius;
  if (Math.hypot(x, y) >= fallbackRadius) return { x, y };

  const depthDirection = depth < 0 ? 1 : -1;
  const fallbackX = fallback[0] * fallbackRadius * depthDirection;
  const fallbackY = fallback[1] * fallbackRadius * depthDirection;
  const blend = 1 - Math.hypot(x, y) / fallbackRadius;
  x += (fallbackX - x) * blend;
  y += (fallbackY - y) * blend;
  return { x, y };
}

/** 返回标准面的双语名称，供 Toolbar、罗盘和日志共享。 */
export function getStandardCameraViewAccessibleLabel(orientation: StandardSceneCameraOrientation): string {
  const label = STANDARD_CAMERA_VIEW_LABELS[orientation];
  return `${label.english} / ${label.chinese}`;
}
