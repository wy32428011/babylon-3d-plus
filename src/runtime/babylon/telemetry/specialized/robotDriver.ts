import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { DeviceTelemetryFields, DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import { findModelNodesByName } from '../../runtimeNodeGeometry';

export const ROBOT_ARM_JOINT_COUNT = 7;
export const ROBOT_WAIST_JOINT_COUNT = 1;

export type RobotArmSide = 'L' | 'R';
export type RobotJointTarget = RobotArmSide | 'waist';
export type RobotJointAxis = 'x' | 'y' | 'z';

export type RobotJointMotionConfig = {
  field: string;
  nodes: string[];
  axes: RobotJointAxis[];
  signs: number[];
  offsets: number[];
};

export type RobotMotionConfig = {
  angleUnit: 'rad' | 'deg';
  arms: Record<RobotArmSide, RobotJointMotionConfig>;
  waist: RobotJointMotionConfig;
};

const ROBOT_ARM_SIDES: readonly RobotArmSide[] = ['L', 'R'];
const ROBOT_JOINT_TARGETS: readonly RobotJointTarget[] = ['L', 'R', 'waist'];
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
  waist: {
    field: 'waistYaw',
    nodes: [],
    axes: ['z'],
    signs: [1],
    offsets: [0],
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

type RobotJointGroupRuntime = {
  joints: (RobotJointRuntime | null)[];
  active: boolean;
  currentAngles: number[];
  startAngles: number[];
  targetAngles: number[];
};

type RobotModelRuntime = {
  signature: string;
  config: RobotMotionConfig;
  groups: Record<RobotJointTarget, RobotJointGroupRuntime>;
  lastSnapshot: DeviceTelemetrySnapshot | null;
  lastSampleTimeMs: number;
  elapsedSeconds: number;
  durationSeconds: number;
};

const baselineRotations = new WeakMap<TransformNode, Quaternion>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown, fallback: string[], length: number): string[] {
  if (!Array.isArray(value) || value.length !== length) return [...fallback];
  return value.every(item => typeof item === 'string' && item.trim().length > 0)
    ? value.map(item => (item as string).trim())
    : [...fallback];
}

function readAxes(value: unknown, fallback: RobotJointAxis[], length: number): RobotJointAxis[] {
  if (!Array.isArray(value) || value.length !== length) return [...fallback];
  return value.every(item => item === 'x' || item === 'y' || item === 'z')
    ? [...value] as RobotJointAxis[]
    : [...fallback];
}

function readSigns(value: unknown, fallback: number[], length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) return [...fallback];
  return value.map(item => Number(item) < 0 ? -1 : 1);
}

function readOffsets(value: unknown, fallback: number[], length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) return [...fallback];
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
  if (isRecord(value.arms)) {
    for (const side of ROBOT_ARM_SIDES) {
      const arm = value.arms[side];
      if (!isRecord(arm)) continue;
      const fallback = DEFAULT_ROBOT_MOTION_CONFIG.arms[side];
      config.arms[side] = {
        field: typeof arm.field === 'string' && arm.field.trim() ? arm.field.trim() : fallback.field,
        nodes: readStringArray(arm.nodes, fallback.nodes, ROBOT_ARM_JOINT_COUNT),
        axes: readAxes(arm.axes, fallback.axes, ROBOT_ARM_JOINT_COUNT),
        signs: readSigns(arm.signs, fallback.signs, ROBOT_ARM_JOINT_COUNT),
        offsets: readOffsets(arm.offsets, fallback.offsets, ROBOT_ARM_JOINT_COUNT),
      };
    }
  }
  if (isRecord(value.waist)) {
    const fallback = DEFAULT_ROBOT_MOTION_CONFIG.waist;
    config.waist = {
      field: typeof value.waist.field === 'string' && value.waist.field.trim() ? value.waist.field.trim() : fallback.field,
      nodes: readStringArray(value.waist.nodes, fallback.nodes, ROBOT_WAIST_JOINT_COUNT),
      axes: readAxes(value.waist.axes, fallback.axes, ROBOT_WAIST_JOINT_COUNT),
      signs: readSigns(value.waist.signs, fallback.signs, ROBOT_WAIST_JOINT_COUNT),
      offsets: readOffsets(value.waist.offsets, fallback.offsets, ROBOT_WAIST_JOINT_COUNT),
    };
  }
  return config;
}

