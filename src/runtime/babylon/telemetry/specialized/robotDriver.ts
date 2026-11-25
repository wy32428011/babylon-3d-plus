import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { DeviceTelemetryFields, DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import { findModelNodesByName } from '../../runtimeNodeGeometry';

export const ROBOT_ARM_JOINT_COUNT = 7;

export type RobotArmSide = 'L' | 'R';
export type RobotJointAxis = 'x' | 'y' | 'z';

export type RobotArmMotionConfig = {
  field: string;
  nodes: string[];
  axes: RobotJointAxis[];
  signs: number[];
  offsets: number[];
};

export type RobotMotionConfig = {
  angleUnit: 'rad' | 'deg';
  arms: Record<RobotArmSide, RobotArmMotionConfig>;
};

const DEFAULT_AXES: RobotJointAxis[] = ['z', 'x', 'z', 'x', 'z', 'x', 'z'];
const DEFAULT_SIGNS = [1, 1, 1, 1, 1, 1, 1];
const DEFAULT_OFFSETS = [0, 0, 0, 0, 0, 0, 0];

const DEFAULT_ROBOT_MOTION_CONFIG: RobotMotionConfig = {
  angleUnit: 'rad',
  arms: {
    L: {
      field: 'armJointL',
      nodes: [],
      axes: [...DEFAULT_AXES],
      signs: [...DEFAULT_SIGNS],
      offsets: [...DEFAULT_OFFSETS],
    },
    R: {
      field: 'armJointR',
      nodes: [],
      axes: [...DEFAULT_AXES],
      signs: [...DEFAULT_SIGNS],
      offsets: [...DEFAULT_OFFSETS],
    },
  },
};

const AXIS_VECTORS = {
  x: new Vector3(1, 0, 0),
  y: new Vector3(0, 1, 0),
  z: new Vector3(0, 0, 1),
} as const;

type RobotJointRuntime = {
  node: TransformNode;
  baselineRotation: Quaternion;
  axis: RobotJointAxis;
  sign: number;
  offset: number;
};

type RobotArmRuntime = {
  joints: (RobotJointRuntime | null)[];
  active: boolean;
  currentAngles: number[];
  startAngles: number[];
  targetAngles: number[];
};

type RobotModelRuntime = {
  signature: string;
  config: RobotMotionConfig;
  arms: Record<RobotArmSide, RobotArmRuntime>;
  lastSnapshot: DeviceTelemetrySnapshot | null;
  lastSampleTimeMs: number;
  elapsedSeconds: number;
  durationSeconds: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || value.length !== ROBOT_ARM_JOINT_COUNT) return [...fallback];
  return value.every(item => typeof item === 'string' && item.trim().length > 0)
    ? value.map(item => (item as string).trim())
    : [...fallback];
}

function readAxes(value: unknown, fallback: RobotJointAxis[]): RobotJointAxis[] {
  if (!Array.isArray(value) || value.length !== ROBOT_ARM_JOINT_COUNT) return [...fallback];
  return value.every(item => item === 'x' || item === 'y' || item === 'z')
    ? [...value] as RobotJointAxis[]
    : [...fallback];
}

function readSigns(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value) || value.length !== ROBOT_ARM_JOINT_COUNT) return [...fallback];
  return value.map(item => Number(item) < 0 ? -1 : 1);
}

function readOffsets(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value) || value.length !== ROBOT_ARM_JOINT_COUNT) return [...fallback];
  return value.map((item, index) => {
    const offset = Number(item);
    return Number.isFinite(offset) ? offset : fallback[index];
  });
}

function cloneDefaultMotionConfig(): RobotMotionConfig {
  return JSON.parse(JSON.stringify(DEFAULT_ROBOT_MOTION_CONFIG)) as RobotMotionConfig;
}

function mergeRobotMotionConfig(value: unknown): RobotMotionConfig {
  const config = cloneDefaultMotionConfig();
  if (!isRecord(value)) return config;
  config.angleUnit = value.angleUnit === 'deg' ? 'deg' : 'rad';
  if (!isRecord(value.arms)) return config;

  for (const side of ['L', 'R'] as const) {
    const arm = value.arms[side];
    if (!isRecord(arm)) continue;
    const fallback = DEFAULT_ROBOT_MOTION_CONFIG.arms[side];
    config.arms[side] = {
      field: typeof arm.field === 'string' && arm.field.trim() ? arm.field.trim() : fallback.field,
      nodes: readStringArray(arm.nodes, fallback.nodes),
      axes: readAxes(arm.axes, fallback.axes),
      signs: readSigns(arm.signs, fallback.signs),
      offsets: readOffsets(arm.offsets, fallback.offsets),
    };
  }
  return config;
}

