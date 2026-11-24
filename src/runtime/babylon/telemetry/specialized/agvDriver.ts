import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import {
  findAgvMapShortestRoute,
  getAgvMapSceneAxisBase,
  mapAgvPointToScene,
  resolveAgvMapNodeId,
  type AgvMapRoute,
  type AgvMapSceneAxis,
} from '../../../../editor/model/agvMap';
import type { TelemetryBindingComponent } from '../../../../editor/model/telemetryBinding';
import { readIntegerField, readNumberField, readStringField, type DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import type { AgvMapPlacement } from '../../scene-runtime/sceneRuntimeTypes';

export type AgvModelForwardAxis = NonNullable<TelemetryBindingComponent['modelForwardAxis']>;

const FORWARD_AXIS_OFFSET_DEGREES: Record<AgvModelForwardAxis, number> = {
  x: 0,
  '-x': 180,
  z: -90,
  '-z': 90,
};

/** NDC8 车头角以场景 +X 为零、顺时针为正；模型轴只补偿几何初始朝向。 */
export function resolveAgvYawRadians(
  headingDegrees: number,
  modelForwardAxis: AgvModelForwardAxis = 'x',
): number {
  return (headingDegrees + FORWARD_AXIS_OFFSET_DEGREES[modelForwardAxis]) * Math.PI / 180;
}

function createAgvMapPlacementMatrix(placement: AgvMapPlacement): Matrix {
  const { transform } = placement;
  return Matrix.Compose(
    new Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
    Quaternion.FromEulerAngles(transform.rotation.x, transform.rotation.y, transform.rotation.z),
    new Vector3(transform.position.x, transform.position.y, transform.position.z),
  );
}

function readAgvMapCoordinate(point: Vector3, axis: AgvMapSceneAxis, scale: number): number {
  const value = point[getAgvMapSceneAxisBase(axis)];
  return (axis.startsWith('-') ? -value : value) / scale;
}

function resolveAgvMapPosition(
  model: ModelRuntimeEntry,
  x: number | null,
  y: number | null,
  currentPosition: Vector3,
): Vector3 {
  const placement = model.agvMapPlacement;
  if (!placement) {
    return new Vector3(x ?? currentPosition.x, currentPosition.y, y ?? currentPosition.z);
  }

  const matrix = createAgvMapPlacementMatrix(placement);
  const current = Vector3.TransformCoordinates(currentPosition, matrix.clone().invert());
  const mapped = mapAgvPointToScene({
    x: x ?? readAgvMapCoordinate(current, placement.map.xAxis, placement.map.scale),
    y: y ?? readAgvMapCoordinate(current, placement.map.yAxis, placement.map.scale),
  }, placement.map);
  return Vector3.TransformCoordinates(new Vector3(mapped.x, mapped.y, mapped.z), matrix);
}

function resolveClosestAgvYaw(targetYaw: number, referenceYaw: number): number {
  const delta = targetYaw - referenceYaw;
  return referenceYaw + Math.atan2(Math.sin(delta), Math.cos(delta));
}

export const AGV_MOTION_DEFAULT_SEGMENT_SECONDS = 0.5;
const AGV_MOTION_MIN_SEGMENT_SECONDS = 1 / 60;

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
    return Math.max(AGV_MOTION_MIN_SEGMENT_SECONDS, measuredSeconds);
  }
  const expectedSeconds = (model.telemetryBinding?.expectedIntervalMs
    ?? AGV_MOTION_DEFAULT_SEGMENT_SECONDS * 1000) / 1000;
  return Math.max(AGV_MOTION_MIN_SEGMENT_SECONDS, expectedSeconds);
}

function readTaskPoint(snapshot: DeviceTelemetrySnapshot, key: string): string | null {
  return readStringField(snapshot.fields, key)?.trim() || null;
}

function readTaskRouteKey(snapshot: DeviceTelemetrySnapshot): string | null {
  const start = readTaskPoint(snapshot, 'task_begin_point');
  const end = readTaskPoint(snapshot, 'task_end_point');
  return start && end ? `${start}\0${end}` : null;
}

type AgvMotionState = {
  lastSnapshot: DeviceTelemetrySnapshot;
  lastSampleTimeMs: number;
  startPosition: Vector3;
  targetPosition: Vector3;
  startYaw: number;
  targetYaw: number | null;
  elapsedSeconds: number;
  durationSeconds: number;
  taskRouteKey: string | null;
  taskRoute: AgvMapRoute | null;
};

/** 动态 AGV 按产生器地图原点、轴映射和比例尺定位；静态 AGV 保持世界坐标驱动。 */
export class AgvTelemetryDriver {
  private motionStates = new WeakMap<ModelRuntimeEntry, AgvMotionState>();