function getMotionGroup(config: RobotMotionConfig, target: RobotJointTarget): RobotJointMotionConfig {
  return target === 'waist' ? config.waist : config.arms[target];
}

function getRuntimeGroup(state: RobotModelRuntime, target: RobotJointTarget): RobotJointGroupRuntime {
  return state.groups[target];
}

function applyJointCalibration(model: ModelRuntimeEntry, config: RobotMotionConfig): RobotMotionConfig {
  const calibration = model.telemetryBinding?.robotJointCalibration;
  if (!calibration) return config;
  for (const target of ROBOT_JOINT_TARGETS) {
    const jointCalibration = calibration[target];
    if (!jointCalibration) continue;
    const group = getMotionGroup(config, target);
    if (jointCalibration.axes) {
      group.axes = jointCalibration.axes.map(axis => axis.replace('-', '') as RobotJointAxis);
      group.signs = jointCalibration.axes.map(axis => axis.startsWith('-') ? -1 : 1);
    } else if (jointCalibration.signs) {
      group.signs = [...jointCalibration.signs];
    }
    group.offsets = jointCalibration.offsetsDeg.map(value => (
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

export function readRobotJointAngles(
  fields: DeviceTelemetryFields,
  field: string,
  count: number,
): (number | null)[] {
  const direct = fields[field];
  const array = Array.isArray(direct) ? direct : null;
  return Array.from({ length: count }, (_, index) => {
    const indexed = readAngle(fields[`${field}.${index}`]);
    return indexed ?? readAngle(array ? array[index] : count === 1 ? direct : undefined);
  });
}

export function readRobotArmAngles(
  fields: DeviceTelemetryFields,
  field: string,
): (number | null)[] {
  return readRobotJointAngles(fields, field, ROBOT_ARM_JOINT_COUNT);
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

  getLightingMotionNodes(model: ModelRuntimeEntry): { moving: TransformNode[]; fixed: TransformNode[] } {
    const config = readRobotMotionConfig(model);
    const names = [...config.arms.L.nodes, ...config.arms.R.nodes, ...config.waist.nodes];
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
      const values: Record<RobotJointTarget, (number | null)[]> = {
        L: readRobotArmAngles(snapshot.fields, state.config.arms.L.field),
        R: readRobotArmAngles(snapshot.fields, state.config.arms.R.field),
        waist: readRobotJointAngles(snapshot.fields, state.config.waist.field, ROBOT_WAIST_JOINT_COUNT),
      };
      if (Object.values(values).some(group => group.some(value => value !== null))) {
        const firstSnapshot = state.lastSnapshot === null;
        const sampleTimeMs = readSnapshotTime(snapshot);
        for (const target of ROBOT_JOINT_TARGETS) {
          if (!values[target].some(value => value !== null)) continue;
          const group = getRuntimeGroup(state, target);
          const firstGroupSample = !group.active;
          group.active = true;
          for (let index = 0; index < values[target].length; index++) {
            const value = values[target][index];
            if (value === null) continue;
            const angle = state.config.angleUnit === 'deg' ? value * Math.PI / 180 : value;
            group.targetAngles[index] = angle;
            if (firstSnapshot || firstGroupSample) {
              group.currentAngles[index] = angle;
              group.startAngles[index] = angle;
            }
          }
        }
        if (!firstSnapshot) {
          for (const group of Object.values(state.groups)) {
            group.startAngles = [...group.currentAngles];
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
      for (const group of Object.values(state.groups)) {
        if (!group.active) continue;
        for (let index = 0; index < group.joints.length; index++) {
          group.currentAngles[index] = group.startAngles[index]
            + (group.targetAngles[index] - group.startAngles[index]) * progress;
        }
      }
    }
    for (const group of Object.values(state.groups)) this.applyCurrentAngles(group);
  }

  getDebugJointOffset(model: ModelRuntimeEntry, target: RobotJointTarget, jointIndex: number): number | null {
    const joint = getRuntimeGroup(this.resolveModelState(model), target).joints[jointIndex];
    return joint && !joint.node.isDisposed() ? joint.offset : null;
  }

  applyDebugToModel(
    model: ModelRuntimeEntry,
    target: RobotJointTarget,
    jointIndex: number,
    angle: number,
  ): boolean {
    const joint = getRuntimeGroup(this.resolveModelState(model), target).joints[jointIndex];
    if (!joint || joint.node.isDisposed()) return false;
    this.applyJointAngle(joint, angle);
    return true;
  }

  restoreDebugJoint(model: ModelRuntimeEntry, target: RobotJointTarget, jointIndex: number): void {
    const joint = getRuntimeGroup(this.resolveModelState(model), target).joints[jointIndex];
    if (!joint || joint.node.isDisposed()) return;
    this.applyJointAngle(joint, 0);
  }

  applyCalibrationToModel(model: ModelRuntimeEntry): void {
    const state = this.resolveModelState(model);
    for (const group of Object.values(state.groups)) {
      for (const joint of group.joints) if (joint) this.applyJointAngle(joint, 0);
    }
  }

  hasPendingMotion(model: ModelRuntimeEntry): boolean {
    const state = this.modelStates.get(model);
    return state !== undefined && state.elapsedSeconds < state.durationSeconds;
  }

  resetMotionStates(): void {
    this.modelStates = new WeakMap<ModelRuntimeEntry, RobotModelRuntime>();
  }

  private applyJointAngle(joint: RobotJointRuntime, angle: number): void {
    const delta = Quaternion.RotationAxis(AXIS_VECTORS[joint.axis], (angle + joint.offset) * joint.sign);
    joint.node.rotationQuaternion = joint.baselineRotation.multiply(delta);
  }

  private applyCurrentAngles(group: RobotJointGroupRuntime): void {
    if (!group.active) return;
    for (let index = 0; index < group.joints.length; index++) {
      const joint = group.joints[index];
      if (joint) this.applyJointAngle(joint, group.currentAngles[index]);
    }
  }

  private resolveModelState(model: ModelRuntimeEntry): RobotModelRuntime {
    const config = readRobotMotionConfig(model);
    const signature = JSON.stringify(config);
    const cached = this.modelStates.get(model);
    if (cached?.signature === signature
      && !Object.values(cached.groups).some(group => group.joints.some(joint => joint?.node.isDisposed()))) {
      return cached;
    }

    const state: RobotModelRuntime = {
      signature,
      config,
      groups: {
        L: this.createJointGroupRuntime(model, config.arms.L, config.angleUnit),
        R: this.createJointGroupRuntime(model, config.arms.R, config.angleUnit),
        waist: this.createJointGroupRuntime(model, config.waist, config.angleUnit),
      },
      lastSnapshot: null,
      lastSampleTimeMs: 0,
      elapsedSeconds: 0,
      durationSeconds: 0,
    };
    this.modelStates.set(model, state);
    return state;
  }

  private createJointGroupRuntime(
    model: ModelRuntimeEntry,
    config: RobotJointMotionConfig,
    angleUnit: RobotMotionConfig['angleUnit'],
  ): RobotJointGroupRuntime {
    const nodes = findModelNodesByName(model, model.root.getScene(), config.nodes);
    return {
      joints: config.nodes.map((name, index) => {
        const node = nodes.find(candidate => candidate.name === name);
        if (!node) return null;
        let baselineRotation = baselineRotations.get(node);
        if (!baselineRotation) {
          baselineRotation = captureBaselineRotation(node);
          baselineRotations.set(node, baselineRotation);
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
      currentAngles: Array.from({ length: config.nodes.length }, () => 0),
      startAngles: Array.from({ length: config.nodes.length }, () => 0),
      targetAngles: Array.from({ length: config.nodes.length }, () => 0),
    };
  }
}
