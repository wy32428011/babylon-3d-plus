import { TransformNode, Vector3, type AbstractMesh } from '@babylonjs/core';
import type { Vector3Data } from '../../editor/model/math';

export type ModelMeasurementStatus = 'loading' | 'ready' | 'unavailable';

export type ModelMeasurementResult =
  | { status: 'loading'; sizeMeters: null }
  | { status: 'unavailable'; sizeMeters: null }
  | { status: 'ready'; sizeMeters: Vector3Data };

const LOCAL_MODEL_AXES = [
  new Vector3(1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, 0, 1),
] as const;
const AXIS_LENGTH_EPSILON = 1e-12;

/** 判断单个模型网格是否应参与实际尺寸测量。 */
function isMeasurableModelMesh(mesh: AbstractMesh): boolean {
  return !mesh.isDisposed()
    && mesh.isEnabled(false)
    && mesh.isVisible
    && mesh.visibility > 0
    && mesh.getTotalVertices() > 0;
}

/** 读取实体根节点三个自身轴在世界空间中的单位方向。 */
function getNormalizedModelAxes(root: TransformNode): [Vector3, Vector3, Vector3] | null {
  root.computeWorldMatrix(true);
  const axes = LOCAL_MODEL_AXES.map((axis) => root.getDirection(axis));

  if (axes.some((axis) => !Number.isFinite(axis.lengthSquared()) || axis.lengthSquared() <= AXIS_LENGTH_EPSILON)) {
    return null;
  }

  return axes.map((axis) => axis.normalize()) as [Vector3, Vector3, Vector3];
}

/**
 * 按模型实体自身 X/Y/Z 轴测量内容根下的实际尺寸，单位为米。
 * 世界投影已经包含源单位换算、参数化脚本调整和用户 Transform.scale，平移与旋转不会改变轴向跨度。
 */
export function measureModelSizeMeters(root: TransformNode, contentRoot: TransformNode): Vector3Data | null {
  const axes = getNormalizedModelAxes(root);
  if (!axes) return null;

  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let measuredPointCount = 0;

  for (const mesh of contentRoot.getChildMeshes(false)) {
    if (!isMeasurableModelMesh(mesh)) continue;

    mesh.computeWorldMatrix(true);
    for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
      if (!Number.isFinite(corner.x) || !Number.isFinite(corner.y) || !Number.isFinite(corner.z)) continue;

      for (let axisIndex = 0; axisIndex < axes.length; axisIndex += 1) {
        const projection = Vector3.Dot(corner, axes[axisIndex]);
        if (!Number.isFinite(projection)) continue;
        minimum[axisIndex] = Math.min(minimum[axisIndex], projection);
        maximum[axisIndex] = Math.max(maximum[axisIndex], projection);
      }
      measuredPointCount += 1;
    }
  }

  if (measuredPointCount === 0 || minimum.some((value) => !Number.isFinite(value)) || maximum.some((value) => !Number.isFinite(value))) {
    return null;
  }

  return {
    x: Math.max(0, maximum[0] - minimum[0]),
    y: Math.max(0, maximum[1] - minimum[1]),
    z: Math.max(0, maximum[2] - minimum[2]),
  };
}
