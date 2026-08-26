export const PROCEDURAL_LIMB = {
  leftArm: -2,
  leftLeg: -1,
  fixed: 0,
  rightLeg: 1,
  rightArm: 2,
} as const;

export type ProceduralLimb = typeof PROCEDURAL_LIMB[keyof typeof PROCEDURAL_LIMB];
export type ProceduralLimbSelection = 'allArms' | 'outerArms' | 'allLegs' | 'lowerLegs';

export type ProceduralPoint3 = {
  x: number;
  y: number;
  z: number;
};

export type ProceduralStridePivots = {
  leftArm: ProceduralPoint3;
  rightArm: ProceduralPoint3;
  leftLeg: ProceduralPoint3;
  rightLeg: ProceduralPoint3;
};

export type ProceduralStrideTargetOptions = {
  limbMask?: ArrayLike<number>;
  normals?: ArrayLike<number> | null;
  tangents?: ArrayLike<number> | null;
  pivots?: Partial<ProceduralStridePivots>;
};

export type ProceduralStrideTargets = {
  forward: Float32Array;
  backward: Float32Array;
  forwardNormals: Float32Array | null;
  backwardNormals: Float32Array | null;
  forwardTangents: Float32Array | null;
  backwardTangents: Float32Array | null;
  changedVertexCount: number;
};

export type ProceduralStrideInfluences = {
  forward: number;
  backward: number;
};

export type ProceduralBodyMotion = {
  verticalOffsetMeters: number;
  rollRadians: number;
};

type PositionBounds = {
  minimumX: number;
  minimumY: number;
  minimumZ: number;
  maximumX: number;
  maximumY: number;
  maximumZ: number;
  centerX: number;
  centerZ: number;
};

const LEG_SWING_RADIANS = 0.34;
const ARM_SWING_RADIANS = 0.28;
const BODY_BOB_AMPLITUDE_METERS = 0.006;
const BODY_SWAY_AMPLITUDE_RADIANS = 0.008;

/**
 * 按索引拓扑划分独立肢体，避免仅凭包围盒误带动躯干或腰胯。
 * 返回值每项对应一个顶点，0 表示该顶点保持固定。
 */
export function createConnectedLimbMask(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  selection: ProceduralLimbSelection,
): Int8Array {
  const vertexCount = Math.floor(positions.length / 3);
  const mask = new Int8Array(vertexCount);
  const bounds = readFiniteBounds(positions);
  if (!bounds || indices.length < 3) return mask;

  const parents = new Int32Array(vertexCount);
  parents.fill(-1);
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const first = sanitizeVertexIndex(indices[index], vertexCount);
    const second = sanitizeVertexIndex(indices[index + 1], vertexCount);
    const third = sanitizeVertexIndex(indices[index + 2], vertexCount);
    if (first < 0 || second < 0 || third < 0) continue;
    initializeParent(parents, first);
    initializeParent(parents, second);
    initializeParent(parents, third);
    unionVertices(parents, first, second);
    unionVertices(parents, second, third);
  }

  const components = new Map<number, number[]>();
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    if (parents[vertexIndex] < 0) continue;
    const root = findVertexRoot(parents, vertexIndex);
    const component = components.get(root) ?? [];
    component.push(vertexIndex);
    components.set(root, component);
  }

  const width = bounds.maximumX - bounds.minimumX;
  const height = bounds.maximumY - bounds.minimumY;
  for (const component of components.values()) {
    let centerX = 0;
    let minimumY = Number.POSITIVE_INFINITY;
    for (const vertexIndex of component) {
      centerX += positions[vertexIndex * 3];
      minimumY = Math.min(minimumY, positions[vertexIndex * 3 + 1]);
    }
    centerX /= component.length;
    const outerEnough = Math.abs(centerX - bounds.centerX) > width * 0.28;
    const lowEnough = minimumY < bounds.minimumY + height * 0.25;
    const selected = selection === 'allArms'
      || selection === 'allLegs'
      || (selection === 'outerArms' && outerEnough)
      || (selection === 'lowerLegs' && lowEnough);
    if (!selected) continue;

    const left = centerX < bounds.centerX;
    const limb = selection === 'allArms' || selection === 'outerArms'
      ? left ? PROCEDURAL_LIMB.leftArm : PROCEDURAL_LIMB.rightArm
      : left ? PROCEDURAL_LIMB.leftLeg : PROCEDURAL_LIMB.rightLeg;
    for (const vertexIndex of component) mask[vertexIndex] = limb;
  }
  return mask;
}

