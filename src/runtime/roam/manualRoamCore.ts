export type ManualRoamLocomotionMode = 'ground' | 'fly';
export type ManualRoamViewMode = 'firstPerson' | 'thirdPerson';

export type RoamVector3 = {
  x: number;
  y: number;
  z: number;
};

export type ManualRoamSpawnPose = {
  position: RoamVector3;
  yaw: number;
};

export type RoamInputFrame = {
  forward: number;
  right: number;
  vertical: number;
  lookX: number;
  lookY: number;
  jump: boolean;
  sprint: boolean;
};

export type ManualRoamConfig = {
  walkSpeed: number;
  runSpeed: number;
  flyVerticalSpeed: number;
  gravity: number;
  jumpSpeed: number;
  mouseSensitivity: number;
  touchLookSensitivity: number;
  gamepadLookSpeed: number;
  capsuleHeight: number;
  capsuleRadius: number;
  eyeHeight: number;
  thirdPersonDistance: number;
  thirdPersonHeight: number;
  stepHeight: number;
  groundProbeDistance: number;
  gamepadDeadZone: number;
  maxPitchDegrees: number;
  maxDeltaSeconds: number;
};

export type RoamKinematicState = {
  position: RoamVector3;
  yaw: number;
  pitch: number;
  verticalVelocity: number;
  grounded: boolean;
};

export type RoamKinematicStep = {
  displacement: RoamVector3;
  yaw: number;
  pitch: number;
  verticalVelocity: number;
  horizontalSpeed: number;
  jumped: boolean;
};

const DEFAULT_CONFIG: Readonly<ManualRoamConfig> = Object.freeze({
  walkSpeed: 1.6,
  runSpeed: 3.2,
  flyVerticalSpeed: 4,
  gravity: -9.81,
  jumpSpeed: 3.2,
  mouseSensitivity: 0.0025,
  touchLookSensitivity: 0.004,
  gamepadLookSpeed: 2.4,
  capsuleHeight: 1.65,
  capsuleRadius: 0.28,
  eyeHeight: 1.55,
  thirdPersonDistance: 2.5,
  thirdPersonHeight: 1.4,
  stepHeight: 0.22,
  groundProbeDistance: 0.32,
  gamepadDeadZone: 0.15,
  maxPitchDegrees: 85,
  maxDeltaSeconds: 0.05,
});

export function createDefaultManualRoamConfig(): ManualRoamConfig {
  return { ...DEFAULT_CONFIG };
}

export function sanitizeManualRoamConfig(
  config: Partial<ManualRoamConfig> | null | undefined,
): ManualRoamConfig {
  const source = config ?? {};
  const walkSpeed = finiteInRange(source.walkSpeed, DEFAULT_CONFIG.walkSpeed, 0.1, 25);
  const runSpeed = finiteInRange(source.runSpeed, DEFAULT_CONFIG.runSpeed, walkSpeed, 50);
  const capsuleHeight = finiteInRange(source.capsuleHeight, DEFAULT_CONFIG.capsuleHeight, 0.8, 3);
  const capsuleRadius = finiteInRange(
    source.capsuleRadius,
    DEFAULT_CONFIG.capsuleRadius,
    0.1,
    capsuleHeight / 2 - 0.01,
  );

  return {
    walkSpeed,
    runSpeed,
    flyVerticalSpeed: finiteInRange(source.flyVerticalSpeed, DEFAULT_CONFIG.flyVerticalSpeed, 0.1, 50),
    gravity: finiteInRange(source.gravity, DEFAULT_CONFIG.gravity, -50, -0.1),
    jumpSpeed: finiteInRange(source.jumpSpeed, DEFAULT_CONFIG.jumpSpeed, 0.1, 20),
    mouseSensitivity: finiteInRange(
      source.mouseSensitivity,
      DEFAULT_CONFIG.mouseSensitivity,
      0.0001,
      5,
    ),
    touchLookSensitivity: finiteInRange(
      source.touchLookSensitivity,
      DEFAULT_CONFIG.touchLookSensitivity,
      0.0001,
      5,
    ),
    gamepadLookSpeed: finiteInRange(
      source.gamepadLookSpeed,
      DEFAULT_CONFIG.gamepadLookSpeed,
      0.1,
      10,
    ),
    capsuleHeight,
    capsuleRadius,
    eyeHeight: finiteInRange(source.eyeHeight, DEFAULT_CONFIG.eyeHeight, 0.4, capsuleHeight),
    thirdPersonDistance: finiteInRange(
      source.thirdPersonDistance,
      DEFAULT_CONFIG.thirdPersonDistance,
      0.5,
      15,
    ),
    thirdPersonHeight: finiteInRange(
      source.thirdPersonHeight,
      DEFAULT_CONFIG.thirdPersonHeight,
      0.2,
      5,
    ),
    stepHeight: finiteInRange(source.stepHeight, DEFAULT_CONFIG.stepHeight, 0, 0.6),
    groundProbeDistance: finiteInRange(
      source.groundProbeDistance,
      DEFAULT_CONFIG.groundProbeDistance,
      0.05,
      1,
    ),
    gamepadDeadZone: finiteInRange(source.gamepadDeadZone, DEFAULT_CONFIG.gamepadDeadZone, 0, 0.5),
    maxPitchDegrees: finiteInRange(
      source.maxPitchDegrees,
      DEFAULT_CONFIG.maxPitchDegrees,
      10,
      89,
    ),
    maxDeltaSeconds: finiteInRange(
      source.maxDeltaSeconds,
      DEFAULT_CONFIG.maxDeltaSeconds,
      1 / 240,
      1,
    ),
  };
}

