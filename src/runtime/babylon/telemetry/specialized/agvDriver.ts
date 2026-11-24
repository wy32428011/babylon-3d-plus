import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import {
  AGV_MAP_NODE_RADIUS_DEFAULT,
  findAgvMapNodeWithinRadius,
  findAgvMapShortestRoute,
  getAgvMapSceneAxisBase,
  mapAgvPointToScene,
  projectAgvPointToRoute,
  resolveAgvMapNodeId,
  sliceAgvMapRouteFromNode,
  type AgvMapRoute,
  type AgvMapSceneAxis,
} from '../../../../editor/model/agvMap';
import type { TelemetryBindingComponent } from '../../../../editor/model/telemetryBinding';
import { readIntegerField, readNumberField, readStringField, type DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import type { AgvMapPlacement } from '../../scene-runtime/sceneRuntimeTypes';
import { AgvTaskRouteHighlight } from '../../agv/AgvTaskRouteHighlight';

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
  taskRouteAnchorNodeId: string | null;
  taskRouteEndNodeId: string | null;
  taskRoute: AgvMapRoute | null;
  taskRouteFull: AgvMapRoute | null;
  taskRouteHighlight: AgvTaskRouteHighlight | null;
};

/** 动态 AGV 按产生器地图原点、轴映射和比例尺定位；静态 AGV 保持世界坐标驱动。 */
export class AgvTelemetryDriver {
  private motionStates = new WeakMap<ModelRuntimeEntry, AgvMotionState>();
  private readonly routeHighlights = new Set<AgvTaskRouteHighlight>();

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
        taskRouteAnchorNodeId: null,
        taskRouteEndNodeId: null,
        taskRoute: null,
        taskRouteFull: null,
        taskRouteHighlight: null,
      };
      this.motionStates.set(model, state);
      model.root.onDisposeObservable.add(() => {
        const current = this.motionStates.get(model);
        if (current) this.disposeTaskRouteHighlight(current);
      });
      this.updateTaskRoute(model, snapshot, state);
      this.updateTaskRouteHighlight(model, state, 0);
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

    if (state.elapsedSeconds < state.durationSeconds) {
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
    this.updateTaskRouteHighlight(model, state, deltaSeconds);
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
    for (const highlight of this.routeHighlights) highlight.dispose();
    this.routeHighlights.clear();
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
    state.taskRouteFull = null;
    state.taskRouteAnchorNodeId = null;
    state.taskRouteEndNodeId = null;
    this.disposeTaskRouteHighlight(state);
    const placement = model.agvMapPlacement;
    const map = placement?.definition;
    if (!routeKey || !map || !placement) return;
    const [startPoint, endPoint] = routeKey.split('\0');
    this.replaceTaskRoute(
      model,
      state,
      resolveAgvMapNodeId(map, startPoint),
      resolveAgvMapNodeId(map, endPoint),
    );
  }

  private replaceTaskRoute(
    model: ModelRuntimeEntry,
    state: AgvMotionState,
    startNodeId: string | null,
    endNodeId: string | null,
  ): void {
    const map = model.agvMapPlacement?.definition;
    this.setTaskRoute(
      model,
      state,
      startNodeId,
      endNodeId,
      map && startNodeId && endNodeId ? findAgvMapShortestRoute(map, startNodeId, endNodeId) : null,
    );
  }

  private setTaskRoute(
    model: ModelRuntimeEntry,
    state: AgvMotionState,
    startNodeId: string | null,
    endNodeId: string | null,
    route: AgvMapRoute | null,
  ): void {
    const placement = model.agvMapPlacement;
    this.disposeTaskRouteHighlight(state);
    state.taskRouteAnchorNodeId = startNodeId;
    state.taskRouteEndNodeId = endNodeId;
    state.taskRoute = route;
    state.taskRouteFull = route;
    const highlight = placement?.routeHighlight;
    if (!placement || !state.taskRoute || state.taskRoute.distance <= 0 || !highlight?.enabled) return;
    state.taskRouteHighlight = new AgvTaskRouteHighlight(
      model.root.name,
      model.root.getScene(),
      state.taskRoute,
      placement,
      highlight,
    );
    this.routeHighlights.add(state.taskRouteHighlight);
  }

  private updateTaskRouteHighlight(
    model: ModelRuntimeEntry,
    state: AgvMotionState,
    deltaSeconds: number,
  ): void {
    const placement = model.agvMapPlacement;
    if (!placement) return;
    const current = Vector3.TransformCoordinates(
      model.root.position,
      createAgvMapPlacementMatrix(placement).invert(),
    );
    const mapPoint = {
      x: readAgvMapCoordinate(current, placement.map.xAxis, placement.map.scale),
      y: readAgvMapCoordinate(current, placement.map.yAxis, placement.map.scale),
    };
    const map = placement.definition;
    const fullRoute = state.taskRouteFull;
    let projection = fullRoute ? projectAgvPointToRoute(fullRoute.points, mapPoint) : null;
    if (map && state.taskRouteEndNodeId) {
      const nodeRadius = (placement.map.nodeRadius ?? AGV_MAP_NODE_RADIUS_DEFAULT) / placement.map.scale;
      const touchedNodeId = findAgvMapNodeWithinRadius(map, mapPoint, nodeRadius);
      if (touchedNodeId && touchedNodeId !== state.taskRouteAnchorNodeId) {
        const remainingRoute = fullRoute
          ? sliceAgvMapRouteFromNode(map, fullRoute, touchedNodeId)
          : null;
        const followsCurrentRoute = projection !== null
          && Math.hypot(mapPoint.x - projection.point.x, mapPoint.y - projection.point.y) <= nodeRadius;
        if (remainingRoute) {
          state.taskRouteAnchorNodeId = touchedNodeId;
          state.taskRoute = remainingRoute;
          if (remainingRoute.distance <= 0) this.disposeTaskRouteHighlight(state);
        } else if (followsCurrentRoute) {
          state.taskRouteAnchorNodeId = touchedNodeId;
        } else {
          this.replaceTaskRoute(model, state, touchedNodeId, state.taskRouteEndNodeId);
          projection = state.taskRouteFull
            ? projectAgvPointToRoute(state.taskRouteFull.points, mapPoint)
            : null;
        }
      }
    }
    const highlight = state.taskRouteHighlight;
    if (!highlight || !state.taskRouteFull) return;
    highlight.update(projection?.progress ?? 0, deltaSeconds);
  }

  private disposeTaskRouteHighlight(state: AgvMotionState): void {
    if (!state.taskRouteHighlight) return;
    this.routeHighlights.delete(state.taskRouteHighlight);
    state.taskRouteHighlight.dispose();
    state.taskRouteHighlight = null;
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
