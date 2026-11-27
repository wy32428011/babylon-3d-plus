import type { ManualRoamCollisionBounds, ManualRoamPoint } from './manualRoamCollisionBounds.ts';

export const DEFAULT_COLLISION_SUBSTEP_RATIO = 0.45;
export const DEFAULT_MAX_COLLISION_SUBSTEPS = 8;
export const DEFAULT_DEPENETRATION_CLEARANCE_METERS = 0.02;
export const DEFAULT_DEPENETRATION_PENETRATION_EPSILON = 0.005;
export const DEFAULT_MAX_DEPENETRATION_ITERATIONS = 4;

export type CapsuleAabbDepenetrationOptions = {
  position: Readonly<ManualRoamPoint>;
  capsuleRadius: number;
  capsuleHeight: number;
  bounds: readonly ManualRoamCollisionBounds[];
  stepHeight?: number;
  allowVerticalExit?: boolean;
  clearanceMeters?: number;
  penetrationEpsilonMeters?: number;
  maxIterations?: number;
};

export type CapsuleAabbDepenetrationResult = {
  position: ManualRoamPoint;
  resolved: boolean;
  overlappingIds: string[];
};

/** 按胶囊半径切分单步位移，避免高速或低帧率时一步跨过薄墙。 */
export function computeCollisionSubstepCount(
  displacement: Readonly<ManualRoamPoint>,
  capsuleRadius: number,
  maxSubsteps = DEFAULT_MAX_COLLISION_SUBSTEPS,
): number {
  const limit = Number.isFinite(maxSubsteps) && maxSubsteps >= 1 ? Math.floor(maxSubsteps) : 1;
  if (!isFinitePoint(displacement) || !Number.isFinite(capsuleRadius) || capsuleRadius <= 1e-4) {
    return 1;
  }
  const distance = Math.hypot(displacement.x, displacement.y, displacement.z);
  if (!Number.isFinite(distance) || distance <= 1e-6) return 1;
  const maxStepDistance = capsuleRadius * DEFAULT_COLLISION_SUBSTEP_RATIO;
  if (maxStepDistance <= 1e-6) return 1;
  return Math.min(limit, Math.max(1, Math.ceil(distance / maxStepDistance)));
}

/** 查找在胶囊碰撞椭球内发生真实穿插的 AABB 列表（按穿插深度由深到浅排序）。 */
export function findOverlappingAabbBounds(
  position: Readonly<ManualRoamPoint>,
  capsuleRadius: number,
  capsuleHeight: number,
  bounds: readonly ManualRoamCollisionBounds[],
  penetrationEpsilonMeters = DEFAULT_DEPENETRATION_PENETRATION_EPSILON,
): ManualRoamCollisionBounds[] {
  if (
    !isFinitePoint(position)
    || !Number.isFinite(capsuleRadius)
    || capsuleRadius <= 1e-4
    || !Number.isFinite(capsuleHeight)
    || capsuleHeight <= 1e-4
  ) {
    return [];
  }
  const thresholdSquared = computePenetrationThresholdSquared(capsuleRadius, penetrationEpsilonMeters);
  const overlapping: Array<{ bound: ManualRoamCollisionBounds; distanceSquared: number }> = [];
  for (const bound of bounds) {
    const distanceSquared = computeNormalizedEllipsoidAabbDistanceSquared(
      position,
      capsuleRadius,
      capsuleHeight,
      bound,
    );
    if (distanceSquared < thresholdSquared) {
      overlapping.push({ bound, distanceSquared });
    }
  }
  overlapping.sort((left, right) => left.distanceSquared - right.distanceSquared);
  return overlapping.map((entry) => entry.bound);
}