export function createInitialRoamKinematicState(
  position: Readonly<RoamVector3>,
  orientation: { yaw?: number; pitch?: number } = {},
): RoamKinematicState {
  return {
    position: {
      x: finiteOrZero(position.x),
      y: finiteOrZero(position.y),
      z: finiteOrZero(position.z),
    },
    yaw: finiteOrZero(orientation.yaw),
    pitch: finiteOrZero(orientation.pitch),
    verticalVelocity: 0,
    grounded: false,
  };
}

/** 运行时边界清洗出生姿态，非法回调结果会回退到当前相机推导逻辑。 */
export function sanitizeManualRoamSpawnPose(
  pose: ManualRoamSpawnPose | null | undefined,
): ManualRoamSpawnPose | null {
  if (!pose) return null;
  const { position, yaw } = pose;
  if (
    !position
    || !Number.isFinite(position.x)
    || !Number.isFinite(position.y)
    || !Number.isFinite(position.z)
    || !Number.isFinite(yaw)
  ) return null;
  return {
    position: { x: position.x, y: position.y, z: position.z },
    yaw: normalizeAngle(yaw),
  };
}

/**
 * 按输入幅度和行走/奔跑上限计算当前水平速度。
 * 模拟摇杆半幅时速度减半，使位移与步频使用同一速度。
 */
export function resolveRoamHorizontalSpeed(
  input: Readonly<RoamInputFrame>,
  rawConfig: Readonly<ManualRoamConfig>,
): number {
  const config = sanitizeManualRoamConfig(rawConfig);
  const forwardInput = clamp(finiteOrZero(input.forward), -1, 1);
  const rightInput = clamp(finiteOrZero(input.right), -1, 1);
  const inputMagnitude = Math.min(1, Math.hypot(forwardInput, rightInput));
  if (inputMagnitude <= 0) return 0;
  const maxSpeed = input.sprint ? config.runSpeed : config.walkSpeed;
  return inputMagnitude * maxSpeed;
}

/**
 * 计算单帧期望位移。场景碰撞、贴地和最终位置由 Babylon 适配层处理。
 */
export function resolveRoamKinematicStep(
  state: Readonly<RoamKinematicState>,
  input: Readonly<RoamInputFrame>,
  rawConfig: Readonly<ManualRoamConfig>,
  deltaSeconds: number,
  locomotionMode: ManualRoamLocomotionMode,
): RoamKinematicStep {
  const config = sanitizeManualRoamConfig(rawConfig);
  const delta = clamp(finiteOrZero(deltaSeconds), 0, config.maxDeltaSeconds);
  const yaw = normalizeAngle(state.yaw + finiteOrZero(input.lookX) * config.mouseSensitivity);
  const maximumPitch = degreesToRadians(config.maxPitchDegrees);
  const pitch = clamp(
    state.pitch - finiteOrZero(input.lookY) * config.mouseSensitivity,
    -maximumPitch,
    maximumPitch,
  );

  const forwardInput = clamp(finiteOrZero(input.forward), -1, 1);
  const rightInput = clamp(finiteOrZero(input.right), -1, 1);
  const inputMagnitude = Math.hypot(forwardInput, rightInput);
  const normalizedScale = inputMagnitude > 1e-8 ? 1 / inputMagnitude : 0;
  const localForward = forwardInput * normalizedScale;
  const localRight = rightInput * normalizedScale;
  const horizontalSpeed = resolveRoamHorizontalSpeed(input, config);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const displacementX = (localForward * sinYaw + localRight * cosYaw) * horizontalSpeed * delta;
  const displacementZ = (localForward * cosYaw - localRight * sinYaw) * horizontalSpeed * delta;

  let verticalVelocity = finiteOrZero(state.verticalVelocity);
  let displacementY = 0;
  let jumped = false;
  if (locomotionMode === 'fly') {
    verticalVelocity = 0;
    displacementY = clamp(finiteOrZero(input.vertical), -1, 1) * config.flyVerticalSpeed * delta;
  } else {
    if (state.grounded) {
      verticalVelocity = input.jump ? config.jumpSpeed : 0;
      jumped = input.jump;
    }
    if (!state.grounded || jumped) verticalVelocity += config.gravity * delta;
    displacementY = verticalVelocity * delta;
  }

  return {
    displacement: {
      x: displacementX,
      y: displacementY,
      z: displacementZ,
    },
    yaw,
    pitch,
    verticalVelocity,
    horizontalSpeed,
    jumped,
  };
}

function finiteInRange(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return clamp(fallback, minimum, maximum);
  }
  return clamp(value, minimum, maximum);
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function normalizeAngle(angle: number): number {
  const fullTurn = Math.PI * 2;
  return ((angle + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