/** 为没有蒙皮和动画片段的人物网格生成两端步态姿势。 */
export function createProceduralStrideTargets(
  positions: ArrayLike<number>,
  options: ProceduralStrideTargetOptions = {},
): ProceduralStrideTargets | null {
  if (positions.length < 9 || positions.length % 3 !== 0) return null;
  const bounds = readFiniteBounds(positions);
  if (!bounds) return null;

  const width = bounds.maximumX - bounds.minimumX;
  const height = bounds.maximumY - bounds.minimumY;
  if (width <= 1e-6 || height <= 1e-6) return null;
  const vertexCount = positions.length / 3;
  const limbMask = options.limbMask ?? createGeometricLimbMask(positions, bounds);
  if (limbMask.length < vertexCount) return null;

  const pivots = resolvePivots(bounds, options.pivots);
  const forward = Float32Array.from(positions);
  const backward = Float32Array.from(positions);
  const hasNormals = options.normals?.length === positions.length;
  const forwardNormals = hasNormals ? Float32Array.from(options.normals!) : null;
  const backwardNormals = hasNormals ? Float32Array.from(options.normals!) : null;
  const tangentStride = options.tangents?.length === vertexCount * 4 ? 4 : 3;
  const hasTangents = options.tangents?.length === vertexCount * tangentStride;
  const forwardTangents = hasTangents ? new Float32Array(vertexCount * 3) : null;
  const backwardTangents = hasTangents ? new Float32Array(vertexCount * 3) : null;
  let changedVertexCount = 0;

  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const positionIndex = vertexIndex * 3;
    const x = positions[positionIndex];
    const y = positions[positionIndex + 1];
    const z = positions[positionIndex + 2];
    const limb = sanitizeLimb(limbMask[vertexIndex]);
    if (limb === PROCEDURAL_LIMB.fixed) {
      copyTangent(options.tangents, tangentStride, vertexIndex, forwardTangents, backwardTangents);
      continue;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    const pivot = resolveLimbPivot(limb, pivots);
    const forwardAngle = resolveLimbAngle(limb, 1);
    const backwardAngle = resolveLimbAngle(limb, -1);
    writeRotatedPosition(forward, positionIndex, x, y, z, pivot, forwardAngle);
    writeRotatedPosition(backward, positionIndex, x, y, z, pivot, backwardAngle);
    if (forwardNormals && backwardNormals && options.normals) {
      writeRotatedDirection(
        options.normals,
        positionIndex,
        forwardNormals,
        backwardNormals,
        forwardAngle,
        backwardAngle,
      );
    }
    if (forwardTangents && backwardTangents && options.tangents) {
      writeRotatedTangent(
        options.tangents,
        tangentStride,
        vertexIndex,
        forwardTangents,
        backwardTangents,
        forwardAngle,
        backwardAngle,
      );
    }
    changedVertexCount += 1;
  }

  return changedVertexCount > 0
    ? {
      forward,
      backward,
      forwardNormals,
      backwardNormals,
      forwardTangents,
      backwardTangents,
      changedVertexCount,
    }
    : null;
}

export function resolveProceduralStrideInfluences(
  phase: number,
  movementAmount: number,
  airborne: boolean,
): ProceduralStrideInfluences {
  if (airborne) return { forward: 0, backward: 0 };
  const amount = clamp01(movementAmount);
  const wave = Math.sin(Number.isFinite(phase) ? phase : 0) * amount;
  return {
    forward: Math.max(0, wave),
    backward: Math.max(0, -wave),
  };
}

