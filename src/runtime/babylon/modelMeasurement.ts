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
export function isMeasurableModelMesh(mesh: AbstractMesh): boolean {
  return !mesh.isDisposed()
    && mesh.isEnabled(false)
    && mesh.isVisible
    && mesh.visibility > 0
    && mesh.getTotalVertices() > 0;
}

/**
 * 判断显式实体网格是否可用于阵列投影测量。
 * POI 粒子范围代理虽然不直接渲染，但必须参与效果占用范围计算。
 */
export function isMeasurableEntityArrayMesh(mesh: AbstractMesh): boolean {
  const metadata = mesh.metadata as Record<string, unknown> | null | undefined;
  const isEffectBoundsProxy = metadata?.effectBoundsProxy === true;

  return !mesh.isDisposed()
    && mesh.isEnabled(false)
    && mesh.isVisible
    && (mesh.visibility > 0 || isEffectBoundsProxy)
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

/** 将外部世界方向归一化，拒绝 NaN、Infinity 和零向量。 */
function normalizeWorldAxis(direction: Vector3Data): Vector3 | null {
  const axis = new Vector3(direction.x, direction.y, direction.z);
  const lengthSquared = axis.lengthSquared();
  if (!Number.isFinite(lengthSquared) || lengthSquared <= AXIS_LENGTH_EPSILON) return null;
  return axis.normalize();
}

/** 按一组世界坐标单位轴测量显式 Mesh 集合的投影跨度。 */
function measureMeshSpansAlongAxes(
  meshes: readonly AbstractMesh[],
  axes: readonly Vector3[],
  isMeasurable: (mesh: AbstractMesh) => boolean,
): number[] | null {
  const minimum = axes.map(() => Number.POSITIVE_INFINITY);
  const maximum = axes.map(() => Number.NEGATIVE_INFINITY);
  let measuredPointCount = 0;

  for (const mesh of meshes) {
    if (!isMeasurable(mesh)) continue;

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

  if (
    measuredPointCount === 0
    || minimum.some((value) => !Number.isFinite(value))
    || maximum.some((value) => !Number.isFinite(value))
  ) {
    return null;
  }

  return minimum.map((value, index) => Math.max(0, maximum[index] - value));
}

/** 按一组世界坐标单位轴测量模型可见几何的投影跨度。 */
function measureModelSpansAlongAxes(contentRoot: TransformNode, axes: readonly Vector3[]): number[] | null {
  return measureMeshSpansAlongAxes(contentRoot.getChildMeshes(false), axes, isMeasurableModelMesh);
}

/**
 * 按模型实体自身 X/Y/Z 轴测量内容根下的实际尺寸，单位为米。
 * 世界投影已经包含源单位换算、参数化脚本调整和用户 Transform.scale，平移与旋转不会改变轴向跨度。
 */
export function measureModelSizeMeters(root: TransformNode, contentRoot: TransformNode): Vector3Data | null {
  const axes = getNormalizedModelAxes(root);
  if (!axes) return null;

  const spans = measureModelSpansAlongAxes(contentRoot, axes);
  if (!spans) return null;

  return { x: spans[0], y: spans[1], z: spans[2] };
}

/** 测量模型有效可见几何沿任意世界方向的投影跨度，供局部/世界轴阵列使用。 */
export function measureModelSpanMetersAlongWorldDirection(
  contentRoot: TransformNode,
  worldDirection: Vector3Data,
): number | null {
  const axis = normalizeWorldAxis(worldDirection);
  if (!axis) return null;

  return measureModelSpansAlongAxes(contentRoot, [axis])?.[0] ?? null;
}

/** 测量显式实体 Mesh 集合沿任意世界方向的投影跨度，供通用 Shift 阵列使用。 */
export function measureEntityMeshesSpanMetersAlongWorldDirection(
  meshes: readonly AbstractMesh[],
  worldDirection: Vector3Data,
): number | null {
  const axis = normalizeWorldAxis(worldDirection);
  if (!axis) return null;

  return measureMeshSpansAlongAxes(meshes, [axis], isMeasurableEntityArrayMesh)?.[0] ?? null;
}
