import { Vector3, type Matrix, type Ray, type TransformNode } from '@babylonjs/core';
import { isMeasurableModelMesh } from './modelMeasurement';

const MATRIX_DETERMINANT_EPSILON = 1e-12;
const PARALLEL_DIRECTION_EPSILON = 1e-12;

type ModelLocalPickBounds = {
  minimum: Vector3;
  maximum: Vector3;
};

/**
 * 读取模型当前可见几何在实体根局部空间中的紧包围盒。
 * 范围实时包含参数脚本生成的 clone / thin instance，但不增加任何外扩 padding。
 */
function getModelLocalPickBounds(
  contentRoot: TransformNode,
  inverseRootWorld: Matrix,
): ModelLocalPickBounds | null {
  const minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  const worldCorner = Vector3.Zero();
  const rootLocalCorner = Vector3.Zero();
  let cornerCount = 0;

  for (const mesh of contentRoot.getChildMeshes(false)) {
    if (!isMeasurableModelMesh(mesh) || !mesh.isEnabled()) continue;

    mesh.computeWorldMatrix(true);
    const meshWorld = mesh.getWorldMatrix();
    for (const corner of mesh.getBoundingInfo().boundingBox.vectors) {
      Vector3.TransformCoordinatesToRef(corner, meshWorld, worldCorner);
      Vector3.TransformCoordinatesToRef(worldCorner, inverseRootWorld, rootLocalCorner);
      if (!isFiniteVector(rootLocalCorner)) continue;

      minimum.minimizeInPlace(rootLocalCorner);
      maximum.maximizeInPlace(rootLocalCorner);
      cornerCount += 1;
    }
  }

  return cornerCount > 0 && isFiniteVector(minimum) && isFiniteVector(maximum)
    ? { minimum, maximum }
    : null;
}

/**
 * 使用世界射线与模型根局部有向包围盒求交。
 * 返回值沿原世界射线计量，可在多个模型之间直接比较最近距离。
 */
export function intersectWorldRayWithModelDisplayBounds(
  ray: Ray,
  root: TransformNode,
  contentRoot: TransformNode,
): number | null {
  if (!isFiniteVector(ray.origin) || !isFiniteVector(ray.direction)) return null;

  root.computeWorldMatrix(true);
  const inverseRootWorld = root.getWorldMatrix().clone();
  const determinant = inverseRootWorld.determinant();
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= MATRIX_DETERMINANT_EPSILON) return null;
  inverseRootWorld.invert();

  const bounds = getModelLocalPickBounds(contentRoot, inverseRootWorld);
  if (!bounds) return null;

  const localOrigin = Vector3.TransformCoordinates(ray.origin, inverseRootWorld);
  // 不归一化局部方向：这样 slab 参数仍等于原世界射线距离，非均匀缩放下也可正确排序。
  const localDirection = Vector3.TransformNormal(ray.direction, inverseRootWorld);
  if (!isFiniteVector(localOrigin) || !isFiniteVector(localDirection)) return null;

  return intersectRayWithAxisAlignedBounds(
    localOrigin,
    localDirection,
    bounds.minimum,
    bounds.maximum,
    ray.length,
  );
}

/** 标准 slab 求交，不增加阈值，确保拾取范围不会超出模型当前显示边界。 */
function intersectRayWithAxisAlignedBounds(
  origin: Vector3,
  direction: Vector3,
  minimum: Vector3,
  maximum: Vector3,
  rayLength: number,
): number | null {
  let nearDistance = 0;
  let farDistance = Number.isFinite(rayLength) ? Math.max(0, rayLength) : Number.MAX_VALUE;

  for (const axis of ['x', 'y', 'z'] as const) {
    const axisOrigin = origin[axis];
    const axisDirection = direction[axis];
    const axisMinimum = minimum[axis];
    const axisMaximum = maximum[axis];

    if (Math.abs(axisDirection) <= PARALLEL_DIRECTION_EPSILON) {
      if (axisOrigin < axisMinimum || axisOrigin > axisMaximum) return null;
      continue;
    }

    let firstDistance = (axisMinimum - axisOrigin) / axisDirection;
    let secondDistance = (axisMaximum - axisOrigin) / axisDirection;
    if (firstDistance > secondDistance) {
      [firstDistance, secondDistance] = [secondDistance, firstDistance];
    }

    nearDistance = Math.max(nearDistance, firstDistance);
    farDistance = Math.min(farDistance, secondDistance);
    if (nearDistance > farDistance) return null;
  }

  return farDistance >= 0 ? nearDistance : null;
}

function isFiniteVector(vector: Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}