function applyJointCalibration(model: ModelRuntimeEntry, config: RobotMotionConfig): RobotMotionConfig {
  const calibration = model.telemetryBinding?.robotJointCalibration;
  if (!calibration) return config;
  for (const side of ['L', 'R'] as const) {
    const arm = calibration[side];
    if (!arm) continue;
    if (arm.axes) {
      config.arms[side].axes = arm.axes.map(axis => axis.replace('-', '') as RobotJointAxis);
      config.arms[side].signs = arm.axes.map(axis => axis.startsWith('-') ? -1 : 1);
    } else if (arm.signs) {
      config.arms[side].signs = [...arm.signs];
    }
    config.arms[side].offsets = arm.offsetsDeg.map(value => (
      config.angleUnit === 'deg' ? value : value * Math.PI / 180
    ));
  }
  return config;
}

function readRobotMotionConfig(model: ModelRuntimeEntry): RobotMotionConfig {
  const persisted = model.entitySnapshot?.components.modelAsset?.dataDrivenConfig
    ?? model.resolvedModelAsset?.dataDrivenConfig;
  if (persisted?.specializedMotion) {
    return applyJointCalibration(model, mergeRobotMotionConfig(persisted.specializedMotion));
  }
  for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
    if (isRecord(dataDriven) && isRecord(dataDriven.motion)) {
      return applyJointCalibration(model, mergeRobotMotionConfig(dataDriven.motion));
    }
  }
  return applyJointCalibration(model, cloneDefaultMotionConfig());
}

function readAngle(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const angle = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(angle) ? angle : null;
}

export function readRobotArmAngles(
  fields: DeviceTelemetryFields,
  field: string,
): (number | null)[] {
  const direct = fields[field];
  const array = Array.isArray(direct) ? direct : null;
  return Array.from({ length: ROBOT_ARM_JOINT_COUNT }, (_, index) => {
    const indexed = readAngle(fields[`${field}.${index}`]);
    return indexed ?? readAngle(array?.[index]);
  });
}

function captureBaselineRotation(node: TransformNode): Quaternion {
  return node.rotationQuaternion?.clone()
    ?? Quaternion.FromEulerAngles(node.rotation.x, node.rotation.y, node.rotation.z);
}

const ROBOT_MOTION_MIN_SEGMENT_SECONDS = 1 / 60;

function readSnapshotTime(snapshot: DeviceTelemetrySnapshot): number {
  return snapshot.sourceTimestamp ?? snapshot.receivedAt;
}

function resolveSegmentDuration(
  model: ModelRuntimeEntry,
  previousTimeMs: number,
  nextTimeMs: number,
): number {
  const measuredSeconds = (nextTimeMs - previousTimeMs) / 1000;
  if (Number.isFinite(measuredSeconds) && measuredSeconds > 0) {
    return Math.max(ROBOT_MOTION_MIN_SEGMENT_SECONDS, measuredSeconds);
  }
  const expectedSeconds = (model.telemetryBinding?.expectedIntervalMs ?? 500) / 1000;
  return Math.max(ROBOT_MOTION_MIN_SEGMENT_SECONDS, expectedSeconds);
}

export class RobotTelemetryDriver {
  private modelStates = new WeakMap<ModelRuntimeEntry, RobotModelRuntime>();
  private baselineRotations = new WeakMap<TransformNode, Quaternion>();

  getLightingMotionNodes(model: ModelRuntimeEntry): { moving: TransformNode[]; fixed: TransformNode[] } {
    const config = readRobotMotionConfig(model);
    const names = [...config.arms.L.nodes, ...config.arms.R.nodes];
    const fixedNames = model.entitySnapshot?.components.modelAsset?.dataDrivenConfig?.fixedNodes
      ?? model.resolvedModelAsset?.dataDrivenConfig?.fixedNodes
      ?? [];
    return {
      moving: findModelNodesByName(model, model.root.getScene(), names),
      fixed: findModelNodesByName(model, model.root.getScene(), fixedNames),
    };
  }

  applyToModel(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    if (snapshot.faulted) return;
    const state = this.resolveModelState(model);
    if (state.lastSnapshot !== snapshot) {
      const values = {
        L: readRobotArmAngles(snapshot.fields, state.config.arms.L.field),
        R: readRobotArmAngles(snapshot.fields, state.config.arms.R.field),
      };
      if (values.L.some(value => value !== null) || values.R.some(value => value !== null)) {
        const firstSnapshot = state.lastSnapshot === null;
        const sampleTimeMs = readSnapshotTime(snapshot);
        for (const side of ['L', 'R'] as const) {
          if (!values[side].some(value => value !== null)) continue;
          const arm = state.arms[side];
          const firstArmSample = !arm.active;
          arm.active = true;
          for (let index = 0; index < ROBOT_ARM_JOINT_COUNT; index++) {
            const value = values[side][index];
            if (value === null) continue;
            const angle = state.config.angleUnit === 'deg' ? value * Math.PI / 180 : value;
            arm.targetAngles[index] = angle;
            if (firstSnapshot || firstArmSample) {
              arm.currentAngles[index] = angle;
              arm.startAngles[index] = angle;
            }
          }
        }
        if (!firstSnapshot) {
          for (const arm of Object.values(state.arms)) {
            arm.startAngles = [...arm.currentAngles];
          }
          state.elapsedSeconds = 0;
          state.durationSeconds = resolveSegmentDuration(model, state.lastSampleTimeMs, sampleTimeMs);
        }
        state.lastSnapshot = snapshot;
        state.lastSampleTimeMs = sampleTimeMs;
      }
    }

    if (state.elapsedSeconds < state.durationSeconds) {
      state.elapsedSeconds = Math.min(state.durationSeconds, state.elapsedSeconds + Math.max(0, deltaSeconds));
      const progress = state.elapsedSeconds / state.durationSeconds;
      for (const arm of Object.values(state.arms)) {
        if (!arm.active) continue;
        for (let index = 0; index < ROBOT_ARM_JOINT_COUNT; index++) {
          arm.currentAngles[index] = arm.startAngles[index]
            + (arm.targetAngles[index] - arm.startAngles[index]) * progress;
        }
      }
    }
    for (const arm of Object.values(state.arms)) this.applyCurrentAngles(arm);
  }

