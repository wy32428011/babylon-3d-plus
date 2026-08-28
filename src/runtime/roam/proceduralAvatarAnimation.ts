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

export type ProceduralStrideRotationOffsets = {
  leftArm: number;
  rightArm: number;
  leftLeg: number;
  rightLeg: number;
};

export type ProceduralStrideLimbLengths = {
  leftArm: number;
  rightArm: number;
  leftLeg: number;
  rightLeg: number;
};

export type ProceduralStrideTargetOptions = {
  limbMask?: ArrayLike<number>;
  normals?: ArrayLike<number> | null;
  tangents?: ArrayLike<number> | null;
  pivots?: Partial<ProceduralStridePivots>;
  distals?: Partial<ProceduralStridePivots>;
  neutralRotationOffsets?: Partial<ProceduralStrideRotationOffsets>;
  limbLengths?: Partial<ProceduralStrideLimbLengths>;
};

export type ProceduralStrideTargets = {
  neutral: Float32Array;
  forward: Float32Array;
  backward: Float32Array;
  neutralNormals: Float32Array | null;
  forwardNormals: Float32Array | null;
  backwardNormals: Float32Array | null;
  neutralTangents: Float32Array | null;
  forwardTangents: Float32Array | null;
  backwardTangents: Float32Array | null;
  changedVertexCount: number;
};

export type ProceduralStrideInfluences = {
  neutral: number;
  forward: number;
  backward: number;
};

export type ProceduralGaitState = {
  phase: number;
  amount: number;
  active: boolean;
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

const LEG_SWING_RADIANS = 0.17;
const ARM_SWING_RADIANS = 0.14;
const BODY_BOB_AMPLITUDE_METERS = 0.003;
const BODY_SWAY_AMPLITUDE_RADIANS = 0.004;
/** 一个完整左右换步周期对应的水平位移，使步频与移动速度成正比。 */
export const GAIT_CYCLE_DISTANCE_METERS = 1.6;
const GAIT_START_RESPONSE = 10;
const GAIT_STOP_RESPONSE = 7;
const GAIT_MOVEMENT_DEAD_ZONE = 0.05;
const GAIT_FULL_STRIDE_INPUT = 0.35;
const MAX_NEUTRAL_ROTATION_OFFSET = 0.65;
const JOINT_FIXED_LENGTH_RATIO = 0.5;
const JOINT_FULL_ROTATION_LENGTH_RATIO = 1;

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
  const neutralRotationOffsets = resolveNeutralRotationOffsets(
    positions,
    limbMask,
    pivots,
    options.neutralRotationOffsets,
  );
  const limbLengths = resolveLimbLengths(
    positions,
    limbMask,
    pivots,
    options.distals,
    options.limbLengths,
  );
  const limbAxes = resolveLimbAxes(pivots, options.distals, neutralRotationOffsets);
  const neutral = Float32Array.from(positions);
  const forward = Float32Array.from(positions);
  const backward = Float32Array.from(positions);
  const hasNormals = options.normals?.length === positions.length;
  const neutralNormals = hasNormals ? Float32Array.from(options.normals!) : null;
  const forwardNormals = hasNormals ? Float32Array.from(options.normals!) : null;
  const backwardNormals = hasNormals ? Float32Array.from(options.normals!) : null;
  const tangentStride = options.tangents?.length === vertexCount * 4 ? 4 : 3;
  const hasTangents = options.tangents?.length === vertexCount * tangentStride;
  const neutralTangents = hasTangents ? new Float32Array(vertexCount * 3) : null;
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
      copyTangent(
        options.tangents,
        tangentStride,
        vertexIndex,
        neutralTangents,
        forwardTangents,
        backwardTangents,
      );
      continue;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    const pivot = resolveLimbPivot(limb, pivots);
    const rotationWeight = resolveLimbRotationWeight(
      x,
      y,
      z,
      pivot,
      resolveLimbPoint(limb, limbAxes),
      resolveLimbLength(limb, limbLengths),
    );
    const rotationOffset = resolveLimbRotationOffset(limb, neutralRotationOffsets);
    const neutralAngle = rotationOffset * rotationWeight;
    const forwardAngle = (rotationOffset + resolveLimbAngle(limb, 1)) * rotationWeight;
    const backwardAngle = (rotationOffset + resolveLimbAngle(limb, -1)) * rotationWeight;
    writeRotatedPosition(neutral, positionIndex, x, y, z, pivot, neutralAngle);
    writeRotatedPosition(forward, positionIndex, x, y, z, pivot, forwardAngle);
    writeRotatedPosition(backward, positionIndex, x, y, z, pivot, backwardAngle);
    if (neutralNormals && forwardNormals && backwardNormals && options.normals) {
      const normalX = options.normals[positionIndex];
      const normalY = options.normals[positionIndex + 1];
      const normalZ = options.normals[positionIndex + 2];
      writeDirection(neutralNormals, positionIndex, normalX, normalY, normalZ, neutralAngle);
      writeDirection(forwardNormals, positionIndex, normalX, normalY, normalZ, forwardAngle);
      writeDirection(backwardNormals, positionIndex, normalX, normalY, normalZ, backwardAngle);
    }
    if (neutralTangents && forwardTangents && backwardTangents && options.tangents) {
      writeRotatedTangent(
        options.tangents,
        tangentStride,
        vertexIndex,
        neutralTangents,
        forwardTangents,
        backwardTangents,
        neutralAngle,
        forwardAngle,
        backwardAngle,
      );
    }
    changedVertexCount += 1;
  }

  return changedVertexCount > 0
    ? {
      neutral,
      forward,
      backward,
      neutralNormals,
      forwardNormals,
      backwardNormals,
      neutralTangents,
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
  if (airborne) return { neutral: 1, forward: 0, backward: 0 };
  const amount = clamp01(movementAmount);
  const wave = Math.sin(Number.isFinite(phase) ? phase : 0) * amount;
  return {
    neutral: 1 - Math.abs(wave),
    forward: Math.max(0, wave),
    backward: Math.max(0, -wave),
  };
}