/** 为程序化步态提供轻微身体重心变化，避免根节点起伏看起来像连续跳跃。 */
export function resolveProceduralBodyMotion(
  phase: number,
  movementAmount: number,
  airborne: boolean,
): ProceduralBodyMotion {
  if (airborne) return { verticalOffsetMeters: 0, rollRadians: 0 };
  const amount = clamp01(movementAmount);
  if (amount === 0) return { verticalOffsetMeters: 0, rollRadians: 0 };
  const wave = Math.sin(Number.isFinite(phase) ? phase : 0);
  return {
    verticalOffsetMeters: wave * wave * BODY_BOB_AMPLITUDE_METERS * amount,
    rollRadians: wave * BODY_SWAY_AMPLITUDE_RADIANS * amount,
  };
}

function createGeometricLimbMask(positions: ArrayLike<number>, bounds: PositionBounds): Int8Array {
  const vertexCount = positions.length / 3;
  const mask = new Int8Array(vertexCount);
  const width = bounds.maximumX - bounds.minimumX;
  const height = bounds.maximumY - bounds.minimumY;
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const x = positions[vertexIndex * 3];
    const y = positions[vertexIndex * 3 + 1];
    const normalizedY = (y - bounds.minimumY) / height;
    const sideDistance = Math.abs(x - bounds.centerX) / Math.max(width / 2, 1e-6);
    const left = x < bounds.centerX;
    if (normalizedY <= 0.5 && sideDistance >= 0.16) {
      mask[vertexIndex] = left ? PROCEDURAL_LIMB.leftLeg : PROCEDURAL_LIMB.rightLeg;
    } else if (normalizedY >= 0.38 && normalizedY <= 0.82 && sideDistance >= 0.58) {
      mask[vertexIndex] = left ? PROCEDURAL_LIMB.leftArm : PROCEDURAL_LIMB.rightArm;
    }
  }
  return mask;
}

function resolvePivots(
  bounds: PositionBounds,
  custom: Partial<ProceduralStridePivots> | undefined,
): ProceduralStridePivots {
  const width = bounds.maximumX - bounds.minimumX;
  const height = bounds.maximumY - bounds.minimumY;
  const hipY = bounds.minimumY + height * 0.52;
  const shoulderY = bounds.minimumY + height * 0.78;
  return {
    leftLeg: custom?.leftLeg ?? {
      x: bounds.centerX - width * 0.17,
      y: hipY,
      z: bounds.centerZ,
    },
    rightLeg: custom?.rightLeg ?? {
      x: bounds.centerX + width * 0.17,
      y: hipY,
      z: bounds.centerZ,
    },
    leftArm: custom?.leftArm ?? {
      x: bounds.centerX - width * 0.14,
      y: shoulderY,
      z: bounds.centerZ,
    },
    rightArm: custom?.rightArm ?? {
      x: bounds.centerX + width * 0.14,
      y: shoulderY,
      z: bounds.centerZ,
    },
  };
}

function resolveLimbPivot(limb: ProceduralLimb, pivots: ProceduralStridePivots): ProceduralPoint3 {
  if (limb === PROCEDURAL_LIMB.leftArm) return pivots.leftArm;
  if (limb === PROCEDURAL_LIMB.rightArm) return pivots.rightArm;
  if (limb === PROCEDURAL_LIMB.leftLeg) return pivots.leftLeg;
  return pivots.rightLeg;
}

function resolveLimbAngle(limb: ProceduralLimb, direction: number): number {
  const side = limb < 0 ? -1 : 1;
  const arm = Math.abs(limb) === 2;
  return direction * side * (arm ? -ARM_SWING_RADIANS : LEG_SWING_RADIANS);
}