/** 计算将嵌入 AABB 代理盒内的胶囊体推离至外部的安全位置。 */
export function resolveCapsuleAabbDepenetration(
  options: CapsuleAabbDepenetrationOptions,
): CapsuleAabbDepenetrationResult {
  const {
    position,
    capsuleRadius,
    capsuleHeight,
    bounds,
    stepHeight = 0.22,
    allowVerticalExit = false,
    clearanceMeters = DEFAULT_DEPENETRATION_CLEARANCE_METERS,
    penetrationEpsilonMeters = DEFAULT_DEPENETRATION_PENETRATION_EPSILON,
    maxIterations = DEFAULT_MAX_DEPENETRATION_ITERATIONS,
  } = options;

  const current: ManualRoamPoint = { x: position.x, y: position.y, z: position.z };
  if (
    !isFinitePoint(current)
    || !Number.isFinite(capsuleRadius)
    || capsuleRadius <= 1e-4
    || !Number.isFinite(capsuleHeight)
    || capsuleHeight <= 1e-4
    || bounds.length === 0
  ) {
    return { position: current, resolved: true, overlappingIds: [] };
  }

  const clearance = Number.isFinite(clearanceMeters) && clearanceMeters >= 0
    ? clearanceMeters
    : DEFAULT_DEPENETRATION_CLEARANCE_METERS;
  const iterations = Number.isFinite(maxIterations) && maxIterations >= 1
    ? Math.floor(maxIterations)
    : DEFAULT_MAX_DEPENETRATION_ITERATIONS;
  const safeStepHeight = Number.isFinite(stepHeight) && stepHeight >= 0 ? stepHeight : 0.22;
  const thresholdSquared = computePenetrationThresholdSquared(capsuleRadius, penetrationEpsilonMeters);
  const halfHeight = capsuleHeight / 2;
  const overlappingIdSet = new Set<string>();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const deepest = findDeepestOverlappingBound(
      current,
      capsuleRadius,
      capsuleHeight,
      bounds,
      thresholdSquared,
    );
    if (!deepest) break;
    overlappingIdSet.add(deepest.id);

    const horizontalExit = computeHorizontalExit(current, capsuleRadius, deepest, clearance);
    const upDist = deepest.maximum.y - current.y + clearance;
    const canExitUp = upDist >= 0
      && (allowVerticalExit || upDist <= safeStepHeight + 0.06)
      && upDist < horizontalExit.distance;
    const downDist = current.y + capsuleHeight - deepest.minimum.y + clearance;
    const canExitDown = allowVerticalExit
      && downDist >= 0
      && downDist < horizontalExit.distance
      && (!canExitUp || downDist < upDist);

    if (canExitDown) {
      current.y = deepest.minimum.y - capsuleHeight - clearance;
    } else if (canExitUp) {
      current.y = deepest.maximum.y + clearance;
    } else {
      current.x = horizontalExit.x;
      current.z = horizontalExit.z;
    }

    // 多迭代后确保中心仍合理有效。
    if (!Number.isFinite(current.x) || !Number.isFinite(current.y) || !Number.isFinite(current.z) || halfHeight <= 0) {
      break;
    }
  }

  const remaining = findOverlappingAabbBounds(
    current,
    capsuleRadius,
    capsuleHeight,
    bounds,
    penetrationEpsilonMeters,
  );
  for (const bound of remaining) overlappingIdSet.add(bound.id);

  return {
    position: current,
    resolved: remaining.length === 0,
    overlappingIds: [...overlappingIdSet],
  };
}

/** 生成同高度环形候选安全位置，供出生或模式切换受困时兜底寻位。 */
export function buildSafeRadialCandidatePositions(
  origin: Readonly<ManualRoamPoint>,
  radii: readonly number[] = [0.4, 0.85, 1.4, 2.2],
  directions = 8,
): ManualRoamPoint[] {
  if (!isFinitePoint(origin)) return [];
  const dirCount = Number.isFinite(directions) && directions >= 1 ? Math.floor(directions) : 8;
  const candidates: ManualRoamPoint[] = [];
  for (const radius of radii) {
    if (!Number.isFinite(radius) || radius <= 0) continue;
    for (let index = 0; index < dirCount; index += 1) {
      const angle = (index / dirCount) * Math.PI * 2;
      candidates.push({
        x: origin.x + Math.sin(angle) * radius,
        y: origin.y,
        z: origin.z + Math.cos(angle) * radius,
      });
    }
  }
  return candidates;
}