export function createInitialProceduralGaitState(): ProceduralGaitState {
  return { phase: 0, amount: 0, active: false };
}

/**
 * 按水平速度换算步态角频率。
 * 速度加倍则换步频率加倍，保持单周期跨步距离不变。
 */
export function resolveProceduralGaitCadence(horizontalSpeedMetersPerSecond: number): number {
  if (!Number.isFinite(horizontalSpeedMetersPerSecond) || horizontalSpeedMetersPerSecond <= 0) {
    return 0;
  }
  return horizontalSpeedMetersPerSecond / GAIT_CYCLE_DISTANCE_METERS * Math.PI * 2;
}

/** 平滑收敛步态强度；相位按实际水平速度推进，停止输入后冻结相位。 */
export function stepProceduralGaitState(
  state: Readonly<ProceduralGaitState>,
  movementAmount: number,
  horizontalSpeedMetersPerSecond: number,
  airborne: boolean,
  deltaSeconds: number,
): ProceduralGaitState {
  const delta = clampFinite(deltaSeconds, 0, 0.05);
  const movement = airborne ? 0 : clamp01(movementAmount);
  const active = movement > GAIT_MOVEMENT_DEAD_ZONE;
  const settledTarget = active
    ? clamp01(
      (movement - GAIT_MOVEMENT_DEAD_ZONE)
      / (GAIT_FULL_STRIDE_INPUT - GAIT_MOVEMENT_DEAD_ZONE),
    )
    : 0;
  const currentAmount = clamp01(state.amount);
  const response = active ? GAIT_START_RESPONSE : GAIT_STOP_RESPONSE;
  const blend = 1 - Math.exp(-response * delta);
  let amount = currentAmount + (settledTarget - currentAmount) * blend;
  if (!active && amount < 0.001) amount = 0;

  let phase = Number.isFinite(state.phase) ? state.phase : 0;
  if (active) {
    phase += delta * resolveProceduralGaitCadence(horizontalSpeedMetersPerSecond);
  } else if (amount === 0) {
    phase = 0;
  }
  return { phase, amount, active };
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
    verticalOffsetMeters: -wave * wave * BODY_BOB_AMPLITUDE_METERS * amount,
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

function resolveNeutralRotationOffsets(
  positions: ArrayLike<number>,
  limbMask: ArrayLike<number>,
  pivots: ProceduralStridePivots,
  custom: Partial<ProceduralStrideRotationOffsets> | undefined,
): ProceduralStrideRotationOffsets {
  const resolve = (limb: ProceduralLimb, override: number | undefined): number => {
    if (Number.isFinite(override)) {
      return clampFinite(override!, -MAX_NEUTRAL_ROTATION_OFFSET, MAX_NEUTRAL_ROTATION_OFFSET);
    }

    const pivot = resolveLimbPivot(limb, pivots);
    let weightedY = 0;
    let weightedZ = 0;
    let totalWeight = 0;
    for (let vertexIndex = 0; vertexIndex < limbMask.length; vertexIndex += 1) {
      if (sanitizeLimb(limbMask[vertexIndex]) !== limb) continue;
      const positionIndex = vertexIndex * 3;
      const relativeY = positions[positionIndex + 1] - pivot.y;
      const relativeZ = positions[positionIndex + 2] - pivot.z;
      if (!Number.isFinite(relativeY) || !Number.isFinite(relativeZ) || relativeY >= -1e-5) continue;
      // 远离关节的顶点更能代表整条肢体朝向，避免袖口/裤脚厚度扰动中立角度。
      const weight = relativeY * relativeY;
      weightedY += relativeY * weight;
      weightedZ += relativeZ * weight;
      totalWeight += weight;
    }
    if (totalWeight <= 1e-8) return 0;
    return clampFinite(
      Math.atan2(weightedZ / totalWeight, -(weightedY / totalWeight)),
      -MAX_NEUTRAL_ROTATION_OFFSET,
      MAX_NEUTRAL_ROTATION_OFFSET,
    );
  };

  return {
    leftArm: resolve(PROCEDURAL_LIMB.leftArm, custom?.leftArm),
    rightArm: resolve(PROCEDURAL_LIMB.rightArm, custom?.rightArm),
    leftLeg: resolve(PROCEDURAL_LIMB.leftLeg, custom?.leftLeg),
    rightLeg: resolve(PROCEDURAL_LIMB.rightLeg, custom?.rightLeg),
  };
}

function resolveLimbPivot(limb: ProceduralLimb, pivots: ProceduralStridePivots): ProceduralPoint3 {
  if (limb === PROCEDURAL_LIMB.leftArm) return pivots.leftArm;
  if (limb === PROCEDURAL_LIMB.rightArm) return pivots.rightArm;
  if (limb === PROCEDURAL_LIMB.leftLeg) return pivots.leftLeg;
  return pivots.rightLeg;
}

function resolveLimbRotationOffset(
  limb: ProceduralLimb,
  offsets: ProceduralStrideRotationOffsets,
): number {
  if (limb === PROCEDURAL_LIMB.leftArm) return offsets.leftArm;
  if (limb === PROCEDURAL_LIMB.rightArm) return offsets.rightArm;
  if (limb === PROCEDURAL_LIMB.leftLeg) return offsets.leftLeg;
  return offsets.rightLeg;
}

function resolveLimbLengths(
  positions: ArrayLike<number>,
  limbMask: ArrayLike<number>,
  pivots: ProceduralStridePivots,
  distals: Partial<ProceduralStridePivots> | undefined,
  custom: Partial<ProceduralStrideLimbLengths> | undefined,
): ProceduralStrideLimbLengths {
  const lengths: ProceduralStrideLimbLengths = {
    leftArm: 0,
    rightArm: 0,
    leftLeg: 0,
    rightLeg: 0,
  };
  for (let vertexIndex = 0; vertexIndex < limbMask.length; vertexIndex += 1) {
    const limb = sanitizeLimb(limbMask[vertexIndex]);
    if (limb === PROCEDURAL_LIMB.fixed) continue;
    const positionIndex = vertexIndex * 3;
    const x = positions[positionIndex];
    const y = positions[positionIndex + 1];
    const z = positions[positionIndex + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const pivot = resolveLimbPivot(limb, pivots);
    const distance = Math.hypot(x - pivot.x, y - pivot.y, z - pivot.z);
    if (limb === PROCEDURAL_LIMB.leftArm) lengths.leftArm = Math.max(lengths.leftArm, distance);
    else if (limb === PROCEDURAL_LIMB.rightArm) lengths.rightArm = Math.max(lengths.rightArm, distance);
    else if (limb === PROCEDURAL_LIMB.leftLeg) lengths.leftLeg = Math.max(lengths.leftLeg, distance);
    else lengths.rightLeg = Math.max(lengths.rightLeg, distance);
  }
  return {
    leftArm: resolvePositiveLength(
      custom?.leftArm,
      resolvePointDistance(pivots.leftArm, distals?.leftArm),
      lengths.leftArm,
    ),
    rightArm: resolvePositiveLength(
      custom?.rightArm,
      resolvePointDistance(pivots.rightArm, distals?.rightArm),
      lengths.rightArm,
    ),
    leftLeg: resolvePositiveLength(
      custom?.leftLeg,
      resolvePointDistance(pivots.leftLeg, distals?.leftLeg),
      lengths.leftLeg,
    ),
    rightLeg: resolvePositiveLength(
      custom?.rightLeg,
      resolvePointDistance(pivots.rightLeg, distals?.rightLeg),
      lengths.rightLeg,
    ),
  };
}

function resolveLimbAxes(
  pivots: ProceduralStridePivots,
  distals: Partial<ProceduralStridePivots> | undefined,
  offsets: ProceduralStrideRotationOffsets,
): ProceduralStridePivots {
  const resolve = (limb: ProceduralLimb): ProceduralPoint3 => {
    const pivot = resolveLimbPivot(limb, pivots);
    const distal = resolveLimbPoint(limb, distals);
    if (distal) {
      const x = distal.x - pivot.x;
      const y = distal.y - pivot.y;
      const z = distal.z - pivot.z;
      const length = Math.hypot(x, y, z);
      if (length > 1e-8) return { x: x / length, y: y / length, z: z / length };
    }

    const offset = resolveLimbRotationOffset(limb, offsets);
    return { x: 0, y: -Math.cos(offset), z: Math.sin(offset) };
  };

  return {
    leftArm: resolve(PROCEDURAL_LIMB.leftArm),
    rightArm: resolve(PROCEDURAL_LIMB.rightArm),
    leftLeg: resolve(PROCEDURAL_LIMB.leftLeg),
    rightLeg: resolve(PROCEDURAL_LIMB.rightLeg),
  };
}

function resolveLimbLength(limb: ProceduralLimb, lengths: ProceduralStrideLimbLengths): number {
  if (limb === PROCEDURAL_LIMB.leftArm) return lengths.leftArm;
  if (limb === PROCEDURAL_LIMB.rightArm) return lengths.rightArm;
  if (limb === PROCEDURAL_LIMB.leftLeg) return lengths.leftLeg;
  return lengths.rightLeg;
}

function resolveLimbPoint(
  limb: ProceduralLimb,
  points: Partial<ProceduralStridePivots> | undefined,
): ProceduralPoint3 | undefined {
  if (limb === PROCEDURAL_LIMB.leftArm) return points?.leftArm;
  if (limb === PROCEDURAL_LIMB.rightArm) return points?.rightArm;
  if (limb === PROCEDURAL_LIMB.leftLeg) return points?.leftLeg;
  return points?.rightLeg;
}

function resolveLimbRotationWeight(
  x: number,
  y: number,
  z: number,
  pivot: ProceduralPoint3,
  axis: ProceduralPoint3 | undefined,
  limbLength: number,
): number {
  if (!axis || limbLength <= 1e-8) return 0;
  const axialDistance = Math.max(
    0,
    (x - pivot.x) * axis.x + (y - pivot.y) * axis.y + (z - pivot.z) * axis.z,
  );
  const distanceRatio = axialDistance / limbLength;
  const progress = clamp01(
    (distanceRatio - JOINT_FIXED_LENGTH_RATIO)
    / (JOINT_FULL_ROTATION_LENGTH_RATIO - JOINT_FIXED_LENGTH_RATIO),
  );
  return progress * progress * (3 - 2 * progress);
}

function resolvePointDistance(
  first: ProceduralPoint3,
  second: ProceduralPoint3 | undefined,
): number {
  if (!second) return 0;
  return Math.hypot(second.x - first.x, second.y - first.y, second.z - first.z);
}

function resolvePositiveLength(...candidates: Array<number | undefined>): number {
  return candidates.find((value): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > 1e-8
  )) ?? 0;
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

function writeRotatedTangent(
  source: ArrayLike<number>,
  sourceStride: number,
  vertexIndex: number,
  neutral: Float32Array,
  forward: Float32Array,
  backward: Float32Array,
  neutralAngle: number,
  forwardAngle: number,
  backwardAngle: number,
): void {
  const sourceIndex = vertexIndex * sourceStride;
  const targetIndex = vertexIndex * 3;
  const x = source[sourceIndex];
  const y = source[sourceIndex + 1];
  const z = source[sourceIndex + 2];
  writeDirection(neutral, targetIndex, x, y, z, neutralAngle);
  writeDirection(forward, targetIndex, x, y, z, forwardAngle);
  writeDirection(backward, targetIndex, x, y, z, backwardAngle);
}

function copyTangent(
  source: ArrayLike<number> | null | undefined,
  sourceStride: number,
  vertexIndex: number,
  neutral: Float32Array | null,
  forward: Float32Array | null,
  backward: Float32Array | null,
): void {
  if (!source || !neutral || !forward || !backward) return;
  const sourceIndex = vertexIndex * sourceStride;
  const targetIndex = vertexIndex * 3;
  for (let offset = 0; offset < 3; offset += 1) {
    neutral[targetIndex + offset] = source[sourceIndex + offset];
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

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