function writeRotatedPosition(
  target: Float32Array,
  index: number,
  x: number,
  y: number,
  z: number,
  pivot: ProceduralPoint3,
  angle: number,
): void {
  const relativeY = y - pivot.y;
  const relativeZ = z - pivot.z;
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  target[index] = x;
  target[index + 1] = pivot.y + relativeY * cosine - relativeZ * sine;
  target[index + 2] = pivot.z + relativeY * sine + relativeZ * cosine;
}

function writeRotatedDirection(
  source: ArrayLike<number>,
  index: number,
  forward: Float32Array,
  backward: Float32Array,
  forwardAngle: number,
  backwardAngle: number,
): void {
  const x = source[index];
  const y = source[index + 1];
  const z = source[index + 2];
  writeDirection(forward, index, x, y, z, forwardAngle);
  writeDirection(backward, index, x, y, z, backwardAngle);
}

function writeRotatedTangent(
  source: ArrayLike<number>,
  sourceStride: number,
  vertexIndex: number,
  forward: Float32Array,
  backward: Float32Array,
  forwardAngle: number,
  backwardAngle: number,
): void {
  const sourceIndex = vertexIndex * sourceStride;
  const targetIndex = vertexIndex * 3;
  const x = source[sourceIndex];
  const y = source[sourceIndex + 1];
  const z = source[sourceIndex + 2];
  writeDirection(forward, targetIndex, x, y, z, forwardAngle);
  writeDirection(backward, targetIndex, x, y, z, backwardAngle);
}

function copyTangent(
  source: ArrayLike<number> | null | undefined,
  sourceStride: number,
  vertexIndex: number,
  forward: Float32Array | null,
  backward: Float32Array | null,
): void {
  if (!source || !forward || !backward) return;
  const sourceIndex = vertexIndex * sourceStride;
  const targetIndex = vertexIndex * 3;
  for (let offset = 0; offset < 3; offset += 1) {
    forward[targetIndex + offset] = source[sourceIndex + offset];
    backward[targetIndex + offset] = source[sourceIndex + offset];
  }
}

function writeDirection(
  target: Float32Array,
  index: number,
  x: number,
  y: number,
  z: number,
  angle: number,
): void {
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  target[index] = x;
  target[index + 1] = y * cosine - z * sine;
  target[index + 2] = y * sine + z * cosine;
}

function sanitizeLimb(value: number): ProceduralLimb {
  return value === PROCEDURAL_LIMB.leftArm
    || value === PROCEDURAL_LIMB.leftLeg
    || value === PROCEDURAL_LIMB.rightLeg
    || value === PROCEDURAL_LIMB.rightArm
    ? value
    : PROCEDURAL_LIMB.fixed;
}

function sanitizeVertexIndex(value: number, vertexCount: number): number {
  return Number.isInteger(value) && value >= 0 && value < vertexCount ? value : -1;
}

function initializeParent(parents: Int32Array, vertexIndex: number): void {
  if (parents[vertexIndex] < 0) parents[vertexIndex] = vertexIndex;
}

function findVertexRoot(parents: Int32Array, vertexIndex: number): number {
  let root = vertexIndex;
  while (parents[root] !== root) root = parents[root];
  while (parents[vertexIndex] !== vertexIndex) {
    const parent = parents[vertexIndex];
    parents[vertexIndex] = root;
    vertexIndex = parent;
  }
  return root;
}

function unionVertices(parents: Int32Array, left: number, right: number): void {
  const leftRoot = findVertexRoot(parents, left);
  const rightRoot = findVertexRoot(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}

function readFiniteBounds(positions: ArrayLike<number>): PositionBounds | null {
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let minimumZ = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  let maximumZ = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 2 < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    minimumZ = Math.min(minimumZ, z);
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
    maximumZ = Math.max(maximumZ, z);
  }
  if (!Number.isFinite(minimumX) || !Number.isFinite(maximumX)) return null;
  return {
    minimumX,
    minimumY,
    minimumZ,
    maximumX,
    maximumY,
    maximumZ,
    centerX: (minimumX + maximumX) / 2,
    centerZ: (minimumZ + maximumZ) / 2,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
