import type { Vector3Data } from './math';

export type GroupWorldBoundsSnapshot = {
  center: Vector3Data;
  sizeMeters: Vector3Data;
  geometryReady: boolean;
  requestedEntityCount: number;
  resolvedEntityCount: number;
  geometryReadyEntityCount: number;
};

export type GroupSpatialInfoResult =
  | {
    status: 'loading' | 'unavailable';
    memberCount: number;
    center: null;
    sizeMeters: null;
  }
  | {
    status: 'ready';
    memberCount: number;
    center: Vector3Data;
    sizeMeters: Vector3Data;
  };

/** 仅在全部群组成员的有限世界包围盒就绪后，向 Inspector 暴露空间信息。 */
export function createGroupSpatialInfo(
  entityIds: readonly string[],
  bounds: GroupWorldBoundsSnapshot | null,
): GroupSpatialInfoResult {
  const memberCount = new Set(entityIds.filter(Boolean)).size;
  if (memberCount === 0) {
    return { status: 'unavailable', memberCount, center: null, sizeMeters: null };
  }

  if (
    !bounds
    || !bounds.geometryReady
    || bounds.requestedEntityCount !== memberCount
    || bounds.resolvedEntityCount !== memberCount
    || bounds.geometryReadyEntityCount !== memberCount
    || !isFiniteVector(bounds.center)
    || !isFiniteVector(bounds.sizeMeters)
  ) {
    return { status: 'loading', memberCount, center: null, sizeMeters: null };
  }

  return {
    status: 'ready',
    memberCount,
    center: { ...bounds.center },
    sizeMeters: {
      x: Math.max(0, bounds.sizeMeters.x),
      y: Math.max(0, bounds.sizeMeters.y),
      z: Math.max(0, bounds.sizeMeters.z),
    },
  };
}

/** 把 Inspector 中的群组中心绝对坐标转换为现有平移事务使用的单轴 delta。 */
export function createGroupPositionDelta(
  currentCenter: Vector3Data,
  axis: keyof Vector3Data,
  targetValue: number,
): Vector3Data | null {
  if (!isFiniteVector(currentCenter) || !Number.isFinite(targetValue)) return null;

  return {
    x: axis === 'x' ? targetValue - currentCenter.x : 0,
    y: axis === 'y' ? targetValue - currentCenter.y : 0,
    z: axis === 'z' ? targetValue - currentCenter.z : 0,
  };
}

function isFiniteVector(value: Vector3Data): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}
