import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Plane } from '@babylonjs/core';
import type { Vector3Data } from '../../editor/model/math';


/**
 * 将局部 AABB 通过实例仿射矩阵视为平行六面体，并以中心/三个半轴投影做保守视锥测试。
 * 相比最大轴包围球，这对货架、轨道、输送线等长条几何显著减少假可见；
 * 非均匀缩放、旋转甚至剪切仍使用完整线性矩阵投影，不会误裁真实可见几何。
 */
export function isTransformedBoxInFrustum(
  localCenter: Vector3,
  localExtent: Vector3,
  worldMatrix: Matrix,
  frustumPlanes: Plane[],
  scratchCenter: Vector3,
): boolean {
  Vector3.TransformCoordinatesToRef(localCenter, worldMatrix, scratchCenter);
  const matrix = worldMatrix.m;
  for (const plane of frustumPlanes) {
    const normal = plane.normal;
    const projectedRadius = (
      localExtent.x * Math.abs(normal.x * matrix[0] + normal.y * matrix[1] + normal.z * matrix[2])
      + localExtent.y * Math.abs(normal.x * matrix[4] + normal.y * matrix[5] + normal.z * matrix[6])
      + localExtent.z * Math.abs(normal.x * matrix[8] + normal.y * matrix[9] + normal.z * matrix[10])
    );
    const signedDistance = Vector3.Dot(normal, scratchCenter) + plane.d;
    // 非有限矩阵继续保留实例，由后续 Babylon 渲染路径处理，绝不能因诊断优化误删几何。
    if (!Number.isFinite(projectedRadius) || !Number.isFinite(signedDistance)) return true;
    if (signedDistance < -projectedRadius) return false;
  }
  return true;
}

export function isFiniteVector3Data(value: Vector3Data): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

export function cloneBoundingInfo(bounds: BoundingInfo | null): BoundingInfo | null {
  if (!bounds) return null;
  return new BoundingInfo(
    bounds.boundingBox.minimumWorld.clone(),
    bounds.boundingBox.maximumWorld.clone(),
  );
}

export function calculateTransformedExtentToRef(localExtent: Vector3, worldMatrix: Matrix, result: Vector3): void {
  const matrix = worldMatrix.m;
  result.set(
    localExtent.x * Math.abs(matrix[0]) + localExtent.y * Math.abs(matrix[4]) + localExtent.z * Math.abs(matrix[8]),
    localExtent.x * Math.abs(matrix[1]) + localExtent.y * Math.abs(matrix[5]) + localExtent.z * Math.abs(matrix[9]),
    localExtent.x * Math.abs(matrix[2]) + localExtent.y * Math.abs(matrix[6]) + localExtent.z * Math.abs(matrix[10]),
  );
}