  getDebugJointOffset(model: ModelRuntimeEntry, side: RobotArmSide, jointIndex: number): number | null {
    const joint = this.resolveModelState(model).arms[side].joints[jointIndex];
    return joint && !joint.node.isDisposed() ? joint.offset : null;
  }

  applyDebugToModel(
    model: ModelRuntimeEntry,
    side: RobotArmSide,
    jointIndex: number,
    angle: number,
  ): boolean {
    const joint = this.resolveModelState(model).arms[side].joints[jointIndex];
    if (!joint || joint.node.isDisposed()) return false;
    const delta = Quaternion.RotationAxis(AXIS_VECTORS[joint.axis], (angle + joint.offset) * joint.sign);
    joint.node.rotationQuaternion = joint.baselineRotation.multiply(delta);
    return true;
  }

  restoreDebugJoint(model: ModelRuntimeEntry, side: RobotArmSide, jointIndex: number): void {
    const joint = this.modelStates.get(model)?.arms[side].joints[jointIndex];
    if (!joint || joint.node.isDisposed()) return;
    joint.node.rotationQuaternion = joint.baselineRotation.clone();
  }

  hasPendingMotion(model: ModelRuntimeEntry): boolean {
    const state = this.modelStates.get(model);
    return state !== undefined && state.elapsedSeconds < state.durationSeconds;
  }

  resetMotionStates(): void {
    this.modelStates = new WeakMap<ModelRuntimeEntry, RobotModelRuntime>();
    this.baselineRotations = new WeakMap<TransformNode, Quaternion>();
  }

  private applyCurrentAngles(arm: RobotArmRuntime): void {
    if (!arm.active) return;
    for (let index = 0; index < ROBOT_ARM_JOINT_COUNT; index++) {
      const joint = arm.joints[index];
      if (!joint) continue;
      const delta = Quaternion.RotationAxis(
        AXIS_VECTORS[joint.axis],
        (arm.currentAngles[index] + joint.offset) * joint.sign,
      );
      joint.node.rotationQuaternion = joint.baselineRotation.multiply(delta);
    }
  }

  private resolveModelState(model: ModelRuntimeEntry): RobotModelRuntime {
    const config = readRobotMotionConfig(model);
    const signature = JSON.stringify(config);
    const cached = this.modelStates.get(model);
    if (cached?.signature === signature
      && !Object.values(cached.arms).some(arm => arm.joints.some(joint => joint?.node.isDisposed()))) {
      return cached;
    }

    const state: RobotModelRuntime = {
      signature,
      config,
      arms: {
        L: this.createArmRuntime(model, config.arms.L, config.angleUnit),
        R: this.createArmRuntime(model, config.arms.R, config.angleUnit),
      },
      lastSnapshot: null,
      lastSampleTimeMs: 0,
      elapsedSeconds: 0,
      durationSeconds: 0,
    };
    this.modelStates.set(model, state);
    return state;
  }

  private createArmRuntime(
    model: ModelRuntimeEntry,
    config: RobotArmMotionConfig,
    angleUnit: RobotMotionConfig['angleUnit'],
  ): RobotArmRuntime {
    const nodes = findModelNodesByName(model, model.root.getScene(), config.nodes);
    return {
      joints: config.nodes.map((name, index) => {
        const node = nodes.find(candidate => candidate.name === name);
        if (!node) return null;
        let baselineRotation = this.baselineRotations.get(node);
        if (!baselineRotation) {
          baselineRotation = captureBaselineRotation(node);
          this.baselineRotations.set(node, baselineRotation);
        }
        return {
          node,
          baselineRotation,
          axis: config.axes[index],
          sign: config.signs[index],
          offset: angleUnit === 'deg' ? config.offsets[index] * Math.PI / 180 : config.offsets[index],
        };
      }),
      active: false,
      currentAngles: Array.from({ length: ROBOT_ARM_JOINT_COUNT }, () => 0),
      startAngles: Array.from({ length: ROBOT_ARM_JOINT_COUNT }, () => 0),
      targetAngles: Array.from({ length: ROBOT_ARM_JOINT_COUNT }, () => 0),
    };
  }
}