function findDeepestOverlappingBound(
  position: Readonly<ManualRoamPoint>,
  capsuleRadius: number,
  capsuleHeight: number,
  bounds: readonly ManualRoamCollisionBounds[],
  thresholdSquared: number,
): ManualRoamCollisionBounds | null {
  let deepest: ManualRoamCollisionBounds | null = null;
  let minDistanceSquared = thresholdSquared;
  for (const bound of bounds) {
    const distanceSquared = computeNormalizedEllipsoidAabbDistanceSquared(
      position,
      capsuleRadius,
      capsuleHeight,
      bound,
    );
    if (distanceSquared < minDistanceSquared) {
      minDistanceSquared = distanceSquared;
      deepest = bound;
    }
  }
  return deepest;
}

function computeHorizontalExit(
  position: Readonly<ManualRoamPoint>,
  capsuleRadius: number,
  bound: Readonly<ManualRoamCollisionBounds>,
  clearance: number,
): { x: number; z: number; distance: number } {
  const minX = Math.min(bound.minimum.x, bound.maximum.x);
  const maxX = Math.max(bound.minimum.x, bound.maximum.x);
  const minZ = Math.min(bound.minimum.z, bound.maximum.z);
  const maxZ = Math.max(bound.minimum.z, bound.maximum.z);

  const clampedX = clamp(position.x, minX, maxX);
  const clampedZ = clamp(position.z, minZ, maxZ);
  const dx = position.x - clampedX;
  const dz = position.z - clampedZ;
  const distXZ = Math.hypot(dx, dz);

  if (distXZ > 1e-6) {
    const targetDistance = capsuleRadius + clearance;
    const push = Math.max(0, targetDistance - distXZ);
    return {
      x: position.x + (dx / distXZ) * push,
      z: position.z + (dz / distXZ) * push,
      distance: push,
    };
  }

  const exitLeftX = minX - capsuleRadius - clearance;
  const exitRightX = maxX + capsuleRadius + clearance;
  const exitBackZ = minZ - capsuleRadius - clearance;
  const exitFrontZ = maxZ + capsuleRadius + clearance;

  const candidates = [
    { x: exitLeftX, z: position.z, distance: Math.abs(position.x - exitLeftX) },
    { x: exitRightX, z: position.z, distance: Math.abs(exitRightX - position.x) },
    { x: position.x, z: exitBackZ, distance: Math.abs(position.z - exitBackZ) },
    { x: position.x, z: exitFrontZ, distance: Math.abs(exitFrontZ - position.z) },
  ];

  let best = candidates[0];
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index].distance < best.distance) {
      best = candidates[index];
    }
  }
  return best;
}

function computeNormalizedEllipsoidAabbDistanceSquared(
  position: Readonly<ManualRoamPoint>,
  capsuleRadius: number,
  capsuleHeight: number,
  bound: Readonly<ManualRoamCollisionBounds>,
): number {
  const minX = Math.min(bound.minimum.x, bound.maximum.x);
  const maxX = Math.max(bound.minimum.x, bound.maximum.x);
  const minY = Math.min(bound.minimum.y, bound.maximum.y);
  const maxY = Math.max(bound.minimum.y, bound.maximum.y);
  const minZ = Math.min(bound.minimum.z, bound.maximum.z);
  const maxZ = Math.max(bound.minimum.z, bound.maximum.z);

  const halfHeight = capsuleHeight / 2;
  const centerX = position.x;
  const centerY = position.y + halfHeight;
  const centerZ = position.z;

  const closestX = clamp(centerX, minX, maxX);
  const closestY = clamp(centerY, minY, maxY);
  const closestZ = clamp(centerZ, minZ, maxZ);

  const nx = (centerX - closestX) / capsuleRadius;
  const ny = (centerY - closestY) / halfHeight;
  const nz = (centerZ - closestZ) / capsuleRadius;
  return nx * nx + ny * ny + nz * nz;
}

function computePenetrationThresholdSquared(
  capsuleRadius: number,
  penetrationEpsilonMeters: number,
): number {
  const epsilon = Number.isFinite(penetrationEpsilonMeters) && penetrationEpsilonMeters >= 0
    ? penetrationEpsilonMeters
    : DEFAULT_DEPENETRATION_PENETRATION_EPSILON;
  const margin = Math.min(0.08, epsilon / Math.max(capsuleRadius, 0.1));
  const threshold = 1 - margin;
  return threshold * threshold;
}

function isFinitePoint(value: Readonly<ManualRoamPoint>): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