  public applyToModel(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    deltaSeconds: number,
  ): void {
    if (snapshot.faulted || readIntegerField(snapshot.fields, 'mode') === 0) return;

    const x = readNumberField(snapshot.fields, 'x');
    const y = readNumberField(snapshot.fields, 'y');
    const heading = readNumberField(snapshot.fields, 'r');
    let state = this.motionStates.get(model);
    if (!state) {
      if (x === null && y === null && heading === null) return;
      const targetYaw = heading === null ? null : this.resolveModelYaw(model, heading);
      model.root.position.copyFrom(resolveAgvMapPosition(model, x, y, model.root.position));
      if (targetYaw !== null) {
        model.root.rotationQuaternion = null;
        model.root.rotation.y = targetYaw;
      }
      state = {
        lastSnapshot: snapshot,
        lastSampleTimeMs: readSnapshotTime(snapshot),
        startPosition: model.root.position.clone(),
        targetPosition: model.root.position.clone(),
        startYaw: model.root.rotation.y,
        targetYaw,
        elapsedSeconds: AGV_MOTION_DEFAULT_SEGMENT_SECONDS,
        durationSeconds: AGV_MOTION_DEFAULT_SEGMENT_SECONDS,
        taskRouteKey: null,
        taskRoute: null,
      };
      this.motionStates.set(model, state);
      this.updateTaskRoute(model, snapshot, state);
      return;
    }

    if (state.lastSnapshot !== snapshot) {
      const sampleTimeMs = readSnapshotTime(snapshot);
      const targetPosition = resolveAgvMapPosition(model, x, y, state.targetPosition);
      const resolvedYaw = heading === null ? null : this.resolveModelYaw(model, heading);
      const targetYaw = resolvedYaw === null
        ? state.targetYaw
        : resolveClosestAgvYaw(resolvedYaw, state.targetYaw ?? model.root.rotation.y);
      if (!targetPosition.equals(state.targetPosition) || targetYaw !== state.targetYaw) {
        state.startPosition.copyFrom(model.root.position);
        state.targetPosition.copyFrom(targetPosition);
        state.startYaw = model.root.rotation.y;
        state.targetYaw = targetYaw;
        state.elapsedSeconds = 0;
        state.durationSeconds = resolveSegmentDuration(model, state.lastSampleTimeMs, sampleTimeMs);
      }
      state.lastSampleTimeMs = sampleTimeMs;
      state.lastSnapshot = snapshot;
      this.updateTaskRoute(model, snapshot, state);
    }

    if (state.elapsedSeconds >= state.durationSeconds) return;
    state.elapsedSeconds = Math.min(
      state.durationSeconds,
      state.elapsedSeconds + Math.max(0, deltaSeconds),
    );
    const progress = state.elapsedSeconds / state.durationSeconds;
    Vector3.LerpToRef(state.startPosition, state.targetPosition, progress, model.root.position);
    if (state.targetYaw !== null) {
      model.root.rotationQuaternion = null;
      model.root.rotation.y = state.startYaw + (state.targetYaw - state.startYaw) * progress;
    }
  }

  public hasPendingMotion(model: ModelRuntimeEntry): boolean {
    const state = this.motionStates.get(model);
    if (!state) return false;
    return state.elapsedSeconds < state.durationSeconds;
  }

  public getTaskRoute(model: ModelRuntimeEntry, startNodeId?: string, endNodeId?: string): AgvMapRoute | null {
    const state = this.motionStates.get(model);
    if (!state) return null;
    if (startNodeId !== undefined && endNodeId !== undefined
      && state.taskRouteKey !== `${startNodeId}\0${endNodeId}`) return null;
    return state.taskRoute;
  }

  public resetMotionStates(): void {
    this.motionStates = new WeakMap<ModelRuntimeEntry, AgvMotionState>();
  }

  private updateTaskRoute(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    state: AgvMotionState,
  ): void {
    const routeKey = readTaskRouteKey(snapshot);
    if (routeKey === state.taskRouteKey) return;
    state.taskRouteKey = routeKey;
    state.taskRoute = null;
    const map = model.agvMapPlacement?.definition;
    if (!routeKey || !map) return;
    const [startPoint, endPoint] = routeKey.split('\0');
    const startNodeId = resolveAgvMapNodeId(map, startPoint);
    const endNodeId = resolveAgvMapNodeId(map, endPoint);
    state.taskRoute = startNodeId && endNodeId
      ? findAgvMapShortestRoute(map, startNodeId, endNodeId)
      : null;
  }

  private resolveModelYaw(model: ModelRuntimeEntry, heading: number): number {
    return resolveAgvYawRadians(
      heading,
      model.telemetryBinding?.modelForwardAxis
        ?? model.entitySnapshot?.components.modelAsset?.dataDrivenConfig?.device.modelForwardAxis
        ?? 'x',
    );
  }
}
